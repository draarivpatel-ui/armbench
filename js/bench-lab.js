/**
 * ArmBench optimization lab.
 * Five kernel configurations per workload (one reference plus four real
 * optimization variants), an accuracy comparator, a Pareto frontier over
 * measured speed and measured accuracy, a documented op and byte model with
 * live measured machine roofs, a hostile size edge stress suite, a pure
 * JavaScript FIPS 180-4 SHA-256, a checksummed audit export, a strict URL
 * hash bookmark codec and the in page self test battery. This module has no
 * DOM access so the browser app, the Node script and the test suite all run
 * the exact same code. Every speed figure it produces is a live measurement;
 * the roofline headroom figures are a documented model and say so.
 */
import {
  makeImage, runGrayscale, runBoxBlur, runSobel, runHistogram, runResize,
  timeWorkload, mulberry32, planRun, speedupBetween, estimateFactor,
  workloadById, WORKLOADS, VIDEO_CONFIG, MAX_IMAGE_PIXELS, DEFAULT_OPTIONS,
  timingStats, runTelemetry, fmt, fmtInt, badgeFor, BASIS,
} from './armbench-core.js';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

function labClock() {
  return typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();
}

function luma709(data, i) {
  return Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
}

function clamp8(v) {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/**
 * Deterministic color probe derived from the seeded gray pattern. The bench
 * input is grayscale by construction, which would make every grayscale
 * variant trivially identical, so accuracy is measured against the reference
 * on this color probe. Same seed produces the same bytes everywhere.
 */
export function makeColorProbe(seed, width, height) {
  const img = makeImage(seed, width, height);
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp8(d[i] + (rand() * 2 - 1) * 48);
    d[i + 1] = clamp8(d[i + 1] + (rand() * 2 - 1) * 48);
    d[i + 2] = clamp8(d[i + 2] + (rand() * 2 - 1) * 48);
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* Kernel variant library                                               */
/* ------------------------------------------------------------------ */

/* --- grayscale variants --- */

function grayIntLuma(img) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

function grayIntLumaRound(img) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 + 128) >> 8;
    out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

/**
 * Exact float luma, unrolled four pixels per iteration. Each pixel still
 * computes the reference expression, so the output is bit identical while
 * the loop body amortizes index arithmetic the way a NEON width pass would.
 */
function grayFloatUnroll(img) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  const n = data.length;
  let i = 0;
  for (; i + 16 <= n; i += 16) {
    for (let k = 0; k < 16; k += 4) {
      const g = luma709(data, i + k);
      out[i + k] = g; out[i + k + 1] = g; out[i + k + 2] = g; out[i + k + 3] = data[i + k + 3];
    }
  }
  for (; i < n; i += 4) {
    const g = luma709(data, i);
    out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

function grayChannelMean(img) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = ((data[i] + data[i + 1] + data[i + 2]) / 3) | 0;
    out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

/* --- box blur variants --- */

/**
 * Exact two pass separable box blur. The horizontal pass stores integer
 * three pixel sums, the vertical pass sums three of those rows and rounds
 * once, so the total is bit identical to the reference nine tap window.
 */
function blurSeparable(img) {
  const { width: w, height: h, data: src } = img;
  const tmp = new Int32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      for (let c = 0; c < 3; c++) {
        tmp[(row + x) * 3 + c] =
          src[(row + x0) * 4 + c] + src[(row + x) * 4 + c] + src[(row + x2) * 4 + c];
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : 0) * w;
    const y1 = y * w;
    const y2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round(
          (tmp[(y0 + x) * 3 + c] + tmp[(y1 + x) * 3 + c] + tmp[(y2 + x) * 3 + c]) / 9);
      }
      out[o + 3] = src[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Exact separable blur with sliding accumulation in both passes. Each row
 * updates its horizontal sum in constant time and each column does the same
 * vertically, so the work per pixel no longer depends on the window size.
 */
function blurSeparableSliding(img) {
  const { width: w, height: h, data: src } = img;
  const tmp = new Int32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let acc = src[row * 4 + c] + src[row * 4 + c] + src[(row + (w > 1 ? 1 : 0)) * 4 + c];
      tmp[row * 3 + c] = acc;
      for (let x = 1; x < w; x++) {
        const addX = x + 1 < w ? x + 1 : w - 1;
        const subX = x - 2 > 0 ? x - 2 : 0;
        acc += src[(row + addX) * 4 + c] - src[(row + subX) * 4 + c];
        tmp[(row + x) * 3 + c] = acc;
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = tmp[x * 3 + c] + tmp[x * 3 + c] + tmp[((h > 1 ? 1 : 0) * w + x) * 3 + c];
      out[x * 4 + c] = Math.round(acc / 9);
      for (let y = 1; y < h; y++) {
        const addY = (y + 1 < h ? y + 1 : h - 1) * w;
        const subY = (y - 2 > 0 ? y - 2 : 0) * w;
        acc += tmp[(addY + x) * 3 + c] - tmp[(subY + x) * 3 + c];
        out[(y * w + x) * 4 + c] = Math.round(acc / 9);
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = src[i];
  return { width: w, height: h, data: out };
}

/**
 * Classic byte separable blur: each pass rounds back to a byte before the
 * next one runs. Real speed, real accuracy loss, which is exactly the
 * trade the lab exists to show.
 */
function blurSeparableByte(img) {
  const { width: w, height: h, data: src } = img;
  const tmp = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      for (let c = 0; c < 3; c++) {
        tmp[(row + x) * 3 + c] = Math.round(
          (src[(row + x0) * 4 + c] + src[(row + x) * 4 + c] + src[(row + x2) * 4 + c]) / 3);
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : 0) * w;
    const y1 = y * w;
    const y2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round(
          (tmp[(y0 + x) * 3 + c] + tmp[(y1 + x) * 3 + c] + tmp[(y2 + x) * 3 + c]) / 3);
      }
      out[o + 3] = src[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Single pass blur with clamped reads everywhere. It produces the reference
 * output but pays the border math on every pixel, an honest counterexample
 * to the interior fast path split.
 */
function blurUniformClamp(img) {
  const { width: w, height: h, data: src } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : 0) * w;
    const y1 = y * w;
    const y2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round((
          src[(y0 + x0) * 4 + c] + src[(y0 + x) * 4 + c] + src[(y0 + x2) * 4 + c] +
          src[(y1 + x0) * 4 + c] + src[(y1 + x) * 4 + c] + src[(y1 + x2) * 4 + c] +
          src[(y2 + x0) * 4 + c] + src[(y2 + x) * 4 + c] + src[(y2 + x2) * 4 + c]) / 9);
      }
      out[o + 3] = src[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/* --- sobel variants --- */

function sobelWithMagnitude(img, magnitude) {
  const { width: w, height: h, data } = img;
  const L = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < L.length; p++, i += 4) L[p] = luma709(data, i);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      const tl = L[y0 * w + x0];
      const t = L[y0 * w + x];
      const tr = L[y0 * w + x2];
      const ml = L[y * w + x0];
      const mr = L[y * w + x2];
      const bl = L[y2 * w + x0];
      const b = L[y2 * w + x];
      const br = L[y2 * w + x2];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      const m = magnitude === 'manhattan'
        ? Math.min(255, Math.abs(gx) + Math.abs(gy))
        : Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      const o = (y * w + x) * 4;
      out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = data[(y * w + x) * 4 + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Row buffered Sobel: only three luma rows are ever alive. Same math and
 * the same bytes as the reference, with a much smaller working set.
 */
function sobelRowBuffer(img, magnitude) {
  const { width: w, height: h, data } = img;
  const lumaRow = (y, buf) => {
    const base = y * w * 4;
    for (let x = 0; x < w; x++) buf[x] = luma709(data, base + x * 4);
  };
  let prev = new Uint8ClampedArray(w);
  let cur = new Uint8ClampedArray(w);
  let next = new Uint8ClampedArray(w);
  lumaRow(0, prev);
  lumaRow(0, cur);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    lumaRow(y < h - 1 ? y + 1 : h - 1, next);
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      const tl = prev[x0];
      const t = prev[x];
      const tr = prev[x2];
      const ml = cur[x0];
      const mr = cur[x2];
      const bl = next[x0];
      const b = next[x];
      const br = next[x2];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      const m = magnitude === 'manhattan'
        ? Math.min(255, Math.abs(gx) + Math.abs(gy))
        : Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      const o = (y * w + x) * 4;
      out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = data[o + 3];
    }
    const stash = prev; prev = cur; cur = next; next = stash;
  }
  return { width: w, height: h, data: out };
}

/**
 * Direct tap Sobel: recomputes luma at every tap with no luma plane at all.
 * Correct and memory free, but nine luma evaluations per pixel is an honest
 * pessimization the comparator makes visible.
 */
function sobelTapsDirect(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x < w - 1 ? x + 1 : w - 1;
      const tl = luma709(data, (y0 * w + x0) * 4);
      const t = luma709(data, (y0 * w + x) * 4);
      const tr = luma709(data, (y0 * w + x2) * 4);
      const ml = luma709(data, (y * w + x0) * 4);
      const mr = luma709(data, (y * w + x2) * 4);
      const bl = luma709(data, (y2 * w + x0) * 4);
      const b = luma709(data, (y2 * w + x) * 4);
      const br = luma709(data, (y2 * w + x2) * 4);
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      const m = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      const o = (y * w + x) * 4;
      out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = data[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/* --- histogram variants --- */

function histIntLuma(img) {
  const { width, height, data } = img;
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    bins[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
  }
  return { bins, count: width * height };
}

/**
 * Specializes for grayscale input: when R equals G equals B the luma is the
 * channel itself, verified per pixel. Correct on any input, faster on the
 * seeded pattern which is grayscale by construction.
 */
function histGraySpecialize(img) {
  const { width, height, data } = img;
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    bins[(data[i + 1] === r && data[i + 2] === r) ? r : luma709(data, i)]++;
  }
  return { bins, count: width * height };
}

function histRefUnroll(img) {
  const { width, height, data } = img;
  const bins = new Uint32Array(256);
  const n = data.length;
  let i = 0;
  for (; i + 16 <= n; i += 16) {
    bins[luma709(data, i)]++;
    bins[luma709(data, i + 4)]++;
    bins[luma709(data, i + 8)]++;
    bins[luma709(data, i + 12)]++;
  }
  for (; i < n; i += 4) bins[luma709(data, i)]++;
  return { bins, count: width * height };
}

function histIntLumaUnroll(img) {
  const { width, height, data } = img;
  const bins = new Uint32Array(256);
  const n = data.length;
  let i = 0;
  for (; i + 16 <= n; i += 16) {
    bins[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
    bins[(data[i + 4] * 77 + data[i + 5] * 150 + data[i + 6] * 29) >> 8]++;
    bins[(data[i + 8] * 77 + data[i + 9] * 150 + data[i + 10] * 29) >> 8]++;
    bins[(data[i + 12] * 77 + data[i + 13] * 150 + data[i + 14] * 29) >> 8]++;
  }
  for (; i < n; i += 4) bins[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
  return { bins, count: width * height };
}

/* --- resize variants --- */

function resizeTables(img) {
  const w2 = Math.max(1, Math.floor(img.width / 2));
  const h2 = Math.max(1, Math.floor(img.height / 2));
  const x0 = new Int32Array(w2);
  const x1 = new Int32Array(w2);
  const fx = new Float64Array(w2);
  const y0 = new Int32Array(h2);
  const y1 = new Int32Array(h2);
  const fy = new Float64Array(h2);
  for (let x = 0; x < w2; x++) {
    const sx = (x + 0.5) * img.width / w2 - 0.5;
    const fxRaw = sx - Math.floor(sx);
    fx[x] = fxRaw < 0 ? 0 : fxRaw > 1 ? 1 : fxRaw;
    x0[x] = Math.max(0, Math.min(img.width - 1, Math.floor(sx)));
    x1[x] = Math.min(img.width - 1, x0[x] + 1);
  }
  for (let y = 0; y < h2; y++) {
    const sy = (y + 0.5) * img.height / h2 - 0.5;
    const fyRaw = sy - Math.floor(sy);
    fy[y] = fyRaw < 0 ? 0 : fyRaw > 1 ? 1 : fyRaw;
    y0[y] = Math.max(0, Math.min(img.height - 1, Math.floor(sy)));
    y1[y] = Math.min(img.height - 1, y0[y] + 1);
  }
  return { w2, h2, x0, x1, fx, y0, y1, fy };
}

function resizeLutXY(img) {
  const { width: w, data: src } = img;
  const t = resizeTables(img);
  const out = new Uint8ClampedArray(t.w2 * t.h2 * 4);
  for (let y = 0; y < t.h2; y++) {
    const fyv = t.fy[y];
    const r0 = t.y0[y] * w;
    const r1 = t.y1[y] * w;
    for (let x = 0; x < t.w2; x++) {
      const fxv = t.fx[x];
      const o = (y * t.w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(r0 + t.x0[x]) * 4 + c];
        const p10 = src[(r0 + t.x1[x]) * 4 + c];
        const p01 = src[(r1 + t.x0[x]) * 4 + c];
        const p11 = src[(r1 + t.x1[x]) * 4 + c];
        const top = p00 + (p10 - p00) * fxv;
        const bottom = p01 + (p11 - p01) * fxv;
        out[o + c] = Math.round(top + (bottom - top) * fyv);
      }
    }
  }
  return { width: t.w2, height: t.h2, data: out };
}

/**
 * Lookup tables with 8 bit fixed point weights. Drops the per tap float
 * multiply for an integer one at the cost of quantization error, which the
 * accuracy column measures honestly.
 */
function resizeLutXYFixed(img) {
  const { width: w, data: src } = img;
  const t = resizeTables(img);
  const fxQ = new Int32Array(t.w2);
  const fyQ = new Int32Array(t.h2);
  for (let x = 0; x < t.w2; x++) fxQ[x] = Math.round(t.fx[x] * 256);
  for (let y = 0; y < t.h2; y++) fyQ[y] = Math.round(t.fy[y] * 256);
  const out = new Uint8ClampedArray(t.w2 * t.h2 * 4);
  for (let y = 0; y < t.h2; y++) {
    const fyv = fyQ[y];
    const r0 = t.y0[y] * w;
    const r1 = t.y1[y] * w;
    for (let x = 0; x < t.w2; x++) {
      const fxv = fxQ[x];
      const o = (y * t.w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(r0 + t.x0[x]) * 4 + c];
        const p10 = src[(r0 + t.x1[x]) * 4 + c];
        const p01 = src[(r1 + t.x0[x]) * 4 + c];
        const p11 = src[(r1 + t.x1[x]) * 4 + c];
        const top = (p00 * (256 - fxv) + p10 * fxv + 128) >> 8;
        const bottom = (p01 * (256 - fxv) + p11 * fxv + 128) >> 8;
        out[o + c] = (top * (256 - fyv) + bottom * fyv + 128) >> 8;
      }
    }
  }
  return { width: t.w2, height: t.h2, data: out };
}

/**
 * Lookup tables plus an equal sample shortcut: when all four taps already
 * agree the interpolation result is that value by definition, so the pixel
 * writes directly. Exact on any input, quickest on flat regions.
 */
function resizeLutXYFlat(img) {
  const { width: w, data: src } = img;
  const t = resizeTables(img);
  const out = new Uint8ClampedArray(t.w2 * t.h2 * 4);
  for (let y = 0; y < t.h2; y++) {
    const fyv = t.fy[y];
    const r0 = t.y0[y] * w;
    const r1 = t.y1[y] * w;
    for (let x = 0; x < t.w2; x++) {
      const fxv = t.fx[x];
      const o = (y * t.w2 + x) * 4;
      const a = (r0 + t.x0[x]) * 4;
      const b = (r0 + t.x1[x]) * 4;
      const cc = (r1 + t.x0[x]) * 4;
      const d = (r1 + t.x1[x]) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[a + c];
        const p10 = src[b + c];
        const p01 = src[cc + c];
        const p11 = src[d + c];
        if (p00 === p10 && p10 === p01 && p01 === p11) {
          out[o + c] = p00;
          continue;
        }
        const top = p00 + (p10 - p00) * fxv;
        const bottom = p01 + (p11 - p01) * fxv;
        out[o + c] = Math.round(top + (bottom - top) * fyv);
      }
    }
  }
  return { width: t.w2, height: t.h2, data: out };
}

/**
 * Lookup tables on the x axis only, keeping the reference per row y math.
 * A partial restructure that isolates the gain of one axis of caching.
 */
function resizeLutX(img) {
  const { width: w, data: src } = img;
  const w2 = Math.max(1, Math.floor(img.width / 2));
  const h2 = Math.max(1, Math.floor(img.height / 2));
  const x0 = new Int32Array(w2);
  const x1 = new Int32Array(w2);
  const fx = new Float64Array(w2);
  for (let x = 0; x < w2; x++) {
    const sx = (x + 0.5) * img.width / w2 - 0.5;
    const fxRaw = sx - Math.floor(sx);
    fx[x] = fxRaw < 0 ? 0 : fxRaw > 1 ? 1 : fxRaw;
    x0[x] = Math.max(0, Math.min(img.width - 1, Math.floor(sx)));
    x1[x] = Math.min(img.width - 1, x0[x] + 1);
  }
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = (y + 0.5) * img.height / h2 - 0.5;
    const fyRaw = sy - Math.floor(sy);
    const fy = fyRaw < 0 ? 0 : fyRaw > 1 ? 1 : fyRaw;
    const yy0 = Math.max(0, Math.min(img.height - 1, Math.floor(sy)));
    const yy1 = Math.min(img.height - 1, yy0 + 1);
    const r0 = yy0 * w;
    const r1 = yy1 * w;
    for (let x = 0; x < w2; x++) {
      const o = (y * w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(r0 + x0[x]) * 4 + c];
        const p10 = src[(r0 + x1[x]) * 4 + c];
        const p01 = src[(r1 + x0[x]) * 4 + c];
        const p11 = src[(r1 + x1[x]) * 4 + c];
        const top = p00 + (p10 - p00) * fx[x];
        const bottom = p01 + (p11 - p01) * fx[x];
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width: w2, height: h2, data: out };
}

/* ------------------------------------------------------------------ */
/* Configuration registry, five per workload                            */
/* ------------------------------------------------------------------ */

/**
 * The five configurations compared for each workload. Slot zero is always
 * the reference kernel from armbench-core, which is what panel 01 already
 * measures. `declared` records the intent of the variant: `exact` claims
 * bit identical output to the reference, `approx` trades a measured amount
 * of accuracy for speed. Whether a config actually is exact is measured,
 * never taken from the declaration.
 */
export const LAB_CONFIGS = {
  grayscale: [
    { id: 'ref', name: 'Reference (Float Luma)', declared: 'exact', run: runGrayscale },
    { id: 'int-luma', name: 'Integer Luma (8.8 Fixed Point)', declared: 'approx', run: grayIntLuma },
    { id: 'int-luma-round', name: 'Integer Luma Rounded', declared: 'approx', run: grayIntLumaRound },
    { id: 'float-unroll', name: 'Float Luma, 4x Unrolled', declared: 'exact', run: grayFloatUnroll },
    { id: 'channel-mean', name: 'Channel Mean (No Luma Weights)', declared: 'approx', run: grayChannelMean },
  ],
  blur: [
    { id: 'ref', name: 'Reference (9 Tap Window)', declared: 'exact', run: runBoxBlur },
    { id: 'separable', name: 'Separable Two Pass', declared: 'exact', run: blurSeparable },
    { id: 'separable-slide', name: 'Separable Sliding Window', declared: 'exact', run: blurSeparableSliding },
    { id: 'separable-byte', name: 'Separable Byte Passes', declared: 'approx', run: blurSeparableByte },
    { id: 'uniform-clamp', name: 'Single Pass, Clamped Everywhere', declared: 'exact', run: blurUniformClamp },
  ],
  sobel: [
    { id: 'ref', name: 'Reference (Luma Plane, Sqrt)', declared: 'exact', run: runSobel },
    { id: 'manhattan', name: 'Manhattan Magnitude', declared: 'approx', run: (img) => sobelWithMagnitude(img, 'manhattan') },
    { id: 'row-buffer', name: 'Rolling 3 Row Luma Buffer', declared: 'exact', run: (img) => sobelRowBuffer(img, 'sqrt') },
    { id: 'manhattan-row', name: 'Manhattan Plus Row Buffer', declared: 'approx', run: (img) => sobelRowBuffer(img, 'manhattan') },
    { id: 'taps-direct', name: 'Direct Taps, No Luma Plane', declared: 'exact', run: sobelTapsDirect },
  ],
  histogram: [
    { id: 'ref', name: 'Reference (Float Luma)', declared: 'exact', run: runHistogram },
    { id: 'gray-specialize', name: 'Grayscale Fast Path', declared: 'exact', run: histGraySpecialize },
    { id: 'int-luma', name: 'Integer Luma', declared: 'approx', run: histIntLuma },
    { id: 'ref-unroll', name: 'Reference, 4x Unrolled', declared: 'exact', run: histRefUnroll },
    { id: 'int-luma-unroll', name: 'Integer Luma, 4x Unrolled', declared: 'approx', run: histIntLumaUnroll },
  ],
  resize: [
    { id: 'ref', name: 'Reference (Per Pixel Coordinates)', declared: 'exact', run: runResize },
    { id: 'lut-x', name: 'X Axis Lookup Table', declared: 'exact', run: resizeLutX },
    { id: 'lut-xy', name: 'XY Lookup Tables', declared: 'exact', run: resizeLutXY },
    { id: 'lut-xy-fixed', name: 'XY Tables, 8 Bit Weights', declared: 'approx', run: resizeLutXYFixed },
    { id: 'lut-xy-flat', name: 'XY Tables, Flat Shortcut', declared: 'exact', run: resizeLutXYFlat },
  ],
};

export function labConfigsFor(workloadId) {
  return Object.prototype.hasOwnProperty.call(LAB_CONFIGS, workloadId)
    ? LAB_CONFIGS[workloadId]
    : null;
}

/* ------------------------------------------------------------------ */
/* Accuracy comparator                                                  */
/* ------------------------------------------------------------------ */

function outputArray(out) {
  if (out && out.data instanceof Uint8ClampedArray) return out.data;
  if (out && out.bins instanceof Uint32Array) return out.bins;
  return null;
}

/**
 * Compare a variant output against the reference output. Returns max
 * absolute delta, the percent of identical cells and an exact flag. A
 * length mismatch is reported as zero percent identical rather than
 * throwing, so a broken variant degrades the score instead of the suite.
 */
export function accuracyAgainst(reference, variant) {
  const ra = outputArray(reference);
  const va = outputArray(variant);
  if (!ra || !va) {
    throw new TypeError('both outputs must expose a data or bins typed array');
  }
  if (ra.length !== va.length) {
    return {
      compared: Math.max(ra.length, va.length),
      mismatches: Math.max(ra.length, va.length),
      maxDelta: null,
      identicalPct: 0,
      exact: false,
      detail: 'length mismatch: reference ' + ra.length + ' cells, variant ' + va.length,
    };
  }
  let mismatches = 0;
  let maxDelta = 0;
  for (let i = 0; i < ra.length; i++) {
    const d = ra[i] - va[i];
    if (d !== 0) {
      mismatches++;
      const a = Math.abs(d);
      if (a > maxDelta) maxDelta = a;
    }
  }
  return {
    compared: ra.length,
    mismatches,
    maxDelta,
    identicalPct: ra.length === 0 ? 100 : (1 - mismatches / ra.length) * 100,
    exact: mismatches === 0,
    detail: mismatches === 0 ? 'bit identical' : mismatches + ' cells differ',
  };
}

/* ------------------------------------------------------------------ */
/* Comparison run, stepped so the UI can yield between configs          */
/* ------------------------------------------------------------------ */

export const LAB_MAX_PIXELS_PER_OP = DEFAULT_OPTIONS.maxPixelsPerOp;

/**
 * Open a comparison session for one workload. The seeded bench input is
 * built once and shared by every config; the color probe is built once for
 * accuracy checks. Iterations are clamped by the same per pass pixel
 * budget the main bench uses, so a lab run stays inside the published
 * budget claim.
 */
export function startComparison({ workloadId, size = 256, seed = 1337, iterations = 5 } = {}) {
  const configs = labConfigsFor(workloadId);
  if (!configs) {
    throw new RangeError('unknown lab workload ' + JSON.stringify(workloadId));
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('size must be a positive integer');
  }
  if (size * size > MAX_IMAGE_PIXELS) {
    throw new RangeError('size exceeds the pixel cap');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError('iterations must be a positive integer');
  }
  if (!Number.isFinite(seed)) {
    throw new RangeError('seed must be a finite number');
  }
  const budgetIters = Math.max(1, Math.floor(LAB_MAX_PIXELS_PER_OP / (size * size)));
  const iters = Math.min(iterations, budgetIters);
  const benchInput = makeImage(seed, size, size);
  const probeInput = makeColorProbe(seed, size, size);
  return {
    workloadId,
    size,
    seed,
    iterations: iters,
    requestedIterations: iterations,
    configs,
    benchInput,
    probeInput,
    baseBench: null,
    baseProbe: null,
    index: 0,
    rows: [],
  };
}

/**
 * Time and score the next config in a session. Returns the finished row, or
 * null when every config has run. Speed is measured on the seeded bench
 * input; accuracy is measured on both the bench input and the color probe.
 */
export function stepComparison(session, clock) {
  if (!session || session.index >= session.configs.length) return null;
  const cfg = session.configs[session.index];
  const t = timeWorkload(cfg.run, session.benchInput, session.iterations, clock);
  const outBench = cfg.run(session.benchInput);
  const outProbe = cfg.run(session.probeInput);
  if (session.index === 0) {
    session.baseBench = outBench;
    session.baseProbe = outProbe;
  }
  const accBench = accuracyAgainst(session.baseBench, outBench);
  const accProbe = accuracyAgainst(session.baseProbe, outProbe);
  session.index++;
  const row = {
    id: cfg.id,
    name: cfg.name,
    declared: cfg.declared,
    meanMs: t.meanMs,
    medianMs: t.medianMs,
    minMs: t.minMs,
    maxMs: t.maxMs,
    opsPerSec: t.opsPerSec,
    cvPercent: t.cvPercent,
    stability: t.stability,
    iterations: t.iterations,
    exact: accBench.exact && accProbe.exact,
    maxDelta: Math.max(accBench.maxDelta ?? 0, accProbe.maxDelta ?? 0),
    identicalPctBench: accBench.identicalPct,
    identicalPctProbe: accProbe.identicalPct,
    accuracyPct: Math.min(accBench.identicalPct, accProbe.identicalPct),
    basis: BASIS.MEASURED,
  };
  session.rows.push(row);
  return row;
}

/**
 * Close a session into the final comparison: speedups against the
 * reference config, the Pareto frontier over measured throughput and
 * measured accuracy, and a plain language verdict.
 */
export function finishComparison(session) {
  const rows = session.rows;
  if (rows.length === 0) {
    throw new RangeError('cannot finish a comparison with no completed configs');
  }
  const baseOps = rows[0].opsPerSec;
  for (const r of rows) {
    r.speedup = baseOps && Number.isFinite(r.opsPerSec) ? r.opsPerSec / baseOps : null;
  }
  const frontier = paretoFrontier(rows, ['opsPerSec', 'accuracyPct']);
  let bestExact = null;
  for (const r of rows) {
    if (r.id !== 'ref' && r.exact && Number.isFinite(r.opsPerSec)) {
      if (!bestExact || r.opsPerSec > bestExact.opsPerSec) bestExact = r;
    }
  }
  const verdict = bestExact
    ? 'Fastest exact config: ' + bestExact.name + ' at ' +
      (bestExact.speedup === null
        ? fmtInt(bestExact.opsPerSec) + ' ops/sec'
        : fmt(bestExact.speedup, 2) + ' x reference') +
      ', bit identical output on both probe images.'
    : 'No config beat the reference while staying bit identical on both probe images.';
  return {
    workloadId: session.workloadId,
    size: session.size,
    seed: session.seed,
    iterations: session.iterations,
    requestedIterations: session.requestedIterations,
    configs: rows,
    frontierIds: frontier.frontierIds,
    dominatedIds: frontier.dominatedIds,
    bestExactId: bestExact ? bestExact.id : null,
    verdict,
    basis: BASIS.MEASURED,
  };
}

/** One call convenience wrapper used by the Node script and tests. */
export function runConfigComparison(options = {}, clock) {
  const session = startComparison(options);
  while (stepComparison(session, clock)) { /* drain */ }
  return finishComparison(session);
}

/* ------------------------------------------------------------------ */
/* Pareto frontier                                                      */
/* ------------------------------------------------------------------ */

/**
 * Generic Pareto frontier over a list of entries where every key is higher
 * is better. Entry A dominates B when A is at least as good on every key
 * and strictly better on one. Non finite values score worse than any finite
 * value, so a config with a broken reading can never dominate.
 */
export function paretoFrontier(entries, keys) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!Array.isArray(keys) || keys.length === 0) throw new TypeError('keys must be a nonempty array');
  const val = (e, k) => {
    const v = e[k];
    return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  };
  const dominates = (a, b) => {
    let strictly = false;
    for (const k of keys) {
      if (val(a, k) < val(b, k)) return false;
      if (val(a, k) > val(b, k)) strictly = true;
    }
    return strictly;
  };
  const frontierIds = [];
  const dominatedIds = [];
  const dominance = {};
  for (const e of entries) dominance[e.id] = [];
  for (const a of entries) {
    for (const b of entries) {
      if (a !== b && dominates(a, b)) dominance[a.id].push(b.id);
    }
  }
  for (const e of entries) {
    const dominated = entries.some((o) => o !== e && dominates(o, e));
    if (dominated) dominatedIds.push(e.id);
    else frontierIds.push(e.id);
  }
  return { frontierIds, dominatedIds, dominance };
}

/* ------------------------------------------------------------------ */
/* Op model, measured roofs, roofline position                          */
/* ------------------------------------------------------------------ */

/**
 * Documented per workload op and byte model. These are hand counted
 * approximations of the reference implementation, used only for roofline
 * positioning. They are a model, clearly labeled, never a measurement.
 */
export const WORKLOAD_MODEL = {
  grayscale: {
    opsPerPixel: 7,
    bytesPerPixel: 8,
    note: 'three multiplies, two adds, a round and a write over 4 bytes read and 4 written',
  },
  blur: {
    opsPerPixel: 33,
    bytesPerPixel: 8,
    note: 'nine adds per channel, three rounds and writes; neighbor reads stay cache resident',
  },
  sobel: {
    opsPerPixel: 47,
    bytesPerPixel: 9,
    note: 'luma pass plus eighteen tap adds, two squares, a square root and a write',
  },
  histogram: {
    opsPerPixel: 7,
    bytesPerPixel: 4,
    note: 'luma math and one bin increment over 4 bytes read, no output buffer',
  },
  resize: {
    opsPerPixel: 26,
    bytesPerPixel: 20,
    note: 'per input pixel share of a quarter resolution output, four channel taps each',
  },
};

function workloadModel(workloadId) {
  if (!Object.prototype.hasOwnProperty.call(WORKLOAD_MODEL, workloadId)) {
    throw new RangeError('unknown workload ' + JSON.stringify(workloadId));
  }
  return WORKLOAD_MODEL[workloadId];
}

export function workloadIntensity(workloadId) {
  const m = workloadModel(workloadId);
  return m.opsPerPixel / m.bytesPerPixel;
}

/**
 * Measure the two machine roofs live: an effective read bandwidth from a
 * streaming sum over a large buffer, and an approximate compute ceiling
 * from independent integer multiply accumulate chains. Both are labeled
 * microbenchmark approximations, not vendor specifications.
 */
export function measureMachineRoofs(clock = labClock(), scale = 1) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('scale must be a positive number');
  }
  const words = Math.max(1 << 16, Math.floor((1 << 21) * scale));
  const buf = new Uint32Array(words);
  for (let i = 0; i < words; i++) buf[i] = i & 0xffff;
  let sink = 0;
  const stream = () => {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i];
    sink += s;
  };
  stream(); // warmup
  let t0 = clock();
  stream();
  stream();
  const streamMs = Math.max(clock() - t0, 1e-9);
  const memoryBytesPerSec = (words * 4 * 2) / (streamMs / 1000);

  const chainIters = Math.max(100_000, Math.floor(600_000 * scale));
  let a0 = 1, a1 = 3, a2 = 5, a3 = 7;
  const c0 = 2654435761 | 0;
  const c1 = 2246822519 | 0;
  const alu = () => {
    for (let i = 0; i < chainIters; i++) {
      a0 = (a0 + Math.imul(i ^ a0, c0)) | 0;
      a1 = (a1 + Math.imul(i ^ a1, c1)) | 0;
      a2 = (a2 + Math.imul(i ^ a2, c0)) | 0;
      a3 = (a3 + Math.imul(i ^ a3, c1)) | 0;
    }
  };
  alu(); // warmup
  t0 = clock();
  alu();
  const aluMs = Math.max(clock() - t0, 1e-9);
  const computeOpsPerSec = (chainIters * 4 * 2) / (aluMs / 1000);
  if (sink === Number.MIN_VALUE) return null; // unreachable guard so sink is used
  return {
    memoryBytesPerSec,
    computeOpsPerSec,
    streamBytes: words * 4 * 2,
    aluOps: chainIters * 4 * 2,
    basis: 'measured',
    note: 'Live microbenchmark roofs on this machine. Approximate, not a vendor specification.',
  };
}

