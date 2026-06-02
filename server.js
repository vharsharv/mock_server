/**
 * FlowOne Mock Server
 * --------------------
 * A local Express server that mimics the FlowOne API contract so the
 * FlowOne Scan mobile app can be built and tested end-to-end without the
 * real backend. Swapping to the real API later is a single config change
 * in the app (config/config.js → ACTIVE_ENV), no server needed.
 */

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
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
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
  console.log(`  Phone should use:   http://${ip}:${PORT}`);
});
