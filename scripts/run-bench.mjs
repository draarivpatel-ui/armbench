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
 * Flags:
 *   --seed N         deterministic input seed, default 1337
 *   --size N         one square size in pixels: 256, 512 or 1024
 *   --all-sizes      run 256, 512 and 1024 (default)
 *   --iterations N   timed iterations per workload, default 5
 *   --json           print machine readable results instead of a table
 */
import os from 'node:os';
import {
  planRun, executeStep, estimateFromLocal, estimateLatencyMs,
  ESTIMATE_MODEL, fmt, fmtInt, VIDEO_CONFIG,
} from '../js/armbench-core.js';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(flag) {
  return args.includes(flag);
}

const seed = Number.parseInt(argValue('--seed') ?? '1337', 10);
const iterations = Math.max(1, Math.min(12, Number.parseInt(argValue('--iterations') ?? '5', 10) || 5));
const sizeArg = argValue('--size');
const sizes = sizeArg ? [Number.parseInt(sizeArg, 10)] : [256, 512, 1024];
const asJson = hasFlag('--json');

if (!Number.isFinite(seed) || sizes.some((s) => !Number.isFinite(s))) {
  console.error('Invalid arguments. Seed and size must be integers.');
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

const steps = planRun({ seed, sizes, iterations });
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
      cloudEstimate: {
        isEstimate: true,
        opsPerSec: estimateFromLocal(r.opsPerSec ?? 0).opsPerSec,
        meanMs: estimateLatencyMs(r.meanMs),
      },
    })),
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
