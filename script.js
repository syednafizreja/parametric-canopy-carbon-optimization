/* Parametric Carbon Optimization – Concrete Canopy
   High-quality research prototype
   Geometry → section properties → structural response → volume → embodied carbon
*/

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ================= 1. MODEL ================= */

const MAT = { rho: 2450, E: 45e9, EF: 0.34, fc: 55e6, ft: 8e6 };
const G = 9.81, QK = 750;
const PHI = 1.5;
const H0 = 2.8;
const SLOPE_MAX = 40;
const EEFF = MAT.E / (1 + PHI);

const DEF = { L: 16, rise: 0.9, t: 0.16, n: 4, camber: 0.3, shape: 2.0 };

const SL = [
  ['L', 'Span', 'm', 12, 18, 0.5, 1, 1],
  ['rise', 'Transverse rise', 'm', 0.4, 1.8, 0.05, 1, 2],
  ['t', 'Shell thickness', 'mm', 0.05, 0.25, 0.005, 1000, 0],
  ['n', 'Tree supports', '', 2, 5, 1, 1, 0],
  ['camber', 'Longitudinal camber', 'm', 0, 1, 0.05, 1, 2],
  ['shape', 'Shape factor (crown)', '', 1.8, 3, 0.05, 1, 2]
];
const KEYS = SL.map(s => s[0]);

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const halfW = (p, xi) => 0.225 * p.L * (0.62 + 0.38 * Math.cos(Math.PI * xi / 2));
const rise = (p, xi) => p.rise * (1 - 0.3 * xi * xi) + p.camber * (1 - xi * xi);
const crown = (p, e) => 1 - Math.pow(Math.abs(e), p.shape);
const yAt = (p, xi, e) => H0 + rise(p, xi) * crown(p, e);
const pos = (p, xi, e) => [xi * p.L / 2, yAt(p, xi, e), e * halfW(p, xi)];
const thick = (p, e) => p.t * (1 + 2.5 * Math.pow(Math.abs(e), 10));

const tri = (P, a, b, c) => {
  const ux = P[3*b]-P[3*a], uy = P[3*b+1]-P[3*a+1], uz = P[3*b+2]-P[3*a+2];
  const vx = P[3*c]-P[3*a], vy = P[3*c+1]-P[3*a+1], vz = P[3*c+2]-P[3*a+2];
  return 0.5 * Math.hypot(uy*vz - uz*vy, uz*vx - ux*vz, ux*vy - uy*vx);
};

