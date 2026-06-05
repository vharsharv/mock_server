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
| `OFF_ENABLED` | `true` | If `true`, barcodes not in the local catalog are looked up in Open Food Facts and auto-added (see below). Set `false` to use only the local catalog. |
| `DISCORD_WEBHOOK_URL` | _(unset)_ | If set, each ingested scan is posted to Discord (with the resolved item). |

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

Every successful POST is appended to `data/scans.json`. The server resolves
the scan to a catalog item (via `item_id` if the app sends one, otherwise by
looking up `scanned_value` in the barcode map) and attaches the resolved
`item` (or `null`) to both the stored record and the Discord notification.

```json
// 200 — now also echoes the resolved item
{ "id": "scan_<uuid>", "status": "received", "item": { "item_id": "item_004", "name": "Laptop Charger 65W USB-C", ... } }
```

## Item master + barcode mapping

The catalog lives in two files:

- `data/items.json` — the item master: `{ item_id, name, sku, unit, category, description }`
- `data/barcodes.json` — a `barcode → item_id` map. Object keys are unique, so a
  barcode belongs to at most one item, while **many barcodes can map to one item**.

### `GET /product/:barcode`

Auth required. Resolve a scanned code to its item. Resolution order:

1. **Local catalog** — `barcodes.json` → `items.json` (`source: "catalog"`).
2. **Open Food Facts fallback** (if `OFF_ENABLED`, only for 8/12/13-digit
   numeric codes) — if the public DB knows the product, it's **auto-added** to
   the catalog and returned (`source: "openfoodfacts"`). The next scan of the
   same code then resolves locally as `"catalog"`.
3. Otherwise `404 not_found`.

```json
// 200 — matched
{
  "barcode": "8901234567890",
  "item": { "item_id": "item_001", "name": "Blue Gel Pen 0.5mm", "sku": "STAT-PEN-001", ... },
  "source": "catalog",
  "barcodes": ["8901234567890", "8901234567891"]
}

// 200 — first time, resolved + learned via Open Food Facts
{
  "barcode": "3017620422003",
  "item": { "item_id": "off_3017620422003", "name": "Nutella (Nutella)", "source": "openfoodfacts", ... },
  "source": "openfoodfacts",
  "barcodes": ["3017620422003"]
}

// 404 — not in catalog and unknown to Open Food Facts
{ "error": "not_found", "barcode": "9999999999" }
```

### `GET /items`

Auth required. The full catalog, each item with its currently mapped `barcodes`.

### `POST /items`

Auth required. Create a brand-new item and (optionally) map the scanned barcode
to it in one call — the "name it once, recognise it forever" path (no external
DB needed). The barcode is checked for conflicts *before* the item is created.

```json
// Request
{ "name": "Stapler No. 10", "sku": "STAT-STP-10", "unit": "pcs",
  "category": "Stationery", "description": "Half-strip stapler",
  "barcode": "8901111222333", "format": "EAN_13" }

// 201 — created (item_id generated, source:"manual")
{ "status": "created", "item": { "item_id": "item_a1b2c3d4", "name": "Stapler No. 10",
  "source": "manual", "barcodes": ["8901111222333"], ... } }

// 400 — missing name
{ "error": "name_required" }

// 409 — barcode already belongs to another item
{ "error": "barcode_already_assigned", "barcode": "8901111222333", "item_id": "item_001" }
```

### `GET /items/:item_id`

Auth required. A single item with its `barcodes`, or `404 not_found`.

### `POST /items/:item_id/barcodes`

Auth required. Assign a new/existing barcode to an item (the "an item got a new
barcode" case). Supports many barcodes per item.

```json
// Request
{ "barcode": "NEWLABEL-XYZ", "format": "CODE_128" }

// 200 — assigned (idempotent if already this item)
{ "status": "assigned", "barcode": "NEWLABEL-XYZ", "item": { "item_id": "item_006", "barcodes": ["NEWLABEL-XYZ"], ... } }

// 404 — no such item
{ "error": "item_not_found", "item_id": "item_999" }

// 400 — empty barcode
{ "error": "barcode_required" }

// 409 — barcode already belongs to a different item
{ "error": "barcode_already_assigned", "barcode": "NEWLABEL-XYZ", "item_id": "item_006" }
```

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