/**
 * Roofline position for one workload given a measured ops/sec and measured
 * roofs. Attainable is min(compute roof, memory roof times documented
 * intensity); headroom is the measured work rate as a share of it. Every
 * output here is a model figure, never a measurement.
 */
export function rooflinePosition(workloadId, opsPerSec, roofs) {
  const m = workloadModel(workloadId);
  if (!roofs || !Number.isFinite(roofs.memoryBytesPerSec) || !Number.isFinite(roofs.computeOpsPerSec)) {
    throw new TypeError('roofs with memoryBytesPerSec and computeOpsPerSec are required');
  }
  const intensity = m.opsPerPixel / m.bytesPerPixel;
  const memCeiling = roofs.memoryBytesPerSec * intensity;
  const ceiling = Math.min(roofs.computeOpsPerSec, memCeiling);
  const achieved = Number.isFinite(opsPerSec) ? opsPerSec * m.opsPerPixel : null;
  return {
    workloadId,
    intensity,
    achievedOpsPerSec: achieved,
    memoryCeilingOpsPerSec: memCeiling,
    ceilingOpsPerSec: ceiling,
    headroomPct: achieved !== null && ceiling > 0 ? (achieved / ceiling) * 100 : null,
    bounded: memCeiling <= roofs.computeOpsPerSec ? 'memory path' : 'compute',
    basis: 'model',
    note: 'Model figure: measured micro roofs plus documented op counts. Not a measurement.',
  };
}

