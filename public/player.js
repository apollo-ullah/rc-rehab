import { newCar, step, autoSteer, realSteer, STAR_BONUS_MS, ASSIST } from './game.js';
import { HeadTracker, buildCalibration, toIntent, toSignals, rangeFrom, rangeFromCalibration } from './head.js';
import {
  UNITS, KINDS, GRAND_PRIX, XP, FACE_SIGS, buildLesson, LessonRun, newProfile, lessonsOf, nodeState, nextNode,
  isGold, difficultyText, recordLesson, recordBoss, addPractice, todayView, weekView, progressLine, levelName,
  unitIndex, localDay, addDays, unitProgress, pathProgress, xpLevel, achievements, knobFor, rangeRows,
  unitsOf, unitNo, lessonInfo, pathOf,
} from './path.js';
import { buildArmLesson, ArmRun, armRaceControl, CAR_TUNE, armsFor, armDir, LEFT_ARM_STEER } from './arms.js';
import { mc, selectCutoff, connect as mcConnect, disconnect as mcDisconnect, setWheels, testWheels, record as mcRecord, calibrate as mcCalibrate, onChange as onMc } from './musclecar.js';
import { raceTrack, lessonTrack, trackSvgPath, LESSON_GATES } from './tracks.js';
import { LessonCourse } from './course.js';
import { mountIcons, iconSvg } from './icons.js';

const $ = (id) => document.getElementById(id);
const AUTOPILOT = new URLSearchParams(location.search).has('autopilot');
// Two modes, picked on the first screen (/). Arcade (/arcade): one person after another racing the
// Grand Prix with no help for the shared leaderboard; nothing personal is kept.
// Practice path (/path): your own roadmap of lessons, saved in this browser.
const ARCADE = /^\/arcade\/?$/.test(location.pathname) || new URLSearchParams(location.search).has('arcade');
const PATH = /^\/path\/?$/.test(location.pathname);
// Arm path (/arms): biceps lessons from two EMG sensors that only say "flexing or not" (docs/arm-path.md).
const ARMS = /^\/arms\/?$/.test(location.pathname);
const PATHID = ARMS ? 'arms' : 'head';
const video = $('cam');
const tracker = new HeadTracker(video);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COLOR_CLASS = ['c-sky', 'c-mint', 'c-coral', 'c-sun'];
const cc = (ui) => COLOR_CLASS[ui] ?? `c-${UNITS[ui].color}`;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- App state ----------
function loadTune() {
  try {
    return { ...CAR_TUNE, ...JSON.parse(localStorage.getItem('rc-car-tune') || '{}') };
  } catch {
    return { ...CAR_TUNE };
  }
}
const S = {
  name: store.get('rc-name') || '',
  assist: 0,
  sens: store.get('rc-sens') || 'normal',
  mode: ARMS ? 'arms' : 'head', // 'head' | 'touch' | 'arms'
  emg: { l: 0, r: 0, online: false }, // the arm sensors, from the server
  armManual: false, // no sensor: A/D keys or the on-screen Left/Right buttons
  armSwap: store.get('rc-arm-swap') === '1',
  armBtn: { l: false, r: false },
  armCheck: null,
  armRace: {},
  tune: loadTune(), // Bluetooth car preferences and game input timing
  cal: null,
  profile: null,
  level: 'gp', // which race: 'gp' or a unit id for that unit's boss race
  track: raceTrack('gp'),
  local: false, // a race played on this phone only: no line, no real car
  queued: false,
  phase: 'setup', // setup | home | lesson | lessondone | waiting | turn | countdown | racing | done
  car: null,
  raceStart: 0,
  lastSend: 0,
  stats: null,
  intent: { steer: 0, go: 0, lost: false },
  sig: null,
  lesson: null,
  stop: null,
  retry: null,
  touch: { active: false, x0: 0, x: 0, y0: 0, y: 0 },
  keys: new Set(),
  holdStart: 0,
  claimEnds: 0,
  puckerUp: false,
  lastBoost: 0,
  restTimer: null,
  timers: [],
  carOnline: false,
  finish: null, // a finish the server hasn't confirmed yet
  finishRetry: null,
  lineLength: 0,
  lineBusy: false,
  board: { fastest: [], improved: [] },
};
$('name').value = S.name;
const sensRadio = document.querySelector(`input[name=sens][value="${S.sens}"]`);
if (sensRadio) sensRadio.checked = true;
document.querySelectorAll('input[name=sens]').forEach((r) =>
  r.addEventListener('change', () => {
    S.sens = r.value;
    store.set('rc-sens', r.value);
  }),
);
const fillBar = (id, f) => ($(id).style.width = `${Math.round(clamp(f, 0, 1) * 1000) / 10}%`);
mountIcons();

// ---------- Toasts ----------
function toast(text, { icon = 'star', kind = '' } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${iconSvg(icon)}<span>${esc(text)}</span>`;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

// ---------- 3D world ----------
let world = null;
let wanted = { track: raceTrack('gp'), mode: 'showcase', bottom: 0.55 };
function scene(track, mode, bottom = 0) {
  wanted = { track, mode, bottom };
  if (!world) return;
  world.setTrack(track);
  world.setMode(mode);
  world.setInset({ bottom });
}
import('./world3d.js')
  .then(({ createWorld }) => {
    world = createWorld($('world'), { mode: wanted.mode, track: wanted.track, inset: { bottom: wanted.bottom } });
    addEventListener('resize', () => world.resize());
    if (S.phase === 'lesson' && S.lesson) S.lesson.course.gates.forEach((g, i) => world.setGate(i, g.state));
  })
  .catch((e) => console.warn('3D world unavailable', e));

// ---------- Screens ----------
const CAM_SLOTS = { 's-camera': 'cam-slot-camera', 's-cal': 'cam-slot-cal', 's-wait': 'cam-slot-wait', 's-race': 'cam-slot-race', 's-lesson': 'cam-slot-lesson' };
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.classList.toggle('demo-on', id === 's-demo');
  const slot = CAM_SLOTS[id];
  if (slot && S.mode === 'head') {
    $(slot).prepend(video);
    video.play().catch(() => {});
  }
  const touch = S.mode === 'touch';
  const arms = S.mode === 'arms';
  $('cam-slot-race').classList.toggle('hidden', S.mode !== 'head');
  $('cam-slot-lesson').classList.toggle('hidden', S.mode !== 'head');
  for (const id of ['r-arms', 'l-arms', 'w-arms']) $(id).classList.toggle('hidden', !arms);
  $('touch-pad').classList.toggle('hidden', !touch);
  $('touch-pad-lesson').classList.toggle('hidden', !touch);
}

function overlay(text, msg = false) {
  const el = $('race-overlay');
  if (el.textContent === text && el.classList.contains('msg') === msg) return;
  el.textContent = text;
  el.className = `overlay${msg ? ' msg' : ''}`;
  if (text && !msg) {
    void el.offsetWidth; // restart the pop
    el.classList.add('pop');
  }
}

// ---------- Server connection ----------
// `ws` is the socket in use. A new one (`spare`) only replaces it once the server has said hello
// on it, so swapping connections never leaves a gap. A connection that drops mid-race has a few
// seconds to come back before the run is called off (the real car stops by itself meanwhile).
let ws = null;
let spare = null;
let connAt = 0;
let freshMs = 0; // the cloud host cuts connections after a while: replace one older than this before a turn
let lostTimer = null;
const pending = []; // messages that must not be lost while reconnecting
const DROPPED = 'The connection dropped, so your run was stopped.';
const racingOnline = () => !S.local && (S.phase === 'racing' || S.phase === 'countdown');

function openSocket() {
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', role: 'player', id: store.get('rc-id') }));
  sock.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (sock !== ws) {
      if (sock !== spare || m.t !== 'hello') return;
      const old = ws;
      ws = sock;
      spare = null;
      connAt = Date.now();
      if (old && old.readyState < 2) old.close(); // the server has moved us over already
    }
    onMessage(m);
  };
  sock.onclose = () => {
    if (sock === spare) spare = null;
    if (sock !== ws) {
      if (!ws && !spare) setTimeout(connect, 1000); // couldn't connect: try again
      return;
    }
    ws = null;
    if (racingOnline() || S.phase === 'turn') {
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => !ws && racingOnline() && endLocalRun(DROPPED), 8000);
      connect();
    } else {
      setTimeout(connect, 1000);
    }
  };
  return sock;
}
function connect() {
  if (!spare) spare = openSocket();
}
// Replace an old connection before a turn so the host's time limit can't cut the race.
function refreshConnection() {
  if (ws && !spare && freshMs && Date.now() - connAt > freshMs) spare = openSocket();
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const sendSure = (m) => (ws?.readyState === 1 ? send(m) : pending.push(m));

// The server says hello on every (re)connection, with where our own run stands: catch up with it.
function onHello(m) {
  clearTimeout(lostTimer);
  while (pending.length) send(pending.shift());
  if (ARMS) send({ t: 'emg_sub' });
  if (S.local) return;
  if (S.phase === 'waiting' && S.queued) return joinQueue();
  if (S.phase === 'turn' && !m.driving) return goWait(); // the turn was lost while away: back in line
  if (S.phase === 'countdown' || S.phase === 'racing') {
    if (m.driving === 'claim') send({ t: 'start' }); // our start press never arrived
    else if (m.driving === 'racing') goNow();
    else if (!m.driving) endLocalRun(DROPPED);
  }
  if (S.finish) {
    if (m.driving === 'racing') send(S.finish);
    else if (!m.driving) finishUnsaved();
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      store.set('rc-id', m.id);
      freshMs = m.freshMs || 0;
      onHello(m);
      break;
    case 'emg': {
      const was = S.emg.online;
      S.emg = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, online: !!m.online };
      if (was !== S.emg.online && S.phase === 'home') toast(S.emg.online ? 'Arm sensor connected' : 'Arm sensor offline', { icon: 'arm' });
      break;
    }
    case 'board':
      S.board = { fastest: m.fastest || [], improved: m.improved || [] };
      if (ARCADE && S.phase === 'home') renderArcade();
      renderChooser();
      break;
    case 'lobby': {
      const was = S.carOnline;
      S.carOnline = !!m.carOnline;
      S.lineLength = m.queue?.length || 0;
      S.lineBusy = !!m.current;
      if (S.phase === 'waiting') {
        const who = m.current ? `${m.current.name} is driving.` : 'The track is free.';
        let text = m.pos ? `You're #${m.pos} in line. ${who}` : who;
        if (!m.carOnline) text += ' The real car is offline, so this run is on screen only.';
        $('wait-pos').textContent = text;
      }
      if ($('s-stop').classList.contains('active')) renderCarStatus();
      if (ARCADE) renderArcadeCar();
      if (was !== S.carOnline && S.phase === 'home') toast(S.carOnline ? 'The real car is connected' : 'The real car went offline', { icon: 'car' });
      break;
    }
    case 'your_turn':
      if (S.local) break;
      if (S.phase === 'countdown') {
        send({ t: 'start' }); // we pressed start but the server didn't get it
        break;
      }
      if (S.phase === 'racing' || S.phase === 'done') break;
      S.phase = 'turn';
      S.queued = false;
      S.claimEnds = performance.now() + m.claimMs;
      S.holdStart = 0;
      show('s-turn');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      refreshConnection();
      break;
    case 'countdown':
      if (S.local) break;
      if (S.phase !== 'countdown') startCountdownView();
      overlay(String(m.n));
      break;
    case 'go':
      if (!S.local) goNow();
      break;
    case 'run_end':
      if (S.local) break;
      stopFinishRetry();
      endLocalRun(
        {
          stopped: 'You stopped the run.',
          timeout: 'Time ran out. You can try again from the roadmap.',
          disconnected: 'The connection dropped, so your run was stopped.',
          stopped_by_host: 'The host stopped the run.',
          missed_turn: 'Your turn timed out. Join the line again when you are ready.',
          left: 'You left the line.',
        }[m.reason] || 'Run ended.',
      );
      break;
    case 'result':
      if (S.local || !S.finish) break;
      stopFinishRetry();
      showResult(m);
      break;
  }
}

// ---------- Profile: saved in this browser only (no accounts) ----------
const profileKey = (name) => `rc-profile:${name.toLowerCase()}`;
function loadLocalProfile(name) {
  try {
    return JSON.parse(store.get(profileKey(name)));
  } catch {
    return null;
  }
}
function loadProfile(name) {
  const p = loadLocalProfile(name);
  S.profile = { ...newProfile(name, localDay()), ...(p || {}), name };
  S.assist = ASSIST[S.profile.assist] ? S.profile.assist : 0;
  applySettings();
}
function saveProfile() {
  const p = S.profile;
  if (!p || ARCADE) return; // arcade players get a throwaway profile
  p.updatedAt = Date.now();
  store.set(profileKey(p.name), JSON.stringify(p));
}

function applySettings() {
  const p = S.profile;
  const check = (name, value) => {
    const el = document.querySelector(`input[name=${name}][value="${value}"]`);
    if (el) el.checked = true;
  };
  check('goal', p.goalMin);
  check('dpw', p.daysPerWeek);
  check('wide', p.wide ? 1 : 0);
  check('assist', S.assist);
}
const onSetting = (name, fn) =>
  document.querySelectorAll(`input[name=${name}]`).forEach((r) =>
    r.addEventListener('change', () => {
      if (!S.profile) return;
      fn(r.value);
      const d = S.profile.days[localDay()];
      if (d) d.goalMet = d.goalMet || d.ms >= S.profile.goalMin * 60000;
      saveProfile();
      renderHome();
      renderMenu();
    }),
  );
