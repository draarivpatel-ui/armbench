/**
 * ArmBench core.
 * Deterministic image kernels, a timing harness, the estimate model and the
 * report generator. This module has no DOM access so the browser app, the
 * Node bench script and the test suite all run the exact same code.
 */

/* ------------------------------------------------------------------ */
/* Seeded randomness                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mulberry32 seeded PRNG. Integer math only, so the same seed produces the
 * same byte sequence in every browser and in Node.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Test image                                                           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic grayscale test pattern: a diagonal gradient, a lifted disc
 * and seeded noise. R, G and B always carry the same value and alpha is 255.
 */
export function makeImage(seed, width, height) {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.5;
  const cy = height * 0.42;
  const r = Math.min(width, height) * 0.28;
  const denom = width + height - 2 || 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = ((x + y) * 255) / denom * 0.55;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) v += 70;
      v += (rand() * 2 - 1) * 24;
      const c = v < 0 ? 0 : v > 255 ? 255 : v;
      const i = (y * width + x) * 4;
      const g = Math.round(c);
      data[i] = g;
      data[i + 1] = g;
      data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------------ */
/* Kernels                                                              */
/* ------------------------------------------------------------------ */

function lumaOf(data, i) {
  return Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
}

/** Rec. 709 luma grayscale. Output has the same dimensions as the input. */
export function runGrayscale(img) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = lumaOf(data, i);
    out[i] = g;
    out[i + 1] = g;
    out[i + 2] = g;
    out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

/**
 * 3 by 3 box blur with replicated edges: every window divides by 9 and edge
 * reads clamp to the border pixel, matching common OpenCV border behavior.
 * Interior pixels use an unrolled fast path. A uniform image stays uniform.
 */
export function runBoxBlur(img) {
  const { width: w, height: h, data: src } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (y > 0 && y < h - 1 && x > 0 && x < w - 1) {
        const r0 = (y - 1) * w;
        const r1 = y * w;
        const r2 = (y + 1) * w;
        for (let c = 0; c < 3; c++) {
          const sum =
            src[(r0 + x - 1) * 4 + c] + src[(r0 + x) * 4 + c] + src[(r0 + x + 1) * 4 + c] +
            src[(r1 + x - 1) * 4 + c] + src[(r1 + x) * 4 + c] + src[(r1 + x + 1) * 4 + c] +
            src[(r2 + x - 1) * 4 + c] + src[(r2 + x) * 4 + c] + src[(r2 + x + 1) * 4 + c];
          out[o + c] = Math.round(sum / 9);
        }
      } else {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const row = Math.min(h - 1, Math.max(0, y + dy)) * w;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.min(w - 1, Math.max(0, x + dx));
              sum += src[(row + xx) * 4 + c];
            }
          }
          out[o + c] = Math.round(sum / 9);
        }
      }
      out[o + 3] = src[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Sobel gradient magnitude on luma, clamped to 255. */
export function runSobel(img) {
  const { width: w, height: h, data } = img;
  const L = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < L.length; p++, i += 4) {
    L[p] = lumaOf(data, i);
  }
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
      const m = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      const o = (y * w + x) * 4;
      out[o] = m;
      out[o + 1] = m;
      out[o + 2] = m;
      out[o + 3] = data[(y * w + x) * 4 + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** 256 bin histogram of the luma channel. */
export function runHistogram(img) {
  const { width, height, data } = img;
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    bins[lumaOf(data, i)]++;
  }
  return { bins, count: width * height };
}

/** Bilinear downscale to half size (floor, minimum 1 by 1). */
export function runResize(img) {
  const w2 = Math.max(1, Math.floor(img.width / 2));
  const h2 = Math.max(1, Math.floor(img.height / 2));
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  const src = img.data;
  for (let y = 0; y < h2; y++) {
    const sy = (y + 0.5) * img.height / h2 - 0.5;
    const fyRaw = sy - Math.floor(sy);
    const fy = fyRaw < 0 ? 0 : fyRaw > 1 ? 1 : fyRaw;
    const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(sy)));
    const y1 = Math.min(img.height - 1, y0 + 1);
    for (let x = 0; x < w2; x++) {
      const sx = (x + 0.5) * img.width / w2 - 0.5;
      const fxRaw = sx - Math.floor(sx);
      const fx = fxRaw < 0 ? 0 : fxRaw > 1 ? 1 : fxRaw;
      const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(sx)));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const o = (y * w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * img.width + x0) * 4 + c];
        const p10 = src[(y0 * img.width + x1) * 4 + c];
        const p01 = src[(y1 * img.width + x0) * 4 + c];
        const p11 = src[(y1 * img.width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width: w2, height: h2, data: out };
}