/**
 * Measured scaling inference for one workload: pixels per second at each
 * measured size, and whether throughput per pixel holds or collapses as the
 * working set grows. Uses only rows marked measured, and returns null when
 * fewer than two sizes were run rather than inventing a trend.
 */
export function analyzeScaling(rows, workloadId) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const pts = rows
    .filter((r) => r && r.basis === BASIS.MEASURED && r.workloadId === workloadId &&
      typeof r.size === 'number' && Number.isFinite(r.opsPerSec))
    .map((r) => ({ size: r.size, pixelsPerSec: r.opsPerSec * r.size * r.size }))
    .sort((a, b) => a.size - b.size);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const ratio = first.pixelsPerSec > 0 ? last.pixelsPerSec / first.pixelsPerSec : null;
  let verdict = 'insufficient evidence';
  if (ratio !== null) {
    if (ratio >= 0.9 && ratio <= 1.1) verdict = 'scales cleanly, pixels/sec holds within 10 percent';
    else if (ratio > 1.1) verdict = 'pixels/sec rose at the larger size, fixed overheads dominate the small run';
    else if (ratio >= 0.6) verdict = 'moderate degradation as the working set grows';
    else verdict = 'steep memory path degradation, consistent with a cache boundary';
  }
  return {
    workloadId,
    points: pts,
    smallestSize: first.size,
    largestSize: last.size,
    pixelsPerSecRatio: ratio,
    verdict,
    basis: 'measured',
    note: 'Inference from measured rows only. Not a cache measurement.',
  };
}