onSetting('goal', (v) => (S.profile.goalMin = Number(v)));
onSetting('dpw', (v) => (S.profile.daysPerWeek = Number(v)));
onSetting('wide', (v) => (S.profile.wide = v === '1'));
onSetting('assist', (v) => (S.assist = S.profile.assist = Number(v)));

// Celebrate achievements that this action completed.
function withAwards(fn) {
  if (ARCADE) return fn();
  const before = new Set(achievements(S.profile).filter((a) => a.done).map((a) => a.id));
  const out = fn();
  achievements(S.profile)
    .filter((a) => a.done && !before.has(a.id))
    .forEach((a, i) => setTimeout(() => toast(`Achievement: ${a.title}`, { icon: 'medal', kind: 'gold' }), 1200 + i * 900));
  return out;
}

// ---------- Step 1: name ----------
$('btn-name').onclick = () => {
  const name = $('name').value.replace(/\s+/g, ' ').trim();
  if (!name) {
    $('name-error').textContent = 'Type a name so your progress can be saved.';
    $('name-error').classList.remove('hidden');
    $('name').focus();
    return;
  }
  $('name-error').classList.add('hidden');
  S.name = name;
  store.set('rc-name', name);
  loadProfile(name);
  saveProfile(); // this browser remembers you from the first visit
  if (ARMS) return S.armCheck?.done || S.armManual ? goHome() : openArmCheck();
  if (S.mode === 'touch' || (tracker.lm && S.cal)) return goHome();
  show('s-camera');
};
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-name').click());

// ---------- Step 2: camera ----------
$('btn-camera').onclick = async () => {
  $('btn-camera').disabled = true;
  $('camera-error').classList.add('hidden');
  try {
    S.mode = 'head';
    show('s-camera');
    await tracker.start((s) => ($('camera-status').textContent = s));
    keepAwake();
    runCalibration(afterSetup);
  } catch (e) {
    console.error(e);
    $('camera-status').textContent = '';
    $('camera-error').textContent =
      e?.name === 'NotAllowedError'
        ? 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.'
        : `Face tracking could not start (${e?.message || e}). You can use touch controls instead.`;
    $('camera-error').classList.remove('hidden');
  } finally {
    $('btn-camera').disabled = false;
  }
};

$('btn-touch').onclick = () => {
  S.mode = 'touch';
  S.cal = null;
  keepAwake();
  afterSetup();
};
// After the camera setup: the roadmap, or straight into the race in the arcade.
function afterSetup() {
  if (ARCADE) startRace('gp');
  else goHome();
}

// ---------- Step 3: head setup (and measuring face ranges) ----------
const CAL_STEPS = [
  { key: 'neutral', title: 'Relax', sub: 'Look at the screen and keep your head still.' },
  { key: 'left', title: 'Steer left', sub: 'Tilt or turn your head to the left, whichever is comfortable, and hold it.' },
  { key: 'right', title: 'Steer right', sub: 'Now the same to the right, and hold it.' },
  { key: 'go', title: 'Your GO move', sub: 'Open your mouth, raise your eyebrows or smile. Pick one and hold it.' },
];

function calScreen() {
  S.phase = 'setup';
  show('s-cal');
  scene(raceTrack('gp'), 'showcase', 0.55);
  $('cal-error').classList.add('hidden');
  $('btn-cal-retry').classList.add('hidden');
  $('btn-cal-back').classList.add('hidden');
}
function calFail(why, canGoBack) {
  $('cal-title').textContent = 'Try that again';
  $('cal-sub').textContent = '';
  $('cal-error').textContent = why;
  $('cal-error').classList.remove('hidden');
  $('btn-cal-retry').classList.remove('hidden');
  // Without a finished head setup there's nothing to go back to, so offer touch controls instead.
  $('btn-cal-back').innerHTML = `<span>${canGoBack ? (ARCADE ? 'Back to the start' : 'Back to the roadmap') : 'Use touch controls instead'}</span>`;
  $('btn-cal-back').classList.remove('hidden');
}
async function collectStep(title, sub, stepText, settleMs) {
  $('cal-title').textContent = title;
  $('cal-sub').textContent = sub;
  $('cal-step').textContent = stepText;
  fillBar('cal-progress', 0);
  await wait(settleMs); // time to get into position
  const t0 = performance.now();
  const bar = setInterval(() => fillBar('cal-progress', (performance.now() - t0) / 1500), 50);
  const samples = await tracker.collect(1500);
  clearInterval(bar);
  fillBar('cal-progress', 1);
  return samples;
}

async function runCalibration(next = goHome) {
  if (!tracker.lm) return show('s-camera');
  S.retry = () => runCalibration(next);
  calScreen();
  const samples = {};
  for (let i = 0; i < CAL_STEPS.length; i++) {
    const st = CAL_STEPS[i];
    samples[st.key] = await collectStep(st.title, st.sub, `Head setup · ${i + 1} of ${CAL_STEPS.length}`, i === 0 ? 1500 : 2200);
  }
  const cal = buildCalibration(samples);
  if (!cal.ok) return calFail(cal.why, !!S.cal);
  S.cal = cal;
  // If the GO move was a face exercise, its range is measured already.
  for (const k of FACE_SIGS) {
    const r = rangeFromCalibration(cal, k);
    if (!S.profile.ranges[k] && r) S.profile.ranges[k] = r;
  }
  saveProfile();
  toast('Head setup done', { icon: 'check', kind: 'good' });
  next();
}

const SHOW_ME = {
  jaw: ['Open wide', 'Open your mouth as wide as is comfortable, and hold it.'],
  pucker: ['Pucker', 'Push your lips forward like a kiss, and hold it.'],
  smile: ['Big smile', 'Smile as wide as you can, and hold it.'],
};
async function captureRanges(keys, next) {
  S.retry = () => captureRanges(keys, next);
  calScreen();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const samples = await collectStep(`Show us: ${SHOW_ME[k][0]}`, SHOW_ME[k][1], `Measuring your range · ${i + 1} of ${keys.length}`, 2200);
    const r = rangeFrom(samples, S.cal, k);
    if (!r) return calFail("We couldn't see that move clearly. Check the light and try a bigger move, or go back and pick another stop.", true);
    S.profile.ranges[k] = r;
  }
  saveProfile();
  next();
}
$('btn-cal-retry').onclick = () => S.retry?.();
$('btn-cal-back').onclick = () => {
  if (S.cal) return goHome();
  S.mode = 'touch';
  afterSetup();
};

const needsRanges = (sigs) => (S.mode === 'head' ? [...new Set(sigs)].filter((k) => FACE_SIGS.includes(k) && !S.profile.ranges[k]) : []);
const verb = () => (S.mode !== 'head' ? 'Slide' : S.cal?.axis === 'roll' ? 'Tilt' : 'Turn');

// ---------- Home: up next, today, and the roadmap of every stop ----------
const fmtMin = (m) => (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m)));
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;
const stopTrack = (ui, li) => (ui < 0 ? raceTrack('gp') : li === 5 ? raceTrack(UNITS[ui].id) : lessonTrack(ui, li));

function goHome() {
  if (ARCADE) return arcadeHome();
  if (S.queued) send({ t: 'leave' });
  S.queued = false;
  S.local = false;
  S.phase = 'home';
  S.timers.forEach(clearTimeout);
  S.timers = [];
  overlay('');
  clearInterval(S.restTimer);
  renderHome();
  show('s-home');
  const nx = nextNode(S.profile, PATHID);
  scene(nx ? stopTrack(nx.ui, nx.li) : raceTrack(ARMS ? 'a4' : 'gp'), 'preview', 0.64);
  world?.reset();
}
$('home-scroll').addEventListener('scroll', () => {
  const el = $('home-scroll');
  $('s-home').classList.toggle('scrolled', el.scrollTop > el.querySelector('.hero-space').offsetHeight - 50);
}, { passive: true });

function streakText(wv) {
  const left = Math.max(0, wv.target - wv.count);
  let t = wv.streak
    ? `${wv.streak}-week streak. ${wv.thisWeekMet ? 'This week is done.' : `${left} more goal day${left === 1 ? '' : 's'} this week.`}`
    : `Hit your goal on ${wv.target} days this week to start a streak. Rest days are built in.`;
  if (wv.frozen) t += ' A missed week was frozen, so your streak kept going.';
  return t;
}

// Where each stop sits on a unit's trail: x in % of the width, y in px.
const TRAIL_X = [22, 42, 70, 78, 58, 30];
const TRAIL_STEP = 84;
const TRAIL_TOP = 44;
const trailX = (ui, li) => (ui % 2 ? 100 - TRAIL_X[li] : TRAIL_X[li]);

function stopInfo(p, ui, li) {
  const u = UNITS[ui];
  const st = nodeState(p, ui, li);
  if (li === 5) {
    const b = p.bosses[u.id];
    return { st, boss: true, title: `Boss: ${u.boss.name}`, sub: raceTrack(u.id).name, meta: b?.bestMs ? `Best ${fmt(b.bestMs)}` : 'Race the real car' };
  }
  const l = lessonsOf(p, u.id)[li];
  const meta = isGold(l) ? `Gold · level ${l.level + 1}` : l.plays ? `Level ${l.level + 1} · last ${Math.round((l.lastRate || 0) * 10)}/10` : 'Not played yet';
  return { st, title: lessonInfo(ui, li).title, sub: lessonTrack(ui, li).name, meta };
}

function diamond(st, { boss = false, num = '', icon = null } = {}) {
  const ic = icon || (st === 'gold' ? 'crown' : st === 'done' ? 'check' : boss ? 'car' : null);
  const inner = ic ? `<i data-icon="${ic}"></i>` : `<b>${num}</b>`;
  const cls = ['dia', `s-${st === 'next' ? 'open' : st}`, st === 'next' && 's-next', boss && 's-boss'].filter(Boolean).join(' ');
  return `<span class="${cls}">${inner}</span>`;
}