function build(p, NU, NV, buf) {
  const G1 = NU + 1, Gn = G1 * (NV + 1);
  const P = new Float32Array(Gn * 3), T = new Float32Array(Gn), d = 1e-3;
  let slope = 0;
  const N = buf ? new Float32Array(Gn * 3) : null;

  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const k = j * G1 + i, xi = -1 + 2 * i / NU, e = -1 + 2 * j / NV;
    const a = pos(p, xi, e);
    const u1 = pos(p, Math.min(1, xi + d), e), u0 = pos(p, Math.max(-1, xi - d), e);
    const v1 = pos(p, xi, Math.min(1, e + d)), v0 = pos(p, xi, Math.max(-1, e - d));
    const U = [u1[0]-u0[0], u1[1]-u0[1], u1[2]-u0[2]];
    const V = [v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
    const n = [V[1]*U[2]-V[2]*U[1], V[2]*U[0]-V[0]*U[2], V[0]*U[1]-V[1]*U[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    slope = Math.max(slope, Math.acos(n[1] / l) * 180 / Math.PI);
    P.set(a, 3 * k); T[k] = thick(p, e);
    if (N) N.set([n[0]/l, n[1]/l, n[2]/l], 3 * k);
  }

  let area = 0, vol = 0;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j*G1+i, b=a+1, c=b+G1, dd=a+G1;
    const A = tri(P,a,b,dd) + tri(P,c,dd,b);
    area += A; vol += A * (T[a]+T[b]+T[c]+T[dd]) / 4;
  }

  if (buf) {
    const out = buf.pos, NP = buf.perim.length;
    for (let k = 0; k < Gn; k++) for (let c = 0; c < 3; c++) {
      const o = N[3*k+c] * T[k] / 2;
      out[3*k+c] = P[3*k+c] + o;
      out[3*(Gn+k)+c] = P[3*k+c] - o;
    }
    buf.perim.forEach((k, r) => {
      for (let c = 0; c < 3; c++) {
        out[3*(2*Gn+r)+c] = out[3*k+c];
        out[3*(2*Gn+NP+r)+c] = out[3*(Gn+k)+c];
      }
    });
  }
  return { area, vol, slope };
}

function limbs(p) {
  const n = Math.round(p.n), s = p.L / n, out = [];
  for (let i = 0; i < n; i++) {
    const x = -p.L/2 + s*(i+0.5), jy = yAt(p, 2*x/p.L, 0) - p.t/2 - 1.25;
    out.push({ a: [x, 0, 0], b: [x, jy, 0], r: 0.20 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const bx = x + sx*0.95, xi = 2*bx/p.L, bz = sz*1.15, e = bz / halfW(p, xi);
      out.push({ a: [x, jy, 0], b: [bx, yAt(p, xi, e) - thick(p, e)/2 + 0.03, bz], r: 0.11 });
    }
  }
  return out;
}
const limbVol = l => Math.PI * Math.hypot(l.b[0]-l.a[0], l.b[1]-l.a[1], l.b[2]-l.a[2]) * l.r * l.r * 0.653;

function section(p, xi) {
  const K = 40, b = halfW(p, xi), D = rise(p, xi), seg = [];
  let A = 0, S = 0, I0 = 0, pz, py, pt;
  for (let k = 0; k <= K; k++) {
    const e = -1 + 2*k/K, y = H0 + D*crown(p, e), z = e*b, t = thick(p, e);
    if (k) {
      const tm = (t+pt)/2, ds = Math.hypot(z-pz, y-py), a = tm*ds;
      A += a; S += a*(y+py)/2; I0 += tm**3 * ds / 12; seg.push([a, (y+py)/2]);
    }
    pz = z; py = y; pt = t;
  }
  const yb = S / A; let I = I0;
  for (const [a, ym] of seg) I += a * (ym - yb)**2;
  return { I, top: H0 + D + p.t/2 - yb, bot: yb - H0 + thick(p, 1)/2, w: 2*b };
}

function gauss(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) for (let r = i+1; r < n; r++) {
    const f = A[r][i] / A[i][i];
    for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
    b[r] -= f * b[i];
  }
  const x = Array(n);
  for (let i = n-1; i >= 0; i--) {
    let s = b[i];
    for (let c = i+1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

function analyse(p, g, NS = 100) {
  const n = Math.round(p.n), s = p.L / n, c = s / 2, dx = p.L / NS;
  const xs = Array.from({ length: n }, (_, i) => -p.L/2 + c + i*s);
  const X = [], S = []; let invI = 0, wid = 0;
  for (let i = 0; i <= NS; i++) {
    const x = -p.L/2 + i*dx, q = section(p, 2*x/p.L);
    X.push(x); S.push(q); invI += 1/q.I; wid += q.w;
  }
  const Ieff = (NS+1)/invI, B = wid/(NS+1);
  const wg = g.vol / p.L * MAT.rho * G, wq = QK * B, ws = wg + wq, wu = 1.35*wg + 1.5*wq;

  const M = new Array(n).fill(-c*c/2), m = n - 2;
  if (m > 0) {
    const A = [], r = [];
    for (let i = 0; i < m; i++) {
      A.push(Array(m).fill(0)); A[i][i] = 4;
      if (i) A[i][i-1] = 1; if (i < m-1) A[i][i+1] = 1;
      r.push(-s*s/2 - (i===0 ? M[0] : 0) - (i===m-1 ? M[n-1] : 0));
    }
    gauss(A, r).forEach((v, i) => { M[i+1] = v; });
  }

  const Mx = x => {
    if (x < xs[0]) return -((xs[0]-x)**2)/2;
    if (x > xs[n-1]) return -((x-xs[n-1])**2)/2;
    const k = Math.min(n-2, Math.floor((x-xs[0])/s)), e = (x-xs[k])/s;
    return M[k]*(1-e) + M[k+1]*e + s*s*e*(1-e)/2;
  };

  const th = [0], y = [0];
  for (let i = 0; i < NS; i++) {
    const k0 = ws * Mx(X[i]) / (EEFF * Ieff);
    const k1 = ws * Mx(X[i+1]) / (EEFF * Ieff);
    th.push(th[i] + (k0+k1)*dx/2);
    y.push(y[i] + (th[i]+th[i+1])*dx/2);
  }
  const i0 = Math.round((xs[0]+p.L/2)/dx), i1 = Math.round((xs[n-1]+p.L/2)/dx);
  const Bs = -(y[i1]-y[i0]) / (X[i1]-X[i0]), As = -y[i0] - Bs*X[i0];

  let dBeam = 0, uF = 0;
  for (let i = 0; i <= NS; i++) {
    dBeam = Math.max(dBeam, Math.abs(y[i] + As + Bs*X[i]));
    const Mu = wu * Mx(X[i]), q = S[i];
    const sg = Mu >= 0 ? [q.top, q.bot] : [q.bot, q.top];
    uF = Math.max(uF, Math.abs(Mu) * Math.max(sg[0]/MAT.fc, sg[1]/MAT.ft) / q.I);
  }

  const b0 = halfW(p, 0), D0 = rise(p, 0), R = (b0*b0 + D0*D0)/(2*D0), tav = g.vol / g.area;
  const dLoc = (tav*MAT.rho*G + QK) * b0**4 / (8 * EEFF * (p.t**3/12) * (1 + 0.06*(D0/p.t)**2));
  const pcr = 0.25 * EEFF * p.t**3 / (4 * 0.96 * R**3);
  const uB = (1.35*tav*MAT.rho*G + 1.5*QK) / pcr;
  const defl = dBeam + dLoc, uD = defl / (Math.max(s, 2*b0)/250);
  const util = Math.max(uF, uB, uD);
  return { defl: defl*1000, util, gov: util===uB ? 'buckling' : util===uD ? 'deflection' : 'flexure', B, s };
}

function evaluate(p, fine, buf) {
  const g = fine ? build(p, 96, 32, buf) : build(p, 28, 10, null);
  const L = limbs(p);
  const V = g.vol + L.reduce((a, l) => a + limbVol(l), 0);
  const an = analyse(p, g, fine ? 100 : 40);
  return { ...an, vol: V, carbon: V * MAT.rho * MAT.EF, area: g.area, slope: g.slope, mass: V * MAT.rho / 1000, limbs: L };
}

const REF = evaluate(DEF, true, null);

const cost = p => {
  const m = evaluate(p, false);
  return m.carbon / REF.carbon + 0.15 * m.defl / REF.defl + 10 * Math.max(0, m.util - 0.85) + 0.05 * Math.max(0, m.slope - SLOPE_MAX);
};

function optimise(p0) {
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let best = { ...p0 }, fb = cost(best);
  const trail = [{ ...best }], N = 350;
  for (let it = 0; it < N; it++) {
    const sg = 0.05 + 0.25 * (1 - it / N), c = { ...best };
    for (const [k, , , mn, mx, st] of SL) {
      if (k === 'L') continue;
      if (k === 'n') { if (rnd() < 0.12) c.n = clamp(c.n + (rnd() < 0.5 ? -1 : 1), mn, mx); continue; }
      c[k] = clamp(Math.round((c[k] + gs() * sg * (mx - mn)) / st) * st, mn, mx);
    }
    const f = cost(c);
    if (f < fb) { fb = f; best = c; trail.push({ ...c }); }
  }
  return { trail, evals: N };
}

/* ================= 2. SCENE + UI ================= */

const $ = id => document.getElementById(id);
let P = { ...DEF }, dirty = true, anim = false;

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f4f0);
scene.fog = new THREE.Fog(0xf5f4f0, 55, 110);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 2.4, 0);
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 9;
controls.maxDistance = 55;

// Soft professional lighting for light background
scene.add(new THREE.HemisphereLight(0xf8f6f2, 0xd8d4cc, 0.55));
const sun = new THREE.DirectionalLight(0xfff8f0, 1.6);
sun.position.set(12, 20, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, far: 70 });
sun.shadow.bias = -0.00035;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xe8eef8, 0.45);
fill.position.set(-10, 8, -6);
scene.add(fill);

