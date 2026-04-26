const state = {
  self: null,
  peers: [],
  downloads: [],
  files: [],
  uploads: [],
  socket: null,
  peerPins: {}
};

const selfDeviceEl = document.querySelector('#self-device');
const fileInputEl = document.querySelector('#file-input');
const selectedFilesEl = document.querySelector('#selected-files');
const peersEl = document.querySelector('#peers');
const uploadsEl = document.querySelector('#uploads');
const downloadsEl = document.querySelector('#downloads');
const refreshBtnEl = document.querySelector('#refresh-btn');
const peerTemplate = document.querySelector('#peer-template');

fileInputEl.addEventListener('change', (event) => {
  state.files = [...(event.target.files || [])];
  renderSelectedFiles();
  renderPeers();
});

refreshBtnEl.addEventListener('click', async () => {
  await requestScan();
  await Promise.all([loadPeers(), loadDownloads()]);
});

await bootstrap();

async function bootstrap() {
  await Promise.all([loadSelf(), loadDownloads()]);
  await requestScan();
  await loadPeers();
  connectSocket();
}

async function requestScan() {
  try {
    await fetch('/api/scan', {
      method: 'POST'
    });
  } catch {
    // Discovery remains best-effort. The WebSocket snapshot will refresh if the scan succeeds later.
  }
}

async function loadSelf() {
  const response = await fetch('/api/info');
  const data = await response.json();
  state.self = data.device;
  renderSelf();
}

async function loadPeers() {
  const response = await fetch('/api/peers');
  const data = await response.json();
  state.peers = data.peers;
  renderPeers();
}

async function loadDownloads() {
  const response = await fetch('/api/downloads');
  const data = await response.json();
  state.downloads = data.downloads;
  renderDownloads();
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') {
      state.self = message.device;
      state.peers = message.peers;
      state.downloads = message.downloads;
      renderSelf();
      renderPeers();
      renderDownloads();
      return;
    }

    if (message.type === 'peers') {
      state.peers = message.peers;
      renderPeers();
      return;
    }

    if (message.type === 'download-added') {
      state.downloads = message.downloads;
      renderDownloads();
    }
  });

  socket.addEventListener('close', () => {
    window.setTimeout(connectSocket, 2000);
  });
}

function renderSelf() {
  if (!state.self) {
    selfDeviceEl.textContent = 'Unavailable';
    return;
  }

  selfDeviceEl.innerHTML = `
    <strong>${escapeHtml(state.self.name)}</strong>
    <span>${escapeHtml(state.self.baseUrl)}</span>
    <span>${state.self.tokenRequired ? 'Protected by PIN' : 'Open for LAN uploads'}</span>
  `;
}

function renderSelectedFiles() {
  if (state.files.length === 0) {
    selectedFilesEl.classList.add('empty');
    selectedFilesEl.innerHTML = '<li>No files selected yet.</li>';
    return;
  }

  selectedFilesEl.classList.remove('empty');
  selectedFilesEl.innerHTML = state.files
    .map(
      (file) => `
        <li>
          <strong>${escapeHtml(file.name)}</strong>
          <span>${formatBytes(file.size)}</span>
        </li>
      `
    )
    .join('');
}

function renderPeers() {
  peersEl.innerHTML = '';

  if (state.peers.length === 0) {
    peersEl.innerHTML = '<p class="empty-inline">No nearby devices discovered yet.</p>';
    return;
  }

  for (const peer of state.peers) {
    const node = peerTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.device-name').textContent = peer.name;
    node.querySelector('.device-address').textContent =
      `${peer.baseUrl} · ${peer.deviceType || 'device'} · ${peer.discoveryMethod}`;

    const pill = node.querySelector('.auth-pill');
    pill.textContent = capabilityLabel(peer);
    pill.dataset.secure = String(peer.tokenRequired || peer.supportsCustomUpload === false);

    const pinInput = node.querySelector('.pin-input');
    pinInput.value = state.peerPins[peer.id] || '';
    pinInput.addEventListener('input', (event) => {
      state.peerPins[peer.id] = event.target.value;
    });
    pinInput.disabled = peer.supportsCustomUpload !== true;

    const sendButton = node.querySelector('.send-btn');
    sendButton.disabled = state.files.length === 0 || peer.supportsCustomUpload !== true;
    sendButton.textContent = peer.supportsCustomUpload === true ? 'Send selected files' : 'Discovery only';
    sendButton.addEventListener('click', () => sendFilesToPeer(peer));

    peersEl.appendChild(node);
  }
}

