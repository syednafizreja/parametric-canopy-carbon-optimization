/* Parametric Carbon Optimization – Concrete Canopy
   Simplified research demonstration: geometry -> section properties -> structural response -> volume -> embodied carbon.
   Part 1 (model) is plain JavaScript; part 2 (scene + UI) uses Three.js. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ================= 1. MODEL ================= */

// Indicative material data. EF is kgCO2e per kg of a cement-rich HPC/UHPFRC thin-shell mix (fibres included,
// cradle to gate). Ordinary C35/45 would be about 0.13-0.16. fc/ft: design compression / effective tension (Pa).
const MAT = { rho: 2450, E: 45e9, EF: 0.34, fc: 55e6, ft: 8e6 };
const G = 9.81, QK = 750;      // gravity; imposed load (Pa)
const PHI = 1.5;               // creep coefficient -> E_eff = E / (1 + PHI)
const H0 = 2.8;                // clear height under the edge beams (m)
const SLOPE_MAX = 40;          // deg: limit for single-sided formwork / sprayed casting
const EEFF = MAT.E / (1 + PHI);

const RIB_T = 0.08, RIB_D = 0.3, MAXR = 18, RK = 24; // underside ribs: thickness, max depth (tapers to 0 at the edge beams)
const DEF = { L: 16, rise: 0.9, t: 0.16, n: 4, rib: 2.0, camber: 0.3, shape: 2.0 };
// key, label, unit, min, max, step, display scale, decimals
const SL = [
  ['L', 'Span', 'm', 12, 18, 0.5, 1, 1],
  ['rise', 'Transverse rise', 'm', 0.4, 1.8, 0.05, 1, 2],
  ['t', 'Shell thickness', 'mm', 0.05, 0.25, 0.005, 1000, 0],
  ['n', 'Tree supports', '', 2, 5, 1, 1, 0],
  ['rib', 'Rib spacing', 'm', 1, 5, 0.1, 1, 1],
  ['camber', 'Longitudinal camber', 'm', 0, 1, 0.05, 1, 2],
  ['shape', 'Shape factor (crown exponent)', '', 1.8, 3, 0.05, 1, 2]
];
const KEYS = SL.map(s => s[0]);

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// Mid-surface. xi, e in [-1,1] along / across. Ridge on the tree axis, wings fall to the edge beams (e = +-1).
const halfW = (p, xi) => 0.225 * p.L * (0.62 + 0.38 * Math.cos(Math.PI * xi / 2)); // leaf-shaped plan, B = 0.45 L
const rise = (p, xi) => p.rise * (1 - 0.3 * xi * xi) + p.camber * (1 - xi * xi);     // local ridge-to-edge depth
const crown = (p, e) => 1 - Math.pow(Math.abs(e), p.shape);
const yAt = (p, xi, e) => H0 + rise(p, xi) * crown(p, e);
const pos = (p, xi, e) => [xi * p.L / 2, yAt(p, xi, e), e * halfW(p, xi)];
const thick = (p, e) => p.t * (1 + 2.5 * Math.pow(Math.abs(e), 10)); // thickening toward e = +-1 forms the edge beams

const ribCount = p => clamp(Math.floor(p.L / p.rib), 1, MAXR);
const nrm = (p, xi, e) => { // unit surface normal (pointing up) from central differences
  const d = 1e-3, a = pos(p, Math.min(1, xi + d), e), b = pos(p, Math.max(-1, xi - d), e), c = pos(p, xi, Math.min(1, e + d)), f = pos(p, xi, Math.max(-1, e - d));
  const U = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], V = [c[0] - f[0], c[1] - f[1], c[2] - f[2]];
  const n = [V[1] * U[2] - V[2] * U[1], V[2] * U[0] - V[0] * U[2], V[0] * U[1] - V[1] * U[0]], l = Math.hypot(n[0], n[1], n[2]);
  return [n[0] / l, n[1] / l, n[2] / l];
};
const arc = (p, xi) => { let s = 0, b = halfW(p, xi), D = rise(p, xi), pz = -b, py = H0; // cross-section arc length
  for (let k = 1; k <= 16; k++) { const e = -1 + k / 8, z = e * b, y = H0 + D * crown(p, e); s += Math.hypot(z - pz, y - py); pz = z; py = y; }
  return s; };