// Ground
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(50, 64),
  new THREE.MeshStandardMaterial({ color: 0xeae7e1, roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(60, 60, 0xd0cdc6, 0xe2dfd8);
grid.position.y = 0.008;
scene.add(grid);

// Light concrete material (professional, readable)
const cv = document.createElement('canvas');
cv.width = cv.height = 256;
const cx = cv.getContext('2d');
const im = cx.createImageData(256, 256);
for (let i = 0; i < im.data.length; i += 4) {
  const v = 210 + Math.random() * 28;
  im.data.set([v, v * 0.985, v * 0.96, 255], i);
}
cx.putImageData(im, 0, 0);
const tex = new THREE.CanvasTexture(cv);
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.colorSpace = THREE.SRGBColorSpace;

const mat = new THREE.MeshStandardMaterial({
  color: 0xd8d4cc,          // soft light concrete / timber-like
  map: tex,
  bumpMap: tex,
  bumpScale: 0.55,
  roughness: 0.78,
  metalness: 0.02,
  side: THREE.DoubleSide
});

// Shell mesh
const NU = 96, NV = 32, G1 = NU + 1, Gn = G1 * (NV + 1);
const perim = [];
for (let i = 0; i < NU; i++) perim.push(i);
for (let j = 0; j < NV; j++) perim.push(j * G1 + NU);
for (let i = NU; i > 0; i--) perim.push(NV * G1 + i);
for (let j = NV; j > 0; j--) perim.push(j * G1);

const NP = perim.length;
const geo = new THREE.BufferGeometry();
const idx = [];
const uv = new Float32Array((2 * Gn + 2 * NP) * 2);

for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
  const k = j * G1 + i;
  uv.set([i / NU * 8, j / NV * 3], 2 * k);
  uv.set([i / NU * 8, j / NV * 3], 2 * (Gn + k));
}
for (let r = 0; r < NP; r++) {
  uv.set([r / NP * 24, 0], 2 * (2 * Gn + r));
  uv.set([r / NP * 24, 0.28], 2 * (2 * Gn + NP + r));
}

for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
  const a = j * G1 + i, b = a + 1, c = b + G1, d = a + G1;
  idx.push(a, c, b, a, d, c, Gn + a, Gn + b, Gn + c, Gn + a, Gn + c, Gn + d);
}
for (let r = 0; r < NP; r++) {
  const r2 = (r + 1) % NP;
  const t0 = 2 * Gn + r, t1 = 2 * Gn + r2, b0 = 2 * Gn + NP + r, b1 = 2 * Gn + NP + r2;
  idx.push(t0, b0, b1, t0, b1, t1);
}

