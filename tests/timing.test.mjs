import test from 'node:test';
import assert from 'node:assert/strict';
import { timeWorkload, planRun, executeStep, workloadById } from '../js/armbench-core.js';

/** Fake clock: pops preset values so every sample is exact. */
function fakeClock(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

test('timeWorkload collects exactly the requested number of samples', () => {
  const t = timeWorkload(() => 1, null, 3, fakeClock([10, 13, 13, 18, 18, 25]));
  assert.equal(t.samples.length, 3);
  assert.equal(t.iterations, 3);
});

test('timeWorkload computes exact stats from a controlled clock', () => {
  const t = timeWorkload(() => 1, null, 3, fakeClock([10, 13, 13, 18, 18, 25]));
  assert.equal(t.totalMs, 15);
  assert.equal(t.meanMs, 5);
  assert.equal(t.minMs, 3);
  assert.equal(t.maxMs, 7);
  assert.equal(t.medianMs, 5);
  assert.equal(t.opsPerSec, 200); // 3 ops in 15 ms
});

test('timeWorkload computes the median of an even sample count', () => {
  // pops produce samples 2, 4, 6, 8, so the median is 5 and the mean is 5
  const t = timeWorkload(() => 1, null, 4, fakeClock([0, 2, 2, 6, 6, 12, 12, 20]));
  assert.equal(t.medianMs, 5);
  assert.equal(t.meanMs, 5);
});

test('timeWorkload never counts the warmup call', () => {
  let calls = 0;
  const t = timeWorkload(() => { calls++; }, null, 4, fakeClock([0, 1, 1, 2, 2, 3, 3, 4]));
  assert.equal(calls, 5, 'one warmup plus four timed calls');
  assert.equal(t.samples.length, 4);
  assert.equal(t.totalMs, 4);
});

test('timeWorkload is deterministic given the same clock and input', () => {
  const run = (img) => img.width + img.height;
  const input = { width: 4, height: 4 };
  const a = timeWorkload(run, input, 3, fakeClock([0, 5, 5, 12, 12, 20]));
  const b = timeWorkload(run, input, 3, fakeClock([0, 5, 5, 12, 12, 20]));
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('timeWorkload rejects a non positive iteration count', () => {
  assert.throws(() => timeWorkload(() => 1, null, 0, fakeClock([0, 1])));
  assert.throws(() => timeWorkload(() => 1, null, 1.5, fakeClock([0, 1])));
});

test('timeWorkload returns null ops per second when the clock never advances', () => {
  const t = timeWorkload(() => 1, null, 2, fakeClock([7, 7, 7, 7, 7]));
  assert.equal(t.opsPerSec, null);
});

/* Plan and execute --------------------------------------------------------- */

test('planRun emits one step per workload per size plus the video step', () => {
  const steps = planRun({ seed: 5, sizes: [64, 128], iterations: 3 });
  assert.equal(steps.length, 5 * 2 + 1);
  const video = steps[steps.length - 1];
  assert.equal(video.workloadId, 'video');
  assert.equal(video.iterations, 3);
  assert.ok(steps.every((s) => s.seed === 5));
});

test('planRun clamps iterations to the pixel budget for large sizes', () => {
  // 12,000,000 / (1024 * 1024) = 11, so an iteration count of 50 clamps to 11
  const steps = planRun({ seed: 5, sizes: [1024], iterations: 50 });
  const sobel = steps.find((s) => s.workloadId === 'sobel');
  assert.equal(sobel.iterations, 11);
  // 12,000,000 / (256 * 256) = 45, well above the requested 5
  const small = planRun({ seed: 5, sizes: [256], iterations: 5 });
  assert.equal(small.find((s) => s.workloadId === 'sobel').iterations, 5);
});

test('executeStep returns a measured row with finite numbers on a real run', () => {
  const steps = planRun({ seed: 77, sizes: [32], iterations: 2 });
  const row = executeStep(steps.find((s) => s.workloadId === 'grayscale'));
  assert.equal(row.workloadId, 'grayscale');
  assert.equal(row.size, 32);
  assert.equal(row.basis, 'measured');
  assert.ok(Number.isFinite(row.meanMs) && row.meanMs >= 0);
  assert.ok(Number.isFinite(row.medianMs));
  assert.ok(row.opsPerSec === null || (Number.isFinite(row.opsPerSec) && row.opsPerSec > 0));
  assert.equal(row.label, workloadById('grayscale').label);
});

test('executeStep runs the video pipeline row with its fixed frame config', () => {
  const steps = planRun({ seed: 9, sizes: [32], iterations: 1 });
  const row = executeStep(steps[steps.length - 1]);
  assert.equal(row.workloadId, 'video');
  assert.equal(row.unit, 'pipelines/sec');
  assert.equal(row.size, '640 x 360, 8 frames');
  assert.ok(Number.isFinite(row.meanMs) && row.meanMs >= 0);
});

test('a full planned run over tiny sizes completes quickly with measured rows', () => {
  const started = Date.now();
  const rows = planRun({ seed: 3, sizes: [48], iterations: 2 }).map((s) => executeStep(s));
  const elapsed = Date.now() - started;
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.basis === 'measured'));
  assert.ok(elapsed < 10_000, 'tiny suite finishes well under ten seconds');
});
