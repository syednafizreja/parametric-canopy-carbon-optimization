// ShellLab user interface. The solver lives in fdm.js; this file reads the
// inputs, runs the solver, and draws the 3D view, the plan and the results.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as F from './fdm.js';
import { CONCRETE, carbon } from './carbon.js';

export const VERSION = '0.1.0';
const GAMMA_CONCRETE = 25; // kN/m^3, reinforced concrete unit weight [J]
const MAX_N = 41; // nodes per side

const $ = (id) => document.getElementById(id);
const DEFAULTS = { lx: 20, ly: 20, mesh: 1, preset: 'corners', rise: 4, fb: 1, sax: 0, say: 0, t: 100, layer: 'forces', custom: [] };
const state = { ...DEFAULTS };
const sliders = ['lx', 'ly', 'mesh', 'rise', 'fb', 'sax', 'say', 't'];
let result = null;
let cursor = { i: 0, j: 0 };

// ---------- number formatting (British English, tabular figures) ----------
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const fmtSig = (v) => (Number.isFinite(v) ? v.toExponential(1).replace('e', ' × 10^').replace(/\^\+?(-?)0*(\d+)/, (_, s, n) => `^${s}${n}`) : '–');
const sup = (s) => s.replace(/\^(-?\d+)/, (_, n) => `<sup>${n.replace('-', '−')}</sup>`);

// ---------- grid from inputs ----------
function gridSize() {
  const nx = Math.max(3, Math.min(MAX_N, Math.round(state.lx / state.mesh) + 1));
  const ny = Math.max(3, Math.min(MAX_N, Math.round(state.ly / state.mesh) + 1));
  return { nx, ny };
}
const boundaryFactor = () => 10 ** state.fb;

function supports(nx, ny) {
  if (state.preset !== 'custom') return F.presetSupports(nx, ny, state.preset);
  return state.custom.filter(([i, j]) => i < nx && j < ny).map(([i, j]) => j * nx + i);
}

// ---------- solve ----------
function compute() {
  const { nx, ny } = gridSize();
  const fixed = supports(nx, ny);
  const t = state.t / 1000;
  if (fixed.length === 0) return { error: 'Add at least one support: click a node on the plan.', nx, ny, fixed };
  const net = F.rectNetwork({ lx: state.lx, ly: state.ly, nx, ny, fixed, qBoundaryFactor: boundaryFactor() });
  let xyz;
  try {
    xyz = F.formToRise(net, state.rise, state.sax, state.say);
  } catch (e) {
    return { error: /load path/.test(e.message) ? 'Some nodes have no path to a support. Add supports so every part of the grid is held.' : e.message, nx, ny, fixed, net };
  }
  const area = F.surfaceArea(net, xyz);
  const weight = area * t * GAMMA_CONCRETE; // kN
  const w = weight / net.n; // kN per node; the form does not depend on this scale
  const bars = F.edgeForces(net, xyz).map((b, e) => {
    const [a] = net.edges[e];
    const isX = net.edges[e][1] - a === 1;
    const strip = isX ? state.ly / (ny - 1) : state.lx / (nx - 1);
    const N = b.force * w; // kN, negative = compression
    return { N, L: b.length, stress: Math.abs(N) / (t * strip) / 1000 }; // MPa
  });
  const R = F.supportReactions(net, xyz).map((r) => r.map((v) => v * w));
  const eq = F.equilibriumError(net, xyz, F.planLoads(net, 1, state.sax, state.say));
  let zmax = -Infinity;
  for (let k = 0; k < net.n; k++) zmax = Math.max(zmax, xyz[3 * k + 2]);
  const volume = area * t;
  return {
    nx, ny, fixed, net, xyz, area, weight, w, bars, R, eq, volume, zmax,
    maxN: Math.max(...bars.map((b) => Math.abs(b.N))),
    maxStress: Math.max(...bars.map((b) => b.stress)),
    maxH: Math.max(...R.map((r) => Math.hypot(r[0], r[1]))),
    sumV: R.reduce((s, r) => s + r[2], 0),
    tension: bars.some((b) => b.N > 1e-9),
    co2: carbon(volume),
  };
}