const ribVol = p => { const n = ribCount(p); let v = 0; // tapered rib area = 2/3 of depth x arc
  for (let r = 0; r < n; r++) v += RIB_T * RIB_D * (2 / 3) * arc(p, -1 + (r + 0.5) * 2 / n);
  return v; };

const tri = (P, a, b, c) => { // triangle area from flat position array
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

// Grid of the mid-surface: area, volume (integral of t dA), max slope. With buf, also writes the thick-shell mesh.
function build(p, NU, NV, buf) {
  const G1 = NU + 1, Gn = G1 * (NV + 1);
  const P = new Float32Array(Gn * 3), T = new Float32Array(Gn), d = 1e-3;
  let slope = 0;
  const N = buf ? new Float32Array(Gn * 3) : null;
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const k = j * G1 + i, xi = -1 + 2 * i / NU, e = -1 + 2 * j / NV;
    const n = nrm(p, xi, e);
    slope = Math.max(slope, Math.acos(n[1]) * 180 / Math.PI);
    P.set(pos(p, xi, e), 3 * k); T[k] = thick(p, e);
    if (N) N.set(n, 3 * k);
  }
  let area = 0, vol = 0;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * G1 + i, b = a + 1, c = b + G1, dd = a + G1;
    const A = tri(P, a, b, dd) + tri(P, c, dd, b);
    area += A; vol += A * (T[a] + T[b] + T[c] + T[dd]) / 4;
  }
  if (buf) { // offset +-t/2 along the normal; the perimeter ring closes the edges and ends
    const out = buf.pos, NP = buf.perim.length;
    for (let k = 0; k < Gn; k++) for (let c = 0; c < 3; c++) {
      const o = N[3 * k + c] * T[k] / 2;
      out[3 * k + c] = P[3 * k + c] + o; out[3 * (Gn + k) + c] = P[3 * k + c] - o;
    }
    buf.perim.forEach((k, r) => { for (let c = 0; c < 3; c++) {
      out[3 * (2 * Gn + r) + c] = out[3 * k + c]; out[3 * (2 * Gn + NP + r) + c] = out[3 * (Gn + k) + c]; } });
  }
  return { area, vol, slope };
}

// Tree supports: trunk + four branches reaching the shell underside. Same data drives volume and meshes.
function limbs(p) {
  const n = Math.round(p.n), s = p.L / n, out = [];
  for (let i = 0; i < n; i++) {
    const x = -p.L / 2 + s * (i + 0.5), jy = yAt(p, 2 * x / p.L, 0) - p.t / 2 - 1.25;
    out.push({ a: [x, 0, 0], b: [x, jy, 0], r: 0.2 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const bx = x + sx * 0.95, xi = 2 * bx / p.L, bz = sz * 1.15, e = bz / halfW(p, xi);
      out.push({ a: [x, jy, 0], b: [bx, yAt(p, xi, e) - thick(p, e) / 2 + 0.03, bz], r: 0.11 });
    }
  }
  return out;
}
const limbVol = l => Math.PI * Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]) * l.r * l.r * 0.653; // taper 1 -> 0.6

