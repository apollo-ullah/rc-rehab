// The practice path: units of head and face exercises, the rep-by-rep lesson engine,
// and the player's progress (XP, daily goal, weekly streak, difficulty, mastery).
// Pure logic with no DOM, so the server and the tests import it too.
//
// Design notes (see README "Practice path" for sources):
//  - Every target is a share of the player's own range, never of "normal".
//  - Aim for 70-85% success: >=90% makes the next lesson harder, <60% makes it easier,
//    and only one difficulty knob moves at a time.
//  - A lesson turns gold after 80%+ on two different days (retention, not one good day).
//  - No lives to lose. Misses cost nothing. "I'm tired" always ends with credit.

export const REPS_PER_LESSON = 10;
export const XP = { rep: 2, lesson: 5, perfect: 5, boss: 20, gp: 10 };
export const GOAL_CHOICES = [5, 10, 15, 20];

export const KINDS = [
  { key: 'find', title: 'Find it', short: 'Find', what: 'Reach the edge of your range and hold it for a moment.' },
  { key: 'hold', title: 'Hold it', short: 'Hold', what: 'Keep the dot in the green. Holds get longer as you improve.' },
  { key: 'aim', title: 'Aim it', short: 'Aim', what: 'Stop in a small green zone: not too little, not too far.' },
  { key: 'quick', title: 'Quick', short: 'Quick', what: 'Move as soon as the cue appears, then relax.' },
  { key: 'mix', title: 'Mix', short: 'Mix', what: 'Everything from this unit in random order, plus a review from the unit before.' },
];

