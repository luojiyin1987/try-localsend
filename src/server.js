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
const DISCOVERY_PORT = Number.parseInt(process.env.DISCOVERY_PORT || '53317', 10);
const DISCOVERY_ADDRESS = (process.env.DISCOVERY_ADDRESS || '224.0.0.167').trim();
const ANNOUNCE_INTERVAL_MS = Number.parseInt(process.env.ANNOUNCE_INTERVAL_MS || '5000', 10);
const PEER_TTL_MS = Number.parseInt(process.env.PEER_TTL_MS || '15000', 10);
const PROTOCOL_VERSION = (process.env.PROTOCOL_VERSION || '2.0').trim();
const HTTP_PROTOCOL = (process.env.HTTP_PROTOCOL || 'http').trim();
const SCAN_TIMEOUT_MS = Number.parseInt(process.env.SCAN_TIMEOUT_MS || '900', 10);
const SCAN_CONCURRENCY = Number.parseInt(process.env.SCAN_CONCURRENCY || '24', 10);
const SCAN_HOST_LIMIT = Number.parseInt(process.env.SCAN_HOST_LIMIT || '256', 10);
const ACCESS_PIN = (process.env.ACCESS_PIN || '').trim();
const DEVICE_NAME = (process.env.DEVICE_NAME || os.hostname()).trim();
const DEVICE_MODEL = (process.env.DEVICE_MODEL || os.type()).trim();
const DEVICE_TYPE = (process.env.DEVICE_TYPE || 'web').trim();
const FINGERPRINT =
  process.env.FINGERPRINT ||
  crypto
    .createHash('sha256')
    .update(`${DEVICE_NAME}:${HTTP_PORT}:${os.hostname()}`)
    .digest('hex')
    .slice(0, 64);
const DEVICE_ID = process.env.DEVICE_ID || FINGERPRINT;

const peers = new Map();
const downloads = [];
const sockets = new Set();
const localInterfaces = listLocalIpv4Interfaces();
const localAddress = localInterfaces[0]?.address || '127.0.0.1';
const activeProbes = new Set();
const recentRegisterReplies = new Map();
let scanPromise = null;

await fsp.mkdir(downloadDir, { recursive: true });
await loadExistingDownloads();

const discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
discoverySocket.on('error', (error) => {
  console.error('[udp] error', error);
});

discoverySocket.on('message', (message, rinfo) => {
  const payload = tryParseJson(message);
  void handleDiscoveryMessage(payload, rinfo);
});

discoverySocket.bind(DISCOVERY_PORT, () => {
  discoverySocket.setMulticastTTL(1);
  discoverySocket.setMulticastLoopback(true);
  joinDiscoveryGroups();
  announceSelf();
  console.log(`[udp] discovery listening on ${DISCOVERY_ADDRESS}:${DISCOVERY_PORT}`);
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

    if (req.method === 'POST' && requestUrl.pathname === '/api/scan') {
      const result = await scanLocalSubnet();
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/localsend/v2/register') {
      return handleLocalSendRegister(req, res, requestUrl);
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
  console.log(`[localsend] fingerprint ${FINGERPRINT}`);
  console.log(`[storage] ${downloadDir}`);
  if (ACCESS_PIN) {
    console.log('[auth] upload PIN enabled');
  }
  void scanLocalSubnet();
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

async function handleLocalSendRegister(req, res, _requestUrl) {
  const payload = await readJsonBody(req);
  if (!isLocalSendPeerPayload(payload) || !hasEndpointInfo(payload)) {
    return sendJson(res, 400, { error: 'Invalid LocalSend register payload' });
  }

  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
  upsertPeer(normalizeLocalSendPeer(payload, remoteAddress, 'http-register'));
  sendJson(res, 200, buildLocalSendIdentity());
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
  const payload = Buffer.from(JSON.stringify(buildLocalSendIdentity({ announce: true })));
  discoverySocket.send(payload, DISCOVERY_PORT, DISCOVERY_ADDRESS);
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
    alias: DEVICE_NAME,
    fingerprint: FINGERPRINT,
    version: PROTOCOL_VERSION,
    deviceModel: DEVICE_MODEL,
    deviceType: DEVICE_TYPE,
    address: localAddress,
    httpPort: HTTP_PORT,
    protocol: HTTP_PROTOCOL,
    download: true,
    discoveryProtocol: 'localsend-v2',
    baseUrl: `${HTTP_PROTOCOL}://${localAddress}:${HTTP_PORT}`,
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
      protocol: peer.protocol,
      version: peer.version,
      fingerprint: peer.fingerprint,
      deviceModel: peer.deviceModel,
      deviceType: peer.deviceType,
      download: peer.download,
      tokenRequired: peer.tokenRequired,
      discoveryMethod: peer.discoveryMethod,
      supportsCustomUpload: peer.supportsCustomUpload,
      baseUrl: `${peer.protocol}://${peer.address}:${peer.httpPort}`,
      lastSeen: peer.lastSeen
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
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

function listLocalIpv4Interfaces() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push({
          address: entry.address,
          netmask: entry.netmask,
          cidr: entry.cidr || `${entry.address}/${prefixFromNetmask(entry.netmask)}`
        });
      }
    }
  }

  return addresses;
}

