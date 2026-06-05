/**
 * FlowOne Mock Server
 * --------------------
 * A local Express server that mimics the FlowOne API contract so the
 * FlowOne Scan mobile app can be built and tested end-to-end without the
 * real backend. Swapping to the real API later is a single config change
 * in the app (config/config.js → ACTIVE_ENV), no server needed.
 */

require('dotenv').config(); // load mock-server/.env locally (Railway injects its own env vars)

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
// Default ON in dev: 5% of /scan/ingest calls return a simulated 500 so we
// can exercise the app's retry / offline-queue paths. Set to "false" to disable.
const SIMULATE_FAILURES = process.env.SIMULATE_FAILURES !== 'false';
const FAILURE_RATE = 0.05;

// ---------------------------------------------------------------------------
// Discord notifications
// ---------------------------------------------------------------------------
// The webhook URL is read ONLY from the DISCORD_WEBHOOK_URL environment
// variable, so the secret never lands in git.
//   • Local:   put it in mock-server/.env  (gitignored)
//   • Railway: add it under the service → Variables tab
// Leave it unset to disable notifications.
//
// How to get a webhook URL:
//   Discord → Server Settings → Integrations → Webhooks → New Webhook →
//   pick a channel → Copy Webhook URL.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

const DATA_DIR = path.join(__dirname, 'data');
const SCANS_FILE = path.join(DATA_DIR, 'scans.json');
// Item master + barcode→item mapping. items.json is the catalog; barcodes.json
// maps each scannable code to an item_id (many barcodes may point to ONE item).
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const BARCODES_FILE = path.join(DATA_DIR, 'barcodes.json');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Persistence helpers — scans persist across restarts in data/scans.json
// ---------------------------------------------------------------------------
function readScans() {
  try {
    if (!fs.existsSync(SCANS_FILE)) return [];
    const raw = fs.readFileSync(SCANS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('  ! Could not read scans.json:', err.message);
    return [];
  }
}

function writeScans(scans) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCANS_FILE, JSON.stringify(scans, null, 2));
}

// ---------------------------------------------------------------------------
// Item master + barcode mapping
// ---------------------------------------------------------------------------
function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`  ! Could not read ${path.basename(file)}:`, err.message);
    return fallback;
  }
}

function readItems() {
  return readJsonFile(ITEMS_FILE, []);
}

function writeItems(items) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}

// barcode → item_id map. Object keys are unique, so a barcode can belong to at
// most one item, while many barcodes can map to the same item_id.
function readBarcodeMap() {
  return readJsonFile(BARCODES_FILE, {});
}

function writeBarcodeMap(map) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BARCODES_FILE, JSON.stringify(map, null, 2));
}

function findItemById(itemId) {
  if (!itemId) return null;
  return readItems().find((it) => it.item_id === itemId) || null;
}

function findItemByBarcode(barcode) {
  if (!barcode) return null;
  const itemId = readBarcodeMap()[barcode];
  return itemId ? findItemById(itemId) : null;
}

// Every barcode currently mapped to an item — the "many barcodes → one item" view.
function barcodesForItem(itemId) {
  const map = readBarcodeMap();
  return Object.keys(map).filter((bc) => map[bc] === itemId);
}

// ---------------------------------------------------------------------------
// Open Food Facts fallback — free public product DB, no API key.
// When a scanned code isn't in our own catalog, we ask Open Food Facts. If it
// knows the product, we show the real name AND auto-add it to the catalog, so
// scanning the same code again resolves instantly from our own data.
// Set OFF_ENABLED=false to disable.
// ---------------------------------------------------------------------------
const OFF_ENABLED = process.env.OFF_ENABLED !== 'false';
const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_TIMEOUT_MS = 4000;

// Only EAN-8 / UPC-A / EAN-13 style numeric codes are worth asking OFF about.
// Keeps QR/URL/internal codes on the instant "not found" path.
function isProductBarcode(barcode) {
  return /^\d{8}$|^\d{12,13}$/.test(barcode || '');
}