export const UNITS = [
  {
    id: 'u1', path: 'head', section: 'Head', title: 'Hold steady', color: 'sky',
    move: 'Keep your head in the middle and still',
    why: 'The base of head control: sitting up, eye contact, and using any head-operated device.',
    moves: [['still', 0]],
    boss: { name: 'Steady Run', how: 'The car drives while your head stays in the middle. It steers itself.' },
  },
  {
    id: 'u2', path: 'head', section: 'Head', title: 'Left and right', color: 'mint',
    move: 'Turn or tilt your head to each side',
    why: 'Looking around. Power wheelchair head arrays have a pad on each side of the head.',
    moves: [['side', -1], ['side', 1]],
    boss: { name: 'Curvy Road', how: 'You steer with your head. The car drives forward by itself.' },
  },
  {
    id: 'u3', path: 'head', section: 'Mouth and face', title: 'Open and close', color: 'tomato',
    move: 'Open and close your jaw',
    why: 'Graded control: half open versus fully open.',
    moves: [['jaw', 1]],
    boss: { name: 'Mouth Pedal', how: 'Open your mouth to go. Wider is faster. The car steers itself.' },
  },
  {
    id: 'u4', path: 'head', section: 'Mouth and face', title: 'Lips', color: 'sun',
    move: 'Pucker and smile',
    why: 'Lip control and lip seal.',
    moves: [['pucker', 1], ['smile', 1]],
    boss: { name: 'Kiss Boost', how: 'The car rolls along by itself. Pucker your lips to boost.' },
  },
];
// ---------- The arm path: two EMG sensors, one on each biceps, each saying only "flexing or not" ----------
// See docs/arm-path.md for the research behind it. Every unit has its own five lessons (instead of
// the head path's shared Find/Hold/Aim/Quick/Mix); each lesson has one difficulty knob.
const ARM_TEXT = {
  hold: ['holds get 1 second longer.', 'holds get 1 second shorter.'],
  quick: ['a little less time to react.', 'more time to react.'],
  relax: ['a little less time to relax.', 'more time to relax.'],
  window: ['the timing window gets a little smaller.', 'the timing window gets bigger.'],
};
const L = (key, title, what, max, value, text, change) => ({ key, title, short: title, what, knob: { max, value }, text, change });
const MIX = L('mix', 'Mix', 'Everything from this unit in random order, plus a review from the unit before.', 0, () => 0, () => 'A bit of everything');
export const ARM_UNITS = [
  {
    id: 'a1', path: 'arms', section: 'Arms', title: 'Wake up', color: 'coral',
    move: 'Switch each biceps on and off when asked',
    why: 'The base of every other arm skill, and of using any muscle switch.',
    moves: [['arm', 'l'], ['arm', 'r']],
    lessons: [
      L('squeeze', 'Squeeze', 'Squeeze the arm that lights up and keep it on for a moment.', 6, (lv) => 0.5 + 0.25 * lv, (v) => `Keep it on ${v} s`, ['squeezes last a little longer.', 'squeezes get a little shorter.']),
      L('release', 'Let go', 'Squeeze, then relax fully as soon as it says "Let go!", and stay relaxed.', 6, (lv) => Math.round((3 - 0.33 * lv) * 10) / 10, (v) => `${v} s to relax`, ARM_TEXT.relax),
      L('hold', 'Hold', 'Keep a squeeze on. Letting go pauses the clock; it never resets it.', 4, (lv) => 2 + lv, (v) => `Hold ${v} s`, ARM_TEXT.hold),
      L('quick', 'Quick', 'Wait for the cue, then squeeze as fast as you can. Squeezing early just restarts the wait.', 7, (lv) => Math.max(0.8, 2.5 - 0.25 * lv), (v) => `${v.toFixed(1)} s to react`, ARM_TEXT.quick),
      MIX,
    ],
    boss: { name: 'Flex Sprint', how: 'Squeeze either arm to drive. The car steers itself.' },
  },
  {
    id: 'a2', path: 'arms', section: 'Arms', title: 'Hold strong', color: 'sky',
    move: 'Hold a squeeze steady, then let it go on cue',
    why: 'Endurance for carrying and holding things, and letting go when you mean to.',
    moves: [['arm', 'l'], ['arm', 'r']],
    lessons: [
      L('longhold', 'Long hold', 'Keep one arm squeezed. Holds grow as you improve.', 9, (lv) => 3 + lv, (v) => `Hold ${v} s`, ARM_TEXT.hold),
      L('holdgo', 'Hold, then let go', 'Hold a squeeze, then relax within 1.5 s when it says "Let go!".', 6, (lv) => 2 + lv, (v) => `Hold ${v} s, then let go`, ARM_TEXT.hold),
      L('bothhold', 'Both arms hold', 'Squeeze both arms and keep them on.', 6, (lv) => 2 + lv, (v) => `Hold both ${v} s`, ARM_TEXT.hold),
      L('loose', 'Stay loose', 'Keep both arms relaxed. Good practice for arms that tighten up by themselves.', 7, (lv) => 3 + lv, (v) => `Relaxed for ${v} s`, ['relaxed stretches get 1 second longer.', 'relaxed stretches get 1 second shorter.']),
      MIX,
    ],
    boss: { name: 'Long Haul', how: 'The car only moves while you hold a squeeze, and every 3 seconds held gives a boost. It steers itself.' },
  },
  {
    id: 'a3', path: 'arms', section: 'Arms', title: 'Curls', color: 'sun',
    move: 'Curl reps at a steady tempo: up, hold, down',
    why: 'A set of biceps curls, the way strength training is done: slow reps with rest in between.',
    moves: [['arm', 'l'], ['arm', 'r']],
    lessons: [
      L('curl', 'Up and down', 'On "Up!" squeeze and keep it up for 2 s. On "Down" relax and stay down for 2 s.', 5, (lv) => Math.max(0.5, 1.2 - 0.14 * lv), (v) => `${v.toFixed(1)} s timing window`, ARM_TEXT.window),
      L('pause', 'Pause at the top', 'Curls with a longer squeeze at the top.', 3, (lv) => 2 + lv, (v) => `${v} s at the top`, ['the pause at the top gets 1 second longer.', 'the pause at the top gets shorter.']),
      L('bothcurl', 'Both arms', 'Curls with both arms together.', 5, (lv) => Math.max(0.5, 1.2 - 0.14 * lv), (v) => `${v.toFixed(1)} s timing window`, ARM_TEXT.window),
      L('fastup', 'Fast up', 'On "Up!" squeeze as fast as you can and hold 1 s, then relax.', 7, (lv) => Math.max(0.8, 2.5 - 0.25 * lv), (v) => `${v.toFixed(1)} s to react`, ARM_TEXT.quick),
      MIX,
    ],
    boss: { name: 'Pump Track', how: 'The car rolls by itself. Every new squeeze (let go, then squeeze again) gives a boost.' },
  },
  {
    id: 'a4', path: 'arms', section: 'Arms', title: 'Left and right', color: 'mint',
    move: 'Use one arm without the other, switch, and work together',
    why: 'Choosing which arm moves. Two muscle switches like these can drive a wheelchair or a toy.',
    moves: [['arm', 'l'], ['arm', 'r']],
    lessons: [
      L('solo', 'Just one', 'Squeeze the named arm while the other stays relaxed. At first the other arm may join in for a while.', 4, (lv) => Math.max(0, 1 - 0.25 * lv), (v) => (v ? `Other arm may join for ${v} s` : 'Other arm stays relaxed'), ['the other arm gets a little less time to join in.', 'the other arm gets more time to join in.']),
      L('swap', 'Switch', 'Squeeze one arm, let go, then squeeze the other.', 6, (lv) => Math.max(2.5, 6 - 0.6 * lv), (v) => `${v.toFixed(1)} s to switch`, ['a little less time to switch.', 'more time to switch.']),
      L('together', 'Together', 'Squeeze both arms at the same moment, then hold for 1 s.', 5, (lv) => Math.max(0.25, 0.8 - 0.11 * lv), (v) => `Within ${v.toFixed(2)} s of each other`, ARM_TEXT.window),
      L('which', 'Which arm?', 'A random arm is named: squeeze that one fast, and not the other.', 7, (lv) => Math.max(0.8, 2.5 - 0.25 * lv), (v) => `${v.toFixed(1)} s to react`, ARM_TEXT.quick),
      MIX,
    ],
    boss: { name: 'Arm Grand Prix', how: 'You steer, like driving each side of the car: your left arm turns right, your right arm turns left, both drive straight at full speed. Neither stops the car.' },
  },
];
UNITS.push(...ARM_UNITS);
export const pathOf = (u) => u?.path || 'head';
// [{ u, ui }] for one path, with ui the index in UNITS.
export const unitsOf = (path) => UNITS.map((u, ui) => ({ u, ui })).filter((x) => pathOf(x.u) === path);
// A unit's number within its own path (1-4).
export const unitNo = (ui) => unitsOf(pathOf(UNITS[ui])).findIndex((x) => x.ui === ui) + 1;
// The lesson at position li of a unit: the arm path's own lessons, or the shared head-path kinds.
export const lessonInfo = (ui, li) => UNITS[ui]?.lessons?.[li] ?? KINDS[li];

export const GRAND_PRIX = { id: 'gp', name: 'Grand Prix', how: 'Your head steers and your GO move drives. Full course, full leaderboard.' };
export const LEVELS = ['gp', ...UNITS.map((u) => u.id)];
export const unitIndex = (id) => UNITS.findIndex((u) => u.id === id);
export const levelName = (id) => (id && id !== 'gp' ? UNITS[unitIndex(id)]?.boss.name : null) ?? GRAND_PRIX.name;
export const FACE_SIGS = ['jaw', 'pucker', 'smile'];

