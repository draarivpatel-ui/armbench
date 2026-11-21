/**
 * ArmBench hardening suite: hostile inputs, degenerate sizes, the pixel
 * budget applied to every timed step, basis filtering, the content security
 * policy, the WCAG 2.1.4 shortcut switch, and a self scan of every shipped
 * file for prohibited punctuation and wording. Written so a regression
 * cannot silently come back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mulberry32, makeImage, runGrayscale, runBoxBlur, runSobel,
  runHistogram, runResize, runVideoPipeline, timeWorkload, timingStats,
  planRun, executeStep, speedupBetween, projectPixelScaling,
  estimateFromLocal, estimateLatencyMs, estimateFactor, badgeFor, BASIS,
  generateReport, fmt, fmtInt, workloadById, WORKLOADS, VIDEO_CONFIG,
  MAX_IMAGE_PIXELS, DEFAULT_OPTIONS, runTelemetry, MAX_STEP_ITERATIONS,
} from '../js/armbench-core.js';
import { execFileSync } from 'node:child_process';
import { boot, ROOT } from './dom-harness.mjs';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const tokens = fs.readFileSync(path.join(ROOT, 'css/tokens.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'js/armbench-core.js'), 'utf8');
const moduleCheckJs = fs.readFileSync(path.join(ROOT, 'js/module-check.js'), 'utf8');
const runBenchJs = fs.readFileSync(path.join(ROOT, 'scripts/run-bench.mjs'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const notes = fs.readFileSync(path.join(ROOT, 'NOTES.md'), 'utf8');

/* Prohibited characters and wording are decoded from code points so this
 * scanner can scan its own file without shipping the literal bytes. */
const decode = (points) => String.fromCodePoint(...points);
const devpost = fs.readFileSync(path.join(ROOT, 'DEVPOST_UPGRADE.md'), 'utf8');

function imgGray(w, h, px) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const p = px[i] || 0;
    data[i * 4] = p;
    data[i * 4 + 1] = p;
    data[i * 4 + 2] = p;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function imgRGBA(w, h, rgba) {
  const data = new Uint8ClampedArray(w * h * 4);
  data.set(rgba.slice(0, w * h * 4));
  return { width: w, height: h, data };
}

/* ---------- mulberry32 ---------- */

test('mulberry32 stays inside [0, 1) for ten thousand draws', () => {
  const rand = mulberry32(12345);
  for (let i = 0; i < 10_000; i += 1) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, 'draw ' + i + ' escaped the unit interval: ' + v);
  }
});

test('mulberry32 long run mean sits near one half', () => {
  const rand = mulberry32(987);
  let sum = 0;
  for (let i = 0; i < 10_000; i += 1) sum += rand();
  const mean = sum / 10_000;
  assert.ok(Math.abs(mean - 0.5) < 0.02, 'mean ' + mean + ' drifted from 0.5');
});

test('mulberry32 coerces negative and fractional seeds without throwing', () => {
  const a = mulberry32(-1);
  const b = mulberry32(0xFFFFFFFF);
  const c = mulberry32(1.9);
  const d = mulberry32(1);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(a(), b(), 'seed -1 should alias 0xFFFFFFFF');
    assert.equal(c(), d(), 'seed 1.9 should alias seed 1');
  }
});

test('mulberry32 does not repeat a draw inside the first sixty four outputs', () => {
  const rand = mulberry32(7);
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const v = rand();
    assert.ok(!seen.has(v), 'repeat draw at position ' + i);
    seen.add(v);
  }
});

/* ---------- makeImage guards ---------- */

test('makeImage rejects a zero width', () => {
  assert.throws(() => makeImage(1, 0, 8), RangeError);
});

test('makeImage rejects a negative height', () => {
  assert.throws(() => makeImage(1, 8, -4), RangeError);
});

test('makeImage rejects fractional dimensions', () => {
  assert.throws(() => makeImage(1, 8.5, 8), RangeError);
  assert.throws(() => makeImage(1, 8, 8.25), RangeError);
});

test('makeImage rejects non numeric dimensions instead of a silent NaN buffer', () => {
  assert.throws(() => makeImage(1, Number.NaN, 8), RangeError);
  assert.throws(() => makeImage(1, 8, 'x'), RangeError);
  assert.throws(() => makeImage(1, null, 8), RangeError);
});

