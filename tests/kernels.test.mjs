import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, makeImage, runGrayscale, runBoxBlur, runSobel,
  runHistogram, runResize, runVideoPipeline, WORKLOADS, workloadById,
} from '../js/armbench-core.js';

/* Helpers ------------------------------------------------------------ */

function imgFromPixels(width, height, pixels) {
  // pixels: array of [r, g, b] in row major order
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, idx) => {
    data[idx * 4] = p[0];
    data[idx * 4 + 1] = p[1];
    data[idx * 4 + 2] = p[2];
    data[idx * 4 + 3] = 255;
  });
  return { width, height, data };
}

/* PRNG ---------------------------------------------------------------- */

test('mulberry32 is deterministic for a fixed seed', () => {
  const a = mulberry32(1337);
  const b = mulberry32(1337);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('mulberry32 gives different sequences for different seeds', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notDeepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('mulberry32 reproduces identical image bytes from the same seed', () => {
  const img1 = makeImage(42, 16, 16);
  const img2 = makeImage(42, 16, 16);
  assert.deepEqual(Array.from(img1.data), Array.from(img2.data));
});

/* Test image ----------------------------------------------------------- */

test('makeImage has correct dimensions, opaque alpha and gray channels', () => {
  const img = makeImage(7, 10, 6);
  assert.equal(img.width, 10);
  assert.equal(img.height, 6);
  assert.equal(img.data.length, 10 * 6 * 4);
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1], 'R equals G');
    assert.equal(img.data[i], img.data[i + 2], 'R equals B');
    assert.equal(img.data[i + 3], 255, 'alpha opaque');
  }
});

/* Grayscale ------------------------------------------------------------ */

test('grayscale applies the Rec. 709 luma formula with rounding', () => {
  // round(0.2126*54 + 0.7152*132 + 0.0722*201) = round(120.399) = 120
  const img = imgFromPixels(1, 1, [[54, 132, 201]]);
  const out = runGrayscale(img);
  assert.equal(out.data[0], 120);
  assert.equal(out.data[1], 120);
  assert.equal(out.data[2], 120);
  assert.equal(out.data[3], 255);
});

test('grayscale preserves dimensions and is a no-op on gray input', () => {
  const img = makeImage(5, 12, 9);
  const out = runGrayscale(img);
  assert.equal(out.width, 12);
  assert.equal(out.height, 9);
  assert.deepEqual(Array.from(out.data), Array.from(img.data));
});

test('grayscale keeps alpha and length for every workload size', () => {
  const img = makeImage(11, 8, 8);
  const out = runGrayscale(img);
  assert.equal(out.data.length, img.data.length);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

/* Box blur ------------------------------------------------------------- */

test('box blur leaves a uniform image uniform', () => {
  const img = imgFromPixels(4, 4, Array.from({ length: 16 }, () => [100, 100, 100]));
  const out = runBoxBlur(img);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i], 100);
    assert.equal(out.data[i + 1], 100);
    assert.equal(out.data[i + 2], 100);
  }
});

test('box blur matches a reference convolution on a known 4 by 4 image', () => {
  const vals = [];
  for (let p = 0; p < 16; p++) vals.push([(p * 17) % 256, (p * 13) % 256, (p * 7) % 256]);
  const img = imgFromPixels(4, 4, vals);
  const out = runBoxBlur(img);
  const ref = (x, y, c) => {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(3, Math.max(0, y + dy));
        const xx = Math.min(3, Math.max(0, x + dx));
        sum += img.data[(yy * 4 + xx) * 4 + c];
        n++;
      }
    }
    return Math.round(sum / n);
  };
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      for (let c = 0; c < 3; c++) {
        assert.equal(out.data[(y * 4 + x) * 4 + c], ref(x, y, c), `blur at ${x},${y},c${c}`);
      }
    }
  }
});

test('box blur preserves dimensions and alpha', () => {
  const img = makeImage(3, 9, 5);
  const out = runBoxBlur(img);
  assert.equal(out.width, 9);
  assert.equal(out.height, 5);
  assert.equal(out.data.length, img.data.length);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

/* Sobel ------------------------------------------------------------------ */

test('sobel returns zero everywhere on a uniform image', () => {
  const img = imgFromPixels(6, 6, Array.from({ length: 36 }, () => [88, 88, 88]));
  const out = runSobel(img);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i], 0, 'uniform image has no edges');
  }
});