// ---------- Difficulty knobs: one per lesson type ----------
const KNOB = {
  find: { max: 8, value: (lv) => Math.min(1, 0.6 + 0.05 * lv) }, // target, share of your range
  hold: { max: 8, value: (lv) => 2 + lv }, // seconds
  aim: { max: 5, value: (lv) => Math.max(0.08, 0.18 - 0.02 * lv) }, // half-width of the green zone
  quick: { max: 7, value: (lv) => Math.max(0.75, 2.5 - 0.25 * lv) }, // seconds to react
  mix: { max: 0, value: () => 0 },
};
// Hold steady (unit 1) has its own knobs: time in a zone, zone size, time to come back.
const STILL_KNOB = {
  find: { max: 6, value: (lv) => 1.5 + 0.5 * lv },
  hold: { max: 8, value: (lv) => 2 + lv },
  aim: { max: 6, value: (lv) => Math.max(0.14, 0.4 - 0.04 * lv) },
  quick: { max: 8, value: (lv) => Math.max(1, 3 - 0.25 * lv) },
  mix: { max: 0, value: () => 0 },
};
export const knobFor = (unitId, kind) =>
  UNITS[unitIndex(unitId)]?.lessons?.find((l) => l.key === kind)?.knob ?? (unitId === 'u1' ? STILL_KNOB : KNOB)[kind];

const CHANGE_TEXT = {
  find: ['targets move a little further out.', 'targets come in a little.'],
  hold: ['holds get 1 second longer.', 'holds get 1 second shorter.'],
  aim: ['the green zone gets a little smaller.', 'the green zone gets bigger.'],
  quick: ['a little less time to react.', 'more time to react.'],
};
const STILL_CHANGE = {
  find: ['holds get a little longer.', 'holds get a little shorter.'],
  hold: CHANGE_TEXT.hold,
  aim: ['the green square gets a little smaller.', 'the green square gets bigger.'],
  quick: ['a little less time to come back.', 'more time to come back.'],
};

export function difficultyText(unitId, kind, level) {
  const arm = UNITS[unitIndex(unitId)]?.lessons?.find((l) => l.key === kind);
  if (arm) return arm.text(arm.knob.value(level));
  const v = knobFor(unitId, kind).value(level);
  if (unitId === 'u1') {
    return {
      find: `Hold ${v} s in a big zone`,
      hold: `Hold ${v} s`,
      aim: `Zone size ${Math.round(v * 100)}% of your range`,
      quick: `${v.toFixed(1)} s to come back`,
      mix: 'A bit of everything',
    }[kind];
  }
  return {
    find: `Target ${Math.round(v * 100)}% of your range`,
    hold: `Hold ${v} s`,
    aim: `Green zone ±${Math.round(v * 100)}%`,
    quick: `${v.toFixed(2)} s to react`,
    mix: 'A bit of everything',
  }[kind];
}

// ---------- Building a lesson ----------
const pickInt = (rng, n) => Math.floor(rng() * n) % n;
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = pickInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function words(sig, dir, verb) {
  if (sig === 'side') {
    const d = dir < 0 ? 'left' : 'right';
    return { reach: `${verb} ${d}`, hold: `Hold ${d}`, aim: `${verb} ${d} to the green`, quick: `${d.toUpperCase()}!`, ready: `${verb.toLowerCase()} ${d}` };
  }
  return {
    jaw: { reach: 'Open wide', hold: 'Hold it half open', aim: 'Open to the green', quick: 'OPEN!', ready: 'open your mouth' },
    pucker: { reach: 'Pucker your lips', hold: 'Hold the pucker', aim: 'Pucker to the green', quick: 'PUCKER!', ready: 'pucker' },
    smile: { reach: 'Big smile', hold: 'Hold the smile', aim: 'Smile to the green', quick: 'SMILE!', ready: 'smile' },
  }[sig];
}

function makeRep(unitId, kind, [sig, dir], level, o) {
  const v = knobFor(unitId, kind).value(level);
  const wide = o.wide ? 1.4 : 1;
  const dwell = o.wide ? 0.5 : 0.3;
  if (sig === 'still') {
    const side = o.rng() < 0.5 ? -1 : 1;
    const base = { sig, kind: 'hold', lo: 0 };
    if (kind === 'find') return { ...base, hi: 0.4 * wide, hold: v, cue: 'Find the middle', sub: 'Look at the screen. Keep the dot in the green.', ready: 'find the middle' };
    if (kind === 'hold') return { ...base, hi: 0.3 * wide, hold: v, cue: 'Hold steady', sub: 'Keep the dot in the green.', ready: 'hold steady' };
    if (kind === 'aim') return { ...base, hi: v * wide, hold: 3, cue: 'Small and steady', sub: 'The green square shrinks as you improve.', ready: 'hold steady' };
    return { sig, kind: 'return', dir: side, w: 0.3 * wide, limit: v * (o.wide ? 1.3 : 1), cue: `${o.verb} ${side < 0 ? 'left' : 'right'}`, sub: 'Then come back to the middle, quickly.', ready: `${o.verb.toLowerCase()} away and back` };
  }
  const w = words(sig, dir, o.verb);
  if (kind === 'find') return { sig, dir, kind: 'reach', target: v, dwell, cue: w.reach, sub: 'As far as is comfortable, then hold.', ready: w.ready };
  if (kind === 'hold') {
    const [lo, hi] = sig === 'side' ? [0.4, 0.95] : [0.35, 0.9];
    const pad = (wide - 1) * 0.15;
    return { sig, dir, kind: 'hold', lo: lo - pad, hi: hi + pad, hold: v, cue: w.hold, sub: 'Keep the dot in the green.', ready: w.ready };
  }
  if (kind === 'aim') return { sig, dir, kind: 'aim', target: o.aimTarget, tol: v * wide, dwell: dwell + 0.1, cue: w.aim, sub: 'Stop in the green. Not too far.', ready: w.ready };
  return { sig, dir, kind: 'quick', target: 0.5, limit: v * (o.wide ? 1.3 : 1), cue: w.quick, sub: 'Then relax.', ready: w.ready };
}

