/* Parametric Carbon Optimization – Aviation Canopy
   Research prototype: geometry -> section properties -> structural response -> volume -> embodied carbon.
   Form language drawn from three terminals: KLIA (hyperbolic-paraboloid shells on conical "tree" columns, linear timber
   soffit), Hamad International (undulating "dune" roof) and Baku Heydar Aliyev (swooping tapered wing, hexagonal skylights
   integrated in the roof grid, tree pillars). Part 1 (model) is plain JavaScript; part 2 (scene + UI) uses Three.js. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ================= 1. MODEL ================= */

// Indicative data. EF = kgCO2e per kg of a cement-rich HPC/UHPFRC thin-shell mix (fibres included, cradle to gate);
// ordinary C35/45 would be about 0.13-0.16. fc / ft = design compression / effective tension (Pa).
const MAT = { rho: 2450, E: 45e9, EF: 0.34, fc: 55e6, ft: 8e6 };
const G = 9.81, QK = 750, PHI = 1.5, H0 = 2.8, SLOPE_MAX = 40; // gravity, imposed load (Pa), creep, clear height under edges, max slope for single-sided casting
const EEFF = MAT.E / (1 + PHI);
const RIB_T = 0.08, RIB_D = 0.3, MAXR = 18, RK = 24, SKY_B = 1.7; // ribs; half-width of the skylight band along the ridge (m)

// key, label, unit, min, max, step, display scale, decimals, group, optimised?  Form = architectural intent, kept fixed by the optimizer.
const SL = [
  ['L', 'Span', 'm', 12, 18, 0.5, 1, 1, 'Form', 0],
  ['B', 'Width', 'm', 5, 10, 0.25, 1, 2, 'Form', 0],
  ['tip', 'Tip width', '%', 0.05, 0.6, 0.01, 100, 0, 'Form', 0],
  ['sweep', 'Plan sweep (crescent)', 'm', -3, 3, 0.1, 1, 1, 'Form', 0],
  ['bend', 'Wing upsweep', 'm', -0.8, 2.5, 0.05, 1, 2, 'Form', 0],
  ['twist', 'Twist (hypar warp)', '°', -30, 30, 0.5, 1, 1, 'Form', 0],
  ['wave', 'Wave amplitude', 'm', 0, 0.8, 0.05, 1, 2, 'Form', 0],
  ['nw', 'Wave count', '', 1, 3, 0.25, 1, 2, 'Form', 0],
  ['rise', 'Transverse rise', 'm', 0.4, 1.8, 0.05, 1, 2, 'Structure', 1],
  ['camber', 'Longitudinal camber', 'm', 0, 1, 0.05, 1, 2, 'Structure', 1],
  ['shape', 'Crown exponent', '', 1.8, 3, 0.05, 1, 2, 'Structure', 1],
  ['t', 'Shell thickness', 'mm', 0.05, 0.25, 0.005, 1000, 0, 'Structure', 1],
  ['n', 'Tree supports', '', 2, 5, 1, 1, 0, 'Structure', 1],
  ['rib', 'Rib spacing', 'm', 1, 5, 0.1, 1, 1, 'Structure', 1],
  ['sky', 'Skylight openness', '%', 0, 0.8, 0.02, 100, 0, 'Details', 0],
  ['spread', 'Branch spread', 'm', 0.6, 2.2, 0.05, 1, 2, 'Details', 0]
];
const KEYS = SL.map(s => s[0]);
const DEF = { L: 16, B: 8, tip: 0.2, sweep: 1.2, bend: 0.8, twist: 6, wave: 0.25, nw: 2, rise: 0.8, camber: 0.25, shape: 2.0, t: 0.14, n: 4, rib: 2.0, sky: 0.45, spread: 1.3 };
const PRESETS = {
  'Default': {},
  'KLIA hypar': { B: 9, tip: 0.55, sweep: 0, bend: 0.3, twist: 14, wave: 0, shape: 2.3, rise: 1.0, camber: 0.2, n: 4, rib: 1.6, sky: 0.4, spread: 1.8, t: 0.18 },
  'Hamad dunes': { tip: 0.3, sweep: 0, bend: 0.5, twist: 0, wave: 0.65, nw: 2.5, rise: 0.8, camber: 0.2, rib: 2.2, sky: 0.3 },
  'Baku wing': { B: 8.5, tip: 0.15, sweep: 1.6, bend: 1.0, twist: 6, rise: 0.9, camber: 0.3, shape: 2.1, sky: 0.6, spread: 1.2 }
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const RAD = Math.PI / 180;
// Mid-surface. xi along the span, e across (-1..1). Ridge on the tree axis, wings fall to the edge beams.
const zc = (p, xi) => p.sweep * xi * xi;                                                                  // crescent centre line
const halfW = (p, xi) => 0.5 * p.B * (p.tip + (1 - p.tip) * Math.cos(Math.PI * xi / 2));  // tapered wing planform
const waveF = (p, xi) => p.wave * Math.sin(Math.PI * p.nw * (xi + 1)) * Math.cos(Math.PI * xi / 2);       // "dune" undulation
// rise scales with the local half-width, so the transverse slope stays moderate toward the narrow wing tips
const rise = (p, xi) => Math.max(0.15, (p.rise * (1 - 0.3 * xi * xi) + p.camber * (1 - xi * xi)) * halfW(p, xi) / (0.5 * p.B) + 0.5 * waveF(p, xi));
const crown = (p, e) => 1 - Math.pow(Math.abs(e), p.shape);
// height = clear height + upsweep of the tips + wave + twist of the cross-section about the span axis + crowned profile
const yAt = (p, xi, e) => H0 + p.bend * Math.pow(Math.abs(xi), 2.2) + 0.5 * waveF(p, xi) + e * halfW(p, xi) * Math.tan(p.twist * RAD * xi) + rise(p, xi) * crown(p, e);
const pos = (p, xi, e) => [xi * p.L / 2, yAt(p, xi, e), zc(p, xi) + e * halfW(p, xi)];
const thick = (p, e) => p.t * (1 + 2.5 * Math.pow(Math.abs(e), 10)); // thickening toward e = +-1 forms the edge beams
const ribCount = p => clamp(Math.floor(p.L / p.rib), 1, MAXR);
const nrm = (p, xi, e) => { // unit surface normal (up) from central differences
  const d = 1e-3, a = pos(p, Math.min(1, xi + d), e), b = pos(p, Math.max(-1, xi - d), e), c = pos(p, xi, Math.min(1, e + d)), f = pos(p, xi, Math.max(-1, e - d));
  const U = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], V = [c[0] - f[0], c[1] - f[1], c[2] - f[2]];
  const n = [V[1] * U[2] - V[2] * U[1], V[2] * U[0] - V[0] * U[2], V[0] * U[1] - V[1] * U[0]], l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
};
const arc = (p, xi) => { let s = 0, b = halfW(p, xi), pz = -b, py = yAt(p, xi, -1); // cross-section arc length
  for (let k = 1; k <= 16; k++) { const e = -1 + k / 8, z = e * b, y = yAt(p, xi, e); s += Math.hypot(z - pz, y - py); pz = z; py = y; }
  return s; };
