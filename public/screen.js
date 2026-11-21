import { ASSIST, newCar } from './game.js';
import { raceTrack } from './tracks.js';
import { LEVELS } from './path.js';
import { mountIcons, iconSvg } from './icons.js';

const $ = (id) => document.getElementById(id);
const adminKey = new URLSearchParams(location.search).get('admin');
mountIcons();

let world = null;
let level = 'gp';
const insetNow = () => (innerWidth > 900 ? { right: (360 + 32) / innerWidth, bottom: 0 } : { right: 0, bottom: 0.4 });
import('./world3d.js')
  .then(({ createWorld }) => {
    world = createWorld($('world'), { mode: 'overview', track: raceTrack(level), inset: insetNow(), maxDpr: 2 });
    addEventListener('resize', () => {
      world.resize();
      world.setInset(insetNow());
    });
    parkCar();
  })
  .catch((e) => console.warn('3D world unavailable', e));

// Each race has its own course: show the one being driven.
function showCourse(l) {
  level = LEVELS.includes(l) ? l : 'gp';
  const t = raceTrack(level);
  $('course-name').textContent = t.name;
  if (world && world.track !== t) {
    world.setTrack(t);
    parkCar();
  }
}
$('course-name').textContent = raceTrack(level).name;

const live = { active: false, name: null, elapsedMs: 0, at: 0, stars: [], air: false, boost: 0 };
let qrFor = null;
let bigTimer = null;

