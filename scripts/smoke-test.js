import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 54321;
const server = spawn('node', ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    DISCOVERY_PORT: '54322',
    DEVICE_NAME: 'smoke-test-device'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let ready = false;

server.stdout.on('data', (chunk) => {
  if (chunk.toString().includes(`[http] listening on http://0.0.0.0:${port}`)) {
    ready = true;
  }
});

server.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

await waitForReady();

try {
  const infoResponse = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(infoResponse.status, 200);
  const infoPayload = await infoResponse.json();
  assert.equal(infoPayload.device.name, 'smoke-test-device');

  const peersResponse = await fetch(`http://127.0.0.1:${port}/api/peers`);
  assert.equal(peersResponse.status, 200);
  const peersPayload = await peersResponse.json();
  assert.ok(Array.isArray(peersPayload.peers));

  const uploadsResponse = await fetch(`http://127.0.0.1:${port}/api/downloads`);
  assert.equal(uploadsResponse.status, 200);
  const uploadsPayload = await uploadsResponse.json();
  assert.ok(Array.isArray(uploadsPayload.downloads));

  console.log('smoke OK');
} finally {
  server.kill('SIGTERM');
}

async function waitForReady() {
  const started = Date.now();

  while (!ready) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early with code ${server.exitCode}`);
    }
    if (Date.now() - started > 10000) {
      throw new Error('server did not start in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