// Cross-section of the shell at station xi, integrated over 40 strips: area, I about the centroid, extreme fibres.
// Edge-beam thickening acts as the tension chord, rise acts as structural depth.
function section(p, xi) {
  const K = 40, b = halfW(p, xi), D = rise(p, xi), seg = [];
  let A = 0, S = 0, I0 = 0, pz, py, pt;
  for (let k = 0; k <= K; k++) {
    const e = -1 + 2 * k / K, y = H0 + D * crown(p, e), z = e * b, t = thick(p, e);
    if (k) { const tm = (t + pt) / 2, ds = Math.hypot(z - pz, y - py), a = tm * ds;
      A += a; S += a * (y + py) / 2; I0 += tm ** 3 * ds / 12; seg.push([a, (y + py) / 2]); }
    pz = z; py = y; pt = t;
  }
  const yb = S / A; let I = I0;
  for (const [a, ym] of seg) I += a * (ym - yb) ** 2;
  return { I, top: H0 + D + p.t / 2 - yb, bot: yb - H0 + thick(p, 1) / 2, w: 2 * b };
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
   1 Global: shell = girder on n tree supports with half-bay cantilevers. Support moments from the three-moment
     equation, deflection by double integration of M/(E_eff I), stresses from the section at each station.
   2 Local: wing deflection as a shallow-shell cantilever: flat-plate stiffness x (1 + 0.06 (D/t)^2), a calibrated
     surrogate for membrane action. Buckling: knocked-down (0.25) cylindrical-arch critical pressure vs ULS load.
   Utilization = max(flexure, buckling, deflection / (span/250)). */
function analyse(p, g, NS = 100) {
  const n = Math.round(p.n), s = p.L / n, c = s / 2, dx = p.L / NS;
  const xs = Array.from({ length: n }, (_, i) => -p.L / 2 + c + i * s);
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
  const b0 = halfW(p, 0), D0 = rise(p, 0), R = (b0 * b0 + D0 * D0) / (2 * D0), tav = g.vol / g.area;
  // Ribs: smeared T-section (shell + tapered ribs) per metre of span governs wing stiffness and panel buckling.
  const dm = 0.6 * RIB_D, Iw = p.t ** 3 / 12 + 0.5 * RIB_T * (dm ** 3 / 12 + dm * (dm / 2 + p.t / 2) ** 2) / (p.L / ribCount(p)); // 0.5: shear-lag / cracking efficiency
  const dLoc = (tav * MAT.rho * G + QK) * b0 ** 4 / (8 * EEFF * Iw * (1 + 0.06 * (D0 / p.t) ** 2));
  const te = Math.min(Math.cbrt(12 * Iw), 2.2 * p.t), pcr = 0.25 * EEFF * te ** 3 / (4 * 0.96 * R ** 3);
  const uB = (1.35 * tav * MAT.rho * G + 1.5 * QK) / pcr;
  const defl = dBeam + dLoc, uD = defl / (Math.max(s, 2 * b0) / 250);
  const util = Math.max(uF, uB, uD);
  return { defl: defl * 1000, util, gov: util === uB ? 'buckling' : util === uD ? 'deflection' : 'flexure', B, s };
}

// fine = render-resolution grid (writes mesh into buf); coarse grid is used by the optimizer.
function evaluate(p, fine, buf) {
  const g = fine ? build(p, 96, 32, buf) : build(p, 28, 10, null), L = limbs(p);
  g.vol += ribVol(p); // ribs count as shell mass for self-weight
  const an = analyse(p, g, fine ? 100 : 40), V = g.vol + L.reduce((a, l) => a + limbVol(l), 0) + Math.round(p.n) * 0.29; // + footings
  return { ...an, vol: V, carbon: V * MAT.rho * MAT.EF, area: g.area, slope: g.slope, mass: V * MAT.rho / 1000, limbs: L };
}
const REF = evaluate(DEF, true, null); // reference design for the percentage deltas

/* Multi-objective cost: carbon (primary) + deflection (secondary) + penalties for utilization > 0.85 and slope > 40 deg. */
const cost = p => { const m = evaluate(p, false);
  return m.carbon / REF.carbon + 0.15 * m.defl / REF.defl + 10 * Math.max(0, m.util - 0.85) + 0.05 * Math.max(0, m.slope - SLOPE_MAX); };

// Seeded (1+lambda) evolution strategy; returns the trail of improving designs for animation.
function optimise(p0) {
  let seed = 7; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let best = { ...p0 }, fb = cost(best); const trail = [{ ...best, f: fb }], N = 350;
  for (let it = 0; it < N; it++) {
    const sg = 0.05 + 0.25 * (1 - it / N), c = { ...best };
    for (const [k, , , mn, mx, st] of SL) {
      if (k === 'L') continue; // span is a brief, not a variable
      if (k === 'n') { if (rnd() < 0.12) c.n = clamp(c.n + (rnd() < 0.5 ? -1 : 1), mn, mx); continue; }
      c[k] = clamp(Math.round((c[k] + gs() * sg * (mx - mn)) / st) * st, mn, mx);
    }
    const f = cost(c); if (f < fb) { fb = f; best = c; trail.push({ ...c, f }); }
  }
  return { trail, evals: N };
}

/* ================= 2. SCENE + UI ================= */
const $ = id => document.getElementById(id);
let P = { ...DEF }, dirty = true, anim = false;

const view = $('view'), renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff); scene.fog = new THREE.Fog(0xffffff, 45, 100);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.85;
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.target.set(0, 2.2, 0); controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 8; controls.maxDistance = 60;

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d4cc, 0.6));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.0); sun.position.set(10, 18, 8); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, far: 60 }); sun.shadow.bias = -4e-4;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({ opacity: 0.16 })); // white page, soft cast shadow
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(60, 60, 0xdededa, 0xe9e9e6); grid.position.y = 0.01; scene.add(grid);
// Rhino world axes: X red, Y green (Y runs into the screen = -z in three.js)
[[0xd9534f, [-30, 0, 0, 30, 0, 0]], [0x5cb85c, [0, 0, 30, 0, 0, -30]]].forEach(([c, a]) => {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(a.map((v, i) => i % 3 === 1 ? 0.02 : v), 3));
  scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c })));
});

