// Runs the game on Vercel, where each WebSocket can land on a different server instance.
//
// Every instance is a gateway: it holds its own phones / screens / car and passes their
// messages through Redis pub/sub. Exactly one instance at a time is the leader: it holds a
// Redis lock and runs the one copy of the game (server/arena.js), exactly as on the laptop.
//
//   socket --> gateway --(hr:in)--> leader (arena) --(hr:out)--> every gateway --> socket
//
// When the leader goes away (its last connection closed, or it stopped renewing the lock),
// another instance with connections takes over within moments: it reloads the saved history,
// restores the waiting line and the run in progress from a snapshot, and asks every gateway to
// re-introduce its sockets. Gateways hold messages while the game is changing hands.
import Redis from 'ioredis';
import { createArena } from './arena.js';
import { redisStore } from './redis-store.js';

const LEASE_MS = 15000; // leader lock lifetime; renewed every BEAT_MS
const BEAT_MS = 5000;
const MAX_MESSAGE = 64 * 1024;
const HOLD_MAX = 500; // messages a gateway keeps while the game changes hands
const HOLD_MS = LEASE_MS + BEAT_MS; // after this, stop holding even if no new leader said hello

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
// Save the snapshot and give up the lock in one step, only if this instance still holds it.
const SAVE_AND_RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2]); return redis.call('del', KEYS[1]) else return 0 end`;

export function createRelay({ redisUrl, prefix = 'hr:', carToken, adminKey, timeZone, publicUrl = null, maxConnMs = 0, version = null, log = console.log }) {
  const IN = `${prefix}in`;
  const OUT = `${prefix}out`;
  const LOCK = `${prefix}leader`;
  const SNAP = `${prefix}snapshot`;
  // After a redeploy, tabs that were already open keep their connections to the old version for
  // up to 5 minutes. New connections only reach the live version, and each one records it here;
  // an older version then hands the game over and stops trying to run it.
  const VERSION = `${prefix}version`;
  const self = crypto.randomUUID();
  const opts = { maxRetriesPerRequest: 3, enableAutoPipelining: true };
  const pub = new Redis(redisUrl, opts);
  const sub = new Redis(redisUrl, opts);
  const err = (where) => (e) => log(`⚠️  ${where}: ${e.message}`);
  pub.on('error', err('Redis'));
  sub.on('error', err('Redis (sub)'));

  // ---------- Gateway: this instance's own sockets ----------
  const local = new Map(); // cid -> { conn, role, remote, origin, hello }
  // Between the old leader leaving and the new one saying hello, messages would be lost: hold them.
  let held = null;
  let holdTimer = null;
  const publish = (m) => pub.publish(IN, JSON.stringify(m)).catch(err('publish'));
  const toLeader = (m) => {
    if (!held) return publish(m);
    // Live car positions go stale at once, so they are not worth keeping.
    if (held.length < HOLD_MAX && !(m.k === 'msg' && m.d.startsWith('{"t":"state"'))) held.push(m);
  };
  function hold() {
    held ||= [];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => release().forEach(publish), HOLD_MS);
  }
  function release() {
    clearTimeout(holdTimer);
    const m = held || [];
    held = null;
    return m;
  }

  function introduce(cid, e) {
    toLeader({ k: 'open', cid, role: e.role, remote: e.remote, origin: e.origin });
    if (e.hello) toLeader({ k: 'msg', cid, d: e.hello });
  }

  function onOut(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.k === 'sync') {
      const waiting = release();
      local.forEach((e, cid) => introduce(cid, e)); // first, so the new leader knows every socket
      return waiting.forEach(publish);
    }
    if (m.k === 'elect') {
      hold();
      return beat();
    }
    for (const [cid, text] of m.to || []) {
      const e = local.get(cid);
      if (!e) continue;
      if (text === null) {
        e.conn.close();
        continue;
      }
      // Remember the id the game gave this phone, so a new leader recognises it.
      if (e.hello && text.startsWith('{"t":"hello"')) {
        const id = JSON.parse(text).id;
        if (id) e.hello = JSON.stringify({ ...JSON.parse(e.hello), id });
      }
      if (e.conn.open) e.conn.send(text);
    }
  }

  sub.subscribe(OUT).catch(err('subscribe'));
  sub.on('message', (channel, raw) => {
    if (channel === OUT) onOut(raw);
    else if (channel === IN) leader?.onIn(raw);
  });

  function connect(conn, role, info = {}) {
    const cid = crypto.randomUUID();
    const e = { conn, role, remote: info.remote, origin: info.origin, hello: null };
    local.set(cid, e);
    if (version) pub.set(VERSION, version).catch(err('version'));
    toLeader({ k: 'open', cid, role, remote: info.remote, origin: info.origin });
    startBeat();
    return {
      message(raw) {
        if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
        if (role === 'web' && raw.length < 2000 && raw.includes('"hello"')) {
          try {
            if (JSON.parse(raw).t === 'hello') e.hello = raw;
          } catch {}
        }
        toLeader({ k: 'msg', cid, d: raw });
      },
      close() {
        if (!local.delete(cid)) return;
        toLeader({ k: 'close', cid });
        if (!local.size) stepDown('no connections left here');
      },
    };
  }

  // ---------- Leader election ----------
  let timer = null;
  let leader = null; // { arena, onIn }
  let becoming = false;
  let lastRenew = 0;
  // A leader that can't prove it still holds the lock (Redis trouble, or the instance was paused)
  // must stop at once, or two copies of the game could answer the same phone.
  const leaseValid = () => Date.now() - lastRenew < LEASE_MS - 1000;
  const isLive = async () => !version || ((await pub.get(VERSION)) ?? version) === version;

  function startBeat() {
    if (timer) return;
    timer = setInterval(beat, BEAT_MS);
    beat();
  }

  async function beat() {
    if (!local.size) {
      clearInterval(timer);
      timer = null;
      return;
    }
    try {
      if (leader) {
        if (!(await isLive())) return stepDown('a newer version of the app is live');
        if (await pub.eval(RENEW, 1, LOCK, self, LEASE_MS)) lastRenew = Date.now();
        else stepDown('lost the lock', false);
      } else if (!becoming && (await isLive()) && (await pub.set(LOCK, self, 'PX', LEASE_MS, 'NX'))) {
        lastRenew = Date.now();
        await lead();
      }
    } catch (e) {
      err('leader election')(e);
      if (leader && !leaseValid()) stepDown('could not renew the lock', false);
    }
  }

  async function lead() {
    becoming = true;
    try {
      const store = await redisStore(pub, { prefix, history: true, log });
      const snap = await pub.get(SNAP);
      let snapTimer = null;
      const saveSnapshot = () => {
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => leader && pub.set(SNAP, JSON.stringify(arena.snapshot())).catch(err('snapshot')), 150);
      };

      // The game's sends are batched into one Redis message per tick.
      let outbox = [];
      const flush = () => {
        const to = outbox;
        outbox = [];
        if (to.length && leader) pub.publish(OUT, JSON.stringify({ to })).catch(err('publish'));
      };
      const queue = (cid, text) => {
        if (!outbox.length) queueMicrotask(flush);
        outbox.push([cid, text]);
      };

      const arena = createArena({ store, carToken, adminKey, timeZone, publicUrl, quietIdle: true, maxConnMs, onChange: saveSnapshot, log });
      if (snap) arena.restore(JSON.parse(snap));
      const sockets = new Map(); // cid -> { conn, h }

      function onIn(raw) {
        if (!leaseValid()) return stepDown('lock expired', false);
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.k === 'open') {
          if (sockets.has(m.cid) || (m.role !== 'web' && m.role !== 'car')) return;
          if (m.origin && !arena.publicUrl) arena.setPublicUrl(m.origin);
          const conn = { open: true, send: (text) => conn.open && queue(m.cid, text), close: () => queue(m.cid, null) };
          sockets.set(m.cid, { conn, h: arena.connect(conn, m.role, { remote: m.remote }) });
        } else if (m.k === 'msg') {
          sockets.get(m.cid)?.h.message(m.d);
        } else if (m.k === 'close') {
          const s = sockets.get(m.cid);
          if (!s) return;
          sockets.delete(m.cid);
          s.conn.open = false;
          s.h.close();
        }
      }

      leader = { arena, onIn, stop: () => clearTimeout(snapTimer) };
      await sub.subscribe(IN);
      await pub.publish(OUT, JSON.stringify({ k: 'sync' }));
      log(`👑 This instance now runs the game (${local.size} connection(s) here)`);
      if (!local.size) stepDown('no connections left here');
    } catch (e) {
      err('taking over the game')(e);
      stepDown('failed to start');
    } finally {
      becoming = false;
    }
  }

  function stepDown(why, handOver = true) {
    if (!leader) return;
    const l = leader;
    leader = null;
    l.stop();
    // Save the game as it is right now (the line and any run in progress) for the next leader.
    // Only while this instance still holds the lock: otherwise another leader owns the snapshot.
    const snap = handOver ? JSON.stringify(l.arena.snapshot()) : null;
    l.arena.dispose();
    sub.unsubscribe(IN).catch(() => {});
    if (handOver) {
      hold();
      pub
        .eval(SAVE_AND_RELEASE, 2, LOCK, SNAP, self, snap)
        .then(() => pub.publish(OUT, JSON.stringify({ k: 'elect' }))) // someone else take over now
        .catch(err('handing over'));
    }
    log(`👋 This instance stopped running the game (${why})`);
  }

  return { connect, get isLeader() { return !!leader; }, close: () => { stepDown('shutting down'); pub.quit(); sub.quit(); } };
}
