// RC Race server: serves the pages, runs the driver queue and the leaderboard,
// and forwards the virtual car's steering + speed to the ESP32.
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { STAR_BONUS_MS, RUN_TIMEOUT_MS, ASSIST } from './public/game.js';
import { raceTrack } from './public/tracks.js';
import { UNITS, KINDS, LEVELS, XP, REPS_PER_LESSON, levelName, unitIndex, localDay } from './public/path.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CAR_TOKEN = process.env.CAR_TOKEN || 'letsgo';
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(3).toString('hex');
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(DIR, 'data', 'results.json');
const PRACTICE_FILE = process.env.PRACTICE_FILE || path.join(path.dirname(RESULTS_FILE), 'practice.json');
const PROFILES_FILE = process.env.PROFILES_FILE || path.join(path.dirname(RESULTS_FILE), 'profiles.json');
const CLAIM_MS = 45000; // time to press start when it's your turn
const COUNTDOWN = 3;
const STALE_MS = 400; // car stops if the phone goes quiet this long

let publicUrl = process.env.PUBLIC_URL || null;

// ---------- Saved data ----------
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
let results = load(RESULTS_FILE, []);
const practice = load(PRACTICE_FILE, []); // one entry per lesson, boss race or Grand Prix finish
const profiles = load(PROFILES_FILE, {}); // practice path progress, by lower-case name
const saveResults = () => save(RESULTS_FILE, results);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const isGp = (r) => !r.level || r.level === 'gp';

// Leaderboards only rank the Grand Prix: boss races use different controls, so times don't compare.
function boards() {
  const byName = new Map();
  for (const r of results.filter(isGp)) {
    if (!byName.has(r.key)) byName.set(r.key, []);
    byName.get(r.key).push(r);
  }
  const fastest = [];
  const improved = [];
  for (const runs of byName.values()) {
    const best = runs.reduce((a, b) => (b.finalMs < a.finalMs ? b : a));
    fastest.push({ name: best.name, ms: best.finalMs, assist: best.assist, stars: best.stars });
    if (runs.length >= 2 && runs[0].finalMs - best.finalMs > 0) {
      improved.push({ name: best.name, gainMs: runs[0].finalMs - best.finalMs, runs: runs.length });
    }
  }
  fastest.sort((a, b) => a.ms - b.ms);
  improved.sort((a, b) => b.gainMs - a.gainMs);
  return { fastest: fastest.slice(0, 10), improved: improved.slice(0, 5) };
}

// ---------- State ----------
const players = new Map(); // id -> { id, name, assist, ws, dropTimer }
const screens = new Set();
const queue = []; // player ids
let car = null;
let run = null; // { id, phase: 'claim'|'countdown'|'racing', t0, state, lastStateAt, timers: [] }

const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
const toScreens = (msg) => screens.forEach((ws) => send(ws, msg));
const toAll = (msg) => {
  toScreens(msg);
  players.forEach((p) => send(p.ws, msg));
};

function lobby() {
  const current = run ? { name: players.get(run.id)?.name ?? '?', phase: run.phase, level: players.get(run.id)?.level ?? 'gp', levelName: levelName(players.get(run.id)?.level) } : null;
  const names = queue.map((id) => players.get(id)?.name ?? '?');
  toScreens({ t: 'lobby', queue: names, current, carOnline: !!car, publicUrl });
  players.forEach((p) => {
    const pos = queue.indexOf(p.id);
    send(p.ws, { t: 'lobby', queue: names, current, carOnline: !!car, pos: pos === -1 ? null : pos + 1 });
  });
}

function clearRunTimers() {
  if (run) run.timers.forEach(clearTimeout);
}

function endRun(reason) {
  if (!run) return;
  clearRunTimers();
  const p = players.get(run.id);
  if (reason !== 'finished') send(p?.ws, { t: 'run_end', reason });
  if (reason !== 'finished') toScreens({ t: 'run_end', name: p?.name, reason });
  run = null;
  driveCar(0, 0);
  setTimeout(nextDriver, 1500);
  lobby();
}

function nextDriver() {
  if (run) return;
  while (queue.length) {
    const id = queue.shift();
    const p = players.get(id);
    if (!p) continue;
    run = { id, phase: 'claim', timers: [], state: null, lastStateAt: 0 };
    send(p.ws, { t: 'your_turn', claimMs: CLAIM_MS });
    run.timers.push(setTimeout(() => endRun('missed_turn'), CLAIM_MS));
    break;
  }
  lobby();
}