// Procedural micro-texture (colour + bump) on a light timber/clay base
const cv = document.createElement('canvas'); cv.width = cv.height = 256;
const cx = cv.getContext('2d'), im = cx.createImageData(256, 256);
for (let i = 0; i < im.data.length; i += 4) { const v = 225 + Math.random() * 30; im.data.set([v, v, v, 255], i); }
cx.putImageData(im, 0, 0);
const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
const mat = new THREE.MeshStandardMaterial({ color: 0xdcc4a6, map: tex, bumpMap: tex, bumpScale: 0.4, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

// Shell mesh: fixed topology (top grid, bottom grid, perimeter ring); only positions change.
const NU = 96, NV = 32, G1 = NU + 1, Gn = G1 * (NV + 1);
const perim = [];
for (let i = 0; i < NU; i++) perim.push(i);
for (let j = 0; j < NV; j++) perim.push(j * G1 + NU);
for (let i = NU; i > 0; i--) perim.push(NV * G1 + i);
for (let j = NV; j > 0; j--) perim.push(j * G1);
const NP = perim.length, geo = new THREE.BufferGeometry(), idx = [], uv = new Float32Array((2 * Gn + 2 * NP) * 2);
for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { const k = j * G1 + i; uv.set([i / NU * 8, j / NV * 3], 2 * k); uv.set([i / NU * 8, j / NV * 3], 2 * (Gn + k)); }
for (let r = 0; r < NP; r++) { uv.set([r / NP * 24, 0], 2 * (2 * Gn + r)); uv.set([r / NP * 24, 0.3], 2 * (2 * Gn + NP + r)); }
for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
  const a = j * G1 + i, b = a + 1, c = b + G1, d = a + G1;
  idx.push(a, c, b, a, d, c, Gn + a, Gn + b, Gn + c, Gn + a, Gn + c, Gn + d);
}
for (let r = 0; r < NP; r++) { const r2 = (r + 1) % NP, t0 = 2 * Gn + r, t1 = 2 * Gn + r2, b0 = 2 * Gn + NP + r, b1 = 2 * Gn + NP + r2; idx.push(t0, b0, b1, t0, b1, t1); }
const posAttr = new THREE.BufferAttribute(new Float32Array((2 * Gn + 2 * NP) * 3), 3).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx);
const shell = new THREE.Mesh(geo, mat); shell.castShadow = shell.receiveShadow = true; shell.frustumCulled = false; scene.add(shell);
const buf = { pos: posAttr.array, perim };

