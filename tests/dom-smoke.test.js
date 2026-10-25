import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeImage,
  planRun,
  executeStep,
  workloadById,
  WORKLOADS,
  ESTIMATE_MODEL,
  estimateFromLocal,
  estimateFactor,
  badgeFor,
  BASIS,
  generateReport,
  fmt,
  fmtInt,
} from '../js/armbench-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(repoRoot, 'css/style.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(repoRoot, 'css/tokens.css'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'js/app.js'), 'utf8');
const readmeMd = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

test('DOM Smoke 01: index.html starts with HTML5 doctype and lang=en', () => {
  assert.match(indexHtml.trimStart(), /^<!doctype html>/i);
  assert.match(indexHtml, /<html\s+lang="en">/i);
});

test('DOM Smoke 02: index.html contains UTF-8 charset and responsive viewport meta tags', () => {
  assert.match(indexHtml, /<meta\s+charset="utf-8"\s*\/>/i);
  assert.match(indexHtml, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"\s*\/>/i);
});

test('DOM Smoke 03: index.html contains non-empty title, meta description, and OpenGraph tags', () => {
  assert.match(indexHtml, /<title>ArmBench,\s*An Arm Image And Video Workload Bench<\/title>/);
  assert.match(indexHtml, /<meta\s+name="description"\s+content="[^"]{40,}"\s*\/>/);
  assert.match(indexHtml, /property="og:title"\s+content="[^"]+"/);
  assert.match(indexHtml, /property="og:description"\s+content="[^"]+"/);
  assert.match(indexHtml, /property="og:type"\s+content="website"/);
});

test('DOM Smoke 04: inline SVG favicon and theme-color exist in <head>', () => {
  assert.match(indexHtml, /<meta\s+name="theme-color"\s+content="#17171b"\s*\/>/i);
  assert.match(indexHtml, /<link\s+rel="icon"\s+href="data:image\/svg\+xml,/);
});

test('DOM Smoke 05: index.html contains exactly one <h1> element and valid heading hierarchy', () => {
  const h1Matches = indexHtml.match(/<h1\b[^>]*>/gi) || [];
  assert.equal(h1Matches.length, 1);
  const levels = [...indexHtml.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  assert.equal(levels[0], 1);
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(
      levels[i] <= levels[i - 1] + 1,
      `Heading level jumped from h${levels[i - 1]} to h${levels[i]}`
    );
  }
});

test('DOM Smoke 06: all id attributes in index.html are unique', () => {
  const ids = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 25);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'Duplicate IDs found in index.html');
});

test('DOM Smoke 07: accessible skip-link, noscript fallback, and semantic landmarks exist', () => {
  assert.match(indexHtml, /<a\s+class="skip-link"\s+href="#main">/);
  assert.match(indexHtml, /<noscript>[\s\S]*?<\/noscript>/);
  assert.match(indexHtml, /<header\s+class="masthead">/);
  assert.match(indexHtml, /<nav\s+class="panel-nav"\s+aria-label="Panel Navigation">/);
  assert.match(indexHtml, /<main\s+id="main">/);
  assert.match(indexHtml, /<footer\s+class="footer">/);
});

test('DOM Smoke 08: every aria-labelledby and label[for] in index.html resolves to an existing ID', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const rawRefs = [...indexHtml.matchAll(/\baria-labelledby="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(rawRefs.length >= 5);
  for (const raw of rawRefs) {
    for (const ref of raw.trim().split(/\s+/)) {
      assert.ok(htmlIds.has(ref), `aria-labelledby target #${ref} is missing in index.html`);
    }
  }
  const forIds = [...indexHtml.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(forIds.length >= 4);
  for (const id of forIds) {
    assert.ok(htmlIds.has(id), `label[for="${id}"] has no matching control ID`);
  }
});

test('DOM Smoke 09: all DOM IDs wired in js/app.js exist in index.html', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const boundIds = [...appJs.matchAll(/\$\(\s*'#([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.equal(boundIds.length, 23);
  for (const id of boundIds) {
    assert.ok(htmlIds.has(id), `ID #${id} queried in js/app.js is missing from index.html`);
  }
});

test('DOM Smoke 10: css/style.css enforces overflow-x: clip, focus-visible outline, and reduced-motion guard', () => {
  assert.match(styleCss, /overflow-x:\s*clip/);
  assert.match(styleCss, /:focus-visible\s*\{[\s\S]*?outline:/);
  assert.match(styleCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(styleCss, /font-variant-numeric:\s*tabular-nums/);
});

test('DOM Smoke 11: zero em-dashes, en-dashes, or emoji across HTML, CSS, UI JS, and README', () => {
  assert.equal(/[\u2013\u2014]/.test(indexHtml), false);
  assert.equal(/[\u2013\u2014]/.test(styleCss), false);
  assert.equal(/[\u2013\u2014]/.test(tokensCss), false);
  assert.equal(/[\u2013\u2014]/.test(appJs), false);
  assert.equal(/[\u2013\u2014]/.test(readmeMd), false);
  const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  assert.equal(emojiRegex.test(indexHtml), false);
  assert.equal(emojiRegex.test(styleCss), false);
  assert.equal(emojiRegex.test(appJs), false);
});

test('DOM Smoke 12: armbench-core executes UI preview, run plan, estimates, and report cleanly', () => {
  const preview = makeImage(1337, 96, 96);
  assert.equal(preview.width, 96);
  assert.equal(preview.height, 96);
  assert.equal(preview.data.length, 96 * 96 * 4);

  const steps = planRun({ seed: 1337, sizes: [256], iterations: 2 });
  assert.equal(steps.length, WORKLOADS.length);

  let fakeNow = 100;
  const fakeClock = () => {
    fakeNow += 2.5;
    return fakeNow;
  };

  const rows = steps.map((s) => executeStep({ ...s, size: s.workloadId === 'video' ? 0 : 64, iterations: 1 }, fakeClock));
  assert.equal(rows.length, WORKLOADS.length);
  for (const r of rows) {
    assert.ok(workloadById(r.workloadId));
    assert.equal(r.basis, BASIS.MEASURED);
    assert.equal(badgeFor(r.basis), 'Measured');
    const est = estimateFromLocal(r.opsPerSec);
    assert.equal(est.isEstimate, true);
    assert.equal(badgeFor(est.basis), 'Estimate');
    assert.equal(est.factor, estimateFactor());
    assert.ok(fmt(r.meanMs).length > 0);
    assert.ok(fmtInt(r.opsPerSec).length > 0);
  }

  const report = generateReport(
    rows,
    { declared: 'Apple Silicon Mac, Arm64, macOS', runtime: 'Node test runner' },
    { author: 'Aariv Patel', generatedAt: '2026-10-25T00:00:00.000Z', seed: 1337, sizes: [256], iterations: 1 }
  );
  assert.ok(report.includes('ArmBench Methodology And Results'));
  assert.ok(report.includes(ESTIMATE_MODEL.target));
  assert.equal(/[\u2013\u2014]/.test(report), false);
});
