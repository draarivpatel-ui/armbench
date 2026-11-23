#!/usr/bin/env node
/**
 * ArmBench Node runner.
 * Executes the same kernels the browser page runs, outside the browser, and
 * prints a results table with clearly labeled cloud estimates. Zero
 * dependencies, no network. Runs unmodified on any Arm Linux box, including
 * AWS Graviton, with Node 18 or newer.
 *
 * Usage:
 *   node scripts/run-bench.mjs
 *   node scripts/run-bench.mjs --seed 1337 --iterations 5 --all-sizes
 *   node scripts/run-bench.mjs --size 512 --json
 *
 * Flags (each takes either --flag value or --flag=value):
 *   --seed N         deterministic input seed, an integer, default 1337
 *   --size N         one square size in pixels, within the pixel cap
 *   --all-sizes      run 256, 512 and 1024 (default)
 *   --iterations N   timed iterations per workload, 1 to 12, default 5
 *   --json           print machine readable results instead of a table
 *   -h, --help       print usage and exit
 * Unknown flags, malformed integers and missing values exit with status 2
 * rather than silently running a different benchmark than requested.
 */
import os from 'node:os';
import {
  planRun, executeStep, estimateFromLocal, estimateLatencyMs, runTelemetry,
  ESTIMATE_MODEL, fmt, fmtInt, VIDEO_CONFIG, MAX_IMAGE_PIXELS,
} from '../js/armbench-core.js';
import {
  runConfigComparison, labConfigsFor, measureMachineRoofs, rooflinePosition,
  workloadIntensity, LAB_CONFIGS,
} from '../js/bench-lab.js';

const USAGE = `ArmBench Node runner.
Usage:
  node scripts/run-bench.mjs
  node scripts/run-bench.mjs --seed 1337 --iterations 5 --all-sizes
  node scripts/run-bench.mjs --size 512 --json
Flags (each takes either --flag value or --flag=value):
  --seed N         deterministic input seed, an integer, default 1337
  --size N         one square size in pixels, within the pixel cap
  --all-sizes      run 256, 512 and 1024 (default)
  --iterations N   timed iterations per workload, 1 to 12, default 5
  --lab WORKLOAD   run the five config optimization comparison for one
                   workload: grayscale, blur, sobel, histogram or resize
  --json           print machine readable results instead of a table
  -h, --help       print this text`;

function parseArgs(argv) {
  const opts = { seed: '1337', iterations: '5', size: null, lab: null, json: false };
  const errors = [];
  const takesValue = new Set(['--seed', '--iterations', '--size', '--lab']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    let flag = arg;
    let inline;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    if (takesValue.has(flag)) {
      let value = inline;
      if (value === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      }
      if (value === undefined) {
        errors.push(flag + ' needs an integer value');
        continue;
      }
      if (flag === '--lab') {
        opts.lab = value;
        continue;
      }
      if (!/^-?\d+$/.test(value)) {
        errors.push(flag + ' must be an integer, got ' + JSON.stringify(value));
        continue;
      }
      opts[flag.slice(2)] = value;
    } else if (flag === '--all-sizes' || flag === '--json') {
      if (inline !== undefined) {
        errors.push(flag + ' takes no value');
        continue;
      }
      if (flag === '--json') opts.json = true;
    } else {
      errors.push('unknown flag ' + JSON.stringify(arg));
    }
  }
  return { help: false, opts, errors };
}

const args = process.argv.slice(2);
const parsed = parseArgs(args);
if (parsed.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.errors.length) {
  for (const e of parsed.errors) console.error('Invalid argument: ' + e);
  process.exit(2);
}

const seed = Number.parseInt(parsed.opts.seed, 10);
const iterations = Number.parseInt(parsed.opts.iterations, 10);
const sizes = parsed.opts.size !== null ? [Number.parseInt(parsed.opts.size, 10)] : [256, 512, 1024];
const labWorkload = parsed.opts.lab;
const asJson = parsed.opts.json;

if (labWorkload !== null && !labConfigsFor(labWorkload)) {
  console.error('Invalid arguments. --lab expects one of: ' + Object.keys(LAB_CONFIGS).join(', '));
  process.exit(2);
}

