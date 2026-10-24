import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTIMATE_MODEL, estimateFactor, estimateFromLocal, estimateLatencyMs,
  BASIS, badgeFor, generateReport, executeStep, planRun,
} from '../js/armbench-core.js';

/* Estimate model ------------------------------------------------------- */

test('the estimate model is pure arithmetic on documented ratios', () => {
  const m = ESTIMATE_MODEL;
  assert.equal(m.clockRatio, 2.6 / 3.2);
  assert.equal(m.memRatio, 0.75);
  assert.equal(m.coreFactor, 1.0);
  assert.ok(Math.abs(estimateFactor() - 0.8125 * 0.75) < 1e-12);
});

test('estimateFromLocal scales throughput by the combined factor', () => {
  const e = estimateFromLocal(1000);
  assert.equal(e.opsPerSec, 1000 * 0.8125 * 0.75);
  assert.equal(e.factor, 0.8125 * 0.75);
});

test('estimateLatencyMs divides local latency by the combined factor', () => {
  const localMs = 10;
  const est = estimateLatencyMs(localMs);
  assert.ok(Math.abs(est - 10 / (0.8125 * 0.75)) < 1e-9);
  assert.ok(est > localMs, 'a slower projected core means longer latency');
});

test('every estimate carries isEstimate true and the estimate basis', () => {
  const e = estimateFromLocal(123);
  assert.equal(e.isEstimate, true);
  assert.equal(e.basis, BASIS.ESTIMATE);
  assert.ok(e.formula.includes('0.8125'));
  assert.ok(e.formula.includes('0.75'));
});

test('the model documents clock, memory and core count assumptions', () => {
  const names = ESTIMATE_MODEL.assumptions.map((a) => a.name);
  assert.ok(names.includes('Per Core Clock Scaling'));
  assert.ok(names.includes('Memory Bandwidth Heuristic'));
  assert.ok(names.includes('Core Count'));
  assert.ok(names.includes('Known Limits'));
  assert.ok(ESTIMATE_MODEL.assumptions.length >= 4);
  assert.ok(ESTIMATE_MODEL.target.includes('Graviton3'));
});

/* Badge and basis labeling ----------------------------------------------- */

test('badgeFor maps bases to human labels without conflating them', () => {
  assert.equal(badgeFor(BASIS.MEASURED), 'Measured');
  assert.equal(badgeFor(BASIS.ESTIMATE), 'Estimate');
  assert.equal(badgeFor('anything else'), 'Estimate');
});

test('measured and estimate bases are distinct constants', () => {
  assert.notEqual(BASIS.MEASURED, BASIS.ESTIMATE);
  assert.equal(BASIS.MEASURED, 'measured');
  assert.equal(BASIS.ESTIMATE, 'estimate');
});

/* Report generation -------------------------------------------------------- */

function sampleRows() {
  return planRun({ seed: 1337, sizes: [256], iterations: 5 })
    .map((s) => executeStep(s, () => 100))
    .map((r, i) => ({ ...r, meanMs: 10 + i, opsPerSec: 1000 - i * 10 }));
}

function sampleEnv() {
  return {
    declared: 'Apple Silicon Mac, Arm64, macOS (declared by the author)',
    runtime: 'Node 26.8.1, arm64, 8 logical cores',
  };
}

function sampleMeta() {
  return {
    author: 'Aariv Patel',
    generatedAt: '2026-10-24T12:00:00.000Z',
    seed: 1337,
    sizes: [256],
    iterations: 5,
  };
}

test('report states the author, seed and generated timestamp', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('Aariv Patel'));
  assert.ok(text.includes('1337'));
  assert.ok(text.includes('2026-10-24T12:00:00.000Z'));
});

test('report labels measured rows and never mixes them with estimates', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('| Measured'));
  assert.ok(text.includes('2. Local Results (measured)'));
  assert.ok(text.includes('3. Cloud Estimates (not measurements)'));
});

test('report contains the estimate model, assumptions and the honesty statement', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('0.8125'));
  assert.ok(text.includes('0.75'));
  assert.ok(text.includes('Per Core Clock Scaling'));
  assert.ok(text.includes('Memory Bandwidth Heuristic'));
  assert.ok(text.includes('AWS Graviton was not used'));
  assert.ok(text.includes('No estimate is presented as a measurement'));
});

test('report includes reproducible commands with the same seed and iterations', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('node scripts/run-bench.mjs --seed 1337 --iterations 5 --all-sizes'));
  assert.ok(text.includes('--json'));
  assert.ok(text.includes('python3 -m http.server 8000'));
});

test('report copy contains no em dashes and no en dashes', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(!text.includes('\u2014'), 'no em dash');
  assert.ok(!text.includes('\u2013'), 'no en dash');
});

test('report lists every workload label from the run', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('Video Pipeline (8 Frames, 640 by 360)'));
  assert.ok(text.includes('Edge Detection (Sobel Magnitude)'));
  assert.ok(text.includes('Histogram (256 Bins, Luma)'));
});

test('report declares the declared versus runtime host split honestly', () => {
  const text = generateReport(sampleRows(), sampleEnv(), sampleMeta());
  assert.ok(text.includes('Declared host: Apple Silicon Mac'));
  assert.ok(text.includes('Runtime reported: Node 26.8.1'));
});
