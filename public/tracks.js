// Every course in the game, as pure geometry shared by the phone, the big screen, the
// server and the tests:
//  - the Grand Prix,
//  - one boss race per unit,
//  - one lesson course per unit and lesson type (20 in all). A lesson course has one gate
//    per rep: the car stops at each gate, the rep opens it, and the lesson ends at the
//    finish line.
// Centrelines are smooth curves sampled every STEP units, so the 3D road has no corners.

export const STEP = 12;
export const GATE_STOP = 90; // in lessons the car waits this far before a gate
const rad = (d) => (d * Math.PI) / 180;

// ---------- Curves ----------
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Centripetal Catmull-Rom through control points (no loops or cusps on uneven spacing).
function catmull(ctrl) {
  const n = ctrl.length;
  const ext = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const P = [ext(ctrl[0], ctrl[1]), ...ctrl, ext(ctrl[n - 1], ctrl[n - 2])];
  const out = [];
  for (let i = 0; i < P.length - 3; i++) {
    const [p0, p1, p2, p3] = [P[i], P[i + 1], P[i + 2], P[i + 3]];
    const tj = (t, a, b) => t + Math.max(1e-3, Math.sqrt(dist(a, b)));
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    const steps = Math.max(4, Math.ceil(dist(p1, p2) / 3));
    for (let k = 0; k < steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const lerp = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const A1 = lerp(p0, p1, t0, t1);
      const A2 = lerp(p1, p2, t1, t2);
      const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2);
      const B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  out.push(ctrl[n - 1]);
  return out;
}

// A course built from pieces: { len, turn (degrees over the piece), mark? }.
// Returns the dense polyline and the distance at which each marked piece starts.
function turtle(pieces, h0 = -Math.PI / 2) {
  let x = 0;
  let y = 0;
  let h = h0;
  let d = 0;
  const out = [[x, y]];
  const marks = [];
  for (const p of pieces) {
    if (p.mark) marks.push({ mark: p.mark, at: d, len: p.len });
    const n = Math.max(1, Math.ceil(p.len / 3));
    const ds = p.len / n;
    const dh = rad(p.turn || 0) / n;
    for (let k = 0; k < n; k++) {
      h += dh / 2;
      x += Math.cos(h) * ds;
      y += Math.sin(h) * ds;
      h += dh / 2;
      d += ds;
      out.push([x, y]);
    }
  }
  return { pts: out, marks };
}

function resample(dense, step = STEP) {
  const out = [dense[0]];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i];
    const len = dist(a, b);
    let t = step - carry;
    while (t <= len) {
      out.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  const last = dense[dense.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

// ---------- Track object ----------
function build(def, pts) {
  const segs = [];
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len = Math.max(1e-6, Math.hypot(bx - ax, by - ay));
    segs.push({ ax, ay, ux: (bx - ax) / len, uy: (by - ay) / len, len, cum });
    cum += len;
  }
  const length = cum;
  const width = def.width || 120;

  const segAt = (d) => {
    let i = Math.min(segs.length - 1, Math.max(0, Math.floor(d / STEP)));
    while (i > 0 && segs[i].cum > d) i--;
    while (i < segs.length - 1 && segs[i].cum + segs[i].len < d) i++;
    return i;
  };
  const pointAt = (progress) => {
    const p = Math.max(0, Math.min(length, progress));
    const s = segs[segAt(p)];
    const d = p - s.cum;
    return { x: s.ax + s.ux * d, y: s.ay + s.uy * d, h: Math.atan2(s.uy, s.ux) };
  };
  const onSeg = (s, i, x, y) => {
    const t = Math.max(0, Math.min(s.len, (x - s.ax) * s.ux + (y - s.ay) * s.uy));
    const px = s.ax + s.ux * t;
    const py = s.ay + s.uy * t;
    return { i, px, py, dist: Math.hypot(x - px, y - py), progress: s.cum + t };
  };
  const closer = (a, b) => (!a || b.dist < a.dist ? b : a);
  // Nearest point, searching only near the car's segment so it can't jump across the course.
  const nearest = (x, y, hint = 0) => {
    let best = null;
    const lo = Math.max(0, hint - 3);
    const hi = Math.min(segs.length - 1, hint + 4);
    for (let i = lo; i <= hi; i++) best = closer(best, onSeg(segs[i], i, x, y));
    return best;
  };
  const distTo = (x, y) => {
    let best = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      // Cheap reject before the exact test.
      if (Math.abs(x - s.ax) > best + s.len || Math.abs(y - s.ay) > best + s.len) continue;
      best = Math.min(best, onSeg(s, i, x, y).dist);
    }
    return best;
  };

  // How sharply the road bends at each sample (radians per unit), for safe cornering speeds.
  const curv = segs.map((_, i) => {
    const a = segs[Math.max(0, i - 3)];
    const b = segs[Math.min(segs.length - 1, i + 3)];
    const dh = Math.abs(Math.atan2(a.ux * b.uy - a.uy * b.ux, a.ux * b.ux + a.uy * b.uy));
    return dh / Math.max(STEP, b.cum - a.cum);
  });
  const curvAhead = (from, ahead) => {
    let k = 0;
    for (let i = segAt(from); i < segs.length && segs[i].cum <= from + ahead; i++) k = Math.max(k, curv[i]);
    return k;
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const bounds = { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };

  return {
    id: def.id,
    name: def.name,
    theme: def.theme,
    color: def.color,
    width,
    pts,
    segs,
    length,
    bounds,
    startAt: 30,
    startGate: 62,
    finishAt: length - (def.finishGap ?? 40),
    pointAt,
    segAt,
    nearest,
    distTo,
    curvAhead,
    features: [],
    stars: [],
    gates: [],
  };
}

// Straight stretches (for ramps and boost pads): [{ from, to }] where the road barely bends.
function straights(t, minLen) {
  const out = [];
  const n = t.segs.length;
  let from = null;
  for (let i = 0; i < n; i++) {
    const s = t.segs[i];
    let straight = true;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2) && straight; j++) {
      const a = t.segs[j];
      if (Math.abs(Math.atan2(s.ux * a.uy - s.uy * a.ux, s.ux * a.ux + s.uy * a.uy)) > 0.035) straight = false;
    }
    if (straight && from === null) from = s.cum;
    if ((!straight || i === n - 1) && from !== null) {
      const to = straight ? s.cum + s.len : s.cum;
      if (to - from >= minLen) out.push({ from, to });
      from = null;
    }
  }
  return out;
}

