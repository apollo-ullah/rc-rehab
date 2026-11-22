// End-to-end checks without hardware:
//  1. An autopilot can finish the course at every assist level.
//  2. Head calibration maps synthetic head poses to the right steer/go.
//  3. The practice path: every lesson, adaptive difficulty, mastery, open units, streaks.
//  3b. Every course: smooth, never crosses itself, and every lesson course is driven
//      gate by gate to its finish line.
//  4. A fake phone + fake ESP32 run a full race through the real server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { newCar, step, pointAt, ASSIST, STARS, TRACK_LENGTH, realSteer } from '../public/game.js';
import { buildCalibration, toIntent, toSignals, rangeFrom } from '../public/head.js';
import {
  UNITS, KINDS, buildLesson, LessonRun, newProfile, lessonsOf, nodeState, nextNode, recordLesson, recordBoss,
  addPractice, weekView, progressLine, addDays, achievements, pathProgress, xpLevel, unitsOf,
} from '../public/path.js';
import {
  buildArmLesson, ArmRun, armRaceControl, ArmChord, wheelMix, realMotion, arcMotion, CAR_TUNE, Pulser, FlexSwitch, armProfile, armDir,
} from '../public/arms.js';
import { LessonCourse } from '../public/course.js';
import { raceTrack, lessonTrack, selfIntersects, RACE_IDS, LESSON_GATES } from '../public/tracks.js';

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failed++;
};

// ---------- 1. Physics ----------
for (let level = 0; level < ASSIST.length; level++) {
  const car = newCar();
  let t = 0;
  let hits = 0;
  while (!car.finished && t < 120) {
    const target = pointAt(car.progress + 90);
    const want = Math.atan2(target.y - car.y, target.x - car.x);
    const diff = Math.atan2(Math.sin(want - car.h), Math.cos(want - car.h));
    const ev = step(car, Math.max(-1, Math.min(1, diff * 3)), 0.85, 1 / 60, level);
    if (ev.newHit) hits++;
    t += 1 / 60;
  }
  check(car.finished, `Autopilot finishes with "${ASSIST[level].name}" in ${t.toFixed(1)} s (${hits} wall hits, ${car.stars.length}/${STARS.length} stars)`);
}
{
  // Jumps: both ramps launch and land on the straight, boost pads fire, an air star is reachable.
  const car = newCar();
  const ev = { launch: 0, land: 0, boost: 0, maxZ: 0 };
  let t = 0;
  while (!car.finished && t < 120) {
    const target = pointAt(car.progress + 90);
    const diff = Math.atan2(Math.sin(Math.atan2(target.y - car.y, target.x - car.x) - car.h), Math.cos(Math.atan2(target.y - car.y, target.x - car.x) - car.h));
    const e = step(car, Math.max(-1, Math.min(1, diff * 3)), 1, 1 / 60, 1);
    if (e.launch) ev.launch++;
    if (e.land) ev.land++;
    if (e.boost) ev.boost++;
    ev.maxZ = Math.max(ev.maxZ, car.z);
    t += 1 / 60;
  }
  check(ev.launch === 2 && ev.land === 2, `Two jumps launch and land (peak height ${ev.maxZ.toFixed(0)})`);
  check(ev.boost === 3, `Three boost pads fire (${ev.boost})`);
  check(car.stars.some((i) => STARS[i].z > 0), 'A mid-air star can be collected');
}
{
  const car = newCar();
  for (let i = 0; i < 600; i++) step(car, 1, 1, 1 / 60, 0); // full lock forever
  check(!car.finished && car.progress < TRACK_LENGTH / 2, 'Driving in circles does not finish the course');
  const c2 = newCar();
  for (let i = 0; i < 300; i++) step(c2, 0, 0, 1 / 60, 0);
  check(c2.v === 0 && c2.throttleOut === 0, 'No GO movement = car stays still (real car gets 0 throttle)');
}

// ---------- 2. Calibration ----------
{
  const noise = () => (Math.random() - 0.5) * 0.01;
  const sample = (roll, yaw, jaw) => ({ roll: roll + noise(), yaw: yaw + noise(), go: { 'open mouth': jaw, 'raise eyebrows': 0.05, smile: 0.1, 'pucker lips': 0, 'puff cheeks': 0 } });
  const many = (fn) => Array.from({ length: 30 }, fn);
  const cal = buildCalibration({
    neutral: many(() => sample(0, 0, 0.02)),
    left: many(() => sample(0.3, 0.02, 0.02)), // this player tilts (roll) to steer
    right: many(() => sample(-0.28, -0.01, 0.02)),
    go: many(() => sample(0, 0, 0.7)),
  });
  check(cal.ok && cal.axis === 'roll' && cal.goKey === 'open mouth', `Calibration picks tilt + open mouth (${cal.axis}, ${cal.goKey})`);
  const L = toIntent(cal, sample(0.3, 0, 0.02));
  const R = toIntent(cal, sample(-0.28, 0, 0.7));
  const N = toIntent(cal, sample(0.01, 0, 0.04));
  check(L.steer < -0.9 && L.go === 0, `Head left -> steer ${L.steer.toFixed(2)}, go ${L.go.toFixed(2)}`);
  check(R.steer > 0.9 && R.go > 0.9, `Head right + mouth open -> steer ${R.steer.toFixed(2)}, go ${R.go.toFixed(2)}`);
  check(Math.abs(N.steer) < 0.01 && N.go === 0, 'Relaxed face -> no steer, no go');
  const small = (sens) => Math.abs(toIntent(cal, sample(0.3 * 0.4, 0, 0.02), sens).steer);
  check(small('gentle') < small('normal') && small('normal') < small('sharp') && small('normal') < 0.3,
    `A small head tilt (40%) steers gently: gentle ${small('gentle').toFixed(2)}, normal ${small('normal').toFixed(2)}, sharp ${small('sharp').toFixed(2)}`);
  // Grand Prix: head steers the car on screen, and the real car's on/off steering follows.
  {
    const FIRMWARE_THRESHOLD = 0.35;
    const half = toIntent(cal, sample(0.3 * 0.45, 0, 0.9), 'normal'); // 45% head tilt left + mouth open
    const car = newCar();
    for (let i = 0; i < 30; i++) step(car, half.steer, 1, 1 / 30);
    const h0 = newCar().h;
    const turned = Math.atan2(Math.sin(car.h - h0), Math.cos(car.h - h0));
    const sent = realSteer(car.steerOut);
    const wobble = realSteer(toIntent(cal, sample(0.3 * 0.2, 0, 0.02), 'normal').steer);
    check(half.go > 0.9 && turned < -0.05 && sent < -FIRMWARE_THRESHOLD && wobble === 0,
      `Head turn steers the Grand Prix car (heading ${turned.toFixed(2)} rad) and the real car presses LEFT (sent ${sent.toFixed(2)}); a 20% wobble sends nothing`);
  }
  const bad = buildCalibration({
    neutral: many(() => sample(0, 0, 0.02)),
    left: many(() => sample(0.01, 0, 0.02)),
    right: many(() => sample(0.0, 0, 0.02)),
    go: many(() => sample(0, 0, 0.7)),
  });
  check(!bad.ok, `Too-small head movement is rejected: "${bad.why}"`);
}