test('sobel matches hand computed values for a horizontal step gradient', () => {
  // rows of luma [0,10,20] repeated: center response 80, corner response 40
  const row = [[0, 0, 0], [10, 10, 10], [20, 20, 20]];
  const img = imgFromPixels(3, 3, [...row, ...row, ...row]);
  const out = runSobel(img);
  assert.equal(out.data[(1 * 3 + 1) * 4], 80, 'center magnitude');
  assert.equal(out.data[(0 * 3 + 0) * 4], 40, 'corner magnitude with clamped window');
});

test('sobel matches an independent reference convolution on seeded input', () => {
  const img = makeImage(99, 7, 7);
  const L = [];
  for (let i = 0; i < img.data.length; i += 4) {
    L.push(Math.round(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]));
  }
  const KX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const KY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
  const out = runSobel(img);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      let gx = 0, gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(6, Math.max(0, y + dy));
          const xx = Math.min(6, Math.max(0, x + dx));
          gx += KX[dy + 1][dx + 1] * L[yy * 7 + xx];
          gy += KY[dy + 1][dx + 1] * L[yy * 7 + xx];
        }
      }
      const expected = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
      assert.equal(out.data[(y * 7 + x) * 4], expected, `sobel at ${x},${y}`);
    }
  }
});

test('sobel magnitudes never exceed 255', () => {
  const img = makeImage(1234, 10, 10);
  const out = runSobel(img);
  for (let i = 0; i < out.data.length; i += 4) {
    assert.ok(out.data[i] >= 0 && out.data[i] <= 255);
  }
});

/* Histogram -------------------------------------------------------------- */

test('histogram bins luma values and sums to the pixel count', () => {
  const img = imgFromPixels(2, 2, [[10, 10, 10], [10, 10, 10], [200, 200, 200], [77, 77, 77]]);
  const { bins, count } = runHistogram(img);
  assert.equal(count, 4);
  assert.equal(bins[10], 2);
  assert.equal(bins[200], 1);
  assert.equal(bins[77], 1);
  let sum = 0;
  for (let b = 0; b < 256; b++) sum += bins[b];
  assert.equal(sum, count);
});

test('histogram always produces exactly 256 bins', () => {
  const { bins } = runHistogram(makeImage(2, 5, 5));
  assert.equal(bins.length, 256);
});

test('histogram is deterministic across runs of the same seed', () => {
  const a = runHistogram(makeImage(808, 16, 16));
  const b = runHistogram(makeImage(808, 16, 16));
  assert.deepEqual(Array.from(a.bins), Array.from(b.bins));
});

/* Resize ------------------------------------------------------------------- */

test('resize halves a 2 by 2 image to the exact mean of its four pixels', () => {
  const img = imgFromPixels(2, 2, [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]]);
  const out = runResize(img);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.equal(out.data[0], 55);
  assert.equal(out.data[1], 65);
  assert.equal(out.data[2], 75);
  assert.equal(out.data[3], 255);
});

test('resize of a 4 by 4 image averages exact quadrants', () => {
  // gray value at (x, y) is y * 40 + x * 10, so each quadrant is a clean ramp
  const px = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) px.push([y * 40 + x * 10, y * 40 + x * 10, y * 40 + x * 10]);
  }
  const out = runResize(imgFromPixels(4, 4, px));
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  // output (0,0) samples rows 0 to 1, cols 0 to 1: mean of 0, 10, 40, 50
  assert.equal(out.data[0], 25);
  // output (1,0) samples rows 0 to 1, cols 2 to 3: mean of 20, 30, 60, 70
  assert.equal(out.data[4], 45);
  // output (0,1) samples rows 2 to 3, cols 0 to 1: mean of 80, 90, 120, 130
  assert.equal(out.data[8], 105);
  // output (1,1) samples rows 2 to 3, cols 2 to 3: mean of 100, 110, 140, 150
  assert.equal(out.data[12], 125);
});

test('resize uses floor half dimensions, so 5 by 5 becomes 2 by 2', () => {
  const out = runResize(makeImage(6, 5, 5));
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 2 * 2 * 4);
});

/* Video pipeline ----------------------------------------------------------- */

test('video pipeline processes exactly 8 deterministic frames', () => {
  const a = runVideoPipeline({ seed: 21, width: 32, height: 18, frames: 8 });
  const b = runVideoPipeline({ seed: 21, width: 32, height: 18, frames: 8 });
  assert.equal(a.width, 32);
  assert.equal(a.height, 18);
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
});

/* Registry ------------------------------------------------------------------ */

test('workload registry covers the five image kernels and the video pipeline', () => {
  assert.equal(WORKLOADS.length, 6);
  for (const id of ['resize', 'grayscale', 'blur', 'sobel', 'histogram', 'video']) {
    assert.ok(workloadById(id), `registry contains ${id}`);
  }
  assert.ok(workloadById('nope') === null);
});