// Ramps on the longest straights, a boost pad before each (the run-up for a big jump),
// and stars spread along the course: two of them float above the jumps.
function autoFeatures(t, { ramps = 2, boosts = 2, stars = 10, starOffset = 0.28, features = null } = {}) {
  if (features) t.features = features.map(([type, frac, len]) => ({ type, at: frac * t.length, len }));
  const usable = straights(t, 230)
    .map((s) => ({ ...s, from: Math.max(s.from, 260), to: Math.min(s.to, t.length - 260) }))
    .filter((s) => s.to - s.from >= 200)
    .sort((a, b) => b.to - b.from - (a.to - a.from));
  const picked = features ? [] : usable.slice(0, ramps).sort((a, b) => a.from - b.from);
  for (const s of picked) {
    const at = s.from + (s.to - s.from) * 0.55;
    t.features.push({ type: 'boost', at: at - 70, len: 40 });
    t.features.push({ type: 'ramp', at, len: 60 });
  }
  // Extra boost pads on other straights.
  const more = straights(t, 160).filter((s) => s.from > 150 && s.to < t.length - 200 && !picked.some((p) => p.from === s.from || (s.from < p.to && s.to > p.from)));
  if (!features) for (const s of more.slice(0, Math.max(0, boosts - picked.length))) t.features.push({ type: 'boost', at: s.from + 30, len: 50 });
  t.features.sort((a, b) => a.at - b.at);

  const near = (d) => t.features.some((f) => d > f.at - 80 && d < f.at + f.len + 160);
  const spots = [];
  for (const f of t.features) if (f.type === 'ramp') spots.push([f.at + f.len + 45, 0, 30]);
  const n = Math.max(0, stars - spots.length);
  for (let k = 0; k < n; k++) {
    let d = 300 + ((t.length - 600) * (k + 0.5)) / n;
    for (let tries = 0; near(d) && tries < 8; tries++) d += 60;
    spots.push([d, (k % 2 ? -1 : 1) * t.width * starOffset, 0]);
  }
  spots.sort((a, b) => a[0] - b[0]);
  t.stars = spots.map(([d, off, z]) => {
    const p = t.pointAt(d);
    return { x: p.x - Math.sin(p.h) * off, y: p.y + Math.cos(p.h) * off, z, d };
  });
}

