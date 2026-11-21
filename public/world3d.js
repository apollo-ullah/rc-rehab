// The 3D world: every course is a floating island over a light grid, with a soft-lit,
// rounded toy look. Used by the phone (chase camera in lessons and races, slow orbits
// behind menus) and by the big screen (the whole island as a diorama).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { raceTrack, GATE_STOP } from './tracks.js';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json';
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ROAD_Y = 0.8;
const GRID_Y = -260;
const STOP_LINE = GATE_STOP - 24; // the painted line, just in front of where the car waits

export const ACCENT = { sky: 0x3b9ad9, mint: 0x2fae6f, coral: 0xf26a4b, sun: 0xf2a922, violet: 0x7a66e0 };
const GLOW = { sky: '#9fd8ff', mint: '#9ff0c4', coral: '#ffc2ad', sun: '#ffe39a', violet: '#cdbfff' };
const C = {
  bg: 0xe9f1ec,
  car: 0xf26a4b,
  carDeep: 0xc94d33,
  ink: 0x2b3640,
  cream: 0xfff8ec,
  glass: 0x3b5666,
  lamp: 0xfff1b8,
  star: 0xf7b733,
  white: 0xffffff,
  good: 0x2fae6f,
  miss: 0xf2a922,
  edge: 0xeadfcd,
  curb: 0xf26a4b,
};
const THEMES = {
  lake: { ground: '#bfe2b1', deep: '#a9d59c', light: '#d3ecc5', side: 0xe6d6b8, foliage: [0x7cc47b, 0x62b06c, 0x9bd48a], trunk: 0x9b7653, flowers: [0xffffff, 0xffe08a, 0xa9d8f5], rocks: [0xc9c4b6, 0xb9b3a3], water: 0x8fd0ee, kinds: { tree: 1, bush: 1, pond: 1 } },
  forest: { ground: '#a9d69c', deep: '#92c886', light: '#c0e3b2', side: 0xdcc8a4, foliage: [0x3f9a63, 0x2f8556, 0x58b075], trunk: 0x8a6446, flowers: [0xffffff, 0xf7c6d9, 0xffe08a], rocks: [0xb8b8aa, 0xa5a598], kinds: { pine: 1, tree: 0.4, bush: 1 } },
  canyon: { ground: '#f2d3a6', deep: '#e9c08d', light: '#f8e2c0', side: 0xe2a77c, foliage: [0x7fb36a, 0x69a35c, 0x8cc277], trunk: 0x9b7653, flowers: [0xff8a6b, 0xffd36b, 0xffffff], rocks: [0xe08e64, 0xd47a52, 0xeaa57d], kinds: { cactus: 1, mesa: 0.35, rock: 1 } },
  beach: { ground: '#f6e6b9', deep: '#efd99f', light: '#fbf0d2', side: 0xe9cf9a, foliage: [0x5dbb7a, 0x47a768, 0x7acb8c], trunk: 0xb08860, flowers: [0xff9a8a, 0xffffff, 0x8fd3e8], rocks: [0xd9cdb4, 0xc9bb9f], water: 0x7fd6e3, kinds: { palm: 1, umbrella: 1, pond: 1 } },
  park: { ground: '#bce0ab', deep: '#a5d396', light: '#d2ebc3', side: 0xe2d1b0, foliage: [0x6fbf72, 0x4fa866, 0xf5b3c8], trunk: 0x8f6a4c, flowers: [0xffffff, 0xffd36b, 0xf5b3c8], rocks: [0xc4c0b2, 0xb3ae9e], kinds: { tree: 1, pine: 0.5, bush: 1 } },
};

function seeded(seed) {
  let s = seed % 2147483647 || 7;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const hashStr = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 17);
const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

