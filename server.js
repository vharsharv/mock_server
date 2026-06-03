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
// Discord notification — fire-and-forget so it never blocks the API response
// ---------------------------------------------------------------------------
function notifyDiscord(record) {
  if (!DISCORD_WEBHOOK_URL) return; // notifications disabled

  const embed = {
    title: '📦 New product scanned',
    color: 0x2ecc71,
    fields: [
      { name: 'Action', value: String(record.action || '—'), inline: true },
      { name: 'Quantity', value: String(record.quantity ?? '—'), inline: true },
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
app.post('/scan/ingest', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token || !token.startsWith('mock-jwt-')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  // Simulate transient server errors so the app's retry/queue logic is testable.
  if (SIMULATE_FAILURES && Math.random() < FAILURE_RATE) {
    console.log('  ! Simulated server error (500)');
    return res.status(500).json({ error: 'Simulated server error' });
  }

  const id = `scan_${uuidv4()}`;
  const record = { id, received_at: new Date().toISOString(), ...req.body };

  const scans = readScans();
  scans.push(record);
  writeScans(scans);

  notifyDiscord(record); // post to Discord (no-op if no webhook configured)

  return res.status(200).json({ id, status: 'received' });
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
  console.log(`  Simulated failures: ${SIMULATE_FAILURES ? `ON (${FAILURE_RATE * 100}%)` : 'OFF'}`);
  console.log(`  Discord webhook:    ${DISCORD_WEBHOOK_URL ? 'ON' : 'OFF (paste URL in server.js or set DISCORD_WEBHOOK_URL)'}`);
  console.log(`  Phone should use:   http://${ip}:${PORT}`);
});
