// Head Racer game core: the driver queue, races, leaderboards and the practice log.
// It has no host-specific code in it, so the same logic runs on a laptop (server.js, JSON files)
// and in the cloud (server/relay.js on Vercel, Redis).
import { STAR_BONUS_MS, RUN_TIMEOUT_MS, ASSIST } from '../public/game.js';
import { raceTrack } from '../public/tracks.js';
import { UNITS, KINDS, LEVELS, XP, REPS_PER_LESSON, levelName, unitIndex, localDay, lessonInfo } from '../public/path.js';

export const CLAIM_MS = 45000; // time to press start when it's your turn
const COUNTDOWN = 3;
const STALE_MS = 400; // car stops if the phone goes quiet this long
const DRIVER_GRACE_MS = 6000; // a driver whose connection blips mid-race has this long to come back
// Longest a connection must last for one turn: time to press start, the countdown, the race.
const RACE_SPAN_MS = CLAIM_MS + COUNTDOWN * 1000 + RUN_TIMEOUT_MS;
const KEEPALIVE_MS = 25000; // a tiny message now and then so idle phones aren't cut off
const MAX_MESSAGE = 64 * 1024;
const PRACTICE_PER_MINUTE = 30; // per connection; a real lesson takes far longer
const EMG_STALE_MS = 2000; // the arm sensors send at least every 0.5 s; silence this long = offline

