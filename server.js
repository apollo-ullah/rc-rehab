// RC-Rehab on a laptop: `npm start`. Serves the pages, saves to JSON files in data/,
// and opens a cloudflared quick tunnel so phones get an HTTPS link.
// The game logic itself lives in server/arena.js (shared with the cloud version, server/relay.js).
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createArena, createHttpApi, roleFor } from './server/arena.js';
import { qrSvg } from './server/qr.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CAR_TOKEN = process.env.CAR_TOKEN || 'letsgo';
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(3).toString('hex');
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(DIR, 'data', 'results.json');
const PRACTICE_FILE = process.env.PRACTICE_FILE || path.join(path.dirname(RESULTS_FILE), 'practice.json');

// ---------- Saved data: JSON files ----------
function fileStore() {
  const load = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const save = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
  };
  const results = load(RESULTS_FILE, []);
  const practice = load(PRACTICE_FILE, []); // one entry per lesson, boss race or Grand Prix finish
  return {
    results,
    practice,
    addResult(e) {
      results.push(e);
      save(RESULTS_FILE, results);
    },
    addPractice(e) {
      practice.push(e);
      save(PRACTICE_FILE, practice);
    },
    allPractice: () => practice,
    reset() {
      results.length = 0;
      practice.length = 0;
      save(RESULTS_FILE, results);
      save(PRACTICE_FILE, practice);
    },
  };
}

const store = fileStore();
const api = createHttpApi({ store, adminKey: ADMIN_KEY });
const arena = createArena({
  store,
  carToken: CAR_TOKEN,
  adminKey: ADMIN_KEY,
  publicUrl: process.env.PUBLIC_URL || null,
  timeZone: process.env.TIME_ZONE,
});

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(DIR, 'public')));
app.get('/screen', (_req, res) => res.sendFile(path.join(DIR, 'public', 'screen.html')));
app.get(['/arcade', '/path', '/arms'], (_req, res) => res.sendFile(path.join(DIR, 'public', 'index.html')));
app.get('/qr.svg', (req, res) => {
  const svg = qrSvg(req.query.text);
  if (!svg) return res.status(400).end();
  res.type('image/svg+xml').send(svg);
});
app.use('/api', express.json({ limit: '64kb' }), async (req, res) => {
  const url = new URL(req.originalUrl, 'http://local');
  const out = await api({ method: req.method, path: url.pathname, params: url.searchParams, body: req.body, publicUrl: arena.publicUrl });
  if (!out) return res.status(404).end();
  res.status(out.status);
  if ('json' in out) return res.json(out.json);
  if (out.filename) res.attachment(out.filename);
  res.type(out.type).send(out.text);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  const role = roleFor(url.pathname, url.searchParams, CAR_TOKEN);
  if (!role) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const conn = {
      send: (text) => ws.send(text),
      close: () => ws.close(),
      get open() {
        return ws.readyState === 1;
      },
    };
    const h = arena.connect(conn, role, { remote: req.socket.remoteAddress });
    ws.on('message', (m) => h.message(String(m)));
    ws.on('close', h.close);
  });
});

// Drop dead sockets (phones that vanished, car that lost power).
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 3000);

// ---------- Startup ----------
function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function startTunnel() {
  if (arena.publicUrl || process.env.NO_TUNNEL) return;
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('error', () => {
    console.log('\n⚠️  cloudflared is not installed, so phones have no HTTPS link yet.');
    console.log('    Install it:  brew install cloudflared   then restart.');
    console.log('    (Or set PUBLIC_URL to an HTTPS address that points at this laptop.)\n');
  });
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !arena.publicUrl) {
      arena.setPublicUrl(m[0]);
      console.log(`\n📱 Players scan the QR on the big screen, or open: ${m[0]}\n`);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const kill = () => proc.kill();
  process.on('exit', kill);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

server.listen(PORT, () => {
  console.log(`\n🏁 RC Race running on port ${PORT}`);
  console.log(`🖥  Big screen (host controls): http://localhost:${PORT}/screen?admin=${ADMIN_KEY}`);
  console.log(`🔌 ESP32 SERVER_HOST should be one of: ${lanIps().join(', ') || '(no network found)'}  port ${PORT}`);
  startTunnel();
});
