import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const downloadDir = path.resolve(process.env.DOWNLOAD_DIR || path.join(projectRoot, 'downloads'));

const HTTP_PORT = Number.parseInt(process.env.PORT || '53317', 10);
const DISCOVERY_PORT = Number.parseInt(process.env.DISCOVERY_PORT || '53318', 10);
const ANNOUNCE_INTERVAL_MS = Number.parseInt(process.env.ANNOUNCE_INTERVAL_MS || '5000', 10);
const PEER_TTL_MS = Number.parseInt(process.env.PEER_TTL_MS || '15000', 10);
const ACCESS_PIN = (process.env.ACCESS_PIN || '').trim();
const DEVICE_NAME = (process.env.DEVICE_NAME || os.hostname()).trim();
const DEVICE_ID =
  process.env.DEVICE_ID ||
  crypto
    .createHash('sha1')
    .update(`${DEVICE_NAME}:${HTTP_PORT}`)
    .digest('hex')
    .slice(0, 12);

const peers = new Map();
const downloads = [];
const sockets = new Set();
const localAddress = pickLocalAddress();

await fsp.mkdir(downloadDir, { recursive: true });
await loadExistingDownloads();

const discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
discoverySocket.on('error', (error) => {
  console.error('[udp] error', error);
});

discoverySocket.on('message', (message, rinfo) => {
  const payload = tryParseJson(message);
  if (!payload || payload.type !== 'announce' || payload.id === DEVICE_ID) {
    return;
  }

  const peer = {
    id: payload.id,
    name: payload.name || 'Unknown Device',
    address: rinfo.address === '127.0.0.1' ? payload.address || rinfo.address : rinfo.address,
    httpPort: Number(payload.httpPort) || HTTP_PORT,
    tokenRequired: Boolean(payload.tokenRequired),
    lastSeen: Date.now()
  };

  const previous = peers.get(peer.id);
  peers.set(peer.id, peer);

  if (!previous || hasPeerChanged(previous, peer)) {
    broadcastJson({ type: 'peers', peers: listPeers() });
  }
});

discoverySocket.bind(DISCOVERY_PORT, () => {
  discoverySocket.setBroadcast(true);
  announceSelf();
  console.log(`[udp] discovery listening on :${DISCOVERY_PORT}`);
});

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && requestUrl.pathname === '/api/info') {
      return sendJson(res, 200, { device: buildSelfDevice() });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/peers') {
      return sendJson(res, 200, { peers: listPeers() });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/downloads') {
      return sendJson(res, 200, { downloads: listDownloads() });
    }

    if (req.method === 'PUT' && requestUrl.pathname.startsWith('/api/files/')) {
      return handleIncomingFile(req, res, requestUrl);
    }

    if (req.method === 'GET' && requestUrl.pathname.startsWith('/downloads/')) {
      return handleDownload(req, res, requestUrl);
    }

    if (req.method === 'GET') {
      return serveStaticAsset(res, requestUrl.pathname);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[http] request failed', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

const wsServer = new WebSocketServer({ server, path: '/ws' });
wsServer.on('connection', (socket) => {
  sockets.add(socket);
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      device: buildSelfDevice(),
      peers: listPeers(),
      downloads: listDownloads()
    })
  );

  socket.on('close', () => {
    sockets.delete(socket);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`[http] listening on http://0.0.0.0:${HTTP_PORT}`);
  console.log(`[device] ${DEVICE_NAME} (${DEVICE_ID})`);
  console.log(`[storage] ${downloadDir}`);
  if (ACCESS_PIN) {
    console.log('[auth] upload PIN enabled');
  }
});

const announceTimer = setInterval(announceSelf, ANNOUNCE_INTERVAL_MS);
const peerGcTimer = setInterval(expirePeers, 2000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

async function handleIncomingFile(req, res, requestUrl) {
  if (ACCESS_PIN) {
    const incomingToken = (req.headers['x-device-token'] || '').toString().trim();
    if (incomingToken !== ACCESS_PIN) {
      return sendJson(res, 401, { error: 'Invalid device PIN' });
    }
  }

  const senderId = requestUrl.searchParams.get('senderId') || 'unknown';
  const senderName = requestUrl.searchParams.get('senderName') || 'Unknown Sender';
  const rawName = decodeURIComponent(requestUrl.pathname.slice('/api/files/'.length));
  const safeName = sanitizeFileName(rawName);
  const finalName = await allocateUniqueFileName(safeName);
  const targetPath = path.join(downloadDir, finalName);
  const fileId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const expectedSize = Number.parseInt((req.headers['x-file-size'] || '0').toString(), 10) || null;
  const contentType = (req.headers['x-file-type'] || 'application/octet-stream').toString();

  const writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
  let receivedBytes = 0;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
  });

  const completed = new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Upload aborted')));
  });

  req.pipe(writeStream);

  try {
    await completed;
    const stats = await fsp.stat(targetPath);
    const record = {
      id: fileId,
      name: finalName,
      originalName: safeName,
      senderId,
      senderName,
      size: stats.size,
      contentType,
      receivedAt: new Date().toISOString(),
      url: `/downloads/${fileId}`,
      path: targetPath
    };

    downloads.unshift(record);
    broadcastJson({
      type: 'download-added',
      download: serializeDownload(record),
      downloads: listDownloads()
    });
    sendJson(res, 201, {
      ok: true,
      file: {
        id: record.id,
        name: record.name,
        size: record.size,
        expectedSize
      }
    });
  } catch (error) {
    await fsp.rm(targetPath, { force: true });
    console.error('[upload] failed', error);
    sendJson(res, 500, { error: error.message });
  }
}