test('makeImage rejects a request over the allocation cap', () => {
  assert.throws(() => makeImage(1, 6000, 6000), RangeError);
  assert.throws(() => makeImage(1, 1, MAX_IMAGE_PIXELS + 1), RangeError);
});

test('makeImage accepts the degenerate 1 by 1 image without a divide by zero', () => {
  const img = makeImage(9, 1, 1);
  assert.equal(img.data.length, 4);
  assert.equal(img.data[3], 255);
});

test('makeImage is byte identical between a fractional seed and its truncation', () => {
  const a = makeImage(1.9, 8, 8);
  const b = makeImage(1, 8, 8);
  assert.deepEqual([...a.data], [...b.data]);
});

test('makeImage keeps alpha at 255 on every pixel of a small image', () => {
  const img = makeImage(11, 7, 5);
  for (let i = 3; i < img.data.length; i += 4) {
    assert.equal(img.data[i], 255, 'alpha drifted at byte ' + i);
  }
});

test('makeImage lifts the disc region above the corner region', () => {
  const img = makeImage(1337, 96, 96);
  const mean = (x0, y0, n) => {
    let s = 0;
    for (let y = y0; y < y0 + n; y += 1) {
      for (let x = x0; x < x0 + n; x += 1) s += img.data[(y * 96 + x) * 4];
    }
    return s / (n * n);
  };
  assert.ok(mean(40, 32, 10) > mean(2, 2, 10), 'the lifted disc must read brighter than the corner');
});

/* ---------- kernels on degenerate and crafted inputs ---------- */

