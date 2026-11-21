// Head control: front camera -> MediaPipe Face Landmarker -> steer + go.
// Video never leaves the phone; only the resulting numbers are used.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Candidate "GO" movements. Calibration picks whichever the player actually does.
const GO_SHAPES = {
  'open mouth': ['jawOpen'],
  'raise eyebrows': ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'],
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  'pucker lips': ['mouthPucker'],
  'puff cheeks': ['cheekPuff'],
};

// Steering feel. "reach" = share of your calibrated head movement that gives full lock.
// The curve makes small head movements give small turns (the old linear map felt twitchy).
export const SENSITIVITY = {
  gentle: { reach: 1.0, curve: 1.9, label: 'Gentle' },
  normal: { reach: 0.85, curve: 1.6, label: 'Normal' },
  sharp: { reach: 0.7, curve: 1.25, label: 'Sharp' },
};
const STEER_DEAD = 0.2; // ignore the first 20% of a head movement (natural wobble)
const GO_REACH = 0.7;
const GO_DEAD = 0.15;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

function measure(result, w, h) {
  const L = result.faceLandmarks[0];
  const p = (i) => ({ x: L[i].x * w, y: L[i].y * h });
  const a = p(33); // outer eye corner
  const b = p(263); // other outer eye corner
  const nose = p(1);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy || 1;
  const roll = Math.atan(dy / (dx || 1e-6)); // head tilt, no wrap-around
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const yaw = ((nose.x - mx) * dx + (nose.y - my) * dy) / d2; // head turn
  // Nod: how far the nose sits below the eye line, in eye-widths. Rough, but it ignores tilt and turn.
  const pitch = ((nose.x - mx) * -dy + (nose.y - my) * dx) / d2;
  const shapes = {};
  for (const c of result.faceBlendshapes?.[0]?.categories ?? []) shapes[c.categoryName] = c.score;
  const go = {};
  for (const [k, names] of Object.entries(GO_SHAPES)) go[k] = Math.max(...names.map((n) => shapes[n] ?? 0));
  return { roll, yaw, pitch, go };
}

export class HeadTracker {
  constructor(video) {
    this.video = video;
    this.lm = null;
    this.m = null; // latest measurement
    this.lastSeen = 0;
    this.lastVideoTime = -1;
    this.listeners = [];
  }

  async start(onStatus = () => {}) {
    onStatus('Turning on camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    onStatus('Loading face tracking (first time takes a few seconds)…');
    const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      this.lm = await FaceLandmarker.createFromOptions(files, opts('GPU'));
    } catch (e) {
      console.warn('GPU face tracking failed, using CPU', e);
      this.lm = await FaceLandmarker.createFromOptions(files, opts('CPU'));
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.video.paused) this.video.play().catch(() => {});
    });
  }

  // Call once per animation frame. Returns true if a new measurement arrived.
  update() {
    const v = this.video;
    if (!this.lm || v.readyState < 2 || v.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = v.currentTime;
    const r = this.lm.detectForVideo(v, performance.now());
    if (!r.faceLandmarks?.length) return false;
    this.m = measure(r, v.videoWidth, v.videoHeight);
    this.lastSeen = performance.now();
    for (const fn of this.listeners) fn(this.m);
    return true;
  }

  get faceVisible() {
    return performance.now() - this.lastSeen < 400;
  }

  // Collect measurements for `ms` milliseconds.
  collect(ms) {
    return new Promise((resolve) => {
      const out = [];
      const fn = (m) => out.push(m);
      this.listeners.push(fn);
      setTimeout(() => {
        this.listeners = this.listeners.filter((f) => f !== fn);
        resolve(out);
      }, ms);
    });
  }
}