if (!Number.isInteger(seed)
  || !Number.isInteger(iterations) || iterations < 1 || iterations > 12
  || sizes.some((s) => !Number.isInteger(s) || s < 1 || s * s > MAX_IMAGE_PIXELS)) {
  console.error('Invalid arguments. Seed must be an integer, iterations must be an integer from 1 to 12, and each size a positive integer within the pixel cap.');
  process.exit(2);
}

const cpu = os.cpus()[0] || {};
const env = {
  declared: 'Declared by the runtime that executed this script, not verified against a cloud vendor',
  runtime: `Node ${process.version}, ${os.arch()}, ${os.platform()}, ${cpu.model || 'unknown cpu'}, ${os.cpus().length} logical cores`,
  node: process.version,
  arch: os.arch(),
  platform: os.platform(),
  cpuModel: cpu.model || 'unknown',
  cores: os.cpus().length,
};

if (labWorkload !== null) {
  const labSize = parsed.opts.size !== null ? Number.parseInt(parsed.opts.size, 10) : 256;
  if (!Number.isInteger(labSize) || labSize < 1 || labSize * labSize > MAX_IMAGE_PIXELS) {
    console.error('Invalid arguments. --size for --lab must be a positive integer within the pixel cap.');
    process.exit(2);
  }
  const lab = runConfigComparison({ workloadId: labWorkload, size: labSize, seed, iterations });
  const roofs = measureMachineRoofs(undefined, 0.25);
  const best = lab.configs.reduce((a, b) => ((b.opsPerSec || 0) > (a.opsPerSec || 0) ? b : a), lab.configs[0]);
  const pos = rooflinePosition(labWorkload, best.opsPerSec, roofs);
  if (asJson) {
    console.log(JSON.stringify({
      tool: 'ArmBench Optimization Lab',
      author: 'Aariv Patel',
      generatedAt: new Date().toISOString(),
      basis: 'live measurements plus a documented roofline model',
      lab,
      machineRoofs: roofs,
      roofline: pos,
    }, null, 2));
  } else {
    console.log('----------------------------------------------------------------');
    console.log('ArmBench Optimization Lab. Author: Aariv Patel');
    console.log('Five configs for ' + labWorkload + ' at ' + labSize + ' px, seed ' + seed +
      ', ' + lab.iterations + ' iterations each. All speeds measured live.');
    console.log('----------------------------------------------------------------');
    console.log(
      'Config'.padEnd(38) +
      'Intent'.padEnd(9) +
      'Ops/sec'.padEnd(12) +
      'Speedup'.padEnd(10) +
      'Accuracy'.padEnd(14) +
      'Frontier'
    );
    for (const c of lab.configs) {
      console.log(
        c.name.padEnd(38) +
        c.declared.padEnd(9) +
        fmt(c.opsPerSec, 1).padEnd(12) +
        (c.speedup === null ? 'n/a' : fmt(c.speedup, 3) + 'x').padEnd(10) +
        (c.exact ? 'bit identical' : fmt(c.accuracyPct, 2) + '%').padEnd(14) +
        (lab.frontierIds.includes(c.id) ? 'yes' : '')
      );
    }
    console.log('');
    console.log('Pareto frontier: ' + lab.frontierIds.join(', '));
    console.log(lab.verdict);
    console.log('Roofline (model): intensity ' + fmt(workloadIntensity(labWorkload), 2) +
      ' ops/byte, memory roof ' + fmtInt(roofs.memoryBytesPerSec) + ' B/s measured, compute roof ' +
      fmtInt(roofs.computeOpsPerSec) + ' ops/s measured, ceiling ' + fmtInt(pos.ceilingOpsPerSec) +
      ' ops/s, headroom ' + (pos.headroomPct === null ? 'n/a' : fmt(pos.headroomPct, 1) + '%') +
      ', bounded by ' + pos.bounded + '.');
    console.log('Honesty: speeds are live measurements; roofline headroom is a model, not a measurement.');
  }
  process.exit(0);
}

let steps;
try {
  steps = planRun({ seed, sizes, iterations });
} catch (err) {
  console.error('Invalid arguments. ' + err.message);
  process.exit(2);
}
const rows = [];
for (const step of steps) {
  rows.push(executeStep(step));
}