function renderHome() {
  const p = S.profile;
  if (!p) return;
  const day = localDay();
  $('h-name').textContent = p.name;
  $('h-avatar').textContent = p.name.charAt(0).toUpperCase();
  const lv = xpLevel(p.xp);
  $('h-level').textContent = `Level ${lv.level}`;
  fillBar('h-level-bar', lv.frac);
  $('h-xp').textContent = p.xp;
  const wv = weekView(p, day);
  $('h-streak').textContent = `${wv.streak} wk`;

  // Up next
  const nx = nextNode(p, PATHID);
  const card = document.querySelector('#s-home .up-next');
  card.className = `panel up-next ${nx ? cc(nx.ui) : 'c-violet'}`;
  if (nx) {
    const u = UNITS[nx.ui];
    const t = stopTrack(nx.ui, nx.li);
    $('h-next-unit').textContent = `${ARMS ? 'Arm unit' : 'Unit'} ${unitNo(nx.ui)} · ${u.title}`;
    $('h-next-title').textContent = nx.li === 5 ? `Boss race: ${u.boss.name}` : lessonInfo(nx.ui, nx.li).title;
    $('h-next-course').innerHTML = `${iconSvg('map')}<span>${esc(t.name)} · ${nx.li === 5 ? 'a race on the real car' : `${LESSON_GATES} gates, about 2 minutes`}</span>`;
    $('h-next-what').textContent = nx.li === 5 ? u.boss.how : lessonInfo(nx.ui, nx.li).what;
    $('h-next-tag').textContent = p.xp ? 'up next' : 'start here';
    $('h-hero-note').textContent = t.name.toLowerCase();
    $('btn-continue').innerHTML = `<span data-icon="play">${nx.li === 5 ? 'See the race' : 'Start'}</span>`;
    $('btn-gp').classList.toggle('hidden', ARMS);
  } else if (ARMS) {
    $('h-next-unit').textContent = 'Arm path';
    $('h-next-title').textContent = 'Every stop is done!';
    $('h-next-course').innerHTML = `${iconSvg('trophy')}<span>Replay anything, or race the Arm Grand Prix</span>`;
    $('h-next-what').textContent = 'Keep your arms in practice: a few lessons every other day.';
    $('h-next-tag').textContent = 'well done';
    $('h-hero-note').textContent = 'arm grand prix';
    $('btn-continue').innerHTML = '<span data-icon="trophy">Race the Arm Grand Prix</span>';
    $('btn-gp').classList.add('hidden');
  } else {
    $('h-next-unit').textContent = 'Together';
    $('h-next-title').textContent = 'Every stop is done!';
    $('h-next-course').innerHTML = `${iconSvg('trophy')}<span>Replay anything, or race the Grand Prix</span>`;
    $('h-next-what').textContent = GRAND_PRIX.how;
    $('h-next-tag').textContent = 'well done';
    $('h-hero-note').textContent = 'grand prix';
    $('btn-continue').innerHTML = '<span data-icon="trophy">Race the Grand Prix</span>';
    $('btn-gp').classList.add('hidden');
  }
  const tv = todayView(p, day);
  $('h-ring').style.setProperty('--p', tv.frac.toFixed(3));
  $('h-ring').classList.toggle('done', tv.met);
  $('h-ring-text').textContent = tv.met ? '✓' : `${Math.round(tv.frac * 100)}%`;
  $('h-today').textContent = tv.met ? `Daily goal done! ${fmtMin(tv.min)} min today` : `${fmtMin(tv.min)} of ${tv.goalMin} min today`;
  $('h-days').innerHTML = wv.days.map((d) => `<span class="${[d.met && 'met', d.today && 'today', d.future && 'future'].filter(Boolean).join(' ')}">${d.label}</span>`).join('');
  $('h-streak-text').textContent = streakText(wv);

  // Roadmap
  const pp = pathProgress(p, PATHID);
  $('h-map-count').textContent = `${pp.done} / ${pp.total} stops${pp.gold ? ` · ${pp.gold} gold` : ''}`;
  fillBar('h-map-bar', pp.done / pp.total);
  const line = progressLine(p);
  $('h-progress').textContent = line;
  $('h-progress').classList.toggle('hidden', !line);

  const gpCount = p.counts?.gp || 0;
  const units = unitsOf(PATHID);
  $('h-unit-tabs').innerHTML = units.map(({ u, ui }) => {
    const up = unitProgress(p, ui);
    return `<button class="utab ${cc(ui)}" data-jump="${ui}" style="--fill:${(up.done / up.total).toFixed(3)}" aria-label="Unit ${unitNo(ui)}, ${esc(u.title)}, ${up.done} of ${up.total} done"><b>${unitNo(ui)}</b><span>${up.done}/${up.total}</span></button>`;
  }).join('') + (ARMS ? '' : `<button class="utab c-violet" data-jump="gp" style="--fill:${gpCount ? 1 : 0}" aria-label="Grand Prix"><b><i data-icon="trophy"></i></b><span>GP</span></button>`);

  let html = '';
  units.forEach(({ u, ui }) => {
    const up = unitProgress(p, ui);
    const H = TRAIL_TOP * 2 + 5 * TRAIL_STEP;
    const pts = [0, 1, 2, 3, 4, 5].map((li) => [trailX(ui, li), TRAIL_TOP + li * TRAIL_STEP]);
    const d = pts.map(([x, y], i) => {
      if (!i) return `M${x} ${y}`;
      const [px, py] = pts[i - 1];
      return `C${px} ${py + TRAIL_STEP / 2} ${x} ${y - TRAIL_STEP / 2} ${x} ${y}`;
    }).join('');
    html += `<div class="region ${cc(ui)}" id="region-${ui}">
      <div class="region-head"><span class="region-num">${unitNo(ui)}</span><div><p class="eyebrow">Unit ${unitNo(ui)} · ${esc(u.section)}</p><h3 class="title">${esc(u.title)}</h3></div>
      <div class="ring small" style="--p:${(up.done / up.total).toFixed(3)}"><span>${up.done}/${up.total}</span></div></div>
      <p class="region-why">${esc(u.move)}. ${esc(u.why)}</p>
      <div class="trail" style="height:${H}px"><svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
    for (let li = 0; li <= 5; li++) {
      const info = stopInfo(p, ui, li);
      const x = trailX(ui, li);
      const left = x > 50;
      html += `<button class="stop${left ? ' label-left' : ''}" style="left:${x}%;top:${pts[li][1]}px" data-ui="${ui}" data-li="${li}" aria-label="${esc(info.title)}, ${esc(info.sub)}, ${esc(info.meta)}">`
        + `${diamond(info.st, { boss: info.boss, num: li + 1 })}<span class="stop-label"><b>${esc(info.title)}</b><small>${esc(info.sub)}</small><small class="meta">${esc(info.meta)}</small></span></button>`;
      if (info.st === 'next') {
        html += `<span class="here${left ? ' to-right' : ''}" style="left:${x}%;top:${pts[li][1]}px" aria-hidden="true">${p.xp ? 'next!' : 'start here!'}</span>`;
      }
    }
    html += '</div></div>';
  });
  if (!ARMS) html += `<div class="region c-violet" id="region-gp">
    <div class="region-head"><span class="region-num"><i data-icon="trophy"></i></span><div><p class="eyebrow">Together · head and face</p><h3 class="title">${GRAND_PRIX.name}</h3></div></div>
    <p class="region-why">${esc(GRAND_PRIX.how)} Open any time.</p>
    <div class="trail short"><button class="stop" style="left:28%;top:46px" data-gp="1" aria-label="Grand Prix">${diamond(gpCount ? 'done' : 'open', { boss: true, icon: 'trophy' })}<span class="stop-label"><b>Grand Prix</b><small>${esc(raceTrack('gp').name)} · leaderboard</small><small class="meta">${gpCount ? `Raced ${gpCount} time${gpCount === 1 ? '' : 's'}${p.bosses.gp?.bestMs ? ` · best ${fmt(p.bosses.gp.bestMs)}` : ''}` : 'Not raced yet'}</small></span></button></div>
  </div>`;
  $('map').innerHTML = html;
  mountIcons($('s-home'));
}

$('map').onclick = (e) => {
  const b = e.target.closest('.stop');
  if (!b) return;
  if (b.dataset.gp) openStop(-1, -1);
  else openStop(Number(b.dataset.ui), Number(b.dataset.li));
};
$('h-unit-tabs').onclick = (e) => {
  const b = e.target.closest('[data-jump]');
  if (b) $(`region-${b.dataset.jump}`)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
};
$('btn-continue').onclick = () => {
  const nx = nextNode(S.profile, PATHID);
  if (!nx) return ARMS ? openStop(unitIndex('a4'), 5) : openStop(-1, -1);
  if (nx.li === 5) return openStop(nx.ui, 5);
  startLesson(nx.ui, nx.li);
};
$('btn-gp').onclick = () => openStop(-1, -1);
$('btn-me').onclick = () => openMenu('progress');
$('btn-menu').onclick = () => openMenu('progress');

// ---------- A stop: a lesson, a boss race or the Grand Prix ----------
// How each race is controlled. Only the Grand Prix and Curvy Road are steered by you;
// the other boss races practise one move, so the car steers itself.
function raceControls(level) {
  const head = S.mode === 'head';
  const you = head ? capital(S.cal?.steerLabel || 'your head') : 'Slide your finger';
  switch (level) {
    case 'u1': return ['By itself', 'Keep your head still'];
    case 'u2': return [you, 'Rolls by itself'];
    case 'u3': return ['By itself', head ? 'Open your mouth' : 'Drag up'];
    case 'u4': return ['By itself', head ? 'Pucker to boost' : 'Drag up to boost'];
    case 'a1': return ['By itself', 'Squeeze either arm'];
    case 'a2': return ['By itself', 'Hold a squeeze'];
    case 'a3': return ['By itself', 'Rolls; squeeze to boost'];
    case 'a4': return ['Left arm turns right, right arm turns left', 'Both arms: full speed'];
    default: return [you, head ? capital(S.cal?.goLabel || 'your GO move') : 'Hold your finger down'];
  }
}
function courseSvg(t) {
  const { d, map } = trackSvgPath(t, 120, 80, 9);
  const at = (dist) => map(t.pointAt(dist).x, t.pointAt(dist).y).map((v) => v.toFixed(1));
  const marks = t.gates.length
    ? t.gates.map((g) => {
      const [x, y] = at(g);
      return `<circle class="gate-dot" cx="${x}" cy="${y}" r="2.8"/>`;
    }).join('')
    : t.stars.map((s) => {
      const [x, y] = map(s.x, s.y).map((v) => v.toFixed(1));
      return `<circle class="star-dot" cx="${x}" cy="${y}" r="2.2"/>`;
    }).join('');
  const ramps = t.features.filter((f) => f.type === 'ramp').map((f) => {
    const [x, y] = at(f.at + f.len / 2);
    return `<rect class="ramp-dot" x="${(x - 2.6).toFixed(1)}" y="${(y - 2.6).toFixed(1)}" width="5.2" height="5.2" rx="1" transform="rotate(45 ${x} ${y})"/>`;
  }).join('');
  const [sx, sy] = at(t.startAt);
  const [fx, fy] = at(t.finishAt);
  return `<path class="road" d="${d}"/><path class="line" d="${d}"/>${ramps}${marks}`
    + `<circle class="start-dot" cx="${sx}" cy="${sy}" r="3.6"/><rect class="finish-dot" x="${(fx - 3.6).toFixed(1)}" y="${(fy - 3.6).toFixed(1)}" width="7.2" height="7.2" rx="1.2"/>`;
}

function openStop(ui, li) {
  S.stop = { ui, li };
  S.phase = 'home';
  const p = S.profile;
  const t = stopTrack(ui, li);
  document.querySelector('#s-stop .stop-sheet').className = `panel sheet stop-sheet ${ui < 0 ? 'c-violet' : cc(ui)}`;
  const ramps = t.features.filter((f) => f.type === 'ramp').length;
  const jumps = ramps ? `${ramps} jump${ramps === 1 ? '' : 's'}` : 'No jumps';
  let facts;
  let note = '';
  if (ui < 0) {
    $('st-unit').textContent = 'Together · head and face';
    $('st-title').textContent = GRAND_PRIX.name;
    $('st-what').textContent = `${GRAND_PRIX.how} Times go on the big screen's leaderboard.`;
    facts = [['Steering', raceControls('gp')[0]], ['Go', raceControls('gp')[1]], ['Best time', p.bosses.gp?.bestMs ? fmt(p.bosses.gp.bestMs) : 'Not yet'], ['Your races', String(p.counts?.gp || 0)]];
  } else {
    const u = UNITS[ui];
    $('st-unit').textContent = `${ARMS ? 'Arm unit' : 'Unit'} ${unitNo(ui)} · ${u.title}`;
    if (li === 5) {
      const b = p.bosses[u.id];
      $('st-title').textContent = `Boss race: ${u.boss.name}`;
      $('st-what').textContent = u.boss.how;
      facts = [['Steering', raceControls(u.id)[0]], ['Go', raceControls(u.id)[1]], ['Best time', b?.bestMs ? fmt(b.bestMs) : 'Not yet'], ['Cleared', b?.cleared ? 'Yes' : 'Not yet']];
      if (!lessonsOf(p, u.id).every((l) => l.done)) note = `The five ${u.title} lessons practise this move first, but you can race now.`;
    } else {
      const k = lessonInfo(ui, li);
      const l = lessonsOf(p, u.id)[li];
      $('st-title').textContent = k.title;
      $('st-what').textContent = `${k.what} Do it at each gate to open it. A miss still opens the gate, so you always reach the finish.`;
      facts = [
        ['Level', `${l.level + 1}: ${difficultyText(u.id, k.key, l.level)}`],
        ['Last score', l.lastRate == null ? 'Not played' : `${Math.round(l.lastRate * 10)}/10`],
        ['Played', l.plays ? `${l.plays} time${l.plays === 1 ? '' : 's'}` : 'Not yet'],
        ['Gold', isGold(l) ? 'Yes!' : `${l.goodDays.length} of 2 good days`],
      ];
      const prev = lessonsOf(p, u.id)[li - 1];
      if (prev && !prev.done && !l.done) note = `Suggested first: ${lessonInfo(ui, li - 1).title}. You can play this one now anyway.`;
    }
  }
  $('st-course').innerHTML = `${iconSvg('map')}<span>${esc(t.name)}</span>`;
  $('st-svg').innerHTML = courseSvg(t);
  $('st-course-facts').innerHTML = (li >= 0 && li < 5
    ? [['gate', `${LESSON_GATES} gates`, 'one rep at each'], ['flag', 'Ends at the finish', `${jumps.toLowerCase()} on the way`], ['clock', 'About 2 minutes', ARMS ? 'steer with your arms between gates' : 'the drive is your rest']]
    : [['star', `${t.stars.length} stars`, `each takes ${STAR_BONUS_MS / 1000} s off`], ['up', jumps, 'with boost pads'], ['car', 'Real RC car', 'or play on this phone']]
  ).map(([ic, b, s]) => `<div>${iconSvg(ic)}<span><b>${esc(b)}</b><small>${esc(s)}</small></span></div>`).join('');
  $('st-facts').innerHTML = facts.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
  $('st-note').textContent = note;
  $('st-note').classList.toggle('hidden', !note);
  renderStopActions();
  show('s-stop');
  scene(t, 'preview', 0.6);
  world?.reset();
  $('s-stop').querySelector('.sheet').scrollTop = 0;
}

function renderCarStatus() {
  const el = $('st-car');
  if (!el) return;
  const line = S.lineBusy || S.lineLength ? ` · ${S.lineLength} waiting` : ' · track free';
  el.innerHTML = `<span class="lamp${S.carOnline ? ' on' : ''}"></span>${S.carOnline ? `Real car connected${line}` : 'Real car offline. You can still race on this phone.'}`;
}
function renderStopActions() {
  const { ui, li } = S.stop;
  if (ui >= 0 && li < 5) {
    $('st-actions').innerHTML = '<button class="btn unit big" id="btn-st-start"><span data-icon="play">Start lesson</span></button>';
  } else if (ARMS && mc.connected) {
    // The MuscleCar is right here over Bluetooth: no line, the car follows this race.
    const on = S.tune.follow;
    $('st-actions').innerHTML = `<p class="car-status"><span class="lamp${on ? ' on' : ''}"></span>${on ? 'MuscleCar connected: the real car follows this race' : 'MuscleCar connected. Following is off (Sensors and car).'}</p>`
      + '<button class="btn unit big" id="btn-st-phone"><span data-icon="play">Start race</span></button>';
  } else {
    const real = (c) => `<button class="btn ${c}" id="btn-st-real"><span data-icon="car">Drive the real car</span></button>`;
    const phone = (c) => `<button class="btn ${c}" id="btn-st-phone"><span data-icon="phone">Play on this phone</span></button>`;
    $('st-actions').innerHTML = `<p class="car-status" id="st-car"></p>${S.carOnline ? real('unit big') + phone('quiet') : phone('unit big') + real('quiet')}`;
    renderCarStatus();
  }
  mountIcons($('st-actions'));
}
$('st-actions').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const { ui, li } = S.stop;
  const level = ui < 0 ? 'gp' : UNITS[ui].id;
  if (b.id === 'btn-st-start') startLesson(ui, li);
  if (b.id === 'btn-st-real') startRace(level, { local: false });
  if (b.id === 'btn-st-phone') startRace(level, { local: true });
};
$('btn-stop-close').onclick = goHome;

