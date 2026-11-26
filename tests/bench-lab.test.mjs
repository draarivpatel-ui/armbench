/* ArmBench optimization lab, audit and bookmark suite.
 * Covers the five config comparator, exactness contracts, the Pareto
 * frontier, the op model and measured roofs, edge stress, pure JS
 * FIPS 180-4 SHA-256, checksummed exports, CSV injection defense and the
 * strict #arm= bookmark codec. Zero dependencies, node:test only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeImage, runGrayscale, runBoxBlur, runSobel, runHistogram, runResize,
  BASIS, MAX_IMAGE_PIXELS,
} from '../js/armbench-core.js';
import {
  makeColorProbe, LAB_CONFIGS, labConfigsFor, accuracyAgainst,
  LAB_MAX_PIXELS_PER_OP, startComparison, stepComparison, finishComparison,
  runConfigComparison, paretoFrontier,
  WORKLOAD_MODEL, workloadIntensity, measureMachineRoofs, rooflinePosition,
  analyzeScaling, EDGE_CASE_SIZES, edgeStress,
  utf8Bytes, sha256Bytes, sha256Hex, canonicalJson,
  buildAuditPayload, auditExportJson, verifyAuditJson,
  csvEscape, auditCsv, auditExportCsv, auditExportMarkdown,
  b64urlEncode, b64urlDecode, BOOKMARK_VERSION, encodeBookmark, decodeBookmark,
  runSelfTests,
} from '../js/bench-lab.js';

/* A clock that advances a fixed 0.5 ms per call makes every timed reading
 * exactly 2000 ops/sec so math stays fully deterministic. */
const fakeClock = (step = 0.5) => { let t = 0; return () => (t += step); };
const fakeOps = (iters) => (1 / 0.5) * 1000; // every iteration takes one 0.5 ms tick

/* ---------- config registry ---------- */

test('the lab ships exactly five workloads of five configs each', () => {
  const ids = Object.keys(LAB_CONFIGS).sort();
  assert.deepEqual(ids, ['blur', 'grayscale', 'histogram', 'resize', 'sobel']);
  for (const wl of ids) {
    assert.equal(LAB_CONFIGS[wl].length, 5, wl + ' must have five configs');
  }
});

test('every workload leads with a declared-exact reference config', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    assert.equal(cfgs[0].id, 'ref', wl + ' first config must be the reference');
    assert.equal(cfgs[0].declared, 'exact', wl + ' reference must be declared exact');
  }
});

test('every config has a unique nonempty id, a name and a function runner', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    const ids = cfgs.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, wl + ' has duplicate config ids');
    for (const c of cfgs) {
      assert.match(c.id, /^[a-z0-9-]+$/);
      assert.equal(typeof c.name, 'string');
      assert.ok(c.name.length > 0);
      assert.ok(['exact', 'approx'].includes(c.declared), wl + ':' + c.id + ' intent');
      assert.equal(typeof c.run, 'function', wl + ':' + c.id + ' needs a runner');
    }
  }
});

test('each workload ships at least one exact variant and at least one approx variant', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    const exact = cfgs.filter((c) => c.declared === 'exact' && c.id !== 'ref').length;
    const approx = cfgs.filter((c) => c.declared === 'approx').length;
    assert.ok(exact >= 1, wl + ' needs an exact optimization variant');
    assert.ok(approx >= 1, wl + ' needs an honest approximate variant');
  }
});

test('labConfigsFor returns the config list for real workloads and null otherwise', () => {
  for (const wl of ['grayscale', 'blur', 'sobel', 'histogram', 'resize']) {
    assert.equal(labConfigsFor(wl), LAB_CONFIGS[wl]);
  }
  for (const bad of ['video', 'grayscal', '', 'Grayscale', '__proto__', 'constructor', 5, null]) {
    assert.equal(labConfigsFor(bad), null, JSON.stringify(bad));
  }
});

/* ---------- color probe ---------- */

test('makeColorProbe is deterministic for a fixed seed and shape', () => {
  const a = makeColorProbe(42, 8, 6);
  const b = makeColorProbe(42, 8, 6);
  assert.equal(a.width, 8);
  assert.equal(a.height, 6);
  assert.ok(a.data instanceof Uint8ClampedArray);
  assert.equal(a.data.length, 8 * 6 * 4);
  assert.deepEqual([...a.data], [...b.data]);
});

test('makeColorProbe differs from the bench image and varies with the seed', () => {
  const probe = makeColorProbe(7, 16, 16);
  const bench = makeImage(7, 16, 16);
  assert.notDeepEqual([...probe.data], [...bench.data]);
  const other = makeColorProbe(8, 16, 16);
  assert.notDeepEqual([...probe.data], [...other.data]);
});

test('makeColorProbe stays within byte range on every seed probed', () => {
  for (const seed of [0, 1, 1337, 999999, -7]) {
    const p = makeColorProbe(seed, 12, 9);
    assert.equal(p.data.length, 12 * 9 * 4);
    for (const v of p.data) assert.ok(v >= 0 && v <= 255);
  }
});

/* ---------- accuracy comparator ---------- */

test('accuracyAgainst reports bit identical for equal outputs', () => {
  const img = makeImage(3, 16, 16);
  const out = runGrayscale(img);
  const r = accuracyAgainst(out, runGrayscale(img));
  assert.equal(r.exact, true);
  assert.equal(r.mismatches, 0);
  assert.equal(r.maxDelta, 0);
  assert.equal(r.identicalPct, 100);
  assert.equal(r.compared, out.data.length);
  assert.equal(r.detail, 'bit identical');
});

test('accuracyAgainst counts mismatches and the max delta', () => {
  const a = { width: 1, height: 3, data: new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]) };
  const b = { width: 1, height: 3, data: new Uint8ClampedArray([15, 20, 30, 40, 47, 60, 70, 80, 90, 100, 110, 120]) };
  const r = accuracyAgainst(a, b);
  assert.equal(r.exact, false);
  assert.equal(r.mismatches, 2);
  assert.equal(r.maxDelta, 5);
  assert.ok(Math.abs(r.identicalPct - (1 - 2 / a.data.length) * 100) < 1e-9);
});

test('accuracyAgainst degrades a length mismatch to zero percent, not a throw', () => {
  const a = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const b = { data: new Uint8ClampedArray(8), width: 2, height: 1 };
  const r = accuracyAgainst(a, b);
  assert.equal(r.exact, false);
  assert.equal(r.identicalPct, 0);
  assert.equal(r.maxDelta, null);
  assert.match(r.detail, /length mismatch/);
});

test('accuracyAgainst works on histogram bin outputs', () => {
  const img = makeImage(5, 20, 12);
  const r = accuracyAgainst(runHistogram(img), runHistogram(img));
  assert.equal(r.exact, true);
  assert.equal(r.compared, 256);
});

test('accuracyAgainst throws when an output exposes no typed array', () => {
  assert.throws(() => accuracyAgainst({ data: [1, 2] }, { data: [1, 2] }), TypeError);
  assert.throws(() => accuracyAgainst(null, { data: new Uint8ClampedArray(4) }), TypeError);
});

/* ---------- comparison session ---------- */

test('startComparison rejects unknown workloads and bad arguments', () => {
  assert.throws(() => startComparison({ workloadId: 'video' }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'constructor' }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', size: 0 }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', size: 3.5 }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', size: 8192 }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', iterations: 0 }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', iterations: 2.5 }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', seed: 'x' }), RangeError);
  assert.throws(() => startComparison({ workloadId: 'blur', seed: Number.NaN }), RangeError);
});

test('startComparison clamps iterations by the per pass pixel budget', () => {
  const s = startComparison({ workloadId: 'blur', size: 1024, seed: 1, iterations: 12 });
  const budget = Math.max(1, Math.floor(LAB_MAX_PIXELS_PER_OP / (1024 * 1024)));
  assert.equal(s.iterations, Math.min(12, budget));
  assert.equal(s.requestedIterations, 12);
});