test('grayscale maps pure primaries to the Rec 709 luma points', () => {
  const img = imgRGBA(2, 2, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const out = runGrayscale(img);
  assert.equal(out.data[0], 54);
  assert.equal(out.data[4], 182);
  assert.equal(out.data[8], 18);
  assert.equal(out.data[12], 255);
});

test('grayscale preserves per pixel alpha values', () => {
  const img = imgRGBA(2, 1, [200, 200, 200, 0, 10, 10, 10, 77]);
  const out = runGrayscale(img);
  assert.equal(out.data[3], 0);
  assert.equal(out.data[7], 77);
});

test('box blur on a 1 by 1 image returns the same pixel', () => {
  const out = runBoxBlur(imgGray(1, 1, [123]));
  assert.equal(out.data[0], 123);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
});

test('box blur replicates edges on a single row of three pixels', () => {
  const out = runBoxBlur(imgGray(3, 1, [0, 90, 0]));
  assert.equal(out.data[0], 30);
  assert.equal(out.data[4], 30);
  assert.equal(out.data[8], 30);
});

test('box blur spreads an impulse evenly into every neighbor', () => {
  const out = runBoxBlur(imgGray(3, 3, [0, 0, 0, 0, 255, 0, 0, 0, 0]));
  for (let p = 0; p < 9; p += 1) {
    assert.equal(out.data[p * 4], 28, 'pixel ' + p + ' should carry the 255/9 share');
  }
});

test('sobel is zero everywhere on a 1 by 1 image', () => {
  const out = runSobel(imgGray(1, 1, [200]));
  assert.equal(out.data[0], 0);
});

test('sobel fires only at the two columns beside a vertical step edge', () => {
  const out = runSobel(imgGray(4, 4, [
    0, 0, 255, 255,
    0, 0, 255, 255,
    0, 0, 255, 255,
    0, 0, 255, 255,
  ]));
  for (let y = 0; y < 4; y += 1) {
    assert.equal(out.data[(y * 4 + 0) * 4], 0, 'left border must stay zero');
    assert.equal(out.data[(y * 4 + 3) * 4], 0, 'right border must stay zero');
    assert.ok(out.data[(y * 4 + 1) * 4] > 200, 'edge column 1 must fire');
    assert.ok(out.data[(y * 4 + 2) * 4] > 200, 'edge column 2 must fire');
  }
});

test('sobel keeps a bright impulse silent at its own center', () => {
  const out = runSobel(imgGray(3, 3, [0, 0, 0, 0, 255, 0, 0, 0, 0]));
  assert.equal(out.data[(1 * 3 + 1) * 4], 0);
  let hot = 0;
  for (let p = 0; p < 9; p += 1) hot = Math.max(hot, out.data[p * 4]);
  assert.ok(hot > 0, 'the impulse must fire in the surrounding ring');
});

test('histogram bins a crafted four pixel image at the exact luma indexes', () => {
  const img = imgRGBA(2, 2, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const { bins, count } = runHistogram(img);
  assert.equal(count, 4);
  assert.equal(bins[54], 1);
  assert.equal(bins[182], 1);
  assert.equal(bins[18], 1);
  assert.equal(bins[255], 1);
});

test('resize of a 1 by 1 image returns an identical 1 by 1 image', () => {
  const out = runResize(imgGray(1, 1, [200]));
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.equal(out.data[0], 200);
});

test('resize of a 2 by 1 row averages the two pixels', () => {
  const out = runResize(imgGray(2, 1, [40, 120]));
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.equal(out.data[0], 80);
});

test('resize of a 3 by 3 image floors to 1 by 1 without sampling out of bounds', () => {
  const out = runResize(imgGray(3, 3, [0, 50, 100, 130, 180, 230, 60, 110, 160]));
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.ok(out.data[0] >= 0 && out.data[0] <= 255);
});

test('video pipeline honors the configured frame dimensions', () => {
  const out = runVideoPipeline({ seed: 5, width: 32, height: 18, frames: 4 });
  assert.equal(out.width, 32);
  assert.equal(out.height, 18);
  assert.equal(out.data.length, 32 * 18 * 4);
});

test('video pipeline changes its output when only the seed changes', () => {
  const a = runVideoPipeline({ seed: 5, width: 32, height: 18, frames: 4 });
  const b = runVideoPipeline({ seed: 6, width: 32, height: 18, frames: 4 });
  assert.notDeepEqual([...a.data], [...b.data]);
});

/* ---------- timing harness edge cases ---------- */

test('timeWorkload propagates a throw from the warmup call', () => {
  let calls = 0;
  assert.throws(
    () => timeWorkload(() => { calls += 1; throw new Error('kernel exploded'); }, {}, 2, () => 0),
    /kernel exploded/
  );
  assert.equal(calls, 1, 'the warmup call must be the first and only call');
});

test('timeWorkload reports null throughput when the clock runs backwards', () => {
  const times = [10, 9, 8, 7];
  let i = 0;
  const t = timeWorkload(() => {}, {}, 2, () => times[i++]);
  assert.equal(t.totalMs, -2);
  assert.equal(t.opsPerSec, null);
});

test('timingStats marks a negative mean pass unavailable rather than dividing', () => {
  const s = timingStats([-4, -5, -6], -5);
  assert.equal(s.cvPercent, null);
  assert.equal(s.stability, 'unavailable');
});

test('timingStats trimmed mean of three samples is the median', () => {
  const s = timingStats([1, 9, 5], 5);
  assert.equal(s.trimmedMeanMs, 5);
});

test('timingStats p95 of twenty samples is the nineteenth by nearest rank', () => {
  const samples = Array.from({ length: 20 }, (_, i) => i + 1);
  const s = timingStats(samples, 10.5);
  assert.equal(s.p95Ms, 19);
});

/* ---------- planRun validation and budget ---------- */

test('planRun rejects a non array sizes option', () => {
  assert.throws(() => planRun({ sizes: '256' }), TypeError);
});

test('planRun rejects zero and negative sizes', () => {
  assert.throws(() => planRun({ sizes: [0] }), RangeError);
  assert.throws(() => planRun({ sizes: [-64] }), RangeError);
});

test('planRun rejects fractional and non numeric sizes', () => {
  assert.throws(() => planRun({ sizes: [128.5] }), RangeError);
  assert.throws(() => planRun({ sizes: ['big'] }), RangeError);
});

test('planRun rejects a size beyond the image cap', () => {
  assert.throws(() => planRun({ sizes: [6000] }), RangeError);
});

test('planRun rejects zero, negative and fractional iterations', () => {
  assert.throws(() => planRun({ iterations: 0 }), RangeError);
  assert.throws(() => planRun({ iterations: -2 }), RangeError);
  assert.throws(() => planRun({ iterations: 2.5 }), RangeError);
});

test('planRun rejects a non positive pixel budget', () => {
  assert.throws(() => planRun({ maxPixelsPerOp: 0 }), RangeError);
  assert.throws(() => planRun({ maxPixelsPerOp: Number.NaN }), RangeError);
});

test('planRun clamps the video step inside the same pixel budget as kernels', () => {
  const steps = planRun({ seed: 1, sizes: [256], iterations: 8 });
  const video = steps.find((s) => s.workloadId === 'video');
  const pixelsPerPass = VIDEO_CONFIG.width * VIDEO_CONFIG.height * VIDEO_CONFIG.frames;
  assert.equal(video.iterations, Math.floor(DEFAULT_OPTIONS.maxPixelsPerOp / pixelsPerPass));
});

test('planRun leaves video iterations alone when the request fits the budget', () => {
  const steps = planRun({ seed: 1, sizes: [256], iterations: 5 });
  const video = steps.find((s) => s.workloadId === 'video');
  assert.equal(video.iterations, 5);
});

test('planRun rejects a budget too small for one video pass', () => {
  const pixelsPerPass = VIDEO_CONFIG.width * VIDEO_CONFIG.height * VIDEO_CONFIG.frames;
  assert.throws(
    () => planRun({ seed: 1, sizes: [256], iterations: 4, maxPixelsPerOp: 1000 }),
    (err) => err instanceof RangeError && err.message.includes(String(pixelsPerPass))
  );
});

test('planRun accepts an empty sizes list as a video only run', () => {
  const steps = planRun({ seed: 1, sizes: [], iterations: 3 });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].workloadId, 'video');
});

