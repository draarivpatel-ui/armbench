/* ArmBench Optimization Lab and Audit panels: live harness tests.
 * Boots the real app code in the zero dependency DOM harness and drives the
 * new controls the way the page does. No browser, no network, no deps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './dom-harness.mjs';
import { encodeBookmark, runSelfTests } from '../js/bench-lab.js';

function bootSmall() {
  const h = boot();
  assert.equal(h.errors.length, 0, 'boot errors: ' + h.errors.join('\n'));
  return h;
}

function labDefaults(h) {
  h.get('lab-workload').value = 'grayscale';
  h.get('lab-size').value = '64';
  h.get('lab-iters').value = '1';
}

/* ---------- boot and defaults ---------- */

test('the app boots with the lab and audit controls present', () => {
  const h = bootSmall();
  for (const id of ['lab-workload', 'lab-size', 'lab-iters', 'lab-run-btn', 'lab-status',
    'lab-config-body', 'lab-frontier-note', 'lab-chart', 'lab-chart-note',
    'roof-intensity', 'roof-mem', 'roof-compute', 'roof-ceiling', 'roof-headroom', 'roof-bounded',
    'lab-bottleneck', 'stress-run-btn', 'stress-status', 'stress-body',
    'audit-json-btn', 'audit-csv-btn', 'audit-md-btn', 'audit-verify-btn', 'audit-digest', 'audit-note',
    'bookmark-link', 'bookmark-copy-btn', 'bookmark-note',
    'selftest-run-btn', 'selftest-summary', 'selftest-body']) {
    assert.ok(h.get(id), 'missing #' + id);
  }
});

test('audit export buttons ship disabled until real evidence exists', () => {
  const h = bootSmall();
  assert.equal(h.get('audit-json-btn').disabled, true);
  assert.equal(h.get('audit-csv-btn').disabled, true);
  assert.equal(h.get('audit-md-btn').disabled, true);
  assert.equal(h.get('audit-verify-btn').disabled, true);
});

test('the bookmark link field is populated at boot with the arm hash', () => {
  const h = bootSmall();
  assert.match(h.get('bookmark-link').value, /#arm=/);
});

test('changing a control rewrites the bookmark link', () => {
  const h = bootSmall();
  const first = h.get('bookmark-link').value;
  h.get('seed-input').value = '7777';
  h.get('seed-input').dispatch('change');
  assert.notEqual(h.get('bookmark-link').value, first);
  h.get('lab-workload').value = 'sobel';
  h.get('lab-workload').dispatch('change');
  assert.match(h.get('bookmark-link').value, /#arm=/);
});

/* ---------- comparison run ---------- */

test('run comparison fills five rows, status and the frontier note', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const rows = h.get('lab-config-body').children;
  assert.equal(rows.length, 5);
  assert.match(h.get('lab-status').textContent, /Comparison complete/);
  assert.match(h.get('lab-frontier-note').textContent, /Pareto frontier/);
});

test('every lab row shows intent, speed, accuracy, stability and frontier cells', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  for (const tr of h.get('lab-config-body').children) {
    assert.equal(tr.children.length, 7);
    assert.ok(tr.children[0].textContent.length > 0);
    assert.match(tr.children[1].textContent, /Exact|Approx/);
    assert.match(tr.children[3].textContent, /x|n\/a/);
    assert.match(tr.children[4].textContent, /bit identical|% d/);
    assert.match(tr.children[5].textContent, /stable|moderate|noisy|unavailable/);
  }
});

test('the reference row leads the table and is declared exact', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const first = h.get('lab-config-body').children[0];
  assert.match(first.children[0].textContent, /Reference/);
  assert.match(first.children[1].textContent, /Exact/);
  assert.match(first.children[4].textContent, /bit identical/);
});

test('the svg chart renders bars, frontier marks and a bottleneck callout', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const svg = h.get('lab-chart');
  const bars = [...svg.children].filter((c) => c.classList.contains('bar'));
  assert.equal(bars.length, 5);
  const marks = [...svg.children].filter((c) => c.classList.contains('frontier-mark'));
  assert.ok(marks.length >= 1);
  const texts = [...svg.children].filter((c) => c.localName === 'text');
  assert.ok(texts.some((t) => /bottleneck/.test(t.textContent)));
  assert.match(svg.getAttribute('aria-label'), /Frontier configs/);
});