// ---------- 3D view ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.addEventListener('change', () => render());
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-20, 40, 25);
scene.add(sun);
const group = new THREE.Group();
scene.add(group);
let lastPlan = '';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const P = (xyz, k) => new THREE.Vector3(xyz[3 * k], xyz[3 * k + 2], -xyz[3 * k + 1]); // z-up to three's y-up

function disposeGroup() {
  group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  group.clear();
}

function draw3d() {
  disposeGroup();
  const colors = { bg: css('--stage'), low: css('--scene-low'), hi: css('--accent'), surf: css('--scene-surface'), sup: css('--scene-support'), rule: css('--rule-strong') };
  scene.background = new THREE.Color(colors.bg);
  const span = Math.max(state.lx, state.ly);
  const grid = new THREE.GridHelper(span * 1.6, 16, colors.rule, colors.rule);
  grid.material.transparent = true; grid.material.opacity = 0.5;
  group.add(grid);
  const r = result;
  if (!r || r.error) { render(); return; }
  const { net, xyz, bars } = r;

  // Bars, coloured by axial force (light = low, accent = high).
  const pos = new Float32Array(net.edges.length * 6), col = new Float32Array(net.edges.length * 6);
  const cl = new THREE.Color(colors.low), ch = new THREE.Color(colors.hi), c = new THREE.Color();
  net.edges.forEach(([a, b], e) => {
    const pa = P(xyz, a), pb = P(xyz, b);
    pos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], 6 * e);
    c.copy(cl).lerp(ch, Math.abs(bars[e].N) / r.maxN);
    col.set([c.r, c.g, c.b, c.r, c.g, c.b], 6 * e);
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  lg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: state.layer === 'surface', opacity: state.layer === 'surface' ? 0.35 : 1 }));
  group.add(lines);

  // Surface.
  if (state.layer === 'surface') {
    const vs = new Float32Array(net.n * 3);
    for (let k = 0; k < net.n; k++) { const p = P(xyz, k); vs.set([p.x, p.y, p.z], 3 * k); }
    const idx = [];
    for (let j = 0; j < r.ny - 1; j++) for (let i = 0; i < r.nx - 1; i++) {
      const k = j * r.nx + i;
      idx.push(k, k + 1, k + r.nx + 1, k, k + r.nx + 1, k + r.nx);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(vs, 3));
    sg.setIndex(idx);
    sg.computeVertexNormals();
    group.add(new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: colors.surf, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })));
  }

  // Supports and the horizontal thrust each one takes.
  const s = Math.max(0.12, span / 90);
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(2 * s, 2 * s, 2 * s), new THREE.MeshBasicMaterial({ color: colors.sup }), net.fixed.length);
  const m = new THREE.Matrix4();
  net.fixed.forEach((k, i) => { const p = P(xyz, k); m.makeTranslation(p.x, p.y - s, p.z); boxes.setMatrixAt(i, m); });
  group.add(boxes);
  const hmax = r.maxH || 1;
  r.R.forEach((rv, i) => {
    const h = Math.hypot(rv[0], rv[1]);
    if (h / hmax < 0.02) return;
    const dir = new THREE.Vector3(-rv[0], 0, rv[1]).normalize(); // thrust on the support = -R, in three's axes
    const len = 0.11 * span * Math.sqrt(h / hmax) + 0.015 * span; // square root, so small thrusts stay visible
    group.add(new THREE.ArrowHelper(dir, P(xyz, net.fixed[i]), len, ch.getHex(), 0.25 * len, 0.12 * len));
  });

  // Frame the camera when the plan changes, not on every slider move.
  const key = `${state.lx}|${state.ly}`;
  if (key !== lastPlan) {
    lastPlan = key;
    fitCamera();
  }
  render();
}

// Fit the plan and rise in view from a three-quarter angle, for any aspect ratio.
function fitCamera() {
  const radius = 0.5 * Math.hypot(state.lx, state.ly, state.rise);
  const vfov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hfov = Math.atan(Math.tan(vfov) * camera.aspect);
  const dist = (1.12 * radius) / Math.sin(Math.min(vfov, hfov));
  const dir = new THREE.Vector3(0.62, 0.5, 0.78).normalize();
  controls.target.set(0, state.rise * 0.3, 0);
  camera.position.copy(dir.multiplyScalar(dist)).add(controls.target);
  camera.near = dist / 100; camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = view;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (result && !result.error) fitCamera();
  render();
}
function render() { renderer.render(scene, camera); }
new ResizeObserver(resize).observe(view);