const ribVol = p => { const n = ribCount(p); let v = 0; // tapered rib area = 2/3 of depth x arc
  for (let r = 0; r < n; r++) v += RIB_T * RIB_D * (2 / 3) * arc(p, -1 + (r + 0.5) * 2 / n);
  return v; };
const tri = (P, a, b, c) => {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

// Grid of the mid-surface: area, volume (integral of t dA, minus skylight openings), max slope.
// With buf it also writes the thick-shell mesh (top, bottom, perimeter ring).
function build(p, NU, NV, buf) {
  const G1 = NU + 1, Gn = G1 * (NV + 1), P = new Float32Array(Gn * 3), T = new Float32Array(Gn), N = buf ? new Float32Array(Gn * 3) : null;
  let slope = 0;
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const k = j * G1 + i, xi = -1 + 2 * i / NU, e = -1 + 2 * j / NV, n = nrm(p, xi, e);
    slope = Math.max(slope, Math.acos(clamp(n[1], -1, 1)) * 180 / Math.PI);
    P.set(pos(p, xi, e), 3 * k); T[k] = thick(p, e);
    if (N) N.set(n, 3 * k);
  }
  let area = 0, vol = 0, bandA = 0, bandV = 0;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * G1 + i, b = a + 1, c = b + G1, dd = a + G1, A = tri(P, a, b, dd) + tri(P, c, dd, b), v = A * (T[a] + T[b] + T[c] + T[dd]) / 4;
    area += A; vol += v;
    const xm = (P[3 * a] + P[3 * c]) / 2, zm = (P[3 * a + 2] + P[3 * c + 2]) / 2;
    if (Math.abs(zm - zc(p, 2 * xm / p.L)) < SKY_B) { bandA += A; bandV += v; } // skylight band along the ridge
  }
  vol -= p.sky * p.sky * bandV; // hexagonal openings remove a fraction sky^2 of the band
  if (buf) {
    const out = buf.pos, NP = buf.perim.length;
    for (let k = 0; k < Gn; k++) for (let c = 0; c < 3; c++) {
      const o = N[3 * k + c] * T[k] / 2;
      out[3 * k + c] = P[3 * k + c] + o; out[3 * (Gn + k) + c] = P[3 * k + c] - o;
    }
    buf.perim.forEach((k, r) => { for (let c = 0; c < 3; c++) {
      out[3 * (2 * Gn + r) + c] = out[3 * k + c]; out[3 * (2 * Gn + NP + r) + c] = out[3 * (Gn + k) + c]; } });
  }
  return { area, vol, slope, share: bandA / area };
}

// Tree supports (KLIA / Baku "tree pillars"): conical trunk + four branches. Same data drives volume and meshes.
function limbs(p) {
  const n = Math.round(p.n), s = p.L / n, out = [];
  for (let i = 0; i < n; i++) {
    const x = -p.L / 2 + s * (i + 0.5), xi = 2 * x / p.L, z0 = zc(p, xi), jy = Math.max(1.4, yAt(p, xi, 0) - p.t / 2 - (0.9 + 0.5 * p.spread));
    out.push({ a: [x, 0, z0], b: [x, jy, z0], r: 0.26 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const bx = x + sx * (0.5 + 0.35 * p.spread), xb = 2 * bx / p.L, hw = halfW(p, xb), e = clamp(sz * p.spread / hw, -0.95, 0.95);
      out.push({ a: [x, jy, z0], b: [bx, yAt(p, xb, e) - thick(p, e) / 2 + 0.03, zc(p, xb) + e * hw], r: 0.12 });
    }
  }
  return out;
}
const limbVol = l => Math.PI * Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]) * l.r * l.r * 0.583; // taper 1 -> 0.5