/* ---------- executeStep hostile inputs ---------- */

test('executeStep throws on an unknown workload id', () => {
  assert.throws(
    () => executeStep({ workloadId: 'bogus', size: 64, iterations: 1, seed: 1 }),
    TypeError
  );
});

test('executeStep throws on a non positive iteration count', () => {
  assert.throws(
    () => executeStep({ workloadId: 'blur', size: 64, iterations: 0, seed: 1 }),
    RangeError
  );
});

test('executeStep refuses a size over the image cap', () => {
  assert.throws(
    () => executeStep({ workloadId: 'blur', size: 6000, iterations: 1, seed: 1 }),
    RangeError
  );
});

test('executeStep video row carries the fixed frame descriptor and measured basis', () => {
  const row = executeStep(
    { workloadId: 'video', size: 0, iterations: 1, seed: 7 },
    (() => { let t = 0; return () => (t += 0.5); })()
  );
  assert.equal(row.size, '640 x 360, 8 frames');
  assert.equal(row.sizePx, VIDEO_CONFIG.width * VIDEO_CONFIG.height * VIDEO_CONFIG.frames);
  assert.equal(row.unit, 'pipelines/sec');
  assert.equal(row.basis, BASIS.MEASURED);
});

/* ---------- measured versus estimate honesty ---------- */

test('speedupBetween ignores rows that are not marked measured', () => {
  const rows = [
    { workloadId: 'blur', size: 256, opsPerSec: 1200, basis: 'estimate' },
    { workloadId: 'blur', size: 512, opsPerSec: 300, basis: BASIS.MEASURED },
  ];
  assert.equal(speedupBetween(rows, 'blur', 256, 512), null);
});

test('speedupBetween returns a ratio of exactly one for equal readings', () => {
  const rows = [
    { workloadId: 'blur', size: 256, opsPerSec: 700, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 512, opsPerSec: 700, basis: BASIS.MEASURED },
  ];
  assert.equal(speedupBetween(rows, 'blur', 256, 512).ratio, 1);
});

test('speedupBetween divides the small size throughput by the large size one', () => {
  const rows = [
    { workloadId: 'blur', size: 256, opsPerSec: 1200, basis: BASIS.MEASURED },
    { workloadId: 'blur', size: 512, opsPerSec: 300, basis: BASIS.MEASURED },
  ];
  const s = speedupBetween(rows, 'blur', 256, 512);
  assert.equal(s.ratio, 4);
  assert.equal(s.basis, 'measured');
});

test('estimateFromLocal marks its output as an estimate with the exact factor', () => {
  const est = estimateFromLocal(1000);
  assert.equal(est.isEstimate, true);
  assert.equal(est.basis, 'estimate');
  assert.equal(est.factor, estimateFactor());
  assert.equal(est.opsPerSec, 1000 * estimateFactor());
});

test('estimateLatencyMs of zero is zero, not a NaN or a null', () => {
  assert.equal(estimateLatencyMs(0), 0);
});

