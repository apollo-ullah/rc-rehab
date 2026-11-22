// Runs the Vercel build locally as one "instance": static files, the api/ functions and their
// WebSockets on one port. Start several on different ports with the same REDIS_URL to act like
// Vercel spreading connections over instances:
//   docker run -d --name hr-redis -p 6390:6379 redis:7-alpine
//   REDIS_URL=redis://localhost:6390 CAR_TOKEN=letsgo ADMIN_KEY=testkey PORT=4001 node test/cloud-dev.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4001;
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = Object.fromEntries(vercel.rewrites.map((r) => [r.source, r.destination]));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const fn = {};
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) fn[`/api/${f.replace(/\.js$/, '')}`] = await import(path.join(ROOT, 'api', f));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = rewrites[url.pathname] || url.pathname;
  const mod = fn[route];
  if (mod && !mod.default) {
    const handler = mod[req.method];
    if (!handler) return res.writeHead(405).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const out = await handler(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(Buffer.from(await out.arrayBuffer()));
  }
  let file = path.join(ROOT, 'public', route === '/' ? 'index.html' : route);
  if (!path.extname(file)) file += '.html'; // cleanUrls
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (req, socket, head) => {
  const mod = fn[new URL(req.url, 'http://local').pathname];
  if (!mod?.default) return socket.destroy();
  mod.default.emit('upgrade', req, socket, head);
});
server.listen(PORT, () => console.log(`☁️  Cloud build running on port ${PORT}`));