// Cross-section at station xi, integrated over 40 strips of the real (twisted, bent) profile: area, I, extreme fibres.
// Edge-beam thickening acts as the tension chord, rise acts as structural depth.
function section(p, xi) {
  const K = 40, b = halfW(p, xi), seg = []; let A = 0, S = 0, I0 = 0, pz, py, pt, ymax = -1e9, ymin = 1e9;
  for (let k = 0; k <= K; k++) {
    const e = -1 + 2 * k / K, y = yAt(p, xi, e), z = e * b, t = thick(p, e);
    ymax = Math.max(ymax, y); ymin = Math.min(ymin, y);
    if (k) { const tm = (t + pt) / 2, ds = Math.hypot(z - pz, y - py), a = tm * ds; A += a; S += a * (y + py) / 2; I0 += tm ** 3 * ds / 12; seg.push([a, (y + py) / 2]); }
    pz = z; py = y; pt = t;
  }
  const yb = S / A; let I = I0;
  for (const [a, ym] of seg) I += a * (ym - yb) ** 2;
  return { I, top: ymax + p.t / 2 - yb, bot: yb - ymin + thick(p, 1) / 2, w: 2 * b };
}

function gauss(A, b) { // tiny dense solver for the three-moment system
  const n = b.length;
  for (let i = 0; i < n; i++) for (let r = i + 1; r < n; r++) {
    const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  const x = Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

/* Structural response (screening level).
   1 Global: shell = girder on n tree supports with half-bay cantilevers. Support moments from the three-moment equation,
     deflection by double integration of M/(E_eff I), stresses from the section at each station.
   2 Local: wing deflection as a shallow-shell cantilever (flat-plate stiffness x (1 + 0.06 (D/t)^2), a calibrated
     surrogate for membrane action), reduced cantilever length by branch spread; ribs as smeared T-section; skylights
     weaken the band; buckling of the transverse arch with a 0.25 knock-down factor.
   Utilization = max(flexure, buckling, deflection / (span/250)). */
function analyse(p, g, NS = 100) {
  const n = Math.round(p.n), s = p.L / n, c = s / 2, dx = p.L / NS, xs = Array.from({ length: n }, (_, i) => -p.L / 2 + c + i * s);
  const X = [], S = []; let invI = 0, wid = 0;
  for (let i = 0; i <= NS; i++) { const x = -p.L / 2 + i * dx, q = section(p, 2 * x / p.L); X.push(x); S.push(q); invI += 1 / q.I; wid += q.w; }
  const Ieff = (NS + 1) / invI, B = wid / (NS + 1);
  const wg = g.vol / p.L * MAT.rho * G, wq = QK * B, ws = wg + wq, wu = 1.35 * wg + 1.5 * wq; // N/m

  const M = new Array(n).fill(-c * c / 2), m = n - 2; // unit-load moments; end supports carry the cantilevers
  if (m > 0) {
    const A = [], r = [];
    for (let i = 0; i < m; i++) { A.push(Array(m).fill(0)); A[i][i] = 4; if (i) A[i][i - 1] = 1; if (i < m - 1) A[i][i + 1] = 1;
      r.push(-s * s / 2 - (i === 0 ? M[0] : 0) - (i === m - 1 ? M[n - 1] : 0)); }
    gauss(A, r).forEach((v, i) => { M[i + 1] = v; });
  }
  const Mx = x => {
    if (x < xs[0]) return -((xs[0] - x) ** 2) / 2;
    if (x > xs[n - 1]) return -((x - xs[n - 1]) ** 2) / 2;
    const k = Math.min(n - 2, Math.floor((x - xs[0]) / s)), e = (x - xs[k]) / s;
    return M[k] * (1 - e) + M[k + 1] * e + s * s * e * (1 - e) / 2;
  };
  const th = [0], y = [0]; // y'' = M / EI, then enforce y = 0 at first and last tree
  for (let i = 0; i < NS; i++) {
    const k0 = ws * Mx(X[i]) / (EEFF * Ieff), k1 = ws * Mx(X[i + 1]) / (EEFF * Ieff);
    th.push(th[i] + (k0 + k1) * dx / 2); y.push(y[i] + (th[i] + th[i + 1]) * dx / 2);
  }
  const i0 = Math.round((xs[0] + p.L / 2) / dx), i1 = Math.round((xs[n - 1] + p.L / 2) / dx);
  const Bs = -(y[i1] - y[i0]) / (X[i1] - X[i0]), As = -y[i0] - Bs * X[i0];
  let dBeam = 0, uF = 0;
  for (let i = 0; i <= NS; i++) {
    dBeam = Math.max(dBeam, Math.abs(y[i] + As + Bs * X[i]));
    const Mu = wu * Mx(X[i]), q = S[i], sg = Mu >= 0 ? [q.top, q.bot] : [q.bot, q.top]; // [compression, tension] fibre
    uF = Math.max(uF, Math.abs(Mu) * Math.max(sg[0] / MAT.fc, sg[1] / MAT.ft) / q.I);
  }
  const b0 = halfW(p, 0), bE = Math.max(1.2, b0 - 0.5 * p.spread), D0 = rise(p, 0), R = (b0 * b0 + D0 * D0) / (2 * D0), tav = g.vol / g.area;
  const dm = 0.6 * RIB_D, weak = 1 - 0.6 * p.sky * p.sky * g.share; // skylight band weakening
  const Iw = weak * (p.t ** 3 / 12 + 0.5 * RIB_T * (dm ** 3 / 12 + dm * (dm / 2 + p.t / 2) ** 2) / (p.L / ribCount(p))); // 0.5: shear-lag / cracking
  const dLoc = (tav * MAT.rho * G + QK) * bE ** 4 / (8 * EEFF * Iw * (1 + 0.06 * (D0 / p.t) ** 2));
  const te = Math.min(Math.cbrt(12 * Iw), 2.2 * p.t), pcr = 0.25 * EEFF * te ** 3 / (4 * 0.96 * R ** 3);
  const uB = (1.35 * tav * MAT.rho * G + 1.5 * QK) / pcr, defl = dBeam + dLoc, uD = defl / (Math.max(s, 2 * bE) / 250), util = Math.max(uF, uB, uD);
  return { defl: defl * 1000, util, gov: util === uB ? 'buckling' : util === uD ? 'deflection' : 'flexure', B, s };
}

// fine = render-resolution grid (writes mesh into buf); the coarse grid is used by the optimizer.
function evaluate(p, fine, buf) {
  const g = fine ? build(p, 96, 32, buf) : build(p, 28, 10, null), L = limbs(p);
  g.vol += ribVol(p); // ribs count as shell mass for self-weight
  const an = analyse(p, g, fine ? 100 : 40), V = g.vol + L.reduce((a, l) => a + limbVol(l), 0) + Math.round(p.n) * 0.29; // + footings
  return { ...an, vol: V, carbon: V * MAT.rho * MAT.EF, area: g.area, slope: g.slope, mass: V * MAT.rho / 1000, glaze: p.sky * p.sky * g.share * g.area, limbs: L };
}
let REF = evaluate(DEF, true, null); // baseline for the percentage deltas (reset by presets / Reset)

/* Multi-objective cost: carbon (primary) + deflection (secondary) + penalties for utilization > 0.85 and slope > 40 deg. */
const cost = (p, R) => { const m = evaluate(p, false);
  return m.carbon / R.carbon + 0.15 * m.defl / R.defl + 10 * Math.max(0, m.util - 0.85) + 0.05 * Math.max(0, m.slope - SLOPE_MAX); };

// Seeded (1+lambda) evolution strategy over the structural parameters only; returns the trail of improving designs.
function optimise(p0) {
  let seed = 7; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const R = evaluate(p0, false); let best = { ...p0 }, fb = cost(best, R); const trail = [{ ...best, f: fb }], N = 350;
  for (let it = 0; it < N; it++) {
    const sg = 0.05 + 0.25 * (1 - it / N), c = { ...best };
    for (const [k, , , mn, mx, st, , , , op] of SL) {
      if (!op) continue;
      if (k === 'n') { if (rnd() < 0.12) c.n = clamp(c.n + (rnd() < 0.5 ? -1 : 1), mn, mx); continue; }
      c[k] = clamp(Math.round((c[k] + gs() * sg * (mx - mn)) / st) * st, mn, mx);
    }
    const f = cost(c, R); if (f < fb) { fb = f; best = c; trail.push({ ...c, f }); }
  }
  return { trail, evals: N };
}

/* ================= 2. SCENE + UI ================= */
const $ = id => document.getElementById(id);
let P = { ...DEF }, dirty = true, anim = false, elev = false;

const view = $('view'), renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff); scene.fog = new THREE.Fog(0xffffff, 50, 110);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 220);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 8; controls.maxDistance = 70; controls.autoRotateSpeed = 0.8;
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0xf6e8d6, 0.7));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3); sun.position.set(12, 20, 9); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 3; Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, far: 70 }); sun.shadow.bias = -4e-4;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), new THREE.ShadowMaterial({ color: 0x0d2a5a, opacity: 0.2 })); // white page, tinted soft shadow
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(70, 70, 0xdfe3ea, 0xeceff4); grid.position.y = 0.01; scene.add(grid);
[[0xe5484d, [-35, 0, 0, 35, 0, 0]], [0x2fbf71, [0, 0, 35, 0, 0, -35]]].forEach(([c, a]) => { // Rhino world axes (Y into the screen = -z)
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(a.map((v, i) => i % 3 === 1 ? 0.02 : v), 3));
  scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c })));
});