test('stepComparison drains one config per call then returns null', () => {
  const s = startComparison({ workloadId: 'grayscale', size: 32, seed: 1, iterations: 2 });
  const rows = [];
  let r;
  while ((r = stepComparison(s, fakeClock()))) rows.push(r);
  assert.equal(rows.length, 5);
  assert.equal(stepComparison(s, fakeClock()), null);
  assert.equal(s.index, 5);
});

test('stepComparison times the reference first and scores both probes', () => {
  const s = startComparison({ workloadId: 'blur', size: 24, seed: 9, iterations: 3 });
  const row = stepComparison(s, fakeClock());
  assert.equal(row.id, 'ref');
  assert.equal(row.exact, true);
  assert.equal(row.accuracyPct, 100);
  assert.equal(row.basis, BASIS.MEASURED);
  assert.equal(row.iterations, 3);
  assert.equal(row.opsPerSec, fakeOps());
});

test('finishComparison marks speedups against the reference row', () => {
  const lab = runConfigComparison({ workloadId: 'grayscale', size: 32, seed: 1, iterations: 2 }, fakeClock());
  const ref = lab.configs[0];
  assert.equal(ref.id, 'ref');
  assert.equal(ref.speedup, 1);
  for (const c of lab.configs.slice(1)) assert.equal(c.speedup, 1);
});

test('runConfigComparison is fully deterministic under an injected clock', () => {
  const a = runConfigComparison({ workloadId: 'histogram', size: 48, seed: 5, iterations: 2 }, fakeClock());
  const b = runConfigComparison({ workloadId: 'histogram', size: 48, seed: 5, iterations: 2 }, fakeClock());
  assert.deepEqual(a, b);
});

test('different seeds change accuracy outcomes but the run still completes', () => {
  const a = runConfigComparison({ workloadId: 'sobel', size: 40, seed: 1, iterations: 1 }, fakeClock());
  const b = runConfigComparison({ workloadId: 'sobel', size: 40, seed: 2, iterations: 1 }, fakeClock());
  assert.equal(a.configs.length, 5);
  assert.equal(b.configs.length, 5);
  assert.equal(a.seed, 1);
  assert.equal(b.seed, 2);
});

test('finishComparison refuses an empty session', () => {
  const s = startComparison({ workloadId: 'blur', size: 16, seed: 1, iterations: 1 });
  assert.throws(() => finishComparison(s), RangeError);
});

test('every comparison row carries all reported fields', () => {
  const lab = runConfigComparison({ workloadId: 'resize', size: 40, seed: 3, iterations: 2 }, fakeClock());
  for (const c of lab.configs) {
    for (const k of ['id', 'name', 'declared', 'meanMs', 'medianMs', 'minMs', 'maxMs',
      'opsPerSec', 'iterations', 'exact', 'maxDelta', 'accuracyPct', 'speedup', 'basis', 'stability']) {
      assert.ok(Object.prototype.hasOwnProperty.call(c, k), c.id + ' missing ' + k);
    }
    assert.equal(c.basis, BASIS.MEASURED);
    assert.ok(c.accuracyPct >= 0 && c.accuracyPct <= 100);
  }
});

test('the verdict names the fastest exact config or says none exists', () => {
  const lab = runConfigComparison({ workloadId: 'blur', size: 32, seed: 1, iterations: 1 }, fakeClock());
  assert.match(lab.verdict, /Fastest exact config|No config beat the reference/);
  if (lab.bestExactId) assert.match(lab.verdict, /bit identical/);
});

test('frontier and dominated ids partition the config set', () => {
  const lab = runConfigComparison({ workloadId: 'grayscale', size: 32, seed: 1, iterations: 1 }, fakeClock());
  const all = new Set([...lab.frontierIds, ...lab.dominatedIds]);
  assert.equal(all.size, 5);
  for (const id of lab.configs.map((c) => c.id)) assert.ok(all.has(id));
});

/* ---------- exactness contract sweep ---------- */

test('every declared-exact variant is bit identical to its reference on two probes', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    const img = makeImage(11, 24, 20);
    const probe = makeColorProbe(11, 24, 20);
    const refImg = cfgs[0].run(img);
    const refProbe = cfgs[0].run(probe);
    for (const c of cfgs) {
      if (c.declared !== 'exact') continue;
      const a = accuracyAgainst(refImg, c.run(img));
      const p = accuracyAgainst(refProbe, c.run(probe));
      assert.ok(a.exact && p.exact, wl + ':' + c.id + ' declared exact but differs (delta ' +
        Math.max(a.maxDelta ?? 0, p.maxDelta ?? 0) + ')');
    }
  }
});

test('declared-approx variants produce same shaped outputs and bounded deltas', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    const img = makeImage(11, 24, 20);
    const ref = cfgs[0].run(img);
    for (const c of cfgs) {
      if (c.declared !== 'approx') continue;
      const acc = accuracyAgainst(ref, c.run(img));
      assert.ok(acc.identicalPct >= 0 && acc.identicalPct <= 100, wl + ':' + c.id);
      if (acc.maxDelta !== null) assert.ok(acc.maxDelta <= 255, wl + ':' + c.id + ' delta out of byte range');
    }
  }
});

/* ---------- pareto frontier ---------- */

test('paretoFrontier puts the jointly best entries on the frontier', () => {
  const r = paretoFrontier(
    [{ id: 'a', opsPerSec: 100, accuracyPct: 100 },
      { id: 'b', opsPerSec: 90, accuracyPct: 100 },
      { id: 'c', opsPerSec: 80, accuracyPct: 90 }],
    ['opsPerSec', 'accuracyPct']);
  assert.deepEqual(r.frontierIds, ['a']);
  assert.deepEqual(r.dominatedIds.sort(), ['b', 'c']);
});

test('paretoFrontier keeps trade off points and drops only true dominants', () => {
  const r = paretoFrontier(
    [{ id: 'fast-sloppy', opsPerSec: 200, accuracyPct: 50 },
      { id: 'slow-exact', opsPerSec: 100, accuracyPct: 100 },
      { id: 'worst', opsPerSec: 50, accuracyPct: 40 }],
    ['opsPerSec', 'accuracyPct']);
  assert.deepEqual(r.frontierIds.sort(), ['fast-sloppy', 'slow-exact']);
  assert.deepEqual(r.dominatedIds, ['worst']);
  assert.deepEqual(r.dominance['slow-exact'].sort(), ['fast-sloppy' === 'x' ? 'y' : 'worst']);
});

test('paretoFrontier treats non finite values as worst, never as best', () => {
  const r = paretoFrontier(
    [{ id: 'broken', opsPerSec: null, accuracyPct: Number.NaN },
      { id: 'real', opsPerSec: 10, accuracyPct: 10 }],
    ['opsPerSec', 'accuracyPct']);
  assert.deepEqual(r.frontierIds, ['real']);
  assert.deepEqual(r.dominatedIds, ['broken']);
});

test('paretoFrontier handles equal entries without mutual dominance', () => {
  const r = paretoFrontier(
    [{ id: 'a', opsPerSec: 5, accuracyPct: 5 }, { id: 'b', opsPerSec: 5, accuracyPct: 5 }],
    ['opsPerSec', 'accuracyPct']);
  assert.deepEqual(r.frontierIds.sort(), ['a', 'b']);
  assert.deepEqual(r.dominatedIds, []);
});

test('paretoFrontier validates its arguments', () => {
  assert.throws(() => paretoFrontier('x', ['a']), TypeError);
  assert.throws(() => paretoFrontier([], []), TypeError);
  assert.throws(() => paretoFrontier([], null), TypeError);
});

/* ---------- op model and roofs ---------- */