// Rhino-style display curves share the shell vertex buffer: surface isocurves + outline loops
const isoIdx = [], olIdx = [];
for (let j = 0; j <= NV; j += 4) for (let i = 0; i < NU; i++) isoIdx.push(j * G1 + i, j * G1 + i + 1);
for (let i = 0; i <= NU; i += 8) for (let j = 0; j < NV; j++) isoIdx.push(j * G1 + i, (j + 1) * G1 + i);
for (let r = 0; r < NP; r++) { const r2 = (r + 1) % NP; olIdx.push(2 * Gn + r, 2 * Gn + r2, 2 * Gn + NP + r, 2 * Gn + NP + r2); }
const lineGeo = ix => { const g = new THREE.BufferGeometry(); g.setAttribute('position', posAttr); g.setIndex(ix); return g; };
const iso = new THREE.LineSegments(lineGeo(isoIdx), new THREE.LineBasicMaterial({ color: 0x6b5f52, transparent: true, opacity: 0.28 }));
const outline = new THREE.LineSegments(lineGeo(olIdx), new THREE.LineBasicMaterial({ color: 0x24201c }));
iso.frustumCulled = outline.frustumCulled = false; scene.add(iso, outline);

// Underside ribs: tapered plates (deepest on the ridge, zero at the edge beams), rebuilt from the surface frame
const ribMat = new THREE.MeshStandardMaterial({ color: 0xcfb28f, roughness: 0.9, side: THREE.DoubleSide });
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
      const e = -1 + 2 * k / RK, P = pos(p, xi, e), N = nrm(p, xi, e), t = thick(p, e), tp = t / 2 - 0.02, bt = t / 2 + RIB_D * (1 - e * e);
      for (const [d, sd] of [[tp, -1], [bt, -1], [tp, 1], [bt, 1], [bt, -1], [bt, 1]]) { o[w++] = P[0] - N[0] * d + sd * h; o[w++] = P[1] - N[1] * d; o[w++] = P[2] - N[2] * d; }
    } }
  ribGeo.setDrawRange(0, n * RK * 18); ribPos.needsUpdate = true; ribGeo.computeVertexNormals();
}

// Footings and node joints (one per tree)
const footMat = new THREE.MeshStandardMaterial({ color: 0xbdb6ab, roughness: 0.95 }), footGeo = new THREE.CylinderGeometry(0.6, 0.7, 0.3, 28), jointGeo = new THREE.SphereGeometry(1, 20, 14);
const feet = [], joints = [];
for (let i = 0; i < 5; i++) { const f = new THREE.Mesh(footGeo, footMat), j = new THREE.Mesh(jointGeo, ribMat); f.castShadow = f.receiveShadow = j.castShadow = true; scene.add(f, j); feet.push(f); joints.push(j); }