test('projectPixelScaling accepts a zero throughput and stays a projection', () => {
  const p = projectPixelScaling(0, 256, 512);
  assert.equal(p.opsPerSec, 0);
  assert.equal(p.basis, 'projection');
  assert.match(p.note, /not a measurement/i);
});

test('projectPixelScaling rejects non finite and negative throughputs', () => {
  assert.throws(() => projectPixelScaling(Number.NaN, 256, 512), RangeError);
  assert.throws(() => projectPixelScaling(-3, 256, 512), RangeError);
});

test('badgeFor keeps the projection basis out of the estimate badge', () => {
  assert.equal(badgeFor(BASIS.MEASURED), 'Measured');
  assert.notEqual(badgeFor('projection'), 'Measured');
});

/* ---------- report honesty ---------- */

test('generateReport with no rows still prints every section and a zero count', () => {
  const report = generateReport([], { declared: 'host', runtime: 'node test' },
    { generatedAt: '2026-11-01T00:00:00Z', seed: 1, sizes: [], iterations: 1 });
  assert.match(report, /ArmBench Methodology And Results/);
  assert.match(report, /Rows summarized: 0/);
  assert.match(report, /No estimate is presented as a measurement/);
  assert.match(report, /Author: Aariv Patel/);
});

test('generateReport carries the video pixels per pass inside the budget line', () => {
  const report = generateReport([], { declared: 'h', runtime: 'r' },
    { generatedAt: 't', seed: 1, sizes: [256], iterations: 5 });
  const pixelsPerPass = VIDEO_CONFIG.width * VIDEO_CONFIG.height * VIDEO_CONFIG.frames;
  assert.ok(report.includes(pixelsPerPass.toLocaleString('en-US') + ' pixels per pass'));
});

test('generateReport writes frames per second beside the video row', () => {
  const videoRow = {
    workloadId: 'video', label: 'Video Pipeline (8 Frames, 640 by 360)',
    unit: 'pipelines/sec', size: '640 x 360, 8 frames', sizePx: 1843200,
    iterations: 1, meanMs: 5, medianMs: 5, minMs: 5, maxMs: 5, totalMs: 5,
    opsPerSec: 200, stdDevMs: 0, cvPercent: 0, p95Ms: 5, trimmedMeanMs: 5,
    stability: 'stable', basis: BASIS.MEASURED,
  };
  const report = generateReport([videoRow], { declared: 'h', runtime: 'r' },
    { generatedAt: 't', seed: 1, sizes: [256], iterations: 1 });
  assert.match(report, /1600\.0 frames\/sec/);
});

/* ---------- formatting ---------- */

test('fmt renders n/a for null, undefined, NaN and Infinity', () => {
  assert.equal(fmt(null), 'n/a');
  assert.equal(fmt(undefined), 'n/a');
  assert.equal(fmt(Number.NaN), 'n/a');
  assert.equal(fmt(Number.POSITIVE_INFINITY), 'n/a');
});

test('fmt and fmtInt format finite numbers as documented', () => {
  assert.equal(fmt(5.5), '5.50');
  assert.equal(fmt(1.236, 3), '1.236');
  assert.equal(fmtInt(1234567), '1,234,567');
  assert.equal(fmtInt(-3.6), '-4');
  assert.equal(fmtInt(null), 'n/a');
});

/* ---------- shipped page hardening ---------- */

test('index.html ships a content security policy with self script and style sources', () => {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  assert.ok(m, 'CSP meta tag is missing');
  const csp = m[1];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'the policy must not allow inline or eval');
});