/* ------------------------------------------------------------------ */
/* Video pipeline                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fixed synthetic video workload: a seeded sequence of frames, each pushed
 * through grayscale then box blur. One pipeline pass is one timed operation.
 */
export const VIDEO_CONFIG = { width: 640, height: 360, frames: 8 };

export function runVideoPipeline(cfg) {
  const { seed, width, height, frames } = cfg;
  let last = null;
  for (let f = 0; f < frames; f++) {
    const img = makeImage(seed + f * 7919, width, height);
    last = runBoxBlur(runGrayscale(img));
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Workload registry                                                    */
/* ------------------------------------------------------------------ */

export const WORKLOADS = [
  { id: 'resize',    label: 'Resize (Bilinear, Half Size)',       unit: 'ops/sec' },
  { id: 'grayscale', label: 'Grayscale (Rec. 709 Luma)',          unit: 'ops/sec' },
  { id: 'blur',      label: 'Convolution Blur (3 by 3 Box)',      unit: 'ops/sec' },
  { id: 'sobel',     label: 'Edge Detection (Sobel Magnitude)',   unit: 'ops/sec' },
  { id: 'histogram', label: 'Histogram (256 Bins, Luma)',         unit: 'ops/sec' },
  { id: 'video',     label: 'Video Pipeline (8 Frames, 640 by 360)', unit: 'pipelines/sec' },
];

export function workloadById(id) {
  return WORKLOADS.find((w) => w.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Timing harness                                                       */
/* ------------------------------------------------------------------ */

function defaultClock() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Time one workload. One warmup call runs uncounted, then exactly
 * `iterations` timed calls. The clock is injectable so tests are
 * deterministic; production uses the monotonic performance.now clock.
 */
export function timeWorkload(run, input, iterations, clock = defaultClock) {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError('iterations must be a positive integer');
  }
  run(input); // warmup, never counted
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = clock();
    run(input);
    samples.push(clock() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = samples.reduce((a, b) => a + b, 0);
  const meanMs = totalMs / iterations;
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    samples,
    iterations,
    meanMs,
    medianMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    totalMs,
    opsPerSec: totalMs > 0 ? (iterations / totalMs) * 1000 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Estimate model                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every cloud figure on the site comes from this model. It is arithmetic on
 * top of a local measurement, never a measurement itself.
 */
export const ESTIMATE_MODEL = {
  target: 'AWS Graviton3 class instance (c7g family)',
  localClockGhz: 3.2,
  cloudClockGhz: 2.6,
  clockRatio: 2.6 / 3.2,
  memRatio: 0.75,
  coreFactor: 1.0,
  assumptions: [
    {
      name: 'Per Core Clock Scaling',
      detail: 'Cloud clock 2.6 GHz (Graviton3 public spec sheet, approximate) over an assumed 3.2 GHz Apple Silicon performance core gives a clock ratio of 0.8125.',
    },
    {
      name: 'Memory Bandwidth Heuristic',
      detail: 'A per-core share of 0.75 reflects that socket bandwidth on a many-core server is divided across more cores than on an 8 to 16 core laptop. This is a heuristic, not a measurement.',
    },
    {
      name: 'Core Count',
      detail: 'Factor 1.0. The reference kernels are single threaded, so core count is deliberately not applied. A parallel cloud deployment could scale further and is out of scope.',
    },
    {
      name: 'Known Limits',
      detail: 'Estimates ignore microarchitecture, cache hierarchy, SIMD width, compiler flags, operating system and thermal behavior. They are order of magnitude planning figures only.',
    },
  ],
};

export function estimateFactor() {
  const m = ESTIMATE_MODEL;
  return m.clockRatio * m.memRatio * m.coreFactor;
}

/** Project a local throughput number into an estimate. Always flagged. */
export function estimateFromLocal(localOpsPerSec) {
  const factor = estimateFactor();
  return {
    isEstimate: true,
    basis: 'estimate',
    factor,
    opsPerSec: localOpsPerSec * factor,
    formula: 'estimate = local ops/sec x 0.8125 (clock) x 0.75 (memory) x 1.0 (cores)',
  };
}

/** Project a local latency number into an estimate. Always flagged. */
export function estimateLatencyMs(localMeanMs) {
  return localMeanMs / estimateFactor();
}

/* ------------------------------------------------------------------ */
/* Basis labels                                                         */
/* ------------------------------------------------------------------ */

export const BASIS = {
  MEASURED: 'measured',
  ESTIMATE: 'estimate',
};

/** Human badge text. Measured means timed here; Estimate means projected. */
export function badgeFor(basis) {
  return basis === BASIS.MEASURED ? 'Measured' : 'Estimate';
}

/* ------------------------------------------------------------------ */
/* Run planning                                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_OPTIONS = {
  seed: 1337,
  sizes: [256, 512, 1024],
  iterations: 5,
  maxPixelsPerOp: 12_000_000,
};

/**
 * Build the ordered list of run steps. Iterations are clamped per step so a
 * single timed pass never processes more than maxPixelsPerOp pixels, which
 * keeps a whole run under roughly ten seconds on a laptop Arm CPU.
 */
export function planRun(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const steps = [];
  for (const size of opts.sizes) {
    for (const wl of WORKLOADS) {
      if (wl.id === 'video') continue;
      const budget = Math.floor(opts.maxPixelsPerOp / (size * size));
      steps.push({
        workloadId: wl.id,
        size,
        iterations: Math.max(1, Math.min(opts.iterations, budget)),
        seed: opts.seed,
      });
    }
  }
  steps.push({ workloadId: 'video', size: 0, iterations: opts.iterations, seed: opts.seed });
  return steps;
}

/** Execute one planned step and return a measured result row. */
export function executeStep(step, clock) {
  const wl = workloadById(step.workloadId);
  let input;
  let run;
  if (step.workloadId === 'video') {
    input = {
      seed: step.seed,
      width: VIDEO_CONFIG.width,
      height: VIDEO_CONFIG.height,
      frames: VIDEO_CONFIG.frames,
    };
    run = runVideoPipeline;
  } else {
    input = makeImage(step.seed, step.size, step.size);
    run = {
      resize: runResize,
      grayscale: runGrayscale,
      blur: runBoxBlur,
      sobel: runSobel,
      histogram: runHistogram,
    }[step.workloadId];
  }
  const t = timeWorkload(run, input, step.iterations, clock);
  return {
    workloadId: step.workloadId,
    label: wl.label,
    unit: wl.unit,
    size: step.workloadId === 'video'
      ? VIDEO_CONFIG.width + ' x ' + VIDEO_CONFIG.height + ', 8 frames'
      : step.size,
    sizePx: step.workloadId === 'video' ? VIDEO_CONFIG.width * VIDEO_CONFIG.height : step.size * step.size,
    iterations: t.iterations,
    meanMs: t.meanMs,
    medianMs: t.medianMs,
    minMs: t.minMs,
    maxMs: t.maxMs,
    totalMs: t.totalMs,
    opsPerSec: t.opsPerSec,
    basis: BASIS.MEASURED,
  };
}

/* ------------------------------------------------------------------ */
/* Number formatting                                                    */
/* ------------------------------------------------------------------ */

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

export function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return Math.round(n).toLocaleString('en-US');
}

/* ------------------------------------------------------------------ */
/* Report generator                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the copyable methodology and results report. `rows` are measured
 * result rows from executeStep, `env` describes the host, `meta` carries the
 * run options. Cloud figures in the report are labeled estimates.
 */
export function generateReport(rows, env, meta) {
  const factor = estimateFactor();
  const lines = [];
  lines.push('ArmBench Methodology And Results');
  lines.push('Author: ' + (meta.author || 'Aariv Patel'));
  lines.push('Generated: ' + meta.generatedAt);
  lines.push('Basis: local Arm measurements with clearly labeled cloud estimates');
  lines.push('');
  lines.push('1. What Was Measured');
  lines.push('Kernels: ' + rows.map((r) => r.label).filter((v, i, a) => a.indexOf(v) === i).join('; '));
  lines.push('Input: deterministic grayscale pattern (gradient, disc, noise) from seed ' + meta.seed);
  lines.push('Image sizes: ' + meta.sizes.map((s) => s + ' px squares').join(', '));
  lines.push('Iterations per workload: ' + meta.iterations + ', plus one warmup iteration excluded from timing');
  lines.push('Clock: performance.now monotonic wall clock, one sample per iteration');
  lines.push('Budget guard: one timed pass never exceeds ' + DEFAULT_OPTIONS.maxPixelsPerOp.toLocaleString('en-US') + ' pixels, so a full run stays under ten seconds');
  lines.push('');
  lines.push('2. Local Results (measured)');
  for (const r of rows) {
    const extra = r.workloadId === 'video'
      ? ', ' + fmt(r.opsPerSec * 8, 1) + ' frames/sec'
      : '';
    lines.push(
      r.label + ', ' + r.size + ': mean ' + fmt(r.meanMs) + ' ms, ' +
      fmt(r.opsPerSec) + ' ' + r.unit + ', ' + r.iterations + ' iterations' + extra + ' | Measured'
    );
  }
  lines.push('');
  lines.push('3. Cloud Estimates (not measurements)');
  lines.push('Target: ' + ESTIMATE_MODEL.target);
  lines.push('Model: ' + 'estimate = local ops/sec x ' + fmt(ESTIMATE_MODEL.clockRatio, 4) +
    ' (clock) x ' + ESTIMATE_MODEL.memRatio + ' (memory) x ' + ESTIMATE_MODEL.coreFactor + ' (cores)');
  lines.push('Combined factor: ' + fmt(factor, 4) + ' of the local throughput');
  lines.push('Assumptions:');
  for (const a of ESTIMATE_MODEL.assumptions) {
    lines.push('- ' + a.name + ': ' + a.detail);
  }
  lines.push('');
  lines.push('4. Environment');
  lines.push('Declared host: ' + env.declared);
  lines.push('Runtime reported: ' + env.runtime);
  lines.push('AWS Graviton was not used. No cloud instance was contacted. Local Arm measurements stand in for cloud figures, and every cloud figure above is an estimate.');
  lines.push('');
  lines.push('5. Reproduce');
  lines.push('Browser: serve this folder statically (for example python3 -m http.server 8000), open the page, keep the same seed and iteration count, press Run');
  lines.push('Node: node scripts/run-bench.mjs --seed ' + meta.seed + ' --iterations ' + meta.iterations + ' --all-sizes');
  lines.push('Graviton plug in point: on any AWS Graviton Linux instance with Node 18 or newer, run the same Node command with --json and compare against section 2');
  lines.push('');
  lines.push('Honesty Statement');
  lines.push('Every number labeled Measured comes from a live timed run of the kernels in this repository. Every number labeled Estimate is arithmetic derived from a local measurement plus the documented assumptions in section 3. No estimate is presented as a measurement.');
  return lines.join('\n');
}
