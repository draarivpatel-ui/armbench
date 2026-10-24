# ArmBench Build Notes

Date: 2026-10-24. Author: Aariv Patel.

## What Was Built

ArmBench is a static single page benchmark studio for image and video workloads on Arm. It runs real, timed measurements of JavaScript pixel kernels in the browser on the local Arm CPU (Apple Silicon), presents them in an instrument style panel, and places them beside AWS Graviton figures that are always labeled as estimates with their assumptions listed. A Node script runs the identical kernels outside the browser so every number is reproducible from the repo.

Files:

- `index.html`, the whole app, semantic HTML, four panels, no dependencies.
- `css/tokens.css` and `css/style.css`, a token locked design system: dark graphite, one amber signal accent, mono data typography, hairline rules, solid versus hatched honesty language.
- `js/armbench-core.js`, one DOM free module shared by browser, Node script and tests: Mulberry32 seeded image generator, five image kernels (bilinear resize, Rec. 709 grayscale, 3 by 3 box blur with replicated edges, Sobel magnitude, 256 bin histogram), an 8 frame video pipeline, the timing harness with injectable clock, the estimate model, and the report generator.
- `js/app.js`, browser wiring: run queue with live status, results table, comparison table, canvas bar chart with hatched estimate bars, report generation and copy.
- `scripts/run-bench.mjs`, the Node bench, table or `--json` output.
- `tests/`, three `node:test` files.
- `README.md`, including the honesty statement, methodology and the Graviton plug in point.

## Exact Real Test Counts

`node --test tests/`, Node v26.8.1:

- 48 tests, 48 pass, 0 fail, 0 skipped, duration about 1.5 seconds.
- Coverage: kernel reference math with known expected outputs (PRNG determinism, luma values, blur against an independent convolution reference, Sobel against hand computed responses of 80 center and 40 corner plus an independent reference, histogram counts and sums, bilinear resize quadrant means), timing harness determinism under an injected fake clock (sample counts, exact mean, median for odd and even counts, min and max, warmup exclusion, iteration validation), plan and execute integration, estimate labeling logic (isEstimate flags, basis constants, badge text, factor arithmetic, assumption coverage), report content (author, seed, honesty statement, absence of em and en dashes, reproduction commands).
- Two real defects were caught by the tests during the build: the box blur double counted clamped edge columns in its first version, and the resize test used a wrong row stride. Both fixed and re verified.

## Real Benchmark Numbers

From an actual `node scripts/run-bench.mjs` run on 2026-10-24, seed 1337, 5 iterations per workload, all sizes. Host as reported by the runtime: Node v26.8.1, arm64, darwin, Apple M5, 10 logical cores. Wall time for the whole run: about 0.5 seconds.

```text
Workload                              Size            Iters  Mean ms   Ops/sec      Graviton ops/sec (Estimate)
Resize (Bilinear, Half Size)          256 px          5      0.36      2809.8       1712.2
Grayscale (Rec. 709 Luma)             256 px          5      0.17      5905.2       3598.5
Convolution Blur (3 by 3 Box)         256 px          5      0.82      1226.4       747.3
Edge Detection (Sobel Magnitude)      256 px          5      0.83      1205.5       734.6
Histogram (256 Bins, Luma)            256 px          5      0.17      5892.7       3590.9
Resize (Bilinear, Half Size)          512 px          5      0.62      1625.8       990.7
Grayscale (Rec. 709 Luma)             512 px          5      0.49      2057.9       1254.0
Convolution Blur (3 by 3 Box)         512 px          5      2.93      341.6        208.1
Edge Detection (Sobel Magnitude)      512 px          5      1.85      541.4        329.9
Histogram (256 Bins, Luma)            512 px          5      0.34      2921.3       1780.1
Resize (Bilinear, Half Size)          1024 px         5      2.56      390.4        237.9
Grayscale (Rec. 709 Luma)             1024 px         5      2.11      474.1        288.9
Convolution Blur (3 by 3 Box)         1024 px         5      11.58     86.3         52.6
Edge Detection (Sobel Magnitude)      1024 px         5      5.92      168.9        102.9
Histogram (256 Bins, Luma)            1024 px         5      1.52      658.8        401.5
Video Pipeline (8 Frames, 640 by 360) 640x360 x8f     5      34.96     28.6         17.4
```