// ---------- plan (SVG): supports, cursor and thrust ----------
const plan = $('plan');
const NS = 'http://www.w3.org/2000/svg';
function planGeom() {
  const { nx, ny } = gridSize();
  const W = 300, pad = 22;
  const sc = (W - 2 * pad) / Math.max(state.lx, state.ly);
  const H = state.ly * sc + 2 * pad;
  const X = (x) => pad + (x + state.lx / 2) * sc + (W - 2 * pad - state.lx * sc) / 2;
  const Y = (y) => pad + (state.ly / 2 - y) * sc;
  return { nx, ny, W, H, sc, X, Y };
}
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}
function drawPlan() {
  const g = planGeom();
  plan.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
  plan.replaceChildren();
  const sx = F.linspace(-state.lx / 2, state.lx / 2, g.nx), sy = F.linspace(-state.ly / 2, state.ly / 2, g.ny);
  for (let i = 0; i < g.nx; i++) el('line', { class: 'g', x1: g.X(sx[i]), x2: g.X(sx[i]), y1: g.Y(sy[0]), y2: g.Y(sy[g.ny - 1]) }, plan);
  for (let j = 0; j < g.ny; j++) el('line', { class: 'g', x1: g.X(sx[0]), x2: g.X(sx[g.nx - 1]), y1: g.Y(sy[j]), y2: g.Y(sy[j]) }, plan);
  // Form outline in plan, so free-edge pull-in is visible.
  const r = result;
  if (r && !r.error) {
    const ring = [];
    for (let i = 0; i < g.nx; i++) ring.push(i);
    for (let j = 1; j < g.ny; j++) ring.push(j * g.nx + g.nx - 1);
    for (let i = g.nx - 2; i >= 0; i--) ring.push((g.ny - 1) * g.nx + i);
    for (let j = g.ny - 2; j > 0; j--) ring.push(j * g.nx);
    el('polygon', { class: 'o', points: ring.map((k) => `${g.X(r.xyz[3 * k])},${g.Y(r.xyz[3 * k + 1])}`).join(' ') }, plan);
  }
  const fixed = new Set(r ? r.fixed : supports(g.nx, g.ny));
  const rad = Math.max(1.1, Math.min(2.4, g.sc * state.mesh * 0.18));
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i, cx = g.X(sx[i]), cy = g.Y(sy[j]);
    if (fixed.has(k)) el('rect', { class: 's', x: cx - 3.5, y: cy - 3.5, width: 7, height: 7 }, plan);
    else el('circle', { class: 'n', cx, cy, r: rad }, plan);
  }
  if (r && !r.error) {
    r.R.forEach((rv, i) => {
      const h = Math.hypot(rv[0], rv[1]);
      if (h / r.maxH < 0.02) return;
      const k = r.fixed[i], len = 5 + 19 * Math.sqrt(h / r.maxH);
      const x0 = g.X(sx[k % g.nx]), y0 = g.Y(sy[Math.floor(k / g.nx)]);
      const ux = -rv[0] / h, uy = rv[1] / h; // thrust on the support, SVG y is down
      const x1 = x0 + ux * len, y1 = y0 + uy * len;
      el('path', { class: 'th', d: `M${x0},${y0} L${x1},${y1} M${x1 - 4 * ux + 3 * uy},${y1 - 4 * uy - 3 * ux} L${x1},${y1} L${x1 - 4 * ux - 3 * uy},${y1 - 4 * uy + 3 * ux}` }, plan);
    });
  }
  cursor.i = Math.min(cursor.i, g.nx - 1); cursor.j = Math.min(cursor.j, g.ny - 1);
  el('rect', { class: 'cur', x: g.X(sx[cursor.i]) - 6, y: g.Y(sy[cursor.j]) - 6, width: 12, height: 12, rx: 2 }, plan);
  const isSup = fixed.has(cursor.j * g.nx + cursor.i);
  $('plan-cursor').textContent = `Node ${cursor.i + 1}, ${cursor.j + 1} at x ${fmt(sx[cursor.i])} m, y ${fmt(sy[cursor.j])} m: ${isSup ? 'support' : 'free'}. ${fixed.size} supports in all.`;
}