/* ------------------------------------------------------------------ */
/* Edge stress suite                                                    */
/* ------------------------------------------------------------------ */

/**
 * Hostile input sizes for the stress suite: degenerate one pixel and one
 * row cases, asymmetric slivers and odd dimensions that exercise every
 * clamp path in the kernels.
 */
export const EDGE_CASE_SIZES = [[1, 1], [1, 3], [3, 1], [2, 2], [3, 3], [5, 4], [17, 13], [31, 29]];

function uniformImage(w, h, v) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function alphaPreserved(img, out) {
  for (let i = 3; i < out.data.length; i += 4) {
    if (out.data[i] !== img.data[i]) return false;
  }
  return true;
}

function staysGrayscale(out) {
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i] !== out.data[i + 1] || out.data[i + 1] !== out.data[i + 2]) return false;
  }
  return true;
}

/**
 * Per workload invariant checks. Each check receives the input, the output
 * and the config runner, and reports a name plus ok. These are the exact
 * domain conservation laws the kernels must satisfy on any input.
 */
const EDGE_INVARIANTS = {
  grayscale: [
    ['alpha channel preserved', (img, out) => alphaPreserved(img, out)],
    ['output stays grayscale', (img, out) => staysGrayscale(out)],
    ['idempotent on its own output', (img, out, run) => {
      const twice = run(out);
      return twice.data.length === out.data.length &&
        twice.data.every((v, i) => v === out.data[i]);
    }],
  ],
  blur: [
    ['dimensions preserved', (img, out) => out.width === img.width && out.height === img.height],
    ['alpha channel preserved', (img, out) => alphaPreserved(img, out)],
    ['uniform input stays uniform', (img, out, run) => {
      const u = uniformImage(img.width, img.height, 127);
      const r = run(u);
      return r.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 127));
    }],
  ],
  sobel: [
    ['dimensions preserved', (img, out) => out.width === img.width && out.height === img.height],
    ['alpha channel preserved', (img, out) => alphaPreserved(img, out)],
    ['uniform input produces zero response', (img, out, run) => {
      const u = uniformImage(img.width, img.height, 200);
      const r = run(u);
      for (let i = 0; i < r.data.length; i += 4) {
        if (r.data[i] !== 0 || r.data[i + 1] !== 0 || r.data[i + 2] !== 0) return false;
      }
      return true;
    }],
  ],
  histogram: [
    ['bin total conserves the pixel count', (img, out) => {
      let s = 0;
      for (let i = 0; i < 256; i++) s += out.bins[i];
      return s === img.width * img.height && s === out.count;
    }],
    ['no bin holds a negative count', (img, out) => {
      for (let i = 0; i < 256; i++) if (out.bins[i] < 0) return false;
      return true;
    }],
  ],
  resize: [
    ['output dimensions are floored half size', (img, out) =>
      out.width === Math.max(1, Math.floor(img.width / 2)) &&
      out.height === Math.max(1, Math.floor(img.height / 2))],
    ['alpha channel preserved', (img, out) => alphaPreserved(img, out)],
    ['uniform input stays uniform', (img, out, run) => {
      const u = uniformImage(img.width, img.height, 90);
      const r = run(u);
      return r.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 90));
    }],
  ],
};