Every Graviton column is `local x 0.8125 x 0.75 x 1.0` and carries an Estimate label in the app, the chart and the report. Nothing above marked Estimate was measured.

## Honest Caveats

1. AWS Graviton was not used. Every local number is from an Apple Silicon Mac (Armv8 and Armv9 via Apple M5, a genuine Arm CPU), and every Graviton number is arithmetic from the documented model. The Environment Card, the README, the in page labels and this file all say so plainly.
2. The estimate model is a heuristic, not a model of a real machine. It ignores microarchitecture, cache hierarchy, SIMD width, compiler flags, operating system and thermals, and applies no core count scaling because the reference kernels are single threaded. Treat Graviton columns as order of magnitude projections only.
3. Browser timings vary run to run with JIT state, tab throttling and system load. The harness controls what it can: deterministic seeded inputs, fixed iteration counts, one excluded warmup pass, and a published budget guard. Exact equality across runs is not claimed and would be dishonest.
4. The kernels are portable JavaScript reference implementations, not tuned NEON or WebAssembly SIMD pipelines, so absolute figures understate what an optimized build could reach. The point of the project is the measurement method and the honesty of the comparison, not peak numbers.
5. The chart normalizes bars within each workload group because the six workloads operate at different scales; the table is the source of exact values, and the note under the chart says so.
6. Verification was code level only (test suite, syntax checks, real script runs, copy scans) because the build environment had no browser available. The page is served through a static server when demoing, since module scripts do not run from a file:// double click; an inline banner explains this if it happens.

## Devpost Bullets

1. Real measurements, honest estimates: ArmBench times five image kernels and an 8 frame video pipeline live in your browser on Arm, and every cloud number it shows is a clearly badged estimate with published assumptions, so nothing pretends a projection is a reading.
2. Reproducible from the repo, end to end: seeded deterministic inputs, fixed iteration counts, one shared kernel module for browser and Node, 48 passing tests over the math and the harness, and one command (`node scripts/run-bench.mjs`) that prints the whole table on any Arm box with Node 18.
3. A documented Graviton plug in point: the suite was not run on AWS Graviton and the app says so on its face; the identical zero dependency script is the plug in point, so a judge on an EC2 c7g instance can produce the same table and complete the comparison.
4. An instrument panel built for scrutiny: dark graphite lab aesthetic with one signal accent, tabular numerals, hairline rules, a solid versus hatched visual language where solid amber always means measured and hatched always means estimated, in badges, table cells and the canvas chart.
5. Copyable methodology for judges: the Report Export panel generates a reusable text block with the environment, seeds, iteration counts, results, estimate formula, assumptions, honesty statement and exact reproduction commands, ready to paste into a submission or a terminal.

## Summary

ArmBench delivers the competition brief the honest way: a dependency free static studio that measures real image and video workload performance on a genuine local Arm CPU with deterministic, test verified kernels, shows the machine it actually ran on, labels every cloud projection as an estimate with its factor math exposed, exports a reproducible methodology report, and documents the exact plug in point for running the same suite on AWS Graviton. 48 tests pass, the Node bench runs in about half a second, and the in page run stays under the ten second budget by construction.

## Refinement Pass 2026-10-24

A presentation only pass over the deployed page. No kernel, timing, or estimate changes.

- Wiring audit: every id app.js references exists in the markup, no duplicate ids, no dead listeners, no reachable console errors on a served load.
- Added Open Graph title, description and type tags. Share sheets had nothing to read before.
- Fixed: the copy fallback message told a Mac user to press Control C. It now names both shortcuts, since the declared host is an Apple Silicon Mac.
- Added: the decorative scanline is explicitly paused while the tab is hidden, via a visibilitychange listener toggling a body class, on top of the browser's own background throttling.
- Contrast audit: converted the oklch tokens to sRGB and computed WCAG ratios. All text pairs clear AA. Faint text sits at about 5.1 to 1 on panels and muted at about 6.9 to 1, so the small mono labels pass.
- Verified: no horizontal page overflow at 320 px. The wide tables scroll inside their own focusable regions instead of stretching the page. Reduced motion stops the sweep and the button lifts.
- Residual risk: module scripts need a static server. Opening index.html from file:// shows the page's own banner explaining this; the Node bench works without a server.
- Tests before the pass: 48 passed, 0 failed. Tests after: 48 passed, 0 failed.