// opts: { verb: 'Turn' | 'Tilt' | 'Slide', rng, wide }
export function buildLesson(p, ui, li, { verb = 'Turn', rng = Math.random, wide = p?.wide } = {}) {
  const unit = UNITS[ui];
  const kind = KINDS[li].key;
  const lv = (k, uid = unit.id) => lessonsOf(p, uid)[KINDS.findIndex((x) => x.key === k)].level;
  const o = { verb, rng, wide: !!wide };
  const aims = shuffle([0.3, 0.6, 0.9, 0.3, 0.6, 0.9, 0.3, 0.6, 0.9, 0.6], rng);
  // Two-sided units alternate evenly; Quick shuffles the order so the next cue can't be guessed.
  let order = Array.from({ length: REPS_PER_LESSON }, (_, i) => unit.moves[i % unit.moves.length]);
  if (unit.moves.length > 1) order = kind === 'quick' ? shuffle(order, rng) : rng() < 0.5 ? order : order.slice().reverse();
  const reps = [];
  for (let i = 0; i < REPS_PER_LESSON; i++) {
    let k = kind;
    let uid = unit.id;
    let mv = order[i];
    if (kind === 'mix') {
      if (ui > 0 && pathOf(UNITS[ui - 1]) === pathOf(unit) && (i === 3 || i === 7)) {
        // Spaced review: a rep from the unit before.
        uid = UNITS[ui - 1].id;
        k = 'find';
        mv = UNITS[ui - 1].moves[pickInt(rng, UNITS[ui - 1].moves.length)];
      } else {
        k = KINDS[pickInt(rng, 4)].key;
        mv = unit.moves[pickInt(rng, unit.moves.length)];
      }
    }
    let level = lv(k, uid);
    if (i === 0) level = Math.max(0, level - 2); // warm-up rep
    if (kind === 'mix' && k === 'hold') level = Math.min(level, 2); // keep mixes brisk
    o.aimTarget = aims[i];
    reps.push({ ...makeRep(uid, k, mv, level, o), lesson: k, unit: uid });
  }
  const l = lessonsOf(p, unit.id)[li];
  // Faded feedback: once a lesson is going well, every third rep hides the live meter.
  const feel = isGold(l) || l.level >= 3 ? [2, 5, 8] : [];
  return { reps, feel, adaptFind: kind === 'find' && unit.id !== 'u1', title: `${unit.title} · ${KINDS[li].title}`, unit: unit.id, kind };
}

// ---------- The rep engine ----------
const REST = 0.25;
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const GOOD = ['Good!', 'Nice!', 'Yes!', 'Great!'];

// Signals: { side: -1.5..1.5, still: 0.., pitch, jaw, pucker, smile: 0..1.5 (share of your range),
//            raw: { side, jaw, pucker, smile }, axis: 'roll'|'yaw', face: bool }
export class LessonRun {
  constructor(lesson, { axis = 'yaw', rng = Math.random } = {}) {
    this.reps = lesson.reps.map((r) => ({ ...r }));
    this.feel = new Set(lesson.feel || []);
    this.adaptFind = !!lesson.adaptFind;
    this.axis = axis;
    this.rng = rng;
    this.i = 0;
    this.results = [];
    this.done = false;
    this.bumps = 0;
    this.lostMs = 0;
    this.streak = {};
    this.begin();
  }

  get rep() {
    return this.reps[Math.min(this.i, this.reps.length - 1)];
  }

  begin() {
    this.phase = 'rest';
    this.t = 0;
    this.restT = 0;
    this.waitFor = 0.8 + this.rng() * 1.7;
    this.cur = { peak: 0, peakRaw: 0, react: null, held: 0, dwell: 0, vals: [], firstIn: null, sub: 'away' };
  }

  value(s, r = this.rep) {
    if (r.sig === 'side') return (s.side || 0) * (r.dir || 1);
    if (r.sig === 'still') return s.still || 0;
    return s[r.sig] || 0;
  }

  raw(s, r) {
    if (r.sig === 'side') return Math.max(0, (s.raw?.side || 0) * r.dir);
    if (r.sig === 'still') return 0;
    return s.raw?.[r.sig] || 0;
  }

  relaxed(s, r) {
    if (r.sig === 'still') return true;
    if (r.sig === 'side') return Math.abs(s.side || 0) < REST;
    return (s[r.sig] || 0) < REST;
  }

  update(s, dt) {
    if (this.done) return this.view(s, null);
    if (!s.face) {
      this.lostMs += dt * 1000;
      return this.view(s, null, true);
    }
    const r = this.rep;
    const v = this.value(s, r);
    this.t += dt;
    let event = null;
    if (this.phase === 'rest') {
      this.restT = this.relaxed(s, r) ? this.restT + dt : 0;
      // Start once relaxed, or after 4 s anyway: some people can't fully relax, and that's fine.
      if ((this.restT >= 0.3 && this.t >= 0.7) || this.t >= 4) {
        this.phase = r.kind === 'quick' ? 'wait' : 'go';
        this.t = 0;
      }
    } else if (this.phase === 'wait') {
      if (v > 0.4) this.t = 0; // moved early: wait again, no penalty
      if (this.t >= this.waitFor) {
        this.phase = 'go';
        this.t = 0;
      }
    } else if (this.phase === 'go') {
      const ok = this.track(r, this.cur, s, v, dt);
      if (ok !== null) {
        event = ok ? 'good' : 'miss';
        this.finishRep(ok);
      }
    } else if (this.phase === 'result' && this.t >= 0.9) {
      this.next();
    }
    return this.view(s, event);
  }

