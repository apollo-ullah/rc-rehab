// The arm path's lessons and rep engine. The only input is two yes/no signals from EMG sensors
// on the biceps: { l: is the left biceps flexing?, r: is the right?, face: is the sensor online? }.
// ArmRun has the same interface as LessonRun (path.js), so lesson courses, the lesson screen and
// scoring are shared with the head path. See docs/arm-path.md.
import { UNITS, REPS_PER_LESSON, lessonsOf, isGold, pathOf } from './path.js';
import { MAX_SPEED, TURN_RATE } from './game.js';

const OTHER = { l: 'r', r: 'l' };
const NAME = { l: 'left', r: 'right', both: 'both' };
const ARM = { l: 'Left arm', r: 'Right arm', both: 'Both arms' };
// A flex has to last 60 ms to count, and a dropout shorter than 150 ms is ignored, so sensor
// flicker doesn't break a hold or count as a rep.
const ON_DELAY = 0.06;
const OFF_DELAY = 0.15;
const GOOD = ['Good!', 'Nice!', 'Yes!', 'Great!'];
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const pickInt = (rng, n) => Math.floor(rng() * n);
const shuffle = (a, rng) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = pickInt(rng, i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// One rep per lesson key: (knob value, arm, rng) -> rep. arm is 'l' | 'r' | 'both'.
const REPS = {
  // Unit 1 · Wake up
  squeeze: (v, arm) => ({ kind: 'squeeze', arm, hold: v, cue: `Squeeze ${NAME[arm]}`, sub: 'Keep it on for a moment.', ready: `squeeze your ${NAME[arm]} arm` }),
  release: (v, arm) => ({ kind: 'release', arm, pre: 1, limit: v, stay: 1.5, cue: `Squeeze ${NAME[arm]}`, sub: 'Then let go when it says.', ready: `squeeze your ${NAME[arm]} arm, then let go` }),
  hold: (v, arm) => ({ kind: 'hold', arm, hold: v, cue: `Hold ${NAME[arm]}`, sub: 'Keep it on. Letting go pauses the clock.', ready: `hold your ${NAME[arm]} arm for ${v} s` }),
  quick: (v, arm) => ({ kind: 'quick', arm, limit: v, after: 0, cue: `Quick! ${ARM[arm]}`, sub: 'Then relax.', ready: `squeeze your ${NAME[arm]} arm fast` }),
  // Unit 2 · Hold strong
  longhold: (v, arm) => REPS.hold(v, arm),
  holdgo: (v, arm) => ({ ...REPS.release(1.5, arm), pre: v, sub: `Hold ${v} s, then let go when it says.`, ready: `hold your ${NAME[arm]} arm, then let go` }),
  bothhold: (v) => ({ ...REPS.hold(v, 'both'), cue: 'Hold both', ready: `hold both arms for ${v} s` }),
  loose: (v) => ({ kind: 'relax', arm: 'both', hold: v, cue: 'Stay loose', sub: 'Keep both arms relaxed.', ready: `keep both arms loose for ${v} s` }),
  // Unit 3 · Curls
  curl: (v, arm) => ({ kind: 'curl', arm, win: v, up: 2, down: 2, cue: 'Up!', sub: `Squeeze ${NAME[arm]} and keep it up.`, ready: `curl your ${NAME[arm]} arm: up, then down` }),
  pause: (v, arm) => ({ ...REPS.curl(1, arm), up: v, ready: `curl your ${NAME[arm]} arm and pause at the top` }),
  bothcurl: (v) => ({ ...REPS.curl(v, 'both'), sub: 'Squeeze both and keep them up.', ready: 'curl both arms: up, then down' }),
  fastup: (v, arm) => ({ ...REPS.quick(v, arm), after: 1, cue: `Up! ${ARM[arm]}`, sub: 'Fast up, hold 1 s, then relax.', ready: `squeeze your ${NAME[arm]} arm fast and hold` }),
  // Unit 4 · Left and right
  solo: (v, arm) => ({ kind: 'solo', arm, hold: 1, allow: v, cue: `Just ${NAME[arm]}`, sub: `Keep your ${NAME[OTHER[arm]]} arm loose.`, ready: `squeeze only your ${NAME[arm]} arm` }),
  swap: (v, arm) => ({ kind: 'swap', arm, limit: v, cue: `Squeeze ${NAME[arm]}`, sub: `Then let go and squeeze ${NAME[OTHER[arm]]}.`, ready: `squeeze ${NAME[arm]}, then switch to ${NAME[OTHER[arm]]}` }),
  together: (v) => ({ kind: 'both', arm: 'both', win: v, hold: 1, cue: 'Both together!', sub: 'Squeeze both at the same moment.', ready: 'squeeze both arms together' }),
  which: (v, arm) => ({ ...REPS.quick(v, arm), strict: true, sub: `Only your ${NAME[arm]} arm.`, ready: 'squeeze the arm it names, fast' }),
};
const BOTH_ONLY = new Set(['bothhold', 'loose', 'bothcurl', 'together']);

// Builds a 10-rep arm lesson. Same shape as path.js buildLesson.
export function buildArmLesson(p, ui, li, { rng = Math.random } = {}) {
  const unit = UNITS[ui];
  const info = unit.lessons[li];
  // Arms alternate evenly; quick cues come in random order so they can't be guessed.
  let arms = Array.from({ length: REPS_PER_LESSON }, (_, i) => (i % 2 ? 'r' : 'l'));
  if (rng() < 0.5) arms = arms.map((a) => OTHER[a]);
  if (['quick', 'which', 'fastup'].includes(info.key)) arms = shuffle(arms, rng);
  const prev = UNITS[ui - 1];
  const reps = [];
  for (let i = 0; i < REPS_PER_LESSON; i++) {
    let u = unit;
    let key = info.key;
    if (key === 'mix') {
      if (prev && pathOf(prev) === 'arms' && (i === 3 || i === 7)) {
        u = prev; // spaced review from the unit before
        key = prev.lessons[pickInt(rng, 4)].key;
      } else {
        key = unit.lessons[pickInt(rng, 4)].key;
      }
    }
    const idx = u.lessons.findIndex((l) => l.key === key);
    let level = lessonsOf(p, u.id)[idx].level;
    if (i === 0) level = Math.max(0, level - 2); // warm-up rep
    if (info.key === 'mix' && /hold/.test(key)) level = Math.min(level, 2); // keep mixes brisk
    const arm = BOTH_ONLY.has(key) ? 'both' : arms[i];
    reps.push({ ...REPS[key](u.lessons[idx].knob.value(level), arm, rng), lesson: key, unit: u.id });
  }
  const l = lessonsOf(p, unit.id)[li];
  // Faded feedback: once a lesson is going well, every third rep hides your arms' lights.
  const feel = isGold(l) || l.level >= 3 ? [2, 5, 8] : [];
  return { reps, feel, title: `${unit.title} · ${info.title}`, unit: unit.id, kind: info.key, arms: true };
}

export class ArmRun {
  constructor(lesson, { rng = Math.random } = {}) {
    this.reps = lesson.reps.map((r) => ({ ...r }));
    this.feel = new Set(lesson.feel || []);
    this.rng = rng;
    this.i = 0;
    this.results = [];
    this.done = false;
    this.bumps = 0;
    this.lostMs = 0;
    this.on = { l: false, r: false }; // debounced flex state
    this.deb = { l: 0, r: 0 };
    this.lostCue = 'Arm sensor offline';
    this.lostSub = 'Check the sensor. The car waits for you.';
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
    this.waited = 0;
    this.cur = { held: 0, dwell: 0, react: null, other: 0, sub: null, step: 0, onT: 0, offT: 0, upAt: null, downAt: null, upOk: false, first: null, synced: false, late: null };
  }

  debounce(s, dt) {
    for (const k of ['l', 'r']) {
      const raw = !!s[k];
      if (raw === this.on[k]) {
        this.deb[k] = 0;
        continue;
      }
      this.deb[k] += dt;
      if (this.deb[k] >= (raw ? ON_DELAY : OFF_DELAY)) {
        this.on[k] = raw;
        this.deb[k] = 0;
      }
    }
  }

  // Is the rep's arm on? For 'both', both must be.
  isOn(arm) {
    return arm === 'both' ? this.on.l && this.on.r : this.on[arm];
  }
  // Is the rep's arm fully off? For 'both', both must be.
  isOff(arm) {
    return arm === 'both' ? !this.on.l && !this.on.r : !this.on[arm];
  }
  get anyOn() {
    return this.on.l || this.on.r;
  }

  update(s, dt) {
    if (this.done) return this.view(s, null);
    if (!s.face) {
      this.lostMs += dt * 1000;
      return this.view(s, null, true);
    }
    this.debounce(s, dt);
    const r = this.rep;
    this.t += dt;
    let event = null;
    if (this.phase === 'rest') {
      this.restT = this.anyOn ? 0 : this.restT + dt;
      // Start once relaxed, or after 4 s anyway: some arms can't fully relax, and that's fine.
      if ((this.restT >= 0.3 && this.t >= 0.6) || this.t >= 4) {
        this.phase = r.kind === 'quick' ? 'wait' : 'go';
        this.t = 0;
      }
    } else if (this.phase === 'wait') {
      this.waited = (this.waited || 0) + dt;
      if (this.anyOn) this.t = 0; // squeezed early: wait again, no penalty
      if (this.waited > 8 + this.waitFor) {
        // Couldn't relax for the cue: move on rather than wait forever.
        event = 'miss';
        this.finishRep(false);
      } else if (this.t >= this.waitFor) {
        this.phase = 'go';
        this.t = 0;
      }
    } else if (this.phase === 'go') {
      const ok = this.track(r, this.cur, dt);
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
  track(r, c, dt) {
    const on = this.isOn(r.arm);
    const otherOn = r.arm !== 'both' && this.on[OTHER[r.arm]];
    if (c.react === null && on && r.kind !== 'relax' && r.kind !== 'swap') c.react = this.t;
    switch (r.kind) {
      case 'squeeze':
        c.dwell = on ? c.dwell + dt : 0;
        if (c.dwell >= r.hold) return true;
        return this.t > 7 + r.hold ? false : null;
      case 'hold':
        // Time on adds up; letting go pauses the clock instead of resetting it.
        if (on) c.held += dt;
        if (c.held >= r.hold) return true;
        return this.t > r.hold + 8 ? false : null;
      case 'relax':
        if (!this.anyOn) c.held += dt;
        if (c.held >= r.hold) return true;
        return this.t > r.hold + 8 ? false : null;
      case 'release': {
        if (c.sub !== 'let') {
          c.dwell = on ? c.dwell + dt : 0;
          if (c.dwell >= r.pre) {
            c.sub = 'let';
            c.dwell = 0;
            this.t = 0;
          }
          return this.t > 7 + r.pre ? false : null;
        }
        // Good when the arm went quiet within the limit and stayed quiet for `stay` seconds.
        c.dwell = this.isOff(r.arm) ? c.dwell + dt : 0;
        if (c.dwell >= r.stay) return this.t - c.dwell <= r.limit + OFF_DELAY;
        return this.t > r.limit + r.stay + 1.5 ? false : null;
      }
      case 'quick': {
        if (c.react === null) {
          if (r.strict && otherOn) return false; // squeezed the other arm
          return this.t > r.limit ? false : null;
        }
        c.dwell = on ? c.dwell + dt : 0;
        if (c.dwell >= r.after) return true;
        return this.t > c.react + r.after + 3 ? false : null;
      }
      case 'curl': {
        // Up for `up` seconds, then down for `down` seconds. Each half: start within the window,
        // then stay there most of the time.
        if (c.sub !== 'down') {
          if (on) c.onT += dt;
          if (on && c.upAt === null) c.upAt = this.t;
          if (this.t >= r.up) {
            c.upOk = c.upAt !== null && c.upAt <= r.win && c.onT >= (r.up - r.win) * 0.8;
            c.sub = 'down';
            this.t = 0;
          }
          return null;
        }
        const off = this.isOff(r.arm);
        if (off) c.offT += dt;
        if (off && c.downAt === null) c.downAt = this.t;
        if (this.t >= r.down) return c.upOk && c.downAt !== null && c.downAt <= r.win + OFF_DELAY && c.offT >= (r.down - r.win) * 0.8;
        return null;
      }
      case 'solo':
        if (otherOn) c.other += dt;
        c.dwell = on ? c.dwell + dt : 0;
        if (c.dwell >= r.hold) return c.other <= r.allow + 1e-6;
        return this.t > 7 + r.hold ? false : null;
      case 'swap': {
        const [a, b] = [r.arm, OTHER[r.arm]];
        const want = c.step === 0 ? a : b;
        c.dwell = this.on[want] && !this.on[want === a ? b : a] ? c.dwell + dt : 0;
        if (c.step === 0 && c.dwell >= 0.3) {
          c.step = 1;
          c.dwell = 0;
          c.react = this.t; // time to the first squeeze
        } else if (c.step === 1 && c.dwell >= 0.3) {
          return this.t - (c.react ?? 0) <= r.limit + 0.3;
        }
        return this.t > 7 + r.limit ? false : null;
      }
      case 'both': {
        const { l, r: rr } = this.on;
        if (!l && !rr) {
          c.first = null;
          c.synced = false;
          c.dwell = 0;
        } else if (c.first === null) {
          c.first = this.t;
        }
        if (l && rr && !c.synced && c.late !== c.first) {
          if (this.t - c.first <= r.win) c.synced = true;
          else c.late = c.first; // too far apart: let go of both and try again
        }
        if (c.synced) {
          c.dwell = l && rr ? c.dwell + dt : 0;
          if (c.dwell >= r.hold) return true;
        }
        return this.t > 9 ? false : null;
      }
    }
    return false;
  }

  finishRep(ok) {
    const r = this.rep;
    const c = this.cur;
    this.results.push({ ok, lesson: r.lesson, kind: r.kind, arm: r.arm, react: c.react, held: c.held, hold: r.hold || 0, other: c.other, feel: this.feel.has(this.i) });
    this.phase = 'result';
    this.t = 0;
    this._fatigue = undefined;
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

  // Which arms an ideal player would have on right now (drives ?autopilot and the tests).
  want() {
    const r = this.rep;
    const c = this.cur;
    const set = (arm) => ({ l: arm === 'l' || arm === 'both', r: arm === 'r' || arm === 'both' });
    if (this.done || this.phase !== 'go') return set(null);
    switch (r.kind) {
      case 'relax': return set(null);
      case 'release': return set(c.sub === 'let' ? null : r.arm);
      case 'curl': return set(c.sub === 'down' ? null : r.arm);
      case 'swap': return set(c.step === 0 ? r.arm : OTHER[r.arm]);
      case 'quick': return set(c.react === null || c.dwell < r.after ? r.arm : null);
      default: return set(r.arm);
    }
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
      cue = this.lostCue;
      sub = 'Check the sensor. The clock is paused.';
      drive = 0;
    } else if (this.phase === 'rest') {
      cue = 'Relax your arms';
      sub = `Next: ${r.ready}`;
    } else if (this.phase === 'wait') {
      cue = 'Wait for it…';
      sub = `Get ready to ${r.ready}`;
    } else if (this.phase === 'go') {
      switch (r.kind) {
        case 'squeeze':
        case 'solo':
          progress = c.dwell / r.hold;
          if (r.kind === 'solo' && c.other > r.allow) sub = `Try to keep your ${NAME[OTHER[r.arm]]} arm loose.`;
          break;
        case 'hold':
        case 'relax':
          progress = c.held / r.hold;
          drive = (r.kind === 'hold' ? this.isOn(r.arm) : !this.anyOn) ? 0.55 : 0.15;
          break;
        case 'release':
          if (c.sub === 'let') {
            cue = 'Let go!';
            sub = 'Relax fully and stay relaxed.';
            progress = c.dwell / r.stay;
          } else {
            progress = c.dwell / r.pre;
          }
          break;
        case 'quick':
          progress = c.react === null ? Math.max(0, 1 - this.t / r.limit) : r.after ? c.dwell / r.after : 1;
          break;
        case 'curl':
          if (c.sub === 'down') {
            cue = 'Down';
            sub = 'Relax and stay down.';
            progress = this.t / r.down;
          } else {
            progress = this.t / r.up;
          }
          break;
        case 'swap':
          if (c.step === 1) {
            cue = `Now ${NAME[OTHER[r.arm]]}!`;
            sub = `Let go of your ${NAME[r.arm]} arm.`;
          }
          progress = (c.step + c.dwell / 0.3) / 2;
          break;
        case 'both':
          progress = c.dwell / r.hold;
          if (c.late !== null && !c.synced) sub = 'Let go of both, then squeeze them together.';
          break;
      }
      if (feelNow) sub = 'Feel it: no lights on this one.';
    } else if (this.phase === 'result') {
      const res = this.results[this.results.length - 1];
      cue = res.ok ? (res.kind === 'hold' ? 'Strong!' : res.kind === 'relax' ? 'Nice and loose!' : GOOD[this.results.length % GOOD.length]) : 'Keep going';
      sub = res.ok ? '' : "That one didn't count. No problem.";
      if (res.feel && res.kind === 'hold') sub = `You held it for ${res.held.toFixed(1)} s.`;
      drive = res.ok ? 0.5 : 0.15;
    }
    const w = this.want();
    const wantOf = (k) => (this.done || lost ? null : this.phase === 'go' ? (w[k] ? 'on' : 'off') : 'off');
    return {
      i: Math.min(this.i, this.reps.length - 1),
      n: this.reps.length,
      phase: this.phase,
      cue,
      sub,
      gauge: { type: 'arms', l: this.on.l, r: this.on.r, want: { l: wantOf('l'), r: wantOf('r') }, band: null, hideDot: feelNow },
      progress: Math.max(0, Math.min(1, progress)),
      event,
      done: this.done,
      results: this.results,
      drive,
      lost,
      fatigue: this.fatigue(),
    };
  }

  // Two warning signs at once = probably tired: slower starts, good reps turning into misses,
  // or the sensor keeps dropping out.
  fatigue() {
    if (this._fatigue !== undefined) return this._fatigue;
    const R = this.results;
    if (R.length < 6) return (this._fatigue = false);
    const a = R.slice(0, 3);
    const b = R.slice(-3);
    const avg = (xs) => {
      const v = xs.map((r) => r.react).filter((x) => x != null && x > 0);
      return v.length ? mean(v) : null;
    };
    let flags = 0;
    const [ra, rb] = [avg(a), avg(b)];
    if (ra && rb && rb > ra * 1.3) flags++;
    if (a.filter((r) => r.ok).length >= 2 && b.every((r) => !r.ok)) flags++;
    if (R.slice(-4).filter((r) => !r.ok).length >= 3) flags++;
    if (this.lostMs > 5000) flags++;
    return (this._fatigue = flags >= 2);
  }

  summary() {
    const R = this.results;
    const good = R.filter((r) => r.ok).length;
    const reacts = R.filter((r) => ['quick', 'squeeze', 'solo', 'both'].includes(r.kind)).map((r) => r.react).filter((x) => x != null);
    const holds = R.filter((r) => r.kind === 'hold' && r.ok).map((r) => r.hold);
    return {
      good,
      total: R.length,
      rate: R.length ? good / R.length : 0,
      peaks: {},
      reactMs: reacts.length ? Math.round(mean(reacts) * 1000) : null,
      longestHoldS: holds.length ? Math.max(...holds) : null,
      fatigue: this.fatigue(),
      bumps: 0,
      lostMs: Math.round(this.lostMs),
    };
  }
}

// What each arm boss race does with the two signals. Returns { steer, go, boost } (boost: start one).
// st keeps the race's own state between frames ({ heldFor, lastOn, lastBoost }).
export function armRaceControl(level, sig, st, dt, autoSteer) {
  const on = sig.face && (sig.l || sig.r);
  const now = (st.t = (st.t || 0) + dt);
  switch (level) {
    case 'a1': // Flex Sprint: squeeze either arm to drive
      return { steer: autoSteer, go: on ? 0.9 : 0 };
    case 'a2': { // Long Haul: moves while you hold, a boost every 3 s held
      st.heldFor = on ? (st.heldFor || 0) + dt : 0;
      const boost = on && st.heldFor >= 3;
      if (boost) st.heldFor = 0;
      return { steer: autoSteer, go: on ? 0.6 : 0, boost };
    }
    case 'a3': { // Pump Track: rolls by itself, each new squeeze boosts
      const rising = on && !st.lastOn;
      st.lastOn = on;
      const boost = rising && now - (st.lastBoost ?? -9) > 1.2;
      if (boost) st.lastBoost = now;
      return { steer: autoSteer, go: sig.face ? 0.45 : 0, boost };
    }
    case 'a4': { // Arm Grand Prix: each arm drives its own side's wheels, both = full speed straight
      st.chord ??= new ArmChord(st.win ?? CHORD_WIN);
      const c = (st.cmd = st.chord.update(sig.face && sig.l, sig.face && sig.r, dt));
      if (c.l && c.r) return { steer: 0, go: 1 };
      if (c.l || c.r) return { steer: c.l ? LEFT_ARM_STEER : -LEFT_ARM_STEER, go: ARC_GO };
      return { steer: 0, go: 0 };
    }
  }
  return { steer: 0, go: 0 };
}

// ---------- Driving with both arms, and the real car ----------
// Like Free Flex (arm-lab): each biceps drives the wheels on its own side of the car. The left
// arm alone turns the car right, the right arm alone turns it left, both drive straight.
export const LEFT_ARM_STEER = 1;
export const ARC_GO = 0.65; // one arm: a gentle forward curve, not a spin
// A two-arm squeeze holds straight until both arms rest. The deadline never
// moves when an arm drops out or comes back during the same squeeze.
export class StraightHold {
  constructor() {
    this.deadline = null;
    this.needsRest = false;
  }
  update(flex, now, live, confirmedRest = true) {
    const [left, right] = flex;
    if (!live) {
      this.deadline = null;
      this.needsRest = true;
      return [false, false];
    }
    if (!left && !right) {
      if (this.needsRest && !confirmedRest) return [false, false];
      this.deadline = null;
      this.needsRest = false;
      return flex;
    }
    if (this.deadline !== null && now >= this.deadline) this.needsRest = true;
    if (this.needsRest) return [false, false];
    if (left && right && this.deadline === null) this.deadline = now + 8000;
    return this.deadline === null ? flex : [true, true];
  }
}

export const CHORD_WIN = 0.25; // seconds

// Nobody starts or stops both arms at exactly the same moment. One arm on its own only counts
// as a turn after `win` seconds alone; both arms (forward) and no arms (stop) count at once.
// So the left arm starting a moment before the right still drives straight, and letting go of
// one arm a moment before the other doesn't swerve the car.
export class ArmChord {
  constructor(win = CHORD_WIN) {
    this.win = win;
    this.out = 0; // 0 none, 1 left, 2 right, 3 both
    this.pend = 0;
    this.t = 0;
  }
  update(l, r, dt) {
    const k = (l ? 1 : 0) | (r ? 2 : 0);
    const waits = (k === 1 || k === 2) && (this.out === 0 || this.out === 3);
    if (!waits) {
      this.out = k;
      this.pend = 0;
      this.t = 0;
    } else {
      if (this.pend !== k) {
        this.pend = k;
        this.t = 0;
      }
      this.t += dt;
      if (this.t >= this.win - 1e-6) {
        this.out = k;
        this.pend = 0;
        this.t = 0;
      }
    }
    return { l: !!(this.out & 1), r: !!(this.out & 2) };
  }
}

// The real car (measured): 1 m in 1 s at full power, 12.5 cm between the left and right wheels,
// 9 cm between front and back wheels. A 4-wheel car steered by its sides scrubs its tyres
// sideways in a turn, so it turns about as if its wheels were 1.4x further apart.
export const REAL_CAR = { topCmS: 100, trackCm: 12.5, wheelbaseCm: 9, skid: 1.4 };
const effTrack = (c = REAL_CAR) => c.trackCm * c.skid;
// Turn rate (rad/s, + = right) and forward speed (cm/s) for wheel power l, r (0..1 each).
export function realMotion(l, r, c = REAL_CAR) {
  return { cmS: ((l + r) / 2) * c.topCmS, yaw: ((l - r) * c.topCmS) / effTrack(c) };
}

// Real-car settings. speed: wheel power when the game car is at full speed (lower = slower real car).
// turn: 1 = the car geometry above; raise it if the real car turns less than the game, lower it if more.
export const CAR_TUNE = { follow: true, speed: 0.45, turn: 1, chord: CHORD_WIN, swapWheels: false };
// Below about 20% power the real car's wheels don't turn at all, so whenever the game car really
// moves, no wheel gets less than this.
export const MIN_WHEEL = 0.4;

// The game car's real movement -> power for the left and right wheels (0..1 each).
// speed: forward speed as a share of the game's top speed. yaw: turn rate in rad/s, + = right.
// The real car turns as fast as the game car and drives a smaller copy of its path. It mirrors
// what the game car actually does, so a game car stuck on a wall stops the real car. A slow game
// car still gets MIN_WHEEL on both wheels, so the real car never stalls on a valid move.
export function wheelMix(speed, yaw, tune = CAR_TUNE, car = REAL_CAR) {
  const s = Math.max(0, Math.min(1.3, speed)) * tune.speed;
  const d = (Math.max(-4, Math.min(4, yaw)) * effTrack(car) * tune.turn) / car.topCmS;
  if (s < 0.01 && Math.abs(d) < 0.01) return { l: 0, r: 0 };
  let l = s + d / 2;
  let r = s - d / 2;
  // The wheels only go forward: keep the turn and add a little forward instead.
  if (r < 0) {
    l -= r;
    r = 0;
  }
  if (l < 0) {
    r -= l;
    l = 0;
  }
  // Too little power to move: lift both wheels together until the slower one is at MIN_WHEEL.
  // The difference between them (the turn rate) stays the same; only forward speed goes up.
  const lift = Math.max(0, MIN_WHEEL - Math.min(l, r));
  l += lift;
  r += lift;
  // More than full power: keep the turn and take away forward (never below MIN_WHEEL).
  const over = Math.max(l, r) - 1;
  if (over > 0) {
    l = Math.max(MIN_WHEEL, l - over);
    r = Math.max(MIN_WHEEL, r - over);
  }
  return tune.swapWheels ? { l: r, r: l } : { l, r };
}

// Which way the arms point the car (Free Flex: left arm = left wheels = turn right).
export function armDir(c) {
  if (c.l && c.r) return 'fwd';
  if (!c.l && !c.r) return 'none';
  return (c.l ? LEFT_ARM_STEER : -LEFT_ARM_STEER) > 0 ? 'right' : 'left';
}
// The arms that give a direction: 'fwd' = both, 'right' / 'left' = one.
export function armsFor(dir) {
  const rightArm = LEFT_ARM_STEER > 0 ? 'l' : 'r';
  if (dir === 'fwd') return { l: true, r: true };
  if (dir === 'right') return { l: rightArm === 'l', r: rightArm === 'r' };
  if (dir === 'left') return { l: rightArm === 'r', r: rightArm === 'l' };
  return { l: false, r: false };
}
// The direction the road needs, from the steering that would follow it (-1..1). Keeps a turn
// until the road is nearly straight again, so the cue doesn't flicker.
export function needDir(steer, prev = 'fwd') {
  if (prev === 'right' && steer > 0.15) return 'right';
  if (prev === 'left' && steer < -0.15) return 'left';
  return steer > 0.4 ? 'right' : steer < -0.4 ? 'left' : 'fwd';
}

// The game car's steady one-arm curve, for the quarter-turn test.
export function arcMotion() {
  const v = ARC_GO * MAX_SPEED;
  const grip = Math.min(1, v / 70) * (1 - 0.3 * Math.min(1, v / MAX_SPEED));
  return { speed: ARC_GO, yaw: TURN_RATE * grip };
}

// Old car firmware can only press a wheel button or release it. Pressing it for part of the time
// (a share of each tick) slows the car down: on average the button is held for `duty`.
export class Pulser {
  constructor() {
    this.acc = 0;
  }
  next(duty) {
    if (duty <= 0.02) {
      this.acc = 0;
      return false;
    }
    if (duty >= 0.98) return true;
    this.acc += duty;
    if (this.acc >= 1) {
      this.acc -= 1;
      return true;
    }
    return false;
  }
}

// ---------- Biceps envelope -> flexing or not (from Free Flex's BinarySwitch) ----------
const median = (v) => {
  const a = [...v].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export function band(values) {
  const a = [...values].sort((x, y) => x - y);
  return { low: a[Math.floor(a.length * 0.1)], mid: median(a), high: a[Math.floor(a.length * 0.9)] };
}
// Relaxed and squeezing samples of one arm -> thresholds, or { error }.
// "Flexing" starts at 65% of the way from relaxed to squeezing and ends below 35%.
export function armProfile(restSamples, flexSamples) {
  if (restSamples.length < 30 || flexSamples.length < 30) return { error: 'too few readings' };
  const rest = band(restSamples);
  const flex = band(flexSamples);
  // Clear gap between the two bands, or failing that, clearly different middles.
  const [lo, hi] = rest.high < flex.low ? [rest.high, flex.low] : [rest.mid, flex.mid];
  if (hi - lo < 25) return { error: 'squeezing looks the same as relaxed' };
  return { rest: rest.mid, flex: flex.mid, on: lo + 0.65 * (hi - lo), off: lo + 0.35 * (hi - lo) };
}
// Median of the last 5 readings, and a change only counts once it lasts a moment.
export class FlexSwitch {
  constructor(profile, { onMs = 150, offMs = 200 } = {}) {
    this.profile = profile;
    this.onMs = onMs;
    this.offMs = offMs;
    this.reset();
  }
  reset() {
    this.active = false;
    this.win = [];
    this.since = null;
    this.lastMs = null;
  }
  update(adc, ms) {
    if (this.lastMs != null && (ms - this.lastMs > 150 || ms < this.lastMs)) this.reset();
    this.lastMs = ms;
    this.win.push(adc);
    if (this.win.length > 5) this.win.shift();
    const level = median(this.win);
    const change = this.active ? level <= this.profile.off : level >= this.profile.on;
    if (!change) this.since = null;
    else {
      this.since ??= ms;
      if (ms - this.since >= (this.active ? this.offMs : this.onMs)) {
        this.active = !this.active;
        this.since = null;
      }
    }
    return this.active;
  }
}