function toggleSupport(i, j) {
  const g = gridSize();
  if (state.preset !== 'custom') {
    state.custom = F.presetSupports(g.nx, g.ny, state.preset).map((k) => [k % g.nx, Math.floor(k / g.nx)]);
    state.preset = 'custom';
    syncSeg('preset', 'custom');
  }
  const at = state.custom.findIndex(([a, b]) => a === i && b === j);
  if (at >= 0) state.custom.splice(at, 1); else state.custom.push([i, j]);
  update();
}

plan.addEventListener('pointerdown', (ev) => {
  const g = planGeom();
  const pt = plan.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(plan.getScreenCTM().inverse());
  const sx = F.linspace(-state.lx / 2, state.lx / 2, g.nx), sy = F.linspace(-state.ly / 2, state.ly / 2, g.ny);
  let best = null, dmin = Infinity;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const d = Math.hypot(g.X(sx[i]) - p.x, g.Y(sy[j]) - p.y);
    if (d < dmin) { dmin = d; best = { i, j }; }
  }
  if (best && dmin < 14) { cursor = best; toggleSupport(best.i, best.j); }
});
plan.addEventListener('keydown', (ev) => {
  const g = gridSize();
  const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
  if (mv) {
    ev.preventDefault();
    cursor.i = Math.max(0, Math.min(g.nx - 1, cursor.i + mv[0]));
    cursor.j = Math.max(0, Math.min(g.ny - 1, cursor.j + mv[1]));
    drawPlan();
  } else if (ev.key === ' ' || ev.key === 'Enter') {
    ev.preventDefault();
    toggleSupport(cursor.i, cursor.j);
  }
});

// ---------- results ----------
function drawStats() {
  const r = result, box = $('stats');
  const status = $('status');
  if (r.error) {
    box.innerHTML = '';
    status.textContent = r.error; status.className = 'status err';
    $('carbon-note').textContent = '';
    $('view-summary').textContent = r.error;
    $('legend').innerHTML = '';
    $('titleblock').innerHTML = '';
    return;
  }
  status.textContent = ''; status.className = 'status';
  // Each value here is a formatted number or a constant, never user text.
  const groups = [
    ['Geometry', [
      ['Grid', `${r.nx} × ${r.ny} nodes`],
      ['Bars', `${r.net.edges.length}`],
      ['Supports', `${r.fixed.length}`],
      ['Span : rise', `${fmt(Math.min(state.lx, state.ly) / state.rise, 1)} : 1`],
      ['Surface area', `${fmt(r.area, 0)} m²`],
    ]],
    ['Forces', [
      ['Self-weight', `${fmt(r.weight, 0)} kN`],
      ['Max bar force', `${fmt(r.maxN, 1)} kN`, 'hi'],
      ['Max support thrust', `${fmt(r.maxH, 1)} kN`, 'hi'],
      ['Σ vertical reactions', `${fmt(r.sumV, 0)} kN`],
      ['Membrane stress, guide', `${fmt(r.maxStress, 2)} MPa`],
      ['Equilibrium residual', sup(fmtSig(r.eq))],
    ]],
    ['Concrete, C40', [
      ['Volume', `${fmt(r.volume, 1)} m³`],
      ['A1–A3 carbon', `${fmt(r.co2.mid / 1000, 1)} tCO₂e`, 'hi'],
      ['Range, ±25 %', `${fmt(r.co2.lo / 1000, 1)}–${fmt(r.co2.hi / 1000, 1)} t`],
      ['Per m² of plan', `${fmt(r.co2.mid / (state.lx * state.ly), 0)} kg`],
    ]],
  ];
  box.innerHTML = groups.map(([h, rows]) => `<div class="group"><h3>${h}</h3><dl>${rows.map(([k, v, c]) => `<dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd>`).join('')}</dl></div>`).join('');
  $('carbon-note').innerHTML = `${CONCRETE.factor} kgCO₂e/m³, GB/T 51366-2019 via ShellBench v1.0.0. Concrete only; reinforcement is not counted.${r.tension ? ' Some bars are in tension.' : ''}`;
  $('legend').innerHTML = state.layer === 'forces' ? `0 <i></i> ${fmt(r.maxN, 0)} kN` : '';
  const lat = state.sax || state.say ? `${fmt(state.sax, 2)} / ${fmt(state.say, 2)} g` : 'none';
  $('titleblock').innerHTML = [
    ['Plan', `${fmt(state.lx, 0)} × ${fmt(state.ly, 0)} m`],
    ['Rise', `${fmt(state.rise, 1)} m`],
    ['Supports', `${r.fixed.length}`],
    ['Lateral', lat],
    ['Shell', `${fmt(state.t, 0)} mm`],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('view-summary').textContent = `Form ${fmt(state.lx, 0)} by ${fmt(state.ly, 0)} m, rise ${fmt(state.rise, 1)} m, ${r.fixed.length} supports. Largest bar force ${fmt(r.maxN, 1)} kN, largest thrust ${fmt(r.maxH, 1)} kN.`;
}

function syncOutputs() {
  for (const id of sliders) {
    const input = $(id), out = document.querySelector(`output[for="${id}"]`);
    input.value = state[id];
    const v = Number(state[id]);
    out.textContent = id === 'fb' ? `× ${fmt(boundaryFactor(), boundaryFactor() < 10 ? 1 : 0)}`
      : `${fmt(v, ['mesh', 'sax', 'say'].includes(id) ? 2 : id === 'rise' ? 1 : 0)} ${out.dataset.unit || ''}`.trim();
    input.style.setProperty('--fill', `${((v - input.min) / (input.max - input.min)) * 100}%`);
  }
  const g = gridSize();
  const real = Math.max(state.lx / (g.nx - 1), state.ly / (g.ny - 1));
  if (real > state.mesh + 1e-9) document.querySelector('output[for="mesh"]').textContent = `${fmt(real, 2)} m`;
}

function syncSeg(id, v) {
  $(id).querySelectorAll('button').forEach((b) => {
    const on = b.dataset.v === v;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}
function setupSeg(id, onPick) {
  const root = $(id), buttons = [...root.querySelectorAll('button')];
  root.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) onPick(b.dataset.v); });
  root.addEventListener('keydown', (ev) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (!dir) return;
    ev.preventDefault();
    const at = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[(at + dir + buttons.length) % buttons.length];
    onPick(next.dataset.v); next.focus();
  });
}