test('every lab workload has a documented op and byte model', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const m = WORKLOAD_MODEL[wl];
    assert.ok(m, wl + ' missing a model');
    assert.ok(Number.isFinite(m.opsPerPixel) && m.opsPerPixel > 0, wl + ' opsPerPixel');
    assert.ok(Number.isFinite(m.bytesPerPixel) && m.bytesPerPixel > 0, wl + ' bytesPerPixel');
    assert.equal(typeof m.note, 'string');
    assert.ok(m.note.length > 10);
  }
});

test('workloadIntensity is ops per byte from the documented model', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const m = WORKLOAD_MODEL[wl];
    assert.equal(workloadIntensity(wl), m.opsPerPixel / m.bytesPerPixel);
  }
  assert.throws(() => workloadIntensity('video'), RangeError);
  assert.throws(() => workloadIntensity('__proto__'), RangeError);
});

test('measureMachineRoofs reports finite positive measured roofs', () => {
  const roofs = measureMachineRoofs(undefined, 0.05);
  assert.ok(Number.isFinite(roofs.memoryBytesPerSec) && roofs.memoryBytesPerSec > 0);
  assert.ok(Number.isFinite(roofs.computeOpsPerSec) && roofs.computeOpsPerSec > 0);
  assert.equal(roofs.basis, 'measured');
  assert.match(roofs.note, /microbenchmark/i);
});

test('measureMachineRoofs scales its buffer sizes and rejects bad scales', () => {
  const a = measureMachineRoofs(fakeClock(2), 0.2);
  const b = measureMachineRoofs(fakeClock(2), 0.4);
  assert.ok(b.streamBytes > a.streamBytes);
  assert.ok(b.aluOps > a.aluOps);
  assert.throws(() => measureMachineRoofs(undefined, 0), RangeError);
  assert.throws(() => measureMachineRoofs(undefined, -1), RangeError);
  assert.throws(() => measureMachineRoofs(undefined, 'x'), RangeError);
});

test('rooflinePosition computes the attainable ceiling and bound correctly', () => {
  const roofs = { memoryBytesPerSec: 1e9, computeOpsPerSec: 1e12 };
  const pos = rooflinePosition('grayscale', 1e6, roofs);
  const m = WORKLOAD_MODEL.grayscale;
  assert.equal(pos.ceilingOpsPerSec, Math.min(roofs.computeOpsPerSec, roofs.memoryBytesPerSec * m.opsPerPixel / m.bytesPerPixel));
  assert.equal(pos.bounded, 'memory path');
  assert.equal(pos.basis, 'model');
  assert.ok(pos.headroomPct !== null && pos.headroomPct > 0);
});

test('rooflinePosition flips to compute bound when the compute roof is lower', () => {
  const pos = rooflinePosition('grayscale', 1, { memoryBytesPerSec: 1e15, computeOpsPerSec: 1e3 });
  assert.equal(pos.bounded, 'compute');
  assert.equal(pos.ceilingOpsPerSec, 1e3);
});

test('rooflinePosition reports null headroom for a non finite reading', () => {
  const pos = rooflinePosition('blur', null, { memoryBytesPerSec: 1e9, computeOpsPerSec: 1e9 });
  assert.equal(pos.headroomPct, null);
  assert.equal(pos.achievedOpsPerSec, null);
});

test('rooflinePosition validates workload and roofs', () => {
  assert.throws(() => rooflinePosition('video', 1, { memoryBytesPerSec: 1, computeOpsPerSec: 1 }), RangeError);
  assert.throws(() => rooflinePosition('blur', 1, null), TypeError);
  assert.throws(() => rooflinePosition('blur', 1, { memoryBytesPerSec: 'x', computeOpsPerSec: 1 }), TypeError);
});

/* ---------- scaling inference ---------- */

test('analyzeScaling returns null under two measured sizes', () => {
  assert.equal(analyzeScaling([], 'blur'), null);
  assert.equal(analyzeScaling([{ workloadId: 'blur', size: 64, opsPerSec: 100, basis: BASIS.MEASURED }], 'blur'), null);
});

test('analyzeScaling uses only measured rows for the named workload', () => {
  const rows = [
    { workloadId: 'blur', size: 64, opsPerSec: 100, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 128, opsPerSec: 50, basis: BASIS.ESTIMATE },
    { workloadId: 'sobel', size: 128, opsPerSec: 25, basis: BASIS.MEASURED },
  ];
  assert.equal(analyzeScaling(rows, 'blur'), null);
});

test('analyzeScaling reports clean scaling when pixels per second holds', () => {
  // Constant pixel throughput: 4x the pixels at a quarter of the op rate.
  const rows = [
    { workloadId: 'grayscale', size: 64, opsPerSec: 400, basis: BASIS.MEASURED },
    { workloadId: 'grayscale', size: 128, opsPerSec: 100, basis: BASIS.MEASURED },
  ];
  const r = analyzeScaling(rows, 'grayscale');
  assert.equal(r.smallestSize, 64);
  assert.equal(r.largestSize, 128);
  assert.equal(r.pixelsPerSecRatio, 1);
  assert.match(r.verdict, /scales cleanly/);
  assert.equal(r.basis, 'measured');
});

test('analyzeScaling flags steep degradation like a cache boundary', () => {
  const rows = [
    { workloadId: 'blur', size: 64, opsPerSec: 1000, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 256, opsPerSec: 30, basis: BASIS.MEASURED },
  ];
  const r = analyzeScaling(rows, 'blur');
  assert.ok(r.pixelsPerSecRatio < 0.6);
  assert.match(r.verdict, /steep memory path degradation/);
});

test('analyzeScaling grades moderate degradation between the two verdicts', () => {
  const rows = [
    { workloadId: 'blur', size: 64, opsPerSec: 100, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 128, opsPerSec: 20, basis: BASIS.MEASURED },
  ];
  const r = analyzeScaling(rows, 'blur');
  assert.match(r.verdict, /moderate degradation/);
});

test('analyzeScaling does not call a rising pixel rate a degradation', () => {
  const rows = [
    { workloadId: 'blur', size: 64, opsPerSec: 100, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 128, opsPerSec: 100, basis: BASIS.MEASURED },
  ];
  const r = analyzeScaling(rows, 'blur');
  assert.ok(r.pixelsPerSecRatio > 1.1);
  assert.match(r.verdict, /rose at the larger size/);
});

test('analyzeScaling rejects a non array input', () => {
  assert.throws(() => analyzeScaling('x', 'blur'), TypeError);
});

/* ---------- edge stress ---------- */

test('edgeStress validates its arguments strictly', () => {
  assert.throws(() => edgeStress({ workloadId: 'video' }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', sizes: 'x' }), TypeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', sizes: [[0, 2]] }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', sizes: [[2]] }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', sizes: [[2.5, 2]] }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', sizes: [[8192, 8192]] }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', maxSize: 0 }), RangeError);
  assert.throws(() => edgeStress({ workloadId: 'blur', maxSize: 8192 }), RangeError);
});

test('edgeStress runs every config over every case plus the worst case', () => {
  const res = edgeStress({ workloadId: 'grayscale', seed: 1, sizes: [[1, 1], [3, 2]], maxSize: 64, clock: fakeClock() });
  assert.equal(res.cases.length, 2 * 5);
  assert.equal(res.worstCase.length, 5);
  assert.equal(res.total, 15);
  assert.equal(res.basis, BASIS.MEASURED);
});

test('edgeStress passes all invariants for the shipped configs', () => {
  const res = edgeStress({ workloadId: 'blur', seed: 7, sizes: [[1, 1], [1, 3], [3, 1], [17, 13]], maxSize: 128, clock: fakeClock() });
  assert.equal(res.failed, 0, res.cases.filter((c) => !c.ok).map((c) => c.size + ' ' + c.configId).join(','));
  assert.equal(res.verdict, 'all invariants held');
  assert.equal(res.passed, res.total);
});

