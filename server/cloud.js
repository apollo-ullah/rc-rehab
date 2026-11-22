// Vercel glue: the WebSocket function (api/ws.js, api/car.js) and the HTTP API functions.
// Needs REDIS_URL (or KV_URL) from a Redis database connected to the Vercel project,
// plus the CAR_TOKEN and ADMIN_KEY environment variables.
import http from 'node:http';
import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { createHttpApi, roleFor } from './arena.js';
import { createRelay } from './relay.js';
import { redisStore } from './redis-store.js';
import { qrSvg } from './qr.js';

const env = process.env;
const REDIS_URL = env.REDIS_URL || env.KV_URL;
const PREFIX = env.REDIS_PREFIX || 'hr:';
const MAX_CONN_MS = Number(env.MAX_CONN_MS) || 300000; // Vercel Hobby closes WebSockets after 5 minutes

let relay = null;
const getRelay = () =>
  (relay ??= createRelay({
    redisUrl: REDIS_URL,
    prefix: PREFIX,
    carToken: env.CAR_TOKEN,
    adminKey: env.ADMIN_KEY,
    timeZone: env.TIME_ZONE || 'America/Toronto',
    publicUrl: env.PUBLIC_URL || null,
    maxConnMs: MAX_CONN_MS,
    version: env.VERCEL_DEPLOYMENT_ID || env.APP_VERSION || null, // Vercel sets the first one
  }));

const originOf = (req) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host || '') ? 'http' : 'https');
  return host ? `${proto}://${host}` : null;
};

// One http.Server per function file, as in Vercel's WebSocket docs. All of them share the relay.
export function wsServer() {
  const server = http.createServer((_req, res) => res.writeHead(426, { 'content-type': 'text/plain' }).end('WebSocket only'));
  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: ({ req }, done) => {
      if (!REDIS_URL) return done(false, 503, 'No database connected (REDIS_URL)');
      const url = new URL(req.url, 'http://local');
      return roleFor(url.pathname, url.searchParams, env.CAR_TOKEN) ? done(true) : done(false, 403);
    },
  });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://local');
    const role = roleFor(url.pathname, url.searchParams, env.CAR_TOKEN);
    const conn = {
      send: (text) => ws.send(text),
      close: () => ws.close(),
      get open() {
        return ws.readyState === 1;
      },
    };
    const remote = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const h = getRelay().connect(conn, role, { remote, origin: env.PUBLIC_URL || originOf(req) });
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (m) => h.message(String(m)));
    ws.on('close', h.close);
  });
  // Drop dead sockets (phones that vanished, car that lost power).
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 3000).unref?.();
  return server;
}

// ---------- HTTP API ----------
let api = null;
const getApi = async () => {
  if (!api) {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    redis.on('error', (e) => console.log(`⚠️  Redis: ${e.message}`));
    api = createHttpApi({ store: await redisStore(redis, { prefix: PREFIX }), adminKey: env.ADMIN_KEY });
  }
  return api;
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// path: which API this is (the function file decides, so rewrites can't confuse it).
export async function handleHttp(request, path) {
  const url = new URL(request.url);
  if (path === '/qr.svg') {
    const svg = qrSvg(url.searchParams.get('text'));
    if (!svg) return new Response(null, { status: 400 });
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
  }
  if (!REDIS_URL) return json(503, { error: 'No database connected (REDIS_URL)' });
  let body = null;
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > 64 * 1024) return json(413, { ok: false });
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { ok: false });
    }
  }
  const out = await (await getApi())({ method: request.method, path, params: url.searchParams, body, publicUrl: env.PUBLIC_URL || url.origin });
  if (!out) return new Response('Not found', { status: 404 });
  if ('json' in out) return json(out.status, out.json);
  const headers = { 'content-type': out.type, 'cache-control': 'no-store' };
  if (out.filename) headers['content-disposition'] = `attachment; filename="${out.filename}"`;
  return new Response(out.text, { status: out.status, headers });
}