export const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const isGp = (r) => !r.level || r.level === 'gp';
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// "YYYY-MM-DD" in a named time zone (the cloud runs on UTC), or the machine's own day.
function dayFn(timeZone) {
  if (!timeZone) return localDay;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (d = new Date()) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Which WebSocket path is which. /api/* is the cloud (Vercel) spelling; the laptop accepts both.
// 'emg' is the arm sensors' ESP32 (docs/arm-path.md); it uses the car's token.
export function roleFor(pathname, params, carToken) {
  if (pathname === '/ws' || pathname === '/api/ws') return 'web';
  const device = carToken && params.get('token') === carToken;
  if ((pathname === '/car' || pathname === '/api/car') && device) return 'car';
  if ((pathname === '/emg' || pathname === '/api/emg') && device) return 'emg';
  return null;
}

/**
 * The live game. One copy runs at a time (the laptop server, or the cloud's current leader).
 * store: {
 *   results: [], practice: [],            // everything saved so far, oldest first
 *   addResult(entry), addPractice(entry), // append + save
 *   reset(),                              // wipe both (host's "Clear leaderboard")
 * }
 * A connection is { send(text), close(), open } and is wrapped by the host.
 * Options for the cloud: quietIdle (don't stream "d 0 0" to the car between races),
 * maxConnMs (the host cuts connections after this long, so clients refresh theirs before a race),
 * onChange (called whenever the line changes, to save snapshot()).
 */
export function createArena({ store, carToken, adminKey, publicUrl = null, timeZone, log = console.log, quietIdle = false, maxConnMs = 0, onChange }) {
  const today = dayFn(timeZone);
  const { results, practice } = store;
  let disposed = false;
  // On a host that cuts connections after maxConnMs, a connection older than this gets replaced
  // before a turn, so it lasts the whole turn.
  const freshMs = maxConnMs ? Math.max(20000, maxConnMs - RACE_SPAN_MS - 10000) : 0;

  // ---------- Leaderboards ----------
  // Only the Grand Prix with no driving help is ranked (the arcade's setting): boss races use
  // different controls and help changes the car, so those times don't compare.
  function boards() {
    const byName = new Map();
    for (const r of results.filter((r) => isGp(r) && !r.assist)) {
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
  const players = new Map(); // id -> { id, name, assist, level, conn, dropTimer }
  const screens = new Set();
  const queue = []; // player ids
  let car = null;
  let carSince = 0;
  let lastDriveAt = 0; // last time the car got a real (non-stale) drive command
  let run = null; // { id, phase: 'claim'|'countdown'|'racing', claimUntil, goAt, t0, state, lastStateAt, timers: [] }
  // Arm sensors: is each biceps flexing? Sent to players in the arm path and to the big screen.
  let emg = { l: false, r: false, online: false };
  let emgConn = null;
  let emgAt = 0;

  const send = (c, msg) => c && c.open && c.send(JSON.stringify(msg));
  const toScreens = (msg) => screens.forEach((c) => send(c, msg));
  const toAll = (msg) => {
    toScreens(msg);
    players.forEach((p) => send(p.conn, msg));
  };

  function lobby() {
    if (disposed) return;
    onChange?.();
    const cur = run && players.get(run.id);
    const current = run ? { name: cur?.name ?? '?', phase: run.phase, level: cur?.level ?? 'gp', levelName: levelName(cur?.level) } : null;
    const names = queue.map((id) => players.get(id)?.name ?? '?');
    toScreens({ t: 'lobby', queue: names, current, carOnline: !!car, publicUrl });
    players.forEach((p) => {
      const pos = queue.indexOf(p.id);
      send(p.conn, { t: 'lobby', queue: names, current, carOnline: !!car, pos: pos === -1 ? null : pos + 1 });
    });
  }

  function clearRunTimers() {
    if (run) run.timers.forEach(clearTimeout);
  }

  function endRun(reason) {
    if (!run) return;
    clearRunTimers();
    const p = players.get(run.id);
    if (reason !== 'finished') send(p?.conn, { t: 'run_end', reason });
    if (reason !== 'finished') toScreens({ t: 'run_end', name: p?.name, reason });
    run = null;
    lastDriveAt = Date.now(); // keep sending stops for a moment
    driveCar(0, 0);
    setTimeout(nextDriver, 1500);
    lobby();
  }

  function nextDriver() {
    if (run || disposed) return;
    while (queue.length) {
      const id = queue.shift();
      const p = players.get(id);
      if (!p) continue;
      // The cloud cuts connections after maxConnMs: give the car a fresh one now if it wouldn't last the turn.
      if (freshMs && car?.open && Date.now() - carSince > freshMs) car.send('r');
      startClaim(id, Date.now() + CLAIM_MS);
      break;
    }
    lobby();
  }

  // Each phase is keyed to wall-clock times, so another server can pick a run up where it was.
  function startClaim(id, claimUntil) {
    run = { id, phase: 'claim', timers: [], state: null, lastStateAt: 0, claimUntil };
    send(players.get(id)?.conn, { t: 'your_turn', claimMs: Math.max(0, claimUntil - Date.now()) });
    run.timers.push(setTimeout(() => endRun('missed_turn'), Math.max(0, claimUntil - Date.now())));
  }

  function startCountdown(goAt = Date.now() + COUNTDOWN * 1000) {
    clearRunTimers();
    run.phase = 'countdown';
    run.goAt = goAt;
    run.timers = [];
    const p = players.get(run.id);
    for (let n = COUNTDOWN; n >= 1; n--) {
      const wait = goAt - n * 1000 - Date.now();
      if (wait < -500) continue; // already shown before a handover
      run.timers.push(
        setTimeout(() => {
          send(p?.conn, { t: 'countdown', n });
          toScreens({ t: 'countdown', n, name: p?.name, level: p?.level, levelName: levelName(p?.level) });
        }, Math.max(0, wait)),
      );
    }
    run.timers.push(setTimeout(() => startRacing(goAt), Math.max(0, goAt - Date.now())));
    lobby();
  }

  function startRacing(t0, resumed = false) {
    run.phase = 'racing';
    run.t0 = t0;
    const p = players.get(run.id);
    if (!resumed) {
      send(p?.conn, { t: 'go' });
      toScreens({ t: 'go', name: p?.name });
    }
    run.timers.push(setTimeout(() => endRun('timeout'), Math.max(0, t0 + RUN_TIMEOUT_MS - Date.now())));
    lobby();
  }

  // A driver whose connection dropped mid-run: the car stops by itself (STALE_MS) and the run
  // ends unless they are back within DRIVER_GRACE_MS.
  function awaitDriver() {
    const id = run.id;
    run.timers.push(setTimeout(() => run?.id === id && run.phase !== 'claim' && !players.get(id)?.conn && endRun('disconnected'), DRIVER_GRACE_MS));
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
    store.addResult({ name: p.name, key, level, finalMs, rawMs, stars, assist: p.assist, stats, at: new Date().toISOString() });
    const b = boards();
    const rank = level === 'gp' ? b.fastest.findIndex((r) => r.name.toLowerCase() === key) + 1 || null : null;
    logPractice({ name: p.name, unit: level, lesson: -1, good: 0, total: 0, xp: level === 'gp' ? XP.gp : XP.boss, ms: rawMs });
    send(p.conn, {
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
    store.addPractice({ ...e, day: today(), at: new Date().toISOString() });
    toScreens(practiceBoard());
  }

  function practiceText(e) {
    const where = e.local ? ' on a phone' : '';
    if (e.unit === 'gp') return `finished the Grand Prix${where}`;
    const u = UNITS[unitIndex(e.unit)];
    if (!u) return 'practised';
    if (e.lesson < 0) return `cleared ${u.boss.name}${where}`;
    return `${u.title} · ${lessonInfo(unitIndex(e.unit), e.lesson)?.title ?? ''} ${e.good}/${e.total}`;
  }

  function practiceBoard() {
    const day = today();
    const todays = [];
    for (let i = practice.length - 1; i >= 0 && practice[i].day >= day; i--) if (practice[i].day === day) todays.unshift(practice[i]);
    const people = new Map();
    for (const e of todays) {
      const k = e.name.toLowerCase();
      const row = people.get(k) || { name: e.name, xp: 0, good: 0 };
      row.xp += e.xp;
      row.good += e.good;
      people.set(k, row);
    }
    return {
      t: 'practice_board',
      reps: todays.reduce((s, e) => s + e.good, 0),
      minutes: Math.round(todays.reduce((s, e) => s + e.ms, 0) / 60000),
      people: [...people.values()].sort((a, b) => b.xp - a.xp).slice(0, 6),
      feed: todays.slice(-4).reverse().map((e) => ({ name: e.name, text: practiceText(e) })),
    };
  }

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

  // ---------- Arm sensors ----------
  const emgMsg = () => ({ t: 'emg', l: emg.l ? 1 : 0, r: emg.r ? 1 : 0, online: emg.online });
  function emgOut() {
    const m = emgMsg();
    toScreens(m);
    players.forEach((p) => p.emg && send(p.conn, m));
  }
  // "f <left> <right>", each 0 or 1. From the arm sensors' ESP32, or from the car's if one board does both.
  function onEmg(text) {
    const m = /^f\s+([01])\s+([01])\s*$/.exec(String(text));
    if (!m) return false;
    emgAt = Date.now();
    const next = { l: m[1] === '1', r: m[2] === '1', online: true };
    if (next.l !== emg.l || next.r !== emg.r || !emg.online) {
      emg = next;
      emgOut();
    }
    return true;
  }
  function emgOffline() {
    if (!emg.online) return;
    emg = { l: false, r: false, online: false };
    log('💪 Arm sensors offline');
    emgOut();
  }

  // ---------- Car link ----------
  function driveCar(steer, throttle) {
    if (!car?.open) return;
    const s = Math.round(Math.max(-1, Math.min(1, steer)) * 1000);
    const t = Math.round(Math.max(-1, Math.min(1, throttle)) * 1000);
    car.send(`d ${s} ${t}`);
  }

  function drive() {
    if (emg.online && Date.now() - emgAt > EMG_STALE_MS) emgOffline();
    if (run?.phase === 'racing' && run.state && Date.now() - run.lastStateAt < STALE_MS) {
      lastDriveAt = Date.now();
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
    } else if (!quietIdle || Date.now() - lastDriveAt < 1000) {
      driveCar(0, 0); // the car also releases everything by itself when commands stop
    }
  }

  // The loops only run while someone is connected, so a cloud host can go to sleep when nobody is.
  let open = 0;
  let loops = [];
  const retain = () => {
    if (open++ === 0) loops = [setInterval(drive, 50), setInterval(() => toAll({ t: 'ping' }), KEEPALIVE_MS)];
  };
  const release = () => {
    if (--open === 0) loops.forEach(clearInterval);
  };

  // A player who disconnects keeps their place in line for a minute (phones lock their screens).
  function scheduleDrop(p) {
    clearTimeout(p.dropTimer);
    const id = p.id;
    p.dropTimer = setTimeout(() => {
      const i = queue.indexOf(id);
      if (i !== -1) queue.splice(i, 1);
      if (run?.id === id) endRun('disconnected');
      players.delete(id);
      lobby();
    }, 60000);
  }

  // ---------- Connections ----------
  function connect(conn, role, info = {}) {
    retain();
    let closed = false;
    const onClose = (fn) => () => {
      if (closed) return;
      closed = true;
      fn();
      release();
    };

    if (role === 'car') {
      if (car) car.close();
      car = conn;
      carSince = Date.now();
      log(`🚗 Car connected${info.remote ? ` from ${info.remote}` : ''}`);
      lobby();
      return {
        message: (m) => onEmg(m) || log(`🚗 car says: ${String(m).slice(0, 80)}`),
        close: onClose(() => {
          if (car !== conn) return;
          car = null;
          log('🚗 Car disconnected');
          lobby();
        }),
      };
    }

    if (role === 'emg') {
      if (emgConn) emgConn.close();
      emgConn = conn;
      log(`💪 Arm sensors connected${info.remote ? ` from ${info.remote}` : ''}`);
      return {
        message: (m) => onEmg(m),
        close: onClose(() => {
          if (emgConn !== conn) return;
          emgConn = null;
          emgOffline();
        }),
      };
    }

    let me = null; // player record if this connection is a player
    let isAdmin = false;
    let practiceTimes = [];

    function message(raw) {
      if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'hello') {
        if (msg.role === 'screen') {
          screens.add(conn);
          isAdmin = !!adminKey && msg.admin === adminKey;
          send(conn, { t: 'hello', admin: isAdmin, publicUrl, maxConnMs, freshMs });
          send(conn, { t: 'board', ...boards() });
          send(conn, practiceBoard());
          send(conn, emgMsg());
          lobby();
          return;
        }
        const id = typeof msg.id === 'string' && msg.id && msg.id.length <= 40 ? msg.id : crypto.randomUUID();
        me = players.get(id);
        if (me) {
          clearTimeout(me.dropTimer);
          if (me.conn && me.conn !== conn) me.conn.close();
          me.conn = conn;
        } else {
          me = { id, name: null, assist: 0, level: 'gp', conn };
          players.set(id, me);
        }
        // driving: where this player's own run stands, so a phone that reconnected can catch up.
        send(conn, { t: 'hello', id, maxConnMs, freshMs, driving: run?.id === id ? run.phase : null });
        send(conn, { t: 'board', ...boards() });
        lobby();
        if (run?.id === id && run.phase === 'claim') send(conn, { t: 'your_turn', claimMs: Math.max(0, run.claimUntil - Date.now()) });
        return;
      }

      if (msg.t === 'admin' && isAdmin) {
        if (msg.action === 'stop' || msg.action === 'skip') endRun('stopped_by_host');
        if (msg.action === 'clear_queue') {
          queue.length = 0;
          lobby();
        }
        if (msg.action === 'reset_board') {
          // Host only: wipe saved race results and the practice log (e.g. before a demo).
          store.reset();
          toAll({ t: 'board', ...boards() });
          toScreens(practiceBoard());
          log('🧹 Leaderboard and practice log cleared by the host');
        }
        return;
      }

      if (!me) return;
      if (msg.t === 'emg_sub') {
        me.emg = true; // this player is in the arm path: send them the arm sensors
        send(conn, emgMsg());
        return;
      }
      const isDriver = run?.id === me.id;
      if (msg.t === 'practice') {
        const now = Date.now();
        practiceTimes = practiceTimes.filter((t) => now - t < 60000);
        if (practiceTimes.length >= PRACTICE_PER_MINUTE) return;
        practiceTimes.push(now);
        return onPractice(msg);
      }

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
    }

    const close = onClose(() => {
      screens.delete(conn);
      if (!me || me.conn !== conn) return;
      me.conn = null;
      if (run?.id === me.id && run.phase !== 'claim') {
        run.state = null; // stop the real car now; the run waits a moment for the phone to come back
        lastDriveAt = Date.now();
        driveCar(0, 0);
        awaitDriver();
      }
      scheduleDrop(me);
    });

    return { message, close };
  }

  // ---------- Handing the game to another server (cloud) ----------
  // The line and the run in progress survive a handover: the run carries on from its clock times.
  function snapshot() {
    const ids = run ? [run.id, ...queue] : [...queue];
    return {
      queue: [...queue],
      run: run && { id: run.id, phase: run.phase, claimUntil: run.claimUntil, goAt: run.goAt, t0: run.t0 },
      players: ids.map((id) => players.get(id)).filter(Boolean).map((p) => [p.id, { name: p.name, assist: p.assist, level: p.level }]),
    };
  }
  function restore(snap) {
    for (const [id, p] of snap?.players || []) {
      if (players.has(id)) continue;
      const rec = { id, name: cleanName(p.name) || null, assist: ASSIST[p.assist] ? Number(p.assist) : 0, level: LEVELS.includes(p.level) ? p.level : 'gp', conn: null };
      players.set(id, rec);
      scheduleDrop(rec);
    }
    for (const id of snap?.queue || []) if (players.has(id) && !queue.includes(id)) queue.push(id);
    const r = snap?.run;
    const now = Date.now();
    if (!run && r && players.has(r.id) && !queue.includes(r.id)) {
      if (r.phase === 'claim' && r.claimUntil > now) {
        startClaim(r.id, Math.max(r.claimUntil, now + 10000)); // the handover may have eaten some of it
      } else if (r.phase === 'countdown' && r.goAt > now) {
        run = { id: r.id, phase: 'countdown', timers: [], state: null, lastStateAt: 0 };
        startCountdown(r.goAt);
        awaitDriver();
      } else if (r.phase !== 'claim' && (r.t0 ?? r.goAt) + RUN_TIMEOUT_MS > now) {
        run = { id: r.id, phase: 'racing', timers: [], state: null, lastStateAt: 0 };
        startRacing(r.t0 ?? r.goAt, true); // racing, or the countdown ended during the handover
        awaitDriver();
      } else if (r.phase === 'claim') {
        queue.unshift(r.id); // their turn ran out mid-handover: first in line again
      }
    }
    if (!run) setTimeout(nextDriver, 1500); // give phones a moment to reconnect first
    lobby();
  }
  function dispose() {
    disposed = true;
    clearRunTimers();
    loops.forEach(clearInterval);
    players.forEach((p) => clearTimeout(p.dropTimer));
  }

  function setPublicUrl(url) {
    if (!url || url === publicUrl) return;
    publicUrl = url;
    lobby(); // lobby carries publicUrl to the big screen
  }

  return { connect, setPublicUrl, snapshot, restore, dispose, get publicUrl() { return publicUrl; } };
}

// ---------- HTTP API (/api/*) ----------
// store: allPractice(), which may return a promise. (Personal progress lives in each browser: no accounts.)
// Returns { status, json } or { status, text, type, filename }, or null when the path is unknown.
export function createHttpApi({ store, adminKey }) {
  return async function api({ method, path, params, body, publicUrl = null }) {
    if (path === '/api/info' && method === 'GET') return { status: 200, json: { publicUrl } };

    // Practice log for therapists. Host key only: it's exercise data about named people.
    if (path === '/api/practice.csv' && method === 'GET') {
      if (!adminKey || params.get('admin') !== adminKey) return { status: 403, text: 'Host key needed', type: 'text/plain' };
      const head = ['date', 'time', 'name', 'unit', 'activity', 'good_reps', 'reps', 'xp', 'minutes', 'avg_reaction_ms', 'fatigue_signs', 'stopped_tired'];
      const rows = (await store.allPractice()).map((e) => {
        const u = UNITS[unitIndex(e.unit)];
        const activity = (e.unit === 'gp' ? 'Grand Prix' : e.lesson < 0 ? `Boss: ${u?.boss.name}` : lessonInfo(unitIndex(e.unit), e.lesson)?.title) + (e.local ? ' (phone)' : '');
        return [e.day, e.at.slice(11, 19), e.name, u?.title ?? 'Grand Prix', activity, e.good, e.total, e.xp, (e.ms / 60000).toFixed(2), e.reactMs ?? '', e.fatigue ? 'yes' : '', e.tired ? 'yes' : ''];
      });
      return { status: 200, text: [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'), type: 'text/csv', filename: 'practice.csv' };
    }
    return null;
  };
}