// Skylights: hexagonal oculi cut by the fragment shader (no mesh surgery). The same pattern clips the shadow map (dappled
// light on the ground) and drives a separate glazing layer with dark mullion rings.
const SKY = { uL: { value: 16 }, uSw: { value: 0 }, uFr: { value: 0 }, uBand: { value: SKY_B }, uPitch: { value: 2.4 } };
const HEX = `varying vec3 vP; uniform float uL,uSw,uFr,uBand,uPitch;
float hexD(){ float xi=2.0*vP.x/uL; float zr=vP.z-uSw*xi*xi; vec2 q=vec2(vP.x,zr)/uPitch; vec2 r=vec2(1.0,1.7320508),h=r*0.5;
  vec2 a=mod(q,r)-h,b=mod(q-h,r)-h; vec2 g=abs(dot(a,a)<dot(b,b)?a:b); return abs(zr)<uBand ? max(dot(g,vec2(0.5,0.8660254)),g.x) : 9.0; }`;
function patch(m, kind) {
  m.customProgramCacheKey = () => 'sky-' + kind;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, SKY);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position;');
    const test = kind === 'glass' ? 'if (hexD() >= uFr*0.5) discard;' : 'if (hexD() < uFr*0.5) discard;';
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + HEX).replace('#include <clipping_planes_fragment>', test + '\n#include <clipping_planes_fragment>');
    if (kind === 'glass') sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nfloat fr=step(uFr*0.5-0.05,hexD()); diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.04,0.1,0.28),fr); diffuseColor.a=mix(diffuseColor.a,1.0,fr);');
  };
}