  // Returns true (good rep), false (missed) or null (still going).
  track(r, c, s, v, dt) {
    if (r.sig !== 'still') {
      c.peak = Math.max(c.peak, v);
      c.peakRaw = Math.max(c.peakRaw, this.raw(s, r));
      if (c.react === null && v >= 0.2) c.react = this.t;
    }
    switch (r.kind) {
      case 'reach':
        c.dwell = v >= r.target ? c.dwell + dt : 0;
        if (c.dwell >= r.dwell) return true;
        return this.t > 7 ? false : null;
      case 'aim':
        c.dwell = Math.abs(v - r.target) <= r.tol ? c.dwell + dt : 0;
        if (c.dwell >= r.dwell) return true;
        return this.t > 8 ? false : null;
      case 'hold': {
        // Time in the zone adds up; leaving it pauses the clock instead of resetting it.
        if (v >= r.lo && v <= r.hi) {
          c.held += dt;
          c.vals.push(v);
        }
        if (c.held >= r.hold) return true;
        return this.t > r.hold + 8 ? false : null;
      }
      case 'quick':
        if (v >= r.target) return true;
        return this.t > r.limit ? false : null;
      case 'return': {
        if (c.sub === 'away') {
          if (this.t > 6) return false; // never turned away, so there was nothing to come back from
          if ((s.side || 0) * r.dir >= 0.4) {
            c.sub = 'back';
            this.t = 0;
          }
          return null;
        }
        const inZone = (s.still || 0) <= r.w;
        if (inZone && c.firstIn === null) c.firstIn = this.t;
        c.dwell = inZone ? c.dwell + dt : 0;
        if (c.dwell >= 0.4 && c.firstIn !== null && c.firstIn <= r.limit) return true;
        return this.t > r.limit + 1.5 ? false : null;
      }
    }
    return false;
  }

  finishRep(ok) {
    const r = this.rep;
    const c = this.cur;
    this.results.push({
      ok,
      lesson: r.lesson,
      kind: r.kind,
      sig: r.sig,
      dir: r.dir || 0,
      peak: c.peak,
      peakRaw: c.peakRaw,
      react: r.kind === 'return' ? c.firstIn : r.kind === 'hold' ? null : c.react,
      held: c.held,
      hold: r.hold || 0,
      jitter: c.vals.length > 5 ? sd(c.vals) : null,
      feel: this.feel.has(this.i),
    });
    this.phase = 'result';
    this.t = 0;
    this._fatigue = undefined;
    if (this.adaptFind && r.kind === 'reach') this.adapt(r, ok);
  }

  // Find it: four good reps in a row on one move pushes that move's target out 5%.
  adapt(r, ok) {
    const key = `${r.sig}${r.dir}`;
    this.streak[key] = ok ? (this.streak[key] || 0) + 1 : 0;
    if (this.streak[key] < 4) return;
    this.streak[key] = 0;
    let bumped = false;
    for (let j = this.i + 1; j < this.reps.length; j++) {
      const n = this.reps[j];
      if (n.kind === 'reach' && n.sig === r.sig && n.dir === r.dir && n.target < 1) {
        n.target = Math.min(1, n.target + 0.05);
        bumped = true;
      }
    }
    if (bumped || r.target < 1) this.bumps++;
  }

  next() {
    this.i++;
    if (this.i >= this.reps.length) {
      this.done = true;
      this.i = this.reps.length;
      return;
    }
    this.begin();
  }

  // What an ideal player would be doing right now (drives ?autopilot and the tests).
  want() {
    const r = this.rep;
    const c = this.cur;
    const at = (value, sig = r.sig, dir = r.dir || 1) => ({ sig, dir, value });
    if (this.done || this.phase !== 'go') return at(0);
    switch (r.kind) {
      case 'reach': return at(r.target + 0.08);
      case 'aim': return at(r.target);
      case 'hold': return at(r.sig === 'still' ? 0 : (r.lo + r.hi) / 2);
      case 'quick': return at(0.8);
      case 'return': return c.sub === 'away' ? at(0.6, 'side', r.dir) : at(0, 'side', r.dir);
    }
    return at(0);
  }

  band(r) {
    const flip = ([a, b]) => (r.sig === 'side' && r.dir < 0 ? [-b, -a] : [a, b]);
    if (this.phase === 'rest' || this.phase === 'wait') {
      if (r.sig === 'still') return null;
      return { range: r.sig === 'side' ? [-REST, REST] : [0, REST], kind: 'rest' };
    }
    if (this.phase !== 'go') return null;
    switch (r.kind) {
      case 'reach': return { range: flip([r.target, 1.25]), kind: 'target' };
      case 'quick': return { range: flip([r.target, 1.25]), kind: 'target' };
      case 'aim': return { range: flip([r.target - r.tol, r.target + r.tol]), kind: 'target' };
      case 'hold': return r.sig === 'still' ? { zone: r.hi, kind: 'target' } : { range: flip([r.lo, r.hi]), kind: 'target' };
      case 'return': return this.cur.sub === 'back' ? { zone: r.w, kind: 'target' } : null;
    }
    return null;
  }