test('roofline readouts fill with measured roofs and a model ceiling', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.match(h.get('roof-intensity').textContent, /ops\/byte/);
  assert.match(h.get('roof-mem').textContent, /bytes\/sec, measured/);
  assert.match(h.get('roof-compute').textContent, /ops\/sec, measured/);
  assert.match(h.get('roof-ceiling').textContent, /ops\/sec attainable \(model\)/);
  assert.match(h.get('roof-bounded').textContent, /memory path|compute/);
  assert.match(h.get('lab-bottleneck').textContent, /Roofline \(model\)/);
});

test('a second comparison replaces the table rather than appending', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.equal(h.get('lab-config-body').children.length, 5);
});

test('the lab refuses to run while the main bench is running', async () => {
  const h = bootSmall();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  // bench is running now; a lab click must be a no-op
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.match(h.get('bench-status').textContent, /Run complete/);
});

test('lab iterations clamp into the 1 to 8 range', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-iters').value = '99';
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.equal(h.get('lab-iters').value, '8');
});

test('running the lab enables the audit export buttons', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.equal(h.get('audit-json-btn').disabled, false);
  assert.equal(h.get('audit-csv-btn').disabled, false);
  assert.equal(h.get('audit-md-btn').disabled, false);
});

/* ---------- edge stress ---------- */

test('edge stress fills the table with case rows plus worst case rows', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('stress-run-btn').click();
  await h.settle(600);
  const rows = h.get('stress-body').children;
  // 8 hostile sizes x 5 configs + 5 worst case rows
  assert.equal(rows.length, 8 * 5 + 5);
  assert.match(h.get('stress-status').textContent, /Stress complete: 45 of 45 checks passed/);
});

test('stress rows carry pass or fail badges and invariant details', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('stress-run-btn').click();
  await h.settle(600);
  for (const tr of [...h.get('stress-body').children].slice(0, 10)) {
    const badge = tr.children[2].querySelector('.badge');
    assert.ok(badge);
    assert.match(badge.textContent, /Pass|Fail/);
    assert.ok(tr.children[3].textContent.length > 0);
  }
});

test('a completed stress run enables the audit buttons', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('stress-run-btn').click();
  await h.settle(600);
  assert.equal(h.get('audit-json-btn').disabled, false);
});

/* ---------- audit export and verify ---------- */

test('exporting json shows a 64 hex digest and enables verify', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  let downloaded = null;
  const origCreate = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      el.click = () => { downloaded = el.download; };
    }
    return el;
  };
  h.get('audit-json-btn').click();
  assert.match(h.get('audit-digest').textContent, /^[0-9a-f]{64}$/);
  assert.equal(h.get('audit-verify-btn').disabled, false);
  assert.match(downloaded, /^armbench-audit-[0-9a-f]{12}\.json$/);
  assert.match(h.get('audit-note').textContent, /Exported JSON/);
});

test('verify digest confirms an untouched export', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  h.get('audit-json-btn').click();
  h.get('audit-verify-btn').click();
  assert.match(h.get('audit-note').textContent, /Digest verified/);
});

test('csv and markdown exports each produce their own file name and digest', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const names = [];
  const origCreate = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => names.push(el.download);
    return el;
  };
  h.get('audit-csv-btn').click();
  const d1 = h.get('audit-digest').textContent;
  h.get('audit-md-btn').click();
  const d2 = h.get('audit-digest').textContent;
  assert.equal(names.length, 2);
  assert.match(names[0], /\.csv$/);
  assert.match(names[1], /\.md$/);
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.match(d2, /^[0-9a-f]{64}$/);
  assert.notEqual(d1, d2);
});

/* ---------- bookmark apply ---------- */

test('a valid arm hash restores seed, sizes, iterations and lab controls', () => {
  const hash = '#' + encodeBookmark({ seed: 9001, sizes: [512], iterations: 4, workload: 'histogram', labSize: 128 });
  const h = boot({ location: { hash, origin: 'http://h.local', pathname: '/index.html', href: 'http://h.local/index.html' + hash } });
  assert.equal(h.errors.length, 0);
  assert.equal(h.get('seed-input').value, '9001');
  assert.equal(h.get('size-select').value, '512');
  assert.equal(h.get('iters-input').value, '4');
  assert.equal(h.get('lab-workload').value, 'histogram');
  assert.equal(h.get('lab-size').value, '128');
  assert.match(h.get('bookmark-note').textContent, /Bookmark applied/);
});

