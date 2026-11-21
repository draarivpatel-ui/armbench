/**
 * ArmBench telemetry, projection, scaling and report invariants.
 * Every statistic here is checked against an independently computed value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timingStats, runTelemetry, projectPixelScaling, speedupBetween,
  timeWorkload, executeStep, planRun, generateReport, BASIS,
  makeImage, runGrayscale, runBoxBlur, runSobel, runHistogram, runResize,
} from '../js/armbench-core.js';

function fakeClock(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

/* ---------- timingStats: exact population statistics ---------- */

test('timingStats computes exact population deviation for a known sample set', () => {
  const s = timingStats([2, 4, 4, 4, 5, 5, 7, 9], 5);
  assert.equal(s.stdDevMs, 2);          // sqrt(32/8)
  assert.equal(s.cvPercent, 40);        // 2/5 x 100
  assert.equal(s.p95Ms, 9);             // nearest rank ceil(0.95 x 8) = 8
  assert.equal(s.trimmedMeanMs, 29 / 6);  // drop 2 and 9 from sum 40, over 6
  assert.equal(s.stability, 'noisy');
});

test('timingStats marks a flat pass stable with zero dispersion', () => {
  const s = timingStats([3, 3, 3, 3], 3);
  assert.equal(s.stdDevMs, 0);
  assert.equal(s.cvPercent, 0);
  assert.equal(s.p95Ms, 3);
  assert.equal(s.trimmedMeanMs, 3);
  assert.equal(s.stability, 'stable');
});

test('timingStats bands use the ten and twenty five percent boundaries', () => {
  assert.equal(timingStats([9, 11], 10).stability, 'stable');    // cv exactly 10
  assert.equal(timingStats([8, 12], 10).stability, 'variable');  // cv 20
  assert.equal(timingStats([7.5, 12.5], 10).stability, 'variable'); // cv 25
  assert.equal(timingStats([7, 13], 10).stability, 'noisy');     // cv 30
  assert.equal(timingStats([10, 10], 10).stability, 'stable');   // cv 0
});

test('timingStats handles one and two samples without dividing by zero', () => {
  const one = timingStats([4], 4);
  assert.equal(one.stdDevMs, 0);
  assert.equal(one.trimmedMeanMs, 4);
  const two = timingStats([2, 6], 4);
  assert.equal(two.stdDevMs, 2);
  assert.equal(two.trimmedMeanMs, 4, 'two samples fall back to the mean');
});

test('timingStats returns safe nulls for an empty or zero mean pass', () => {
  const empty = timingStats([], 0);
  assert.equal(empty.count, undefined);
  assert.equal(empty.stdDevMs, null);
  assert.equal(empty.cvPercent, null);
  assert.equal(empty.stability, 'no samples');
  const zero = timingStats([0, 0], 0);
  assert.equal(zero.cvPercent, null);
  assert.equal(zero.stability, 'unavailable');
  assert.equal(zero.trimmedMeanMs, 0);
});

test('timingStats derives its own mean when the caller omits it', () => {
  assert.equal(timingStats([1, 3]).meanIfExposed, undefined);
  const s = timingStats([1, 3]);
  assert.equal(s.stdDevMs, 1);
  assert.equal(s.cvPercent, 50);
});

test('timingStats rejects a non array input', () => {
  assert.throws(() => timingStats('not an array', 1), TypeError);
  assert.throws(() => timingStats(null, 1), TypeError);
});

test('timingStats p95 uses nearest rank on odd and even lengths', () => {
  assert.equal(timingStats([1, 2, 3, 4, 5], 3).p95Ms, 5);
  assert.equal(timingStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5.5).p95Ms, 10);
  assert.equal(timingStats([1, 2, 3], 2).p95Ms, 3);
});

/* ---------- timeWorkload carries telemetry from the same samples ---------- */

test('timeWorkload attaches all five dispersion fields from its own samples', () => {
  const t = timeWorkload(() => 1, null, 4, fakeClock([0, 2, 2, 6, 6, 12, 12, 20]));
  assert.deepEqual(t.samples, [2, 4, 6, 8]);
  assert.equal(t.stdDevMs, Math.sqrt(5));
  assert.equal(t.p95Ms, 8);
  assert.equal(t.trimmedMeanMs, 5);
  assert.equal(t.cvPercent, (Math.sqrt(5) / 5) * 100);
  assert.ok(['stable', 'variable', 'noisy'].includes(t.stability));
});

test('timeWorkload validates its clock argument before running', () => {
  assert.throws(() => timeWorkload(() => 1, null, 1, 42), TypeError);
  assert.throws(() => timeWorkload(() => 1, null, 1, null), TypeError);
});

test('timeWorkload keeps the original sample order while sorting for percentiles', () => {
  const t = timeWorkload(() => 1, null, 3, fakeClock([0, 9, 10, 11, 20, 25, 26]));
  assert.deepEqual(t.samples, [9, 1, 5]);
  assert.equal(t.p95Ms, 9);
  assert.equal(t.trimmedMeanMs, 5);
});

