# ArmBench | OpenCV AI Competition 2026, powered by AWS

Name: ArmBench, an honest Arm workload benchmark and comparison studio

Description:
ArmBench runs real image and video workload measurements on the Arm CPU you are using right now, in the browser, with seeds and settings shown beside every number. Resize, grayscale, convolution blur, Sobel edge detection, histogram, and an eight frame video pipeline are timed across selectable image sizes and iteration counts.

The Baseline Compare panel places those measured results next to estimated cloud figures with an engineered distinction you cannot miss: measured values are solid, estimated values are hatched and dashed, and every estimate lists its assumptions inline. The Environment Card states plainly that measurements were taken on Apple Silicon Arm locally, not on AWS Graviton, with a documented plug in point for running the identical suite on a Graviton instance. Report Export generates the full methodology text, honesty statement, and reproduction commands a judge can run.

The repo includes a Node script that executes the same kernel suite outside the browser and prints a results table, so every claim is reproducible from the command line in under a second. Forty eight unit tests cover kernel reference math, timing harness determinism under an injected clock, estimate labeling, and report generation.

Built with: vanilla JavaScript, canvas, node:test, and a measurement first methodology.

Try it: https://aariv.me/armbench/
Code: https://github.com/draarivpatel-ui/armbench