if (asJson) {
  const payload = {
    tool: 'ArmBench',
    author: 'Aariv Patel',
    generatedAt: new Date().toISOString(),
    basis: 'local measurements plus labeled estimates',
    honesty: 'No AWS Graviton instance was contacted. Cloud figures are estimates from the documented model, not measurements.',
    options: { seed, iterations, sizes },
    env,
    estimateModel: {
      target: ESTIMATE_MODEL.target,
      clockRatio: ESTIMATE_MODEL.clockRatio,
      memRatio: ESTIMATE_MODEL.memRatio,
      coreFactor: ESTIMATE_MODEL.coreFactor,
      assumptions: ESTIMATE_MODEL.assumptions,
    },
    results: rows.map((r) => ({
      ...r,
      dispersion: {
        stdDevMs: r.stdDevMs,
        cvPercent: r.cvPercent,
        p95Ms: r.p95Ms,
        trimmedMeanMs: r.trimmedMeanMs,
        stability: r.stability,
      },
      cloudEstimate: {
        isEstimate: true,
        opsPerSec: estimateFromLocal(r.opsPerSec ?? 0).opsPerSec,
        meanMs: estimateLatencyMs(r.meanMs),
      },
    })),
    dispersionSummary: runTelemetry(rows),
  };
  console.log(JSON.stringify(payload, null, 2));
} else {
  const line = '----------------------------------------------------------------';
  console.log(line);
  console.log('ArmBench, Node Run. Author: Aariv Patel');
  console.log('Local measurements with clearly labeled cloud estimates.');
  console.log(line);
  console.log('Environment (runtime reported): ' + env.runtime);
  console.log('Note: no AWS Graviton instance was contacted. Graviton figures are estimates.');
  console.log('');
  console.log(
    'Workload'.padEnd(38) +
    'Size'.padEnd(16) +
    'Iters'.padEnd(7) +
    'Mean ms'.padEnd(10) +
    'Ops/sec'.padEnd(13) +
    'Graviton ops/sec (Estimate)'
  );
  for (const r of rows) {
    const size = r.workloadId === 'video'
      ? VIDEO_CONFIG.width + 'x' + VIDEO_CONFIG.height + ' x' + VIDEO_CONFIG.frames + 'f'
      : String(r.size) + ' px';
    const est = r.opsPerSec === null ? 'n/a' : fmt(estimateFromLocal(r.opsPerSec).opsPerSec, 1);
    console.log(
      r.label.padEnd(38) +
      size.padEnd(16) +
      String(r.iterations).padEnd(7) +
      fmt(r.meanMs).padEnd(10) +
      fmt(r.opsPerSec, 1).padEnd(13) +
      est
    );
  }
  console.log('');
  console.log('Estimate model: ' + 'estimate = local ops/sec x ' + fmt(ESTIMATE_MODEL.clockRatio, 4) +
    ' (clock) x ' + ESTIMATE_MODEL.memRatio + ' (memory) x ' + ESTIMATE_MODEL.coreFactor + ' (cores)');
  console.log('Target: ' + ESTIMATE_MODEL.target);
  for (const a of ESTIMATE_MODEL.assumptions) {
    console.log('Assumption, ' + a.name + ': ' + a.detail);
  }
  console.log('');
  const disp = runTelemetry(rows);
  console.log('Timing dispersion (measured): ' + disp.count + ' rows, mean cv ' +
    (disp.meanCvPercent === null ? 'n/a' : fmt(disp.meanCvPercent, 1) + ' percent') +
    ', worst cv ' + (disp.worstCvPercent === null ? 'n/a' : fmt(disp.worstCvPercent, 1) + ' percent') +
    ', verdict ' + disp.verdict);
  console.log('');
  console.log('Largest size throughput summary (measured locally):');
  const big = rows.filter((r) => r.workloadId !== 'video' && r.size === Math.max(...sizes));
  for (const r of big) {
    console.log('  ' + r.label + ': ' + fmtInt(r.opsPerSec) + ' ' + r.unit);
  }
  console.log('');
  console.log('Reproduce: node scripts/run-bench.mjs --seed ' + seed + ' --iterations ' + iterations + ' --all-sizes');
  console.log('On an AWS Graviton instance (Node 18+): run the same command with --json and compare.');
  console.log('Honesty statement: every number above is measured on this machine,');
  console.log('except Graviton columns, which are labeled estimates from the model.');
}