function canvasTex(w, h, draw, { repeat = false, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ---------- Shared textures ----------
const tex = {};
function gridTexture() {
  return (tex.grid ||= canvasTex(256, 256, (g, w) => {
    g.fillStyle = '#e3ede7';
    g.fillRect(0, 0, w, w);
    g.strokeStyle = 'rgba(110,150,140,0.28)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, w, w);
    g.strokeStyle = 'rgba(80,140,125,0.5)';
    g.lineWidth = 3;
    for (const x of [64, 192]) for (const y of [64, 192]) {
      g.beginPath();
      g.moveTo(x - 6, y - 6);
      g.lineTo(x + 6, y + 6);
      g.moveTo(x + 6, y - 6);
      g.lineTo(x - 6, y + 6);
      g.stroke();
    }
  }, { repeat: true }));
}
function roadTexture() {
  // Light paving stones in staggered rows.
  return (tex.road ||= canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#f4ede1';
    g.fillRect(0, 0, w, h);
    const r = seeded(5);
    for (let row = 0; row < 8; row++) {
      const y = row * 32;
      const off = row % 2 ? 16 : 0;
      for (let x = -32 + off; x < w; x += 32) {
        const tone = 236 + Math.floor(r() * 10);
        g.fillStyle = `rgb(${tone + 8},${tone + 2},${tone - 10})`;
        g.beginPath();
        g.roundRect(x + 1.5, y + 1.5, 29, 29, 5);
        g.fill();
      }
    }
  }, { repeat: true }));
}
function groundTexture(theme) {
  const T = THEMES[theme];
  return (tex[`g-${theme}`] ||= canvasTex(256, 256, (g, w) => {
    g.fillStyle = T.ground;
    g.fillRect(0, 0, w, w);
    const r = seeded(hashStr(theme));
    for (let i = 0; i < 60; i++) {
      const x = r() * w;
      const y = r() * w;
      const rad = 10 + r() * 34;
      const col = r() < 0.55 ? T.deep : T.light;
      for (const dx of [-w, 0, w]) for (const dy of [-w, 0, w]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
        grd.addColorStop(0, col);
        grd.addColorStop(1, `${col}00`);
        g.fillStyle = grd;
        g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
      }
    }
  }, { repeat: true }));
}
function checkerTexture() {
  return (tex.checker ||= canvasTex(128, 32, (g) => {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) {
      g.fillStyle = (i + j) % 2 ? '#2b3640' : '#fffaf2';
      g.fillRect(i * 16, j * 16, 16, 16);
    }
  }));
}
function stripeTexture(color) {
  return (tex[`s-${color}`] ||= canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#fffaf2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    for (let x = -32; x < w + 32; x += 48) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + 24, h);
      g.lineTo(x + 48, 0);
      g.lineTo(x + 24, 0);
      g.fill();
    }
  }));
}
function chevronTexture(color) {
  return (tex[`c-${color}`] ||= canvasTex(128, 128, (g, w, h) => {
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    g.fillStyle = hex;
    g.globalAlpha = 0.35;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 14;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const x of [24, 88]) {
      g.beginPath();
      g.moveTo(x, 24);
      g.lineTo(x + 26, 64);
      g.lineTo(x, 104);
      g.stroke();
    }
  }, { repeat: true }));
}
function crateTexture() {
  return (tex.crate ||= canvasTex(64, 64, (g) => {
    g.fillStyle = '#e0b07a';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#c98f55';
    for (const y of [20, 40]) g.fillRect(6, y, 52, 2);
    g.strokeStyle = '#b07a45';
    g.lineWidth = 7;
    g.strokeRect(3.5, 3.5, 57, 57);
    g.beginPath();
    g.moveTo(6, 58);
    g.lineTo(58, 6);
    g.stroke();
  }));
}
function softDot() {
  return (tex.dot ||= canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(40,60,60,0.38)');
    grd.addColorStop(1, 'rgba(40,60,60,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }));
}
function badgeTexture(text, color) {
  const fam = document.fonts?.check?.('900 40px Nunito') ? 'Nunito' : 'system-ui, sans-serif';
  return canvasTex(128, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(64, 64, 58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    g.beginPath();
    g.arc(64, 64, 50, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 64, 43, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = `900 ${text.length > 1 ? 50 : 58}px ${fam}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 64, 68);
  });
}

// ---------- Shared geometry ----------
const geo = {};
function tuftGeometry() {
  if (geo.tuft) return geo.tuft;
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const h = 7 + (i % 3) * 3;
    const blade = new THREE.ConeGeometry(1.3, h, 3);
    blade.translate(0, h / 2, 0);
    blade.rotateZ((i - 2.5) * 0.12);
    blade.rotateY(i * 1.1);
    blade.translate(Math.cos(i * 2.4) * 2.2, 0, Math.sin(i * 2.4) * 2.2);
    parts.push(blade);
  }
  return (geo.tuft = mergeGeometries(parts));
}
function starGeometry() {
  if (geo.star) return geo.star;
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 4.6 : 10;
    const a = (i * Math.PI) / 5 + Math.PI / 2;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 2.5, bevelEnabled: true, bevelThickness: 1.4, bevelSize: 1.1, bevelSegments: 3 });
  g.translate(0, 0, -1.25);
  return (geo.star = g);
}

// Instanced mesh from items { x, y, z, rx, ry, rz, s | sx sy sz, color }.
function instanced(geometry, material, items, { cast = true, receive = false } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, items.length));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const col = new THREE.Color();
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    const s = it.s ?? 1;
    m.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.sx ?? s, it.sy ?? s, it.sz ?? s));
    mesh.setMatrixAt(i, m);
    if (it.color != null) mesh.setColorAt(i, col.set(it.color));
  });
  mesh.count = items.length;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// ---------- Island outline: the course's convex hull, grown by a margin ----------
function hull(points) {
  const P = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of P) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function islandOutline(track, margin) {
  const h = hull(track.pts.filter((_, i) => i % 3 === 0 || i === track.pts.length - 1));
  const grown = [];
  for (const [x, y] of h) for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    grown.push([x + Math.cos(a) * margin, y + Math.sin(a) * margin]);
  }
  return hull(grown);
}
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ---------- Building a course ----------
function buildIsland(group, track, outline, theme, accentName) {
  const T = THEMES[theme];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, -y)));
  const depth = 60;
  const bevel = 16;
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5, curveSegments: 4 });
  const top = groundTexture(theme);
  top.repeat.set(1 / 320, 1 / 320);
  const island = new THREE.Mesh(g, [lambert(0xffffff, { map: top }), lambert(T.side)]);
  island.rotation.x = -Math.PI / 2;
  island.position.y = -(depth + bevel);
  island.receiveShadow = true;
  group.add(island);

  // Glowing rim along the top edge, and a soft halo on the grid below.
  const pts = outline.map(([x, y]) => {
    const c = [track.bounds.cx, track.bounds.cy];
    const d = Math.hypot(x - c[0], y - c[1]) || 1;
    return new THREE.Vector3(x + ((x - c[0]) / d) * bevel, -bevel * 0.35, y + ((y - c[1]) / d) * bevel);
  });
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const rim = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 3.2, 6, true), new THREE.MeshBasicMaterial({ color: GLOW[accentName] }));
  group.add(rim);

  const b = track.bounds;
  const size = Math.max(b.w, b.h) + 1600;
  const halo = canvasTex(256, 256, (ctx) => {
    const s = 256 / size;
    ctx.translate(128 - b.cx * s, 128 - b.cy * s);
    ctx.filter = 'blur(18px)';
    ctx.fillStyle = GLOW[accentName];
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
    ctx.closePath();
    ctx.lineWidth = 60 * s * 4;
    ctx.strokeStyle = GLOW[accentName];
    ctx.stroke();
    ctx.fill();
  });
  const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: halo, transparent: true, opacity: 0.85, depthWrite: false }));
  haloMesh.rotation.x = -Math.PI / 2;
  haloMesh.position.set(b.cx, GRID_Y + 1, b.cy);
  group.add(haloMesh);
}

// A strip that follows the road at a sideways offset (inner..outer, negative = left).
function ribbon(track, inner, outer, y, material, { uvLen = 0, colorAt = null, from = 0, to = Infinity } = {}) {
  const P = track.pts;
  const S = track.segs;
  const n = P.length;
  const nrm = P.map((_, i) => {
    const a = S[Math.max(0, i - 1)];
    const b = S[Math.min(S.length - 1, i)];
    let nx = -(a.uy + b.uy);
    let ny = a.ux + b.ux;
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  });
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  const c = new THREE.Color();
  let v = 0;
  for (let i = 0; i < n - 1; i++) {
    const d0 = S[i].cum;
    if (d0 < from || d0 > to) continue;
    const quad = [i, i + 1];
    if (colorAt) c.set(colorAt(i, d0));
    for (const k of quad) {
      const [x, z] = P[k];
      const [nx, nz] = nrm[k];
      const d = k < S.length ? S[k].cum : track.length;
      pos.push(x + nx * inner, y, z + nz * inner, x + nx * outer, y, z + nz * outer);
      uv.push(0, uvLen ? d / uvLen : 0, 1, uvLen ? d / uvLen : 0);
      if (colorAt) col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colorAt) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Make every normal point up, whichever way the strip was wound.
  const nAttr = g.getAttribute('normal');
  for (let i = 0; i < nAttr.count; i++) nAttr.setXYZ(i, 0, 1, 0);
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  return m;
}

function buildRoad(group, track, theme) {
  const w = track.width / 2;
  const T = THEMES[theme];
  const roadTex = roadTexture();
  const road = lambert(0xffffff, { map: roadTex });
  group.add(ribbon(track, -w, w, ROAD_Y, road, { uvLen: 128 }));
  // Soft shoulder and edges
  const shoulder = lambert(new THREE.Color(T.deep).getHex());
  group.add(ribbon(track, -w - 22, -w, 0.35, shoulder));
  group.add(ribbon(track, w, w + 22, 0.35, shoulder));
  // Curbs: red and white on bends, cream on straights.
  const curbAt = (i, d) => {
    const bend = track.curvAhead(d - 20, 40) > 0.0028;
    return bend ? (Math.floor(d / 22) % 2 ? C.curb : C.white) : C.edge;
  };
  const curb = lambert(0xffffff, { vertexColors: true });
  group.add(ribbon(track, -w - 9, -w + 1, ROAD_Y + 0.9, curb, { colorAt: curbAt }));
  group.add(ribbon(track, w - 1, w + 9, ROAD_Y + 0.9, curb, { colorAt: curbAt }));
  // Dashes down the middle, skipping jumps and gates.
  const busy = (d) => track.features.some((f) => d > f.at - 20 && d < f.at + f.len + 20) || track.gates.some((g) => d > g - 60 && d < g + 20);
  const dashes = [];
  for (let d = 80; d < track.finishAt - 30; d += 44) {
    if (busy(d)) continue;
    const p = track.pointAt(d);
    dashes.push({ x: p.x, y: ROAD_Y + 0.25, z: p.y, ry: -p.h, rx: -Math.PI / 2 });
  }
  const dashGeo = new THREE.PlaneGeometry(18, 3.2);
  group.add(instanced(dashGeo, lambert(C.white), dashes.map((d) => ({ ...d, rz: 0 })), { cast: false, receive: true }));
}

function buildArches(group, track, accent) {
  const post = new THREE.CylinderGeometry(4.5, 5.5, 64, 16);
  const postMat = lambert(C.cream);
  const arch = (d, beamMat, withBeam) => {
    const p = track.pointAt(d);
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.y);
    g.rotation.y = -p.h;
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(post, postMat);
      m.position.set(0, 32, side * (track.width / 2 + 14));
      m.castShadow = true;
      g.add(m);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 12), lambert(accent));
      cap.position.set(0, 66, side * (track.width / 2 + 14));
      cap.castShadow = true;
      g.add(cap);
    }
    if (withBeam) {
      const beam = new THREE.Mesh(new RoundedBoxGeometry(10, 16, track.width + 40, 3, 3), beamMat);
      beam.position.set(0, 60, 0);
      beam.castShadow = true;
      g.add(beam);
    }
    group.add(g);
  };
  arch(track.startGate, null, false); // no beam at the start: it would block the chase camera
  const ck = checkerTexture().clone();
  ck.needsUpdate = true;
  arch(track.finishAt, lambert(0xffffff, { map: ck }), true);
  const line = (d, map, len) => {
    const p = track.pointAt(d);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, track.width), lambert(0xffffff, map ? { map } : {}));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -p.h;
    m.position.set(p.x, ROAD_Y + 0.3, p.y);
    m.receiveShadow = true;
    group.add(m);
  };
  const ck2 = canvasTex(32, 128, (g) => {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = (i + j) % 2 ? '#2b3640' : '#fffaf2';
      g.fillRect(i * 16, j * 16, 16, 16);
    }
  });
  line(track.finishAt, ck2, 16);
  line(track.startGate, null, 5);
}

function buildGates(group, track, accent) {
  const gates = [];
  const postGeo = new THREE.CylinderGeometry(4, 5, 40, 14);
  const lampGeo = new THREE.SphereGeometry(6, 16, 12);
  const armGeo = new RoundedBoxGeometry(6, 6, track.width + 16, 2, 2);
  const armMat = lambert(0xffffff, { map: (() => {
    const t = stripeTexture(accent).clone();
    t.needsUpdate = true;
    t.rotation = Math.PI / 2;
    t.center.set(0.5, 0.5);
    return t;
  })() });
  const postMat = lambert(C.cream);
  const signGeo = new THREE.CylinderGeometry(16, 16, 3, 32);
  track.gates.forEach((d, i) => {
    const p = track.pointAt(d);
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.y);
    g.rotation.y = -p.h;
    const lamps = [];
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(postGeo, postMat);
      m.position.set(0, 20, side * (track.width / 2 + 12));
      m.castShadow = true;
      g.add(m);
      const lampMat = new THREE.MeshLambertMaterial({ color: C.white, emissive: C.white, emissiveIntensity: 0.25 });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(0, 45, side * (track.width / 2 + 12));
      g.add(lamp);
      lamps.push(lampMat);
    }
    const pivot = new THREE.Group();
    pivot.position.set(0, 30, -(track.width / 2 + 12));
    const arm = new THREE.Mesh(armGeo, armMat);
    arm.position.set(0, 0, (track.width + 16) / 2);
    arm.castShadow = true;
    pivot.add(arm);
    g.add(pivot);
    // Round number sign in the middle of the arm: it lifts with the arm.
    const sign = new THREE.Mesh(signGeo, [lambert(0xffffff), lambert(0xffffff, { map: badgeTexture(String(i + 1), accent) }), lambert(0xffffff, { map: badgeTexture(String(i + 1), accent) })]);
    sign.rotation.z = Math.PI / 2;
    sign.position.set(0, 0, (track.width + 16) / 2);
    sign.castShadow = true;
    pivot.add(sign);
    group.add(g);
    // Painted waiting line.
    const s = track.pointAt(d - STOP_LINE);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(4, track.width - 10), lambert(C.white));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -s.h;
    line.position.set(s.x, ROAD_Y + 0.3, s.y);
    group.add(line);
    gates.push({ d, pivot, lamps, sign, state: 'closed', angle: 0, x: p.x, y: p.y });
  });
  return gates;
}

function buildFeatures(group, track, accent) {
  const pads = [];
  for (const f of track.features) {
    const p = track.pointAt(f.at);
    const g = new THREE.Group();
    g.position.set(p.x, ROAD_Y, p.y);
    g.rotation.y = -p.h;
    if (f.type === 'ramp') {
      const H = 18;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(f.len, 0);
      shape.lineTo(f.len, H);
      shape.closePath();
      const w = track.width - 10;
      const rg = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: true, bevelThickness: 2, bevelSize: 1.5, bevelSegments: 2 });
      rg.translate(0, 0, -w / 2);
      const ramp = new THREE.Mesh(rg, [lambert(accent), lambert(C.cream)]);
      ramp.castShadow = true;
      ramp.receiveShadow = true;
      g.add(ramp);
      const slope = Math.atan2(H, f.len);
      for (const t of [0.3, 0.6, 0.9]) {
        const bar = new THREE.Mesh(new RoundedBoxGeometry(5, 1.6, w - 16, 1, 0.7), lambert(accent));
        bar.position.set(f.len * t, H * t + 1.3, 0);
        bar.rotation.z = slope;
        g.add(bar);
      }
    } else if (f.type === 'boost') {
      const map = chevronTexture(accent).clone();
      map.needsUpdate = true;
      map.repeat.set(Math.max(1, Math.round(f.len / 24)), 1);
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(f.len, track.width - 24), new THREE.MeshBasicMaterial({ map, transparent: true }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(f.len / 2, 0.35, 0);
      g.add(pad);
      pads.push(map);
    }
    group.add(g);
  }
  return pads;
}

function buildScenery(group, track, outline, theme) {
  const T = THEMES[theme];
  const r = seeded(hashStr(track.id || 'x'));
  const w = track.width / 2;
  const b = track.bounds;
  const pad = 320;
  const area = (b.w + pad * 2) * (b.h + pad * 2);
  const taken = [];
  const free = (x, y, rad) => taken.every((t) => Math.hypot(t[0] - x, t[1] - y) > t[2] + rad);
  const spot = (minRoad, rad, tries = 60) => {
    for (let k = 0; k < tries; k++) {
      const x = b.minX - pad + r() * (b.w + pad * 2);
      const y = b.minY - pad + r() * (b.h + pad * 2);
      if (!inside(outline, x, y)) continue;
      if (track.distTo(x, y) < w + minRoad + rad) continue;
      if (!free(x, y, rad)) continue;
      taken.push([x, y, rad]);
      return [x, y];
    }
    return null;
  };
  const K = T.kinds;
  const pick = (arr) => arr[Math.floor(r() * arr.length)];

  // Water first (ponds and lagoons), so everything else goes around it.
  if (K.pond) {
    const waterMat = new THREE.MeshLambertMaterial({ color: T.water, transparent: true, opacity: 0.92 });
    const rimMat = lambert(0xffffff);
    for (let i = 0; i < 3; i++) {
      const rad = 90 + r() * 70;
      const s = spot(60, rad);
      if (!s) continue;
      const pond = new THREE.Mesh(new THREE.CircleGeometry(rad, 40), waterMat);
      pond.rotation.x = -Math.PI / 2;
      pond.scale.set(1, 0.7 + r() * 0.3, 1);
      pond.position.set(s[0], 0.5, s[1]);
      pond.receiveShadow = true;
      group.add(pond);
      const ring = new THREE.Mesh(new THREE.RingGeometry(rad, rad + 7, 40), rimMat);
      ring.rotation.x = -Math.PI / 2;
      ring.scale.copy(pond.scale);
      ring.position.set(s[0], 0.6, s[1]);
      group.add(ring);
    }
  }

  const trunks = [];
  const puffs = [];
  const cones = [];
  const rocks = [];
  const cacti = [];
  const mesas = [];
  const palmTrunk = [];
  const leaves = [];
  const umbrellas = [];
  const poles = [];
  const count = Math.min(170, Math.round(area / 30000));
  for (let i = 0; i < count; i++) {
    const roll = r();
    const kinds = Object.entries(K).filter(([k]) => k !== 'pond');
    const total = kinds.reduce((a, [, v]) => a + v, 0);
    let acc = 0;
    let kind = kinds[0][0];
    for (const [k, v] of kinds) {
      acc += v / total;
      if (roll <= acc) {
        kind = k;
        break;
      }
    }
    const s = 0.8 + r() * 0.6;
    if (kind === 'tree') {
      const p = spot(55, 22 * s);
      if (!p) continue;
      trunks.push({ x: p[0], y: 12 * s, z: p[1], sx: s, sy: s, sz: s, color: T.trunk });
      const tint = pick(T.foliage);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + r();
        const rr = k === 0 ? 0 : 9 * s;
        puffs.push({ x: p[0] + Math.cos(a) * rr, y: (30 + (k === 0 ? 8 : r() * 6)) * s, z: p[1] + Math.sin(a) * rr, s: (k === 0 ? 14 : 9 + r() * 4) * s, ry: r() * 3, color: tint });
      }
    } else if (kind === 'bush') {
      const p = spot(40, 14 * s);
      if (!p) continue;
      const tint = pick(T.foliage);
      for (let k = 0; k < 3; k++) puffs.push({ x: p[0] + (k - 1) * 7 * s, y: 6 * s, z: p[1] + (r() - 0.5) * 8, s: (7 + r() * 3) * s, color: tint });
    } else if (kind === 'pine') {
      const p = spot(55, 18 * s);
      if (!p) continue;
      trunks.push({ x: p[0], y: 8 * s, z: p[1], sx: s * 0.8, sy: s * 0.7, sz: s * 0.8, color: T.trunk });
      const tint = pick(T.foliage);
      for (let k = 0; k < 3; k++) cones.push({ x: p[0], y: (22 + k * 13) * s, z: p[1], sx: (17 - k * 4) * s, sy: 20 * s, sz: (17 - k * 4) * s, color: tint });
    } else if (kind === 'rock') {
      const p = spot(30, 14 * s);
      if (!p) continue;
      rocks.push({ x: p[0], y: 4 * s, z: p[1], sx: 14 * s, sy: 9 * s, sz: 11 * s, ry: r() * 3, color: pick(T.rocks) });
    } else if (kind === 'cactus') {
      const p = spot(45, 12 * s);
      if (!p) continue;
      const tint = pick(T.foliage);
      cacti.push({ x: p[0], y: 20 * s, z: p[1], s: s, color: tint });
      cacti.push({ x: p[0] + 9 * s, y: 24 * s, z: p[1], s: s * 0.55, color: tint });
      cacti.push({ x: p[0] - 8 * s, y: 18 * s, z: p[1] + 1, s: s * 0.5, color: tint });
    } else if (kind === 'mesa') {
      const p = spot(90, 60 * s);
      if (!p) continue;
      const c1 = pick(T.rocks);
      mesas.push({ x: p[0], y: 10 * s, z: p[1], sx: 55 * s, sy: 20 * s, sz: 55 * s, ry: r() * 3, color: c1 });
      mesas.push({ x: p[0], y: 25 * s, z: p[1], sx: 40 * s, sy: 11 * s, sz: 40 * s, ry: r() * 3, color: pick(T.rocks) });
    } else if (kind === 'palm') {
      const p = spot(55, 20 * s);
      if (!p) continue;
      const lean = (r() - 0.5) * 0.5;
      const dir = r() * Math.PI * 2;
      let x = p[0];
      let z = p[1];
      for (let k = 0; k < 5; k++) {
        x += Math.cos(dir) * lean * 7 * s;
        z += Math.sin(dir) * lean * 7 * s;
        palmTrunk.push({ x, y: (5 + k * 9) * s, z, s: s * (1 - k * 0.08), rz: lean * 0.6, color: T.trunk });
      }
      const tint = pick(T.foliage);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        leaves.push({ x: x + Math.cos(a) * 10 * s, y: 48 * s, z: z + Math.sin(a) * 10 * s, sx: 14 * s, sy: 1.6 * s, sz: 4.5 * s, ry: -a, rz: -0.35, color: tint });
      }
    } else if (kind === 'umbrella') {
      const p = spot(40, 18 * s);
      if (!p) continue;
      poles.push({ x: p[0], y: 14 * s, z: p[1], s, color: 0xffffff });
      umbrellas.push({ x: p[0], y: 30 * s, z: p[1], s, ry: r() * 3, color: pick([0xf26a4b, 0x3b9ad9, 0xf7b733, 0x2fae6f]) });
    }
  }
  const add = (g, items, opts) => items.length && group.add(instanced(g, lambert(0xffffff), items, opts));
  add(new THREE.CylinderGeometry(2.6, 3.6, 24, 10), trunks);
  add(new THREE.IcosahedronGeometry(1, 2), puffs);
  add(new THREE.ConeGeometry(1, 1, 16), cones);
  add(new THREE.DodecahedronGeometry(1, 1), rocks);
  add(new THREE.CapsuleGeometry(5, 26, 6, 12), cacti);
  add(new THREE.CylinderGeometry(1, 1.1, 1, 28), mesas);
  add(new THREE.CylinderGeometry(3.2, 3.8, 10, 10), palmTrunk);
  add(new THREE.SphereGeometry(1, 14, 8), leaves);
  add(new THREE.CylinderGeometry(1, 1, 30, 8), poles);
  add(new THREE.ConeGeometry(22, 9, 16), umbrellas);

  // Grass tufts and flowers along the roadside (the detail you see from the chase camera).
  const tufts = [];
  const flowers = [];
  for (let i = 0; i < Math.min(900, Math.round(area / 3500)); i++) {
    const x = b.minX - pad + r() * (b.w + pad * 2);
    const y = b.minY - pad + r() * (b.h + pad * 2);
    if (!inside(outline, x, y)) continue;
    const dd = track.distTo(x, y);
    if (dd < w + 26) continue;
    if (!free(x, y, 3)) continue;
    if (r() < 0.78) tufts.push({ x, y: 0, z: y, s: 0.8 + r() * 0.9, ry: r() * 6, color: pick(T.foliage) });
    else flowers.push({ x, y: 2.5, z: y, s: 2 + r() * 1.5, color: pick(T.flowers) });
  }
  if (tufts.length) group.add(instanced(tuftGeometry(), lambert(0xffffff), tufts, { cast: false }));
  if (flowers.length) group.add(instanced(new THREE.IcosahedronGeometry(1, 1), lambert(0xffffff), flowers, { cast: false }));

  // Lanterns at the start and along the road.
  const posts = [];
  const lamps = [];
  for (let d = 120; d < track.length - 100; d += 520) {
    const p = track.pointAt(d);
    const side = Math.floor(d / 520) % 2 ? 1 : -1;
    const o = w + 34;
    const x = p.x - Math.sin(p.h) * o * side;
    const y = p.y + Math.cos(p.h) * o * side;
    posts.push({ x, y: 16, z: y });
    lamps.push({ x, y: 34, z: y });
  }
  if (posts.length) {
    group.add(instanced(new THREE.CylinderGeometry(1.8, 2.4, 32, 8), lambert(0x4a5a66), posts));
    group.add(instanced(new RoundedBoxGeometry(8, 9, 8, 2, 1.5), new THREE.MeshBasicMaterial({ color: C.lamp }), lamps, { cast: false }));
  }
}

let fontPromise = null;
function loadFont() {
  return (fontPromise ||= new Promise((res) => new FontLoader().load(FONT_URL, res, undefined, () => res(null))));
}

// The course name in big 3D letters beside the start, facing the starting car.
async function buildTitle(group, track, accent) {
  const font = await loadFont();
  if (!font || !group.parent) return;
  const text = (track.name || '').toUpperCase();
  const g = new TextGeometry(text, { font, size: 30, depth: 10, curveSegments: 6, bevelEnabled: true, bevelThickness: 2.5, bevelSize: 1.6, bevelSegments: 3 });
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.max.x + bb.min.x) / 2, 0, 0);
  const mesh = new THREE.Mesh(g, [lambert(0xffffff), lambert(accent)]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Beside and a little behind the start, so it reads in the island views but stays out of the
  // way of the chase camera while you drive.
  const p = track.pointAt(0);
  const side = 1;
  const off = track.width / 2 + 45 + (bb.max.x - bb.min.x) * 0.2;
  const back = 70;
  const holder = new THREE.Group();
  holder.position.set(p.x - Math.sin(p.h) * off * side - Math.cos(p.h) * back, 0, p.y + Math.cos(p.h) * off * side - Math.sin(p.h) * back);
  // Face back toward the start, turned a little toward the road.
  holder.rotation.y = -p.h - Math.PI / 2 + 0.55 * side;
  mesh.position.y = 0;
  holder.add(mesh);
  holder.scale.setScalar(Math.min(1, 520 / Math.max(1, bb.max.x - bb.min.x)));
  group.add(holder);
}

function buildCar() {
  const car = new THREE.Group();
  const body = new THREE.Group();
  car.add(body);
  const box = (w, h, d, r, color, x, y, z, emissive) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), emissive ? new THREE.MeshBasicMaterial({ color }) : lambert(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    body.add(m);
    return m;
  };
  box(36, 10, 21, 3.5, C.car, 0, 10, 0);
  box(17, 9, 18, 3.5, C.cream, -3, 18.5, 0);
  box(18.5, 2.5, 19, 1.2, C.car, -3, 23.5, 0);
  box(2, 6, 15, 0.8, C.glass, 5.7, 18.5, 0);
  box(4, 3, 21.5, 1.2, C.ink, 17.5, 7, 0);
  box(4, 3, 21.5, 1.2, C.ink, -17.5, 7, 0);
  box(1.5, 2.5, 4.5, 0.6, C.lamp, 18.2, 11, 6.5, true);
  box(1.5, 2.5, 4.5, 0.6, C.lamp, 18.2, 11, -6.5, true);
  box(1.5, 2.5, 4.5, 0.6, 0xff5a4a, -18.2, 11, 6.5, true);
  box(1.5, 2.5, 4.5, 0.6, 0xff5a4a, -18.2, 11, -6.5, true);
  const wheelGeo = new THREE.CylinderGeometry(5.6, 5.6, 5, 20);
  wheelGeo.rotateX(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(2.4, 2.4, 5.4, 12);
  hubGeo.rotateX(Math.PI / 2);
  const front = [];
  for (const [x, z] of [[11.5, 11], [11.5, -11], [-11.5, 11], [-11.5, -11]]) {
    const hub = new THREE.Group();
    hub.position.set(x, 5.6, z);
    const tire = new THREE.Mesh(wheelGeo, lambert(C.ink));
    tire.castShadow = true;
    hub.add(tire, new THREE.Mesh(hubGeo, lambert(C.cream)));
    car.add(hub);
    if (x > 0) front.push(hub);
  }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(56, 40), new THREE.MeshBasicMaterial({ map: softDot(), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.4;
  car.add(shadow);
  return { car, body, front, shadow };
}

function buildCrate() {
  const m = new THREE.Mesh(new RoundedBoxGeometry(13, 13, 13, 2, 1.6), lambert(0xffffff, { map: crateTexture() }));
  m.castShadow = true;
  const g = new THREE.Group();
  m.position.y = 6.5;
  g.add(m);
  return g;
}

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map && !Object.values(tex).includes(m.map)) m.map.dispose();
      m.dispose();
    }
  });
}

// ---------- The world ----------
// inset: { right, bottom } = share of the screen covered by panels, so cameras frame the rest.
export function createWorld(canvas, { mode = 'chase', track = raceTrack('gp'), inset = {}, maxDpr = 1.5 } = {}) {
  let ins = { right: 0, bottom: 0, ...inset };
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(maxDpr, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.bg);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8cdb4, 1.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3df, 2.1);
  sun.castShadow = true;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const grid = gridTexture();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshBasicMaterial({ map: grid }));
  grid.repeat.set(40000 / 420, 40000 / 420);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = GRID_Y;
  scene.add(floor);

  // Dynamic things
  const { car: carMesh, body, front, shadow: carShadow } = buildCar();
  scene.add(carMesh);
  const starGeo = starGeometry();
  const starMat = new THREE.MeshLambertMaterial({ color: C.star, emissive: C.star, emissiveIntensity: 0.35 });

  const POOL = 90;
  const partMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), POOL);
  partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  partMesh.frustumCulled = false;
  const parts = Array.from({ length: POOL }, () => ({ life: 0 }));
  const tmpColor = new THREE.Color();
  for (let i = 0; i < POOL; i++) partMesh.setColorAt(i, tmpColor.set(0xffffff));
  scene.add(partMesh);
  let partCursor = 0;
  function emit(x, y, z, n, color, power = 60) {
    for (let k = 0; k < n; k++) {
      const i = partCursor;
      const p = parts[i];
      partCursor = (partCursor + 1) % POOL;
      const a = Math.random() * Math.PI * 2;
      Object.assign(p, {
        x, y, z,
        vx: Math.cos(a) * power * (0.4 + Math.random()),
        vy: Math.sin(a) * power * (0.4 + Math.random()),
        vz: power * (0.6 + Math.random()),
        life: 0.5 + Math.random() * 0.45,
        max: 0.95,
      });
      partMesh.setColorAt(i, tmpColor.set(Array.isArray(color) ? color[k % color.length] : color));
    }
    partMesh.instanceColor.needsUpdate = true;
  }

  // Per-course things, rebuilt by setTrack.
  let T = null; // current track
  let group = null;
  let stars = [];
  let crates = [];
  let gates = [];
  let pads = [];
  let accent = ACCENT.violet;
  let outline = [];

  function setTrack(track) {
    if (T === track && group) return;
    if (group) {
      scene.remove(group);
      dispose(group);
    }
    T = track;
    group = new THREE.Group();
    const theme = THEMES[track.theme] ? track.theme : 'park';
    const accentName = ACCENT[track.color] ? track.color : 'violet';
    accent = ACCENT[accentName];
    outline = islandOutline(track, 320);
    hemi.groundColor.set(THEMES[theme].ground);
    buildIsland(group, track, outline, theme, accentName);
    buildRoad(group, track, theme);
    buildArches(group, track, accent);
    gates = buildGates(group, track, accent);
    pads = buildFeatures(group, track, accent);
    buildScenery(group, track, outline, theme);
    stars = track.stars.map((s, i) => {
      const m = new THREE.Mesh(starGeo, starMat);
      m.castShadow = true;
      m.userData = { base: (s.z > 0 ? s.z + 6 : 14) + ROAD_Y, phase: i * 0.7, gone: 0 };
      m.position.set(s.x, m.userData.base, s.y);
      group.add(m);
      return m;
    });
    // Crates near the road edges on races: knock them flying.
    crates = [];
    if (!track.gates.length) {
      for (let d = 320, side = 1; d < track.length - 200; d += 260, side = -side) {
        if (track.features.some((f) => d > f.at - 80 && d < f.at + f.len + 160)) continue;
        const p = track.pointAt(d);
        const o = (track.width / 2 - 16) * side;
        const mesh = buildCrate();
        group.add(mesh);
        const home = { x: p.x - Math.sin(p.h) * o, y: p.y + Math.cos(p.h) * o };
        crates.push({ mesh, home, x: home.x, y: home.y, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, hit: false });
      }
    }
    scene.add(group);
    buildTitle(group, track, accent);
    fitShadow();
    reset();
    const s = track.pointAt(track.startAt);
    setCar({ x: s.x, y: s.y, z: 0, h: s.h, v: 0 });
    resize();
  }

  // Cameras
  const persp = new THREE.PerspectiveCamera(48, 1, 2, 12000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 12000);
  let camMode = mode;
  let camHeading = null;
  let orbit = 0.7;
  let shake = 0;
  let w = 1;
  let h = 1;

  const state = { x: 0, y: 0, z: 0, h: 0, v: 0, steer: 0, boost: 0, air: false };
  const shown = { x: 0, y: 0, z: 0, h: 0 };
  let firstState = true;
  const smooth = mode === 'overview'; // the big screen smooths between network updates

  function setCar(s) {
    Object.assign(state, s);
    if (firstState) {
      Object.assign(shown, { x: s.x, y: s.y, z: s.z || 0, h: s.h });
      firstState = false;
    }
  }

  function setStars(collected) {
    stars.forEach((m, i) => {
      const got = collected.includes(i);
      if (got && !m.userData.gone) m.userData.gone = performance.now();
      if (!got) {
        m.userData.gone = 0;
        m.visible = true;
        m.scale.setScalar(1);
      }
    });
  }

  // Gate states: closed | good | miss. Opening a gate lifts its arm and lights its lamps.
  function setGate(i, st) {
    const g = gates[i];
    if (!g || g.state === st) return;
    g.state = st;
    const col = st === 'good' ? C.good : st === 'miss' ? C.miss : C.white;
    for (const m of g.lamps) {
      m.color.set(col);
      m.emissive.set(col);
      m.emissiveIntensity = st === 'closed' ? 0.25 : 0.7;
    }
    if (st === 'good') emit(g.x, 50, g.y, 26, [C.good, C.star, 0xffffff, accent], 90);
    if (st === 'miss') emit(g.x, 40, g.y, 8, [C.miss, 0xffffff], 50);
  }

  function reset() {
    setStars([]);
    gates.forEach((g, i) => {
      setGate(i, 'closed');
      g.angle = 0;
      g.pivot.rotation.x = 0;
    });
    for (const c of crates) Object.assign(c, { x: c.home.x, y: c.home.y, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, hit: false });
    for (const p of parts) p.life = 0;
    firstState = true;
    camHeading = null;
  }

  function fx(ev) {
    if (!ev) return;
    if (ev.land) {
      emit(state.x, ROAD_Y + 2, state.y, 14, 0xffffff, 70);
      if (!reduceMotion) shake = Math.min(1, 0.4 + ev.land);
    }
    if (ev.launch) emit(state.x, ROAD_Y + 18, state.y, 8, C.cream, 50);
    if (ev.boost) emit(state.x, ROAD_Y + 4, state.y, 14, [accent, 0xffffff], 60);
    if (ev.newHit) emit(state.x, ROAD_Y + 6, state.y, 6, C.white, 40);
    if (ev.star >= 0 && T?.stars[ev.star]) {
      const s = T.stars[ev.star];
      emit(s.x, (s.z > 0 ? s.z + 6 : 14) + ROAD_Y, s.y, 18, [C.star, 0xffffff], 80);
    }
  }

  function fitShadow() {
    const sc = sun.shadow.camera;
    const big = camMode === 'overview' || camMode === 'preview';
    const span = big && T ? Math.max(T.bounds.w, T.bounds.h) / 2 + 400 : 300;
    const size = big ? 2048 : 1024;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    Object.assign(sc, { left: -span, right: span, top: span, bottom: -span, near: 10, far: 6000 });
    sc.updateProjectionMatrix();
    scene.fog = camMode === 'chase' ? new THREE.Fog(C.bg, 1100, 2600) : camMode === 'showcase' ? new THREE.Fog(C.bg, 1400, 4200) : null;
  }

  function resize() {
    w = canvas.clientWidth || 1;
    h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    persp.aspect = w / h;
    // Panels cover part of the screen: shift the picture so the subject sits in the rest.
    const offX = (ins.right * w) / 2;
    const offY = (ins.bottom * h) / 2;
    if (offX || offY) persp.setViewOffset(w, h, offX, offY, w, h);
    else persp.clearViewOffset();
    persp.updateProjectionMatrix();
    if (T) {
      const b = T.bounds;
      const aspect = w / h;
      const usableW = 1 - ins.right;
      const usableH = 1 - ins.bottom;
      let halfW = (b.w / 2 + 380) / usableW;
      let halfH = ((b.h * 0.83) / 2 + 300) / usableH;
      if (halfW / halfH < aspect) halfW = halfH * aspect;
      else halfH = halfW / aspect;
      Object.assign(ortho, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
      ortho.updateProjectionMatrix();
      ortho.userData.offX = ins.right * halfW;
      ortho.userData.offY = ins.bottom * halfH;
    }
  }

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const tmpV = new THREE.Vector3();
  const one = new THREE.Vector3();
  const look = new THREE.Vector3();
  let t = 0;

  function frame(dt) {
    t += dt;
    if (smooth) {
      const k = 1 - Math.exp(-12 * dt);
      shown.x += (state.x - shown.x) * k;
      shown.y += (state.y - shown.y) * k;
      shown.z += ((state.z || 0) - shown.z) * k;
      shown.h += wrap(state.h - shown.h) * k;
    } else {
      Object.assign(shown, { x: state.x, y: state.y, z: state.z || 0, h: state.h });
    }
    carMesh.position.set(shown.x, ROAD_Y + shown.z, shown.y);
    carMesh.rotation.y = -shown.h;
    carShadow.position.y = 0.4 - shown.z;
    carShadow.material.opacity = Math.max(0.2, 1 - shown.z / 60);
    body.rotation.z = state.air ? THREE.MathUtils.clamp((state.vz || 0) / 500, -0.3, 0.3) : 0;
    body.rotation.x = -(state.steer || 0) * 0.05;
    for (const wh of front) wh.rotation.y = -(state.steer || 0) * 0.45;

    stars.forEach((m) => {
      const u = m.userData;
      if (u.gone) {
        const age = (performance.now() - u.gone) / 1000;
        m.scale.setScalar(1 + age * 4);
        if (age > 0.12) m.visible = false;
        return;
      }
      m.rotation.y = reduceMotion ? 0.6 : t * 2 + u.phase;
      m.position.y = u.base + (reduceMotion ? 0 : Math.sin(t * 3 + u.phase) * 2);
    });
    for (const map of pads) if (!reduceMotion) map.offset.x = (map.offset.x - dt * 1.6) % 1;

    // Gate arms swing up when opened.
    for (const g of gates) {
      const target = g.state === 'closed' ? 0 : 1.35;
      g.angle += (target - g.angle) * Math.min(1, dt * (reduceMotion ? 20 : 6));
      g.pivot.rotation.x = -g.angle;
    }

    const sp = state.v || 0;
    for (const c of crates) {
      if (!c.hit && shown.z < 20 && Math.hypot(c.x - shown.x, c.y - shown.y) < 20 && sp > 20) {
        c.hit = true;
        const side = Math.random() - 0.5;
        c.vx = Math.cos(shown.h) * (sp * 0.9 + 40) - Math.sin(shown.h) * side * 80;
        c.vy = Math.sin(shown.h) * (sp * 0.9 + 40) + Math.cos(shown.h) * side * 80;
        c.vz = 110 + sp * 0.35;
        c.spin = (Math.random() - 0.5) * 16;
        emit(c.x, ROAD_Y + 8, c.y, 8, [0xe0b07a, 0xffffff], 45);
      }
      if (c.hit) {
        c.vz -= 430 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        if (c.z <= 0) {
          c.z = 0;
          c.vz = Math.abs(c.vz) > 60 ? -c.vz * 0.3 : 0;
          c.vx *= 0.7;
          c.vy *= 0.7;
          c.spin *= 0.6;
        }
        c.mesh.rotation.x += c.spin * dt;
        c.mesh.rotation.z += c.spin * 0.6 * dt;
      } else {
        c.mesh.rotation.set(0, 0, 0);
      }
      c.mesh.position.set(c.x, ROAD_Y + c.z, c.y);
    }

    for (let i = 0; i < POOL; i++) {
      const p = parts[i];
      if (p.life > 0) {
        p.life -= dt;
        p.vz -= 300 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z = Math.max(ROAD_Y, p.z + p.vz * dt);
        const s = Math.max(0, p.life / p.max);
        tmpE.set(p.life * 5, p.life * 3, 0);
        tmpQ.setFromEuler(tmpE);
        tmpM.compose(tmpV.set(p.x, p.z, p.y), tmpQ, one.set(s, s, s));
      } else {
        tmpM.makeScale(0, 0, 0);
      }
      partMesh.setMatrixAt(i, tmpM);
    }
    partMesh.instanceMatrix.needsUpdate = true;
    if (state.boost > 0 && !reduceMotion && Math.random() < 0.5) {
      emit(shown.x - Math.cos(shown.h) * 18, ROAD_Y + 6, shown.y - Math.sin(shown.h) * 18, 1, [accent, 0xffffff], 25);
    }

    let cam = persp;
    const b = T?.bounds || { cx: 0, cy: 0, w: 1000, h: 1000 };
    if (camMode === 'overview') {
      cam = ortho;
      const cx = b.cx + (ortho.userData.offX || 0);
      const cz = b.cy + (ortho.userData.offY || 0) * 1.2;
      ortho.position.set(cx, 2600, cz + 1780);
      ortho.lookAt(cx, 0, cz);
      sun.position.set(b.cx - 700, 1600, b.cy + 900);
      sun.target.position.set(b.cx, 0, b.cy);
    } else if (camMode === 'preview') {
      // A slow orbit round the whole island (behind course cards on the phone).
      if (!reduceMotion) orbit += dt * 0.08;
      // Fit the whole island (any way round) into the part of the screen not under panels.
      const size = Math.max(b.w, b.h) + 760;
      const vt = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
      const dist = Math.max(size / 2 / (vt * persp.aspect), (size * 0.62) / 2 / (vt * Math.max(0.3, 1 - ins.bottom)));
      const R = dist / 1.38;
      tmpV.set(b.cx + Math.cos(orbit) * R, R * 0.95, b.cy + Math.sin(orbit) * R);
      persp.position.lerp(tmpV, firstPreview ? 1 : 1 - Math.exp(-2.5 * dt));
      firstPreview = false;
      persp.lookAt(b.cx, -40, b.cy);
      sun.position.set(b.cx - 700, 1600, b.cy + 900);
      sun.target.position.set(b.cx, 0, b.cy);
    } else {
      look.set(shown.x, ROAD_Y + shown.z * 0.6, shown.y);
      if (camMode === 'showcase') {
        if (!reduceMotion) orbit += dt * 0.16;
        tmpV.set(shown.x + Math.cos(orbit) * 230, 165, shown.y + Math.sin(orbit) * 230);
        persp.position.lerp(tmpV, 1 - Math.exp(-3 * dt));
        persp.lookAt(look.x, 14, look.z);
      } else {
        if (camHeading === null) camHeading = shown.h;
        camHeading += wrap(shown.h - camHeading) * (1 - Math.exp(-3.4 * dt));
        tmpV.set(shown.x - Math.cos(camHeading) * 150, 128 + shown.z * 0.5, shown.y - Math.sin(camHeading) * 150);
        persp.position.lerp(tmpV, 1 - Math.exp(-7 * dt));
        if (shake > 0) {
          persp.position.x += (Math.random() - 0.5) * shake * 6;
          persp.position.y += (Math.random() - 0.5) * shake * 6;
          shake = Math.max(0, shake - dt * 3);
        }
        persp.lookAt(shown.x + Math.cos(camHeading) * 75, 8, shown.y + Math.sin(camHeading) * 75);
      }
      sun.position.set(shown.x - 220, 520, shown.y + 260);
      sun.target.position.set(shown.x, 0, shown.y);
    }
    renderer.render(scene, cam);
  }
  let firstPreview = true;

  function setMode(m) {
    if (m === camMode) return;
    if (m === 'chase') camHeading = null;
    if (m === 'preview') firstPreview = camMode !== 'showcase';
    if (m === 'showcase' && camMode === 'chase') orbit = Math.atan2(persp.position.z - shown.y, persp.position.x - shown.x);
    camMode = m;
    fitShadow();
    resize();
  }

  function setInset(v) {
    ins = { right: 0, bottom: 0, ...(typeof v === 'number' ? { right: v } : v) };
    resize();
  }

  setTrack(track);
  if (camMode !== 'overview') {
    const s = T.pointAt(T.startAt);
    persp.position.set(s.x + 160, 120, s.y + 140);
  }

  return {
    setTrack, setCar, setStars, setGate, reset, fx, frame, resize, setMode, setInset, emit,
    get track() {
      return T;
    },
    get mode() {
      return camMode;
    },
  };
}