function hasPeerChanged(previous, next) {
  return (
    previous.name !== next.name ||
    previous.address !== next.address ||
    previous.httpPort !== next.httpPort ||
    previous.protocol !== next.protocol ||
    previous.version !== next.version ||
    previous.deviceModel !== next.deviceModel ||
    previous.deviceType !== next.deviceType ||
    previous.download !== next.download ||
    previous.tokenRequired !== next.tokenRequired ||
    previous.supportsCustomUpload !== next.supportsCustomUpload
  );
}

async function handleDiscoveryMessage(payload, rinfo) {
  if (!isLocalSendPeerPayload(payload) || !hasEndpointInfo(payload) || payload.fingerprint === FINGERPRINT) {
    return;
  }

  const peer = normalizeLocalSendPeer(payload, normalizeRemoteAddress(rinfo.address), 'udp-multicast');
  upsertPeer(peer);

  if (payload.announce === true) {
    maybeReplyToAnnouncement(peer, rinfo.port);
  }
}

function joinDiscoveryGroups() {
  if (localInterfaces.length === 0) {
    try {
      discoverySocket.addMembership(DISCOVERY_ADDRESS);
    } catch (error) {
      console.warn('[udp] addMembership default failed', error.message);
    }
    return;
  }

  for (const iface of localInterfaces) {
    try {
      discoverySocket.addMembership(DISCOVERY_ADDRESS, iface.address);
    } catch (error) {
      console.warn(`[udp] addMembership failed for ${iface.address}`, error.message);
    }
  }
}

function buildLocalSendIdentity(overrides = {}) {
  return {
    alias: DEVICE_NAME,
    version: PROTOCOL_VERSION,
    deviceModel: DEVICE_MODEL,
    deviceType: DEVICE_TYPE,
    fingerprint: FINGERPRINT,
    port: HTTP_PORT,
    protocol: HTTP_PROTOCOL,
    download: true,
    ...overrides
  };
}

function isLocalSendPeerPayload(payload) {
  return (
    payload &&
    typeof payload === 'object' &&
    typeof payload.alias === 'string' &&
    typeof payload.fingerprint === 'string'
  );
}

function hasEndpointInfo(payload) {
  return typeof payload?.port === 'number' && typeof payload?.protocol === 'string';
}

function normalizeLocalSendPeer(payload, address, discoveryMethod, fallback = {}) {
  const protocol = payload.protocol || fallback.protocol || 'http';
  const httpPort = Number(payload.port ?? fallback.httpPort) || HTTP_PORT;

  return {
    id: payload.fingerprint,
    fingerprint: payload.fingerprint,
    name: payload.alias || 'Unknown Device',
    address,
    httpPort,
    protocol: protocol === 'https' ? 'https' : 'http',
    version: payload.version || fallback.version || PROTOCOL_VERSION,
    deviceModel: payload.deviceModel || null,
    deviceType: payload.deviceType || null,
    download: Boolean(payload.download),
    tokenRequired: false,
    discoveryMethod,
    supportsCustomUpload: protocol === 'http' ? null : false,
    lastSeen: Date.now()
  };
}

function upsertPeer(peer) {
  const previous = peers.get(peer.id);
  const merged = previous
    ? {
        ...previous,
        ...peer,
        supportsCustomUpload:
          peer.supportsCustomUpload !== null && peer.supportsCustomUpload !== undefined
            ? peer.supportsCustomUpload
            : previous.supportsCustomUpload
      }
    : peer;

  peers.set(peer.id, merged);

  if (!previous || hasPeerChanged(previous, merged)) {
    broadcastJson({ type: 'peers', peers: listPeers() });
  }

  if (merged.protocol === 'http' && merged.supportsCustomUpload === null) {
    void probeCustomUploadSupport(merged.id);
  }
}