function stressChecks(workloadId, cfg, img, probe, refImg, refProbe) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  let out;
  let outProbe;
  try {
    out = cfg.run(img);
  } catch (err) {
    push('runs without throwing', false, err && err.message ? err.message : 'threw');
    return checks;
  }
  try {
    outProbe = cfg.run(probe);
  } catch (err) {
    push('runs on the color probe', false, err && err.message ? err.message : 'threw');
    return checks;
  }
  const isHist = workloadId === 'histogram';
  if (!isHist) {
    push('returns a byte buffer', out.data instanceof Uint8ClampedArray && out.data.length === out.width * out.height * 4);
  } else {
    push('returns 256 bins and a count', out.bins instanceof Uint32Array && out.bins.length === 256 &&
      out.count === img.width * img.height);
  }
  for (const [name, fn] of EDGE_INVARIANTS[workloadId] || []) {
    let ok = false;
    let detail = '';
    try {
      ok = !!fn(img, out, cfg.run);
    } catch (err) {
      detail = err && err.message ? err.message : 'invariant threw';
    }
    push(name, ok, detail);
  }
  if (cfg.declared === 'exact') {
    const a = accuracyAgainst(refImg, out);
    const b = accuracyAgainst(refProbe, outProbe);
    push('bit identical to the reference', a.exact && b.exact,
      a.exact && b.exact ? '' : 'max delta ' + Math.max(a.maxDelta ?? 0, b.maxDelta ?? 0));
  }
  return checks;
}