// ---------- Lessons: each lesson is its own course that ends at the finish line ----------
function startLesson(ui, li) {
  if (pathOf(UNITS[ui]) === 'arms') return startArmLesson(ui, li);
  if (S.mode === 'head' && !S.cal) return runCalibration(() => startLesson(ui, li));
  const unitSigs = UNITS[ui].moves.map((m) => m[0]);
  const reviewSigs = li === 4 && ui > 0 ? UNITS[ui - 1].moves.map((m) => m[0]) : [];
  const need = needsRanges([...unitSigs, ...reviewSigs]);
  if (need.length) return captureRanges(need, () => startLesson(ui, li));

  const lesson = buildLesson(S.profile, ui, li, { verb: verb() });
  runLesson(ui, li, lesson, new LessonRun(lesson, { axis: S.cal?.axis || 'yaw' }));
}
// Arm lessons: no camera. The sensor check comes first unless it's done or keys/touch are in use.
function startArmLesson(ui, li) {
  if (!S.armCheck?.done && !S.armManual && !armOnline()) return openArmCheck(() => startArmLesson(ui, li));
  const lesson = buildArmLesson(S.profile, ui, li);
  runLesson(ui, li, lesson, new ArmRun(lesson), { armSteer: { win: S.tune.chord } });
}
function runLesson(ui, li, lesson, run, opts = {}) {
  const track = lessonTrack(ui, li);
  const course = new LessonCourse(track, run, opts);
  S.lesson = {
    ui, li, lesson, run, track, course,
    activeMs: 0,
    meterOff: false,
    lastCue: '',
    lastGate: -1,
    wasGold: isGold(lessonsOf(S.profile, UNITS[ui].id)[li]),
    fatigueShown: false,
    finishing: false,
  };
  S.phase = 'lesson';
  S.timers.forEach(clearTimeout);
  S.timers = [];
  scene(track, 'chase', 0);
  world?.reset();
  world?.setCar(course.car);
  document.querySelector('#s-lesson .course-bar').className = `course-bar panel slim ${cc(ui)}`;
  $('l-course').textContent = `${track.name} · ${lessonInfo(ui, li).title}${AUTOPILOT ? ' · autopilot' : ''}`;
  tellAutopilot();
  $('l-track').innerHTML = '<i class="cb-fill" id="l-fill"></i>'
    + track.gates.map((d, i) => `<span class="cb-gate" data-g="${i}" style="left:${((d / track.finishAt) * 100).toFixed(2)}%"></span>`).join('')
    + '<span class="cb-flag"></span><span class="cb-car" id="l-car"></span>';
  mountIcons($('l-track'));
  $('l-fatigue').classList.add('hidden');
  $('l-cue').textContent = '';
  setMeterButton();
  show('s-lesson');
}

function setMeterButton() {
  const off = !!S.lesson?.meterOff;
  $('btn-meter').innerHTML = `<span data-icon="eye">${off ? 'Show meter' : 'Hide meter'}</span>`;
  $('btn-meter').setAttribute('aria-pressed', String(off));
  mountIcons($('btn-meter'));
}
$('btn-meter').onclick = () => {
  if (!S.lesson) return;
  S.lesson.meterOff = !S.lesson.meterOff;
  setMeterButton();
};
$('btn-tired').onclick = () => finishLesson(true);
$('btn-l-finish').onclick = () => finishLesson(true);
$('btn-l-quit').onclick = () => finishLesson(true);

// ?autopilot: a stand-in player for demos without a face. It only plays while nobody else is:
// a calibrated face in view, a finger on the screen or a key held takes over straight away.
const playerActive = () => (S.mode === 'head' && !!S.cal && tracker.faceVisible) || (S.mode === 'arms' && armOnline()) || S.armBtn.l || S.armBtn.r || S.touch.active || S.keys.size > 0;
const autopilotNow = () => AUTOPILOT && !playerActive();
let autopilotTold = false;
function tellAutopilot() {
  if (!AUTOPILOT || autopilotTold) return;
  autopilotTold = true;
  if (S.mode === 'arms') return toast('Autopilot is on until the arm sensor connects', { icon: 'car' });
  toast(S.mode === 'head' ? 'Autopilot is on until it sees your face' : 'Autopilot is on until you touch the screen', { icon: 'car' });
}
const bot = { v: 0 };
function botSignals(run, dt) {
  if (S.mode === 'arms') return { ...(S.lesson?.course.botArms() || run.want()), face: true };
  const w = run.want();
  bot.v += (w.value - bot.v) * Math.min(1, dt * 5);
  const s = { side: 0, still: 0, pitch: 0, jaw: 0, pucker: 0, smile: 0, raw: { side: 0, jaw: 0, pucker: 0, smile: 0 }, axis: 'yaw', face: true };
  if (w.sig === 'side' || w.sig === 'still') {
    s.side = bot.v * (w.dir || 1);
    s.still = Math.abs(s.side);
    s.raw.side = s.side * 0.3;
  } else {
    s[w.sig] = bot.v;
    s.raw[w.sig] = bot.v * 0.4;
  }
  return s;
}

function lessonFrame(dt, sig) {
  const L = S.lesson;
  const { view, ev, gateEvent } = L.course.update(autopilotNow() ? botSignals(L.run, dt) : sig, dt);
  if (!view.lost && L.course.mode !== 'done') L.activeMs += dt * 1000;
  if (gateEvent) {
    world?.setGate(gateEvent.i, gateEvent.ok ? 'good' : 'miss');
    if (gateEvent.ok) {
      ev.boost = true;
      if (navigator.vibrate) navigator.vibrate(30);
    }
  }
  const car = L.course.car;
  world?.fx(ev);
  world?.setCar({ x: car.x, y: car.y, z: car.z, h: car.h, v: car.v, vz: car.vz, steer: car.steer, air: car.air, boost: L.course.burst > 0 ? 1 : 0 });
  renderLesson(view);
  if (view.done && !L.finishing) {
    L.finishing = true;
    overlay('Finish!');
    S.timers.push(setTimeout(() => finishLesson(false), 1300));
  }
}

const HOLD_LABEL = { reach: 'Hold', aim: 'Hold', hold: 'Hold', quick: 'Time', return: 'Back', relax: 'Loose', curl: 'Rep', swap: 'Switch' };
function renderLesson(v) {
  const L = S.lesson;
  if (v.cue !== L.lastCue) {
    const el = $('l-cue');
    el.textContent = v.cue;
    const last = v.results[v.results.length - 1];
    el.classList.remove('pop', 'good');
    if (v.phase === 'result' && last?.ok && v.mode === 'drive') el.classList.add('good');
    void el.offsetWidth;
    el.classList.add('pop');
    L.lastCue = v.cue;
  }
  if ($('l-sub').textContent !== v.sub) $('l-sub').textContent = v.sub;
  // Course bar: where the car is, and each gate's result.
  const pct = `${(v.courseProgress * 100).toFixed(1)}%`;
  $('l-fill').style.width = pct;
  $('l-car').style.left = pct;
  const key = v.gate * 2 + (v.mode === 'gate' ? 1 : 0);
  if (L.lastGate !== key) {
    L.lastGate = key;
    v.gates.forEach((g, i) => {
      const el = $('l-track').querySelector(`[data-g="${i}"]`);
      if (el) el.className = `cb-gate${g.state !== 'closed' ? ` ${g.state}` : ''}${i === v.gate && !v.done ? ' now' : ''}`;
    });
    $('l-count').textContent = v.gate < v.gates.length ? `Gate ${v.gate + 1} / ${v.gates.length}` : 'Finish';
  }
  const g = v.gauge;
  const hide = g.hideDot || L.meterOff;
  const pad = g.type === 'pad';
  const arms = g.type === 'arms';
  $('l-gauge').classList.toggle('hidden', pad || arms);
  $('l-pad').classList.toggle('hidden', !pad);
  if (arms) {
    armLights('l-arms', g, hide ? null : g.want);
  } else if (pad) {
    const pos = (u) => `${50 + (clamp(u, -1.25, 1.25) / 1.25) * 50}%`;
    const dot = $('l-pdot');
    dot.style.left = pos(g.x);
    dot.style.top = pos(g.y);
    dot.classList.toggle('ghost', hide);
    const z = g.band?.zone;
    const zone = $('l-zone');
    zone.classList.toggle('hidden', !z);
    zone.classList.toggle('rest', g.band?.kind === 'rest');
    if (z) {
      const size = Math.min(100, (z / 1.25) * 100);
      Object.assign(zone.style, { width: `${size}%`, height: `${size}%`, left: `${50 - size / 2}%`, top: `${50 - size / 2}%` });
    }
  } else {
    const bi = g.type === 'bi';
    $('l-gauge').classList.toggle('bi', bi);
    const pos = (u) => (bi ? 50 + (clamp(u, -1.25, 1.25) / 1.25) * 50 : (clamp(u, 0, 1.25) / 1.25) * 100);
    const at = (pct) => `calc(14px + (100% - 28px) * ${(pct / 100).toFixed(4)})`; // keep the dot inside the rounded ends
    $('l-dot').style.left = at(pos(g.value));
    $('l-dot').classList.toggle('ghost', hide);
    const band = $('l-band');
    const r = g.band?.range;
    band.classList.toggle('hidden', !r);
    if (r) {
      const a = pos(Math.min(r[0], r[1]));
      const b = pos(Math.max(r[0], r[1]));
      const lo = a <= 0.5 ? 0 : a; // bands that start at an end fill to the edge
      const hi = b >= 99.5 ? 100 : b;
      band.style.left = lo === 0 ? '4px' : at(lo);
      band.style.width = `calc(${hi === 100 ? '100% - 4px' : at(hi)} - ${lo === 0 ? '4px' : at(lo)})`;
      band.classList.toggle('rest', g.band.kind === 'rest');
    }
  }
  $('l-hold-label').textContent = v.mode === 'gate' ? HOLD_LABEL[L.run.rep.kind] || 'Hold' : 'Drive';
  fillBar('l-hold', v.mode === 'gate' ? v.progress : v.courseProgress);
  $('l-hold').parentElement.classList.toggle('drive', v.mode !== 'gate');
  if (v.fatigue && !L.fatigueShown) {
    L.fatigueShown = true;
    $('l-fatigue').classList.remove('hidden');
  }
  $('cam-slot-lesson').classList.toggle('lost', !!v.lost);
}

function finishLesson(tired) {
  const L = S.lesson;
  if (!L || S.phase !== 'lesson') return;
  S.phase = 'lessondone';
  S.timers.forEach(clearTimeout);
  S.timers = [];
  overlay('');
  const sum = { ...L.run.summary(), ms: Math.round(L.activeMs), tired };
  if (!sum.total) {
    // Stopped before the first gate: keep the practice time, nothing to score.
    addPractice(S.profile, localDay(), { ms: sum.ms });
    saveProfile();
    return goHome();
  }
  const unit = UNITS[L.ui];
  const out = withAwards(() => recordLesson(S.profile, L.ui, L.li, sum, localDay()));
  saveProfile();
  sendSure({
    t: 'practice', name: S.profile.name, unit: unit.id, lesson: L.li, good: sum.good, total: sum.total,
    xp: out.xp, ms: sum.ms, reactMs: sum.reactMs, fatigue: sum.fatigue, tired,
  });
  showDone(sum, out, tired);
}

function showDone(sum, out, tired) {
  const L = S.lesson;
  $('s-done').querySelector('.sheet').className = `panel sheet ${cc(L.ui)}`;
  $('d-unit').textContent = `Unit ${unitNo(L.ui)} · ${UNITS[L.ui].title} · ${L.track.name}`;
  $('d-title').textContent = tired ? 'Good call to rest' : sum.rate >= 0.9 ? 'Brilliant!' : sum.rate >= 0.6 ? 'Course complete' : 'You made it';
  $('d-score').textContent = `${sum.good}/${sum.total}`;
  $('d-xp').textContent = `+${out.xp}`;
  $('d-gates').innerHTML = Array.from({ length: LESSON_GATES }, (_, i) => {
    const r = L.run.results[i];
    return `<i class="${r ? (r.ok ? 'good' : 'miss') : ''}" title="Gate ${i + 1}: ${r ? (r.ok ? 'good rep' : 'missed') : 'not reached'}"></i>`;
  }).join('');
  let banner = '';
  let icon = 'star';
  if (out.goalJustMet) {
    banner = 'Daily goal done!';
    icon = 'flame';
  } else if (out.gold && !L.wasGold) {
    banner = 'Gold! You did this well on two different days.';
    icon = 'crown';
  } else if (out.change === 'up') {
    banner = 'Level up for this lesson.';
    icon = 'up';
  }
  $('d-banner').innerHTML = banner ? `${iconSvg(icon)}<span>${esc(banner)}</span>` : '';
  $('d-banner').classList.toggle('hidden', !banner);
  $('d-change').textContent = out.text;
  $('d-change').classList.toggle('hidden', !out.text);
  const fat = sum.fatigue
    ? 'Your last reps looked tired: slower or smaller moves. A longer rest, or stopping for today, is a good idea.'
    : tired ? 'Stopping when you are tired is part of training. Your reps still count.' : '';
  $('d-fatigue').textContent = fat;
  $('d-fatigue').classList.toggle('hidden', !fat);
  const line = progressLine(S.profile);
  $('d-progress').textContent = line;
  $('d-progress').classList.toggle('hidden', !line);
  const tv = todayView(S.profile, localDay());
  $('d-today').textContent = tv.met ? `Goal done! ${fmtMin(tv.min)} min` : `${fmtMin(tv.min)} of ${tv.goalMin} min`;
  fillBar('d-goal', tv.frac);
  $('btn-next').innerHTML = `<span data-icon="play">${L.li < 4 ? `Next: ${lessonInfo(L.ui, L.li + 1).title}` : 'Next: the boss race'}</span>`;
  mountIcons($('btn-next'));
  startRest();
  show('s-done');
  scene(L.track, 'showcase', 0.6);
  $('s-done').querySelector('.sheet').scrollTop = 0;
}

