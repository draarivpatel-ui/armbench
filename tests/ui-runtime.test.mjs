/**
 * ArmBench browser runtime tests. Boots the real js/app.js against a stubbed
 * DOM parsed from the shipped index.html, then drives a live bench run and
 * asserts the rendered tables, telemetry, chart, report and keyboard flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './dom-harness.mjs';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

function fresh() {
  const h = boot();
  assert.deepEqual(h.errors, [], 'the app must boot with no runtime errors: ' + h.errors.join('\n'));
  return h;
}

/* ---------- markup and accessibility contracts ---------- */

test('the shipped page has one h1, semantic landmarks and a skip link target', () => {
  assert.equal((html.match(/<h1\b/gi) || []).length, 1);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<nav class="panel-nav" aria-label="Panel Navigation">/);
  assert.match(html, /<footer class="footer">/);
});

test('every aria-labelledby and label for in the page resolves to a real id', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\baria-labelledby="([^"]+)"/g)) {
    for (const ref of m[1].trim().split(/\s+/)) assert.ok(ids.has(ref), 'missing #' + ref);
  }
  for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) {
    assert.ok(ids.has(m[1]), 'label for missing #' + m[1]);
  }
});

test('all getElementById bindings in the app exist in the markup', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const bound = [...appJs.matchAll(/\$\(\s*'#([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(bound.length >= 30);
  assert.equal(new Set(bound).size, bound.length, 'no duplicate DOM bindings');
  for (const id of bound) assert.ok(ids.has(id), 'app binds missing #' + id);
});

test('the five panels are numbered in order and each has a heading', () => {
  const panels = [...html.matchAll(/<section class="panel" id="([^"]+)" aria-labelledby="([^"]+)">/g)];
  assert.deepEqual(panels.map((m) => m[1]), ['bench', 'compare', 'telemetry', 'environment', 'report']);
  for (const m of panels) {
    assert.ok(html.includes('id="' + m[2] + '"'), 'heading missing for ' + m[1]);
  }
});

test('the shortcuts dialog is labelled, closable and lists all six shortcuts', () => {
  assert.match(html, /<dialog id="shortcuts-dialog" aria-labelledby="shortcuts-title">/);
  assert.match(html, /<h2 id="shortcuts-title">Keyboard Shortcuts<\/h2>/);
  assert.match(html, /<button type="button" id="shortcuts-close"/);
  for (const key of ['R', 'E', 'G', 'C', '?', 'Esc']) {
    assert.ok(html.includes('<kbd>' + key + '</kbd>'), 'missing shortcut ' + key);
  }
});

test('the telemetry panel ships its four stability readouts and three tables', () => {
  for (const id of ['tm-count', 'tm-mean-cv', 'tm-worst-cv', 'tm-verdict',
    'telemetry-body', 'scaling-body', 'scaling-workload']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
  }
  assert.match(html, /<th scope="col" class="num">Cv Percent<\/th>/);
  assert.match(html, /<th scope="col" class="num">Trimmed Mean Ms<\/th>/);
});

test('wide tables are inside focusable labelled scroll regions', () => {
  const regions = [...html.matchAll(/role="region" aria-label="([^"]+)" tabindex="0"/g)];
  assert.ok(regions.length >= 4, 'found ' + regions.length + ' regions');
  assert.ok(regions.some((m) => m[1] === 'Per Row Dispersion Table'));
  assert.ok(regions.some((m) => m[1] === 'Measured Scaling Table'));
});

test('the stylesheet keeps focus visible, reduced motion, overflow guard and new badges', () => {
  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /\.badge--variable\s*\{/);
  assert.match(css, /\.badge--noisy\s*\{/);
  assert.match(css, /#shortcuts-dialog::backdrop/);
  assert.match(css, /\.telemetry-grid\s*\{/);
});

/* ---------- live runtime ---------- */

test('the app boots with an idle status, enabled run and disabled report controls', () => {
  const h = fresh();
  assert.equal(h.get('ro-state').textContent, 'Ready');
  assert.equal(h.get('run-btn').textContent, 'Run Bench');
  assert.equal(h.get('run-btn').disabled, false);
  assert.equal(h.get('cancel-btn').disabled, true);
  assert.equal(h.get('gen-report-btn').disabled, true);
  assert.equal(h.get('download-report-btn').disabled, true);
  assert.equal(h.get('copy-report-btn').disabled, true);
  assert.match(h.get('bench-status').textContent, /Idle/);
  assert.ok(h.get('assumptions-list').children.length >= 4);
  assert.match(h.get('formula-line').textContent, /0\.8125/);
});

test('the seeded preview re-renders and clamps an out of range seed', () => {
  const h = fresh();
  h.get('seed-input').value = '999999999';
  h.get('seed-input').dispatch('change');
  assert.equal(h.get('ro-seed').textContent, '999999');
  h.get('seed-input').value = '-4';
  h.get('seed-input').dispatch('change');
  assert.equal(h.get('ro-seed').textContent, '0');
});

test('a live run fills results, comparison, telemetry, scaling and enables the report', async () => {
  const h = fresh();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '2';
  h.get('run-btn').click();
  await h.settle(400);

  assert.equal(h.get('run-btn').disabled, false, 'controls re-enabled after the run');
  assert.equal(h.get('cancel-btn').disabled, true);
  assert.equal(h.get('ro-state').textContent, 'Ready');
  assert.match(h.get('bench-status').textContent, /Run complete: 6 measured readings/);
  assert.equal(h.get('queue-list').children.length, 6);
  assert.equal(h.get('results-body').children.length, 6);
  assert.equal(h.get('compare-body').children.length, 6, 'five kernels at the largest size plus the video row');
  assert.equal(h.get('telemetry-body').children.length, 6);
  assert.equal(h.get('scaling-body').children.length, 1, 'a single size run honestly shows one explanatory row');
  assert.equal(h.get('gen-report-btn').disabled, false);
  assert.equal(h.get('download-report-btn').disabled, false);
  assert.match(h.get('tm-count').textContent, /^6$/);
  assert.match(h.get('tm-verdict').textContent, /steady|some variance|noisy|no dispersion data/);
  assert.match(h.get('chart-canvas').getAttribute('aria-label'), /measured local throughput with estimated/);
});

test('every rendered results row carries a Measured badge and estimate cells carry Estimate', async () => {
  const h = fresh();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  for (const tr of h.get('results-body').children) {
    assert.equal(tr.querySelectorAll('.badge--measured').length, 1);
    assert.equal(tr.querySelector('.badge--measured').textContent, 'Measured');
  }
  for (const tr of h.get('compare-body').children) {
    assert.equal(tr.querySelectorAll('.badge--estimate').length, 1);
    assert.equal(tr.querySelector('.badge--estimate').textContent, 'Estimate');
  }
});

test('the scaling selector re-renders from measured rows for every workload', async () => {
  const h = fresh();
  h.get('size-select').value = 'all';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(600);
  for (const id of ['resize', 'grayscale', 'blur', 'sobel', 'histogram']) {
    h.get('scaling-workload').value = id;
    h.get('scaling-workload').dispatch('change');
    assert.equal(h.get('scaling-body').children.length, 3);
    for (const tr of h.get('scaling-body').children) {
      assert.equal(tr.children.length, 4);
      assert.ok(!tr.children[3].textContent.includes('not run'), id + ' must have measured pairs');
    }
  }
});

test('a single size run honestly reports not run for absent scaling pairs', async () => {
  const h = fresh();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  assert.equal(h.get('scaling-body').children.length, 1);
  assert.match(h.get('scaling-body').textContent, /not measured at two comparable sizes/);
});

test('generate report fills the text area with dispersion and the honesty statement', async () => {
  const h = fresh();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  h.get('gen-report-btn').click();
  const text = h.get('report-output').value;
  assert.match(text, /ArmBench Methodology And Results/);
  assert.match(text, /2b\. Timing Dispersion/);
  assert.match(text, /AWS Graviton was not used/);
  assert.match(text, /No estimate is presented as a measurement/);
  assert.equal(h.get('copy-report-btn').disabled, false);
  assert.equal(h.get('copied-note').textContent, 'Report Ready');
});

test('keyboard shortcuts open the dialog, run the bench and ignore focused fields', async () => {
  const h = fresh();
  h.globalKey('?');
  assert.equal(h.get('shortcuts-dialog').open, true);
  h.get('shortcuts-close').click();
  assert.equal(h.get('shortcuts-dialog').open, false);

  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.globalKey('r');
  await h.settle(600);
  assert.match(h.get('bench-status').textContent, /Run complete/);

  const before = h.get('results-body').children.length;
  h.key('seed-input', 'r');
  assert.equal(h.get('results-body').children.length, before, 'typing in a field must not start a run');
  h.key('run-btn', 'r');
  assert.equal(h.get('results-body').children.length, before, 'focused buttons must not start a run');
});

test('the Generate and Download shortcuts require a completed run', async () => {
  const h = fresh();
  h.globalKey('g');
  h.globalKey('e');
  assert.match(h.get('report-output').value, /No report yet/);
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  h.globalKey('g');
  assert.match(h.get('report-output').value, /ArmBench Methodology/);
  h.globalKey('e');
  assert.equal(h.get('copied-note').textContent, 'Report Downloaded');
});

test('cancel between steps prevents a partial report and re-enables controls', async () => {
  const h = fresh();
  h.get('size-select').value = 'all';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  h.get('cancel-btn').click();
  await h.settle(200);
  assert.equal(h.get('run-btn').disabled, false);
  assert.equal(h.get('cancel-btn').disabled, true);
  assert.match(h.get('bench-status').textContent, /Run cancelled/);
  assert.equal(h.get('gen-report-btn').disabled, true);
  assert.match(h.get('report-output').value, /No report yet/);
});

test('the copy shortcut reports its result through the polite live region', async () => {
  const h = fresh();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  h.globalKey('g');
  h.globalKey('c');
  await h.settle(10);
  assert.match(h.get('copied-note').textContent, /Copied|Selected/);
});

test('shipped copy contains no dashes and no restricted disclosure wording', () => {
  for (const text of [html, css, appJs, fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')]) {
    assert.ok(!text.includes('\u2014'), 'no em dash');
    assert.ok(!text.includes('\u2013'), 'no en dash');
  }
  assert.ok(!/\bA\u0049\b|\bL\u004cM\b|language\u0020model/i.test(html + appJs));
});