function writeHash() {
  const p = new URLSearchParams();
  for (const k of [...sliders, 'preset', 'layer']) if (state[k] !== DEFAULTS[k]) p.set(k, state[k]);
  if (state.preset === 'custom') p.set('c', state.custom.map(([i, j]) => `${i}.${j}`).join('_'));
  const h = p.toString();
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of sliders) if (p.has(k)) { const v = Number(p.get(k)); if (Number.isFinite(v)) state[k] = Math.min(Number($(k).max), Math.max(Number($(k).min), v)); }
  const presets = [...$('preset').querySelectorAll('button')].map((b) => b.dataset.v);
  if (presets.includes(p.get('preset'))) state.preset = p.get('preset');
  if (['forces', 'surface'].includes(p.get('layer'))) state.layer = p.get('layer');
  if (p.get('c')) state.custom = p.get('c').split('_').map((s) => s.split('.').map(Number)).filter((a) => a.length === 2 && a.every(Number.isInteger));
}

let queued = false;
function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    syncOutputs();
    result = compute();
    drawStats();
    drawPlan();
    draw3d();
    writeHash();
  });
}

let prevGrid = gridSize();
for (const id of sliders) {
  $(id).addEventListener('input', () => {
    state[id] = Number($(id).value);
    const g = gridSize();
    if (state.preset === 'custom' && (g.nx !== prevGrid.nx || g.ny !== prevGrid.ny)) {
      // Keep custom supports at the same relative place on a new grid.
      state.custom = [...new Map(state.custom.map(([i, j]) => {
        const a = Math.round((i / (prevGrid.nx - 1)) * (g.nx - 1)), b = Math.round((j / (prevGrid.ny - 1)) * (g.ny - 1));
        return [`${a}.${b}`, [a, b]];
      })).values()];
    }
    prevGrid = g;
    update();
  });
}
setupSeg('preset', (v) => {
  if (v === 'custom' && state.preset !== 'custom') {
    const g = gridSize();
    state.custom = F.presetSupports(g.nx, g.ny, state.preset).map((k) => [k % g.nx, Math.floor(k / g.nx)]);
  }
  state.preset = v; syncSeg('preset', v); update();
});
setupSeg('layer', (v) => { state.layer = v; syncSeg('layer', v); update(); });