// ---------- Race courses ----------
const RACES = {
  gp: {
    name: 'Grand Prix', theme: 'park', color: 'violet', width: 120, finishGap: 15,
    ctrl: [
      [150, 850], [150, 550], [250, 250], [500, 150], [750, 250], [750, 500],
      [600, 650], [600, 850], [900, 900], [1150, 800], [1150, 550], [950, 450],
      [1000, 200], [1300, 130], [1450, 300], [1450, 600], [1350, 880],
    ],
    // Same layout as the original course: boost, jump, boost, then boost into the big jump.
    features: [['boost', 0.026, 50], ['ramp', 0.455, 60], ['boost', 0.748, 50], ['boost', 0.878, 30], ['ramp', 0.887, 60]],
    stars: 10,
  },
  u1: {
    name: 'Mirror Lake', theme: 'lake', color: 'sky', width: 130,
    ctrl: [[0, 0], [0, -520], [70, -900], [320, -1150], [720, -1210], [1030, -1050], [1120, -720], [1060, -380], [1170, -90], [1480, 10], [1820, -80], [1970, -400], [1970, -820]],
    ramps: 1, boosts: 2, stars: 10, starOffset: 0, // the car steers itself here, so stars sit on its line
  },
  u2: {
    name: 'Curvy Road', theme: 'forest', color: 'mint', width: 130,
    ctrl: [[0, 0], [0, -320], [230, -540], [240, -840], [20, -1060], [30, -1360], [270, -1560], [580, -1500], [720, -1240], [960, -1080], [1220, -1220], [1300, -1520], [1560, -1680], [1840, -1540], [1860, -1220]],
    ramps: 0, boosts: 3, stars: 10,
  },
  u3: {
    name: 'Red Canyon', theme: 'canyon', color: 'coral', width: 130,
    ctrl: [[0, 0], [0, -760], [150, -1040], [460, -1130], [940, -1120], [1170, -960], [1220, -650], [1220, -180], [1370, 60], [1720, 110], [2060, 10]],
    ramps: 3, boosts: 1, stars: 10, starOffset: 0,
  },
  u4: {
    name: 'Kiss Beach', theme: 'beach', color: 'sun', width: 130,
    ctrl: [[0, 0], [0, -640], [210, -930], [560, -980], [820, -770], [830, -400], [1030, -150], [1440, -150], [1680, -410], [1690, -930]],
    ramps: 3, boosts: 2, stars: 10, starOffset: 0,
  },
};

// ---------- Lesson courses: one per unit and lesson type ----------
const UNIT_THEME = [
  { theme: 'lake', color: 'sky', names: ['Calm Bay', 'Long Pier', 'Lily Pads', 'Ripple Run', 'Lake Tour'] },
  { theme: 'forest', color: 'mint', names: ['Fern Bend', 'Pine Avenue', 'Slalom Woods', 'Zigzag Trail', 'Forest Tour'] },
  { theme: 'canyon', color: 'coral', names: ['Red Rock Rise', 'Mesa Straight', 'Cactus Gap', 'Dust Devil', 'Canyon Tour'] },
  { theme: 'beach', color: 'sun', names: ['Shell Shore', 'Boardwalk', 'Palm Slalom', 'Wave Hop', 'Beach Tour'] },
];
export const LESSON_GATES = 10;
const KIND_KEYS = ['find', 'hold', 'aim', 'quick', 'mix'];

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// The road between two gates. Each lesson type has its own shape:
// Find = big sweeping bends, Hold = long calm straights, Aim = slalom S-bends,
// Quick = short tight zigzags with gates close together, Mix = a bit of each plus a jump.
function connector(kind, i, s, r, scale) {
  switch (kind) {
    case 'find':
      return i === 4 ? [{ len: 70 * scale, turn: 0 }, { len: 150, turn: 0, mark: 'ramp' }, { len: 130 * scale, turn: s * 45 }] : [{ len: 200 * scale, turn: s * 70 }];
    case 'hold':
      return [{ len: 90 * scale, turn: 0 }, { len: 150 * scale, turn: s * 34 }, ...(i === 5 ? [{ len: 150, turn: 0, mark: 'ramp' }] : [])];
    case 'aim':
      return [{ len: 95 * scale, turn: s * 48 }, { len: 95 * scale, turn: -s * 48 }, { len: 30, turn: 0 }];
    case 'quick':
      return [{ len: 140 * scale, turn: s * 78 }];
    case 'mix': {
      if (i === 3 || i === 7) return [{ len: 60, turn: 0 }, { len: 150, turn: 0, mark: 'ramp' }, { len: 120 * scale, turn: s * 45 }];
      const pick = Math.floor(r() * 4);
      return connector(KIND_KEYS[pick], i === 4 ? 0 : i, s, r, scale);
    }
  }
  return [{ len: 200, turn: 0 }];
}