function big(text, ms = 0, msg = false) {
  const el = $('big');
  el.textContent = text;
  el.className = `overlay${msg ? ' msg' : ''}${text ? ' pop' : ''}`;
  clearTimeout(bigTimer);
  if (ms) bigTimer = setTimeout(() => (el.textContent = ''), ms);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Boss races show which exercise is driving the car.
const lvl = (level, name) => (level && level !== 'gp' ? ` <span class="lvl">Boss: ${esc(name)}</span>` : '');
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

function setPublicUrl(url) {
  // With no tunnel URL known, fall back to this page's own address if it was opened through one.
  const u = url || (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? location.origin : null);
  if (!u) {
    $('url').textContent = 'Waiting for the HTTPS link. Is cloudflared installed?';
    return;
  }
  if (u === qrFor) return;
  qrFor = u;
  $('qr').src = `/qr.svg?text=${encodeURIComponent(u + '/')}`;
  $('qr').classList.remove('hidden');
  $('url').textContent = u;
}

function setNow(html) {
  $('now').innerHTML = html;
}

function parkCar() {
  Object.assign(live, { stars: [], air: false, boost: 0 });
  world?.reset();
  world?.setCar(newCar(raceTrack(level)));
}

let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', role: 'screen', admin: adminKey }));
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'hello':
        $('admin').classList.toggle('hidden', !m.admin);
        setPublicUrl(m.publicUrl);
        break;
      case 'lobby': {
        setPublicUrl(m.publicUrl);
        $('car-lamp').className = `lamp${m.carOnline ? ' on' : ''}`;
        $('car-text').textContent = m.carOnline ? 'Real car connected' : 'Real car offline. Races still run on screen.';
        $('queue').innerHTML = m.queue.length
          ? m.queue.map((n, i) => `<li><span class="n">${i + 1}</span><span class="name">${esc(n)}</span><span></span></li>`).join('')
          : '<li class="empty">Nobody in line.</li>';
        if (!m.current) {
          live.active = false;
          setNow('Waiting for a driver');
        } else if (m.current.phase === 'claim') {
          showCourse(m.current.level);
          setNow(`${esc(m.current.name)}, it's your turn${lvl(m.current.level, m.current.levelName)}`);
        }
        break;
      }
      case 'practice_board':
        $('pr-reps').textContent = m.reps;
        $('pr-min').textContent = m.minutes;
        $('pr-people').innerHTML = m.people.length
          ? m.people.map((r, i) => `<li class="${i === 0 ? 'first' : ''}"><span class="n">${i + 1}</span><span class="name">${esc(r.name)}</span><span class="t">${r.xp} XP</span></li>`).join('')
          : '<li class="empty">No practice yet today.</li>';
        $('pr-feed').innerHTML = m.feed.map((f) => `<li><b>${esc(f.name)}</b> ${esc(f.text)}</li>`).join('');
        break;
      case 'board':
        $('fastest').innerHTML = m.fastest.length
          ? m.fastest
              .map((r, i) => `<li class="${i === 0 ? 'first' : ''}"><span class="n">${i + 1}</span><span class="name">${esc(r.name)}${r.assist ? `<span class="tag">${ASSIST[r.assist].name}</span>` : ''}</span><span class="t">${fmt(r.ms)}</span></li>`)
              .join('')
          : '<li class="empty">No finished runs yet. Be the first.</li>';
        $('improved').innerHTML = m.improved.length
          ? m.improved.map((r, i) => `<li><span class="n">${i + 1}</span><span class="name">${esc(r.name)}</span><span class="t">−${fmt(r.gainMs)}</span></li>`).join('')
          : '<li class="empty">Race twice to show up here.</li>';
        break;
      case 'countdown':
        showCourse(m.level);
        if (m.n === 3) parkCar();
        live.active = false;
        setNow(`${esc(m.name)} is lining up${lvl(m.level, m.levelName)}`);
        big(String(m.n));
        break;
      case 'go':
        big('GO', 800);
        break;
      case 'live': {
        const wasAir = live.air;
        const newStars = m.stars.filter((s) => !live.stars.includes(s));
        if (!live.active) live.stars = [];
        if ((m.level || 'gp') !== level) showCourse(m.level);
        Object.assign(live, { active: true, name: m.name, level: m.level, levelName: m.levelName, elapsedMs: m.elapsedMs, at: performance.now() });
        world?.setCar({ x: m.x, y: m.y, z: m.z, h: m.h, v: m.v, steer: m.steer, air: m.air, boost: m.boost });
        if (world) {
          if (!wasAir && m.air) world.fx({ launch: true });
          if (wasAir && !m.air) world.fx({ land: 0.5 });
          if (m.boost && !live.boost) world.fx({ boost: true });
          newStars.forEach((s) => world.fx({ star: s }));
          world.setStars(m.stars);
        }
        Object.assign(live, { air: m.air, boost: m.boost, stars: m.stars });
        break;
      }
      case 'finished':
        live.active = false;
        if (m.level && m.level !== 'gp') {
          big(`${m.name}\ncleared ${m.levelName}!`, 5000, true);
          setNow(`${esc(m.name)} cleared <span class="time">${esc(m.levelName)}</span>`);
        } else {
          big(`${m.name}\n${fmt(m.finalMs)}`, 5000, true);
          setNow(`${esc(m.name)} finished in <span class="time">${fmt(m.finalMs)}</span>`);
        }
        break;
      case 'run_end':
        live.active = false;
        big(`${m.name ?? 'Run'}: ${m.reason.replace(/_/g, ' ')}`, 3000, true);
        break;
    }
  };
}

$('btn-stop').onclick = () => ws.send(JSON.stringify({ t: 'admin', action: 'stop' }));
$('btn-clear').onclick = () => ws.send(JSON.stringify({ t: 'admin', action: 'clear_queue' }));
if (adminKey) $('csv').href = `/api/practice.csv?admin=${encodeURIComponent(adminKey)}`;

fetch('/api/info')
  .then((r) => r.json())
  .then((i) => setPublicUrl(i.publicUrl))
  .catch(() => setPublicUrl(null));

const star = iconSvg('star');
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (live.active) {
    const t = live.elapsedMs + (performance.now() - live.at);
    setNow(`${esc(live.name)}${lvl(live.level, live.levelName)} <span class="time">${(t / 1000).toFixed(1)}</span><span class="stars">${star}${live.stars.length}</span>`);
  }
  world?.frame(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
connect();
