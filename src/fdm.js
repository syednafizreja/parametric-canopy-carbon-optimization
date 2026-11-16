// ShellLab solver: force density method (Schek 1974) for a pin-jointed grid.
//
// A port of ShellForm's src/shellform/formfind.py and checks.py, generalised
// from a square n x n plan to an nx x ny rectangle with any set of supports.
// The square cases are checked against ShellForm itself (test/fdm.test.mjs).
//
// Conventions follow ShellForm: z is up, gravity loads are negative, and a
// negative force density q means compression. Node k = j * nx + i.

/** numpy.linspace(a, b, n): start + i * step, with the last value set to b. */
export function linspace(a, b, n) {
  const step = (b - a) / (n - 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b;
  return out;
}

/** Support presets, as node index lists for an nx x ny grid. */
export function presetSupports(nx, ny, name) {
  const idx = (i, j) => j * nx + i;
  const set = new Set();
  const all = (test) => {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (test(i, j)) set.add(idx(i, j));
  };
  switch (name) {
    case 'edges': all((i, j) => i === 0 || j === 0 || i === nx - 1 || j === ny - 1); break;
    case 'corners': [idx(0, 0), idx(nx - 1, 0), idx(0, ny - 1), idx(nx - 1, ny - 1)].forEach((k) => set.add(k)); break;
    case 'two-edges': all((i) => i === 0 || i === nx - 1); break;
    case 'three-edges': all((i, j) => i === 0 || i === nx - 1 || j === 0); break;
    case 'mid-edges': {
      const mi = Math.floor(nx / 2), mj = Math.floor(ny / 2);
      [idx(mi, 0), idx(mi, ny - 1), idx(0, mj), idx(nx - 1, mj)].forEach((k) => set.add(k));
      [idx(0, 0), idx(nx - 1, 0), idx(0, ny - 1), idx(nx - 1, ny - 1)].forEach((k) => set.add(k));
      break;
    }
    default: throw new Error(`unknown support preset: ${name}`);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Build the network on an lx x ly plan with nx x ny nodes.
 * Edge order matches ShellForm: x-direction edges row by row, then y-direction.
 * Boundary edges (along the plan perimeter) get q * qBoundaryFactor.
 */
export function rectNetwork({ lx, ly, nx, ny, fixed, q = -1.0, qBoundaryFactor = 1.0 }) {
  if (nx < 3 || ny < 3) throw new Error('nx and ny must be at least 3');
  const sx = linspace(-lx / 2, lx / 2, nx);
  const sy = linspace(-ly / 2, ly / 2, ny);
  const n = nx * ny;
  const xyz = new Float64Array(3 * n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    xyz[3 * k] = sx[i]; xyz[3 * k + 1] = sy[j]; xyz[3 * k + 2] = 0;
  }
  const edges = [], boundary = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx - 1; i++) {
    edges.push([j * nx + i, j * nx + i + 1]); boundary.push(j === 0 || j === ny - 1);
  }
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx; i++) {
    edges.push([j * nx + i, (j + 1) * nx + i]); boundary.push(i === 0 || i === nx - 1);
  }
  const qv = Float64Array.from(boundary, (b) => (b ? q * qBoundaryFactor : q));
  const fixedSorted = [...new Set(fixed)].sort((a, b) => a - b);
  const isFixed = new Uint8Array(n);
  fixedSorted.forEach((k) => { isFixed[k] = 1; });
  const free = [];
  for (let k = 0; k < n; k++) if (!isFixed[k]) free.push(k);
  return { lx, ly, nx, ny, n, xyz, plan: xyz.slice(), edges, q: qv, boundary, fixed: fixedSorted, free, isFixed };
}

/** ShellForm's square_network(span, n, 'edges' | 'corners', q, factor). */
export function squareNetwork(span, n, supports, q = -1.0, qBoundaryFactor = 1.0) {
  return rectNetwork({ lx: span, ly: span, nx: n, ny: n, fixed: presetSupports(n, n, supports), q, qBoundaryFactor });
}

/** Nodal loads [N]: sa_x * w and sa_y * w sideways, -w down, at every node. */
export function planLoads(net, w = 1.0, saX = 0.0, saY = 0.0) {
  const p = new Float64Array(3 * net.n);
  for (let k = 0; k < net.n; k++) { p[3 * k] = saX * w; p[3 * k + 1] = saY * w; p[3 * k + 2] = -w; }
  return p;
}

/**
 * Solve D x_free = p_free - D_f x_fixed for x, y and z.
 * With every q < 0, -D is symmetric positive definite, so a banded Cholesky
 * factorisation is used. The free-node bandwidth is at most nx, which keeps a
 * 41 x 41 grid well under a millisecond-scale budget in the browser.
 */
export function solve(net, loads) {
  const { free, edges, q, isFixed, xyz: x0 } = net;
  const m = free.length;
  const pos = new Int32Array(net.n).fill(-1);
  free.forEach((k, a) => { pos[k] = a; });
  // Bandwidth in free-index space.
  let bw = 0;
  for (const [a, b] of edges) {
    const pa = pos[a], pb = pos[b];
    if (pa >= 0 && pb >= 0) bw = Math.max(bw, Math.abs(pa - pb));
  }
  // Band storage of A = -D: A[r][c] for c in [r - bw, r] at band[r * (bw + 1) + (c - r + bw)].
  const w = bw + 1;
  const band = new Float64Array(m * w);
  const rhs = new Float64Array(3 * m);
  for (let a = 0; a < m; a++) {
    const k = free[a];
    for (let d = 0; d < 3; d++) rhs[3 * a + d] = -loads[3 * k + d]; // A x = -(p - Df xf)
  }
  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e];
    const qe = -q[e]; // A = -D, so each edge adds +|q| on the diagonal
    const pa = pos[a], pb = pos[b];
    if (pa >= 0) band[pa * w + bw] += qe;
    if (pb >= 0) band[pb * w + bw] += qe;
    if (pa >= 0 && pb >= 0) {
      const r = Math.max(pa, pb), c = Math.min(pa, pb);
      band[r * w + (c - r + bw)] -= qe;
    } else if (pa >= 0 && isFixed[b]) {
      for (let d = 0; d < 3; d++) rhs[3 * pa + d] += qe * x0[3 * b + d];
    } else if (pb >= 0 && isFixed[a]) {
      for (let d = 0; d < 3; d++) rhs[3 * pb + d] += qe * x0[3 * a + d];
    }
  }
  // Banded Cholesky, A = L L^T, in place.
  for (let r = 0; r < m; r++) {
    const c0 = Math.max(0, r - bw);
    for (let c = c0; c <= r; c++) {
      let s = band[r * w + (c - r + bw)];
      const k0 = Math.max(c0, c - bw);
      for (let k = k0; k < c; k++) s -= band[r * w + (k - r + bw)] * band[c * w + (k - c + bw)];
      if (c === r) {
        if (!(s > 1e-12 * Math.abs(band[r * w + bw] || 1))) {
          throw new Error('unsupported: some free nodes have no load path to a support');
        }
        band[r * w + bw] = Math.sqrt(s);
      } else {
        band[r * w + (c - r + bw)] = s / band[c * w + bw];
      }
    }
  }
  // Forward and back substitution for the three right-hand sides.
  for (let d = 0; d < 3; d++) {
    for (let r = 0; r < m; r++) {
      let s = rhs[3 * r + d];
      for (let c = Math.max(0, r - bw); c < r; c++) s -= band[r * w + (c - r + bw)] * rhs[3 * c + d];
      rhs[3 * r + d] = s / band[r * w + bw];
    }
    for (let r = m - 1; r >= 0; r--) {
      let s = rhs[3 * r + d];
      for (let c = r + 1; c <= Math.min(m - 1, r + bw); c++) s -= band[c * w + (r - c + bw)] * rhs[3 * c + d];
      rhs[3 * r + d] = s / band[r * w + bw];
    }
  }
  const out = x0.slice();
  free.forEach((k, a) => { for (let d = 0; d < 3; d++) out[3 * k + d] = rhs[3 * a + d]; });
  return out;
}