  view(s, event, lost = false) {
    const r = this.rep;
    const c = this.cur;
    let cue = r.cue;
    let sub = r.sub;
    let progress = 0;
    let drive = 0.12;
    const feelNow = this.feel.has(this.i) && this.phase === 'go';
    if (this.done) {
      cue = 'Done!';
      sub = '';
      drive = 0;
    } else if (lost) {
      cue = "Can't see your face";
      sub = 'Move back into view of the camera. The clock is paused.';
      drive = 0;
    } else if (this.phase === 'rest') {
      cue = r.sig === 'side' ? 'Back to the middle' : r.sig === 'still' ? 'Get ready' : 'Relax your face';
      sub = `Next: ${r.ready}`;
    } else if (this.phase === 'wait') {
      cue = 'Wait for it…';
      sub = `Get ready to ${r.ready}`;
    } else if (this.phase === 'go') {
      const v = this.value(s, r);
      if (r.kind === 'hold') {
        progress = c.held / r.hold;
        drive = v >= r.lo && v <= r.hi ? 0.55 : 0.15;
      } else if (r.kind === 'quick') {
        progress = Math.max(0, 1 - this.t / r.limit);
      } else if (r.kind === 'return') {
        if (c.sub === 'back') {
          cue = 'Back to the middle!';
          sub = 'As quick as you can, then stay.';
          progress = c.dwell / 0.4;
        }
      } else {
        progress = c.dwell / r.dwell;
      }
      if (feelNow) sub = 'Feel it: no meter on this one.';
    } else if (this.phase === 'result') {
      const res = this.results[this.results.length - 1];
      cue = res.ok ? (res.kind === 'hold' ? 'Steady!' : GOOD[this.results.length % GOOD.length]) : 'Keep going';
      sub = res.ok ? '' : "That one didn't count. No problem.";
      if (res.feel) {
        sub = res.kind === 'hold'
          ? `You held it for ${res.held.toFixed(1)} s.`
          : res.sig === 'still' ? sub : `You reached ${Math.round(res.peak * 100)}% of your range.`;
      }
      drive = res.ok ? 0.5 : 0.15;
    }
    return {
      i: Math.min(this.i, this.reps.length - 1),
      n: this.reps.length,
      phase: this.phase,
      cue,
      sub,
      gauge: {
        type: r.sig === 'still' ? 'pad' : r.sig === 'side' ? 'bi' : 'uni',
        value: r.sig === 'side' ? s.side || 0 : r.sig === 'still' ? 0 : s[r.sig] || 0,
        x: s.side || 0,
        y: s.pitch || 0,
        band: this.done ? null : this.band(r),
        hideDot: feelNow,
      },
      progress: Math.max(0, Math.min(1, progress)),
      event,
      done: this.done,
      results: this.results,
      drive,
      lost,
      fatigue: this.fatigue(),
    };
  }

  // Two warning signs at once = probably tired: slower reactions, smaller moves,
  // more wobble, good reps turning into misses, or the face keeps leaving the camera.
  fatigue() {
    if (this._fatigue !== undefined) return this._fatigue;
    const R = this.results;
    if (R.length < 6) return (this._fatigue = false);
    const a = R.slice(0, 3);
    const b = R.slice(-3);
    const avg = (xs, f) => {
      const v = xs.map(f).filter((x) => x != null && x > 0);
      return v.length ? mean(v) : null;
    };
    let flags = 0;
    const [ra, rb] = [avg(a, (r) => r.react), avg(b, (r) => r.react)];
    if (ra && rb && rb > ra * 1.3) flags++;
    const [pa, pb] = [avg(a, (r) => r.peak), avg(b, (r) => r.peak)];
    if (pa && pb && pb < pa * 0.8) flags++;
    const [ja, jb] = [avg(a, (r) => r.jitter), avg(b, (r) => r.jitter)];
    if (ja && jb && jb > ja * 1.5) flags++;
    if (a.filter((r) => r.ok).length >= 2 && b.every((r) => !r.ok)) flags++;
    if (this.lostMs > 5000) flags++;
    return (this._fatigue = flags >= 2);
  }

  summary() {
    const R = this.results;
    const good = R.filter((r) => r.ok).length;
    const peaks = {};
    for (const r of R) {
      if (r.kind !== 'reach' || !(r.peakRaw > 0)) continue;
      const key = r.sig === 'side' ? `${this.axis}${r.dir < 0 ? 'L' : 'R'}` : r.sig;
      peaks[key] = Math.max(peaks[key] || 0, r.peakRaw);
    }
    const reacts = R.map((r) => r.react).filter((x) => x != null);
    return {
      good,
      total: R.length,
      rate: R.length ? good / R.length : 0,
      peaks,
      reactMs: reacts.length ? Math.round(mean(reacts) * 1000) : null,
      fatigue: this.fatigue(),
      bumps: this.bumps,
      lostMs: Math.round(this.lostMs),
    };
  }
}

// ---------- Achievements ----------
// A long list of small wins, each with a progress bar. Resting counts as a win too.
export function achievements(p, day = localDay()) {
  const days = Object.values(p.days || {});
  const sum = (f) => days.reduce((a, d) => a + (f(d) || 0), 0);
  const all = UNITS.flatMap((u) => lessonsOf(p, u.id));
  const c = counts(p);
  const HEAD = UNITS.filter((u) => pathOf(u) === 'head'); // the head path's own goals
  const bosses = HEAD.filter((u) => p.bosses[u.id]?.cleared).length;
  const tried = HEAD.filter((u) => lessonsOf(p, u.id).some((l) => l.plays > 0)).length;
  const pp = pathProgress(p, 'head');
  const list = [
    ['first', 'First gate', 'Open your first gate with a good rep.', sum((d) => d.good), 1],
    ['warmup', 'Warmed up', 'Finish your first lesson.', all.filter((l) => l.done).length, 1],
    ['explorer', 'Explorer', 'Play a lesson in every unit.', tried, HEAD.length],
    ['perfect', 'Perfect ten', 'Open all 10 gates in one lesson.', c.perfect, 1],
    ['rest', 'Good call', 'Stop with "I\'m tired" when you need a rest.', c.tired, 1],
    ['gates', 'Gatekeeper', 'Open 100 gates.', sum((d) => d.good), 100],
    ['goal', 'Goal getter', 'Hit your daily goal on 5 days.', days.filter((d) => d.goalMet).length, 5],
    ['streak', 'On a roll', 'Keep a 2-week streak going.', weekView(p, day).streak, 2],
    ['gold', 'Golden', 'Turn 5 lessons gold.', all.filter(isGold).length, 5],
    ['boss', 'Boss hunter', 'Clear all four boss races.', bosses, HEAD.length],
    ['gp', 'Racer', 'Finish the Grand Prix.', c.gp, 1],
    ['hour', 'Long haul', 'Practise for 60 minutes in total.', Math.floor(sum((d) => d.ms) / 60000), 60],
    ['map', 'Whole map', 'Finish every stop on the roadmap.', pp.done, pp.total],
  ];
  return list.map(([id, title, what, have, need]) => ({ id, title, what, have: Math.min(have, need), need, done: have >= need }));
}