// Fine micro-texture on the shell
const cv = document.createElement('canvas'); cv.width = cv.height = 256;
const cx = cv.getContext('2d'), im = cx.createImageData(256, 256);
for (let i = 0; i < im.data.length; i += 4) { const v = 228 + Math.random() * 27; im.data.set([v, v, v, 255], i); }
cx.putImageData(im, 0, 0);
const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
const mat = new THREE.MeshStandardMaterial({ color: 0xf4d2a0, map: tex, bumpMap: tex, bumpScale: 0.3, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
patch(mat, 'cut');
const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); patch(depthMat, 'cut');
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1ec8e0, transparent: true, opacity: 0.5, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, depthWrite: false }); patch(glassMat, 'glass');

// Shell mesh: fixed topology (top grid, bottom grid, perimeter ring); only positions change.
const NU = 96, NV = 32, G1 = NU + 1, Gn = G1 * (NV + 1), perim = [];
for (let i = 0; i < NU; i++) perim.push(i);
for (let j = 0; j < NV; j++) perim.push(j * G1 + NU);
for (let i = NU; i > 0; i--) perim.push(NV * G1 + i);
for (let j = NV; j > 0; j--) perim.push(j * G1);
const NP = perim.length, NVX = 2 * Gn + 2 * NP, geo = new THREE.BufferGeometry(), idx = [], topIdx = [], uv = new Float32Array(NVX * 2);
for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { const k = j * G1 + i; uv.set([i / NU * 8, j / NV * 3], 2 * k); uv.set([i / NU * 8, j / NV * 3], 2 * (Gn + k)); }
for (let r = 0; r < NP; r++) { uv.set([r / NP * 24, 0], 2 * (2 * Gn + r)); uv.set([r / NP * 24, 0.3], 2 * (2 * Gn + NP + r)); }
for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
  const a = j * G1 + i, b = a + 1, c = b + G1, d = a + G1;
  topIdx.push(a, c, b, a, d, c); idx.push(a, c, b, a, d, c, Gn + a, Gn + b, Gn + c, Gn + a, Gn + c, Gn + d);
}
for (let r = 0; r < NP; r++) { const r2 = (r + 1) % NP, t0 = 2 * Gn + r, t1 = 2 * Gn + r2, b0 = 2 * Gn + NP + r, b1 = 2 * Gn + NP + r2; idx.push(t0, b0, b1, t0, b1, t1); }
const posAttr = new THREE.BufferAttribute(new Float32Array(NVX * 3), 3).setUsage(THREE.DynamicDrawUsage);
const colAttr = new THREE.BufferAttribute(new Float32Array(NVX * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr); geo.setAttribute('color', colAttr); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx);
const shell = new THREE.Mesh(geo, mat); shell.customDepthMaterial = depthMat; shell.castShadow = shell.receiveShadow = true; shell.frustumCulled = false; scene.add(shell);
const glassGeo = new THREE.BufferGeometry(); glassGeo.setAttribute('position', posAttr); glassGeo.setAttribute('uv', geo.attributes.uv); glassGeo.setIndex(topIdx);
const glass = new THREE.Mesh(glassGeo, glassMat); glass.frustumCulled = false; glass.renderOrder = 3; scene.add(glass);
const buf = { pos: posAttr.array, perim };

// Rhino-style display curves share the shell vertex buffer: surface isocurves + outline loops
const isoIdx = [], olIdx = [];
for (let j = 0; j <= NV; j += 4) for (let i = 0; i < NU; i++) isoIdx.push(j * G1 + i, j * G1 + i + 1);
for (let i = 0; i <= NU; i += 8) for (let j = 0; j < NV; j++) isoIdx.push(j * G1 + i, (j + 1) * G1 + i);
for (let r = 0; r < NP; r++) { const r2 = (r + 1) % NP; olIdx.push(2 * Gn + r, 2 * Gn + r2, 2 * Gn + NP + r, 2 * Gn + NP + r2); }
const lineGeo = ix => { const g = new THREE.BufferGeometry(); g.setAttribute('position', posAttr); g.setIndex(ix); return g; };
const iso = new THREE.LineSegments(lineGeo(isoIdx), new THREE.LineBasicMaterial({ color: 0x0d2a5a, transparent: true, opacity: 0.22 }));
const outline = new THREE.LineSegments(lineGeo(olIdx), new THREE.LineBasicMaterial({ color: 0x0d2240 }));
iso.frustumCulled = outline.frustumCulled = false; scene.add(iso, outline);