// Technical dimensions (Rhino-style: dimension line, end ticks, label)
const dimGroup = new THREE.Group(); scene.add(dimGroup);
function mkDim() {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false })); sp.scale.set(3.2, 0.8, 1); sp.renderOrder = 9;
  const ln = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1d1d1b })); ln.frustumCulled = false; dimGroup.add(ln, sp);
  return { g, c, t, sp, txt: '' };
}
const dimA = mkDim(), dimB = mkDim();
function setDim(d, a, b, tk, txt) {
  d.g.attributes.position.set([...a, ...b, a[0] - tk[0], a[1], a[2] - tk[2], a[0] + tk[0], a[1], a[2] + tk[2], b[0] - tk[0], b[1], b[2] - tk[2], b[0] + tk[0], b[1], b[2] + tk[2]]);
  d.g.attributes.position.needsUpdate = true; d.sp.position.set((a[0] + b[0]) / 2, 0.45, (a[2] + b[2]) / 2);
  if (d.txt !== txt) { d.txt = txt; const x = d.c.getContext('2d'); x.clearRect(0, 0, 256, 64); x.font = '600 32px "IBM Plex Sans",sans-serif'; x.textAlign = 'center';
    x.lineWidth = 7; x.strokeStyle = '#fff'; x.strokeText(txt, 128, 44); x.fillStyle = '#1d1d1b'; x.fillText(txt, 128, 44); d.t.needsUpdate = true; }
}
function updateDims(p) {
  const b = halfW(p, 0); setDim(dimA, [-p.L / 2, 0.02, b + 1.6], [p.L / 2, 0.02, b + 1.6], [0, 0, 0.3], p.L.toFixed(2) + ' m');
  setDim(dimB, [-p.L / 2 - 1.6, 0.02, -b], [-p.L / 2 - 1.6, 0.02, b], [0.3, 0, 0], (2 * b).toFixed(2) + ' m');
}

// Pooled limb meshes (5 trees x 5 limbs), unit tapered cylinders scaled per frame
const limbGeo = new THREE.CylinderGeometry(0.6, 1, 1, 20, 1), pool = [];
for (let i = 0; i < 25; i++) { const m = new THREE.Mesh(limbGeo, mat); m.castShadow = m.receiveShadow = true; scene.add(m); pool.push(m); }
const UP = new THREE.Vector3(0, 1, 0), va = new THREE.Vector3(), vb = new THREE.Vector3();
function placeLimbs(list) {
  pool.forEach((m, i) => {
    const l = list[i]; m.visible = !!l; if (!l) return;
    va.fromArray(l.a); vb.fromArray(l.b); const d = vb.clone().sub(va), len = d.length();
    m.position.copy(va).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(UP, d.normalize()); m.scale.set(l.r, len, l.r);
  });
  for (let i = 0; i < 5; i++) { const t = list[5 * i]; feet[i].visible = joints[i].visible = !!t; if (!t) continue;
    feet[i].position.set(t.a[0], 0.15, 0); joints[i].position.fromArray(t.b); joints[i].scale.setScalar(0.19); }
}

// Sliders
const outs = {}, ins = {};
SL.forEach(([k, lab, u, mn, mx, st, sc, dp]) => {
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
    d.textContent = pct(v, r) + ' vs reference'; d.className = Math.abs(x) < 5e-4 ? '' : x < 0 ? 'ok' : 'wr'; };
  set('vol', m.vol.toFixed(1), m.vol, REF.vol); set('co2', Math.round(m.carbon).toLocaleString('en-US'), m.carbon, REF.carbon);
  set('def', m.defl.toFixed(1), m.defl, REF.defl);
  $('k-util').textContent = Math.round(m.util * 100) + '%';
  $('d-util').textContent = 'governed by ' + m.gov; $('d-util').className = m.util < 0.7 ? 'ok' : m.util < 1 ? 'wr' : 'bd';
  $('dims').textContent = `${P.L.toFixed(1)} × ${m.B.toFixed(1)} m · ${Math.round(P.n)} trees · ${ribCount(P)} ribs · ${m.area.toFixed(0)} m² · ${m.mass.toFixed(1)} t · max slope ${m.slope.toFixed(0)}°${m.slope > SLOPE_MAX ? ' (over 40°)' : ''}`;
}
function refresh() {
  const m = evaluate(P, true, buf); posAttr.needsUpdate = true; geo.computeVertexNormals(); fillRibs(P); updateDims(P);
  placeLimbs(m.limbs); show(m); dirty = true; return m;
}
let pend = false; const queue = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; refresh(); }); } };