const posAttr = new THREE.BufferAttribute(new Float32Array((2 * Gn + 2 * NP) * 3), 3).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr);
geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
geo.setIndex(idx);

const shell = new THREE.Mesh(geo, mat);
shell.castShadow = shell.receiveShadow = true;
shell.frustumCulled = false;
scene.add(shell);

const buf = { pos: posAttr.array, perim };

// Limb pool
const limbGeo = new THREE.CylinderGeometry(0.6, 1, 1, 18, 1);
const pool = [];
for (let i = 0; i < 25; i++) {
  const m = new THREE.Mesh(limbGeo, mat);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  pool.push(m);
}
const UP = new THREE.Vector3(0, 1, 0), va = new THREE.Vector3(), vb = new THREE.Vector3();

function placeLimbs(list) {
  pool.forEach((m, i) => {
    const l = list[i];
    m.visible = !!l;
    if (!l) return;
    va.fromArray(l.a); vb.fromArray(l.b);
    const d = vb.clone().sub(va), len = d.length();
    m.position.copy(va).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize());
    m.scale.set(l.r, len, l.r);
  });
}

// Sliders
const outs = {}, ins = {};
SL.forEach(([k, lab, u, mn, mx, st, sc, dp]) => {
  const d = document.createElement('div');
  d.className = 'sl';
  d.innerHTML = `<label for="s-${k}">${lab}<output id="o-${k}"></output></label>
                 <input id="s-${k}" type="range" min="${mn}" max="${mx}" step="${st}">`;
  $('sliders').appendChild(d);
  ins[k] = d.querySelector('input');
  outs[k] = d.querySelector('output');
  ins[k].oninput = () => { if (anim) return; P[k] = +ins[k].value; sync(); queue(); };
});

function sync() {
  SL.forEach(([k, , u, , , , sc, dp]) => {
    ins[k].value = P[k];
    outs[k].textContent = (P[k] * sc).toFixed(dp) + (u ? ' ' + u : '');
  });
}

