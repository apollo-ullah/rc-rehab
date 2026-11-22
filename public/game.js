// Car physics. Pure logic, no drawing.
// The phone runs the simulation; the big screen, the 3D world and the server
// import the same courses (tracks.js) so everyone agrees on the road.
import { raceTrack } from './tracks.js';

export const TRACK_WIDTH = 120;
export const CAR = { len: 34, wid: 20, radius: 12 };
export const MAX_SPEED = 220; // world units per second at full throttle, no assist
export const TURN_RATE = 2.1; // radians per second at full steer, at low speed
export const STAR_BONUS_MS = 2000; // each star takes 2 s off your time
export const RUN_TIMEOUT_MS = 150000;

const GRAVITY = 430;
const RAMP_HEIGHT = 18;
const LAUNCH = 0.42; // vertical launch speed as a share of forward speed
const BOOST_TIME = 1.2; // seconds
const BOOST_SPEED = 1.3; // multiple of the car's top speed while boosting

// Assist levels. Tagged on the leaderboard so times stay comparable.
export const ASSIST = [
  { name: 'No help', speed: 1.0, steerHelp: 0.0, autoGo: 0 },
  { name: 'Some help', speed: 0.75, steerHelp: 0.45, autoGo: 0 },
  { name: 'Lots of help', speed: 0.6, steerHelp: 0.7, autoGo: 0.6 },
];

// The default course is the Grand Prix. Every other course comes from tracks.js, and a car
// remembers the course it was created on.
export const GP = raceTrack('gp');
export const TRACK_LENGTH = GP.length;
export const STARS = GP.stars;
export const FEATURES = GP.features;
export const pointAt = (d) => GP.pointAt(d);
const STAR_PICKUP = 26;