function startRest() {
  clearInterval(S.restTimer);
  const t0 = Date.now();
  const tick = () => {
    const el = Math.floor((Date.now() - t0) / 1000);
    const left = Math.max(0, 30 - el);
    $('d-rest-title').textContent = left ? `Rest ${left} s` : 'Rested. Ready when you are.';
    $('d-rest-sub').textContent = left ? (Math.floor(el / 4) % 2 ? 'Breathe out slowly.' : 'Breathe in slowly.') : 'Take more time if you need it.';
    if (!left) clearInterval(S.restTimer);
  };
  tick();
  S.restTimer = setInterval(tick, 250);
}
$('btn-next').onclick = () => {
  clearInterval(S.restTimer);
  const { ui, li } = S.lesson;
  if (li < 4) startLesson(ui, li + 1);
  else openStop(ui, 5);
};
$('btn-to-path').onclick = goHome;

// ---------- Races: boss races and the Grand Prix ----------
function startRace(level, { local = false } = {}) {
  if (S.mode === 'head' && !S.cal) return runCalibration(() => startRace(level, { local }));
  const need = needsRanges(level === 'u3' ? ['jaw'] : level === 'u4' ? ['pucker'] : []);
  if (need.length) return captureRanges(need, () => startRace(level, { local }));
  S.level = level;
  S.local = local;
  S.track = raceTrack(level);
  S.timers.forEach(clearTimeout);
  S.timers = [];
  if (!local) return goWait();
  if (S.queued) send({ t: 'leave' });
  S.queued = false;
  startCountdownView();
  [3, 2, 1].forEach((n, i) => S.timers.push(setTimeout(() => overlay(String(n)), 300 + i * 1000)));
  S.timers.push(setTimeout(goNow, 3300));
}
function goNow() {
  if (S.phase !== 'countdown') return;
  S.phase = 'racing';
  S.raceStart = performance.now();
  overlay('GO');
  S.timers.push(setTimeout(() => S.phase === 'racing' && overlay(''), 700));
}

// Each boss race uses one exercise. The car steers itself unless steering is the exercise.
function bossControl(level, it, sig, car, dt) {
  if (level.startsWith('a')) {
    const c = armRaceControl(level, sig, S.armRace, dt, autoSteer(car));
    const on = sig.face && (sig.l || sig.r);
    if (on && !S.armRace.wasOn) S.stats.squeezes++;
    S.armRace.wasOn = on;
    if (on) S.stats.onMs += dt * 1000;
    if (c.boost) {
      car.boost = 1.0;
      world?.fx({ boost: true });
    }
    return c;
  }
  const on = sig.face;
  switch (level) {
    case 'u1': return { steer: autoSteer(car), go: on ? clamp((0.5 - sig.still) / 0.3, 0, 1) : 0 };
    case 'u2': return { steer: it.steer, go: on ? 0.6 : 0 };
    case 'u3': return { steer: autoSteer(car), go: on ? clamp((sig.jaw - 0.15) / 0.55, 0, 1) : 0 };
    case 'u4': {
      if (on && sig.pucker > 0.55) {
        if (!S.puckerUp && performance.now() - S.lastBoost > 1200) {
          car.boost = 1.0;
          S.lastBoost = performance.now();
          S.stats.puckers++;
          world?.fx({ boost: true });
        }
        S.puckerUp = true;
      } else if (sig.pucker < 0.3) S.puckerUp = false;
      return { steer: autoSteer(car), go: on ? 0.5 : 0 };
    }
  }
  return it;
}
// What the meters show for each race.
function bossPreview(level, it, sig) {
  if (level === 'gp') return it;
  if (!sig.face) return { steer: 0, go: 0 };
  if (level === 'a4') {
    const c = S.armRace.cmd || { l: sig.l, r: sig.r };
    return { steer: c.l === c.r ? 0 : c.l ? LEFT_ARM_STEER : -LEFT_ARM_STEER, go: c.l || c.r ? 1 : 0 };
  }
  if (level.startsWith('a')) return { steer: 0, go: sig.l || sig.r ? 1 : 0 };
  return {
    u1: { steer: 0, go: clamp((0.5 - sig.still) / 0.3, 0, 1) },
    u2: { steer: it.steer, go: 0.6 },
    u3: { steer: 0, go: clamp((sig.jaw - 0.15) / 0.55, 0, 1) },
    u4: { steer: 0, go: sig.pucker },
  }[level];
}
const GO_LABEL = { u1: 'Steady', u2: 'Auto', u3: 'Mouth', u4: 'Pucker', a1: 'Squeeze', a2: 'Hold', a3: 'Pump', a4: 'Arms' };
const raceTitle = (level) => (level === 'gp' ? GRAND_PRIX.name : `Boss race · ${levelName(level)}`);

function howTo() {
  if (S.level !== 'gp') {
    const u = UNITS[unitIndex(S.level)];
    if (S.mode === 'arms') return esc(u.boss.how) + (S.armManual || !armOnline() ? ' No sensor? Hold A and D, or the Left and Right buttons.' : '');
    return esc(u.boss.how) + (S.mode === 'touch' ? ' On touch: slide to steer, drag up for face moves.' : '');
  }
  if (S.mode === 'touch') return 'Hold a finger on the screen to go. Slide it left or right to steer.';
  return `To steer, <b>${esc(S.cal.steerLabel)}</b>. To go, <b>${esc(S.cal.goLabel)}</b>. Practise here while you wait.`;
}
function joinQueue() {
  send({ t: 'join', name: S.name, assist: S.assist, level: S.level });
}
function goWait() {
  S.phase = 'waiting';
  S.queued = true;
  $('wait-level').textContent = raceTitle(S.level);
  $('wait-howto').innerHTML = howTo();
  $('w-go-label').textContent = S.level !== 'gp' ? GO_LABEL[S.level] : S.mode === 'head' ? S.cal.goLabel : 'hold finger';
  const head = S.mode === 'head';
  $('cam-slot-wait').classList.toggle('hidden', !head);
  $('btn-recal').classList.toggle('hidden', !head);
  $('sens-choices').classList.toggle('hidden', !head || !(S.level === 'gp' || S.level === 'u2'));
  $('btn-local').classList.toggle('hidden', ARCADE);
  $('turn-text').textContent = S.mode === 'arms' ? 'Find the real car. Sit comfortably with the arm sensors on.' : 'Find the real car, then keep your face in view of the camera.';
  $('turn-hold-hint').textContent = S.mode === 'arms' ? 'Or squeeze an arm and hold it for a second.' : 'Or hold your GO move for a second.';
  $('wait-pos').textContent = 'Joining the line…';
  show('s-wait');
  scene(S.track, 'showcase', 0.62);
  world?.reset();
  joinQueue();
}
$('btn-recal').onclick = () => runCalibration(goWait); // keeps your place in line
$('btn-leave').onclick = () => {
  sendSure({ t: 'leave' });
  S.queued = false;
  goHome();
};
$('btn-local').onclick = () => {
  sendSure({ t: 'leave' });
  S.queued = false;
  startRace(S.level, { local: true });
};

$('btn-start').onclick = () => {
  if (S.phase === 'turn') {
    sendSure({ t: 'start' });
    startCountdownView();
  }
};

function startCountdownView() {
  S.phase = 'countdown';
  S.car = newCar(S.track);
  S.stats = { headMoves: 0, goMoves: 0, goHoldMs: 0, wallHits: 0, jumps: 0, puckers: 0, squeezes: 0, onMs: 0, steerUp: false, goUp: false };
  S.armRace = { win: S.tune.chord };
  S.puckerUp = false;
  S.lastBoost = 0;
  scene(S.track, 'chase', 0);
  world?.reset();
  world?.setCar(S.car);
  overlay(S.local ? '' : '3');
  show('s-race');
  $('hud-time').textContent = '0.0';
  $('hud-stars').textContent = `0/${S.track.stars.length}`;
  $('hud-name').textContent = `${S.level === 'gp' ? S.track.name : levelName(S.level)}${S.local ? (bleDriving() ? ' · real car' : ' · phone') : ''}${AUTOPILOT ? ' · autopilot' : ''}`;
  tellAutopilot();
  $('r-go-label').textContent = S.level === 'gp' ? 'Go' : GO_LABEL[S.level];
  $('r-steer-wrap').classList.toggle('hidden', !['gp', 'u2', 'a4'].includes(S.level)); // the other races steer themselves
  drawMinimapBase();
}

// ---------- Input ----------
for (const pad of [$('touch-pad'), $('touch-pad-lesson')]) {
  pad.addEventListener('pointerdown', (e) => {
    S.touch = { active: true, x0: e.clientX, x: e.clientX, y0: e.clientY, y: e.clientY };
    pad.setPointerCapture(e.pointerId);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!S.touch.active) return;
    S.touch.x = e.clientX;
    S.touch.y = e.clientY;
  });
  const end = () => (S.touch.active = false);
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
}
addEventListener('keydown', (e) => {
  if (e.target.matches?.('input')) return;
  S.keys.add(e.key);
});
addEventListener('keyup', (e) => S.keys.delete(e.key));
addEventListener('blur', () => S.keys.clear());

const SIG_KEYS = ['side', 'still', 'pitch', 'jaw', 'pucker', 'smile'];
// Per-exercise signals for lessons and boss races, smoothed so camera jitter doesn't flicker targets.
function readSignals() {
  if (S.mode === 'arms') return (S.sig = readArms());
  let s;
  if (S.mode === 'head') {
    s = S.cal && tracker.m && tracker.faceVisible
      ? toSignals(S.cal, tracker.m, S.profile?.ranges)
      : { side: 0, still: 0, pitch: 0, jaw: 0, pucker: 0, smile: 0, raw: { side: 0, jaw: 0, pucker: 0, smile: 0 }, axis: S.cal?.axis || 'yaw', face: false };
  } else {
    // Touch: slide sideways = head left/right, drag up = face moves.
    const t = S.touch;
    const side = t.active ? clamp((t.x - t.x0) / 110, -1.3, 1.3) : 0;
    const amt = t.active ? clamp((t.y0 - t.y) / 150, 0, 1.3) : 0;
    s = { side, still: Math.abs(side), pitch: 0, jaw: amt, pucker: amt, smile: amt, raw: { side: side * 0.3, jaw: amt * 0.5, pucker: amt * 0.5, smile: amt * 0.5 }, axis: 'yaw', face: true };
  }
  const k = S.keys; // laptop testing: arrows / WASD
  if (k.size) {
    const side = k.has('ArrowLeft') || k.has('a') ? -1 : k.has('ArrowRight') || k.has('d') ? 1 : 0;
    const amt = k.has('ArrowUp') || k.has('w') || k.has(' ') ? 1 : 0;
    Object.assign(s, { side, still: Math.abs(side), jaw: amt, pucker: amt, smile: amt, face: true });
    s.raw = { side: side * 0.3, jaw: amt * 0.5, pucker: amt * 0.5, smile: amt * 0.5 };
  }
  const prev = S.sig;
  if (prev?.face && s.face) {
    for (const key of SIG_KEYS) s[key] = prev[key] + (s[key] - prev[key]) * 0.4;
  }
  S.sig = s;
  return s;
}

function readIntent() {
  let steer = 0;
  let go = 0;
  let lost = false;
  if (S.mode === 'arms') {
    const a = S.sig || readArms();
    go = a.l || a.r ? 1 : 0;
    steer = a.l && !a.r ? -1 : a.r && !a.l ? 1 : 0;
    lost = !a.face;
  } else if (S.mode === 'head') {
    if (S.cal && tracker.m && tracker.faceVisible) ({ steer, go } = toIntent(S.cal, tracker.m, S.sens));
    else lost = true; // can't see the face: no gas
  } else if (S.touch.active) {
    go = 1;
    steer = clamp((S.touch.x - S.touch.x0) / 110, -1, 1);
  }
  // ?autopilot drives races by itself (testing the real car without head setup) until you take over.
  if (autopilotNow() && S.car && (S.phase === 'racing' || S.phase === 'countdown')) {
    steer = autoSteer(S.car);
    go = 0.85;
    lost = false;
  }
  const k = S.keys;
  if (k.size) {
    if (k.has('ArrowLeft') || k.has('a')) steer = -1;
    if (k.has('ArrowRight') || k.has('d')) steer = 1;
    if (k.has('ArrowUp') || k.has('w') || k.has(' ')) go = 1;
    lost = false;
  }
  // Steering is smoothed more than GO so small head wobbles don't jerk the car.
  S.intent.steer += (steer - S.intent.steer) * 0.25;
  S.intent.go += (go - S.intent.go) * 0.4;
  if (lost && S.mode === 'head') S.intent.go = 0;
  S.intent.lost = lost;
  return S.intent;
}

function setMeters(steerEl, goEl, it) {
  $(steerEl).style.left = `${50 + clamp(it.steer, -1, 1) * 44}%`;
  fillBar(goEl, it.go);
}

