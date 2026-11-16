// Checks the ShellLab JS solver against fixtures written by ShellForm itself
// (tools/make_fixtures.py). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as F from '../src/fdm.js';

const dir = new URL('./fixtures/', import.meta.url);
const TOL = 1e-9; // metres, on coordinates of order 1-30 m

function maxAbsDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(new URL(file, dir)));
  const c = fx.case;
  test(`${file} matches ShellForm ${fx.shellform}`, () => {
    let net, xyz;
    if (file.startsWith('inset_')) {
      ({ net, xyz } = F.networkForInset({
        build: (f) => F.squareNetwork(c.span, c.n, 'corners', -1.0, f),
        riseM: c.rise, insetRatio: c.inset_ratio, span: c.span,
      }));
      const inset = F.edgeInset(net, xyz);
      assert.ok(Math.abs(inset - fx.inset) < TOL, `inset ${inset} vs ${fx.inset}`);
    } else {
      net = F.squareNetwork(c.span, c.n, c.supports, -1.0, c.q_boundary_factor);
      xyz = F.formToRise(net, c.rise, c.sa_x, c.sa_y);
    }
    assert.deepEqual(net.edges, fx.edges, 'edge order');
    assert.deepEqual(net.fixed, fx.fixed, 'supports');
    assert.ok(maxAbsDiff(net.plan, fx.plan.flat()) === 0, 'plan grid is bit-identical');
    assert.ok(maxAbsDiff(net.q, fx.q) < 1e-9 * Math.max(...fx.q.map(Math.abs)), 'force densities');
    const dx = maxAbsDiff(xyz, fx.xyz.flat());
    assert.ok(dx < TOL, `coordinates differ by ${dx}`);
    const R = F.supportReactions(net, xyz).flat();
    const dr = maxAbsDiff(R, fx.reactions.flat());
    assert.ok(dr < 1e-8, `reactions differ by ${dr}`);
    const err = F.equilibriumError(net, xyz, F.planLoads(net, 1, c.sa_x || 0, c.sa_y || 0));
    assert.ok(err < 1e-9, `equilibrium error ${err}`);
  });
}

test('rectangle on two edges stays in equilibrium and is symmetric', () => {
  const net = F.rectNetwork({ lx: 24, ly: 12, nx: 17, ny: 9, fixed: F.presetSupports(17, 9, 'two-edges') });
  const xyz = F.formToRise(net, 3);
  assert.ok(F.equilibriumError(net, xyz, F.planLoads(net)) < 1e-9);
  const zmax = Math.max(...net.free.map((k) => xyz[3 * k + 2]));
  assert.ok(Math.abs(zmax - 3) < 1e-12);
  const mirror = (k) => { const i = k % 17, j = Math.floor(k / 17); return j * 17 + (16 - i); };
  for (let k = 0; k < net.n; k++) assert.ok(Math.abs(xyz[3 * k + 2] - xyz[3 * mirror(k) + 2]) < 1e-10);
});

test('vertical reactions sum to the free-node weight', () => {
  const net = F.rectNetwork({ lx: 18, ly: 14, nx: 13, ny: 11, fixed: F.presetSupports(13, 11, 'mid-edges'), qBoundaryFactor: 6 });
  const xyz = F.formToRise(net, 4, 0.1, 0);
  const R = F.supportReactions(net, xyz);
  const Rz = R.reduce((s, r) => s + r[2], 0), Rx = R.reduce((s, r) => s + r[0], 0);
  assert.ok(Math.abs(Rz - net.free.length) < 1e-9, `Rz ${Rz}`);
  assert.ok(Math.abs(Rx + 0.1 * net.free.length) < 1e-9, `Rx ${Rx}`);
});

test('a free node with no path to a support is reported', () => {
  const net = F.rectNetwork({ lx: 10, ly: 10, nx: 5, ny: 5, fixed: [] });
  assert.throws(() => F.solve(net, F.planLoads(net)), /no load path/);
});