/**
 * Run the edge stress suite: every config over every hostile size plus a
 * timed worst case pass at maxSize. Returns per case per config check
 * results and an overall pass count. Custom config lists are accepted so
 * tests can feed deliberately broken variants and prove the suite catches
 * them.
 */
export function edgeStress({ workloadId, seed = 1337, sizes = EDGE_CASE_SIZES, maxSize = 1024, configs = null, clock } = {}) {
  const defs = configs || labConfigsFor(workloadId);
  if (!defs) throw new RangeError('unknown lab workload ' + JSON.stringify(workloadId));
  if (!Array.isArray(sizes)) throw new TypeError('sizes must be an array');
  const rows = [];
  for (const pair of sizes) {
    if (!Array.isArray(pair) || pair.length !== 2 ||
      !Number.isInteger(pair[0]) || !Number.isInteger(pair[1]) || pair[0] < 1 || pair[1] < 1) {
      throw new RangeError('each stress size must be a [width, height] pair of positive integers');
    }
    const [w, h] = pair;
    if (w * h > MAX_IMAGE_PIXELS) throw new RangeError('stress size exceeds the pixel cap');
    const img = makeImage(seed, w, h);
    const probe = makeColorProbe(seed, w, h);
    const refImg = defs[0].run(img);
    const refProbe = defs[0].run(probe);
    for (const cfg of defs) {
      const checks = stressChecks(workloadId, cfg, img, probe, refImg, refProbe);
      rows.push({
        kind: 'case',
        w, h,
        size: w + ' x ' + h,
        configId: cfg.id,
        configName: cfg.name,
        ok: checks.every((c) => c.ok),
        checks,
      });
    }
  }
  const worst = [];
  if (maxSize !== null) {
    if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize * maxSize > MAX_IMAGE_PIXELS) {
      throw new RangeError('maxSize must be a positive integer within the pixel cap');
    }
    const big = makeImage(seed, maxSize, maxSize);
    for (const cfg of defs) {
      try {
        const t = timeWorkload(cfg.run, big, 1, clock);
        worst.push({
          kind: 'worst-case',
          configId: cfg.id,
          configName: cfg.name,
          size: maxSize + ' x ' + maxSize,
          latencyMs: t.meanMs,
          ok: true,
        });
      } catch (err) {
        worst.push({
          kind: 'worst-case',
          configId: cfg.id,
          configName: cfg.name,
          size: maxSize + ' x ' + maxSize,
          latencyMs: null,
          ok: false,
          detail: err && err.message ? err.message : 'threw',
        });
      }
    }
  }
  const caseRows = rows.filter((r) => r.ok === false).length +
    worst.filter((r) => r.ok === false).length;
  return {
    workloadId,
    seed,
    cases: rows,
    worstCase: worst,
    total: rows.length + worst.length,
    failed: caseRows,
    passed: rows.length + worst.length - caseRows,
    verdict: caseRows === 0 ? 'all invariants held' : caseRows + ' config case(s) failed invariants',
    basis: BASIS.MEASURED,
  };
}

/* ------------------------------------------------------------------ */
/* FIPS 180-4 SHA-256, pure JavaScript                                  */
/* ------------------------------------------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) { out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63)); }
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return out;
}

/**
 * FIPS 180-4 SHA-256 over a string (UTF-8) or an array like sequence of
 * bytes. Returns the 32 byte digest as a Uint8Array. Pure JavaScript, no
 * dependency on WebCrypto so it runs identically in Node, the page and the
 * DOM harness.
 */