/* ---------- runTelemetry ---------- */

test('runTelemetry only summarizes measured rows with finite dispersion', () => {
  const rows = [
    { basis: BASIS.MEASURED, cvPercent: 4 },
    { basis: BASIS.MEASURED, cvPercent: 8 },
    { basis: BASIS.ESTIMATE, cvPercent: 900 },
    { basis: BASIS.MEASURED, cvPercent: null },
    { basis: BASIS.MEASURED, cvPercent: Number.NaN },
  ];
  const t = runTelemetry(rows);
  assert.equal(t.count, 2);
  assert.equal(t.meanCvPercent, 6);
  assert.equal(t.worstCvPercent, 8);
  assert.equal(t.verdict, 'steady');
});

test('runTelemetry escalates the verdict on the worst row, not the mean', () => {
  const steady = [{ basis: BASIS.MEASURED, cvPercent: 1 }, { basis: BASIS.MEASURED, cvPercent: 2 }];
  assert.equal(runTelemetry(steady).verdict, 'steady');
  assert.equal(runTelemetry([...steady, { basis: BASIS.MEASURED, cvPercent: 12 }]).verdict, 'some variance');
  assert.equal(runTelemetry([...steady, { basis: BASIS.MEASURED, cvPercent: 30 }]).verdict, 'noisy run, rerun recommended');
});

test('runTelemetry is safe for empty and non measured input', () => {
  const e = runTelemetry([]);
  assert.equal(e.count, 0);
  assert.equal(e.meanCvPercent, null);
  assert.equal(e.verdict, 'no dispersion data');
  assert.equal(runTelemetry([{ basis: 'estimate', cvPercent: 3 }]).count, 0);
});

test('runTelemetry of a real tiny run reports a finite worst dispersion', () => {
  const rows = planRun({ seed: 5, sizes: [32], iterations: 2 }).map((s) => executeStep(s));
  const t = runTelemetry(rows);
  assert.equal(t.count, rows.length);
  assert.ok(Number.isFinite(t.meanCvPercent));
  assert.ok(Number.isFinite(t.worstCvPercent));
  assert.ok(t.worstCvPercent >= 0);
});

/* ---------- projectPixelScaling ---------- */

test('projectPixelScaling uses the inverse square pixel ratio and stays a projection', () => {
  const p = projectPixelScaling(1000, 256, 512);
  assert.equal(p.ratio, 0.25);
  assert.equal(p.opsPerSec, 250);
  assert.equal(p.isProjection, true);
  assert.equal(p.basis, 'projection');
  assert.match(p.note, /Not a measurement/);
});

test('projectPixelScaling is exact for doubling and tripling', () => {
  assert.equal(projectPixelScaling(900, 100, 200).opsPerSec, 225);
  assert.equal(projectPixelScaling(900, 100, 300).opsPerSec, 100);
  assert.equal(projectPixelScaling(50, 512, 256).opsPerSec, 200);
});

test('projectPixelScaling rejects invalid sizes and non finite throughput', () => {
  assert.throws(() => projectPixelScaling(1, 0, 256), RangeError);
  assert.throws(() => projectPixelScaling(1, 256, -1), RangeError);
  assert.throws(() => projectPixelScaling(1, 256.5, 512), RangeError);
  assert.throws(() => projectPixelScaling(Number.NaN, 256, 512), RangeError);
  assert.throws(() => projectPixelScaling(-5, 256, 512), RangeError);
});

test('projectPixelScaling at equal sizes is an identity with a projection flag', () => {
  const p = projectPixelScaling(432.5, 256, 256);
  assert.equal(p.ratio, 1);
  assert.equal(p.opsPerSec, 432.5);
  assert.equal(p.isProjection, true);
});

/* ---------- speedupBetween ---------- */

const rowSet = (id, pairs) => pairs.map(([size, ops]) => ({ workloadId: id, size, opsPerSec: ops, basis: BASIS.MEASURED }));

test('speedupBetween divides two measured rows of the same workload', () => {
  const rows = rowSet('blur', [[256, 1200], [512, 300]]);
  const s = speedupBetween(rows, 'blur', 256, 512);
  assert.equal(s.ratio, 4);
  assert.equal(s.opsA, 1200);
  assert.equal(s.opsB, 300);
  assert.equal(s.basis, 'measured');
});

test('speedupBetween returns null when a size, workload or reading is missing', () => {
  const rows = rowSet('blur', [[256, 1200], [512, 300]]);
  assert.equal(speedupBetween(rows, 'blur', 256, 1024), null);
  assert.equal(speedupBetween(rows, 'sobel', 256, 512), null);
  assert.equal(speedupBetween([{ ...rows[0], opsPerSec: null }, rows[1]], 'blur', 256, 512), null);
});

