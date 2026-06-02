# FlowOne Mock Server

A local Express + CORS server that mimics the FlowOne API contract so the
FlowOne Scan mobile app can be built and tested end-to-end without the
real backend.

## Run

```powershell
npm install
npm start
```

Listens on `0.0.0.0:3000` (not just localhost) so a phone on the same
WiFi can reach it. On startup it prints a banner with the LAN IP the
phone should target:

```
┌─────────────────────────────────────────────┐
│  FlowOne Mock Server running                │
│  Local:    http://localhost:3000            │
│  Network:  http://192.168.1.7:3000          │
│  Demo:     demo@flowone.in / demo123        │
└─────────────────────────────────────────────┘
```

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `SIMULATE_FAILURES` | `true` | If `true`, ~5% of `/scan/ingest` calls return 500 so the app's retry / offline-queue paths are exercisable. Set `false` for a quiet server. |

```powershell
$env:SIMULATE_FAILURES = "false"; npm start
```

## Endpoints

### `POST /auth/login`

```json
// Request
{ "email": "demo@flowone.in", "password": "demo123" }

// 200 — success
{ "token": "mock-jwt-<uuid>", "user": { "name": "Demo User", "company": "FlowOne Demo Co" } }

// 401 — any other credentials
{ "error": "Invalid credentials" }
```

### `POST /scan/ingest`

Auth: `Authorization: Bearer mock-jwt-<...>` required. Any token starting
with `mock-jwt-` is accepted.

```json
// Request — matches the FlowOne contract exactly
{
  "action": "GRN",
  "scanned_value": "8901234567890",
  "format": "EAN_13",
  "quantity": 1,
  "notes": "Optional",
  "scanned_at": "2026-06-01T10:23:45.123Z",
  "device": { "platform": "ios", "model": "iPhone 14", "app_version": "0.1.0" }
}

// 200
{ "id": "scan_<uuid>", "status": "received" }

// 401 — missing or non-mock-jwt token
{ "error": "Missing or invalid token" }

// 500 — simulated (5% of requests when SIMULATE_FAILURES=true)
{ "error": "Simulated server error" }
```

Every successful POST is appended to `data/scans.json`.

### `GET /health`

```json
{ "status": "ok", "version": "mock-1.0.0", "timestamp": "2026-06-01T10:23:45.123Z" }
```

Use this from the phone's browser to verify reachability before
launching the app.

### `GET /scans`

Returns every submitted scan in `data/scans.json` — for developer
inspection. Not part of the FlowOne contract, mock-only.

## Persistence

Submitted scans persist in `data/scans.json` across restarts. To clear:

```powershell
Remove-Item data/scans.json
```

The file is recreated on the next `POST /scan/ingest`.

## Smoke tests

```powershell
# health
curl http://localhost:3000/health

# login
curl -X POST http://localhost:3000/auth/login `
  -H "Content-Type: application/json" `
  -d '{"email":"demo@flowone.in","password":"demo123"}'

# ingest (replace <token> with the token from login)
curl -X POST http://localhost:3000/scan/ingest `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <token>" `
  -d '{"action":"GRN","scanned_value":"123","format":"EAN_13","quantity":1,"scanned_at":"2026-06-01T00:00:00Z","device":{"platform":"curl","model":"shell","app_version":"0.1.0"}}'

# inspect
curl http://localhost:3000/scans
```