function maybeReplyToAnnouncement(peer, replyPort) {
  const lastReplyAt = recentRegisterReplies.get(peer.id) || 0;
  if (Date.now() - lastReplyAt < 3000) {
    return;
  }

  recentRegisterReplies.set(peer.id, Date.now());
  void sendRegisterToPeer(peer);
  sendUdpFallbackResponse(peer.address, replyPort);
}

async function sendRegisterToPeer(peer) {
  try {
    const response = await fetch(`${peer.protocol}://${peer.address}:${peer.httpPort}/api/localsend/v2/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildLocalSendIdentity()),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    if (isLocalSendPeerPayload(payload)) {
      upsertPeer(normalizeLocalSendPeer(payload, peer.address, 'http-register', peer));
    }
  } catch {
    // UDP fallback below covers the discovery case where HTTP register is blocked.
  }
}

function sendUdpFallbackResponse(address, port) {
  const payload = Buffer.from(JSON.stringify(buildLocalSendIdentity({ announce: false })));
  discoverySocket.send(payload, port, address);
}

async function probeCustomUploadSupport(peerId) {
  if (activeProbes.has(peerId)) {
    return;
  }

  const peer = peers.get(peerId);
  if (!peer || peer.protocol !== 'http') {
    return;
  }

  activeProbes.add(peerId);

  try {
    const response = await fetch(`${peer.protocol}://${peer.address}:${peer.httpPort}/api/info`, {
      signal: AbortSignal.timeout(1500)
    });
    const payload = response.ok ? await response.json() : null;
    updatePeerCompatibility(peerId, Boolean(payload && payload.device));
  } catch {
    updatePeerCompatibility(peerId, false);
  } finally {
    activeProbes.delete(peerId);
  }
}

function updatePeerCompatibility(peerId, supportsCustomUpload) {
  const peer = peers.get(peerId);
  if (!peer || peer.supportsCustomUpload === supportsCustomUpload) {
    return;
  }

  peers.set(peerId, {
    ...peer,
    supportsCustomUpload
  });
  broadcastJson({ type: 'peers', peers: listPeers() });
}

async function scanLocalSubnet() {
  if (scanPromise) {
    return scanPromise;
  }

  scanPromise = performSubnetScan().finally(() => {
    scanPromise = null;
  });

  return scanPromise;
}

async function performSubnetScan() {
  const candidates = buildScanTargets();
  if (candidates.length === 0) {
    return { scanned: 0, found: 0, peers: listPeers() };
  }

  let found = 0;
  let index = 0;

  async function worker() {
    while (index < candidates.length) {
      const current = candidates[index];
      index += 1;
      found += await tryRegisterCandidate(current);
    }
  }

  const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);

  broadcastJson({ type: 'peers', peers: listPeers() });
  return { scanned: candidates.length, found, peers: listPeers() };
}

function buildScanTargets() {
  const targets = new Set();

  for (const iface of localInterfaces) {
    for (const address of enumerateSubnetHosts(iface)) {
      if (address !== iface.address) {
        targets.add(address);
      }
    }
  }

  return [...targets];
}

function enumerateSubnetHosts(iface) {
  const prefix = prefixFromNetmask(iface.netmask);
  if (prefix < 16) {
    return [];
  }

  const ipInt = ipv4ToInt(iface.address);
  const maskInt = ipv4ToInt(iface.netmask);
  const networkInt = ipInt & maskInt;
  const broadcastInt = networkInt | (~maskInt >>> 0);
  const results = [];

  for (let value = networkInt + 1; value < broadcastInt; value += 1) {
    results.push(intToIpv4(value >>> 0));
    if (results.length >= SCAN_HOST_LIMIT) {
      break;
    }
  }

  return results;
}

async function tryRegisterCandidate(address) {
  try {
    const response = await fetch(`http://${address}:53317/api/localsend/v2/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildLocalSendIdentity()),
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS)
    });

    if (!response.ok) {
      return 0;
    }

    const payload = await response.json();
    if (!isLocalSendPeerPayload(payload)) {
      return 0;
    }

    upsertPeer(normalizeLocalSendPeer(payload, address, 'http-scan', { httpPort: 53317, protocol: 'http' }));
    return 1;
  } catch {
    return 0;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeRemoteAddress(address) {
  if (!address) {
    return '127.0.0.1';
  }

  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function prefixFromNetmask(netmask) {
  return netmask
    .split('.')
    .map((part) => Number.parseInt(part, 10).toString(2).padStart(8, '0'))
    .join('')
    .replaceAll('0', '').length;
}

function ipv4ToInt(address) {
  return address.split('.').reduce((accumulator, part) => ((accumulator << 8) | Number.parseInt(part, 10)) >>> 0, 0);
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
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
