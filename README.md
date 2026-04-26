# LocalSend Web Prototype

Browser-based LAN file transfer prototype inspired by [LocalSend](https://github.com/localsend/localsend).

## Features

- Browser frontend
  - Select multiple files
  - Show nearby devices discovered on the LAN
  - Track upload progress per file
  - Show local download list
- Node.js backend
  - UDP broadcast device discovery
  - HTTP file upload and download
  - WebSocket notifications for peers and downloads
  - Optional PIN verification through `ACCESS_PIN`

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:53317`.

## Environment variables

- `PORT`: HTTP port, default `53317`
- `DISCOVERY_PORT`: UDP discovery port, default `53318`
- `DEVICE_NAME`: advertised device name, default hostname
- `ACCESS_PIN`: optional upload PIN
- `DOWNLOAD_DIR`: directory for received files, default `./downloads`

## Protocol

- Discovery: UDP broadcast JSON announcements on `DISCOVERY_PORT`
- Upload: `PUT /api/files/:filename`
- Download: `GET /downloads/:id`
- Realtime: WebSocket at `/ws`

## Smoke test

```bash
npm run smoke
```

## Two local instances

```bash
PORT=53317 DISCOVERY_PORT=53318 DEVICE_NAME=sender npm start
PORT=53327 DISCOVERY_PORT=53318 DEVICE_NAME=receiver ACCESS_PIN=2468 npm start
```

Both browser tabs will discover each other through the shared UDP port. When a receiver has `ACCESS_PIN`, enter that PIN in its device card before sending files.