test('speedupBetween never divides by zero', () => {
  const rows = rowSet('blur', [[256, 1200], [512, 0]]);
  assert.equal(speedupBetween(rows, 'blur', 256, 512), null);
});

test('speedupBetween ignores a same workload row at a different size', () => {
  const rows = rowSet('blur', [[128, 4800], [256, 1200], [512, 300]]);
  assert.equal(speedupBetween(rows, 'blur', 256, 512).ratio, 4);
  assert.equal(speedupBetween(rows, 'blur', 128, 512).ratio, 16);
});

/* ---------- report invariants and regressions ---------- */

function reportFor(overrides = {}) {
  const rows = planRun({ seed: 11, sizes: [256], iterations: 3 })
    .map((s) => executeStep(s, () => 100))
    .map((r, i) => ({ ...r, meanMs: 4 + i, opsPerSec: 900 - i * 50, ...overrides }));
  return generateReport(rows, { declared: 'declared host', runtime: 'runtime host' },
    { author: 'Aariv Patel', generatedAt: '2026-11-15T00:00:00.000Z', seed: 11, sizes: [256], iterations: 3 });
}

test('the report now includes a measured dispersion section with a verdict', () => {
  const text = reportFor();
  assert.match(text, /2b\. Timing Dispersion \(measured\)/);
  assert.match(text, /Rows summarized: 0/, 'a constant clock has no measurable dispersion');
  assert.match(text, /Verdict: no dispersion data/);
  assert.match(text, /trimmed mean/);

  const realRows = planRun({ seed: 11, sizes: [32], iterations: 3 }).map((s) => executeStep(s));
  const realText = generateReport(realRows, { declared: 'declared host', runtime: 'runtime host' },
    { author: 'Aariv Patel', generatedAt: '2026-11-15T00:00:00.000Z', seed: 11, sizes: [32], iterations: 3 });
  assert.match(realText, /Rows summarized: 6/);
  assert.match(realText, /Verdict: (steady|some variance|noisy run, rerun recommended)/);
});

test('the report keeps measured and estimated sections strictly separated', () => {
  const text = reportFor();
  const measuredAt = text.indexOf('2. Local Results (measured)');
  const dispersionAt = text.indexOf('2b. Timing Dispersion (measured)');
  const estimatesAt = text.indexOf('3. Cloud Estimates (not measurements)');
  assert.ok(measuredAt < dispersionAt && dispersionAt < estimatesAt);
  assert.match(text, /No estimate is presented as a measurement/);
});

test('the report survives rows with no dispersion data', () => {
  const text = reportFor({ stdDevMs: null, cvPercent: null, p95Ms: null, trimmedMeanMs: null });
  assert.match(text, /Rows summarized: 0/);
  assert.match(text, /n\/a/);
  assert.match(text, /no dispersion data/);
});

test('the report copy contains neither dash character', () => {
  const text = reportFor();
  assert.ok(!text.includes('\u2014'));
  assert.ok(!text.includes('\u2013'));
});

/* ---------- regression: kernels still satisfy their documented invariants ---------- */

test('regression: a uniform image is unchanged by grayscale, blur and Sobel', () => {
  const img = makeImage(9, 12, 12);
  const data = new Uint8ClampedArray(12 * 12 * 4).fill(200);
  const uniform = { width: 12, height: 12, data };
  const gray = runGrayscale(uniform);
  const blur = runBoxBlur(uniform);
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(gray.data[i], 200);
    assert.equal(gray.data[i + 3], 200);
    assert.equal(blur.data[i], 200);
  }
  const sobel = runSobel(uniform);
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(sobel.data[i], 0, 'a flat field has no gradient');
  }
});

test('regression: histogram counts always sum to width times height', () => {
  for (const [w, h, seed] of [[1, 1, 0], [3, 7, 42], [16, 9, 999]]) {
    const hist = runHistogram(makeImage(seed, w, h));
    assert.equal(hist.count, w * h);
    assert.equal(hist.bins.reduce((a, b) => a + b, 0), w * h);
  }
});

test('regression: resize output dimensions are floor half with a one pixel floor', () => {
  for (const [w, h, ew, eh] of [[2, 2, 1, 1], [5, 5, 2, 2], [1, 1, 1, 1], [8, 6, 4, 3]]) {
    const out = runResize(makeImage(7, w, h));
    assert.equal(out.width, ew);
    assert.equal(out.height, eh);
    assert.equal(out.data.length, ew * eh * 4);
  }
});

test('regression: alpha is preserved through every pixel kernel', () => {
  const img = makeImage(3, 8, 8);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 137;
  for (const fn of [runGrayscale, runBoxBlur, runSobel, runResize]) {
    const out = fn(img);
    for (let i = 3; i < out.data.length; i += 4) {
      assert.equal(out.data[i], 137, fn.name + ' changed alpha');
    }
  }
});