/**
 * ShellForm's form_to_rise: scale q once from the gravity form so the gravity
 * rise is exactly riseM, then re-solve with the lateral load. Mutates net.q.
 */
export function formToRise(net, riseM, saX = 0.0, saY = 0.0) {
  const g = solve(net, planLoads(net));
  let z0 = -Infinity;
  for (let k = 0; k < net.n; k++) z0 = Math.max(z0, g[3 * k + 2]);
  if (!(z0 > 0)) throw new Error('form does not stand up; use negative (compression) q');
  const s = z0 / riseM;
  for (let e = 0; e < net.q.length; e++) net.q[e] *= s;
  return solve(net, planLoads(net, 1.0, saX, saY));
}

/** Plan inset of the free edge at the node nearest (0, -ly/2) [m]. */
export function edgeInset(net, xyz) {
  let best = 0, dmin = Infinity;
  for (let k = 0; k < net.n; k++) {
    const d = Math.hypot(net.plan[3 * k], net.plan[3 * k + 1] + net.ly / 2);
    if (d < dmin) { dmin = d; best = k; }
  }
  return xyz[3 * best + 1] + net.ly / 2;
}

/**
 * ShellForm's corner_network_for_inset: geometric bisection on the boundary
 * force-density factor until the mid-edge inset / span hits the target.
 * `build(f)` returns a fresh network for factor f (defaults to a square).
 */