// ---------- theme ----------
function syncThemeButton() {
  const light = document.documentElement.dataset.theme === 'light';
  $('version').textContent = `v${VERSION}`;
  $('theme').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
}
$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('shelllab-theme', next); } catch (e) { /* private mode */ }
  syncThemeButton();
  draw3d(); drawPlan();
});

// ---------- copy link and downloads ----------
function flash(msg) { const s = $('status'); s.textContent = msg; s.className = 'status'; }
$('copy').addEventListener('click', async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); flash('Link copied.'); }
  catch (e) { flash('Copy the address bar: it holds this design.'); }
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
$('json').addEventListener('click', () => {
  const r = result;
  if (!r || r.error) return flash('Nothing to export yet.');
  const nodes = []; for (let k = 0; k < r.net.n; k++) nodes.push([r6(r.xyz[3 * k]), r6(r.xyz[3 * k + 1]), r6(r.xyz[3 * k + 2])]);
  const out = {
    tool: `ShellLab ${VERSION}`, solver: 'force density method (Schek 1974), checked against ShellForm v0.2.0',
    link: location.href,
    units: { length: 'm', force: 'kN', stress: 'MPa', carbon: 'kgCO2e' },
    inputs: { lx: state.lx, ly: state.ly, nx: r.nx, ny: r.ny, rise: state.rise, boundary_q_factor: r6(boundaryFactor()), sa_x_g: state.sax, sa_y_g: state.say, thickness_m: state.t / 1000, unit_weight_kN_m3: GAMMA_CONCRETE },
    nodes, supports: r.fixed,
    bars: r.net.edges.map(([a, b], e) => ({ a, b, force: r6(r.bars[e].N), length: r6(r.bars[e].L), force_density_unit_weight: r6(r.net.q[e]) })),
    reactions: r.fixed.map((k, i) => ({ node: k, force: r.R[i].map(r6) })),
    results: { surface_area: r6(r.area), self_weight: r6(r.weight), max_bar_force: r6(r.maxN), max_support_thrust: r6(r.maxH), equilibrium_residual: r.eq, concrete_m3: r6(r.volume), a1_a3: { mid: r6(r.co2.mid), low: r6(r.co2.lo), high: r6(r.co2.hi), factor: CONCRETE.factor, source: CONCRETE.source } },
    not_checked: ['reinforcement', 'buckling', 'bending under non-funicular loads', 'supports and foundations'],
  };
  download('shelllab-form.json', JSON.stringify(out, null, 2), 'application/json');
});
$('obj').addEventListener('click', () => {
  const r = result;
  if (!r || r.error) return flash('Nothing to export yet.');
  const lines = [`# ShellLab ${VERSION} form, metres, z up`, `# ${location.href}`];
  for (let k = 0; k < r.net.n; k++) lines.push(`v ${r6(r.xyz[3 * k])} ${r6(r.xyz[3 * k + 1])} ${r6(r.xyz[3 * k + 2])}`);
  for (let j = 0; j < r.ny - 1; j++) for (let i = 0; i < r.nx - 1; i++) {
    const k = j * r.nx + i + 1;
    lines.push(`f ${k} ${k + 1} ${k + r.nx + 1} ${k + r.nx}`);
  }
  download('shelllab-form.obj', `${lines.join('\n')}\n`, 'text/plain');
});
$('reset').addEventListener('click', () => {
  Object.assign(state, structuredClone(DEFAULTS));
  syncSeg('preset', state.preset); syncSeg('layer', state.layer);
  lastPlan = ''; prevGrid = gridSize();
  update();
});

// ---------- start ----------
readHash();
prevGrid = gridSize();
syncSeg('preset', state.preset);
syncSeg('layer', state.layer);
syncThemeButton();
window.addEventListener('hashchange', () => { readHash(); syncSeg('preset', state.preset); syncSeg('layer', state.layer); update(); });
update();
window.shelllab = { state, get result() { return result; }, VERSION };