// ---------- 3. Practice path ----------
{
  // A simulated player who follows each rep's target (like ?autopilot), or one who does nothing.
  const play = (run, mode, { lostFor = 0 } = {}) => {
    let v = 0;
    let t = 0;
    const dt = 1 / 30;
    while (!run.done && t < 400) {
      const w = run.want();
      v += ((mode === 'ideal' ? w.value : 0) - v) * Math.min(1, dt * 5);
      const sg = { side: 0, still: 0, pitch: 0, jaw: 0, pucker: 0, smile: 0, raw: {}, face: t >= lostFor };
      if (w.sig === 'side' || w.sig === 'still') {
        sg.side = v * (w.dir || 1);
        sg.still = Math.abs(sg.side);
        sg.raw.side = sg.side * 0.3;
      } else {
        sg[w.sig] = v;
        sg.raw[w.sig] = v * 0.5;
      }
      run.update(sg, dt);
      t += dt;
    }
    return { t, ...run.summary() };
  };
  const p = newProfile('Test', '2026-11-16');
  let allIdeal = true;
  let idleMisses = true;
  for (const { ui } of unitsOf('head')) {
    for (let li = 0; li < KINDS.length; li++) {
      const a = play(new LessonRun(buildLesson(p, ui, li), { axis: 'roll' }), 'ideal');
      if (a.good !== 10 || a.total !== 10) allIdeal = false;
      const b = play(new LessonRun(buildLesson(p, ui, li), { axis: 'roll' }), 'idle');
      if (ui > 0 && li < 4 && b.good > 0) idleMisses = false;
      if (b.t >= 400) idleMisses = false; // a lesson must always end, even if nothing happens
    }
  }
  check(allIdeal, 'Every lesson in every unit can be completed 10/10');
  check(idleMisses, 'Doing nothing scores no reps on the movement units, and every lesson still ends');
  const still = play(new LessonRun(buildLesson(p, 0, 3), { axis: 'roll' }), 'idle');
  check(still.good === 0, 'Hold steady "Quick": never turning away does not count as coming back');
  const lost = new LessonRun(buildLesson(p, 1, 0), { axis: 'roll' });
  for (let i = 0; i < 600; i++) lost.update({ side: -1, face: false, raw: {} }, 1 / 30);
  check(lost.results.length === 0 && lost.lostMs > 19000, 'Losing the face pauses the lesson instead of scoring misses');

  // Fatigue: reactions slow down and moves shrink over the lesson.
  const tired = new LessonRun(buildLesson(p, 2, 0), { axis: 'roll' });
  tired.results = Array.from({ length: 9 }, (_, i) => ({ ok: i < 6, react: i < 3 ? 0.4 : 0.9, peak: i < 3 ? 1.1 : 0.7, jitter: null }));
  check(tired.fatigue(), 'Fatigue is flagged when reactions slow and moves shrink');

  // Adaptive difficulty: >=90% harder, <60% easier, otherwise the same.
  const q = newProfile('Q', '2026-11-16');
  const sum = (good) => ({ good, total: 10, rate: good / 10, peaks: {}, bumps: 0, ms: 60000 });
  recordLesson(q, 1, 1, sum(10), '2026-11-16');
  const up = lessonsOf(q, 'u2')[1].level;
  recordLesson(q, 1, 1, sum(7), '2026-11-16');
  const same = lessonsOf(q, 'u2')[1].level;
  const r = recordLesson(q, 1, 1, sum(4), '2026-11-16');
  check(up === 1 && same === 1 && lessonsOf(q, 'u2')[1].level === 0 && r.change === 'down', `Difficulty moves one step: 10/10 up, 7/10 same, 4/10 down ("${r.text}")`);
  const tiredOut = recordLesson(q, 1, 2, { ...sum(10), tired: true }, '2026-11-16');
  check(tiredOut.change === 'same' && lessonsOf(q, 'u2')[2].done, '"I\'m tired" still completes the lesson but never raises difficulty');

  // Gold = 80%+ on two different days.
  const g = newProfile('G', '2026-11-16');
  recordLesson(g, 0, 0, sum(9), '2026-11-16');
  recordLesson(g, 0, 0, sum(10), '2026-11-16');
  const sameDay = nodeState(g, 0, 0);
  recordLesson(g, 0, 0, sum(8), '2026-11-17');
  check(sameDay === 'done' && nodeState(g, 0, 0) === 'gold', 'Gold needs a good score on two different days, not twice in one day');

  // Everything is open from day one; the path only suggests what's next.
  const u = newProfile('U', '2026-11-16');
  const first = nextNode(u);
  const allOpen = UNITS.every((_, ui) => [0, 1, 2, 3, 4, 5].every((li) => ['open', 'next'].includes(nodeState(u, ui, li))));
  check(first.ui === 0 && first.li === 0 && nodeState(u, 0, 0) === 'next' && allOpen, 'A new player is pointed at Unit 1, lesson 1, and every unit and boss is already open');
  recordLesson(u, 2, 1, sum(8), '2026-11-16'); // jump straight to Open and close
  check(nodeState(u, 2, 1) === 'done' && nextNode(u).ui === 0, 'Playing ahead counts, and the suggestion stays on the first unfinished stop');
  for (let li = 0; li < 5; li++) recordLesson(u, 0, li, sum(8), '2026-11-16');
  const bossNext = nodeState(u, 0, 5) === 'next';
  const boss = recordBoss(u, 'u1', { ms: 40000 }, '2026-11-16');
  check(bossNext && boss.firstClear && boss.nextUp === 'Left and right' && nodeState(u, 1, 0) === 'next', 'After the five lessons the boss is suggested; clearing it points to Unit 2');
  const pp = pathProgress(u);
  check(pp.done === 7 && pp.total === 24, `Roadmap progress counts stops (${pp.done}/${pp.total})`);
  const ach = achievements(u, '2026-11-16');
  const got = (id) => ach.find((a) => a.id === id);
  check(got('warmup').done && got('first').done && !got('boss').done && got('boss').have === 1 && got('explorer').have === 2, 'Achievements track wins with progress (1 of 4 bosses, 2 of 4 units tried)');
  check(xpLevel(0).level === 1 && xpLevel(50).level === 2 && xpLevel(149).level === 2 && xpLevel(150).level === 3, 'XP levels: 50, 150, 300…');

  // Daily goal + weekly streak with one automatic freeze.
  const w = newProfile('W', '2026-10-26'); // a Monday
  w.goalMin = 5;
  const justMet = [addPractice(w, '2026-11-17', { ms: 200000 }), addPractice(w, '2026-11-17', { ms: 200000 }), addPractice(w, '2026-11-17', { ms: 200000 })];
  check(justMet.join() === 'false,true,false', 'Daily goal fires once, when the day crosses the goal');
  const meet = (mon) => [0, 1, 2, 3].forEach((i) => addPractice(w, addDays(mon, i), { ms: 400000 }));
  meet('2026-10-26');
  meet('2026-11-02'); // 2026-11-09 week missed -> frozen
  meet('2026-11-16');
  const wv = weekView(w, '2026-11-21');
  check(wv.streak === 3 && wv.frozen === 1 && wv.thisWeekMet, `Weekly streak survives one missed week (streak ${wv.streak}, frozen ${wv.frozen})`);
  const w2 = newProfile('W2', '2026-10-26');
  w2.goalMin = 5;
  [0, 1, 2, 3].forEach((i) => addPractice(w2, addDays('2026-10-26', i), { ms: 400000 }));
  check(weekView(w2, '2026-11-21').streak === 0, 'Two missed weeks in a row end the streak');

  // Progress line compares with the player's own day 1.
  const pr = newProfile('P', '2026-11-16');
  recordLesson(pr, 1, 0, { ...sum(9), peaks: { rollL: 0.26 } }, '2026-11-16');
  recordLesson(pr, 1, 0, { ...sum(9), peaks: { rollL: 0.36 } }, '2026-11-18');
  const line = progressLine(pr);
  check(/left tilt reached 21°, up from 15°/.test(line), `Progress line: "${line}"`);

  // Signals: each exercise scaled to the player's own range.
  const cal = { axis: 'roll', n: 0, l: 0.3, r: -0.3, pn: 0.5, fn: { 'open mouth': 0.05, 'pucker lips': 0.02, smile: 0.1 } };
  const m = (roll, pitch, jaw) => ({ roll, yaw: 0, pitch, go: { 'open mouth': jaw, 'pucker lips': 0.02, smile: 0.1 } });
  const sL = toSignals(cal, m(0.3, 0.5, 0.05), { jaw: 0.5 });
  const sJ = toSignals(cal, m(0, 0.5, 0.3), { jaw: 0.5 });
  const sN = toSignals(cal, m(0, 0.56, 0.05), { jaw: 0.5 });
  check(Math.abs(sL.side + 1) < 0.01 && sL.still > 0.99 && Math.abs(sJ.jaw - 0.5) < 0.01 && sN.still > 0.4 && sN.side === 0,
    `Signals: full left tilt = side ${sL.side.toFixed(2)}, half mouth = jaw ${sJ.jaw.toFixed(2)}, a nod moves "still" (${sN.still.toFixed(2)})`);
  const range = rangeFrom(Array.from({ length: 20 }, (_, i) => m(0, 0.5, 0.05 + i * 0.02)), cal, 'jaw');
  check(range > 0.3 && range < 0.4 && rangeFrom(Array.from({ length: 20 }, () => m(0, 0.5, 0.08)), cal, 'jaw') === null, `Face range measured from a "show me" (${range?.toFixed(2)}), tiny moves rejected`);
}