export function networkForInset({ build, riseM, insetRatio, span, lo = 1.0, hi = 200.0, tol = 1e-3 }) {
  let net, xyz, mid;
  for (let it = 0; it < 60; it++) {
    mid = Math.sqrt(lo * hi);
    net = build(mid);
    xyz = formToRise(net, riseM);
    const r = edgeInset(net, xyz) / span;
    if (Math.abs(r - insetRatio) < tol) break;
    if (r > insetRatio) lo = mid; else hi = mid;
  }
  return { net, xyz, factor: mid };
}

/** Sum of member forces at each node in `nodes`, plus loads (ShellForm nodal_residuals). */
export function nodalResiduals(net, xyz, loads, nodes) {
  const f = loads ? Float64Array.from(loads) : new Float64Array(3 * net.n);
  net.edges.forEach(([a, b], e) => {
    for (let d = 0; d < 3; d++) {
      const v = net.q[e] * (xyz[3 * b + d] - xyz[3 * a + d]);
      f[3 * a + d] += v; f[3 * b + d] -= v;
    }
  });
  return nodes.map((k) => [f[3 * k], f[3 * k + 1], f[3 * k + 2]]);
}

/** max |free-node residual| / max |load| (ShellForm test S2 passes below 1e-9). */
export function equilibriumError(net, xyz, loads) {
  const res = nodalResiduals(net, xyz, loads, net.free);
  let rmax = 0, pmax = 0;
  res.forEach((r) => { rmax = Math.max(rmax, Math.hypot(r[0], r[1], r[2])); });
  for (let k = 0; k < net.n; k++) pmax = Math.max(pmax, Math.hypot(loads[3 * k], loads[3 * k + 1], loads[3 * k + 2]));
  if (pmax === 0) throw new Error('all loads are zero; the relative residual is undefined');
  return rmax / pmax;
}

/** Support reactions to the free-node loads, R_k = -sum q (x_j - x_k) (ShellForm support_reactions). */
export function supportReactions(net, xyz) {
  return nodalResiduals(net, xyz, null, net.fixed).map((r) => r.map((v) => -v));
}

/** Axial force per edge for unit nodal weight: N = q * L (negative = compression). */
export function edgeForces(net, xyz) {
  return net.edges.map(([a, b], e) => {
    const L = Math.hypot(xyz[3 * b] - xyz[3 * a], xyz[3 * b + 1] - xyz[3 * a + 1], xyz[3 * b + 2] - xyz[3 * a + 2]);
    return { force: net.q[e] * L, length: L };
  });
}

/** Surface area of the form [m^2], each grid cell split into two triangles. */
export function surfaceArea(net, xyz) {
  const { nx, ny } = net;
  const tri = (a, b, c) => {
    const ux = xyz[3 * b] - xyz[3 * a], uy = xyz[3 * b + 1] - xyz[3 * a + 1], uz = xyz[3 * b + 2] - xyz[3 * a + 2];
    const vx = xyz[3 * c] - xyz[3 * a], vy = xyz[3 * c + 1] - xyz[3 * a + 1], vz = xyz[3 * c + 2] - xyz[3 * a + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  let A = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const k = j * nx + i;
    A += tri(k, k + 1, k + nx + 1) + tri(k, k + nx + 1, k + nx);
  }
  return A;
}