// ---------- Dates ----------
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const utc = (s) => new Date(`${s}T00:00:00Z`);
export const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const mondayOf = (s) => addDays(s, -((utc(s).getUTCDay() + 6) % 7));

// ---------- Profile ----------
export function newProfile(name, today = localDay()) {
  return {
    v: 1, name, created: today, updatedAt: 0, xp: 0,
    goalMin: 10, daysPerWeek: 4, wide: false,
    days: {}, lessons: {}, bosses: {}, ranges: {}, peaks: {},
    counts: { perfect: 0, tired: 0, gp: 0 },
  };
}
const counts = (p) => (p.counts ||= { perfect: 0, tired: 0, gp: 0 });

export function lessonsOf(p, unitId) {
  p.lessons[unitId] ||= KINDS.map(() => ({ level: 0, done: false, plays: 0, goodDays: [], lastRate: null }));
  return p.lessons[unitId];
}
export const isGold = (l) => l.goodDays.length >= 2;

// Every unit and lesson is open from day one. The path only suggests an order.
export const unitOpen = () => true;

// Path order: unit by unit, the five lessons then the boss race.
export function nextNode(p, path = 'head') {
  for (const { ui } of unitsOf(path)) {
    const L = lessonsOf(p, UNITS[ui].id);
    for (let li = 0; li < 5; li++) if (!L[li].done) return { ui, li };
    if (!p.bosses[UNITS[ui].id]?.cleared) return { ui, li: 5 };
  }
  return null;
}

// li 0-4 = lessons, 5 = boss. States: open | next (the suggested one) | done | gold.
export function nodeState(p, ui, li) {
  if (li === 5) {
    if (p.bosses[UNITS[ui].id]?.cleared) return 'done';
  } else {
    const l = lessonsOf(p, UNITS[ui].id)[li];
    if (isGold(l)) return 'gold';
    if (l.done) return 'done';
  }
  const nx = nextNode(p, pathOf(UNITS[ui]));
  return nx && nx.ui === ui && nx.li === li ? 'next' : 'open';
}

// How far along a unit is: 6 stops (5 lessons and the boss).
export function unitProgress(p, ui) {
  const L = lessonsOf(p, UNITS[ui].id);
  const done = L.filter((l) => l.done).length + (p.bosses[UNITS[ui].id]?.cleared ? 1 : 0);
  return { done, gold: L.filter(isGold).length, total: 6 };
}
export function pathProgress(p, path = 'head') {
  let done = 0;
  let gold = 0;
  const list = unitsOf(path);
  list.forEach(({ ui }) => {
    const u = unitProgress(p, ui);
    done += u.done;
    gold += u.gold;
  });
  return { done, gold, total: list.length * 6 };
}

// Player level from XP: 50, 150, 300, 500… XP (a lesson is worth about 25).
export function xpLevel(xp) {
  let level = 1;
  while (xp >= 25 * level * (level + 1)) level++;
  const from = 25 * (level - 1) * level;
  const to = 25 * level * (level + 1);
  return { level, from, to, frac: (xp - from) / (to - from) };
}

function dayOf(p, day) {
  return (p.days[day] ||= { ms: 0, xp: 0, good: 0, reps: 0, goalMet: false });
}

// Adds practice time and XP to a day. Returns true when this pushed the day past the daily goal.
export function addPractice(p, day, { ms = 0, xp = 0, good = 0, reps = 0 }) {
  const d = dayOf(p, day);
  d.ms += Math.max(0, ms);
  d.xp += xp;
  d.good += good;
  d.reps += reps;
  p.xp += xp;
  const was = d.goalMet;
  d.goalMet = was || d.ms >= p.goalMin * 60000;
  p.updatedAt = Date.now();
  return d.goalMet && !was;
}

function recordPeak(p, key, v, day) {
  const e = p.peaks[key];
  if (!e) {
    p.peaks[key] = { firstDay: day, first: v, best: v, bestDay: day };
    return;
  }
  if (e.firstDay === day) e.first = Math.max(e.first, v);
  if (v > e.best) {
    e.best = v;
    e.bestDay = day;
  }
}