// ---------- 3b. Courses ----------
{
  for (const id of RACE_IDS) {
    const t = raceTrack(id);
    const car = newCar(t);
    let time = 0;
    let hits = 0;
    while (!car.finished && time < 120) {
      const p = t.pointAt(car.progress + 90);
      const diff = Math.atan2(Math.sin(Math.atan2(p.y - car.y, p.x - car.x) - car.h), Math.cos(Math.atan2(p.y - car.y, p.x - car.x) - car.h));
      if (step(car, Math.max(-1, Math.min(1, diff * 3)), 0.85, 1 / 60, 0, t).newHit) hits++;
      time += 1 / 60;
    }
    const ramps = t.features.filter((f) => f.type === 'ramp');
    const straightRamps = ramps.every((f) => Math.abs(Math.atan2(Math.sin(t.pointAt(f.at + f.len).h - t.pointAt(f.at).h), Math.cos(t.pointAt(f.at + f.len).h - t.pointAt(f.at).h))) < 0.2);
    check(car.finished && hits <= 1 && !selfIntersects(t, 1.3) && straightRamps,
      `Race course "${t.name}" (${id}): ${Math.round(t.length)} long, driven in ${time.toFixed(1)} s, ${hits} wall hits, ${ramps.length} jumps on straights`);
  }

  // Every lesson course, played by an ideal player: 10 gates, 10 good reps, ends at the finish line.
  const names = new Set();
  let all = true;
  let worst = '';
  for (const { ui } of unitsOf('head')) {
    for (let li = 0; li < KINDS.length; li++) {
      const t = lessonTrack(ui, li);
      names.add(t.name);
      const p = newProfile('C', '2026-11-16');
      const lesson = buildLesson(p, ui, li, { verb: 'Turn', rng: mulberry(ui * 10 + li + 1) });
      const run = new LessonRun(lesson, { axis: 'yaw', rng: mulberry(7) });
      const c = new LessonCourse(t, run);
      let time = 0;
      let hits = 0;
      let opened = 0;
      let doneBeforeFinish = false;
      let bot = 0;
      while (c.mode !== 'done' && time < 240) {
        const w = run.want();
        bot += (w.value - bot) * Math.min(1, (1 / 60) * 5);
        const s = idealSignals(w, bot);
        const out = c.update(s, 1 / 60);
        if (out.ev.newHit) hits++;
        if (out.gateEvent?.ok) opened++;
        if (run.done && c.gate < LESSON_GATES) doneBeforeFinish = true;
        time += 1 / 60;
      }
      const sumry = run.summary();
      const ok = c.mode === 'done' && t.gates.length === LESSON_GATES && opened === LESSON_GATES && sumry.good === 10 && !doneBeforeFinish && hits <= 2 && !selfIntersects(t) && c.car.finished;
      if (!ok) {
        all = false;
        console.log(`   ${t.id}: mode ${c.mode} gates ${t.gates.length} opened ${opened} good ${sumry.good} hits ${hits} time ${time.toFixed(1)}`);
      }
      if (!worst || time > Number(worst.split(' ')[1])) worst = `${t.id} ${time.toFixed(1)}`;
    }
  }
  check(all, `All 20 lesson courses: 10 gates each, every gate opened, lesson ends at the finish line (longest: ${worst} s)`);
  check(names.size === 20, 'Every lesson has its own named course');

  // A missed rep still opens the gate, and a lost face makes the car wait.
  const t = lessonTrack(1, 3);
  const run = new LessonRun(buildLesson(newProfile('M', '2026-11-16'), 1, 3, { rng: mulberry(3) }), { rng: mulberry(4) });
  const c = new LessonCourse(t, run);
  const idle = { side: 0, still: 0, pitch: 0, jaw: 0, pucker: 0, smile: 0, raw: { side: 0 }, face: true };
  let time = 0;
  while (c.gate < 1 && time < 30) {
    c.update(idle, 1 / 60);
    time += 1 / 60;
  }
  const missOpened = c.gates[0].state === 'miss';
  for (let i = 0; i < 60; i++) c.update(idle, 1 / 60); // drive on a bit
  const before = c.car.progress;
  for (let i = 0; i < 120; i++) c.update({ ...idle, face: false }, 1 / 60);
  const waited = c.car.progress - before < 60 && c.car.v < 5;
  check(missOpened && waited, 'A missed rep still opens the gate; when the face is lost the car pulls over and waits');
}