// Run / reset
const run = $('run'), say = t => { $('status').textContent = t; };
run.onclick = () => {
  if (anim) return;
  const start = evaluate(P, false), { trail, evals } = optimise({ ...P });
  if (trail.length < 2) { say('Already at a local optimum for this model.'); return; }
  const kf = trail.length > 40 ? Array.from({ length: 40 }, (_, i) => trail[Math.round(i * (trail.length - 1) / 39)]) : trail;
  anim = true; run.disabled = true; say('Optimizing…'); const fs = kf.map(k => k.f);
  const t0 = performance.now(), D = 3200;
  const step = now => {
    const u = clamp((now - t0) / D, 0, 1), e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
    const f = e * (kf.length - 1), i = Math.min(kf.length - 2, Math.floor(f)), r = f - i;
    for (const k of KEYS) P[k] = k === 'n' ? (r < 0.5 ? kf[i] : kf[i + 1]).n : kf[i][k] + (kf[i + 1][k] - kf[i][k]) * r;
    sync(); const m = refresh(); plot(fs, Math.min(fs.length, i + 2));
    if (u < 1) return requestAnimationFrame(step);
    anim = false; run.disabled = false;
    say(`Carbon ${pct(m.carbon, start.carbon)}, deflection ${pct(m.defl, start.defl)} · ${evals} evaluations`);
  };
  requestAnimationFrame(step);
};
$('reset').onclick = () => { if (anim) return; P = { ...DEF }; sync(); refresh(); say(''); plot(null); };

// Toolbar, responsive layout, render loop
const MODES = { rendered: { c: 0xdcc4a6, r: 0xcfb28f, w: false, l: 0.28 }, technical: { c: 0xf7f6f3, r: 0xe6e4df, w: false, l: 0.55 }, wire: { c: 0xdcc4a6, r: 0xcfb28f, w: true, l: 0.28 } };
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { const m = MODES[b.dataset.mode];
  mat.color.setHex(m.c); ribMat.color.setHex(m.r); mat.wireframe = m.w; iso.material.opacity = m.l;
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', x === b)); dirty = true; });
document.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => { const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on); (b.dataset.layer === 'ribs' ? ribMesh : dimGroup).visible = on; dirty = true; });
$('png').onclick = () => { renderer.render(scene, camera); const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = 'concrete-canopy.png'; a.click(); };
// Solver history, Galapagos-style: fitness of each improving design
function plot(v, upto) {
  const c = $('plot'), g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  g.strokeStyle = '#deded9'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, H * i / 4); g.lineTo(W, H * i / 4); g.stroke(); }
  if (!v || v.length < 2) { g.fillStyle = '#7a7a75'; g.font = '22px "IBM Plex Sans",sans-serif'; g.fillText('No solver history yet', 14, H / 2 + 8); return; }
  const mx = Math.max(...v), mn = Math.min(...v), X = i => 12 + i * (W - 24) / (v.length - 1), Y = x => 12 + (mx - x) / (mx - mn || 1) * (H - 24), w = v.slice(0, upto);
  g.strokeStyle = '#1d1d1b'; g.lineWidth = 2; g.beginPath(); w.forEach((x, i) => i ? g.lineTo(X(i), Y(x)) : g.moveTo(X(i), Y(x))); g.stroke();
  g.fillStyle = '#2f6f9f'; w.forEach((x, i) => { g.beginPath(); g.arc(X(i), Y(x), 4, 0, 7); g.fill(); });
}
function fit() { const a = camera.aspect, d = 25 * Math.max(1, 1.15 / a); camera.position.set(0.62 * d, 0.36 * d, 0.7 * d); controls.target.set(0, 2.2, 0); dirty = true; }
$('fit').onclick = fit;
new ResizeObserver(() => { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; }).observe(view);
const panel = $('panel'), fold = $('fold');
fold.onclick = () => { panel.classList.toggle('fold'); fold.setAttribute('aria-expanded', !panel.classList.contains('fold')); };
if (matchMedia('(max-width:820px)').matches) { panel.classList.add('fold'); fold.setAttribute('aria-expanded', 'false'); }

sync(); refresh(); plot(null); camera.aspect = 1.6; fit();
(function loop() { requestAnimationFrame(loop); if (controls.update() || dirty) { renderer.render(scene, camera); dirty = false; } })();