// Underside ribs: tapered plates (deepest on the ridge, zero at the edge beams) = the linear timber soffit of KLIA
const ribMat = new THREE.MeshStandardMaterial({ color: 0xc4733a, roughness: 0.7, side: THREE.DoubleSide });
const RV = 6 * (RK + 1), ribPos = new THREE.BufferAttribute(new Float32Array(MAXR * RV * 3), 3).setUsage(THREE.DynamicDrawUsage);
const ribGeo = new THREE.BufferGeometry(), ribIdx = [];
for (let r = 0; r < MAXR; r++) for (let k = 0; k < RK; k++) { const a = r * RV + 6 * k, b = a + 6;
  ribIdx.push(a, a + 1, b, a + 1, b + 1, b, a + 2, b + 2, a + 3, a + 3, b + 2, b + 3, a + 4, a + 5, b + 4, a + 5, b + 5, b + 4); }
ribGeo.setAttribute('position', ribPos); ribGeo.setIndex(ribIdx);
const ribMesh = new THREE.Mesh(ribGeo, ribMat); ribMesh.castShadow = true; ribMesh.frustumCulled = false; scene.add(ribMesh);
function fillRibs(p) {
  const n = ribCount(p), o = ribPos.array, h = RIB_T / 2; let w = 0;
  for (let r = 0; r < n; r++) { const xi = -1 + (r + 0.5) * 2 / n;
    for (let k = 0; k <= RK; k++) {
      const e = -1 + 2 * k / RK, Q = pos(p, xi, e), N = nrm(p, xi, e), t = thick(p, e), tp = t / 2 - 0.02, bt = t / 2 + RIB_D * (1 - e * e);
      for (const [d, sd] of [[tp, -1], [bt, -1], [tp, 1], [bt, 1], [bt, -1], [bt, 1]]) { o[w++] = Q[0] - N[0] * d + sd * h; o[w++] = Q[1] - N[1] * d; o[w++] = Q[2] - N[2] * d; }
    } }
  ribGeo.setDrawRange(0, n * RK * 18); ribPos.needsUpdate = true; ribGeo.computeVertexNormals();
}

// Footings, node joints, conical timber-clad trunks and branches (pooled)
const woodMat = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.6 }), footMat = new THREE.MeshStandardMaterial({ color: 0xb9bec7, roughness: 0.9 });
const footGeo = new THREE.CylinderGeometry(0.6, 0.7, 0.3, 28), jointGeo = new THREE.SphereGeometry(1, 20, 14), feet = [], joints = [];
for (let i = 0; i < 5; i++) { const f = new THREE.Mesh(footGeo, footMat), j = new THREE.Mesh(jointGeo, ribMat); f.castShadow = f.receiveShadow = j.castShadow = true; scene.add(f, j); feet.push(f); joints.push(j); }
const limbGeo = new THREE.CylinderGeometry(0.5, 1, 1, 24, 1), pool = [];
for (let i = 0; i < 25; i++) { const m = new THREE.Mesh(limbGeo, woodMat); m.castShadow = m.receiveShadow = true; scene.add(m); pool.push(m); }
const UP = new THREE.Vector3(0, 1, 0), va = new THREE.Vector3(), vb = new THREE.Vector3();
function placeLimbs(list) {
  pool.forEach((m, i) => {
    const l = list[i]; m.visible = !!l; if (!l) return;
    va.fromArray(l.a); vb.fromArray(l.b); const d = vb.clone().sub(va), len = d.length();
    m.position.copy(va).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(UP, d.normalize()); m.scale.set(l.r, len, l.r);
  });
  for (let i = 0; i < 5; i++) { const t = list[5 * i]; feet[i].visible = joints[i].visible = !!t; if (!t) continue;
    feet[i].position.set(t.a[0], 0.15, t.a[2]); joints[i].position.fromArray(t.b); joints[i].scale.setScalar(0.2); }
}

// Technical dimensions (Rhino-style: dimension line, end ticks, label)
const dimGroup = new THREE.Group(); scene.add(dimGroup);
function mkDim() {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false })); sp.scale.set(3.2, 0.8, 1); sp.renderOrder = 9;
  const ln = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1a56ff })); ln.frustumCulled = false; dimGroup.add(ln, sp);
  return { g, c, t, sp, txt: '' };
}
const dimA = mkDim(), dimB = mkDim();
function setDim(d, a, b, tk, txt) {
  d.g.attributes.position.set([...a, ...b, a[0] - tk[0], a[1], a[2] - tk[2], a[0] + tk[0], a[1], a[2] + tk[2], b[0] - tk[0], b[1], b[2] - tk[2], b[0] + tk[0], b[1], b[2] + tk[2]]);
  d.g.attributes.position.needsUpdate = true; d.sp.position.set((a[0] + b[0]) / 2, 0.45, (a[2] + b[2]) / 2);
  if (d.txt !== txt) { d.txt = txt; const x = d.c.getContext('2d'); x.clearRect(0, 0, 256, 64); x.font = '600 32px "IBM Plex Sans",sans-serif'; x.textAlign = 'center';
    x.lineWidth = 7; x.strokeStyle = '#fff'; x.strokeText(txt, 128, 44); x.fillStyle = '#1a56ff'; x.fillText(txt, 128, 44); d.t.needsUpdate = true; }
}
function updateDims(p) {
  let z0 = 1e9, z1 = -1e9; for (let i = 0; i <= 20; i++) { const xi = -1 + i / 10; z0 = Math.min(z0, zc(p, xi) - halfW(p, xi)); z1 = Math.max(z1, zc(p, xi) + halfW(p, xi)); }
  setDim(dimA, [-p.L / 2, 0.02, z1 + 1.6], [p.L / 2, 0.02, z1 + 1.6], [0, 0, 0.3], p.L.toFixed(2) + ' m');
  setDim(dimB, [-p.L / 2 - 1.6, 0.02, zc(p, 0) - halfW(p, 0)], [-p.L / 2 - 1.6, 0.02, zc(p, 0) + halfW(p, 0)], [0.3, 0, 0], p.B.toFixed(2) + ' m');
}