function mulberry(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function idealSignals(w, v) {
  const s = { side: 0, still: 0, pitch: 0, jaw: 0, pucker: 0, smile: 0, raw: { side: 0, jaw: 0, pucker: 0, smile: 0 }, axis: 'yaw', face: true };
  if (w.sig === 'side' || w.sig === 'still') {
    s.side = v * (w.dir || 1);
    s.still = Math.abs(s.side);
    s.raw.side = s.side * 0.3;
  } else {
    s[w.sig] = v;
    s.raw[w.sig] = v * 0.4;
  }
  return s;
}

// ---------- 3c. Moving the game to another server mid-turn (the cloud does this) ----------
{
  const { createArena } = await import('../server/arena.js');
  const store = { results: [], practice: [], addResult: (e) => store.results.push(e), addPractice: (e) => store.practice.push(e), reset() {} };
  const fake = () => {
    const c = { open: true, inbox: [], send: (t) => c.inbox.push(t), close: () => (c.open = false) };
    return c;
  };
  const got = (c, t) => c.inbox.filter((s) => s.startsWith('{') && JSON.parse(s).t === t).map((s) => JSON.parse(s));
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const opts = { store, carToken: 'x', adminKey: 'k', log: () => {} };
  const join = (arena, id) => {
    const c = fake();
    const h = arena.connect(c, 'web');
    h.message(JSON.stringify({ t: 'hello', role: 'player', id }));
    return { c, h };
  };

  // Handover during the countdown: the new server still says GO on time.
  const a = createArena(opts);
  const p1 = join(a);
  const id = got(p1.c, 'hello')[0].id;
  p1.h.message(JSON.stringify({ t: 'join', name: 'Ana', assist: 0 }));
  p1.h.message(JSON.stringify({ t: 'start' }));
  const snap1 = JSON.parse(JSON.stringify(a.snapshot()));
  a.dispose();
  const b = createArena(opts);
  b.restore(snap1);
  const p2 = join(b, id);
  await pause(3300);
  check(got(p2.c, 'hello')[0].driving === 'countdown' && got(p2.c, 'go').length === 1, 'A countdown carries on after the game moves to another server');

  // Handover mid-race: the run keeps going and the finish is saved.
  const snap2 = JSON.parse(JSON.stringify(b.snapshot()));
  b.dispose();
  const c = createArena(opts);
  c.restore(snap2);
  const p3 = join(c, id);
  p3.h.message(JSON.stringify({ t: 'finish', rawMs: 400, stars: 0, stats: {} }));
  check(got(p3.c, 'hello')[0].driving === 'racing' && got(p3.c, 'result').length === 1 && store.results.length === 1, 'A race in progress carries on after the game moves to another server');
  c.dispose();

  // Handover while it's someone's turn: they keep the turn, with time left to press start.
  const d = createArena(opts);
  const q1 = join(d, id);
  q1.h.message(JSON.stringify({ t: 'join', name: 'Ana', assist: 0 }));
  const snap3 = JSON.parse(JSON.stringify(d.snapshot()));
  d.dispose();
  const e = createArena(opts);
  e.restore(snap3);
  const q2 = join(e, id);
  const turn = got(q2.c, 'your_turn')[0];
  check(got(q2.c, 'hello')[0].driving === 'claim' && turn?.claimMs > 10000, 'Your turn survives the game moving to another server');
  e.dispose();
}

// ---------- 3d. Arm path: two yes/no biceps signals ----------
{
  const arms = unitsOf('arms');
  const dt = 1 / 60;
  const play = (run, policy) => {
    let t = 0;
    while (!run.done && t < 400) {
      run.update({ ...policy(run), face: true }, dt);
      t += dt;
    }
    return { t, ...run.summary() };
  };
  let ideal = true;
  let idle = true;
  let ends = true;
  let cheat = true;
  for (const lv of [0, 9]) {
    const p = newProfile('A', '2026-11-16');
    for (const { u } of arms) lessonsOf(p, u.id).forEach((l) => (l.level = lv));
    for (const { u, ui } of arms) {
      for (let li = 0; li < 5; li++) {
        const L = buildArmLesson(p, ui, li, { rng: mulberry(ui * 10 + li + lv) });
        const a = play(new ArmRun(L, { rng: mulberry(5) }), (r) => r.want());
        if (a.good !== 10 || a.total !== 10) {
          ideal = false;
          console.log(`   ${u.id} lesson ${li} level ${lv}: ideal ${a.good}/${a.total}`);
        }
        const b = play(new ArmRun(L, { rng: mulberry(6) }), () => ({ l: false, r: false }));
        if (b.t >= 400) ends = false;
        if (li < 4 && u.lessons[li].key !== 'loose' && b.good > 0) idle = false;
        if (['swap', 'which'].includes(u.lessons[li].key) && play(new ArmRun(L, { rng: mulberry(7) }), () => ({ l: true, r: true })).good > 0) cheat = false;
      }
    }
  }
  check(ideal, 'Arm path: all 20 arm lessons can be completed 10/10, at the easiest and hardest levels');
  check(idle && ends, 'Arm path: never flexing scores nothing (except "Stay loose"), and every lesson still ends');
  check(cheat, 'Arm path: flexing both arms all the time scores nothing on "Switch" and "Which arm?"');
  const lostRun = new ArmRun(buildArmLesson(newProfile('L', '2026-11-16'), arms[0].ui, 0, { rng: mulberry(2) }), { rng: mulberry(3) });
  for (let i = 0; i < 600; i++) lostRun.update({ l: true, r: false, face: false }, dt);
  check(lostRun.results.length === 0 && lostRun.lostMs > 9000, 'Arm path: a dropped sensor pauses the lesson instead of scoring misses');

  // Every arm lesson course, driven gate by gate with an ideal player.
  const names = new Set(unitsOf('head').flatMap(({ ui }) => [0, 1, 2, 3, 4].map((li) => lessonTrack(ui, li).name)));
  let all = true;
  for (const { ui } of arms) {
    for (let li = 0; li < 5; li++) {
      const t = lessonTrack(ui, li);
      names.add(t.name);
      const run = new ArmRun(buildArmLesson(newProfile('C', '2026-11-16'), ui, li, { rng: mulberry(ui + li) }), { rng: mulberry(9) });
      const c = new LessonCourse(t, run);
      let time = 0;
      let opened = 0;
      while (c.mode !== 'done' && time < 300) {
        if (c.update({ ...run.want(), face: true }, dt).gateEvent?.ok) opened++;
        time += dt;
      }
      if (c.mode !== 'done' || opened !== LESSON_GATES || !c.car.finished) {
        all = false;
        console.log(`   ${t.id}: mode ${c.mode} opened ${opened} time ${time.toFixed(1)}`);
      }
    }
  }
  check(all && names.size === 40, `Arm path: all 20 arm courses driven to the finish, every gate opened, 40 different course names (${names.size})`);

  // Boss races: what each pair of signals does to the car.
  const on = (l, r) => ({ l, r, face: true });
  const hold = (s, sec) => {
    const st = {};
    let c;
    for (let t = 0; t < sec; t += dt) c = armRaceControl('a4', s, st, dt, 0);
    return c;
  };
  const a4 = [on(true, true), on(true, false), on(false, true), on(false, false)].map((s) => hold(s, 0.4));
  check(a4[0].go === 1 && a4[0].steer === 0 && a4[1].steer === 1 && a4[2].steer === -1 && a4[3].go === 0 && armRaceControl('a4', on(true, true), {}, dt, 0).go === 1,
    'Arm Grand Prix (Free Flex mapping): both arms = full speed at once, left arm turns right, right arm turns left, none = stop');
  const st3 = {};
  let boosts = 0;
  for (let i = 0; i < 480; i++) if (armRaceControl('a3', on(Math.floor(i / 60) % 2 === 0, false), st3, dt, 0).boost) boosts++; // 1 s up, 1 s down
  const st3b = {};
  let held = 0;
  for (let i = 0; i < 240; i++) if (armRaceControl('a3', on(true, false), st3b, dt, 0).boost) held++;
  check(boosts === 4 && held === 1, `Pump Track: each new squeeze boosts (${boosts} for 4 curls), holding doesn't (${held})`);
  const st2 = {};
  let b2 = 0;
  for (let i = 0; i < 400; i++) if (armRaceControl('a2', on(true, false), st2, dt, 0).boost) b2++;
  check(b2 === 2 && armRaceControl('a2', on(false, false), st2, dt, 0).go === 0, `Long Haul: a boost every 3 s held (${b2} in 6.7 s), stops when you let go`);
}

// ---------- 3e. The real car over Bluetooth ----------
{
  const dt = 1 / 60;
  // Both-arms window: one arm a moment ahead of the other still means straight on.
  const run = (fn, sec) => {
    const c = new ArmChord();
    const seen = new Set();
    for (let t = 0; t < sec; t += dt) seen.add(armDir(c.update(...fn(t), dt)));
    return seen;
  };
  const start = run((t) => [t >= 0, t >= 0.15], 1);
  const stop = run((t) => [t < 0.6, t < 0.75], 1.2);
  const turn = run((t) => [true, false], 1);
  check(!start.has('right') && !start.has('left') && start.has('fwd'), `Both-arms window: right arm 150 ms after the left still drives straight, no turn (${[...start]})`);
  check(!stop.has('right') && !stop.has('left') && stop.has('none'), `Both-arms window: letting go 150 ms apart stops without a swerve (${[...stop]})`);
  check(turn.has('right'), 'Both-arms window: the left arm alone for longer turns right');

  // Pushing into a wall: the wheels spin in the game but the car doesn't move, so the real car stops.
  const car = newCar();
  car.h += Math.PI / 2;
  for (let t = 0; t < 3; t += dt) step(car, 0, 1, dt);
  const w = wheelMix(car.vReal / 220, car.yawRate);
  check(car.v > 30 && car.vReal < 3 && car.throttleOut < 0.02 && w.l === 0 && w.r === 0,
    `Driving into a wall: game wheels spin (${car.v.toFixed(0)}) but the real car gets no power (moves ${car.vReal.toFixed(1)}, wheels ${w.l}/${w.r})`);

  // The real car turns as fast as the game car (2 m/s at full power, 12.5 cm track, tyre scrub).
  const a = arcMotion();
  const right = wheelMix(a.speed, a.yaw);
  const left = wheelMix(a.speed, -a.yaw);
  const m = realMotion(right.l, right.r);
  const straight = wheelMix(1, 0);
  check(Math.abs(m.yaw - a.yaw) < 0.01 && right.l > right.r && right.r > 0.05 && left.r > left.l && straight.l === straight.r && straight.l === CAR_TUNE.speed,
    `Real-car power: one-arm curve = left ${right.l.toFixed(2)} / right ${right.r.toFixed(2)} (gentle arc, ${(m.yaw * 57.3).toFixed(0)}°/s like the game), straight = ${straight.l}`);
  const sw = wheelMix(a.speed, a.yaw, { ...CAR_TUNE, swapWheels: true });
  check(sw.l === right.r && sw.r === right.l, 'Swap the wheels setting swaps left and right power');

  // Old firmware: pulsing on/off gives the same average power.
  const p = new Pulser();
  let n = 0;
  for (let i = 0; i < 1000; i++) n += p.next(0.37) ? 1 : 0;
  check(Math.abs(n / 1000 - 0.37) < 0.01, `Pulsing a wheel button averages the asked power (${n / 10}% for 37%)`);

  // Calibrated envelope -> flexing or not, with a short dwell so twitches don't count.
  const rest = Array.from({ length: 100 }, (_, i) => 300 + (i % 7) * 4);
  const flex = Array.from({ length: 100 }, (_, i) => 1400 + (i % 9) * 20);
  const prof = armProfile(rest, flex);
  const fs2 = new FlexSwitch(prof);
  let ms = 0;
  const feed = (v, dur) => {
    let on;
    for (let t = 0; t < dur; t += 20) on = fs2.update(v, (ms += 20));
    return on;
  };
  const twitch = feed(1500, 80);
  const quiet = feed(310, 400);
  const flexed = feed(1500, 400);
  const relaxed = feed(310, 400);
  check(!prof.error && !twitch && !quiet && flexed && !relaxed && armProfile(rest, rest).error, 'EMG calibration: thresholds between relaxed and squeezing; an 80 ms twitch is ignored, a squeeze counts, same-level recordings are refused');

  // Lessons: between gates the car only moves while the arms give the direction the road needs.
  const ui = unitsOf('arms')[0].ui;
  const lessonRun = (arms) => {
    const lesson = buildArmLesson(newProfile('Car', '2026-11-21'), ui, 0, { rng: () => 0.3 });
    const r = new ArmRun(lesson);
    const c = new LessonCourse(lessonTrack(ui, 0), r, { armSteer: {} });
    let moved = 0;
    let wrongWay = 0;
    for (let t = 0; t < 300 && c.mode !== 'done'; t += dt) {
      const x = c.car.x;
      const y = c.car.y;
      const sig = c.mode === 'gate' ? { ...r.want(), face: true } : { ...arms(c.botArms()), face: true };
      c.update(sig, dt);
      const d = Math.hypot(c.car.x - x, c.car.y - y);
      moved += d;
      if (c.steer.have !== c.steer.need && c.steer.have !== 'none' && d > 4 * dt * 60) wrongWay++;
    }
    return { done: c.mode === 'done', moved, wrongWay };
  };
  const good = lessonRun((b) => b);
  const wrong = lessonRun((b) => (b.l && b.r ? { l: true, r: false } : { l: b.r, r: b.l }));
  const idle = lessonRun(() => ({ l: false, r: false }));
  check(good.done && wrong.moved === 0 && idle.moved === 0,
    `Arm lessons: the right arms drive to the finish; wrong arms (moved ${wrong.moved.toFixed(0)}) or no arms (moved ${idle.moved.toFixed(0)}) never move the car`);
}

// ---------- 4. Server ----------
// SIM_URL=http://localhost:4001 runs these checks against a server that is already running, e.g. the
// cloud build (test/cloud-dev.js) with CAR_TOKEN=letsgo, ADMIN_KEY=testkey and an empty Redis.
// SIM_URL2 puts the car and the big screen on a second instance, like Vercel can.
const REMOTE = process.env.SIM_URL?.replace(/\/$/, '');
const PORT = 3999;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-race-'));
const srv = REMOTE ? null : spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NO_TUNNEL: '1', RESULTS_FILE: path.join(tmp, 'r.json'), ADMIN_KEY: 'testkey' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (srv) await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('running') && res()));
const base = REMOTE || `http://localhost:${PORT}`;
const wsBase = base.replace(/^http/, 'ws');
const CAR = process.env.SIM_CAR_TOKEN || 'letsgo';
const ADMIN = process.env.SIM_ADMIN_KEY || 'testkey';
const wsBase2 = (process.env.SIM_URL2?.replace(/\/$/, '') || base).replace(/^http/, 'ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.on('message', (d) => inbox.push(String(d)));
  const until = async (pred, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await wait(20);
    }
    return null;
  };
  return { ws, inbox, until, open: new Promise((r) => ws.on('open', r)) };
}
const isT = (t) => (s) => s.startsWith('{') && JSON.parse(s).t === t;