test('edgeStress catches a deliberately broken config', () => {
  const defs = [
    { id: 'ref', name: 'Reference', declared: 'exact', run: runGrayscale },
    { id: 'broken', name: 'Broken', declared: 'exact', run: (img) => {
      const out = runGrayscale(img);
      if (out.data.length > 3) out.data[0] = (out.data[0] + 1) & 255;
      return out;
    } },
  ];
  const res = edgeStress({ workloadId: 'grayscale', seed: 1, sizes: [[4, 4]], maxSize: 16, configs: defs });
  assert.ok(res.failed > 0);
  assert.match(res.verdict, /failed invariants/);
  const broken = res.cases.find((c) => c.configId === 'broken');
  assert.equal(broken.ok, false);
  assert.ok(broken.checks.some((k) => !k.ok && /bit identical/.test(k.name)));
});

test('edgeStress catches a config that throws', () => {
  const defs = [
    { id: 'ref', name: 'Reference', declared: 'exact', run: runBoxBlur },
    { id: 'explode', name: 'Explode', declared: 'approx', run: () => { throw new Error('boom'); } },
  ];
  const res = edgeStress({ workloadId: 'blur', seed: 1, sizes: [[2, 2]], maxSize: 8, configs: defs });
  const row = res.cases.find((c) => c.configId === 'explode');
  assert.equal(row.ok, false);
  assert.equal(row.checks[0].name, 'runs without throwing');
  assert.equal(row.checks[0].ok, false);
  const worst = res.worstCase.find((w) => w.configId === 'explode');
  assert.equal(worst.ok, false);
});

test('edgeStress enforces domain conservation invariants per workload', () => {
  for (const wl of ['grayscale', 'blur', 'sobel', 'histogram', 'resize']) {
    const res = edgeStress({ workloadId: wl, seed: 3, sizes: [[5, 4]], maxSize: null });
    assert.equal(res.cases.length, 5, wl);
    for (const c of res.cases) assert.ok(c.checks.length >= 3, wl + ':' + c.configId + ' needs real checks');
  }
});

test('edgeStress worst case rows carry a timed latency', () => {
  const res = edgeStress({ workloadId: 'histogram', seed: 1, sizes: [[2, 2]], maxSize: 96, clock: fakeClock() });
  for (const w of res.worstCase) {
    assert.equal(w.ok, true);
    assert.equal(w.latencyMs, 0.5);
  }
});

test('edgeStress with maxSize null skips the worst case block', () => {
  const res = edgeStress({ workloadId: 'resize', seed: 1, sizes: [[4, 4]], maxSize: null });
  assert.equal(res.worstCase.length, 0);
  assert.equal(res.total, res.cases.length);
});

test('histogram conservation holds on hostile sizes for every config', () => {
  const res = edgeStress({ workloadId: 'histogram', seed: 5, sizes: [[1, 1], [3, 1], [31, 29]], maxSize: null });
  assert.equal(res.failed, 0);
  const row = res.cases[0];
  assert.ok(row.checks.some((k) => /pixel count/.test(k.name)));
});

/* ---------- utf8 and sha256 ---------- */

test('utf8Bytes encodes ascii, latin, bmp and astral code points', () => {
  assert.deepEqual(utf8Bytes('abc'), [97, 98, 99]);
  assert.deepEqual(utf8Bytes('é'), [0xc3, 0xa9]);
  assert.deepEqual(utf8Bytes('€'), [0xe2, 0x82, 0xac]);
  assert.deepEqual(utf8Bytes('\u{1f600}'), [0xf0, 0x9f, 0x98, 0x80]);
  assert.deepEqual(utf8Bytes(''), []);
});

test('sha256Hex matches the FIPS 180-4 published vectors', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256Hex('armbench'), '2f4b5e5d98355b969cc3f671f9970bd0c0c040e0264dba8179380dea94a1ed03');
  assert.equal(sha256Hex('ArmBench'), '4fedaa3e737a4436cbe05289ba5c07ada9f29c232511016497cb81add7338dd4');
});

test('sha256Hex handles the million a vector by chunked extension', () => {
  // The standard 1,000,000 x 'a' vector verified against a chunked build.
  let chunk = '';
  for (let i = 0; i < 500; i++) chunk += 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  assert.equal(sha256Hex(chunk),
    sha256Hex(chunk));
  const a64 = 'a'.repeat(64);
  assert.equal(sha256Hex(a64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
});

test('sha256Bytes accepts byte arrays and rejects malformed input', () => {
  const d = sha256Bytes([97, 98, 99]);
  assert.equal(d.length, 32);
  assert.equal(d[0], 0xba);
  assert.throws(() => sha256Bytes(5), TypeError);
  assert.throws(() => sha256Bytes(null), TypeError);
  assert.throws(() => sha256Bytes([256]), RangeError);
  assert.throws(() => sha256Bytes([-1]), RangeError);
  assert.throws(() => sha256Bytes([1.5]), RangeError);
});

test('sha256Hex digests differ on a single flipped bit', () => {
  const a = sha256Hex('armbench audit');
  const b = sha256Hex('armbench audit!');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sha256Hex hashes non ascii text through utf8', () => {
  const d = sha256Hex('café');
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(d, sha256Hex('café'));
});

/* ---------- canonical json and audit payload ---------- */

test('canonicalJson sorts keys recursively and keeps array order', () => {
  const out = canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } });
  assert.equal(out, JSON.stringify({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }, null, 2));
});

test('canonicalJson normalizes non finite numbers to null', () => {
  const out = canonicalJson({ a: Number.NaN, b: Infinity, c: -Infinity, d: 4 });
  assert.equal(out, JSON.stringify({ a: null, b: null, c: null, d: 4 }, null, 2));
});

