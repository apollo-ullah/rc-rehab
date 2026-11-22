// The MuscleCar board (firmware/MuscleCar, an ESP32-S3 by the arm-lab team) over Web Bluetooth,
// straight from the game page: both biceps' EMG readings come in about 50 times a second, and
// power for the left and right wheel buttons goes out. Needs Chrome or Edge (laptop or Android)
// on https:// or localhost. The same board and service as arm-lab's Free Flex.
import { FlexSwitch, armProfile } from './arms.js';

const uuid = (s) => `e0730c${s}-b64d-48f3-a0ac-3d0657c85430`;
const STALE_MS = 300; // no readings for this long = sensors offline
const WRITE_MS = 60; // wheel commands; the board releases the buttons 300 ms after the last one
const WANT_MS = 250; // the game must keep asking, or the wheels stop (hidden tab, frozen page)
const CAL_KEY = 'rc-mc-cal';

function loadCal() {
  try {
    const c = JSON.parse(localStorage.getItem(CAL_KEY));
    return Array.isArray(c) && c[0]?.on && c[1]?.on ? c : null;
  } catch {
    return null;
  }
}

export const mc = {
  supported: typeof navigator !== 'undefined' && !!navigator.bluetooth,
  connected: false,
  name: '',
  adc: [0, 0], // latest envelope readings, left and right
  flex: [false, false],
  out: { l: 0, r: 0 }, // wheel power last sent
  last: -Infinity,
  cal: null,
  get online() {
    return this.connected && performance.now() - this.last < STALE_MS;
  },
  get calibrated() {
    return !!this.cal;
  },
  get ready() {
    return this.online && this.calibrated;
  },
};

let device = null;
let samples = null;
let maskCh = null;
let powerCh = null;
let switches = [null, null];
let capture = null;
let writing = false;
let timer = null;
let want = { l: 0, r: 0, at: -Infinity };
let test = null;

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

function useCal(cal) {
  mc.cal = cal;
  switches = cal ? cal.map((p) => new FlexSwitch(p)) : [null, null];
  mc.flex = [false, false];
}
useCal(loadCal());

function receive(e) {
  const d = e.target.value;
  if (d.byteLength !== 12) return;
  const ms = d.getUint32(4, true);
  const v = [d.getUint16(8, true), d.getUint16(10, true)];
  mc.last = performance.now();
  mc.adc = v;
  if (capture) capture.push(v);
  mc.flex = v.map((x, i) => (switches[i] ? switches[i].update(x, ms) : false));
}

export async function connect() {
  if (!mc.supported) throw new Error('This browser has no Bluetooth. Use Chrome or Edge on a laptop or Android.');
  const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [uuid('50')] }] });
  try {
    dev.addEventListener('gattserverdisconnected', dropped);
    const svc = await (await dev.gatt.connect()).getPrimaryService(uuid('50'));
    const s = await svc.getCharacteristic(uuid('53')).catch(() => null);
    if (!s) throw new Error('This board only reads one arm. Flash firmware/MuscleCar for two biceps.');
    maskCh = await svc.getCharacteristic(uuid('52')).catch(() => null);
    powerCh = await svc.getCharacteristic(uuid('54')).catch(() => null);
    if (!maskCh && !powerCh) throw new Error('Sensor stream found, but wheel controls are unavailable. Disconnect and reconnect the board.');
    samples = s;
    samples.addEventListener('characteristicvaluechanged', receive);
    await samples.startNotifications();
  } catch (err) {
    dev.gatt?.disconnect();
    throw err;
  }
  device = dev;
  mc.connected = true;
  mc.name = dev.name || 'MuscleCar';
  clearInterval(timer);
  timer = setInterval(tick, WRITE_MS);
  changed();
}

function dropped() {
  clearInterval(timer);
  samples?.removeEventListener('characteristicvaluechanged', receive);
  device?.removeEventListener('gattserverdisconnected', dropped);
  device = samples = maskCh = powerCh = null;
  capture = null;
  test = null;
  mc.connected = false;
  mc.flex = [false, false];
  mc.out = { l: 0, r: 0 };
  switches.forEach((s) => s?.reset());
  changed();
}

export function disconnect() {
  device?.gatt?.disconnect();
}

// Forward button state for each side. Call it every frame: if the calls stop, the wheels stop.
export function setWheels(l, r) {
  want = { l, r, at: performance.now() };
}
// Drive the wheels for a fixed time, for the test buttons (the game's own commands wait).
export function testWheels(l, r, ms, onResult) {
  test = { l, r, until: performance.now() + ms, onResult };
}

async function tick() {
  if (writing || (!maskCh && !powerCh)) return;
  const now = performance.now();
  let l = 0;
  let r = 0;
  const trial = !document.hidden && test && now < test.until ? test : null;
  if (trial) ({ l, r } = test);
  else {
    test = null;
    if (!document.hidden && now - want.at < WANT_MS) ({ l, r } = want);
  }
  mc.out = { l, r };
  writing = true;
  try {
    if (maskCh) await maskCh.writeValueWithResponse(Uint8Array.of((l ? 1 : 0) | (r ? 2 : 0)));
    else await powerCh.writeValueWithResponse(Uint8Array.of(l ? 255 : 0, r ? 255 : 0));
    trial?.onResult?.('ESP32 acknowledged the forward command.');
  } catch (err) {
    trial?.onResult?.('Wheel write failed: ' + err.message);
    // The next tick tries again. The board releases the buttons by itself after 300 ms.
  } finally {
    writing = false;
  }
}

// Calibration: record both arms' readings for ms, while the person relaxes or squeezes.
export function record(ms) {
  return new Promise((resolve, reject) => {
    const rows = [];
    capture = rows;
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (!mc.online) {
        clearInterval(iv);
        capture = null;
        reject(new Error('The sensor readings stopped. Check the board is on and close by.'));
      } else if (performance.now() - t0 >= ms) {
        clearInterval(iv);
        capture = null;
        resolve(rows);
      }
    }, 50);
  });
}
// Relaxed, left-squeeze and right-squeeze recordings -> thresholds for each arm.
// Returns null when saved, or { left, right } with what went wrong for each.
export function calibrate(rest, left, right) {
  const a = armProfile(rest.map((v) => v[0]), left.map((v) => v[0]));
  const b = armProfile(rest.map((v) => v[1]), right.map((v) => v[1]));
  if (a.error || b.error) return { left: a.error, right: b.error };
  useCal([a, b]);
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify([a, b]));
  } catch { /* private window: keep it for this visit */ }
  return null;
}

addEventListener('pagehide', () => {
  want = { l: 0, r: 0, at: -Infinity };
  test = null;
});