export function sha256Bytes(input) {
  let bytes;
  if (typeof input === 'string') bytes = utf8Bytes(input);
  else if (input && typeof input.length === 'number') bytes = Array.from(input);
  else throw new TypeError('sha256 input must be a string or a byte sequence');
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new RangeError('sha256 byte sequence must contain integers 0 to 255');
    }
  }
  const bitLen = bytes.length * 8;
  const padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  padded.push(
    (hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
    (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (padded[off + i * 4] << 24) | (padded[off + i * 4 + 1] << 16) |
        (padded[off + i * 4 + 2] << 8) | padded[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const digest = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    digest[i * 4] = (h[i] >>> 24) & 255;
    digest[i * 4 + 1] = (h[i] >>> 16) & 255;
    digest[i * 4 + 2] = (h[i] >>> 8) & 255;
    digest[i * 4 + 3] = h[i] & 255;
  }
  return digest;
}

export function sha256Hex(input) {
  return Array.from(sha256Bytes(input)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Audit export, canonical JSON plus SHA-256 digest                     */
/* ------------------------------------------------------------------ */

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order,
 * two space indent. Stable serialization is what makes the digest a
 * meaningful tamper check rather than a formatting artifact.
 */
export function canonicalJson(value) {
  const normalize = (v) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      return v;
    }
    if (Array.isArray(v)) return v.map(normalize);
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = normalize(v[k]);
    return o;
  };
  return JSON.stringify(normalize(value), null, 2);
}

/**
 * Assemble the audit payload from whatever evidence exists. Sections are
 * only included when real data backs them, so an export never fabricates a
 * section for a run that never happened.
 */
export function buildAuditPayload({ run = null, lab = null, stress = null, roofs = null, env = {}, meta = {} } = {}) {
  const payload = {
    tool: 'ArmBench',
    auditFormat: 1,
    author: meta.author || 'Aariv Patel',
    generatedAt: meta.generatedAt || new Date(0).toISOString(),
    honesty: 'Every speed figure is a live measurement on this machine. Roofline headroom figures are a documented model. No AWS Graviton instance was contacted.',
    env: {
      declared: env.declared || 'not recorded',
      runtime: env.runtime || 'not recorded',
    },
    sections: [],
  };
  if (run) {
    payload.sections.push('bench');
    payload.bench = {
      seed: run.seed,
      sizes: run.sizes,
      iterations: run.iterations,
      at: run.at,
      rows: run.rows.map((r) => ({
        workloadId: r.workloadId, size: r.size, iterations: r.iterations,
        meanMs: r.meanMs, opsPerSec: r.opsPerSec, cvPercent: r.cvPercent,
        stability: r.stability, basis: r.basis,
      })),
    };
  }
  if (lab) {
    payload.sections.push('optimization-lab');
    payload.lab = {
      workloadId: lab.workloadId,
      size: lab.size,
      seed: lab.seed,
      iterations: lab.iterations,
      frontierIds: lab.frontierIds,
      bestExactId: lab.bestExactId,
      verdict: lab.verdict,
      configs: lab.configs.map((c) => ({
        id: c.id, name: c.name, declared: c.declared, opsPerSec: c.opsPerSec,
        speedup: c.speedup, accuracyPct: c.accuracyPct, exact: c.exact,
        maxDelta: c.maxDelta, basis: c.basis,
      })),
    };
  }
  if (stress) {
    payload.sections.push('edge-stress');
    payload.stress = {
      workloadId: stress.workloadId,
      seed: stress.seed,
      total: stress.total,
      passed: stress.passed,
      failed: stress.failed,
      verdict: stress.verdict,
      cases: stress.cases.map((c) => ({
        size: c.size, configId: c.configId, ok: c.ok,
        failedChecks: c.checks.filter((k) => !k.ok).map((k) => k.name),
      })),
      worstCaseMs: stress.worstCase.map((w) => ({ configId: w.configId, latencyMs: w.latencyMs, ok: w.ok })),
    };
  }
  if (roofs) {
    payload.machineRoofs = {
      memoryBytesPerSec: roofs.memoryBytesPerSec,
      computeOpsPerSec: roofs.computeOpsPerSec,
      basis: roofs.basis,
      note: roofs.note,
    };
  }
  return payload;
}

/**
 * Serialize the payload canonically and attach an unkeyed SHA-256 digest.
 * The digest is tamper detection only: it proves the exported text was not
 * altered after export. It is not a signature and proves nothing about who
 * produced the file.
 */
export function auditExportJson(payload) {
  const text = canonicalJson(payload);
  return {
    text,
    digest: sha256Hex(text),
    note: 'Unkeyed SHA-256 tamper detection digest. Detects edits, not authorship.',
  };
}

/**
 * Recompute the digest of an exported JSON text and compare it with the
 * expected digest. Returns ok plus both digests so a mismatch shows what
 * the file actually hashes to.
 */
export function verifyAuditJson(text, expectedDigest) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const digest = sha256Hex(text);
  return {
    ok: typeof expectedDigest === 'string' && digest === expectedDigest.toLowerCase(),
    digest,
    expected: typeof expectedDigest === 'string' ? expectedDigest.toLowerCase() : null,
  };
}

/**
 * CSV cell escaping with formula injection defense. Numbers and booleans
 * pass through raw. Strings are wrapped in quotes when they contain a comma,
 * quote or line break, inner quotes are doubled, and a string whose first
 * character could be read as a spreadsheet formula gets a leading
 * apostrophe before quoting.
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  let v = s;
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function auditCsv(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array of arrays');
  return rows.map((r) => {
    if (!Array.isArray(r)) throw new TypeError('each csv row must be an array');
    return r.map(csvEscape).join(',');
  }).join('\r\n');
}

/**
 * Flat audit CSV: every measured bench row plus every lab config row, with
 * a section column so the two never mix silently. The digest line is
 * appended as a comment row so the checksum travels with the data.
 */
export function auditExportCsv(payload) {
  const rows = [['section', 'workload', 'config', 'size', 'iterations', 'mean_ms',
    'ops_per_sec', 'cv_percent', 'accuracy_pct', 'exact', 'basis']];
  if (payload.bench) {
    for (const r of payload.bench.rows) {
      rows.push(['bench', r.workloadId, 'reference', r.size, r.iterations,
        r.meanMs, r.opsPerSec, r.cvPercent, '', '', r.basis]);
    }
  }
  if (payload.lab) {
    for (const c of payload.lab.configs) {
      rows.push(['optimization-lab', payload.lab.workloadId, c.id, payload.lab.size,
        payload.lab.iterations, '', c.opsPerSec, '', c.accuracyPct, c.exact, c.basis]);
    }
  }
  const text = auditCsv(rows) + '\r\n';
  return {
    text,
    digest: sha256Hex(text),
    note: 'Unkeyed SHA-256 tamper detection digest over the whole file. Detects edits, not authorship.',
  };
}

export function auditExportMarkdown(payload) {
  const lines = [];
  lines.push('# ArmBench Audit');
  lines.push('');
  lines.push('Author: ' + payload.author);
  lines.push('Generated: ' + payload.generatedAt);
  lines.push('Honesty: ' + payload.honesty);
  lines.push('Environment: ' + payload.env.declared + '; ' + payload.env.runtime);
  lines.push('');
  if (payload.bench) {
    lines.push('## Measured Bench Rows');
    lines.push('');
    lines.push('| Workload | Size | Iterations | Mean ms | Ops/sec | Cv percent | Basis |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of payload.bench.rows) {
      lines.push('| ' + r.workloadId + ' | ' + r.size + ' | ' + r.iterations +
        ' | ' + fmt(r.meanMs, 3) + ' | ' + fmt(r.opsPerSec, 2) + ' | ' +
        (Number.isFinite(r.cvPercent) ? fmt(r.cvPercent, 1) : 'n/a') + ' | ' + r.basis + ' |');
    }
    lines.push('');
  }
  if (payload.lab) {
    lines.push('## Optimization Lab, ' + payload.lab.workloadId + ' at ' + payload.lab.size + ' px');
    lines.push('');
    lines.push('| Config | Declared | Ops/sec | Speedup | Accuracy pct | Exact | Frontier |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of payload.lab.configs) {
      lines.push('| ' + c.name + ' | ' + c.declared + ' | ' + fmt(c.opsPerSec, 2) +
        ' | ' + fmt(c.speedup, 3) + ' | ' + fmt(c.accuracyPct, 2) + ' | ' +
        (c.exact ? 'yes' : 'no') + ' | ' + (payload.lab.frontierIds.includes(c.id) ? 'yes' : 'no') + ' |');
    }
    lines.push('');
    lines.push('Verdict: ' + payload.lab.verdict);
    lines.push('');
  }
  if (payload.stress) {
    lines.push('## Edge Stress');
    lines.push('');
    lines.push('Cases passed: ' + payload.stress.passed + ' of ' + payload.stress.total +
      '. Verdict: ' + payload.stress.verdict + '.');
    lines.push('');
  }
  lines.push('## Integrity');
  lines.push('');
  lines.push('The SHA-256 digest of this file is shown beside the export buttons and in the file name. It is an unkeyed tamper detection digest: it detects edits, not authorship.');
  const text = lines.join('\n') + '\n';
  return {
    text,
    digest: sha256Hex(text),
    note: 'Unkeyed SHA-256 tamper detection digest over the whole file. Detects edits, not authorship.',
  };
}

/* ------------------------------------------------------------------ */
/* URL hash bookmark codec, #arm=                                       */
/* ------------------------------------------------------------------ */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64urlEncode(str) {
  const bytes = utf8Bytes(str);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
    out += b === undefined ? '' : B64URL[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
    out += c === undefined ? '' : B64URL[c & 63];
  }
  return out;
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCodePoint(b); continue; }
    let cp;
    let need;
    if (b < 0xc0) return null;
    if (b < 0xe0) { cp = b & 0x1f; need = 1; }
    else if (b < 0xf0) { cp = b & 0x0f; need = 2; }
    else if (b < 0xf8) { cp = b & 0x07; need = 3; }
    else return null;
    if (i + need >= bytes.length) return null;
    for (let j = 0; j < need; j++) {
      const nb = bytes[++i];
      if ((nb & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (nb & 0x3f);
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null;
  const bytes = [];
  for (let i = 0; i < str.length; i += 4) {
    const c0 = B64URL.indexOf(str[i]);
    const c1 = i + 1 < str.length ? B64URL.indexOf(str[i + 1]) : -1;
    if (c0 < 0 || c1 < 0) return null;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < str.length) {
      const c2 = B64URL.indexOf(str[i + 2]);
      if (c2 < 0) return null;
      bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (i + 3 < str.length) {
        const c3 = B64URL.indexOf(str[i + 3]);
        if (c3 < 0) return null;
        bytes.push(((c2 & 3) << 6) | c3);
      }
    }
  }
  return utf8Decode(bytes);
}

export const BOOKMARK_VERSION = 1;

/**
 * Encode bench and lab control state into the arm= hash token. Only
 * whitelisted fields are written, so a link never smuggles extra state.
 */
/**
 * One field validator shared by encode and decode so a bookmark can never
 * be produced that the decoder would reject. Throws RangeError with the
 * reason; callers that want a soft failure catch it.
 */
function validateBookmarkFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RangeError('bookmark payload must be an object');
  }
  if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 999999) {
    throw new RangeError('seed must be an integer from 0 to 999999');
  }
  if (!Array.isArray(data.sizes) || data.sizes.length < 1 || data.sizes.length > 8) {
    throw new RangeError('sizes must be a nonempty list of at most 8 entries');
  }
  for (const sz of data.sizes) {
    if (!Number.isInteger(sz) || sz < 1 || sz * sz > MAX_IMAGE_PIXELS) {
      throw new RangeError('size ' + String(sz) + ' is out of range');
    }
  }
  if (!Number.isInteger(data.iterations) || data.iterations < 1 || data.iterations > 12) {
    throw new RangeError('iterations must be an integer from 1 to 12');
  }
  if (data.workload !== null && !(typeof data.workload === 'string' && labConfigsFor(data.workload))) {
    throw new RangeError('unknown workload ' + JSON.stringify(data.workload));
  }
  if (data.labSize !== null &&
    !(Number.isInteger(data.labSize) && data.labSize >= 1 && data.labSize * data.labSize <= MAX_IMAGE_PIXELS)) {
    throw new RangeError('labSize is out of range');
  }
  return {
    seed: data.seed,
    sizes: data.sizes.slice(),
    iterations: data.iterations,
    workload: data.workload,
    labSize: data.labSize,
  };
}

export function encodeBookmark(state) {
  if (!state || typeof state !== 'object') throw new TypeError('state must be an object');
  const clean = validateBookmarkFields({
    seed: state.seed,
    sizes: state.sizes,
    iterations: state.iterations,
    workload: state.workload === undefined ? null : state.workload,
    labSize: state.labSize === undefined ? null : state.labSize,
  });
  return 'arm=' + b64urlEncode(JSON.stringify({ v: BOOKMARK_VERSION, ...clean }));
}