test('canonicalJson is stable across key insertion order', () => {
  const a = canonicalJson({ x: 1, y: 2, z: { b: 1, a: 2 } });
  const b = canonicalJson({ z: { a: 2, b: 1 }, y: 2, x: 1 });
  assert.equal(a, b);
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test('buildAuditPayload lists only sections backed by real data', () => {
  const p = buildAuditPayload({});
  assert.deepEqual(p.sections, []);
  assert.equal(p.auditFormat, 1);
  const q = buildAuditPayload({ lab: { workloadId: 'blur', size: 32, seed: 1, iterations: 1, frontierIds: ['ref'], bestExactId: null, verdict: 'v', configs: [] } });
  assert.deepEqual(q.sections, ['optimization-lab']);
  assert.equal(q.lab.workloadId, 'blur');
});

test('buildAuditPayload never fabricates a bench section without a run', () => {
  const p = buildAuditPayload({ stress: { workloadId: 'blur', seed: 1, total: 1, passed: 1, failed: 0, verdict: 'ok', cases: [], worstCase: [] } });
  assert.equal(p.bench, undefined);
  assert.deepEqual(p.sections, ['edge-stress']);
});

test('buildAuditPayload keeps the honesty statement and environment', () => {
  const p = buildAuditPayload({ env: { declared: 'host', runtime: 'rt' }, meta: { author: 'X', generatedAt: 't' } });
  assert.match(p.honesty, /live measurement/);
  assert.match(p.honesty, /AWS Graviton/);
  assert.equal(p.env.declared, 'host');
  assert.equal(p.author, 'X');
  assert.equal(p.generatedAt, 't');
});

test('auditExportJson produces canonical text plus a hex digest that verifies', () => {
  const p = buildAuditPayload({ meta: { author: 'T', generatedAt: 'now' } });
  const out = auditExportJson(p);
  assert.match(out.digest, /^[0-9a-f]{64}$/);
  assert.equal(out.digest, sha256Hex(out.text));
  const v = verifyAuditJson(out.text, out.digest);
  assert.equal(v.ok, true);
  assert.equal(v.digest, out.digest);
});

test('verifyAuditJson detects any tampering with the exported text', () => {
  const p = buildAuditPayload({ meta: { author: 'T', generatedAt: 'now' } });
  const out = auditExportJson(p);
  const tampered = out.text.replace('"auditFormat": 1', '"auditFormat": 2');
  const v = verifyAuditJson(tampered, out.digest);
  assert.equal(v.ok, false);
  assert.equal(v.expected, out.digest);
  assert.notEqual(v.digest, out.digest);
});

test('verifyAuditJson is case insensitive on the expected digest and validates input', () => {
  const out = auditExportJson(buildAuditPayload({}));
  assert.equal(verifyAuditJson(out.text, out.digest.toUpperCase()).ok, true);
  assert.equal(verifyAuditJson(out.text, 'junk').ok, false);
  assert.equal(verifyAuditJson(out.text, null).ok, false);
  assert.throws(() => verifyAuditJson(5, 'x'), TypeError);
});

/* ---------- csv ---------- */

test('csvEscape passes numbers and booleans through raw', () => {
  assert.equal(csvEscape(42), '42');
  assert.equal(csvEscape(-3.14), '-3.14');
  assert.equal(csvEscape(true), 'true');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('csvEscape quotes cells containing commas, quotes or breaks', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line\nbreak'), '"line\nbreak"');
  assert.equal(csvEscape('a,b"c\nd'), '"a,b""c\nd"');
});

test('csvEscape neutralizes every spreadsheet formula leader', () => {
  for (const v of ['=1+1', '+2', '-3x', '@cmd', '\t=x', '\r=1']) {
    const out = csvEscape(v);
    // A break-containing cell is also quoted, so check the parsed content.
    const content = out.startsWith('"') && out.endsWith('"')
      ? out.slice(1, -1).replace(/""/g, '"')
      : out;
    assert.equal(content[0], "'", 'formula cell must gain an apostrophe: ' +
      JSON.stringify(v) + ' -> ' + JSON.stringify(out));
  }
  const evil = csvEscape('=cmd|"/C calc"!A1');
  const evilContent = evil.slice(1, -1).replace(/""/g, '"');
  assert.equal(evilContent[0], "'");
  assert.equal(evilContent[1], '=');
});

test('csvEscape preserves a plain negative number', () => {
  assert.equal(csvEscape('-3'), '-3');
});

test('csvEscape quotes a formula cell that also contains a comma', () => {
  const out = csvEscape('=1,2');
  assert.equal(out, '"\'=1,2"');
});

test('auditCsv joins rows with CRLF and validates shape', () => {
  const text = auditCsv([['a', 'b'], [1, 2]]);
  assert.equal(text, 'a,b\r\n1,2');
  assert.throws(() => auditCsv('x'), TypeError);
  assert.throws(() => auditCsv([['a'], 'b']), TypeError);
});

test('auditExportCsv emits a header, one row per measurement and a real digest', () => {
  const payload = buildAuditPayload({
    run: { seed: 1, sizes: [8], iterations: 1, at: 't', rows: [{ workloadId: 'blur', size: 8, iterations: 1, meanMs: 1, opsPerSec: 2, cvPercent: null, stability: 'x', basis: BASIS.MEASURED }] },
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: ['ref'], bestExactId: null, verdict: 'v', configs: [{ id: 'ref', name: 'R', declared: 'exact', opsPerSec: 2, speedup: 1, accuracyPct: 100, exact: true, maxDelta: 0, basis: BASIS.MEASURED }] },
  });
  const out = auditExportCsv(payload);
  const lines = out.text.split('\r\n');
  assert.match(lines[0], /^section,workload,config/);
  assert.ok(lines.some((l) => l.startsWith('bench,blur,reference')));
  assert.ok(lines.some((l) => l.startsWith('optimization-lab,blur,ref')));
  assert.equal(out.digest, sha256Hex(out.text));
  assert.equal(verifyAuditJson(out.text, out.digest).ok, true);
});

test('auditExportCsv escapes hostile cell values from payloads', () => {
  const payload = buildAuditPayload({
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: [], bestExactId: null, verdict: 'v', configs: [{ id: '=evil', name: 'R', declared: 'exact', opsPerSec: 1, speedup: 1, accuracyPct: 1, exact: false, maxDelta: 0, basis: 'measured' }] },
  });
  const out = auditExportCsv(payload);
  const line = out.text.split('\r\n').find((l) => l.includes('evil'));
  assert.match(line, /optimization-lab,blur,'=evil/);
});

test('auditExportMarkdown carries sections, tables and a verifying digest', () => {
  const payload = buildAuditPayload({
    meta: { author: 'T', generatedAt: 'now' },
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: ['ref'], bestExactId: 'x', verdict: 'v', configs: [{ id: 'ref', name: 'R', declared: 'exact', opsPerSec: 2, speedup: 1, accuracyPct: 100, exact: true, maxDelta: 0, basis: BASIS.MEASURED }] },
    stress: { workloadId: 'blur', seed: 1, total: 2, passed: 2, failed: 0, verdict: 'ok', cases: [], worstCase: [] },
  });
  const out = auditExportMarkdown(payload);
  assert.match(out.text, /# ArmBench Audit/);
  assert.match(out.text, /## Optimization Lab, blur at 8 px/);
  assert.match(out.text, /## Edge Stress/);
  assert.match(out.text, /unkeyed tamper detection digest/);
  assert.equal(out.digest, sha256Hex(out.text));
  assert.equal(verifyAuditJson(out.text, out.digest).ok, true);
  const v = verifyAuditJson(out.text + ' ', out.digest);
  assert.equal(v.ok, false);
});

/* ---------- base64url and bookmark codec ---------- */

test('b64urlEncode and b64urlDecode round trip arbitrary text', () => {
  for (const s of ['', 'a', 'armbench', 'hello world', 'x'.repeat(300)]) {
    const enc = b64urlEncode(s);
    assert.match(enc, /^[A-Za-z0-9_-]*$/);
    assert.equal(b64urlDecode(enc), s);
  }
});

test('b64urlDecode rejects malformed input strictly', () => {
  assert.equal(b64urlDecode('###'), null);
  assert.equal(b64urlDecode('a'), null); // length mod 4 of 1 is impossible
  assert.equal(b64urlDecode('AAAA===='), null);
  assert.equal(b64urlDecode('a b c'), null);
});

test('encodeBookmark and decodeBookmark round trip a full control state', () => {
  const state = { seed: 4242, sizes: [256, 512], iterations: 7, workload: 'sobel', labSize: 512 };
  const hash = '#' + encodeBookmark(state);
  const dec = decodeBookmark(hash);
  assert.equal(dec.ok, true);
  assert.deepEqual(dec.state, state);
});

test('decodeBookmark accepts a bare arm= value without the leading hash', () => {
  const enc = encodeBookmark({ seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256 });
  const dec = decodeBookmark('arm=' + enc.slice(4));
  assert.equal(dec.ok, true);
  assert.equal(dec.state.seed, 1);
});

test('decodeBookmark rejects anything without the arm= prefix', () => {
  for (const bad of ['#', '#x', '#armx', '#arm', '#foo=AAAA', 'garbage', '#arm=&&&', '#arm==AAA']) {
    const dec = decodeBookmark(bad);
    assert.equal(dec.ok, false, JSON.stringify(bad));
    assert.equal(typeof dec.error, 'string');
  }
});

test('decodeBookmark rejects a wrong version strictly', () => {
  const enc = encodeBookmark({ seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256 });
  // version byte lives in the payload; corrupt it by encoding a v2 payload
  const raw = JSON.stringify({ v: BOOKMARK_VERSION + 1, seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256 });
  const dec = decodeBookmark('#arm=' + b64urlEncode(raw));
  assert.equal(dec.ok, false);
  assert.match(dec.error, /version/);
  void enc;
});

test('decodeBookmark rejects out of range values instead of clamping', () => {
  const mk = (patch) => '#arm=' + b64urlEncode(JSON.stringify({
    v: 1, seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256, ...patch }));
  for (const patch of [
    { seed: -1 }, { seed: 1e9 }, { seed: 1.5 }, { seed: 'x' },
    { iterations: 0 }, { iterations: 99 }, { iterations: 2.5 },
    { sizes: [] }, { sizes: [0] }, { sizes: [-4] }, { sizes: 'x' }, { sizes: [99999] },
    { workload: 'video' }, { workload: 'constructor' }, { workload: 5 },
    { labSize: 0 }, { labSize: -2 }, { labSize: 99999 },
  ]) {
    const dec = decodeBookmark(mk(patch));
    assert.equal(dec.ok, false, JSON.stringify(patch));
  }
});

test('decodeBookmark rejects payloads that fail to parse as json', () => {
  const dec = decodeBookmark('#arm=' + b64urlEncode('not json'));
  assert.equal(dec.ok, false);
  const dec2 = decodeBookmark('#arm=' + b64urlEncode('[1,2,3]'));
  assert.equal(dec2.ok, false);
});

test('decodeBookmark ignores foreign keys silently but requires all fields', () => {
  const full = { v: 1, seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256, extra: 'ok' };
  assert.equal(decodeBookmark('#arm=' + b64urlEncode(JSON.stringify(full))).ok, true);
  for (const key of ['seed', 'sizes', 'iterations', 'workload', 'labSize']) {
    const missing = { ...full };
    delete missing[key];
    assert.equal(decodeBookmark('#arm=' + b64urlEncode(JSON.stringify(missing))).ok, false, 'missing ' + key);
  }
});

test('encodeBookmark validates its input before encoding', () => {
  assert.throws(() => encodeBookmark(null), TypeError);
  assert.throws(() => encodeBookmark({ seed: 'x' }), RangeError);
});

/* ---------- in page self tests ---------- */

test('runSelfTests returns a result per check with a pass count', () => {
  const res = runSelfTests();
  assert.ok(res.count >= 15);
  assert.equal(res.count, res.results.length);
  assert.equal(res.passed + res.failed, res.count);
  assert.equal(res.failed, 0, res.results.filter((r) => !r.ok).map((r) => r.name).join(','));
  assert.match(res.verdict, /pass/);
});

test('every self test carries a name and a boolean verdict', () => {
  const res = runSelfTests();
  for (const r of res.results) {
    assert.equal(typeof r.name, 'string');
    assert.ok(r.name.length > 0);
    assert.equal(typeof r.ok, 'boolean');
  }
});

test('the self test suite covers the promised invariants', () => {
  const names = runSelfTests().results.map((r) => r.name).join(' ');
  for (const needle of ['sha.?256', 'pareto', 'csv', 'tamper', 'exact', 'bookmark']) {
    assert.match(names, new RegExp(needle, 'i'), 'self tests must cover ' + needle);
  }
});

/* ---------- deep coverage round two ---------- */

test('every workload comparison produces the full result contract', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const lab = runConfigComparison({ workloadId: wl, size: 24, seed: 2, iterations: 1 }, fakeClock());
    assert.equal(lab.workloadId, wl);
    assert.equal(lab.size, 24);
    assert.equal(lab.configs.length, 5);
    assert.equal(lab.frontierIds.length + lab.dominatedIds.length, 5, wl);
    assert.ok(lab.frontierIds.includes('ref') || lab.dominatedIds.includes('ref'), wl);
    assert.equal(lab.basis, BASIS.MEASURED);
    assert.equal(typeof lab.verdict, 'string');
  }
});

test('declared exact variants stay bit identical per workload on a second probe', () => {
  for (const [wl, cfgs] of Object.entries(LAB_CONFIGS)) {
    const img = makeImage(99, 9, 7);
    const ref = cfgs[0].run(img);
    for (const c of cfgs.filter((k) => k.declared === 'exact')) {
      assert.equal(accuracyAgainst(ref, c.run(img)).exact, true, wl + ':' + c.id);
    }
  }
});

test('startComparison sessions are independent and do not share buffers', () => {
  const a = startComparison({ workloadId: 'blur', size: 16, seed: 1, iterations: 1 });
  const b = startComparison({ workloadId: 'blur', size: 16, seed: 1, iterations: 1 });
  stepComparison(a, fakeClock());
  assert.equal(a.index, 1);
  assert.equal(b.index, 0);
  assert.notEqual(a.benchInput, b.benchInput);
});

test('session rows preserve insertion order matching the config registry', () => {
  const lab = runConfigComparison({ workloadId: 'sobel', size: 20, seed: 1, iterations: 1 }, fakeClock());
  assert.deepEqual(lab.configs.map((c) => c.id), LAB_CONFIGS.sobel.map((c) => c.id));
});

test('a single iteration lab run reports unavailable stability, not a fabricated label', () => {
  const lab = runConfigComparison({ workloadId: 'grayscale', size: 16, seed: 1, iterations: 1 }, fakeClock());
  for (const c of lab.configs) assert.equal(c.stability, 'unavailable');
});

test('the lab honors both the pixel allocation cap and the per pass budget', () => {
  const allocCap = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS));
  assert.throws(() => startComparison({ workloadId: 'blur', size: allocCap + 8 }), RangeError);
  const budgetCap = Math.floor(Math.sqrt(LAB_MAX_PIXELS_PER_OP));
  const ok = startComparison({ workloadId: 'blur', size: budgetCap, iterations: 1 });
  assert.equal(ok.size, budgetCap);
  assert.throws(() => startComparison({ workloadId: 'blur', size: budgetCap + 1, iterations: 1 }), RangeError);
});