// Build a calibration from samples gathered while the player was
// relaxed / steering left / steering right / doing their GO movement.
export function buildCalibration({ neutral, left, right, go }) {
  if ([neutral, left, right, go].some((s) => s.length < 5)) {
    return { ok: false, why: "We couldn't see your face clearly. Check the lighting and keep your face in the frame." };
  }
  let best = null;
  for (const axis of ['roll', 'yaw']) {
    const n = mean(neutral.map((s) => s[axis]));
    const jitter = sd(neutral.map((s) => s[axis]));
    const l = mean(left.map((s) => s[axis]));
    const r = mean(right.map((s) => s[axis]));
    const opposite = Math.sign(l - n) !== Math.sign(r - n);
    const minMove = Math.min(Math.abs(l - n), Math.abs(r - n));
    const score = opposite && minMove > 0.04 ? minMove / (jitter + 0.01) : 0;
    if (!best || score > best.score) best = { axis, n, l, r, score };
  }
  if (!best.score) {
    return { ok: false, why: 'Left and right looked too similar. Try a bigger tilt or turn of your head each way.' };
  }
  let goBest = null;
  for (const key of Object.keys(GO_SHAPES)) {
    const gn = mean(neutral.map((s) => s.go[key]));
    const gg = mean(go.map((s) => s.go[key]));
    if (!goBest || gg - gn > goBest.gg - goBest.gn) goBest = { key, gn, gg };
  }
  if (goBest.gg - goBest.gn < 0.15) {
    return { ok: false, why: "We couldn't see your GO movement. Try opening your mouth wider or raising your eyebrows more." };
  }
  // Resting face and nod position, for the practice path's per-exercise signals.
  const fn = Object.fromEntries(Object.keys(GO_SHAPES).map((k) => [k, mean(neutral.map((s) => s.go[k] ?? 0))]));
  const pn = mean(neutral.map((s) => s.pitch ?? 0));
  return {
    ok: true,
    fn,
    pn,
    axis: best.axis,
    n: best.n,
    l: best.l,
    r: best.r,
    goKey: goBest.key,
    gn: goBest.gn,
    gg: goBest.gg,
    steerLabel: best.axis === 'roll' ? 'tilt your head' : 'turn your head',
    goLabel: goBest.key,
  };
}

function dead(x, d) {
  const a = Math.abs(x);
  return a < d ? 0 : Math.sign(x) * Math.min(1, (a - d) / (1 - d));
}

// Turn a measurement into { steer: -1..1, go: 0..1 } for this player's calibration.
export function toIntent(cal, m, sensitivity = 'normal') {
  const sens = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  const v = m[cal.axis];
  const lt = (v - cal.n) / (cal.l - cal.n);
  const rt = (v - cal.n) / (cal.r - cal.n);
  let steer = 0;
  if (lt > 0) steer = -lt;
  else if (rt > 0) steer = rt;
  steer = dead(clamp(steer / sens.reach, -1, 1), STEER_DEAD);
  steer = Math.sign(steer) * Math.pow(Math.abs(steer), sens.curve);
  const g = (m.go[cal.goKey] - cal.gn) / (cal.gg - cal.gn);
  const go = Math.max(0, dead(clamp(g / GO_REACH, 0, 1), GO_DEAD));
  return { steer, go };
}


// ---------- Practice path signals ----------
// Each exercise gets its own number, scaled to this player's own range (1 = their calibrated reach).
export const FACE_SHAPES = { jaw: 'open mouth', pucker: 'pucker lips', smile: 'smile' };
export const PITCH_SPAN = 0.12; // a comfortable nod, in eye-widths (rough)

export function toSignals(cal, m, ranges = {}) {
  const v = m[cal.axis];
  const lt = (v - cal.n) / (cal.l - cal.n);
  const rt = (v - cal.n) / (cal.r - cal.n);
  let side = 0;
  if (lt > 0) side = -lt;
  else if (rt > 0) side = rt;
  side = clamp(side, -1.5, 1.5);
  const rawSide = Math.sign(side) * Math.abs(v - cal.n);
  const pitch = clamp(((m.pitch ?? cal.pn ?? 0) - (cal.pn ?? 0)) / PITCH_SPAN, -1.5, 1.5);
  const raw = { side: rawSide };
  const out = { side, pitch, still: Math.hypot(side, pitch), axis: cal.axis, face: true, raw };
  for (const [k, shape] of Object.entries(FACE_SHAPES)) {
    raw[k] = Math.max(0, (m.go[shape] ?? 0) - (cal.fn?.[shape] ?? 0));
    out[k] = ranges[k] ? clamp(raw[k] / ranges[k], 0, 1.5) : 0;
  }
  return out;
}

// A player's range for one face move, from ~1.5 s of them doing it as big as is comfortable.
export function rangeFrom(samples, cal, key) {
  const shape = FACE_SHAPES[key];
  const vals = samples.map((s) => (s.go[shape] ?? 0) - (cal.fn?.[shape] ?? 0)).sort((a, b) => a - b);
  if (vals.length < 5) return null;
  const r = vals[Math.floor(vals.length * 0.8)];
  return r >= 0.12 ? r : null;
}

// If the calibration's GO move was one of the face exercises, its range is already known.
export function rangeFromCalibration(cal, key) {
  if (!cal?.ok || cal.goKey !== FACE_SHAPES[key]) return null;
  const r = cal.gg - cal.gn;
  return r >= 0.12 ? r : null;
}