test('index.html contains no inline style attributes', () => {
  assert.equal(/\sstyle="/i.test(html), false, 'an inline style attribute survived');
});

test('every script tag in index.html loads an external file', () => {
  const tags = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(tags.length >= 2);
  for (const tag of tags) {
    assert.ok(/\bsrc="[^"]+"/.test(tag), 'inline script tag found: ' + tag);
  }
});

test('the module fallback checker is referenced and guards the banner flag', () => {
  assert.match(html, /<script src="js\/module-check\.js">/);
  assert.match(moduleCheckJs, /__ARMBENCH_LOADED__/);
  assert.match(moduleCheckJs, /module-banner/);
});

test('the page ships a visible shortcuts button and a single key master switch', () => {
  assert.match(html, /<button type="button" id="shortcuts-btn" class="btn btn-ghost">Shortcuts<\/button>/);
  assert.match(html, /id="shortcuts-toggle"/);
});

test('no stylesheet anywhere sets scroll-behavior', () => {
  assert.equal(/scroll-behavior/i.test(css + tokens), false);
});

test('shipped text contains no prohibited disclosure wording', () => {
  const shipped = [html, css, tokens, appJs, coreJs, moduleCheckJs, runBenchJs, readme, notes, devpost].join('\n');
  const terms = [
    [111, 112, 101, 110, 97, 105],
    [99, 104, 97, 116, 103, 112, 116],
    [97, 110, 116, 104, 114, 111, 112, 105, 99],
    [99, 111, 112, 105, 108, 111, 116],
    [103, 101, 109, 105, 110, 105],
    [100, 101, 101, 112, 115, 101, 101, 107],
    [97, 114, 116, 105, 102, 105, 99, 105, 97, 108, 32, 105, 110, 116, 101, 108, 108, 105, 103, 101, 110, 99, 101],
    [108, 97, 110, 103, 117, 97, 103, 101, 32, 109, 111, 100, 101, 108],
    [108, 108, 109],
  ].map(decode);
  const re = new RegExp('\\b(?:' + terms.join('|') + ')\\b', 'i');
  for (const term of terms) assert.equal(re.test('x ' + term + ' y'), true, 'probe ' + term);
  assert.equal(re.test(shipped), false);
});

test('every shipped source file is free of em and en dashes', () => {
  const smartQuotes = new RegExp('[' + decode([0x201c, 0x201d]) + ']');
  const emDash = decode([0x2014]);
  const enDash = decode([0x2013]);
  for (const [name, text] of Object.entries({
    'index.html': html, 'css/style.css': css, 'css/tokens.css': tokens,
    'js/app.js': appJs, 'js/armbench-core.js': coreJs, 'js/module-check.js': moduleCheckJs,
    'scripts/run-bench.mjs': runBenchJs, 'README.md': readme, 'NOTES.md': notes,
    'DEVPOST_UPGRADE.md': devpost,
  })) {
    assert.ok(!smartQuotes.test(text), 'smart quote found in ' + name);
    assert.ok(!text.includes(emDash), 'em dash found in ' + name);
    assert.ok(!text.includes(enDash), 'en dash found in ' + name);
  }
});

test('the run bench script rejects non positive and oversized sizes', () => {
  assert.match(runBenchJs, /s < 1 \|\| s \* s > MAX_IMAGE_PIXELS/);
  assert.match(runBenchJs, /process\.exit\(2\)/);
});

test('the workload registry still holds exactly the five kernels plus video', () => {
  assert.equal(WORKLOADS.length, 6);
  assert.equal(WORKLOADS.filter((w) => w.id === 'video').length, 1);
  assert.equal(workloadById('video').unit, 'pipelines/sec');
});

/* ---------- live DOM runtime ---------- */

test('the Shortcuts button opens the dialog without relying on a key press', () => {
  const h = boot();
  assert.equal(h.errors.length, 0, 'boot errors: ' + h.errors.join('\n'));
  h.get('shortcuts-btn').click();
  assert.equal(h.get('shortcuts-dialog').open, true);
  h.get('shortcuts-close').click();
  assert.equal(h.get('shortcuts-dialog').open, false);
});

test('turning the single key switch off makes every character shortcut inert', async () => {
  const h = boot();
  const toggle = h.get('shortcuts-toggle');
  assert.equal(toggle.checked, true, 'shortcuts ship enabled by default');
  toggle.checked = false;
  toggle.dispatch('change');
  const rowsBefore = h.get('results-body').children.length;
  h.globalKey('r');
  await h.settle(50);
  assert.match(h.get('bench-status').textContent, /shortcuts are off/i);
  assert.equal(h.get('results-body').children.length, rowsBefore, 'disabled shortcuts must not start a run');
  assert.equal(h.get('run-btn').disabled, false);
  h.globalKey('?');
  assert.equal(h.get('shortcuts-dialog').open, false, 'the ? key must also be inert');
});

test('turning the switch back on restores the character shortcuts', async () => {
  const h = boot();
  const toggle = h.get('shortcuts-toggle');
  toggle.checked = false;
  toggle.dispatch('change');
  toggle.checked = true;
  toggle.dispatch('change');
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.globalKey('r');
  await h.settle(400);
  assert.match(h.get('bench-status').textContent, /Run complete/);
});

test('a stored off preference is honored when the app boots', () => {
  const store = { 'armbench.shortcutsEnabled': 'off' };
  const h = boot({
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  });
  const toggle = h.get('shortcuts-toggle');
  assert.equal(toggle.checked, false, 'the stored preference must win over the default');
});

test('the toggle writes its state back to local storage', () => {
  const store = {};
  const h = boot({
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  });
  const toggle = h.get('shortcuts-toggle');
  toggle.checked = false;
  toggle.dispatch('change');
  assert.equal(store['armbench.shortcutsEnabled'], 'off');
  toggle.checked = true;
  toggle.dispatch('change');
  assert.equal(store['armbench.shortcutsEnabled'], 'on');
});

test('the module banner stays hidden once the module script has run', () => {
  const h = boot();
  assert.equal(h.errors.length, 0);
  assert.equal(h.sandbox.window.__ARMBENCH_LOADED__, true);
  assert.equal(h.get('module-banner').classList.contains('is-visible'), false);
});

/* ---------- adversarial pass 2 regressions ---------- */

test('planRun rejects a size whose single pass exceeds the pixel budget', () => {
  // 4096^2 = 16.7M px: even one timed call would break the 12M claim.
  assert.throws(() => planRun({ seed: 1, sizes: [4096], iterations: 1 }), RangeError);
  assert.throws(() => planRun({ seed: 1, sizes: [2048], iterations: 1, maxPixelsPerOp: 2_000_000 }), RangeError);
  // the same size stays legal under a budget that can hold it
  const steps = planRun({ seed: 1, sizes: [4096], iterations: 1, maxPixelsPerOp: 20_000_000 });
  assert.equal(steps.find((s) => s.workloadId === 'blur').iterations, 1);
});

test('planRun requires a finite seed so video frame seeds stay reproducible', () => {
  for (const seed of ['1337', 'abc', Number.NaN, Infinity, {}, null, undefined]) {
    assert.throws(() => planRun({ seed, sizes: [64], iterations: 1 }), RangeError, 'seed ' + String(seed));
  }
  const steps = planRun({ seed: 7, sizes: [64], iterations: 1 });
  assert.equal(steps[0].seed, 7);
});

test('runVideoPipeline coerces the seed once and rejects degenerate frame counts', () => {
  for (const frames of [0, -3, 2.5, '8', null, undefined]) {
    assert.throws(() => runVideoPipeline({ seed: 1, width: 16, height: 16, frames }), RangeError, 'frames ' + String(frames));
  }
  const a = runVideoPipeline({ seed: 7.9, width: 8, height: 8, frames: 1 });
  const b = runVideoPipeline({ seed: 7, width: 8, height: 8, frames: 1 });
  assert.deepEqual([...a.data], [...b.data]);
});

test('a single timed iteration reports no dispersion instead of a fabricated steady verdict', () => {
  const s = timingStats([4], 4);
  assert.equal(s.cvPercent, null);
  assert.equal(s.stability, 'unavailable');
  const row = executeStep({ workloadId: 'blur', size: 16, iterations: 1, seed: 1 }, (() => { let t = 0; return () => (t += 0.5); })());
  assert.equal(row.cvPercent, null);
  assert.equal(row.stability, 'unavailable');
  const t = runTelemetry([row]);
  assert.equal(t.count, 0);
  assert.equal(t.verdict, 'no dispersion data');
});

test('planRun clamps giant iteration requests to the absolute cap', () => {
  const steps = planRun({ seed: 1, sizes: [1], iterations: 1e9 });
  assert.equal(steps.find((s) => s.workloadId === 'blur').iterations, MAX_STEP_ITERATIONS);
  assert.equal(steps.find((s) => s.workloadId === 'video').iterations, Math.min(MAX_STEP_ITERATIONS, Math.floor(DEFAULT_OPTIONS.maxPixelsPerOp / 1843200)));
});

test('generateReport labels every row with its real basis', () => {
  const estRow = {
    workloadId: 'blur', label: 'Blur', unit: 'ops/sec', size: 64, sizePx: 4096,
    iterations: 5, meanMs: 1, medianMs: 1, minMs: 1, maxMs: 1, totalMs: 5,
    opsPerSec: 64, stdDevMs: 0, cvPercent: 0, p95Ms: 1, trimmedMeanMs: 1,
    stability: 'stable', basis: BASIS.ESTIMATE,
  };
  const report = generateReport([estRow], { declared: 'h', runtime: 'r' },
    { author: 'A', generatedAt: 't', seed: 1, sizes: [64], iterations: 5 });
  assert.ok(!/\| Measured/.test(report), 'an estimate row must never print a Measured label');
  assert.ok(report.includes('| Estimate'));
});

test('generateReport reports the effective per step iteration counts when the budget clamps', () => {
  const clock = (() => { let t = 0; return () => (t += 0.5); })();
  const rows = planRun({ seed: 1, sizes: [256], iterations: 8 }).map((s) => executeStep(s, clock));
  const report = generateReport(rows, { declared: 'h', runtime: 'r' },
    { author: 'A', generatedAt: 't', seed: 1, sizes: [256], iterations: 8 });
  assert.match(report, /up to 8 requested; each step ran 6 or 8 iterations/);
  const flat = generateReport(rows, { declared: 'h', runtime: 'r' },
    { author: 'A', generatedAt: 't', seed: 1, sizes: [256], iterations: 8, maxPixelsPerOp: 7_000_000 });
  assert.match(flat, /never total more than 7,000,000 pixels/);
});

test('a held shortcut key cannot spam downloads or clipboard writes', async () => {
  const h = boot();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  h.globalKey('g');
  await h.settle(20);
  let downloads = 0;
  let copies = 0;
  const origCreate = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') downloads++;
    return el;
  };
  const clip = h.sandbox.navigator.clipboard;
  clip.writeText = async (t) => { copies++; };
  for (let i = 0; i < 5; i++) h.globalKey('e', { repeat: true });
  for (let i = 0; i < 5; i++) h.globalKey('c', { repeat: true });
  await h.settle(20);
  assert.equal(downloads, 0, 'key repeat must not fire downloads');
  assert.equal(copies, 0, 'key repeat must not fire clipboard writes');
  h.globalKey('e');
  h.globalKey('c');
  await h.settle(20);
  assert.equal(downloads, 1);
  assert.equal(copies, 1);
});