async function handleDownload(_req, res, requestUrl) {
  const fileId = requestUrl.pathname.slice('/downloads/'.length);
  const record = downloads.find((entry) => entry.id === fileId);

  if (!record) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  try {
    const stats = await fsp.stat(record.path);
    res.writeHead(200, {
      'Content-Type': record.contentType || 'application/octet-stream',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(record.originalName)}"`
    });
    fs.createReadStream(record.path).pipe(res);
  } catch (error) {
    console.error('[download] failed', error);
    sendJson(res, 404, { error: 'File not found' });
  }
}

async function serveStaticAsset(res, pathname) {
  const effectivePath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(effectivePath).replace(/^(\.\.[/\\])+/, '');
  const assetPath = path.join(publicDir, normalized);

  if (!assetPath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  try {
    const data = await fsp.readFile(assetPath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(assetPath)
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function loadExistingDownloads() {
  const entries = await fsp.readdir(downloadDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(downloadDir, entry.name);
    const stats = await fsp.stat(filePath);
    downloads.push({
      id: `existing-${entry.name}`,
      name: entry.name,
      originalName: entry.name,
      senderId: 'unknown',
      senderName: 'Existing File',
      size: stats.size,
      contentType: 'application/octet-stream',
      receivedAt: stats.mtime.toISOString(),
      url: `/downloads/existing-${entry.name}`,
      path: filePath
    });
  }
  downloads.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

function announceSelf() {
  const payload = Buffer.from(
    JSON.stringify({
      type: 'announce',
      id: DEVICE_ID,
      name: DEVICE_NAME,
      address: localAddress,
      httpPort: HTTP_PORT,
      tokenRequired: Boolean(ACCESS_PIN)
    })
  );

  discoverySocket.send(payload, DISCOVERY_PORT, '255.255.255.255');
  discoverySocket.send(payload, DISCOVERY_PORT, '127.0.0.1');
}

function expirePeers() {
  const now = Date.now();
  let removed = false;

  for (const [peerId, peer] of peers.entries()) {
    if (now - peer.lastSeen > PEER_TTL_MS) {
      peers.delete(peerId);
      removed = true;
    }
  }

  if (removed) {
    broadcastJson({ type: 'peers', peers: listPeers() });
  }
}

function buildSelfDevice() {
  return {
    id: DEVICE_ID,
    name: DEVICE_NAME,
    address: localAddress,
    httpPort: HTTP_PORT,
    baseUrl: `http://${localAddress}:${HTTP_PORT}`,
    tokenRequired: Boolean(ACCESS_PIN)
  };
}

function listPeers() {
  return [...peers.values()]
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      address: peer.address,
      httpPort: peer.httpPort,
      tokenRequired: peer.tokenRequired,
      baseUrl: `http://${peer.address}:${peer.httpPort}`,
      lastSeen: peer.lastSeen
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Size, X-File-Type, X-Device-Token');
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function broadcastJson(payload) {
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === 1) {
      socket.send(message);
    }
  }
}

function listDownloads() {
  return downloads.map(serializeDownload);
}

function serializeDownload(record) {
  return {
    id: record.id,
    name: record.name,
    originalName: record.originalName,
    senderId: record.senderId,
    senderName: record.senderName,
    size: record.size,
    contentType: record.contentType,
    receivedAt: record.receivedAt,
    url: record.url
  };
}

function tryParseJson(message) {
  try {
    return JSON.parse(message.toString('utf8'));
  } catch {
    return null;
  }
}

async function allocateUniqueFileName(fileName) {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let index = 1;

  while (await fileExists(path.join(downloadDir, candidate))) {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  }

  return candidate;
}

function sanitizeFileName(fileName) {
  const trimmed = fileName.trim() || 'unnamed-file';
  const basename = path.basename(trimmed);
  return basename.replace(/[^a-zA-Z0-9._()\- ]+/g, '_');
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pickLocalAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function hasPeerChanged(previous, next) {
  return (
    previous.name !== next.name ||
    previous.address !== next.address ||
    previous.httpPort !== next.httpPort ||
    previous.tokenRequired !== next.tokenRequired
  );
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  return 'application/octet-stream';
}

function shutdown(signal) {
  clearInterval(announceTimer);
  clearInterval(peerGcTimer);
  wsServer.close();
  discoverySocket.close();
  server.close(() => {
    console.log(`[shutdown] ${signal}`);
    process.exit(0);
  });
}
