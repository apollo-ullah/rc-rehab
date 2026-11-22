// A lesson played on its own course. The car drives itself between gates and stops at
// each one. The rep at that gate opens it: a good rep sends the car off with a burst of
// speed, a miss still opens the gate (misses never block you). The lesson ends when the
// car crosses the finish line, so the course is the lesson.
// Pure logic: the phone uses it, and the tests drive every course with it.
import { newCar, step, MAX_SPEED } from './game.js';
import { GATE_STOP as STOP_GAP } from './tracks.js';
import { ArmChord, armDir, armsFor, needDir, CHORD_WIN } from './arms.js';

export { STOP_GAP };
const CRUISE = 0.72; // share of top speed between gates
const BRAKE = 320; // how hard it pulls up at a gate (units/s²)
const CORNER = 1.35; // radians per second of turning it takes corners at
const HALT = 700; // how fast it stops when the arms give the wrong direction (units/s²)
const DIR_TEXT = {
  fwd: ['Straight on', 'both arms'],
  right: ['Turn right', ''],
  left: ['Turn left', ''],
};

export class LessonCourse {
  // armSteer (arm path): between gates the car only moves while the arms give the direction the
  // road needs there (both = straight, one arm = a turn), so the real car never goes another way.
  constructor(track, run, { armSteer = null } = {}) {
    this.track = track;
    this.run = run;
    this.steer = armSteer ? { chord: new ArmChord(armSteer.win ?? CHORD_WIN), need: 'fwd', have: 'none', ok: false } : null;
    this.car = newCar(track);
    this.gates = track.gates.map((d) => ({ d, state: 'closed' }));
    this.gate = 0; // next gate to reach
    this.mode = 'drive'; // drive | gate | done
    this.burst = 0;
  }

  get stopAt() {
    return this.gate < this.gates.length ? this.gates[this.gate].d - STOP_GAP : Infinity;
  }

  update(sig, dt) {
    const { run, car, track } = this;
    const lost = !sig.face;
    let gateEvent = null;
    let view;
    let go = 0;

    if (this.mode === 'gate') {
      view = run.update(sig, dt);
      if (view.event) {
        const ok = view.event === 'good';
        this.gates[this.gate].state = ok ? 'good' : 'miss';
        gateEvent = { i: this.gate, ok };
        if (ok) this.burst = 1;
        this.gate++;
        this.mode = 'drive';
      }
    } else {
      // Let the last result finish showing while the car drives on. The next rep then
      // waits for the next gate, so the drive is the rest between reps.
      view = run.phase === 'result' && !run.done ? run.update(sig, dt) : run.view(sig, null, lost);
      if (this.mode === 'drive') {
        const left = this.stopAt - car.progress;
        let v = (this.burst > 0 ? 1 : CRUISE) * MAX_SPEED;
        const k = track.curvAhead(car.progress, 130);
        if (k > 0) v = Math.min(v, Math.max(70, CORNER / k));
        if (Number.isFinite(left)) v = Math.min(v, Math.sqrt(2 * BRAKE * Math.max(0, left - 2)));
        if (lost && !car.air) v = 0; // can't see you: the car waits
        const a = this.steer;
        if (a) {
          a.need = needDir(autoLine(car, track), a.need);
          a.have = armDir(a.chord.update(!lost && sig.l, !lost && sig.r, dt));
          a.ok = a.have === a.need;
          if (!a.ok && !car.air) {
            v = 0;
            car.v = Math.max(0, car.v - HALT * dt);
          }
        }
        go = Math.max(0, Math.min(1, v / MAX_SPEED));
        if (Number.isFinite(left) && (left < 3 || (left < 30 && car.v < 14)) && !car.air) {
          this.mode = 'gate';
          car.v = 0;
        }
      }
    }
    this.burst = Math.max(0, this.burst - dt);

    const ev = step(car, autoLine(car, track), go, dt, 0);
    if (car.finished && this.mode !== 'done' && this.gate >= this.gates.length) this.mode = 'done';
    return { view: this.hud(view, sig, lost), ev, gateEvent };
  }

  // For ?autopilot and tests: the arms that keep the car moving right now.
  botArms() {
    return this.steer && this.mode === 'drive' ? armsFor(this.steer.need) : null;
  }

  hud(view, sig, lost) {
    const n = this.gates.length;
    const out = { ...view, mode: this.mode, gate: this.gate, gates: this.gates, done: this.mode === 'done' };
    out.courseProgress = Math.min(1, this.car.progress / this.track.finishAt);
    if (this.mode === 'done') {
      out.cue = 'Finish!';
      out.sub = '';
    } else if (this.mode === 'drive') {
      if (lost) {
        out.cue = this.run.lostCue || "Can't see your face";
        out.sub = this.run.lostSub || 'Move back into view. The car waits for you.';
      } else if (!(this.run.phase === 'result' && !this.run.done)) {
        const r = this.run.rep;
        out.cue = this.gate < n ? `Gate ${this.gate + 1} of ${n}` : 'On to the finish!';
        out.sub = this.gate < n ? `Next: ${r.ready}` : 'Nice work. Enjoy the ride.';
        out.progress = 0;
        out.gauge = { ...out.gauge, band: null, hideDot: out.gauge.hideDot };
        const a = this.steer;
        if (a) {
          const want = armsFor(a.need);
          const arms = want.l && want.r ? 'both arms' : want.l ? 'left arm' : 'right arm';
          out.cue = `${DIR_TEXT[a.need][0]}: ${arms}`;
          out.sub = a.ok ? (this.gate < n ? `Driving to gate ${this.gate + 1} of ${n}` : 'Driving to the finish')
            : a.have === 'none' ? 'The car waits until you squeeze.'
            : 'Not that way: the car waits.';
          out.gauge = { ...out.gauge, hideDot: false, want: { l: want.l ? 'on' : 'off', r: want.r ? 'on' : 'off' } };
        }
      }
    }
    return out;
  }
}

// Steering that follows the road, looking a little further ahead at speed.
function autoLine(car, track) {
  const ahead = 70 + car.v * 0.25;
  const p = track.pointAt(car.progress + ahead);
  const want = Math.atan2(p.y - car.y, p.x - car.x);
  const diff = Math.atan2(Math.sin(want - car.h), Math.cos(want - car.h));
  return Math.max(-1, Math.min(1, diff * 3));
}