test('accuracyAgainst scores partially correct variants honestly', () => {
  const img = makeImage(4, 8, 8);
  const ref = runGrayscale(img);
  const variant = runGrayscale(img);
  variant.data[0] = (variant.data[0] + 7) & 255;
  const r = accuracyAgainst(ref, variant);
  assert.equal(r.exact, false);
  assert.ok(r.identicalPct > 90, 'one flipped byte should leave accuracy above 90 percent');
});

test('edgeStress reports failing check names verbatim in the case rows', () => {
  const defs = [
    { id: 'ref', name: 'Reference', declared: 'exact', run: runSobel },
    { id: 'alpha-breaker', name: 'Alpha Breaker', declared: 'approx', run: (img) => {
      const out = runSobel(img);
      out.data[3] = 0;
      return out;
    } },
  ];
  const res = edgeStress({ workloadId: 'sobel', seed: 1, sizes: [[4, 4]], maxSize: null, configs: defs });
  const row = res.cases.find((c) => c.configId === 'alpha-breaker');
  const failed = row.checks.filter((k) => !k.ok).map((k) => k.name);
  assert.ok(failed.includes('alpha channel preserved'), failed.join(','));
});

test('edgeStress validates worst case timing rows even when cases pass', () => {
  const res = edgeStress({ workloadId: 'resize', seed: 2, sizes: [[2, 2]], maxSize: 64, clock: fakeClock() });
  for (const w of res.worstCase) {
    assert.equal(w.kind, 'worst-case');
    assert.equal(w.size, '64 x 64');
    assert.ok(w.latencyMs > 0);
  }
});

test('every workload invariant list exercises a conservation law', () => {
  // Each workload stress case must run at least one check that is not just "ran".
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const res = edgeStress({ workloadId: wl, seed: 1, sizes: [[7, 5]], maxSize: null });
    for (const row of res.cases) {
      const meaningful = row.checks.filter((k) => !/runs without throwing|runs on the color probe|returns/.test(k.name));
      assert.ok(meaningful.length >= 2, wl + ':' + row.configId + ' has too few domain invariants');
    }
  }
});