test('a malformed arm hash is rejected and explained without throwing', () => {
  const h = boot({ location: { hash: '#arm=%%%', origin: 'http://h.local', pathname: '/index.html', href: 'http://h.local/index.html#arm=%%%' } });
  assert.equal(h.errors.length, 0);
  assert.match(h.get('bookmark-note').textContent, /Ignored an invalid bookmark hash/);
});

test('a hash without the arm prefix leaves controls untouched', () => {
  const h = boot({ location: { hash: '#lab', origin: 'http://h.local', pathname: '/index.html', href: 'http://h.local/index.html#lab' } });
  assert.equal(h.errors.length, 0);
  assert.equal(h.get('seed-input').value, '1337');
});

test('copy link uses the clipboard and reports success', async () => {
  const h = bootSmall();
  let wrote = null;
  h.sandbox.navigator.clipboard.writeText = async (t) => { wrote = t; };
  h.get('bookmark-copy-btn').click();
  await h.settle(30);
  assert.match(wrote, /#arm=/);
  assert.match(h.get('bookmark-note').textContent, /Link Copied/);
});

/* ---------- self tests panel ---------- */

test('run self tests fills the summary and one row per check', () => {
  const h = bootSmall();
  h.get('selftest-run-btn').click();
  assert.match(h.get('selftest-summary').textContent, /passed, 0 failed/);
  assert.ok(h.get('selftest-body').children.length >= 15);
});

test('every self test row shows a pass badge and a check name', () => {
  const h = bootSmall();
  h.get('selftest-run-btn').click();
  for (const li of h.get('selftest-body').children) {
    const badge = li.children[0];
    assert.ok(badge.classList.contains('badge--pass'), li.textContent);
    assert.ok(li.children[1].textContent.length > 0);
  }
});

test('self tests pass in the harness exactly like the module reports', () => {
  const h = bootSmall();
  h.get('selftest-run-btn').click();
  const m = h.get('selftest-summary').textContent.match(/(\d+) passed, (\d+) failed of (\d+)/);
  assert.ok(m);
  assert.equal(m[2], '0');
  const res = runSelfTests();
  assert.equal(Number(m[3]), res.count);
});

/* ---------- full flow ---------- */

test('bench run then lab run then stress then audit: the whole story works end to end', async () => {
  const h = bootSmall();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(600);
  assert.match(h.get('bench-status').textContent, /Run complete/);
  assert.equal(h.get('audit-json-btn').disabled, false);
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.match(h.get('lab-bottleneck').textContent, /Measured scaling|run the bench/i);
  h.get('stress-run-btn').click();
  await h.settle(600);
  h.get('gen-report-btn').click();
  const report = h.get('report-output').value;
  assert.match(report, /6\. Optimization Lab \(measured\)/);
  assert.match(report, /7\. Edge Stress \(measured\)/);
  assert.match(report, /Pareto frontier configs/);
});

test('the report carries the audit digest section after an export', async () => {
  const h = bootSmall();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(600);
  h.get('audit-json-btn').click();
  h.get('gen-report-btn').click();
  const report = h.get('report-output').value;
  assert.match(report, /8\. Audit Integrity/);
  assert.match(report, /unkeyed tamper detection/);
});

test('the report stays section 5 only before any lab or audit evidence exists', async () => {
  const h = bootSmall();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(600);
  h.get('gen-report-btn').click();
  const report = h.get('report-output').value;
  assert.ok(!/6\. Optimization Lab/.test(report));
  assert.ok(!/8\. Audit Integrity/.test(report));
});

/* ---------- deeper lab coverage ---------- */

test('chart bars distinguish exact and approx configs by class', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-workload').value = 'blur';
  h.get('lab-run-btn').click();
  await h.settle(600);
  const bars = [...h.get('lab-chart').children].filter((c) => c.classList.contains('bar'));
  const approx = bars.filter((b) => b.classList.contains('bar--approx'));
  assert.ok(approx.length >= 1, 'approx configs must be visually distinct');
  assert.equal(bars.length, approx.length + bars.filter((b) => !b.classList.contains('bar--approx')).length);
});