async function lookupOpenFoodFacts(barcode) {
  if (!OFF_ENABLED || !isProductBarcode(barcode)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OFF_TIMEOUT_MS);
  try {
    const url = `${OFF_BASE}/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,quantity`;
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'FlowOne-Scan-Prototype/1.0 (mock server)' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    const name = String(p.product_name || '').trim();
    if (!name) return null;
    const brand = String(p.brands || '').split(',')[0].trim();
    return { name: brand ? `${name} (${brand})` : name, brand, quantity: p.quantity || '' };
  } catch (err) {
    return null; // timeout / network / parse error → treat as a miss
  } finally {
    clearTimeout(timer);
  }
}

// Persist a freshly discovered product so future scans resolve from our catalog.
function autoCreateItem(barcode, off) {
  const items = readItems();
  const item_id = `off_${barcode}`;
  if (!items.some((it) => it.item_id === item_id)) {
    items.push({
      item_id,
      name: off.name,
      sku: `OFF-${barcode}`,
      unit: 'pcs',
      category: off.quantity ? `Open Food Facts · ${off.quantity}` : 'Open Food Facts',
      description: off.brand ? `Brand: ${off.brand}` : 'Imported from Open Food Facts',
      source: 'openfoodfacts',
    });
    writeItems(items);
  }
  const map = readBarcodeMap();
  if (map[barcode] !== item_id) {
    map[barcode] = item_id;
    writeBarcodeMap(map);
  }
  return findItemById(item_id);
}

// Resolve a barcode: our catalog first, then Open Food Facts (auto-added).
// Returns { item, source } where source is 'catalog' | 'openfoodfacts' | null.
async function resolveOrDiscover(barcode) {
  const local = findItemByBarcode(barcode);
  if (local) return { item: local, source: 'catalog' };
  const off = await lookupOpenFoodFacts(barcode);
  if (off) return { item: autoCreateItem(barcode, off), source: 'openfoodfacts' };
  return { item: null, source: null };
}

// ---------------------------------------------------------------------------
// Auth — any token starting with "mock-jwt-" is accepted (mock only)
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !token.startsWith('mock-jwt-')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Discord notification — fire-and-forget so it never blocks the API response
// ---------------------------------------------------------------------------
function notifyDiscord(record) {
  if (!DISCORD_WEBHOOK_URL) return; // notifications disabled

  // record.item is the catalog item the barcode resolved to (null if the
  // scanned code isn't mapped to any item yet).
  const item = record.item;

  const embed = {
    title: item ? `📦 ${item.name}` : '📦 Unidentified scan',
    color: item ? 0x2ecc71 : 0xe67e22, // green = matched, orange = not in catalog
    fields: [
      { name: 'Item', value: String(item ? item.name : '⚠ Not in catalog'), inline: true },
      { name: 'SKU', value: String(item ? item.sku : '—'), inline: true },
      { name: 'Action', value: String(record.action || '—'), inline: true },
      { name: 'Quantity', value: String(record.quantity ?? '—'), inline: true },
      { name: 'Unit', value: String(item ? item.unit : '—'), inline: true },
      { name: 'Format', value: String(record.format || '—'), inline: true },
      { name: 'Scanned value', value: '```' + String(record.scanned_value || '—') + '```' },
    ],
    footer: {
      text: `${record.device?.platform || 'unknown'} · ${record.device?.model || 'device'} · ${record.id}`,
    },
    timestamp: record.received_at,
  };

  if (record.notes) {
    embed.fields.push({ name: 'Notes', value: String(record.notes) });
  }

  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'FlowOne Scan', embeds: [embed] }),
  })
    .then((r) => {
      if (!r.ok) console.error(`  ! Discord webhook returned ${r.status}`);
    })
    .catch((err) => console.error('  ! Discord webhook failed:', err.message));
}