// Each course also curls slowly one way, so it winds around its island instead of running
// off in a straight line.
const DRIFT = { find: 22, hold: 24, aim: 26, quick: 14, mix: 22 };

function lessonPieces(ui, li, variant) {
  const kind = KIND_KEYS[li];
  const r = rng(1009 * (ui + 1) + 97 * (li + 1) + 7919 * variant);
  const mirror = (ui + li + variant) % 2 ? -1 : 1;
  const scale = 1 + (ui - 1.5) * 0.05;
  const drift = mirror * (DRIFT[kind] - (variant % 4) * 4);
  const pieces = [{ len: 160, turn: 0 }];
  for (let i = 0; i < LESSON_GATES; i++) {
    pieces.push({ len: 60, turn: 0, mark: 'gate-in' }, { len: 60, turn: 0 });
    if (i === LESSON_GATES - 1) break;
    // Alternate the bends. Quick goes +,+,-,- for tight U-shaped zigzags.
    let s = kind === 'quick' ? ((Math.floor(i / 2) % 2) ? -1 : 1) : i % 2 ? -1 : 1;
    s *= mirror;
    if (variant > 3 && r() < 0.3) s = -s;
    const con = connector(kind, i, s, r, scale).map((p) => ({ ...p }));
    const bend = con.find((p) => !p.mark);
    bend.turn = (bend.turn || 0) + drift;
    pieces.push(...con);
  }
  pieces.push({ len: 220, turn: 0 });
  return pieces;
}

// True if the road comes back too close to itself somewhere further along.
export function selfIntersects(t, gap = 1.9) {
  const P = t.pts;
  const skip = Math.ceil((t.width * 3.2) / STEP);
  const min = t.width * gap;
  for (let i = 0; i < P.length; i += 2) {
    for (let j = i + skip; j < P.length; j += 2) {
      if (Math.abs(P[i][0] - P[j][0]) < min && Math.abs(P[i][1] - P[j][1]) < min && dist(P[i], P[j]) < min) return true;
    }
  }
  return false;
}

function lessonCourse(ui, li) {
  const u = UNIT_THEME[ui];
  let t = null;
  for (let variant = 0; variant < 40; variant++) {
    const { pts, marks } = turtle(lessonPieces(ui, li, variant));
    t = build({ id: `${['u1', 'u2', 'u3', 'u4'][ui]}-${KIND_KEYS[li]}`, name: u.names[li], theme: u.theme, color: u.color, width: 130, finishGap: 60 }, resample(pts));
    t.gates = marks.filter((m) => m.mark === 'gate-in').map((m) => m.at + 60);
    t.features = marks.filter((m) => m.mark === 'ramp').map((m) => ({ type: 'ramp', at: m.at + 50, len: 60 }));
    t.lesson = { ui, li, variant };
    if (!selfIntersects(t)) break;
  }
  return t;
}

// ---------- Registry ----------
const cache = new Map();
export function raceTrack(level = 'gp') {
  const id = RACES[level] ? level : 'gp';
  if (!cache.has(id)) {
    const def = RACES[id];
    const t = build({ id, ...def }, resample(catmull(def.ctrl)));
    autoFeatures(t, def);
    cache.set(id, t);
  }
  return cache.get(id);
}
export function lessonTrack(ui, li) {
  const key = `L${ui}-${li}`;
  if (!cache.has(key)) cache.set(key, lessonCourse(ui, li));
  return cache.get(key);
}
export const RACE_IDS = Object.keys(RACES);

// Small SVG path of a course (for the roadmap's previews), fitted into w × h.
export function trackSvgPath(t, w, h, pad = 6) {
  const b = t.bounds;
  const s = Math.min((w - pad * 2) / Math.max(1, b.w), (h - pad * 2) / Math.max(1, b.h));
  const ox = (w - b.w * s) / 2 - b.minX * s;
  const oy = (h - b.h * s) / 2 - b.minY * s;
  const map = ([x, y]) => [x * s + ox, y * s + oy];
  const step = Math.max(1, Math.floor(t.pts.length / 80));
  const pts = t.pts.filter((_, i) => i % step === 0 || i === t.pts.length - 1).map(map);
  return {
    d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(''),
    map: (x, y) => map([x, y]),
    scale: s,
  };
}