test('hovering a chart bar writes its exact measured numbers into the note', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const bar = [...h.get('lab-chart').children].find((c) => c.classList.contains('bar'));
  bar.dispatch('mouseover');
  assert.match(h.get('lab-chart-note').textContent, /ops\/sec measured/);
  bar.dispatch('mouseout');
  assert.match(h.get('lab-chart-note').textContent, /normalized to the fastest/);
});

test('the bottleneck readout names the bounded side after a lab run', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  assert.match(h.get('lab-bottleneck').textContent, /bound\.|memory path|compute/);
  assert.match(h.get('roof-bounded').textContent, /memory path|compute/);
});

test('stress on histogram conserves the bin count on every hostile size', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-workload').value = 'histogram';
  h.get('stress-run-btn').click();
  await h.settle(600);
  assert.match(h.get('stress-status').textContent, /45 of 45 checks passed/);
});

test('verify confirms the digest on an untouched export', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  h.get('audit-json-btn').click();
  h.get('audit-verify-btn').click();
  assert.match(h.get('audit-note').textContent, /Digest verified/);
});

test('the lab workload selector offers exactly the five kernels', () => {
  const h = bootSmall();
  const opts = [...h.get('lab-workload').querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(opts, ['grayscale', 'blur', 'sobel', 'histogram', 'resize']);
});

test('lab runs on every workload choice complete without errors', async () => {
  for (const wl of ['grayscale', 'blur', 'sobel', 'histogram', 'resize']) {
    const h = bootSmall();
    labDefaults(h);
    h.get('lab-workload').value = wl;
    h.get('lab-run-btn').click();
    await h.settle(600);
    assert.match(h.get('lab-status').textContent, /Comparison complete/, wl);
  }
});

test('a bookmark note explains a valid apply versus a plain boot', () => {
  const hash = '#' + encodeBookmark({ seed: 5, sizes: [256, 512, 1024], iterations: 8, workload: 'resize', labSize: 1024 });
  const h = boot({ location: { hash, origin: 'http://h.local', pathname: '/index.html', href: 'http://h.local/index.html' + hash } });
  assert.equal(h.get('size-select').value, 'all');
  assert.equal(h.get('lab-size').value, '1024');
  assert.match(h.get('bookmark-note').textContent, /Bookmark applied/);
});

test('a bookmark with a custom size list falls back to all sizes honestly', () => {
  const hash = '#' + encodeBookmark({ seed: 5, sizes: [64, 256], iterations: 8, workload: 'resize', labSize: 512 });
  const h = boot({ location: { hash, origin: 'http://h.local', pathname: '/index.html', href: 'http://h.local/index.html' + hash } });
  assert.equal(h.get('size-select').value, 'all');
  assert.match(h.get('bookmark-note').textContent, /custom size list has no select option/);
});

test('the self test button is wired and the panel lists real check names', () => {
  const h = bootSmall();
  h.get('selftest-run-btn').click();
  const names = [...h.get('selftest-body').children].map((li) => li.children[1].textContent);
  assert.ok(names.some((n) => /SHA-256/.test(n)), 'sha256 KAT row must show');
  assert.ok(names.some((n) => /Pareto/.test(n)), 'pareto row must show');
});

test('the audit note lists the exported sections after a full flow', async () => {
  const h = bootSmall();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(600);
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  h.get('audit-json-btn').click();
  assert.match(h.get('audit-note').textContent, /bench.*optimization-lab|optimization-lab.*bench/);
});

test('the bookmark field updates when lab size changes', () => {
  const h = bootSmall();
  const first = h.get('bookmark-link').value;
  h.get('lab-size').value = '512';
  h.get('lab-size').dispatch('change');
  assert.notEqual(h.get('bookmark-link').value, first);
});

test('run lab then self tests then audit in any order stays consistent', async () => {
  const h = bootSmall();
  h.get('selftest-run-btn').click();
  assert.match(h.get('selftest-summary').textContent, /0 failed/);
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  h.get('selftest-run-btn').click();
  assert.match(h.get('selftest-summary').textContent, /0 failed/);
});

test('the svg chart aria label summarizes frontier and verdict for screen readers', async () => {
  const h = bootSmall();
  labDefaults(h);
  h.get('lab-run-btn').click();
  await h.settle(600);
  const label = h.get('lab-chart').getAttribute('aria-label');
  assert.match(label, /Bar chart of measured ops per second/);
  assert.match(label, /Frontier configs/);
});