const pct = (v, r) => {
  const x = (v / r - 1) * 100;
  return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + '%';
};

function show(m) {
  const set = (id, val, v, r) => {
    $('k-' + id).textContent = val;
    const d = $('d-' + id), x = v / r - 1;
    d.textContent = pct(v, r) + ' vs reference';
    d.className = Math.abs(x) < 5e-4 ? '' : x < 0 ? 'ok' : 'wr';
  };
  set('vol', m.vol.toFixed(1), m.vol, REF.vol);
  set('co2', Math.round(m.carbon).toLocaleString('en-US'), m.carbon, REF.carbon);
  set('def', m.defl.toFixed(1), m.defl, REF.defl);
  $('k-util').textContent = Math.round(m.util * 100) + '%';
  $('d-util').textContent = 'governed by ' + m.gov;
  $('d-util').className = m.util < 0.7 ? 'ok' : m.util < 1 ? 'wr' : 'bd';
  $('dims').textContent = `${P.L.toFixed(1)} × ${m.B.toFixed(1)} m · ${Math.round(P.n)} trees · ${m.area.toFixed(0)} m² · ${m.mass.toFixed(1)} t · max slope ${m.slope.toFixed(0)}°${m.slope > SLOPE_MAX ? ' (over 40°)' : ''}`;
}

function refresh() {
  const m = evaluate(P, true, buf);
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
  placeLimbs(m.limbs);
  show(m);
  dirty = true;
  return m;
}

let pend = false;
const queue = () => {
  if (!pend) {
    pend = true;
    requestAnimationFrame(() => { pend = false; refresh(); });
  }
};

// Optimization
const run = $('run');
const say = t => { $('status').textContent = t; };

run.onclick = () => {
  if (anim) return;
  const start = evaluate(P, false);
  const { trail, evals } = optimise({ ...P });
  if (trail.length < 2) { say('Already near a local optimum for this model.'); return; }

  const kf = trail.length > 40
    ? Array.from({ length: 40 }, (_, i) => trail[Math.round(i * (trail.length - 1) / 39)])
    : trail;

  anim = true;
  run.disabled = true;
  say('Optimizing…');

  const t0 = performance.now(), D = 3200;
  const step = now => {
    const u = clamp((now - t0) / D, 0, 1);
    const e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
    const f = e * (kf.length - 1);
    const i = Math.min(kf.length - 2, Math.floor(f));
    const r = f - i;

    for (const k of KEYS) {
      P[k] = k === 'n'
        ? (r < 0.5 ? kf[i] : kf[i + 1]).n
        : kf[i][k] + (kf[i + 1][k] - kf[i][k]) * r;
    }
    sync();
    const m = refresh();

    if (u < 1) return requestAnimationFrame(step);
    anim = false;
    run.disabled = false;
    say(`Carbon ${pct(m.carbon, start.carbon)}, deflection ${pct(m.defl, start.defl)} · ${evals} evaluations`);
  };
  requestAnimationFrame(step);
};

$('reset').onclick = () => {
  if (anim) return;
  P = { ...DEF };
  sync();
  refresh();
  say('');
};

// Toolbar
$('wire').onclick = e => {
  mat.wireframe = !mat.wireframe;
  e.currentTarget.setAttribute('aria-pressed', mat.wireframe);
  dirty = true;
};

function fit() {
  const a = camera.aspect;
  const d = 26 * Math.max(1, 1.12 / a);
  camera.position.set(0.58 * d, 0.38 * d, 0.72 * d);
  controls.target.set(0, 2.5, 0);
  dirty = true;
}
$('fit').onclick = fit;

new ResizeObserver(() => {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}).observe(view);

const panel = $('panel'), fold = $('fold');
fold.onclick = () => {
  panel.classList.toggle('fold');
  fold.setAttribute('aria-expanded', !panel.classList.contains('fold'));
};
if (matchMedia('(max-width:820px)').matches) {
  panel.classList.add('fold');
  fold.setAttribute('aria-expanded', 'false');
}

sync();
refresh();
camera.aspect = 1.6;
fit();

(function loop() {
  requestAnimationFrame(loop);
  if (controls.update() || dirty) {
    renderer.render(scene, camera);
    dirty = false;
  }
})();