try {
  const rogue = new WebSocket(`${wsBase}/api/car?token=wrong`);
  const rejected = await new Promise((r) => { rogue.on('error', () => r(true)); rogue.on('open', () => r(false)); });
  check(rejected, 'Car connection with the wrong token is refused');

  const car = client(`${wsBase2}/api/car?token=${CAR}`);
  await car.open;
  const screen = client(`${wsBase2}/api/ws`);
  await screen.open;
  screen.ws.send(JSON.stringify({ t: 'hello', role: 'screen', admin: ADMIN }));
  check(!!(await screen.until((s) => isT('hello')(s) && JSON.parse(s).admin === true)), 'Big screen gets host controls with the admin key');
  check(!!(await screen.until((s) => isT('lobby')(s) && JSON.parse(s).carOnline)), 'Big screen sees the car online');

  // Arm sensors: their ESP32 sends "f <left> <right>"; players in the arm path get the two signals.
  const armPhone = client(`${wsBase}/api/ws`);
  await armPhone.open;
  armPhone.ws.send(JSON.stringify({ t: 'hello', role: 'player' }));
  armPhone.ws.send(JSON.stringify({ t: 'emg_sub' }));
  const emgIs = (l, r, online) => (s) => isT('emg')(s) && JSON.parse(s).online === online && (!online || (JSON.parse(s).l === l && JSON.parse(s).r === r));
  check(!!(await armPhone.until(emgIs(0, 0, false))), 'Arm path player is told the arm sensors are offline');
  const emgDev = client(`${wsBase2}/api/emg?token=${CAR}`);
  await emgDev.open;
  emgDev.ws.send('f 1 0');
  check(!!(await armPhone.until(emgIs(1, 0, true))), 'Left biceps flex from the sensor ESP32 reaches the phone');
  car.ws.send('f 0 1');
  check(!!(await armPhone.until(emgIs(0, 1, true))), "The car's own ESP32 can send the arm signals too");
  armPhone.inbox.length = 0;
  emgDev.ws.close();
  check(!!(await armPhone.until(emgIs(0, 0, false))), 'Arm sensors show offline when their ESP32 disconnects');
  armPhone.ws.close();

  const phone = client(`${wsBase}/api/ws`);
  await phone.open;
  phone.ws.send(JSON.stringify({ t: 'hello', role: 'player' }));
  await phone.until(isT('hello'));
  phone.ws.send(JSON.stringify({ t: 'join', name: '  Sam  ', assist: 0 }));
  check(!!(await phone.until(isT('your_turn'))), 'Player joins and gets their turn');

  const phone2 = client(`${wsBase}/api/ws`);
  await phone2.open;
  phone2.ws.send(JSON.stringify({ t: 'hello', role: 'player' }));
  phone2.ws.send(JSON.stringify({ t: 'join', name: 'Alex', assist: 0 }));
  check(!!(await phone2.until((s) => isT('lobby')(s) && JSON.parse(s).pos === 1)), 'Second player is #1 in line');

  phone.ws.send(JSON.stringify({ t: 'start' }));
  check(!!(await phone.until((s) => isT('countdown')(s) && JSON.parse(s).n === 3)), 'Countdown starts');
  check(!!(await phone.until(isT('go'), 5000)), 'GO after countdown');
  car.inbox.length = 0;
  for (let i = 0; i < 12; i++) {
    phone.ws.send(JSON.stringify({ t: 'state', x: 150, y: 800 - i * 5, h: -1.57, cs: -0.8, ct: 0.6, stars: [0] }));
    await wait(50);
  }
  check(car.inbox.some((m) => m === 'd -800 600'), `Car receives the phone's steering + throttle ("${car.inbox.at(-1)}")`);
  check(!!(await screen.until(isT('live'))), 'Big screen gets live car position');

  car.inbox.length = 0;
  await wait(600); // phone goes quiet
  check(car.inbox.slice(-3).every((m) => m === 'd 0 0'), 'Car is told to stop when the phone goes quiet');

  phone.ws.send(JSON.stringify({ t: 'finish', rawMs: 1300, stars: 1, stats: { headMoves: 4, goMoves: 2, goHoldMs: 900, wallHits: 1 } }));
  const res = JSON.parse(await phone.until(isT('result')));
  check(res.stars === 1 && res.rank === 1 && res.personalBest, `Result saved: ${res.finalMs} ms, rank ${res.rank}`);
  const board = JSON.parse(await screen.until((s) => isT('board')(s) && JSON.parse(s).fastest.length > 0));
  check(board.fastest[0]?.name === 'Sam' && !board.fastest[0].assist, 'Leaderboard shows "Sam"');
  check(!!(await phone2.until(isT('your_turn'))), 'Next player in line gets their turn');

  // Second player starts, then their connection drops mid-race -> car must stop.
  const id2 = JSON.parse(phone2.inbox.find(isT('hello'))).id;
  phone2.ws.send(JSON.stringify({ t: 'start' }));
  await phone2.until(isT('go'), 5000);
  phone2.ws.send(JSON.stringify({ t: 'state', x: 150, y: 800, h: -1.57, cs: 0, ct: 1, stars: [] }));
  await wait(100);
  phone2.ws.terminate();
  car.inbox.length = 0;
  await wait(REMOTE ? 700 : 300);
  // A drive command already in flight when the phone dropped may still land; after the first stop, nothing else may.
  // In the cloud the host may notice the drop late, so the "phone went quiet" rule stops the car instead (0.4 s).
  const firstStop = car.inbox.indexOf('d 0 0');
  check(firstStop >= 0 && (REMOTE || firstStop <= 1) && car.inbox.slice(firstStop).every((m) => m === 'd 0 0'), `Driver disconnect mid-race stops the car${REMOTE ? ' (within 0.4 s)' : ''}`);
  // Back within a few seconds (a phone blip, or the cloud moving the connection): the run carries on.
  const phone2b = client(`${wsBase}/api/ws`);
  await phone2b.open;
  phone2b.ws.send(JSON.stringify({ t: 'hello', role: 'player', id: id2 }));
  const back = JSON.parse(await phone2b.until(isT('hello')));
  car.inbox.length = 0;
  for (let i = 0; i < 8; i++) {
    phone2b.ws.send(JSON.stringify({ t: 'state', x: 150, y: 800, h: -1.57, cs: 0.2, ct: 0.5, stars: [] }));
    await wait(50);
  }
  check(back.driving === 'racing' && car.inbox.includes('d 200 500'), 'A driver whose connection blips gets back into their run');
  // Gone for good: the run ends after the grace period.
  phone2b.ws.terminate();
  // In the cloud the host notices a vanished phone a few seconds late (its pings go unanswered), then the grace period runs.
  check(!!(await screen.until((s) => isT('run_end')(s) && JSON.parse(s).reason === 'disconnected', REMOTE ? 16000 : 10000)), 'Big screen shows the run ended when the driver does not come back');

  // Sam races again, slower then faster -> most improved.
  phone.ws.send(JSON.stringify({ t: 'join', name: 'sam', assist: 0 }));
  await phone.until((s) => isT('your_turn')(s) && phone.inbox.filter(isT('your_turn')).length >= 2, 8000);
  phone.inbox.length = 0;
  phone.ws.send(JSON.stringify({ t: 'start' }));
  await phone.until(isT('go'), 5000);
  await wait(300);
  phone.ws.send(JSON.stringify({ t: 'finish', rawMs: 100, stars: 0, stats: {} }));
  const res2 = JSON.parse(await phone.until(isT('result')));
  check(res2.rawMs >= 0 && res2.rawMs < 1000, `Phone timer is sanity-checked against the server (${res2.rawMs} ms)`);
  if (!REMOTE) {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'r.json'), 'utf8'));
    check(saved.length === 2 && saved.every((r) => r.key === 'sam'), 'Results persisted to disk; names match case-insensitively');
  }
  const gpBest = Math.min(res.finalMs, res2.finalMs);

  // Boss race: same queue and car, but kept off the Grand Prix leaderboard.
  phone.inbox.length = 0;
  phone.ws.send(JSON.stringify({ t: 'join', name: 'Sam', assist: 0, level: 'u3' }));
  await phone.until(isT('your_turn'), 8000);
  phone.ws.send(JSON.stringify({ t: 'start' }));
  const cd = JSON.parse(await screen.until((s) => isT('countdown')(s) && JSON.parse(s).level === 'u3'));
  check(cd.levelName === 'Mouth Pedal', 'Big screen shows which boss race is starting');
  await phone.until(isT('go'), 5000);
  await wait(200);
  screen.inbox.length = 0;
  phone.ws.send(JSON.stringify({ t: 'finish', rawMs: 300, stars: 0, stats: {} }));
  const bossRes = JSON.parse(await phone.until(isT('result')));
  check(bossRes.level === 'u3' && bossRes.rank === null, 'Boss race result comes back tagged with its level');
  const fin = JSON.parse(await screen.until(isT('finished')));
  const b2 = JSON.parse(await screen.until(isT('board')));
  check(fin.levelName === 'Mouth Pedal' && b2.fastest.length === 1 && b2.fastest[0].ms === gpBest, 'Boss times stay off the Grand Prix leaderboard');

  // Practice feed for the big screen.
  phone.ws.send(JSON.stringify({ t: 'practice', name: 'Sam', unit: 'u2', lesson: 1, good: 8, total: 10, xp: 21, ms: 50000, reactMs: 600 }));
  phone.ws.send(JSON.stringify({ t: 'practice', name: 'Sam', unit: 'nope', lesson: 1, good: 8, total: 10 }));
  phone.ws.send(JSON.stringify({ t: 'practice', name: '=HYPERLINK(1)', unit: 'u1', lesson: 0, good: 99, total: 10, xp: 9999, ms: 1 }));
  const pb = JSON.parse(await screen.until((s) => isT('practice_board')(s) && JSON.parse(s).people.length >= 2));
  check(pb.reps === 18 && pb.people[0].name === 'Sam' && pb.people[0].xp === 61 && pb.feed.some((f) => f.text === 'Left and right · Hold it 8/10') && pb.feed.some((f) => f.text === 'cleared Mouth Pedal'),
    `Big screen gets today's practice: ${pb.reps} good reps, ${pb.people.length} people, feed "${pb.feed[0]?.text}"`);
  check(!pb.people.some((r) => r.xp > 30 && r.name !== 'Sam'), 'Practice numbers are capped (no 9999 XP)');

  // A race played on a phone only: practice time and XP, never the leaderboard.
  screen.inbox.length = 0;
  phone.ws.send(JSON.stringify({ t: 'practice', kind: 'race', local: true, name: 'Robin', unit: 'u4', xp: 500, ms: 999999 }));
  phone.ws.send(JSON.stringify({ t: 'practice', kind: 'race', local: true, name: 'Robin', unit: 'nope', xp: 5, ms: 1000 }));
  const pb2 = JSON.parse(await screen.until((s) => isT('practice_board')(s) && JSON.parse(s).people.some((r) => r.name === 'Robin')));
  const robin = pb2.people.find((r) => r.name === 'Robin');
  check(robin.xp === 20 && pb2.feed[0].text === 'cleared Kiss Boost on a phone' && !screen.inbox.some((m) => isT('board')(m)),
    'Phone-only races log practice (capped) and stay off the leaderboard');

  // A Grand Prix with driving help counts for the player but stays off the (no-help) leaderboard.
  const kim = client(`${wsBase}/api/ws`);
  await kim.open;
  kim.ws.send(JSON.stringify({ t: 'hello', role: 'player' }));
  kim.ws.send(JSON.stringify({ t: 'join', name: 'Kim', assist: 2 }));
  await kim.until(isT('your_turn'), 8000);
  kim.ws.send(JSON.stringify({ t: 'start' }));
  await kim.until(isT('go'), 5000);
  await wait(200);
  screen.inbox.length = 0;
  kim.ws.send(JSON.stringify({ t: 'finish', rawMs: 50, stars: 0, stats: {} }));
  const kimRes = JSON.parse(await kim.until(isT('result')));
  const b3 = JSON.parse(await screen.until(isT('board')));
  check(kimRes.rank === null && kimRes.personalBest && !b3.fastest.some((r) => r.name === 'Kim'), 'Times with driving help stay off the leaderboard');
  kim.ws.close();

  // The therapist CSV.
  const denied = await fetch(`${base}/api/practice.csv`);
  const csv = await fetch(`${base}/api/practice.csv?admin=${ADMIN}`).then((r) => r.text());
  check(denied.status === 403 && csv.startsWith('date,time,name,unit') && csv.includes('Boss: Mouth Pedal') && csv.includes('Boss: Kiss Boost (phone)') && csv.includes("'=HYPERLINK(1)"),
    'Practice CSV needs the host key and defuses spreadsheet formulas in names');
  await wait(400);
  if (!REMOTE) check(fs.existsSync(path.join(tmp, 'practice.json')), 'Practice log is saved to disk');

  // Host-only reset. A player can't do it; the host can.
  phone.ws.send(JSON.stringify({ t: 'admin', action: 'reset_board' }));
  await wait(REMOTE ? 800 : 300);
  const stillThere = await fetch(`${base}/api/practice.csv?admin=${ADMIN}`).then((r) => r.text());
  screen.inbox.length = 0;
  screen.ws.send(JSON.stringify({ t: 'admin', action: 'reset_board' }));
  const emptied = JSON.parse(await screen.until((s) => isT('board')(s)));
  await wait(REMOTE ? 800 : 200);
  const csvAfter = await fetch(`${base}/api/practice.csv?admin=${ADMIN}`).then((r) => r.text());
  check(stillThere.split('\n').length > 1 && emptied.fastest.length === 0 && csvAfter.split('\n').length === 1, 'Only the host can clear the leaderboard and practice log');
} finally {
  srv?.kill();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