// summary: LessonRun.summary() plus { ms, tired }
export function recordLesson(p, ui, li, sum, day = localDay()) {
  const unit = UNITS[ui];
  const info = lessonInfo(ui, li);
  const kind = info.key;
  const l = lessonsOf(p, unit.id)[li];
  const knob = knobFor(unit.id, kind);
  const before = l.level;
  l.plays++;
  l.done = true; // "I'm tired" still counts: stopping early is never punished
  l.lastRate = sum.rate;
  if (sum.total >= 5 && knob.max > 0) {
    if (sum.rate >= 0.9 && !sum.tired) l.level += Math.max(1, sum.bumps || 0);
    else if (sum.rate < 0.6) l.level -= 1;
    else if (sum.bumps) l.level += sum.bumps;
    l.level = Math.max(0, Math.min(knob.max, l.level));
  }
  const change = l.level > before ? 'up' : l.level < before ? 'down' : 'same';
  if (sum.rate >= 0.8 && sum.total >= 8 && !l.goodDays.includes(day)) l.goodDays.push(day);
  for (const [key, v] of Object.entries(sum.peaks || {})) {
    recordPeak(p, key, v, day);
    // Face ranges grow toward what you've actually shown, so targets stay within your reach.
    if (FACE_SIGS.includes(key) && p.ranges[key] && v > p.ranges[key]) p.ranges[key] += 0.3 * (v - p.ranges[key]);
  }
  const perfect = sum.total >= REPS_PER_LESSON && sum.good === sum.total;
  const xp = sum.good * XP.rep + XP.lesson + (perfect ? XP.perfect : 0);
  if (perfect) counts(p).perfect++;
  if (sum.tired) counts(p).tired++;
  const goalJustMet = addPractice(p, day, { ms: sum.ms || 0, xp, good: sum.good, reps: sum.total });
  const texts = info.change || (unit.id === 'u1' ? STILL_CHANGE : CHANGE_TEXT)[kind];
  let text = '';
  if (knob.max > 0) {
    if (change === 'up') text = `Next time: ${texts[0]}`;
    else if (change === 'down') text = `Next time: ${texts[1]}`;
    else if (l.level === knob.max) text = "You're at the top level for this lesson.";
    else text = 'Next time: same level, to lock it in.';
  }
  return { xp, change, text, gold: isGold(l), goalJustMet };
}

export function recordBoss(p, level, { ms = 0, finished = true } = {}, day = localDay()) {
  const ui = unitIndex(level);
  let firstClear = false;
  if (ui >= 0 && finished) {
    const b = (p.bosses[level] ||= { cleared: false, bestMs: null });
    firstClear = !b.cleared;
    b.cleared = true;
    b.bestMs = b.bestMs == null ? ms : Math.min(b.bestMs, ms);
  }
  const xp = finished ? (ui >= 0 ? XP.boss : XP.gp) : 0;
  if (finished && ui < 0) counts(p).gp++;
  const goalJustMet = addPractice(p, day, { ms, xp });
  const next = UNITS[ui + 1];
  return { xp, goalJustMet, firstClear, nextUp: firstClear && next && pathOf(next) === pathOf(UNITS[ui]) ? next.title : null };
}

export function todayView(p, day = localDay()) {
  const d = p.days[day] || { ms: 0, xp: 0, goalMet: false };
  const min = d.ms / 60000;
  return { min, goalMin: p.goalMin, frac: Math.min(1, min / p.goalMin), xp: d.xp, met: d.goalMet };
}

// Weekly streak: hit your daily goal on `daysPerWeek` days. Rest days are built in,
// and one missed week a month is frozen automatically instead of breaking the streak.
export function weekView(p, day = localDay()) {
  const mon = mondayOf(day);
  const met = (d) => !!p.days[d]?.goalMet;
  const weekMet = (m) => Array.from({ length: 7 }, (_, i) => addDays(m, i)).filter(met).length >= p.daysPerWeek;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i);
    return { date: d, label: 'MTWTFSS'[i], met: met(d), today: d === day, future: d > day };
  });
  let streak = weekMet(mon) ? 1 : 0;
  let frozen = 0;
  let lastFreeze = -99;
  const first = mondayOf(p.created || day);
  for (let k = 1; ; k++) {
    const m = addDays(mon, -7 * k);
    if (m < first) break;
    if (weekMet(m)) streak++;
    else if (k - lastFreeze >= 4) {
      lastFreeze = k;
      frozen++;
    } else break;
  }
  return { days, count: days.filter((d) => d.met).length, target: p.daysPerWeek, streak, frozen, thisWeekMet: weekMet(mon) };
}

const PEAK_LABEL = {
  rollL: ['left tilt', 'deg'], rollR: ['right tilt', 'deg'],
  yawL: ['left turn', 'pct'], yawR: ['right turn', 'pct'],
  jaw: ['mouth opening', 'pct'], pucker: ['pucker', 'pct'], smile: ['smile', 'pct'],
};
const deg = (rad) => Math.round((rad * 180) / Math.PI);

// One line of real progress, compared with the player's own day 1.
export function progressLine(p) {
  let best = null;
  for (const [key, e] of Object.entries(p.peaks || {})) {
    if (e.bestDay === e.firstDay || !(e.first > 0)) continue;
    const gain = e.best / e.first - 1;
    if (gain >= 0.05 && (!best || gain > best.gain)) best = { key, e, gain };
  }
  if (!best) return Object.keys(p.peaks || {}).length ? 'Day 1 is measured. Come back another day to see your range grow.' : '';
  const [label, unit] = PEAK_LABEL[best.key] || [best.key, 'pct'];
  if (unit === 'deg') return `Your ${label} reached ${deg(best.e.best)}°, up from ${deg(best.e.first)}° on day 1.`;
  return `Your ${label} is ${Math.round(best.gain * 100)}% bigger than on day 1.`;
}

// Each measured movement: day 1 against your best, for the progress screen.
export function rangeRows(p) {
  return Object.entries(p.peaks || {}).map(([key, e]) => {
    const [label, unit] = PEAK_LABEL[key] || [key, 'pct'];
    const gain = e.first > 0 ? Math.max(0, Math.round((e.best / e.first - 1) * 100)) : 0;
    return {
      key,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      frac: e.best > 0 ? e.first / e.best : 1,
      text: unit === 'deg' ? `${deg(e.first)}° → ${deg(e.best)}°` : gain ? `+${gain}% since day 1` : 'Day 1 measured',
    };
  });
}

export const newer = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