function startCountdown() {
  clearRunTimers();
  run.phase = 'countdown';
  run.timers = [];
  const p = players.get(run.id);
  for (let i = 0; i < COUNTDOWN; i++) {
    run.timers.push(
      setTimeout(() => {
        send(p?.ws, { t: 'countdown', n: COUNTDOWN - i });
        toScreens({ t: 'countdown', n: COUNTDOWN - i, name: p?.name, level: p?.level, levelName: levelName(p?.level) });
      }, i * 1000),
    );
  }
  run.timers.push(
    setTimeout(() => {
      run.phase = 'racing';
      run.t0 = Date.now();
      send(p?.ws, { t: 'go' });
      toScreens({ t: 'go', name: p?.name });
      run.timers.push(setTimeout(() => endRun('timeout'), RUN_TIMEOUT_MS));
      lobby();
    }, COUNTDOWN * 1000),
  );
  lobby();
}

function finishRun(p, msg) {
  const serverMs = Date.now() - run.t0;
  // Trust the phone's timer (no network jitter) but keep it close to the server's.
  const rawMs = Math.round(Math.min(serverMs + 500, Math.max(serverMs - 2500, Number(msg.rawMs) || serverMs)));
  const stars = Math.max(0, Math.min(raceTrack(p.level).stars.length, Number(msg.stars) || 0));
  const finalMs = Math.max(0, rawMs - stars * STAR_BONUS_MS);
  const stats = {
    headMoves: Math.max(0, Number(msg.stats?.headMoves) || 0),
    goMoves: Math.max(0, Number(msg.stats?.goMoves) || 0),
    goHoldMs: Math.max(0, Number(msg.stats?.goHoldMs) || 0),
    wallHits: Math.max(0, Number(msg.stats?.wallHits) || 0),
    jumps: Math.max(0, Number(msg.stats?.jumps) || 0),
  };
  const key = p.name.toLowerCase();
  const level = p.level || 'gp';
  const previous = results.filter((r) => r.key === key && (r.level || 'gp') === level);
  const prevBest = previous.length ? Math.min(...previous.map((r) => r.finalMs)) : null;
  const entry = { name: p.name, key, level, finalMs, rawMs, stars, assist: p.assist, stats, at: new Date().toISOString() };
  results.push(entry);
  saveResults();
  const b = boards();
  const rank = level === 'gp' ? b.fastest.findIndex((r) => r.name.toLowerCase() === key) + 1 || null : null;
  logPractice({ name: p.name, unit: level, lesson: -1, good: 0, total: 0, xp: level === 'gp' ? XP.gp : XP.boss, ms: rawMs });
  send(p.ws, {
    t: 'result',
    level,
    levelName: levelName(level),
    finalMs,
    rawMs,
    stars,
    stats,
    rank,
    personalBest: prevBest === null || finalMs < prevBest,
    prevBestMs: prevBest,
    firstMs: previous[0]?.finalMs ?? null,
  });
  toScreens({ t: 'finished', name: p.name, finalMs, stars, assist: p.assist, level, levelName: levelName(level) });
  toAll({ t: 'board', ...b });
  endRun('finished');
}

// ---------- Practice feed (big screen "Today's practice" + therapist CSV) ----------
function logPractice(e) {
  practice.push({ ...e, day: localDay(), at: new Date().toISOString() });
  save(PRACTICE_FILE, practice);
  toScreens(practiceBoard());
}

function practiceText(e) {
  const where = e.local ? ' on a phone' : '';
  if (e.unit === 'gp') return `finished the Grand Prix${where}`;
  const u = UNITS[unitIndex(e.unit)];
  if (!u) return 'practised';
  if (e.lesson < 0) return `cleared ${u.boss.name}${where}`;
  return `${u.title} · ${KINDS[e.lesson]?.title ?? ''} ${e.good}/${e.total}`;
}

function practiceBoard() {
  const today = practice.filter((e) => e.day === localDay());
  const people = new Map();
  for (const e of today) {
    const k = e.name.toLowerCase();
    const row = people.get(k) || { name: e.name, xp: 0, good: 0 };
    row.xp += e.xp;
    row.good += e.good;
    people.set(k, row);
  }
  return {
    t: 'practice_board',
    reps: today.reduce((s, e) => s + e.good, 0),
    minutes: Math.round(today.reduce((s, e) => s + e.ms, 0) / 60000),
    people: [...people.values()].sort((a, b) => b.xp - a.xp).slice(0, 6),
    feed: today.slice(-4).reverse().map((e) => ({ name: e.name, text: practiceText(e) })),
  };
}

