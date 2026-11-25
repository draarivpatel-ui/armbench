# ArmBench submission upgrade

## Inspiration

A benchmark that reports a single mean invites a judge to trust a number they cannot inspect. ArmBench already separated live measurements from cloud estimates. This upgrade adds the missing layer: the dispersion behind every mean, a measured size to size scaling view, and a browser runtime test suite that drives the real app rather than only reading its markup.

## What it does

ArmBench still times five image kernels and an eight frame video pipeline on the local Arm CPU. In addition, every timed pass now reports population standard deviation, coefficient of variation, 95th percentile by nearest rank and trimmed mean. The new Timing Telemetry panel summarizes the whole run with a plain language verdict, steady, variable or noisy, and shows measured throughput ratios between 256, 512 and 1024 pixel squares. Ratios are computed only from rows that were actually run, so a missing size reads `not run` instead of being filled with a guess.

The report export gained a measured dispersion section and a download button. The Node runner prints the same dispersion summary and exposes it in its JSON output. A run can now be cancelled between steps, and a cancelled run produces no partial report. Keyboard shortcuts and an accessible shortcut dialog make the whole bench operable without a mouse.

## How we built it

All new statistics live in `js/armbench-core.js` as one exported `timingStats` helper shared by the browser, the Node script and the tests. `runTelemetry` aggregates measured rows only, `speedupBetween` refuses to divide by zero or invent missing rows, and `projectPixelScaling` is explicitly flagged as a projection so it can never be confused with a measurement or a cloud estimate.

The UI runtime suite boots the actual `js/app.js` against a dependency free DOM and canvas adapter parsed from the shipped `index.html`. It clicks a live run, asserts every rendered row and badge, re-renders the scaling selector for each workload, opens the shortcut dialog, cancels a run, and copies and downloads the generated report. No browser binary, package install or network access is required.

## Challenges

Timing a real workload produces unstable samples. A single mean hides that. We added a population based dispersion calculation with explicit handling for one sample, two samples, a zero mean and an empty pass, so no statistic divides by zero or returns a NaN. The stability verdict is driven by the worst row, not the mean, so one noisy workload cannot be averaged away.

A cancelled run could previously leave a stale report available for export. The run loop now disables the report buttons at the start of every run and only re-enables them after a complete run, so no partial or synthesized report can be issued. The scaling view had to distinguish measured pairs from absent ones, because a single size run cannot produce a ratio. Keyboard shortcuts had to ignore focused inputs, selects and buttons so typing a seed never triggers a benchmark.

## Accomplishments

- Five ordered panels with a dedicated measured dispersion panel and a real stability verdict.
- Population deviation, coefficient of variation, p95 and trimmed mean on every timed pass, in the page, the CLI table, the JSON output and the exported report.
- Measured size to size scaling for all five image kernels, with honest `not run` cells.
- Cancellable runs, keyboard shortcuts with a labelled dialog, and report download.
- A live browser runtime suite that boots the shipped app and drives the full flow.
- Explicit separation of three bases: measured, estimated, and arithmetic projection.

## Initial verification numbers

The pre-lab checkpoint verified on Node v26.8.1 with:

```sh
node --test tests/
```

**198 passed, 0 failed, 0 skipped.** Breakdown: 87 hardening and adversarial regression cases, 31 telemetry, scaling and regression cases, 20 browser runtime cases, 12 DOM smoke cases, and the original 48 kernel, timing, estimate and report cases.

Additional checks:

```sh
node scripts/run-bench.mjs --size 256 --iterations 2
node scripts/run-bench.mjs --size 256 --iterations 1 --json
python3 ../../hark_honesty_and_defect_harness.py --audit . --project armbench
```

The CLI prints a dispersion summary whose verdict is derived from real samples, for example `6 rows, mean cv 19.8 percent, worst cv 55.7 percent, verdict noisy run, rerun recommended`. That candid verdict is the point of the upgrade: an unstable run is reported as unstable. The honesty audit reports 0 violations.

During that checkpoint, browser layout and rendering were exercised through the DOM runtime adapter and markup contracts, not measured in a real browser. The estimate model and the Graviton plug in point are unchanged and remain clearly separated from every measurement.

## What's next

Run the identical suite on an EC2 c7g instance to replace the estimated column with measured cloud numbers, add multi core kernel variants so the core factor becomes meaningful, and chart dispersion over repeated runs rather than within one run. A real browser pass on phone and laptop widths would complement the DOM contract tests.

## Judge demo

Serve the folder, press `R`, watch all six queue entries complete, then open the Timing Telemetry panel. Run all sizes and change the scaling workload selector to see measured ratios for each kernel. Press `G` and `E` to generate and download the report, which now includes the dispersion section alongside the honesty statement and the reproduction commands.

## Optimization Lab and Audit pass

This pass adds two panels and one module while keeping every earlier honesty rule.

- **Optimization Lab** (`js/bench-lab.js`, panel 04): a five config comparator per workload, each leading with the reference kernel plus four real variants declared as exact or approximate. Every config is timed live on the same seeded input and compared byte for byte against the reference on two probes, so exactness is measured, not claimed. The panel reports performance, accuracy and stability deltas, the Pareto frontier over measured speed and measured accuracy, a roofline readout pairing live microbenchmark roofs with a documented op model (labeled as a model, never a measurement), a bottleneck inference, a zero dependency SVG trade off chart with a bottleneck callout, and an edge stress suite over degenerate sizes plus a timed worst case pass.
- **Audit And Verify** (panel 05): canonical JSON, CSV and Markdown exports checksummed by a pure JavaScript FIPS 180-4 implementation of SHA-256, described on the page as an unkeyed tamper detection digest. In page Verify Digest recomputes the checksum, the CSV writer quotes specials and prefixes formula leading cells, a strict `#arm=` bookmark restores the seed, sizes, iterations and lab controls and rejects malformed or out of range hashes without partially applying them, and a Run Self Tests button runs the invariant battery live.
- Honesty guardrails that held through the pass: `video/` untouched, zero external network requests, CSP unchanged, every speed figure a live measurement, every roofline figure labeled model, and declared intent kept separate from measured exactness.
- New verified numbers: **389 node:test cases pass with 0 failures** across ten files, **20 of 20 in page self tests pass**, and a real headless Chromium audit at 1440x900 and 390x844 reports 0 console errors, 0 page errors, 0 external requests and 0 overflow errors (`node scripts/headless-audit.mjs`).