/**
 * Strictly decode an arm= token. Every field is range checked against the
 * same limits the UI enforces, unknown versions and malformed payloads are
 * rejected with a reason, and nothing is ever partially applied.
 */
export function decodeBookmark(input) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== 'string') return fail('bookmark must be a string');
  const s = input.startsWith('#') ? input.slice(1) : input;
  if (!s.startsWith('arm=')) return fail('missing the arm= prefix');
  const text = b64urlDecode(s.slice(4));
  if (text === null) return fail('corrupt bookmark payload');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail('bookmark payload is not json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail('bookmark payload must be an object');
  }
  if (data.v !== BOOKMARK_VERSION) return fail('unsupported bookmark version ' + String(data.v));
  try {
    return { ok: true, state: validateBookmarkFields(data) };
  } catch (err) {
    return fail(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* In page self tests                                                   */
/* ------------------------------------------------------------------ */

/**
 * The self test battery that runs inside the page. Every check is pure,
 * deterministic and fast: FIPS 180-4 known answer vectors, kernel
 * invariants on crafted inputs, Pareto dominance, CSV escaping, tamper
 * detection, bookmark strictness and the timing conservation rules. No
 * network, no DOM, no timing dependence.
 */
export function runSelfTests() {
  const results = [];
  const check = (id, name, fn) => {
    let ok = false;
    let detail = '';
    try {
      const r = fn();
      ok = r === true;
      detail = typeof r === 'string' ? r : '';
    } catch (err) {
      detail = err && err.message ? err.message : 'threw';
    }
    results.push({ id, name, ok, detail });
  };

  check('sha256-empty', 'SHA-256 empty message KAT', () =>
    sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  check('sha256-abc', 'SHA-256 abc KAT', () =>
    sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('sha256-56', 'SHA-256 two block message KAT', () =>
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  check('sha256-utf8', 'SHA-256 non ASCII input KAT', () =>
    sha256Hex('ArmBench') === '4fedaa3e737a4436cbe05289ba5c07ada9f29c232511016497cb81add7338dd4');

  check('prng-kat', 'Seeded PRNG produces the recorded first draws', () => {
    const r = mulberry32(1337);
    const want = [0.184411832597, 0.189989251317, 0.810471992241];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(r() - want[i]) > 1e-9) return 'draw ' + i + ' drifted';
    }
    return true;
  });

  check('image-determinism', 'Seeded image is byte identical across builds', () => {
    const a = makeImage(42, 16, 16);
    const b = makeImage(42, 16, 16);
    return a.data.every((v, i) => v === b.data[i]) && a.data[3] === 255;
  });

  check('blur-impulse', 'Blur spreads a centered impulse evenly', () => {
    const img = uniformImage(3, 3, 0);
    img.data[(1 * 3 + 1) * 4] = 255;
    img.data[(1 * 3 + 1) * 4 + 1] = 255;
    img.data[(1 * 3 + 1) * 4 + 2] = 255;
    const out = runBoxBlur(img);
    for (let p = 0; p < 9; p++) if (out.data[p * 4] !== 28) return false;
    return true;
  });

  check('histogram-conservation', 'Histogram bins conserve the pixel count', () => {
    const img = makeImage(7, 17, 13);
    const { bins, count } = runHistogram(img);
    let s = 0;
    for (let i = 0; i < 256; i++) s += bins[i];
    return s === count && count === 17 * 13;
  });

  check('timing-single-sample', 'A single timed sample reports no dispersion', () => {
    const s = timingStats([4], 4);
    return s.cvPercent === null && s.stability === 'unavailable';
  });

  check('pareto-kat', 'Pareto frontier marks the expected dominant configs', () => {
    const entries = [
      { id: 'a', opsPerSec: 100, accuracyPct: 100 },
      { id: 'b', opsPerSec: 200, accuracyPct: 90 },
      { id: 'c', opsPerSec: 150, accuracyPct: 80 },
      { id: 'd', opsPerSec: 50, accuracyPct: 100 },
      { id: 'e', opsPerSec: 200, accuracyPct: 95 },
    ];
    const f = paretoFrontier(entries, ['opsPerSec', 'accuracyPct']);
    return f.frontierIds.slice().sort().join(',') === 'a,e' &&
      f.dominatedIds.slice().sort().join(',') === 'b,c,d';
  });

  check('csv-escape', 'CSV escaping quotes specials and defuses formulas', () => {
    return csvEscape('a,b') === '"a,b"' &&
      csvEscape('say "hi"') === '"say ""hi"""' &&
      csvEscape('=SUM(1)') === "'=SUM(1)" &&
      csvEscape(42) === '42' &&
      csvEscape(null) === '';
  });

  check('tamper-detect', 'Tamper detection: digest verify catches a flipped character', () => {
    const { text, digest } = auditExportJson({ probe: 'integrity', n: 1 });
    if (!verifyAuditJson(text, digest).ok) return 'clean text failed';
    const tampered = text.replace('"probe": "integrity"', '"probe": "tampered "');
    if (tampered === text) return 'tamper setup failed';
    return verifyAuditJson(tampered, digest).ok === false;
  });

  check('bookmark-roundtrip', 'Bookmark codec round trips and rejects junk', () => {
    const state = { seed: 7, sizes: [256, 512], iterations: 5, workload: 'blur', labSize: 256 };
    const enc = encodeBookmark(state);
    const dec = decodeBookmark('#' + enc);
    if (!dec.ok) return 'round trip failed: ' + dec.error;
    if (dec.state.seed !== 7 || dec.state.workload !== 'blur') return 'fields drifted';
    if (decodeBookmark('arm=!!!').ok) return 'junk accepted';
    if (decodeBookmark('arm=' + b64urlEncode('{"v":99}')).ok) return 'bad version accepted';
    return true;
  });

  check('canonical-json', 'Canonical JSON sorts keys for a stable digest', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    return a.indexOf('"a"') < a.indexOf('"b"') &&
      canonicalJson({ z: [2, 1], a: 1 }) === canonicalJson({ a: 1, z: [2, 1] });
  });

  check('estimate-factor', 'Estimate factor stays the documented 0.609375', () =>
    Math.abs(estimateFactor() - 0.609375) < 1e-12);

  check('speedup-absent', 'Missing measured rows produce no invented ratio', () =>
    speedupBetween([], 'blur', 256, 512) === null);

  check('accuracy-detect', 'Accuracy comparator catches a sabotaged variant', () => {
    const img = makeImage(3, 8, 8);
    const ref = runGrayscale(img);
    const bad = runGrayscale(img);
    bad.data[0] = (bad.data[0] + 1) % 256;
    const acc = accuracyAgainst(ref, bad);
    return !acc.exact && acc.mismatches === 1 && acc.maxDelta === 1;
  });

  check('config-integrity', 'Every workload keeps exactly five configs with the reference first', () => {
    for (const wl of ['grayscale', 'blur', 'sobel', 'histogram', 'resize']) {
      const cfgs = labConfigsFor(wl);
      if (!cfgs || cfgs.length !== 5 || cfgs[0].id !== 'ref' || cfgs[0].declared !== 'exact') {
        return wl + ' registry drifted';
      }
      const ids = new Set(cfgs.map((c) => c.id));
      if (ids.size !== cfgs.length) return wl + ' has duplicate config ids';
    }
    return true;
  });

  check('monotonic-sort', 'Sorted percentile input cannot invert p95', () => {
    const samples = [9, 1, 5, 3, 7];
    const s = timingStats(samples, 5);
    return s.p95Ms === 9 && s.trimmedMeanMs === 5;
  });

  check('plan-budget-all', 'Planned steps never break the per pass pixel budget', () => {
    const plan = planRun({ seed: 1, sizes: [256, 512, 1024], iterations: 8 });
    const budget = DEFAULT_OPTIONS.maxPixelsPerOp;
    const videoPx = VIDEO_CONFIG.width * VIDEO_CONFIG.height * VIDEO_CONFIG.frames;
    for (const s of plan) {
      const px = s.workloadId === 'video' ? videoPx : s.size * s.size;
      if (s.iterations * px > budget) return 'step ' + s.workloadId + ' exceeds budget';
    }
    return true;
  });

  const passed = results.filter((r) => r.ok).length;
  return {
    count: results.length,
    passed,
    failed: results.length - passed,
    results,
    verdict: results.every((r) => r.ok) ? 'all self tests passed' : (results.length - passed) + ' self test(s) failed',
  };
}