// ---------------------------------------------------------------------------
// Pretty request logging: method, path, action, scanned value
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  const action = req.body?.action ? ` action=${req.body.action}` : '';
  const value = req.body?.scanned_value ? ` value=${req.body.scanned_value}` : '';
  console.log(`[${ts}] ${req.method} ${req.path}${action}${value}`);
  next();
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === 'demo@flowone.in' && password === 'demo123') {
    return res.status(200).json({
      token: `mock-jwt-${uuidv4()}`,
      user: { name: 'Demo User', company: 'FlowOne Demo Co' },
    });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

// ---------------------------------------------------------------------------
// POST /scan/ingest  (auth required)
// ---------------------------------------------------------------------------
app.post('/scan/ingest', requireAuth, async (req, res) => {
  // Simulate transient server errors so the app's retry/queue logic is testable.
  if (SIMULATE_FAILURES && Math.random() < FAILURE_RATE) {
    console.log('  ! Simulated server error (500)');
    return res.status(500).json({ error: 'Simulated server error' });
  }

  const id = `scan_${uuidv4()}`;

  // Resolve the scan to a catalog item so the stored record AND the Discord
  // notification show WHAT was scanned, not just the raw code. Prefer an
  // explicit item_id from the app; then our catalog; then Open Food Facts
  // (which also auto-adds the product so the next scan is instant).
  let item = findItemById(req.body.item_id) || findItemByBarcode(req.body.scanned_value);
  if (!item) {
    item = (await resolveOrDiscover(req.body.scanned_value)).item;
  }

  // `item` is placed AFTER the spread so the server-resolved item is the
  // source of truth even if the client sent its own.
  const record = { id, received_at: new Date().toISOString(), ...req.body, item: item || null };

  const scans = readScans();
  scans.push(record);
  writeScans(scans);

  notifyDiscord(record); // post to Discord (no-op if no webhook configured)

  return res.status(200).json({ id, status: 'received', item });
});

// ---------------------------------------------------------------------------
// GET /product/:barcode  (auth required) — resolve a scanned code to an item
// ---------------------------------------------------------------------------
app.get('/product/:barcode', requireAuth, async (req, res) => {
  const { barcode } = req.params;
  const { item, source } = await resolveOrDiscover(barcode);
  if (!item) {
    return res.status(404).json({ error: 'not_found', barcode });
  }
  return res.status(200).json({ barcode, item, source, barcodes: barcodesForItem(item.item_id) });
});

// ---------------------------------------------------------------------------
// GET /items  (auth required) — the item catalog, each with its barcodes
// ---------------------------------------------------------------------------
app.get('/items', requireAuth, (req, res) => {
  const items = readItems().map((it) => ({
    ...it,
    barcodes: barcodesForItem(it.item_id),
  }));
  res.status(200).json(items);
});

// ---------------------------------------------------------------------------
// POST /items  (auth required) — create a brand-new item and (optionally) map
// the scanned barcode to it in one call. This is the "name it once on first
// scan, recognise it forever" path that doesn't need any external DB.
// Body: { name (required), sku?, unit?, category?, description?, barcode?, format? }
// ---------------------------------------------------------------------------
app.post('/items', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });

  // Check the barcode is free BEFORE creating, so a conflict can't orphan an item.
  const barcode = String(req.body?.barcode || '').trim();
  const map = readBarcodeMap();
  if (barcode && map[barcode]) {
    return res.status(409).json({ error: 'barcode_already_assigned', barcode, item_id: map[barcode] });
  }

  const items = readItems();
  const item_id = `item_${uuidv4().slice(0, 8)}`;
  const item = {
    item_id,
    name,
    sku: String(req.body.sku || '').trim() || `SKU-${item_id}`,
    unit: String(req.body.unit || 'pcs').trim() || 'pcs',
    category: String(req.body.category || 'Uncategorised').trim(),
    description: String(req.body.description || '').trim(),
    source: 'manual',
  };
  items.push(item);
  writeItems(items);

  if (barcode) {
    map[barcode] = item_id;
    writeBarcodeMap(map);
  }
  console.log(`  + Created item ${item_id} (${name})${barcode ? ` ← ${barcode}` : ''}`);

  return res.status(201).json({ status: 'created', item: { ...item, barcodes: barcodesForItem(item_id) } });
});

