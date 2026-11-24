/* Regression tests for the November 2026 local engineering revamp.
 * Each test names the externally visible contract first; the implementation
 * is fixed only after the probe demonstrates the defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  LAB_MAX_PIXELS_PER_OP, startComparison, encodeBookmark, decodeBookmark,
  b64urlEncode, buildAuditPayload, auditExportCsv,
} from '../js/bench-lab.js';
import { MAX_STEP_ITERATIONS } from '../js/armbench-core.js';
import { boot } from './dom-harness.mjs';

test('the lab rejects a size whose single pass exceeds the pixel budget', () => {
  const size = Math.floor(Math.sqrt(LAB_MAX_PIXELS_PER_OP)) + 1;
  assert.ok(size * size > LAB_MAX_PIXELS_PER_OP, 'probe must exceed the budget');
  assert.throws(
    () => startComparison({ workloadId: 'histogram', size, seed: 1, iterations: 1 }),
    RangeError,
  );
});

test('the lab applies the same absolute iteration cap as planned bench steps', () => {
  const s = startComparison({
    workloadId: 'histogram', size: 1, seed: 1, iterations: MAX_STEP_ITERATIONS + 10,
  });
  assert.equal(s.iterations, MAX_STEP_ITERATIONS);
});

test('CLI --all-sizes overrides an earlier single size instead of being ignored', () => {
  const r = spawnSync(process.execPath,
    ['scripts/run-bench.mjs', '--size', '128', '--all-sizes', '--iterations', '1', '--json'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload.options.sizes, [256, 512, 1024]);
});

test('bookmark iteration validation matches the page control instead of clamping silently', () => {
  assert.throws(
    () => encodeBookmark({ seed: 1, sizes: [256], iterations: 9, workload: 'blur', labSize: 256 }),
    RangeError,
  );
  const raw = JSON.stringify({ v: 1, seed: 1, sizes: [256], iterations: 9, workload: 'blur', labSize: 256 });
  const dec = decodeBookmark('#arm=' + b64urlEncode(raw));
  assert.equal(dec.ok, false, 'a value the control cannot represent must be rejected');
});

test('stress, comparison and bench runs are mutually exclusive in both directions', async () => {
  const h = boot();
  assert.equal(h.errors.length, 0, h.errors.join('\n'));
  h.get('lab-workload').value = 'grayscale';
  h.get('stress-run-btn').click();
  h.get('run-btn').click();
  h.get('lab-run-btn').click();
  assert.match(h.get('bench-status').textContent, /Idle/, 'bench must not start during stress');
  assert.match(h.get('lab-status').textContent, /Idle/, 'comparison must not start during stress');
  await h.settle(800);
  assert.match(h.get('stress-status').textContent, /Stress complete|Stress failed/, 'stress probe should finish');
});

test('focusable chart bars expose their measurements to keyboard users', async () => {
  const h = boot();
  assert.equal(h.errors.length, 0, h.errors.join('\n'));
  h.get('lab-workload').value = 'grayscale';
  h.get('lab-size').value = '64';
  h.get('lab-iters').value = '1';
  h.get('lab-run-btn').click();
  await h.settle(600);
  const bar = [...h.get('lab-chart').children].find((c) => c.classList.contains('bar'));
  assert.ok(bar, 'expected a chart bar');
  bar.dispatch('focus');
  assert.match(h.get('lab-chart-note').textContent, /ops\/sec measured/);
  bar.dispatch('blur');
  assert.match(h.get('lab-chart-note').textContent, /Hover or focus a bar/);
});

test('the audit csv includes every edge stress row carried by the payload', () => {
  const payload = buildAuditPayload({
    stress: {
      workloadId: 'blur', seed: 1, total: 2, passed: 1, failed: 1, verdict: 'probe verdict',
      cases: [{
        size: '1 x 1', configId: 'ref', ok: false,
        checks: [
          { name: 'runs without throwing', ok: false },
          { name: 'alpha channel preserved', ok: true },
        ],
      }],
      worstCase: [{ configId: 'ref', configName: 'Reference', size: '1024 x 1024', latencyMs: 2.5, ok: true }],
    },
  });
  const text = auditExportCsv(payload).text;
  const stressRows = text.split('\r\n').filter((line) => line.startsWith('edge-stress,'));
  assert.equal(stressRows.length, 2, 'one case row plus one worst case row');
  assert.ok(text.includes('runs without throwing'), 'failed check detail must survive export');
});