const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
function onPractice(msg) {
  const name = cleanName(msg.name);
  if (!name) return;
  // A race played on a phone only (no line, no real car): practice time and XP, never the leaderboard.
  if (msg.kind === 'race') {
    if (!LEVELS.includes(msg.unit)) return;
    return logPractice({
      name,
      unit: msg.unit,
      lesson: -1,
      good: 0,
      total: 0,
      xp: int(msg.xp, 0, msg.unit === 'gp' ? XP.gp : XP.boss),
      ms: int(msg.ms, 0, 3 * 60000),
      local: true,
    });
  }
  if (unitIndex(msg.unit) < 0) return;
  const total = int(msg.total, 0, REPS_PER_LESSON);
  const good = int(msg.good, 0, total);
  logPractice({
    name,
    unit: msg.unit,
    lesson: int(msg.lesson, 0, KINDS.length - 1),
    good,
    total,
    xp: int(msg.xp, 0, good * XP.rep + XP.lesson + XP.perfect),
    ms: int(msg.ms, 0, 15 * 60000),
    reactMs: msg.reactMs == null ? null : int(msg.reactMs, 0, 20000),
    fatigue: !!msg.fatigue,
    tired: !!msg.tired,
  });
}

// ---------- Car link ----------
function driveCar(steer, throttle) {
  if (!car || car.readyState !== 1) return;
  const s = Math.round(Math.max(-1, Math.min(1, steer)) * 1000);
  const t = Math.round(Math.max(-1, Math.min(1, throttle)) * 1000);
  car.send(`d ${s} ${t}`);
}

setInterval(() => {
  if (run?.phase === 'racing' && run.state && Date.now() - run.lastStateAt < STALE_MS) {
    driveCar(run.state.cs, run.state.ct);
    const p = players.get(run.id);
    toScreens({
      t: 'live',
      name: p?.name,
      level: p?.level || 'gp',
      levelName: levelName(p?.level),
      x: run.state.x,
      y: run.state.y,
      z: run.state.z,
      h: run.state.h,
      v: run.state.v,
      steer: run.state.cs,
      air: run.state.air,
      boost: run.state.boost ? 1 : 0,
      stars: run.state.stars,
      elapsedMs: Date.now() - run.t0,
    });
  } else {
    driveCar(0, 0);
  }
}, 50);

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(DIR, 'public')));
app.get('/screen', (_req, res) => res.sendFile(path.join(DIR, 'public', 'screen.html')));
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '');
  if (!/^https?:\/\//.test(text) || text.length > 300) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1 }));
});
app.get('/api/info', (_req, res) => res.json({ publicUrl }));

// Practice path progress, saved by name so a player can pick up on another phone.
// Names are not accounts: anyone typing the same name shares the progress. Fine for an event.
app.get('/api/profile', (req, res) => {
  const key = cleanName(req.query.name).toLowerCase();
  if (!key) return res.status(400).json(null);
  res.json(profiles[key] ?? null); // null = new player
});
let profileSave = null;
app.post('/api/profile', express.json({ limit: '64kb' }), (req, res) => {
  const name = cleanName(req.body?.name);
  const p = req.body?.profile;
  if (!name || !p || typeof p !== 'object' || Array.isArray(p)) return res.status(400).json({ ok: false });
  const key = name.toLowerCase();
  if ((profiles[key]?.updatedAt || 0) > (Number(p.updatedAt) || 0)) return res.json({ ok: true, kept: 'newer' });
  profiles[key] = { ...p, name };
  clearTimeout(profileSave);
  profileSave = setTimeout(() => save(PROFILES_FILE, profiles), 300);
  res.json({ ok: true });
});

// Practice log for therapists. Host key only: it's exercise data about named people.
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
app.get('/api/practice.csv', (req, res) => {
  if (req.query.admin !== ADMIN_KEY) return res.status(403).send('Host key needed');
  const head = ['date', 'time', 'name', 'unit', 'activity', 'good_reps', 'reps', 'xp', 'minutes', 'avg_reaction_ms', 'fatigue_signs', 'stopped_tired'];
  const rows = practice.map((e) => {
    const u = UNITS[unitIndex(e.unit)];
    const activity = (e.unit === 'gp' ? 'Grand Prix' : e.lesson < 0 ? `Boss: ${u?.boss.name}` : KINDS[e.lesson]?.title) + (e.local ? ' (phone)' : '');
    return [e.day, e.at.slice(11, 19), e.name, u?.title ?? 'Grand Prix', activity, e.good, e.total, e.xp, (e.ms / 60000).toFixed(2), e.reactMs ?? '', e.fatigue ? 'yes' : '', e.tired ? 'yes' : ''];
  });
  res.type('text/csv').attachment('practice.csv').send([head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  let role = null;
  if (url.pathname === '/car' && url.searchParams.get('token') === CAR_TOKEN) role = 'car';
  else if (url.pathname === '/ws') role = 'web';
  if (!role) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, role, req));
});