// ---------- Minimap of the current race course ----------
const mini = $('minimap');
const mctx = mini.getContext('2d');
let miniMap = null;
let miniBase = null;
function drawMinimapBase() {
  const t = S.track;
  miniMap = trackSvgPath(t, mini.width, mini.height, 16).map;
  miniBase = document.createElement('canvas');
  miniBase.width = mini.width;
  miniBase.height = mini.height;
  const g = miniBase.getContext('2d');
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const path = () => {
    g.beginPath();
    t.pts.forEach(([x, y], i) => {
      const [px, py] = miniMap(x, y);
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    });
    g.closePath();
  };
  g.strokeStyle = '#cfc5b3';
  g.lineWidth = 12;
  path();
  g.stroke();
  g.strokeStyle = '#fbf6ec';
  g.lineWidth = 7;
  path();
  g.stroke();
  const f = t.pointAt(t.finishAt);
  const [fx, fy] = miniMap(f.x, f.y);
  g.fillStyle = '#22303a';
  g.fillRect(fx - 5, fy - 5, 10, 10);
}
function drawMinimap(car) {
  if (!miniBase) return;
  mctx.clearRect(0, 0, mini.width, mini.height);
  mctx.drawImage(miniBase, 0, 0);
  S.track.stars.forEach((s, i) => {
    if (car.stars.includes(i)) return;
    const [x, y] = miniMap(s.x, s.y);
    mctx.fillStyle = '#f2a922';
    mctx.beginPath();
    mctx.arc(x, y, 3.4, 0, Math.PI * 2);
    mctx.fill();
  });
  const [cx, cy] = miniMap(car.x, car.y);
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.arc(cx, cy, 8, 0, Math.PI * 2);
  mctx.fill();
  mctx.fillStyle = '#f26a4b';
  mctx.beginPath();
  mctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  mctx.fill();
}

// ---------- Race ----------
function countStats(it, dt, ev) {
  const st = S.stats;
  const a = Math.abs(it.steer);
  if (!st.steerUp && a > 0.5) {
    st.steerUp = true;
    st.headMoves++;
  }
  if (st.steerUp && a < 0.2) st.steerUp = false;
  if (!st.goUp && it.go > 0.5) {
    st.goUp = true;
    st.goMoves++;
  }
  if (st.goUp && it.go < 0.2) st.goUp = false;
  if (it.go > 0.3) st.goHoldMs += dt * 1000;
  if (ev.launch) st.jumps++;
  if (ev.newHit) {
    st.wallHits++;
    if (navigator.vibrate) navigator.vibrate(40);
  }
  if (ev.land && navigator.vibrate) navigator.vibrate(60);
}

function raceStats() {
  const st = S.stats;
  const stats = { headMoves: st.headMoves, goMoves: st.goMoves, goHoldMs: Math.round(st.goHoldMs), wallHits: st.wallHits, jumps: st.jumps };
  if (S.level === 'u4') Object.assign(stats, { goMoves: st.puckers, goHoldMs: 0 });
  if (S.level.startsWith('a')) Object.assign(stats, { headMoves: 0, goMoves: st.squeezes, goHoldMs: Math.round(st.onMs) });
  return stats;
}

function raceFrame(dt, it, sig) {
  const car = S.car;
  const auto = autopilotNow();
  const face = auto || S.mode === 'touch' || sig.face;
  if (S.phase === 'racing') {
    // Grand Prix: your head steers and your GO move drives. Boss races use their unit's move.
    const ctl = S.level === 'gp' || auto ? it : bossControl(S.level, it, sig, car, dt);
    const ev = step(car, ctl.steer, ctl.go, dt, S.assist);
    countStats(ctl, dt, ev);
    world?.fx(ev);
    world?.setStars(car.stars);
    const elapsed = performance.now() - S.raceStart;
    $('hud-time').textContent = (elapsed / 1000).toFixed(1);
    $('hud-stars').textContent = `${car.stars.length}/${S.track.stars.length}`;
    if (!S.local && performance.now() - S.lastSend > 50) {
      S.lastSend = performance.now();
      send({
        t: 'state', x: car.x, y: car.y, z: car.z, h: car.h, v: car.v,
        cs: realSteer(car.steerOut), ct: car.throttleOut, stars: car.stars, air: car.air, boost: car.boost > 0,
      });
    }
    if (car.finished) {
      S.phase = 'done';
      const rawMs = Math.round(elapsed);
      overlay('Finish!');
      if (S.local) {
        showResult({ local: true, level: S.level, rawMs, stars: car.stars.length, finalMs: Math.max(0, rawMs - car.stars.length * STAR_BONUS_MS), stats: raceStats() });
      } else {
        sendFinish({ t: 'finish', rawMs, stars: car.stars.length, stats: raceStats() });
      }
    } else if (!face) {
      overlay(S.mode === 'arms' ? 'Arm sensor offline' : "Can't see your face", true);
    } else if ($('race-overlay').classList.contains('msg')) {
      overlay('');
    }
  }
  world?.setCar({ x: car.x, y: car.y, z: car.z, h: car.h, v: car.v, vz: car.vz, steer: car.steer, air: car.air, boost: car.boost });
  $('cam-slot-race').classList.toggle('lost', !face);
  setMeters('r-steer', 'r-go', bossPreview(S.level, it, sig));
  if (S.mode === 'arms') armLights('r-arms', sig);
  drawMinimap(car);
}

// The finish must reach the server to count: resend it until the result comes back.
function sendFinish(msg) {
  S.finish = msg;
  send(msg);
  let tries = 0;
  clearInterval(S.finishRetry);
  S.finishRetry = setInterval(() => (++tries > 5 ? finishUnsaved() : send(msg)), 2000);
}
function stopFinishRetry() {
  clearInterval(S.finishRetry);
  S.finish = null;
}
// The server never confirmed the finish: show the time anyway, marked as not saved.
function finishUnsaved() {
  const f = S.finish;
  stopFinishRetry();
  if (!f) return;
  showResult({ unsaved: true, level: S.level, rawMs: f.rawMs, stars: f.stars, finalMs: Math.max(0, f.rawMs - f.stars * STAR_BONUS_MS), stats: f.stats });
}

$('btn-stop').onclick = () => {
  if (!S.local) send({ t: 'stop' });
  endLocalRun('You stopped the run.');
};

function endLocalRun(message) {
  if (['setup', 'home', 'lesson', 'lessondone'].includes(S.phase)) return;
  clearTimeout(lostTimer);
  S.timers.forEach(clearTimeout);
  S.timers = [];
  if (S.phase === 'racing' && S.profile) {
    // Stopped races still count as practice time.
    addPractice(S.profile, localDay(), { ms: Math.min(150000, performance.now() - S.raceStart) });
    saveProfile();
  }
  S.phase = 'done';
  S.queued = false;
  overlay('');
  $('res-level').textContent = raceTitle(S.level);
  $('res-title').textContent = 'Run stopped';
  $('res-time').parentElement.classList.add('hidden');
  $('res-banner').classList.add('hidden');
  $('res-detail').textContent = message;
  $('res-stats').innerHTML = '';
  $('res-stats-title').classList.add('hidden');
  $('res-board').classList.add('hidden');
  $('res-board-title').classList.add('hidden');
  $('btn-again').innerHTML = '<span data-icon="play">Try again</span>';
  mountIcons($('btn-again'));
  show('s-result');
  scene(S.track, 'showcase', 0.6);
}

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const RESULT_ROWS = {
  u1: (st) => [['Time steady', sec(st.goHoldMs)], ['Wall bumps', st.wallHits]],
  u2: (st) => [['Head moves', st.headMoves], ['Wall bumps', st.wallHits]],
  u3: (st) => [['Mouth openings', st.goMoves], ['Mouth open', sec(st.goHoldMs)], ['Wall bumps', st.wallHits]],
  u4: (st) => [['Puckers', st.goMoves], ['Jumps', st.jumps ?? 0], ['Wall bumps', st.wallHits]],
  a1: (st) => [['Squeezes', st.goMoves], ['Time squeezing', sec(st.goHoldMs)], ['Wall bumps', st.wallHits]],
  a2: (st) => [['Time holding', sec(st.goHoldMs)], ['Squeezes', st.goMoves], ['Wall bumps', st.wallHits]],
  a3: (st) => [['Squeezes', st.goMoves], ['Jumps', st.jumps ?? 0], ['Wall bumps', st.wallHits]],
  a4: (st) => [['Squeezes', st.goMoves], ['Time squeezing', sec(st.goHoldMs)], ['Wall bumps', st.wallHits]],
};