// Elevation colouring (Ladybug-style ramp): vivid height map on the shell
const RAMP = [[0.1, 0.24, 0.95], [0.05, 0.75, 0.92], [0.25, 0.82, 0.45], [1, 0.82, 0.2], [1, 0.33, 0.16]];
function colorize() {
  const o = posAttr.array, c = colAttr.array, n = o.length / 3; let lo = 1e9, hi = -1e9;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, o[3 * i + 1]); hi = Math.max(hi, o[3 * i + 1]); }
  for (let i = 0; i < n; i++) { const x = clamp((o[3 * i + 1] - lo) / (hi - lo || 1), 0, 1) * 4, k = Math.min(3, Math.floor(x)), f = x - k, a = RAMP[k], b = RAMP[k + 1];
    for (let j = 0; j < 3; j++) c[3 * i + j] = a[j] + (b[j] - a[j]) * f; }
  colAttr.needsUpdate = true;
}

// Sliders (grouped)
const outs = {}, ins = {}; let lastGroup = '';
SL.forEach(([k, lab, u, mn, mx, st, sc, dp, grp, op]) => {
  if (grp !== lastGroup) { lastGroup = grp; const h = document.createElement('h3'); h.textContent = grp === 'Form' ? 'Form · architectural intent' : grp === 'Structure' ? 'Structure · optimized' : 'Details'; $('sliders').appendChild(h); }
  const d = document.createElement('div'); d.className = 'sl';
  d.innerHTML = `<label for="s-${k}">${lab}<output id="o-${k}"></output></label><input id="s-${k}" type="range" min="${mn}" max="${mx}" step="${st}">`;
  $('sliders').appendChild(d); ins[k] = d.querySelector('input'); outs[k] = d.querySelector('output');
  ins[k].oninput = () => { if (anim) return; P[k] = +ins[k].value; sync(); queue(); };
});
function sync() { SL.forEach(([k, , u, mn, mx, , sc, dp]) => { ins[k].value = P[k]; outs[k].textContent = (P[k] * sc).toFixed(dp) + (u ? ' ' + u : '');
  ins[k].style.setProperty('--v', ((P[k] - mn) / (mx - mn) * 100) + '%'); }); }

// KPIs
const pct = (v, r) => { const x = (v / r - 1) * 100; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + '%'; };
function show(m) {
  const set = (id, val, v, r) => { $('k-' + id).textContent = val; const d = $('d-' + id), x = v / r - 1;
    d.textContent = pct(v, r) + ' vs baseline'; d.className = Math.abs(x) < 5e-4 ? '' : x < 0 ? 'ok' : 'wr'; };
  set('vol', m.vol.toFixed(1), m.vol, REF.vol); set('co2', Math.round(m.carbon).toLocaleString('en-US'), m.carbon, REF.carbon);
  set('def', m.defl.toFixed(1), m.defl, REF.defl);
  $('k-util').textContent = Math.round(m.util * 100) + '%';
  $('d-util').textContent = 'governed by ' + m.gov; $('d-util').className = m.util < 0.7 ? 'ok' : m.util < 1 ? 'wr' : 'bd';
  $('dims').textContent = `${P.L.toFixed(1)} × ${P.B.toFixed(1)} m · ${Math.round(P.n)} trees · ${ribCount(P)} ribs · ${m.area.toFixed(0)} m² · glazing ${m.glaze.toFixed(0)} m² · ${m.mass.toFixed(1)} t · max slope ${m.slope.toFixed(0)}°${m.slope > SLOPE_MAX ? ' (over 40°)' : ''}`;
}
function refresh() {
  SKY.uL.value = P.L; SKY.uSw.value = P.sweep; SKY.uFr.value = P.sky;
  const m = evaluate(P, true, buf); posAttr.needsUpdate = true; geo.computeVertexNormals(); if (!glassGeo.attributes.normal) glassGeo.setAttribute('normal', geo.attributes.normal);
  if (elev) colorize();
  fillRibs(P); updateDims(P); placeLimbs(m.limbs); show(m); dirty = true; return m;
}
let pend = false; const queue = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; refresh(); }); } };