function renderUploads() {
  if (state.uploads.length === 0) {
    uploadsEl.classList.add('empty');
    uploadsEl.textContent = 'No active uploads.';
    return;
  }

  uploadsEl.classList.remove('empty');
  uploadsEl.innerHTML = state.uploads
    .map(
      (upload) => `
        <article class="upload-row">
          <div class="upload-top">
            <strong>${escapeHtml(upload.fileName)}</strong>
            <span>${escapeHtml(upload.deviceName)} · ${upload.status}</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar" style="width:${upload.progress}%"></div>
          </div>
          <div class="upload-bottom">
            <span>${upload.progress}%</span>
            <span>${formatBytes(upload.loaded)} / ${formatBytes(upload.total)}</span>
          </div>
        </article>
      `
    )
    .join('');
}

function renderDownloads() {
  if (state.downloads.length === 0) {
    downloadsEl.classList.add('empty');
    downloadsEl.textContent = 'No files received yet.';
    return;
  }

  downloadsEl.classList.remove('empty');
  downloadsEl.innerHTML = state.downloads
    .map(
      (download) => `
        <a class="download-row" href="${download.url}">
          <div>
            <strong>${escapeHtml(download.originalName || download.name)}</strong>
            <span>${escapeHtml(download.senderName)} · ${new Date(download.receivedAt).toLocaleString()}</span>
          </div>
          <span>${formatBytes(download.size)}</span>
        </a>
      `
    )
    .join('');
}

async function sendFilesToPeer(peer) {
  const pin = state.peerPins[peer.id] || '';

  for (const file of state.files) {
    const upload = {
      id: `${peer.id}-${file.name}-${Date.now()}`,
      fileName: file.name,
      deviceName: peer.name,
      progress: 0,
      loaded: 0,
      total: file.size,
      status: 'Queued'
    };

    state.uploads.unshift(upload);
    renderUploads();

    try {
      upload.status = 'Uploading';
      renderUploads();
      await sendSingleFile(peer, file, pin, upload);
      upload.progress = 100;
      upload.loaded = file.size;
      upload.status = 'Completed';
      renderUploads();
    } catch (error) {
      upload.status = error.message || 'Failed';
      renderUploads();
    }
  }
}

function sendSingleFile(peer, file, pin, upload) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = new URL(`/api/files/${encodeURIComponent(file.name)}`, peer.baseUrl);

    if (state.self) {
      url.searchParams.set('senderId', state.self.id);
      url.searchParams.set('senderName', state.self.name);
    }

    xhr.open('PUT', url);
    xhr.setRequestHeader('X-File-Size', String(file.size));
    xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
    if (pin) {
      xhr.setRequestHeader('X-Device-Token', pin);
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) {
        return;
      }
      upload.loaded = event.loaded;
      upload.total = event.total;
      upload.progress = Math.round((event.loaded / event.total) * 100);
      renderUploads();
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const payload = JSON.parse(xhr.responseText);
          reject(new Error(payload.error || `Upload failed (${xhr.status})`));
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(file);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function capabilityLabel(peer) {
  if (peer.supportsCustomUpload === true) {
    return peer.tokenRequired ? 'PIN required' : 'Send ready';
  }

  if (peer.supportsCustomUpload === null) {
    return 'Checking upload API';
  }

  if (peer.protocol === 'https') {
    return 'LocalSend HTTPS';
  }

  return 'LocalSend discovery';
}