function showResult(r) {
  S.phase = 'done';
  const level = r.level || 'gp';
  const prevBest = S.profile?.bosses[level]?.bestMs;
  const ms = level === 'gp' ? r.finalMs : r.rawMs;
  const out = S.profile && !ARCADE ? withAwards(() => recordBoss(S.profile, level, { ms: r.rawMs, finished: true }, localDay())) : { xp: 0 };
  if (S.profile && level === 'gp') {
    const b = (S.profile.bosses.gp ||= { cleared: false, bestMs: null });
    b.bestMs = b.bestMs == null ? ms : Math.min(b.bestMs, ms);
  }
  if (S.profile) saveProfile();
  if (r.local && S.profile) sendSure({ t: 'practice', kind: 'race', local: true, name: S.profile.name, unit: level, xp: out.xp, ms: r.rawMs });
  const pb = prevBest != null && ms < prevBest;
  S.timers.push(setTimeout(() => {
    overlay('');
    $('res-level').textContent = `${raceTitle(level)}${r.local ? ' · on this phone' : ''}`;
    $('res-time').textContent = fmt(r.finalMs);
    $('res-time').parentElement.classList.remove('hidden');
    let banner;
    let icon = 'flag';
    if (level !== 'gp') {
      $('res-title').textContent = out.firstClear ? 'Boss cleared!' : `${levelName(level)} done`;
      icon = 'star';
      banner = out.nextUp ? `Next unit on the path: ${out.nextUp}` : pb ? `New best, ${fmt(prevBest - ms)} faster` : out.firstClear ? 'Every unit cleared!' : 'Nice driving';
    } else if (r.local) {
      $('res-title').textContent = 'Finished';
      banner = pb ? `New personal best, ${fmt(prevBest - ms)} faster` : 'Phone runs stay off the leaderboard';
      icon = pb ? 'star' : 'phone';
    } else if (r.unsaved) {
      $('res-title').textContent = 'Finished';
      banner = "The connection dropped at the finish, so this time isn't on the leaderboard";
      icon = 'wifi';
    } else {
      $('res-title').textContent = 'Finished';
      icon = r.personalBest ? 'star' : 'flag';
      banner = r.personalBest
        ? r.prevBestMs ? `New personal best, ${fmt(r.prevBestMs - r.finalMs)} faster` : 'Your first time on the board'
        : `Your best is still ${fmt(r.prevBestMs)}`;
    }
    $('res-banner').innerHTML = `${iconSvg(icon)}<span>${esc(banner)}</span>`;
    $('res-banner').classList.remove('hidden');
    const xpText = out.xp ? ` +${out.xp} XP.` : '';
    const goalText = out.goalJustMet ? ' Daily goal done!' : '';
    $('res-detail').textContent = level === 'gp'
      ? `Drive time ${fmt(r.rawMs)}, minus ${r.stars} star${r.stars === 1 ? '' : 's'} × ${STAR_BONUS_MS / 1000} s.${r.rank ? ` You're #${r.rank} on the leaderboard.` : ''}${xpText}${goalText}`
      : `Drive time ${fmt(r.rawMs)}. Stars took ${r.stars * (STAR_BONUS_MS / 1000)} s off.${xpText}${goalText}`;
    const st = r.stats || {};
    const rows = RESULT_ROWS[level]?.(st) ?? (S.mode === 'head'
      ? [['Head moves', st.headMoves], [`${capital(S.cal?.goLabel || 'GO move')} reps`, st.goMoves], ['GO held', sec(st.goHoldMs)], ['Jumps', st.jumps ?? 0], ['Wall bumps', st.wallHits]]
      : [['Big steers', st.headMoves], ['Go presses', st.goMoves], ['Go held', sec(st.goHoldMs)], ['Jumps', st.jumps ?? 0], ['Wall bumps', st.wallHits]]);
    $('res-stats').innerHTML = [['Stars', `${r.stars}/${S.track.stars.length}`], ...rows].map(([l, v]) => `<div><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('');
    $('res-stats-title').classList.remove('hidden');
    $('btn-again').innerHTML = `<span data-icon="play">${r.local ? 'Race again on this phone' : 'Race again'}</span>`;
    mountIcons($('btn-again'));
    if (ARCADE) renderBoard($('res-board'), S.board.fastest.slice(0, 5), S.name);
    $('res-board').classList.toggle('hidden', !ARCADE);
    $('res-board-title').classList.toggle('hidden', !ARCADE);
    show('s-result');
    scene(S.track, 'showcase', 0.62);
    $('s-result').querySelector('.sheet').scrollTop = 0;
    if (out.goalJustMet) toast('Daily goal done!', { icon: 'flame', kind: 'gold' });
  }, 1000)); // let the finish moment land before the sheet comes up
}

$('btn-again').onclick = () => startRace(S.level, { local: S.local });
$('btn-res-path').onclick = goHome;

// ---------- Arcade ----------
function renderBoard(el, rows, me = '') {
  const key = me.toLowerCase();
  el.innerHTML = rows.length
    ? rows.map((r, i) => {
        const tag = r.assist ? `<span class="tag">${esc(ASSIST[r.assist]?.name ?? '')}</span>` : '';
        const cls = [i === 0 ? 'first' : '', key && r.name.toLowerCase() === key ? 'me' : ''].join(' ').trim();
        return `<li class="${cls}"><span class="n">${i + 1}</span><span class="who">${esc(r.name)}${tag}</span><span class="t">${fmt(r.ms)}</span></li>`;
      }).join('')
    : '<li class="empty">No times yet. Be the first.</li>';
}
// First screen: show the time to beat on the Arcade card.
function renderChooser() {
  const top = S.board.fastest[0];
  $('c-top').textContent = top ? `Time to beat: ${top.name}, ${fmt(top.ms)}` : '';
  $('c-top').classList.toggle('hidden', !top);
}
function renderArcadeCar() {
  $('a-car').textContent = S.carOnline ? 'The real car is connected and drives with you.' : 'The real car is offline, so races run on screen.';
}
function renderArcade() {
  renderBoard($('a-fastest'), S.board.fastest);
  $('a-improved').innerHTML = S.board.improved.length
    ? S.board.improved.map((r, i) => `<li><span class="n">${i + 1}</span><span class="who">${esc(r.name)}</span><span class="t">−${fmt(r.gainMs)}</span></li>`).join('')
    : '<li class="empty">Race twice to show up here.</li>';
  renderArcadeCar();
}
// Home in the arcade is "next player": nothing from the last person is kept.
function arcadeHome() {
  if (S.queued) sendSure({ t: 'leave' });
  S.queued = false;
  S.local = false;
  S.phase = 'home';
  S.timers.forEach(clearTimeout);
  S.timers = [];
  overlay('');
  S.name = '';
  S.profile = null;
  S.cal = null;
  S.mode = 'head';
  $('a-name').value = '';
  $('a-error').classList.add('hidden');
  renderArcade();
  show('s-arcade');
  scene(raceTrack('gp'), 'preview', 0.64);
  world?.reset();
}
$('btn-a-play').onclick = () => {
  const name = $('a-name').value.replace(/\s+/g, ' ').trim();
  if (!name) {
    $('a-error').textContent = 'Type a name for the leaderboard.';
    $('a-error').classList.remove('hidden');
    $('a-name').focus();
    return;
  }
  S.name = name;
  S.profile = { ...newProfile(name, localDay()), name }; // throwaway: never saved
  S.assist = 0; // the arcade is always no help, so every time on the board is comparable
  S.mode = 'head';
  S.cal = null;
  if (tracker.lm) return runCalibration(afterSetup); // camera already on from the last player
  show('s-camera');
};
$('a-name').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-a-play').click());
if (ARCADE) {
  $('btn-res-path').innerHTML = '<span data-icon="people">Next player</span>';
  mountIcons($('btn-res-path'));
  document.title = 'RC-Rehab Arcade';
}

// ---------- Menu: progress, achievements, settings, about ----------
function openMenu(tab = 'progress') {
  if (!S.profile) return;
  renderMenu();
  setTab(tab);
  show('s-menu');
}
function setTab(tab) {
  document.querySelectorAll('#s-menu .tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('#s-menu .tab-body').forEach((b) => b.classList.toggle('active', b.dataset.body === tab));
  $('s-menu').querySelector('.sheet').scrollTop = 0;
}
document.querySelector('#s-menu .tabs').onclick = (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
};
$('btn-menu-close').onclick = goHome;

function renderMenu() {
  const p = S.profile;
  if (!p) return;
  const day = localDay();
  const lv = xpLevel(p.xp);
  const days = Object.values(p.days || {});
  const total = (f) => days.reduce((a, d) => a + (f(d) || 0), 0);
  const pp = pathProgress(p, PATHID);
  const wv = weekView(p, day);
  const units = unitsOf(PATHID);
  const tiles = [
    ['bolt', `Level ${lv.level}`, 'Player level', `${p.xp} XP · ${lv.to - p.xp} to go`],
    ['clock', fmtMin(total((d) => d.ms) / 60000), 'Minutes practised', `on ${days.filter((d) => d.ms > 0).length} day${days.filter((d) => d.ms > 0).length === 1 ? '' : 's'}`],
    ['gate', total((d) => d.good), 'Gates opened', `${total((d) => d.reps)} reps in all`],
    ['map', `${pp.done}/${pp.total}`, 'Stops done', `${pp.gold} gold`],
    ['flame', `${wv.streak} wk`, 'Week streak', `${wv.count} of ${wv.target} days this week`],
    ['car', units.filter(({ u }) => p.bosses[u.id]?.cleared).length, 'Bosses cleared', `of ${units.length}`],
  ];
  $('m-tiles').innerHTML = tiles.map(([ic, b, s, sm]) => `<div class="tile">${iconSvg(ic)}<span>${esc(s)}</span><b>${esc(b)}</b><small>${esc(sm)}</small></div>`).join('');

  // The last 14 days
  const list = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(day, i - 13);
    const e = p.days[d];
    return { d, min: (e?.ms || 0) / 60000, met: !!e?.goalMet, today: d === day };
  });
  const top = Math.max(p.goalMin * 1.25, ...list.map((x) => x.min));
  const H = 90;
  $('m-chart').innerHTML = list.map((x) => `<div class="col${x.met ? ' met' : ''}${x.today ? ' today' : ''}" title="${x.d}: ${fmtMin(x.min)} min"><i style="height:${Math.max(3, (x.min / top) * H).toFixed(1)}px"></i><span>${'MTWTFSS'[(new Date(`${x.d}T12:00:00`).getDay() + 6) % 7]}</span></div>`).join('')
    + `<div class="goal" style="--y:${((p.goalMin / top) * H).toFixed(1)}px" aria-hidden="true"><span>${p.goalMin} min</span></div>`;
  $('m-chart-note').textContent = `Minutes per day for the last two weeks. Green bars hit your ${p.goalMin}-minute goal.`;

  const rows = rangeRows(p);
  $('m-ranges').innerHTML = ARMS
    ? '<p class="hint">The arm sensors only say on or off, so the arm path tracks your scores, hold times and reaction times instead of a range.</p>'
    : rows.length
    ? rows.map((r) => `<div class="range"><span>${esc(r.label)}</span><div class="bar"><i style="width:100%"></i><em style="left:${(r.frac * 100).toFixed(1)}%"></em></div><small>${esc(r.text)}</small></div>`).join('')
      + '<p class="hint">The dark mark is day 1. The bar is your best since.</p>'
    : '<p class="hint">Play a "Find it" lesson to measure your range. Come back another day to see it grow.</p>';

  $('m-mastery').innerHTML = units.map(({ u, ui }) => {
    const L = lessonsOf(p, u.id);
    const b = p.bosses[u.id];
    return `<div class="m-unit ${cc(ui)}"><h4><span class="region-num">${unitNo(ui)}</span>${esc(u.title)}</h4>${L.map((l, li) => {
      const max = knobFor(u.id, lessonInfo(ui, li).key).max;
      const pips = Array.from({ length: max + 1 }, (_, k) => `<i class="${k <= l.level && l.plays ? 'on' : ''}"></i>`).join('');
      const state = isGold(l) ? ' · gold' : '';
      return `<div class="m-row"><span><b>${lessonInfo(ui, li).title}</b><small>${l.plays ? `last ${Math.round((l.lastRate || 0) * 10)}/10${state}` : 'not played'}</small></span><span class="lv" title="Level ${l.level + 1} of ${max + 1}">${pips}</span><span class="lvn">Lv ${l.level + 1}</span></div>`;
    }).join('')}<div class="m-row boss"><span><b>Boss: ${esc(u.boss.name)}</b><small>${b?.cleared ? 'cleared' : 'not cleared yet'}</small></span><span></span><span class="lvn">${b?.bestMs ? fmt(b.bestMs) : ''}</span></div></div>`;
  }).join('');

  const aw = achievements(p, day);
  $('m-awards-count').textContent = `${aw.filter((a) => a.done).length} of ${aw.length} earned`;
  $('m-awards').innerHTML = aw.map((a) => `<li class="award${a.done ? ' done' : ''}"><span class="medal">${iconSvg(a.done ? 'medal' : 'lock')}</span><div><b>${esc(a.title)}</b><p>${esc(a.what)}</p><div class="prog"><div class="bar"><i style="width:${((a.have / a.need) * 100).toFixed(1)}%"></i></div><small>${a.have}/${a.need}</small></div></div></li>`).join('');

  $('m-controls').textContent = S.mode === 'arms'
    ? S.armManual ? 'You use the A and D keys, or the on-screen Left and Right buttons.' : `You use the arm sensors${S.armSwap ? ', with left and right swapped' : ''}.`
    : S.mode === 'head'
    ? S.cal ? `You use the camera. You ${S.cal.steerLabel} to steer and ${S.cal.goLabel} to go.` : 'You use the camera. Head setup is not done yet.'
    : 'You use touch. Slide sideways for left and right, and drag up for face moves.';
  $('btn-m-controls').innerHTML = S.mode === 'arms' ? '<span data-icon="arm">Sensors and car</span>' : `<span data-icon="${S.mode === 'head' ? 'hand' : 'camera'}">${S.mode === 'head' ? 'Use touch instead' : 'Use the camera'}</span>`;
  $('btn-m-recal').classList.toggle('hidden', S.mode !== 'head');
  mountIcons($('s-menu'));
}
$('btn-m-recal').onclick = () => (tracker.lm ? runCalibration(goHome) : show('s-camera'));
$('btn-m-controls').onclick = () => {
  if (S.mode === 'arms') return openArmCheck();
  if (S.mode === 'head') {
    S.mode = 'touch';
    toast('Touch controls on', { icon: 'hand' });
    goHome();
  } else {
    show('s-camera');
  }
};
$('btn-m-name').onclick = () => {
  S.phase = 'setup';
  show('s-name');
  scene(raceTrack('gp'), 'showcase', 0.55);
};

// ---------- Arm path: the two biceps sensors, or keys and buttons instead ----------
// The sensors only say "flexing or not" for each arm. A and D (or ← and →) and the on-screen
// Left/Right lights work too, for testing or when there's no sensor.
// Sensors: the MuscleCar board over Bluetooth first, else a WiFi sensor board through the server.
const armOnline = () => mc.ready || S.emg.online;
function readArms() {
  const ble = mc.ready;
  const e = ble ? { l: mc.flex[0], r: mc.flex[1], online: true } : S.emg;
  const k = S.keys;
  const kl = k.has('a') || k.has('A') || k.has('ArrowLeft') || S.armBtn.l;
  const kr = k.has('d') || k.has('D') || k.has('ArrowRight') || S.armBtn.r;
  if ((kl || kr) && !e.online) S.armManual = true;
  const sl = e.online && !!(S.armSwap ? e.r : e.l);
  const sr = e.online && !!(S.armSwap ? e.l : e.r);
  return { l: sl || kl, r: sr || kr, face: e.online || S.armManual };
}
// Light up each arm; want = { l: 'on' | 'off' | null, r } marks what the exercise asks for.
function armLights(id, sig, want = null) {
  for (const b of $(id).children) {
    const side = b.dataset.side;
    const cls = ['arm-light', sig[side] && 'on', want?.[side] && `want-${want[side]}`].filter(Boolean).join(' ');
    if (b.className !== cls) b.className = cls;
  }
}
document.querySelectorAll('.arm-lights').forEach((box) =>
  box.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    e.preventDefault();
    b.setPointerCapture?.(e.pointerId);
    const side = b.dataset.side;
    S.armBtn[side] = true;
    const up = () => {
      S.armBtn[side] = false;
      b.removeEventListener('pointerup', up);
      b.removeEventListener('pointercancel', up);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }),
);

const ARM_STEPS = [
  { key: 'l', text: 'Squeeze your left arm', ok: (s) => s.l && !s.r, ms: 400 },
  { key: 'r', text: 'Squeeze your right arm', ok: (s) => s.r && !s.l, ms: 400 },
  { key: 'relax', text: 'Relax both arms for a second', ok: (s) => !s.l && !s.r, ms: 1000 },
];
function openArmCheck(next = goHome) {
  S.armCheck = { step: 0, t: 0, done: false, next, online: null };
  S.phase = 'armcheck';
  $('ac-swap').checked = S.armSwap;
  renderArmStatus();
  renderArmCheck();
  show('s-arms');
  scene(raceTrack('a4'), 'showcase', 0.55);
  world?.reset();
}
function renderArmStatus() {
  S.armCheck.online = armOnline();
  $('ac-status').innerHTML = armOnline()
    ? `<span class="lamp on"></span>Arm sensors working${mc.ready ? ' (Bluetooth)' : ' (WiFi)'}`
    : mc.connected && !mc.calibrated
    ? '<span class="lamp"></span>Calibrate the sensors to use them.'
    : '<span class="lamp"></span>Waiting for the arm sensors. Connect MuscleCar, or use the keys or buttons.';
  renderMc();
}
function renderArmCheck() {
  const c = S.armCheck;
  $('ac-steps').innerHTML = ARM_STEPS.map((st, i) => `<li class="${i < c.step ? 'done' : i === c.step ? 'now' : ''}">${esc(st.text)}</li>`).join('');
  $('btn-ac-go').innerHTML = `<span data-icon="${c.done ? 'check' : 'right'}">${c.done ? 'Sensors ready: continue' : 'Skip the check'}</span>`;
  $('btn-ac-go').className = `btn ${c.done ? 'primary' : 'quiet'}`;
  mountIcons($('btn-ac-go'));
}
function armCheckFrame(sig, dt) {
  const c = S.armCheck;
  if (c.online !== armOnline()) renderArmStatus();
  liveMc();
  $('btn-ac-race').disabled = mcBusy || !mc.ready || !S.tune.follow || !c.done;
  const st = ARM_STEPS[c.step];
  if (st && st.ok(sig)) {
    c.t += dt * 1000;
    if (c.t >= st.ms) {
      c.step++;
      c.t = 0;
      if (c.step === ARM_STEPS.length) {
        c.done = true;
        toast('Both arms found', { icon: 'check' });
      }
      renderArmCheck();
    }
  } else c.t = 0;
  const want = !st ? null : st.key === 'relax' ? { l: 'off', r: 'off' } : { [st.key]: 'on' };
  armLights('ac-arms', sig, want);
}
const leaveArmCheck = () => {
  const next = S.armCheck?.next || goHome;
  if (S.armCheck) S.armCheck.done = true;
  next();
};
$('btn-ac-go').onclick = leaveArmCheck;
$('btn-ac-race').onclick = () => {
  if (mcBusy || !mc.ready || !S.armCheck?.done || !S.tune.follow) return;
  startRace('a4', { local: true });
};
$('btn-ac-keys').onclick = () => {
  S.armManual = true;
  toast('Keys and buttons on: hold A or D, or the Left and Right lights', { icon: 'hand' });
  leaveArmCheck();
};
$('ac-swap').onchange = (e) => {
  S.armSwap = e.target.checked;
  store.set('rc-arm-swap', S.armSwap ? '1' : '0');
};
// ---------- The real car over Bluetooth (MuscleCar) ----------
// Each bicep presses the forward button for its side.
const bleDriving = () => ARMS && mc.connected && S.tune.follow && S.local;
function mirrorRealCar() {
  const racing = bleDriving() && S.phase === 'racing';
  const lesson = ARMS && S.tune.follow && S.phase === 'lesson' && !S.lesson?.finishing;
  if (!mc.ready || !(racing || lesson || S.phase === 'demo')) return setWheels(false, false);
  const [l, r] = mc.flex;
  if (S.armSwap !== S.tune.swapWheels) setWheels(r, l);
  else setWheels(l, r);
}
const saveTune = () => store.set('rc-car-tune', JSON.stringify(S.tune));
const mcHelp = (text) => ($('mc-help').textContent = text);
let mcBusy = false;
let mcLiveAt = 0;
function mcStatusHtml() {
  if (!mc.supported) return '<span class="lamp"></span>No Bluetooth in this browser. Use Chrome or Edge.';
  if (!mc.connected) return '<span class="lamp"></span>MuscleCar not connected';
  if (!mc.online) return '<span class="lamp"></span>MuscleCar connected, waiting for readings…';
  return `<span class="lamp on"></span>${esc(mc.name)} · left ${mc.adc[0]} · right ${mc.adc[1]}${mc.calibrated ? '' : ' · not calibrated'}`;
}
function renderMc() {
  $('mc-status').innerHTML = mcStatusHtml();
  $('btn-mc-connect').innerHTML = `<span data-icon="arm">${mc.connected ? 'Disconnect' : 'Connect MuscleCar'}</span>`;
  $('btn-mc-connect').disabled = !mc.supported || mcBusy;
  $('mc-cutoff').value = mc.cutoff;
  $('mc-cutoff').disabled = mcBusy;
  $('btn-mc-cal').classList.toggle('hidden', !mc.connected || mc.cutoff !== 'adaptive');
  $('btn-mc-cal').disabled = mcBusy;
  $('btn-mc-cal').innerHTML = `<span>${mc.calibrated ? 'Calibrate again' : 'Calibrate'}</span>`;
  $('mc-car').classList.toggle('hidden', !mc.connected);
  const t = S.tune;
  $('mc-follow').checked = t.follow;
  $('mc-chord').value = Math.round(t.chord * 1000);
  $('mc-chord-v').textContent = `${Math.round(t.chord * 1000)} ms`;
  $('mc-swapw').checked = t.swapWheels;
  mountIcons($('btn-mc-connect'));
}
// Live readings on the sensor screen, a few times a second.
function liveMc() {
  const now = performance.now();
  if (now - mcLiveAt < 200) return;
  mcLiveAt = now;
  $('mc-status').innerHTML = mcStatusHtml();
}
onMc(() => {
  if (!mc.connected) toast('MuscleCar disconnected', { icon: 'arm' });
  if (S.phase === 'armcheck') renderArmStatus();
  if ($('s-stop').classList.contains('active') && S.stop) renderStopActions();
});
$('btn-mc-connect').onclick = async () => {
  if (mc.connected) return mcDisconnect();
  mcBusy = true;
  renderMc();
  try {
    await mcConnect();
    toast('MuscleCar connected', { icon: 'arm' });
    $('mc-car').open = true;
    mcHelp(mc.cutoff !== 'adaptive' ? cutoffHint() : mc.calibrated ? 'Using your last calibration. Calibrate again if the pads moved.' : 'Next: calibrate, so it knows your relaxed and squeezing levels.');
  } catch (e) {
    mcHelp(e.name === 'NotFoundError' ? 'No board chosen. Turn MuscleCar on and try again.' : e.message);
  }
  mcBusy = false;
  if (S.armCheck) renderArmStatus();
  if (mc.connected && !mc.calibrated) runMcCalibration();
};
// Relax both (2 s), squeeze left (2 s), squeeze right (2 s). Thresholds sit between the levels.
async function runMcCalibration() {
  if (mcBusy || !mc.connected) return;
  mcBusy = true;
  for (let i = 0; i < 30 && !mc.online; i++) await wait(100); // just connected: first readings
  renderMc();
  const steps = ['Relax both arms', 'Squeeze your LEFT arm and keep squeezing', 'Squeeze your RIGHT arm and keep squeezing'];
  const got = [];
  try {
    for (const text of steps) {
      mcHelp(`${text}…`);
      await wait(1000);
      got.push(await mcRecord(2000));
    }
    const [rest, left, right] = got;
    const bad = S.armSwap ? mcCalibrate(rest, right, left) : mcCalibrate(rest, left, right);
    if (bad) {
      const side = (k) => (S.armSwap ? { left: 'right', right: 'left' }[k] : k);
      mcHelp(`Not saved. ${Object.entries(bad).filter(([, v]) => v).map(([k, v]) => `${capital(side(k))} arm: ${v}.`).join(' ')} Check the pads and calibrate again.`);
    } else {
      mcHelp('Calibrated. Check each arm lights up below.');
      toast('Sensors calibrated', { icon: 'check' });
      if (S.armCheck) Object.assign(S.armCheck, { step: 0, t: 0, done: false });
    }
  } catch (e) {
    mcHelp(e.message);
  }
  mcBusy = false;
  if (S.armCheck) {
    renderArmStatus();
    renderArmCheck();
  }
}
function cutoffHint() {
  return 'Both arms: flex at ' + mc.cutoff + ', release at ' + (Number(mc.cutoff) - 50) + '.';
}
$('mc-cutoff').onchange = (e) => {
  selectCutoff(e.target.value);
  if (S.armCheck) Object.assign(S.armCheck, {step: 0, t: 0, done: false});
  mcHelp(mc.cutoff === 'adaptive' ? 'Capture rest and flex with Calibrate.' : cutoffHint());
  renderArmStatus();
  renderArmCheck();
};
$('btn-mc-cal').onclick = runMcCalibration;
$('mc-follow').onchange = (e) => {
  S.tune.follow = e.target.checked;
  saveTune();
};
$('mc-swapw').onchange = (e) => {
  S.tune.swapWheels = e.target.checked;
  saveTune();
};
$('mc-chord').oninput = (e) => {
  S.tune.chord = Number(e.target.value) / 1000;
  saveTune();
  renderMc();
};
document.querySelector('.mc-tests').addEventListener('click', (e) => {
  const b = e.target.closest('[data-test]');
  if (!b || !mc.connected) return;
  if (b.dataset.test === 'direct') {
    const note = $('mc-test-note');
    note.textContent = 'Sending forward to both wheels…';
    testWheels(1, 1, 500, message => { note.textContent = message; });
  } else {
    const direction = b.dataset.test;
    const l = direction !== 'left', r = direction !== 'right';
    testWheels(S.tune.swapWheels ? r : l, S.tune.swapWheels ? l : r, direction === 'fwd' ? 1000 : 500);
  }
});

// ---------- Demo mode: no game, the arms drive the real car directly ----------
// Both arms = forward,
// left arm = turn right, right arm = turn left, relaxed = stop.
const DEMO_DIR = { fwd: 'Forward', right: 'Turning right', left: 'Turning left', none: 'Stopped' };
let demoTextAt = 0;
function openDemo() {
  S.timers.forEach(clearTimeout);
  S.timers = [];
  S.phase = 'demo';
  S.demo = { dir: '' };
  show('s-demo');
  demoText();
}
function leaveDemo() {
  S.demo = null;
  if (S.profile) return goHome();
  S.phase = 'setup';
  show('s-name');
}
function demoFrame(sig) {
  const d = S.demo;
  const dir = sig.face ? armDir(sig) : 'none';
  if (dir !== d.dir) {
    d.dir = dir;
    $('dm-dir').textContent = DEMO_DIR[dir];
    $('dm-dir').classList.toggle('go', dir !== 'none');
  }
  armLights('dm-arms', sig);
  if (performance.now() - demoTextAt > 200) demoText();
}
function demoText() {
  demoTextAt = performance.now();
  const w = mc.out;
  $('dm-status').innerHTML = !mc.connected
    ? `<span class="lamp"></span>MuscleCar not connected${S.emg.online ? ' · WiFi arm sensors working' : ''}`
    : !mc.online ? '<span class="lamp"></span>MuscleCar connected, waiting for readings…'
    : !mc.calibrated ? '<span class="lamp"></span>MuscleCar connected · calibrate it in the settings'
    : `<span class="lamp on"></span>MuscleCar · left ${mc.adc[0]} · right ${mc.adc[1]}`;
  $('dm-power').textContent = mc.connected
    ? `Left wheels ${w.l ? "on" : "off"} · right wheels ${w.r ? "on" : "off"}`
    : 'No car connected: nothing is sent';
  $('btn-dm-connect').classList.toggle('hidden', mc.connected || !mc.supported);
}
$('btn-dm-exit').onclick = leaveDemo;
$('btn-dm-setup').onclick = () => openArmCheck(openDemo);
$('btn-dm-connect').onclick = async () => {
  try {
    await mcConnect();
    toast('MuscleCar connected', { icon: 'arm' });
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message, { icon: 'info' });
  }
  demoText();
  if (mc.connected && !mc.calibrated) {
    openArmCheck(openDemo);
    runMcCalibration();
  }
};
$('btn-demo').onclick = openDemo;
$('btn-name-demo').onclick = openDemo;
$('btn-ac-demo').onclick = openDemo;

if (ARMS) {
  for (const id of ['btn-demo', 'btn-name-demo']) $(id).classList.remove('hidden');
  document.title = 'RC-Rehab · Arm path';
  $('name-hand').textContent = 'arm path';
  $('name-intro').textContent = 'Biceps exercises with two muscle sensors that see whether each arm is flexing. Every lesson is its own little course: open each gate by squeezing or relaxing on cue, then drive on to the finish line.';
}

// ---------- Main loop ----------
let last = performance.now();
let worldAcc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (S.mode === 'head') tracker.update();
  const sig = readSignals();
  const it = readIntent();
  const inRace = S.car && (S.phase === 'countdown' || S.phase === 'racing' || (S.phase === 'done' && $('s-race').classList.contains('active')));
  const inLesson = S.phase === 'lesson';

  if (S.phase === 'waiting') {
    setMeters('w-steer', 'w-go', bossPreview(S.level, it, sig));
    badge('wait-badge');
  } else if (S.phase === 'setup') {
    badge('cal-badge');
  } else if (S.phase === 'turn') {
    const left = Math.max(0, S.claimEnds - now);
    $('turn-timer').textContent = `${Math.ceil(left / 1000)} s left to start`;
    if (it.go > 0.5 && !S.holdStart) S.holdStart = now;
    if (it.go < 0.3) S.holdStart = 0;
    const held = S.holdStart ? (now - S.holdStart) / 1000 : 0;
    fillBar('turn-hold', held);
    if (held >= 1) $('btn-start').onclick();
  }
  if (S.phase === 'armcheck') armCheckFrame(sig, dt);
  else if (S.phase === 'demo') demoFrame(sig);
  else if (S.phase === 'waiting' && S.mode === 'arms') armLights('w-arms', sig);
  if (inRace) raceFrame(dt, it, sig);
  if (inLesson) lessonFrame(dt, sig);
  if (mc.connected) mirrorRealCar();

  // Menus render the world at ~30 fps to leave room for face tracking.
  worldAcc += dt;
  if (world && (inRace || inLesson || worldAcc > 1 / 30)) {
    world.frame(inRace || inLesson ? dt : worldAcc);
    worldAcc = 0;
  }
  requestAnimationFrame(frame);
}

function badge(id) {
  const el = $(id);
  const ok = S.mode !== 'head' || tracker.faceVisible;
  const want = ok ? 'face' : 'search';
  if (el.dataset.icon !== want) {
    el.dataset.icon = want;
    el.textContent = ok ? 'Face found' : 'Looking for you';
    el.className = `badge${ok ? '' : ' lost'}`;
    delete el.dataset.mounted;
    mountIcons(el.parentElement);
  }
}
requestAnimationFrame(frame);

// ---------- Keep the screen on ----------
async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.phase !== 'setup') keepAwake();
});

if (ARCADE) arcadeHome();
else if (ARMS && new URLSearchParams(location.search).has('demo')) openDemo();
else if (PATH || ARMS) show('s-name');
connect();