// Tween (presets, reset) and optimizer animation
const ease = u => u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
function tween(target, ms, done) {
  if (anim) return; anim = true; const a = { ...P }, t0 = performance.now();
  const step = now => { const u = clamp((now - t0) / ms, 0, 1), e = ease(u);
    for (const k of KEYS) P[k] = k === 'n' ? (u < 0.5 ? a.n : target.n) : a[k] + (target[k] - a[k]) * e;
    sync(); refresh(); if (u < 1) return requestAnimationFrame(step); anim = false; done && done(); };
  requestAnimationFrame(step);
}
const run = $('run'), say = t => { $('status').textContent = t; };
run.onclick = () => {
  if (anim) return;
  const start = evaluate(P, false), { trail, evals } = optimise({ ...P });
  if (trail.length < 2) { say('Already at a local optimum for this form.'); return; }
  const kf = trail.length > 40 ? Array.from({ length: 40 }, (_, i) => trail[Math.round(i * (trail.length - 1) / 39)]) : trail, fs = kf.map(k => k.f);
  anim = true; run.disabled = true; say('Optimizing structure…');
  const t0 = performance.now(), D = 3200;
  const step = now => {
    const u = clamp((now - t0) / D, 0, 1), f = ease(u) * (kf.length - 1), i = Math.min(kf.length - 2, Math.floor(f)), r = f - i;
    for (const k of KEYS) P[k] = k === 'n' ? (r < 0.5 ? kf[i] : kf[i + 1]).n : kf[i][k] + (kf[i + 1][k] - kf[i][k]) * r;
    sync(); const m = refresh(); plot(fs, Math.min(fs.length, i + 2));
    if (u < 1) return requestAnimationFrame(step);
    anim = false; run.disabled = false;
    say(`Carbon ${pct(m.carbon, start.carbon)}, deflection ${pct(m.defl, start.defl)} · ${evals} evaluations`);
  };
  requestAnimationFrame(step);
};
const setBase = () => { REF = evaluate(P, true, null); refresh(); };
const load = (preset, ms = 1100) => { const target = { ...DEF, ...preset }; tween(target, ms, () => { setBase(); plot(null); say(''); }); };
$('reset').onclick = () => load({}, 700);
Object.keys(PRESETS).forEach(name => { const b = document.createElement('button'); b.textContent = name; b.onclick = () => load(PRESETS[name]); $('presets').appendChild(b); });

// Display modes (Rhino-style), layers, export, solver history
const MODES = {
  rendered: { c: 0xf4d2a0, r: 0xc4733a, vc: false, w: false, l: 0.22 },
  elevation: { c: 0xffffff, r: 0xd9a066, vc: true, w: false, l: 0.3 },
  technical: { c: 0xffffff, r: 0xe3e8f0, vc: false, w: false, l: 0.5 },
  wire: { c: 0xf4d2a0, r: 0xc4733a, vc: false, w: true, l: 0.22 }
};
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { const m = MODES[b.dataset.mode];
  mat.color.setHex(m.c); ribMat.color.setHex(m.r); mat.wireframe = m.w; iso.material.opacity = m.l; mat.vertexColors = elev = m.vc; mat.needsUpdate = true; if (elev) colorize();
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', x === b)); dirty = true; });
document.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => { const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on); ({ ribs: ribMesh, dims: dimGroup, glass })[b.dataset.layer].visible = on; dirty = true; });
$('spin').onclick = e => { controls.autoRotate = !controls.autoRotate; e.currentTarget.setAttribute('aria-pressed', controls.autoRotate); };
$('png').onclick = () => { renderer.render(scene, camera); const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = 'aviation-canopy.png'; a.click(); };
function plot(v, upto) { // Galapagos-style fitness history
  const c = $('plot'), g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  g.strokeStyle = '#dfe3ea'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, H * i / 4); g.lineTo(W, H * i / 4); g.stroke(); }
  if (!v || v.length < 2) { g.fillStyle = '#7a8190'; g.font = '22px "IBM Plex Sans",sans-serif'; g.fillText('No solver history yet', 14, H / 2 + 8); return; }
  const mx = Math.max(...v), mn = Math.min(...v), X = i => 12 + i * (W - 24) / (v.length - 1), Y = x => 12 + (mx - x) / (mx - mn || 1) * (H - 24), w = v.slice(0, upto);
  g.strokeStyle = '#1a56ff'; g.lineWidth = 2.5; g.beginPath(); w.forEach((x, i) => i ? g.lineTo(X(i), Y(x)) : g.moveTo(X(i), Y(x))); g.stroke();
  g.fillStyle = '#ff5a36'; w.forEach((x, i) => { g.beginPath(); g.arc(X(i), Y(x), 4, 0, 7); g.fill(); });
}

// Camera, layout, render loop
function fit() { const a = camera.aspect, d = 29 * Math.max(1, 1.15 / a); camera.position.set(0.62 * d, 0.38 * d, 0.7 * d); controls.target.set(0, 2.3, 0); dirty = true; }
$('fit').onclick = fit;
new ResizeObserver(() => { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; }).observe(view);
const panel = $('panel'), fold = $('fold');
fold.onclick = () => { panel.classList.toggle('fold'); fold.setAttribute('aria-expanded', !panel.classList.contains('fold')); };
if (matchMedia('(max-width:820px)').matches) { panel.classList.add('fold'); fold.setAttribute('aria-expanded', 'false'); }

sync(); refresh(); plot(null); camera.aspect = 1.6; fit();
(function loop() { requestAnimationFrame(loop); if (controls.update() || dirty) { renderer.render(scene, camera); dirty = false; } })();