export function newCar(track = GP) {
  const p = track.pointAt(track.startAt);
  const car = {
    x: p.x, y: p.y, z: 0, h: p.h, v: 0, vz: 0,
    air: false, airTime: 0, boost: 0, steer: 0,
    seg: track.segAt(track.startAt), progress: track.startAt, stars: [], hit: false, finished: false,
    steerOut: 0, throttleOut: 0,
    vReal: 0, yawRate: 0, // how fast it really moves forward and turns, after walls
  };
  // Not enumerable, so spreading or sending a car never copies the whole course.
  Object.defineProperty(car, 'track', { value: track, writable: true, enumerable: false });
  return car;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The real car's steering buttons are on/off: the firmware presses LEFT/RIGHT past 0.35.
// The head curve keeps on-screen steering gentle, so a clear turn on screen is sent as at
// least a firm press. Tiny corrections stay released so the real car doesn't twitch.
export const REAL_STEER_MIN = 0.15;
export function realSteer(s) {
  const a = Math.abs(s);
  return a < REAL_STEER_MIN ? 0 : Math.sign(s) * Math.min(1, 0.45 + 0.55 * a);
}

// Steering that follows the road by itself. Used when an exercise only controls the speed
// (practice lessons, most boss races) and by ?autopilot.
export function autoSteer(car, track = car.track || GP) {
  const target = track.pointAt(car.progress + 90);
  return clamp(wrap(Math.atan2(target.y - car.y, target.x - car.x) - car.h) * 3, -1, 1);
}
const featureAt = (track, type, progress) => track.features.find((f) => f.type === type && progress >= f.at && progress <= f.at + f.len);

// Advance the car. steer: -1 (left) .. 1 (right), go: 0..1.
// Returns events for effects: { newHit, star, launch, land, boost }.
export function step(car, steer, go, dt, assistLevel = 0, track = car.track || GP) {
  const cfg = ASSIST[assistLevel] || ASSIST[0];
  const ev = { newHit: false, star: -1, launch: false, land: false, boost: false };
  const before = car.progress;
  const x0 = car.x;
  const y0 = car.y;
  const h0 = car.h;

  let thr = cfg.autoGo ? Math.max(go, cfg.autoGo) : go;
  let st = steer;
  if (cfg.steerHelp > 0) {
    const target = track.pointAt(car.progress + 140);
    const diff = wrap(Math.atan2(target.y - car.y, target.x - car.x) - car.h);
    st = clamp(st + cfg.steerHelp * clamp(diff * 2, -1, 1), -1, 1);
  }
  car.steer = car.air ? 0 : st;

  const vmax = MAX_SPEED * cfg.speed;
  if (car.boost > 0) car.boost = Math.max(0, car.boost - dt);
  if (!car.air) {
    // In the air the wheels can't push or steer.
    const targetV = car.boost > 0 ? vmax * BOOST_SPEED : thr * vmax;
    const k = targetV > car.v ? (car.boost > 0 ? 4 : 2.2) : 3.5;
    car.v += (targetV - car.v) * Math.min(1, k * dt);
    // Like a real car: no turning on the spot, and a little less twitchy at speed.
    const grip = clamp(car.v / 70, 0, 1) * (1 - 0.3 * clamp(car.v / MAX_SPEED, 0, 1));
    car.h = wrap(car.h + st * TURN_RATE * grip * dt);
  }
  car.x += Math.cos(car.h) * car.v * dt;
  car.y += Math.sin(car.h) * car.v * dt;

  // Walls: push back onto the track and scrub speed.
  const n = track.nearest(car.x, car.y, car.seg);
  const limit = track.width / 2 - CAR.radius;
  const wasHit = car.hit;
  car.hit = n.dist > limit;
  if (car.hit) {
    const f = limit / n.dist;
    car.x = n.px + (car.x - n.px) * f;
    car.y = n.py + (car.y - n.py) * f;
    if (!car.air) {
      if (!wasHit) car.v *= 0.5;
      car.v *= Math.pow(0.02, dt);
    }
  }
  ev.newHit = car.hit && !wasHit;
  car.seg = n.i;
  car.progress = n.progress;

  // Ramps and jumps
  if (car.air) {
    car.airTime += dt;
    car.vz -= GRAVITY * dt;
    car.z += car.vz * dt;
    if (car.z <= 0) {
      car.z = 0;
      car.vz = 0;
      car.air = false;
      car.v *= 0.92;
      ev.land = car.airTime;
    }
  } else {
    const ramp = track.features.find((f) => f.type === 'ramp' && before < f.at + f.len && car.progress >= f.at - 2);
    if (ramp && car.progress < ramp.at + ramp.len) {
      car.z = RAMP_HEIGHT * clamp((car.progress - ramp.at) / ramp.len, 0, 1);
    } else if (ramp && car.progress >= ramp.at + ramp.len && before >= ramp.at) {
      car.air = true;
      car.airTime = 0;
      car.z = RAMP_HEIGHT;
      car.vz = car.v * LAUNCH;
      ev.launch = true;
    } else {
      car.z = 0;
    }
    if (featureAt(track, 'boost', car.progress)) {
      if (car.boost <= 0) ev.boost = true;
      car.boost = BOOST_TIME;
    }
  }

  track.stars.forEach((s, i) => {
    if (car.stars.includes(i)) return;
    const near = Math.hypot(s.x - car.x, s.y - car.y) < STAR_PICKUP;
    const height = s.z > 0 ? Math.abs(car.z - s.z) < 24 : car.z < 24;
    if (near && height) {
      car.stars.push(i);
      ev.star = i;
    }
  });

  if (car.progress >= track.finishAt) car.finished = true;

  // What the car really did this step. Pushing into a wall keeps the wheels spinning (car.v)
  // but the car doesn't move, so the real car must stop too.
  if (dt > 0) {
    const fwd = ((car.x - x0) * Math.cos(car.h) + (car.y - y0) * Math.sin(car.h)) / dt;
    const k = Math.min(1, dt * 12);
    car.vReal += (Math.max(0, fwd) - car.vReal) * k;
    car.yawRate += (wrap(car.h - h0) / dt - car.yawRate) * k;
  }

  // What the real car gets: the virtual car's actual speed and steering.
  car.steerOut = car.vReal > 5 ? car.steer : 0;
  car.throttleOut = clamp(car.vReal / MAX_SPEED, 0, 1);
  return ev;
}