// ---------------------------------------------------------------------------
// GET /items/:item_id  (auth required) — a single item with its barcodes
// ---------------------------------------------------------------------------
app.get('/items/:item_id', requireAuth, (req, res) => {
  const item = findItemById(req.params.item_id);
  if (!item) {
    return res.status(404).json({ error: 'not_found', item_id: req.params.item_id });
  }
  res.status(200).json({ ...item, barcodes: barcodesForItem(item.item_id) });
});

// ---------------------------------------------------------------------------
// POST /items/:item_id/barcodes  (auth required)
// Assign a new/existing barcode to an item. Supports many barcodes per item.
// Body: { barcode, format? }
// ---------------------------------------------------------------------------
app.post('/items/:item_id/barcodes', requireAuth, (req, res) => {
  const { item_id } = req.params;
  const barcode = String(req.body?.barcode || '').trim();

  const item = findItemById(item_id);
  if (!item) return res.status(404).json({ error: 'item_not_found', item_id });
  if (!barcode) return res.status(400).json({ error: 'barcode_required' });

  const map = readBarcodeMap();
  const existing = map[barcode];
  // A barcode can belong to only ONE item — block silently re-pointing it.
  if (existing && existing !== item_id) {
    return res.status(409).json({ error: 'barcode_already_assigned', barcode, item_id: existing });
  }

  map[barcode] = item_id; // assign (idempotent if it's already this item)
  writeBarcodeMap(map);
  console.log(`  + Assigned barcode ${barcode} → ${item_id} (${item.name})`);

  return res.status(200).json({
    status: 'assigned',
    barcode,
    item: { ...item, barcodes: barcodesForItem(item_id) },
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: 'mock-1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /scans — developer inspection of everything submitted
// ---------------------------------------------------------------------------
app.get('/scans', (req, res) => {
  res.status(200).json(readScans());
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function getLanIp() {
  const ifaces = os.networkInterfaces();
  // Skip virtual adapters (VPNs, hypervisors) — the phone can't reach those.
  const SKIP = /wireguard|surfshark|vpn|virtualbox|vmware|hyper-v|loopback|docker|tailscale|zerotier/i;

  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    if (SKIP.test(name)) continue;
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue; // link-local / unassigned
      candidates.push({ name, address: iface.address });
    }
  }

  // Prefer a real Wi-Fi / Ethernet adapter when present.
  const preferred = candidates.find((c) => /wi-?fi|wireless|ethernet|en0|wlan/i.test(c.name));
  return (preferred || candidates[0])?.address || 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIp();
  const pad = (s) => s + ' '.repeat(Math.max(0, 43 - s.length));
  console.log('┌─────────────────────────────────────────────┐');
  console.log(`│  ${pad('FlowOne Mock Server running')}│`);
  console.log(`│  ${pad(`Local:    http://localhost:${PORT}`)}│`);
  console.log(`│  ${pad(`Network:  http://${ip}:${PORT}`)}│`);
  console.log(`│  ${pad('Demo:     demo@flowone.in / demo123')}│`);
  console.log('└─────────────────────────────────────────────┘');
  console.log(`  Item catalog:       ${readItems().length} items, ${Object.keys(readBarcodeMap()).length} barcodes mapped`);
  console.log(`  Open Food Facts:    ${OFF_ENABLED ? 'ON (fallback for unknown barcodes)' : 'OFF'}`);
  console.log(`  Simulated failures: ${SIMULATE_FAILURES ? `ON (${FAILURE_RATE * 100}%)` : 'OFF'}`);
  console.log(`  Discord webhook:    ${DISCORD_WEBHOOK_URL ? 'ON' : 'OFF (paste URL in server.js or set DISCORD_WEBHOOK_URL)'}`);
  console.log(`  Phone should use:   http://${ip}:${PORT}`);
});