test('the compare caption and video row name the fixed pipeline and its real unit', async () => {
  assert.match(html, /largest image size in the latest run, plus the fixed eight frame video pipeline/);
  const h = boot();
  h.get('size-select').value = '256';
  h.get('iters-input').value = '1';
  h.get('run-btn').click();
  await h.settle(400);
  const videoRow = [...h.get('compare-body').children].find((tr) => tr.children[0].textContent.includes('Video'));
  assert.ok(videoRow);
  assert.match(videoRow.children[2].textContent, /pipelines\/sec/);
  assert.match(videoRow.children[3].textContent, /pipelines\/sec/);
});

const RUN_BENCH = path.join(ROOT, 'scripts', 'run-bench.mjs');

function cliStatus(argv) {
  try {
    const stdout = execFileSync(process.execPath, [RUN_BENCH, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('the CLI prints usage on --help and -h without running a benchmark', () => {
  for (const flag of ['--help', '-h']) {
    const r = cliStatus([flag]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.ok(!r.stdout.includes('ArmBench, Node Run'), flag + ' must not run the bench');
  }
});

test('the CLI rejects malformed, missing and unknown arguments', () => {
  for (const argv of [
    ['--iterations', '0'], ['--iterations', '-3'], ['--iterations', 'abc'], ['--iterations', '13'],
    ['--seed=1e3'], ['--seed', 'x'], ['--seed'], ['--size', '512junk'], ['--size', '0'],
    ['--bogus'], ['--json=true'], ['--size', '4096'],
  ]) {
    const r = cliStatus(argv);
    assert.equal(r.code, 2, JSON.stringify(argv) + ' must exit 2, got ' + r.code + ' ' + (r.stderr || ''));
    assert.ok(!r.stdout.includes('ArmBench, Node Run'), JSON.stringify(argv) + ' must not run the bench');
  }
});

test('the CLI accepts the --flag=value form and runs what was asked', () => {
  const r = cliStatus(['--seed=7', '--size=64', '--iterations=1', '--json']);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.options.seed, 7);
  assert.equal(payload.options.iterations, 1);
  assert.deepEqual(payload.options.sizes, [64]);
});