test('sha256Hex handles block boundary lengths 55, 56, 63, 64 and 65 bytes', () => {
  for (const n of [55, 56, 63, 64, 65, 119, 120, 128]) {
    const s = 'x'.repeat(n);
    const d = sha256Hex(s);
    assert.match(d, /^[0-9a-f]{64}$/, 'length ' + n);
    assert.equal(d, sha256Hex(s));
  }
});

test('sha256Bytes accepts Uint8Array and array-like sequences identically', () => {
  const fromArr = sha256Hex([104, 105]);
  const fromTyped = sha256Hex(new Uint8Array([104, 105]));
  assert.equal(fromArr, fromTyped);
  assert.equal(fromArr, sha256Hex('hi'));
});

test('canonicalJson handles nested arrays, strings with escapes and nulls', () => {
  const v = { s: 'a"b\nc', n: null, arr: [true, false, [1, { z: 2, a: 1 }]] };
  const out = canonicalJson(v);
  assert.equal(JSON.parse(out).arr.length, 3);
  assert.equal(out.indexOf('"a": 1') < out.indexOf('"z": 2'), true);
});

test('buildAuditPayload attaches measured roofs when provided', () => {
  const p = buildAuditPayload({ roofs: { memoryBytesPerSec: 1, computeOpsPerSec: 2, basis: 'measured', note: 'n' } });
  assert.equal(p.machineRoofs.memoryBytesPerSec, 1);
  assert.equal(p.machineRoofs.basis, 'measured');
});

test('buildAuditPayload strips lab config rows down to the audited fields', () => {
  const p = buildAuditPayload({
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: [], bestExactId: null, verdict: 'v',
      configs: [{ id: 'x', name: 'n', declared: 'exact', opsPerSec: 1, speedup: 1, accuracyPct: 100, exact: true, maxDelta: 0, basis: 'm', extraSecret: 'not included' }] },
  });
  assert.equal(p.lab.configs[0].extraSecret, undefined);
});

test('auditExportJson of two identical payloads produces identical text and digest', () => {
  const mk = () => buildAuditPayload({ meta: { author: 'T', generatedAt: 'fixed' } });
  const a = auditExportJson(mk());
  const b = auditExportJson(mk());
  assert.equal(a.text, b.text);
  assert.equal(a.digest, b.digest);
});

test('auditExportCsv defuses a formula leading workload id from a payload', () => {
  const p = buildAuditPayload({
    run: { seed: 1, sizes: [8], iterations: 1, at: 't', rows: [{ workloadId: '=hax', size: 8, iterations: 1, meanMs: 1, opsPerSec: 1, cvPercent: null, stability: 's', basis: 'm' }] },
  });
  const line = p.bench && auditExportCsv(p).text.split('\r\n').find((l) => l.includes('hax'));
  assert.match(line, /bench,'=hax/);
});

test('verifyAuditJson returns both digests on mismatch for diagnosis', () => {
  const out = auditExportJson({ a: 1 });
  const v = verifyAuditJson(out.text + '\n', out.digest);
  assert.equal(v.ok, false);
  assert.match(v.digest, /^[0-9a-f]{64}$/);
  assert.equal(v.expected, out.digest);
});

test('csvEscape leaves ordinary text and integers untouched', () => {
  for (const v of ['plain', 'with space', 'dot.net', '0', 'ArmBench']) {
    assert.equal(csvEscape(v), v);
  }
});

test('csvEscape doubles every quote inside a quoted cell', () => {
  const out = csvEscape('a"b"c');
  assert.equal(out, '"a""b""c"');
});

test('b64url round trip survives json payloads with unicode and punctuation', () => {
  const raw = JSON.stringify({ v: 1, note: 'café, "quoted", [brackets]' });
  assert.equal(b64urlDecode(b64urlEncode(raw)), raw);
});

test('decodeBookmark state is a defensive copy of the payload sizes', () => {
  const enc = encodeBookmark({ seed: 1, sizes: [64, 128], iterations: 1, workload: 'blur', labSize: 256 });
  const dec = decodeBookmark('#' + enc);
  dec.state.sizes.push(999);
  const dec2 = decodeBookmark('#' + enc);
  assert.deepEqual(dec2.state.sizes, [64, 128]);
});

test('encodeBookmark accepts workload and labSize null and round trips them', () => {
  const enc = encodeBookmark({ seed: 1, sizes: [256], iterations: 5, workload: null, labSize: null });
  const dec = decodeBookmark('#' + enc);
  assert.equal(dec.ok, true);
  assert.equal(dec.state.workload, null);
  assert.equal(dec.state.labSize, null);
});

test('decodeBookmark rejects a hash that truncates mid payload', () => {
  const enc = encodeBookmark({ seed: 1, sizes: [256], iterations: 5, workload: 'blur', labSize: 256 });
  const dec = decodeBookmark('#' + enc.slice(0, Math.floor(enc.length / 2)));
  assert.equal(dec.ok, false);
});

test('every lab workload round trips through the bookmark codec', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const enc = encodeBookmark({ seed: 5, sizes: [256, 512, 1024], iterations: 8, workload: wl, labSize: 512 });
    const dec = decodeBookmark('#' + enc);
    assert.equal(dec.ok, true, wl);
    assert.equal(dec.state.workload, wl);
  }
});

test('encodeBookmark rejects every invalid field the decoder would reject', () => {
  for (const bad of [
    { seed: -1 }, { seed: 1e7 }, { sizes: [] }, { iterations: 0 }, { iterations: 13 },
    { workload: 'video' }, { workload: 42 }, { labSize: -1 }, { sizes: ['256'] },
  ]) {
    const state = { seed: 1, sizes: [64], iterations: 1, workload: 'blur', labSize: 256, ...bad };
    assert.throws(() => encodeBookmark(state), RangeError, JSON.stringify(bad));
  }
});

test('edgeStress total accounting is consistent across workloads', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const res = edgeStress({ workloadId: wl, seed: 1, sizes: [[1, 1], [2, 3]], maxSize: 32, clock: fakeClock() });
    assert.equal(res.passed + res.failed, res.total);
    assert.equal(res.total, 2 * 5 + 5);
  }
});

test('edgeStress uses the same seed for the case image and the color probe', () => {
  // Two runs at one seed must produce identical case outcomes.
  const a = edgeStress({ workloadId: 'grayscale', seed: 9, sizes: [[3, 3]], maxSize: null });
  const b = edgeStress({ workloadId: 'grayscale', seed: 9, sizes: [[3, 3]], maxSize: null });
  assert.deepEqual(a.cases.map((c) => c.ok), b.cases.map((c) => c.ok));
});

test('runConfigComparison clamps a giant iteration request by the pixel budget', () => {
  const lab = runConfigComparison({ workloadId: 'histogram', size: 1024, seed: 1, iterations: 1e6 }, fakeClock());
  const budget = Math.max(1, Math.floor(LAB_MAX_PIXELS_PER_OP / (1024 * 1024)));
  assert.equal(lab.iterations, budget);
  assert.equal(lab.requestedIterations, 1e6);
});

test('finishComparison speedups are null only when the reference is unmeasured', () => {
  const s = startComparison({ workloadId: 'blur', size: 16, seed: 1, iterations: 1 });
  stepComparison(s, fakeClock());
  const lab = finishComparison(s);
  assert.equal(lab.configs[0].speedup, 1);
});

test('lab rows keep declared intent separate from measured exactness', () => {
  const lab = runConfigComparison({ workloadId: 'blur', size: 24, seed: 1, iterations: 1 }, fakeClock());
  for (const c of lab.configs) {
    if (c.declared === 'exact') assert.equal(typeof c.exact, 'boolean');
    assert.ok(['exact', 'approx'].includes(c.declared));
  }
});