function onConnect(ws, role, req) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  if (role === 'car') {
    if (car) car.close();
    car = ws;
    console.log(`🚗 Car connected from ${req.socket.remoteAddress}`);
    ws.on('message', (m) => console.log(`🚗 car says: ${String(m).slice(0, 80)}`));
    ws.on('close', () => {
      if (car === ws) {
        car = null;
        console.log('🚗 Car disconnected');
        lobby();
      }
    });
    lobby();
    return;
  }

  let me = null; // player record if this socket is a player
  let isAdmin = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'hello') {
      if (msg.role === 'screen') {
        screens.add(ws);
        isAdmin = msg.admin === ADMIN_KEY;
        send(ws, { t: 'hello', admin: isAdmin, publicUrl });
        send(ws, { t: 'board', ...boards() });
        send(ws, practiceBoard());
        lobby();
        return;
      }
      const id = typeof msg.id === 'string' && msg.id.length <= 40 ? msg.id : crypto.randomUUID();
      me = players.get(id);
      if (me) {
        clearTimeout(me.dropTimer);
        if (me.ws && me.ws !== ws) me.ws.close();
        me.ws = ws;
      } else {
        me = { id, name: null, assist: 0, level: 'gp', ws };
        players.set(id, me);
      }
      send(ws, { t: 'hello', id });
      send(ws, { t: 'board', ...boards() });
      lobby();
      if (run?.id === id && run.phase === 'claim') send(ws, { t: 'your_turn', claimMs: CLAIM_MS });
      return;
    }

    if (msg.t === 'admin' && isAdmin) {
      if (msg.action === 'stop' || msg.action === 'skip') endRun('stopped_by_host');
      if (msg.action === 'clear_queue') {
        queue.length = 0;
        lobby();
      }
      return;
    }

    if (!me) return;
    const isDriver = run?.id === me.id;
    if (msg.t === 'practice') return onPractice(msg);

    switch (msg.t) {
      case 'join': {
        const name = cleanName(msg.name);
        if (!name) return;
        me.name = name;
        me.assist = ASSIST[msg.assist] ? Number(msg.assist) : 0;
        if (!isDriver) me.level = LEVELS.includes(msg.level) ? msg.level : 'gp';
        if (!queue.includes(me.id) && !isDriver) queue.push(me.id);
        if (!run) nextDriver();
        else lobby();
        break;
      }
      case 'leave': {
        const i = queue.indexOf(me.id);
        if (i !== -1) queue.splice(i, 1);
        if (isDriver) endRun('left');
        lobby();
        break;
      }
      case 'start':
        if (isDriver && run.phase === 'claim') startCountdown();
        break;
      case 'state':
        if (isDriver && run.phase === 'racing') {
          run.state = {
            x: +msg.x || 0,
            y: +msg.y || 0,
            z: +msg.z || 0,
            h: +msg.h || 0,
            v: +msg.v || 0,
            cs: +msg.cs || 0,
            ct: +msg.ct || 0,
            air: !!msg.air,
            boost: !!msg.boost,
            stars: Array.isArray(msg.stars) ? msg.stars.slice(0, raceTrack(me.level).stars.length) : [],
          };
          run.lastStateAt = Date.now();
        }
        break;
      case 'finish':
        if (isDriver && run.phase === 'racing') finishRun(me, msg);
        break;
      case 'stop':
        if (isDriver) endRun('stopped');
        break;
    }
  });

  ws.on('close', () => {
    screens.delete(ws);
    if (!me || me.ws !== ws) return;
    me.ws = null;
    // Safety first: a driver who disconnects mid-race loses the run immediately.
    if (run?.id === me.id && run.phase !== 'claim') endRun('disconnected');
    // Keep their queue spot for a bit in case the phone just locked its screen.
    const id = me.id;
    me.dropTimer = setTimeout(() => {
      const i = queue.indexOf(id);
      if (i !== -1) queue.splice(i, 1);
      if (run?.id === id) endRun('disconnected');
      players.delete(id);
      lobby();
    }, 60000);
  });
}

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
  if (publicUrl || process.env.NO_TUNNEL) return;
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
    if (m && !publicUrl) {
      publicUrl = m[0];
      console.log(`\n📱 Players scan the QR on the big screen, or open: ${publicUrl}\n`);
      lobby(); // lobby carries publicUrl to the big screen
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