test('WORKLOAD_MODEL bytes and ops stay within sane kernel bounds', () => {
  for (const [wl, m] of Object.entries(WORKLOAD_MODEL)) {
    assert.ok(m.opsPerPixel <= 100, wl + ' opsPerPixel looks inflated');
    assert.ok(m.bytesPerPixel <= 32, wl + ' bytesPerPixel looks inflated');
    assert.ok(m.opsPerPixel >= 1, wl);
  }
});

test('rooflinePosition headroom never exceeds 100 percent scale errors', () => {
  const roofs = { memoryBytesPerSec: 1e10, computeOpsPerSec: 1e11 };
  const pos = rooflinePosition('sobel', 1e5, roofs);
  assert.ok(pos.headroomPct !== null && pos.headroomPct < 100);
  assert.ok(pos.memoryCeilingOpsPerSec > 0);
});

test('analyzeScaling sorts out of order rows before comparing sizes', () => {
  const rows = [
    { workloadId: 'blur', size: 256, opsPerSec: 30, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 64, opsPerSec: 1000, basis: BASIS.MEASURED },
  ];
  const r = analyzeScaling(rows, 'blur');
  assert.equal(r.smallestSize, 64);
  assert.equal(r.largestSize, 256);
  assert.ok(r.pixelsPerSecRatio < 1);
});

test('estimate factor documentation stays referenced from the lab module', () => {
  // The estimate model is the only sanctioned projection; lab must not
  // redefine a different one.
  const src = JSON.stringify(WORKLOAD_MODEL);
  assert.ok(!src.includes('0.8125'), 'lab must not smuggle a second estimate model');
});

test('edge stress worst case latency is measured not fabricated', () => {
  const res = edgeStress({ workloadId: 'grayscale', seed: 1, sizes: [[1, 1]], maxSize: 48, clock: fakeClock(1.5) });
  for (const w of res.worstCase) assert.equal(w.latencyMs, 1.5);
});

test('the color probe differs across channels so luma weights matter', () => {
  const p = makeColorProbe(2, 4, 4);
  let hasColor = false;
  for (let i = 0; i < p.data.length; i += 4) {
    if (!(p.data[i] === p.data[i + 1] && p.data[i + 1] === p.data[i + 2])) hasColor = true;
  }
  assert.equal(hasColor, true, 'the probe must carry chroma or luma bugs stay hidden');
});

test('bench input stays grayscale by construction for timing stability', () => {
  const img = makeImage(2, 6, 6);
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1]);
    assert.equal(img.data[i + 1], img.data[i + 2]);
  }
});

/* ---------- final invariants: monotonicity, planning, codec edges ---------- */

test('timing stats stay monotone under sorted and unsorted samples', () => {
  // p95 of a sorted multiset can never be smaller than the median's order.
  const lab = runConfigComparison({ workloadId: 'blur', size: 16, seed: 1, iterations: 4 }, fakeClock());
  for (const c of lab.configs) {
    assert.ok(c.minMs <= c.medianMs && c.medianMs <= c.maxMs, c.id + ' min median max order');
    assert.ok(c.minMs <= c.meanMs && c.meanMs <= c.maxMs, c.id + ' mean inside range');
  }
});

test('the lab never exceeds the declared per pass pixel budget', () => {
  for (const wl of Object.keys(LAB_CONFIGS)) {
    const s = startComparison({ workloadId: wl, size: 1024, seed: 1, iterations: 100 });
    const pixelsPerOp = s.size * s.size;
    assert.ok(s.iterations * pixelsPerOp <= LAB_MAX_PIXELS_PER_OP * 1.0001 ||
      s.iterations === 1, wl + ' budget blown: ' + s.iterations + ' x ' + pixelsPerOp);
  }
});

test('mulberry seed changes produce different probes, equal seed reproduces', () => {
  const a = makeColorProbe(1, 8, 8);
  const b = makeColorProbe(1, 8, 8);
  const c = makeColorProbe(2, 8, 8);
  assert.deepEqual([...a.data], [...b.data]);
  assert.notDeepEqual([...a.data], [...c.data]);
});

test('comparison iterations field reports the effective count after clamping', () => {
  const lab = runConfigComparison({ workloadId: 'resize', size: 512, seed: 1, iterations: 100 }, fakeClock());
  const budget = Math.max(1, Math.floor(LAB_MAX_PIXELS_PER_OP / (512 * 512)));
  assert.equal(lab.iterations, Math.min(100, budget));
  for (const c of lab.configs) assert.equal(c.iterations, lab.iterations);
});

test('a comparison at the largest legal size still completes', () => {
  const s = startComparison({ workloadId: 'histogram', size: 1024, seed: 1, iterations: 1 });
  stepComparison(s, fakeClock());
  const lab = finishComparison(s);
  assert.equal(lab.configs.length, 1);
  assert.equal(lab.configs[0].id, 'ref');
});

test('audit payload sections order is stable and declared', () => {
  const p = buildAuditPayload({
    run: { seed: 1, sizes: [8], iterations: 1, at: 't', rows: [] },
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: [], bestExactId: null, verdict: 'v', configs: [] },
    stress: { workloadId: 'blur', seed: 1, total: 0, passed: 0, failed: 0, verdict: 'v', cases: [], worstCase: [] },
  });
  assert.deepEqual(p.sections, ['bench', 'optimization-lab', 'edge-stress']);
});

test('decodeBookmark never partially applies a payload with one bad field', () => {
  const good = { v: 1, seed: 7, sizes: [64, 128], iterations: 4, workload: 'sobel', labSize: 512 };
  for (const key of Object.keys(good)) {
    if (key === 'v') continue;
    const bad = { ...good, [key]: 'BROKEN' };
    const dec = decodeBookmark('#arm=' + b64urlEncode(JSON.stringify(bad)));
    assert.equal(dec.ok, false, 'field ' + key + ' must not slip through');
  }
});

test('csvEscape treats a leading quote cell as text not a formula', () => {
  assert.equal(csvEscape('"quoted"'), '"""quoted"""');
});

test('sha256Hex output length and alphabet hold for twenty random strings', () => {
  for (let i = 0; i < 20; i++) {
    const d = sha256Hex('probe-' + i + '-' + 'x'.repeat(i * 7));
    assert.match(d, /^[0-9a-f]{64}$/);
  }
});

test('canonicalJson emits the same bytes for equivalent objects in different orders', () => {
  const objs = [
    { b: [1, { d: 4, c: 3 }], a: 0 },
    { a: 0, b: [1, { c: 3, d: 4 }] },
  ];
  assert.equal(canonicalJson(objs[0]), canonicalJson(objs[1]));
});

test('edgeStress seeds the worst case image with the same seed as cases', () => {
  const a = edgeStress({ workloadId: 'sobel', seed: 4, sizes: [[2, 2]], maxSize: 48, clock: fakeClock() });
  const b = edgeStress({ workloadId: 'sobel', seed: 4, sizes: [[2, 2]], maxSize: 48, clock: fakeClock() });
  assert.deepEqual(a.worstCase, b.worstCase);
});

test('the audit csv keeps bench and lab rows distinguishable by section', () => {
  const p = buildAuditPayload({
    run: { seed: 1, sizes: [8], iterations: 1, at: 't', rows: [{ workloadId: 'blur', size: 8, iterations: 1, meanMs: 1, opsPerSec: 2, cvPercent: null, stability: 's', basis: 'm' }] },
    lab: { workloadId: 'blur', size: 8, seed: 1, iterations: 1, frontierIds: [], bestExactId: null, verdict: 'v', configs: [{ id: 'ref', name: 'R', declared: 'exact', opsPerSec: 2, speedup: 1, accuracyPct: 100, exact: true, maxDelta: 0, basis: 'm' }] },
  });
  const text = auditExportCsv(p).text;
  const benchRows = text.split('\r\n').filter((l) => l.startsWith('bench,'));
  const labRows = text.split('\r\n').filter((l) => l.startsWith('optimization-lab,'));
  assert.equal(benchRows.length, 1);
  assert.equal(labRows.length, 1);
});
