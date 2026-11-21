/**
 * ArmBench browser app.
 * Wires the shared core (kernels, timing harness, estimate model, report
 * generator) to the instrument panel. All timing happens here in the page;
 * nothing is fetched and nothing leaves the machine.
 */
import {
  makeImage, planRun, executeStep, workloadById,
  ESTIMATE_MODEL, estimateFromLocal, estimateFactor, badgeFor, BASIS,
  runTelemetry, speedupBetween, timingStats,
  generateReport as buildReportText,
  fmt, fmtInt,
} from './armbench-core.js';

window.__ARMBENCH_LOADED__ = true;

const $ = (sel) => document.querySelector(sel);

const els = {
  roState: $('#ro-state'),
  roHost: $('#ro-host'),
  roCores: $('#ro-cores'),
  roSeed: $('#ro-seed'),
  sizeSelect: $('#size-select'),
  itersInput: $('#iters-input'),
  seedInput: $('#seed-input'),
  runBtn: $('#run-btn'),
  benchStatus: $('#bench-status'),
  queueList: $('#queue-list'),
  resultsBody: $('#results-body'),
  compareBody: $('#compare-body'),
  chartCanvas: $('#chart-canvas'),
  assumptionsList: $('#assumptions-list'),
  formulaLine: $('#formula-line'),
  specUa: $('#spec-ua'),
  specCores: $('#spec-cores'),
  envRuntime: $('#env-runtime'),
  previewCanvas: $('#preview-canvas'),
  genBtn: $('#gen-report-btn'),
  copyBtn: $('#copy-report-btn'),
  reportOutput: $('#report-output'),
  copiedNote: $('#copied-note'),
  cancelBtn: $('#cancel-btn'),
  downloadBtn: $('#download-report-btn'),
  telemetryBody: $('#telemetry-body'),
  scalingBody: $('#scaling-body'),
  scalingWorkload: $('#scaling-workload'),
  tmCount: $('#tm-count'),
  tmMeanCv: $('#tm-mean-cv'),
  tmWorstCv: $('#tm-worst-cv'),
  tmVerdict: $('#tm-verdict'),
  shortcutsDialog: $('#shortcuts-dialog'),
  shortcutsClose: $('#shortcuts-close'),
  shortcutsBtn: $('#shortcuts-btn'),
  shortcutsToggle: $('#shortcuts-toggle'),
};

const state = {
  running: false,
  cancelled: false,
  lastRun: null,
  shortcutsEnabled: true,
};

/* Single-key shortcuts can be turned off, which keeps WCAG 2.1.4 satisfied
   for users whose own tools listen on plain character keys. The choice is
   remembered in local storage when the runtime offers it. */
const SHORTCUTS_KEY = 'armbench.shortcutsEnabled';

function loadShortcutPref() {
  try {
    const raw = window.localStorage ? window.localStorage.getItem(SHORTCUTS_KEY) : null;
    return raw !== 'off';
  } catch (err) {
    return true;
  }
}

function saveShortcutPref(enabled) {
  try {
    if (window.localStorage) {
      window.localStorage.setItem(SHORTCUTS_KEY, enabled ? 'on' : 'off');
    }
  } catch (err) {
    /* Storage is optional; the toggle still applies for the session. */
  }
}

/* Host readout, reported verbatim by the runtime ------------------------ */

function shortRuntime() {
  const cores = navigator.hardwareConcurrency ? navigator.hardwareConcurrency + ' cores' : 'cores unknown';
  const platform = navigator.platform || 'platform unknown';
  return platform + ', ' + cores;
}

function initHostReadout() {
  const ua = navigator.userAgent;
  const cores = navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency + ' logical cores (runtime reported)'
    : 'logical core count not reported by this runtime';
  els.roHost.textContent = shortRuntime();
  els.roCores.textContent = String(navigator.hardwareConcurrency ?? 'unknown');
  els.specUa.textContent = ua;
  els.specCores.textContent = cores;
  els.envRuntime.textContent = ua + ', ' + cores;
}

/* Seeded preview ---------------------------------------------------------- */

function drawPreview() {
  const seed = clampInt(els.seedInput.value, 0, 999999, 1337);
  const img = makeImage(seed, 96, 96);
  const ctx = els.previewCanvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), 96, 96), 0, 0);
  els.roSeed.textContent = String(seed);
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* Assumptions and formula, rendered from the single source of truth ------- */

function initEstimatePanel() {
  els.assumptionsList.textContent = '';
  for (const a of ESTIMATE_MODEL.assumptions) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'a-name';
    name.textContent = a.name;
    const detail = document.createElement('p');
    detail.className = 'a-detail';
    detail.textContent = a.detail;
    li.append(name, detail);
    els.assumptionsList.append(li);
  }
  els.formulaLine.textContent =
    'estimate = local ops/sec x ' + fmt(ESTIMATE_MODEL.clockRatio, 4) +
    ' (clock) x ' + ESTIMATE_MODEL.memRatio + ' (memory) x ' + ESTIMATE_MODEL.coreFactor +
    ' (cores), combined factor ' + fmt(estimateFactor(), 4) +
    '. Target: ' + ESTIMATE_MODEL.target;
}

/* Run flow ----------------------------------------------------------------- */

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setControlsDisabled(disabled) {
  els.sizeSelect.disabled = disabled;
  els.itersInput.disabled = disabled;
  els.seedInput.disabled = disabled;
  els.runBtn.disabled = disabled;
  els.runBtn.textContent = disabled ? 'Running' : 'Run Bench';
  els.cancelBtn.disabled = !disabled;
}

function buildQueue(steps) {
  els.queueList.textContent = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.dataset.state = 'pending';
    const dot = document.createElement('span');
    dot.className = 'q-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    const wl = workloadById(step.workloadId);
    const where = step.workloadId === 'video' ? '8 frame pipeline' : step.size + ' px';
    name.textContent = wl.label + ', ' + where + ', ' + step.iterations + ' iterations';
    const ms = document.createElement('span');
    ms.className = 'q-ms';
    li.append(dot, name, ms);
    els.queueList.append(li);
  }
}

function markQueue(index, stateName, row) {
  const li = els.queueList.children[index];
  if (!li) return;
  li.dataset.state = stateName;
  if (row) {
    li.querySelector('.q-ms').textContent = fmt(row.meanMs) + ' ms';
  }
}

function status(text) {
  els.benchStatus.textContent = text;
}

async function runBench() {
  if (state.running) return;
  const sizeVal = els.sizeSelect.value;
  const sizes = sizeVal === 'all' ? [256, 512, 1024] : [Number.parseInt(sizeVal, 10)];
  const iterations = clampInt(els.itersInput.value, 1, 8, 5);
  const seed = clampInt(els.seedInput.value, 0, 999999, 1337);
  els.itersInput.value = String(iterations);
  els.seedInput.value = String(seed);

  state.running = true;
  state.cancelled = false;
  setControlsDisabled(true);
  els.roState.textContent = 'Running';
  els.genBtn.disabled = true;
  els.copyBtn.disabled = true;
  els.downloadBtn.disabled = true;
  const startedAt = performance.now();
  const steps = planRun({ seed, sizes, iterations });
  buildQueue(steps);
  status('Run started with seed ' + seed + '. One warmup pass per workload is excluded from timing.');

  const rows = [];
  let cancelled = false;
  let failure = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      if (state.cancelled) { cancelled = true; break; }
      const step = steps[i];
      const wl = workloadById(step.workloadId);
      const where = step.workloadId === 'video' ? 'the 8 frame pipeline' : step.size + ' px';
      markQueue(i, 'running');
      status('Running ' + wl.label + ' at ' + where + ', ' + step.iterations + ' timed iterations.');
      await yieldToUi();
      if (state.cancelled) { cancelled = true; break; }
      const row = executeStep(step);
      rows.push(row);
      markQueue(i, 'done', row);
      await yieldToUi();
    }
  } catch (err) {
    failure = err;
  } finally {
    setControlsDisabled(false);
    state.running = false;
  }

  if (failure) {
    els.roState.textContent = 'Ready';
    status('Run stopped after ' + rows.length + ' completed steps: ' +
      (failure && failure.message ? failure.message : 'engine error') +
      '. No partial or synthesized report was produced.');
    return;
  }

  if (cancelled || rows.length === 0) {
    els.roState.textContent = 'Ready';
    status('Run cancelled after ' + rows.length + ' completed steps. No partial or synthesized report was produced.');
    return;
  }

  const wallSeconds = (performance.now() - startedAt) / 1000;
  state.lastRun = { at: new Date().toISOString(), seed, sizes, iterations, rows };
  renderResults(rows);
  renderCompare();
  renderTelemetry(rows);
  renderScaling();
  drawChart();
  els.genBtn.disabled = false;
  els.downloadBtn.disabled = false;
  els.roState.textContent = 'Ready';
  status('Run complete: ' + rows.length + ' measured readings in ' + fmt(wallSeconds, 1) +
    ' seconds. Comparison, telemetry and report are ready. Every reading above is a live measurement.');
}

/* Results table --------------------------------------------------------------- */

function renderResults(rows) {
  const tbody = els.resultsBody;
  tbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'workload';
    tdName.textContent = r.label;
    tr.append(tdName);

    const tdSize = document.createElement('td');
    tdSize.textContent = r.workloadId === 'video' ? r.size : r.size + ' px';
    tr.append(tdSize);

    const tdIters = document.createElement('td');
    tdIters.className = 'num';
    tdIters.textContent = String(r.iterations);
    tr.append(tdIters);

    const tdMean = document.createElement('td');
    tdMean.className = 'num';
    tdMean.textContent = fmt(r.meanMs);
    tr.append(tdMean);

    const tdMedian = document.createElement('td');
    tdMedian.className = 'num';
    tdMedian.textContent = fmt(r.medianMs);
    tr.append(tdMedian);

    const tdOps = document.createElement('td');
    tdOps.className = 'num';
    tdOps.textContent = r.workloadId === 'video'
      ? fmtInt(r.opsPerSec) + ' pipelines'
      : fmtInt(r.opsPerSec);
    tr.append(tdOps);

    const tdBasis = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge badge--measured';
    badge.textContent = badgeFor(BASIS.MEASURED);
    tdBasis.append(badge);
    tr.append(tdBasis);

    tbody.append(tr);
  }
}

/* Compare panel ---------------------------------------------------------------- */

function compareRows() {
  const rows = state.lastRun.rows;
  const numericSizes = rows.filter((r) => typeof r.size === 'number').map((r) => r.size);
  const maxSize = Math.max(...numericSizes);
  return rows.filter((r) => r.size === maxSize || r.workloadId === 'video');
}

function renderCompare() {
  const rows = compareRows();
  const tbody = els.compareBody;
  tbody.textContent = '';
  for (const r of rows) {
    const est = estimateFromLocal(r.opsPerSec ?? 0);
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'workload';
    tdName.textContent = r.label;
    tr.append(tdName);

    const tdSize = document.createElement('td');
    tdSize.textContent = r.workloadId === 'video' ? r.size : r.size + ' px';
    tr.append(tdSize);

    const unit = r.workloadId === 'video' ? ' pipelines/sec' : '';
    const tdLocal = document.createElement('td');
    tdLocal.className = 'num';
    const localVal = document.createElement('span');
    localVal.textContent = fmtInt(r.opsPerSec) + unit;
    const localBadge = document.createElement('span');
    localBadge.className = 'badge badge--measured';
    localBadge.textContent = badgeFor(BASIS.MEASURED);
    tdLocal.append(localVal, ' ', localBadge);
    tr.append(tdLocal);

    const tdEst = document.createElement('td');
    tdEst.className = 'num cell-est';
    const estVal = document.createElement('span');
    estVal.textContent = fmtInt(est.opsPerSec) + unit;
    const estBadge = document.createElement('span');
    estBadge.className = 'badge badge--estimate';
    estBadge.textContent = badgeFor(BASIS.ESTIMATE);
    tdEst.append(estVal, ' ', estBadge);
    tr.append(tdEst);

    const tdFactor = document.createElement('td');
    tdFactor.className = 'num';
    tdFactor.textContent = fmt(est.factor, 4);
    tr.append(tdFactor);

    tbody.append(tr);
  }
}

/* Timing telemetry ------------------------------------------------------------ */

function stabilityClass(stability) {
  if (stability === 'stable') return 'badge badge--measured';
  if (stability === 'variable') return 'badge badge--variable';
  return 'badge badge--noisy';
}

function renderTelemetry(rows) {
  const t = runTelemetry(rows);
  els.tmCount.textContent = String(t.count);
  els.tmMeanCv.textContent = t.meanCvPercent === null ? 'n/a' : fmt(t.meanCvPercent, 1) + ' percent';
  els.tmWorstCv.textContent = t.worstCvPercent === null ? 'n/a' : fmt(t.worstCvPercent, 1) + ' percent';
  els.tmVerdict.textContent = t.verdict;

  const tbody = els.telemetryBody;
  tbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = [
      r.label,
      r.workloadId === 'video' ? r.size : r.size + ' px',
      fmt(r.meanMs, 3),
      Number.isFinite(r.stdDevMs) ? fmt(r.stdDevMs, 3) : 'n/a',
      Number.isFinite(r.cvPercent) ? fmt(r.cvPercent, 1) : 'n/a',
      Number.isFinite(r.p95Ms) ? fmt(r.p95Ms, 3) : 'n/a',
      Number.isFinite(r.trimmedMeanMs) ? fmt(r.trimmedMeanMs, 3) : 'n/a',
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i > 1) td.className = 'num';
      td.textContent = text;
      tr.append(td);
    });
    const td = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = stabilityClass(r.stability);
    badge.textContent = r.stability;
    td.append(badge);
    tr.append(td);
    tbody.append(tr);
  }
  tbody.setAttribute('aria-label', 'Per row dispersion for ' + rows.length + ' measured passes. ' + t.verdict + '.');
}

function renderScaling() {
  if (!state.lastRun) return;
  const rows = state.lastRun.rows;
  const id = els.scalingWorkload.value;
  const pairs = [[256, 512], [512, 1024], [256, 1024]];
  const tbody = els.scalingBody;
  tbody.textContent = '';
  let shown = 0;
  for (const [a, b] of pairs) {
    const s = speedupBetween(rows, id, a, b);
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = a + ' px versus ' + b + ' px';
    tr.append(name);
    for (const val of [s ? s.opsA : null, s ? s.opsB : null, s ? s.ratio : null]) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = val === null ? 'not run' :
        (val === s.ratio ? fmt(val, 3) + ' x' : fmtInt(val));
      tr.append(td);
    }
    tbody.append(tr);
    if (s) shown++;
  }
  if (shown === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'The selected workload was not measured at two comparable sizes. Run all sizes for a full scaling view.';
    tr.append(td);
    tbody.replaceChildren(tr);
  }
}

/* Chart --------------------------------------------------------------------------- */

let chartResizeTimer = null;

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    accent: css.getPropertyValue('--color-accent').trim(),
    line: css.getPropertyValue('--color-line').trim(),
    lineStrong: css.getPropertyValue('--color-line-strong').trim(),
    muted: css.getPropertyValue('--color-muted').trim(),
    faint: css.getPropertyValue('--color-faint').trim(),
    ink: css.getPropertyValue('--color-ink').trim(),
    hatch: css.getPropertyValue('--color-hatch').trim(),
  };
}

function drawHatchRect(ctx, x, y, w, h, hatchColor, lineColor) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = hatchColor;
  ctx.lineWidth = 1;
  for (let i = -h; i < w; i += 5) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.strokeStyle = lineColor;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

function shortLabel(label) {
  return label.split(' (')[0];
}

function drawChart() {
  const canvas = els.chartCanvas;
  const colors = chartColors();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 0);
  const h = canvas.clientHeight || 360;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 80 || h < 80) {
    /* A collapsed or display none canvas has nothing to draw into. */
    return;
  }
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const padL = 14;
  const padR = 14;
  const padT = 26;
  const padB = 40;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  // Rhythm hairlines
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (innerH * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  if (!state.lastRun) {
    ctx.fillStyle = colors.faint;
    ctx.font = '12px ' + getComputedStyle(document.body).getPropertyValue('font-family').split(',')[0] + ', monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No Run Yet. Press Run Bench In Panel 01.', w / 2, h / 2);
    return;
  }

  const rows = compareRows();
  const slot = innerW / rows.length;
  const barW = Math.max(10, Math.min(34, slot * 0.26));
  const gap = 6;
  const showValues = slot >= 88;

  rows.forEach((r, i) => {
    const est = estimateFromLocal(r.opsPerSec ?? 0);
    const groupMax = Math.max(r.opsPerSec ?? 0, est.opsPerSec) || 1;
    const cx = padL + slot * i + slot / 2;
    const xLocal = cx - gap / 2 - barW;
    const xEst = cx + gap / 2;
    const hLocal = Math.max(2, ((r.opsPerSec ?? 0) / groupMax) * innerH);
    const hEst = Math.max(2, (est.opsPerSec / groupMax) * innerH);
    const base = padT + innerH;

    // Measured bar, solid signal
    ctx.fillStyle = colors.accent;
    ctx.fillRect(xLocal, base - hLocal, barW, hLocal);
    // Estimated bar, hatched and dashed
    drawHatchRect(ctx, xEst, base - hEst, barW, hEst, colors.hatch, colors.lineStrong);

    if (showValues) {
      ctx.fillStyle = colors.ink;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(fmtInt(r.opsPerSec), xLocal + barW / 2, base - hLocal - 5);
      ctx.fillStyle = colors.muted;
      ctx.fillText(fmtInt(est.opsPerSec), xEst + barW / 2, base - hEst - 5);
    }

    // Group label
    ctx.fillStyle = colors.muted;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    let name = shortLabel(r.label);
    const maxTextW = slot - 8;
    while (ctx.measureText(name).width > maxTextW && name.length > 3) {
      name = name.slice(0, -2);
    }
    ctx.fillText(name, cx, base + 16);
  });

  // Honest caption inside the drawing area
  ctx.fillStyle = colors.faint;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Solid: measured local. Hatched: estimated Graviton. Bars normalized within each group.', padL, padT - 10);

  // Accessible description
  const summary = rows
    .map((r) => shortLabel(r.label) + ' local ' + fmtInt(r.opsPerSec) + ', estimated ' + fmtInt(estimateFromLocal(r.opsPerSec ?? 0).opsPerSec))
    .join('; ');
  canvas.setAttribute('aria-label',
    'Bar chart comparing measured local throughput with estimated Graviton throughput for ' + rows.length +
    ' workloads at the largest image size plus the fixed video pipeline. Values in ops per second: ' + summary +
    '. Estimated values are projections, not measurements.');
}

/* Report --------------------------------------------------------------------------- */

function buildReport() {
  if (!state.lastRun) return;
  const run = state.lastRun;
  const env = {
    declared: 'Apple Silicon Mac, Arm64, macOS (declared by the author)',
    runtime: navigator.userAgent + ', ' +
      (navigator.hardwareConcurrency ? navigator.hardwareConcurrency + ' logical cores' : 'core count not reported'),
  };
  const meta = {
    author: 'Aariv Patel',
    generatedAt: run.at,
    seed: run.seed,
    sizes: run.sizes,
    iterations: run.iterations,
  };
  els.reportOutput.value = buildReportText(run.rows, env, meta);
  els.copyBtn.disabled = false;
  els.copiedNote.textContent = 'Report Ready';
}

async function downloadReport() {
  if (!state.lastRun) return;
  if (els.reportOutput.value.startsWith('No report yet')) buildReport();
  const text = els.reportOutput.value;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'armbench-report-' + state.lastRun.seed + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  els.copiedNote.textContent = 'Report Downloaded';
}

async function copyReport() {
  const text = els.reportOutput.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (err) {
    els.reportOutput.focus();
    els.reportOutput.select();
  }
  els.copiedNote.textContent = ok ? 'Copied To Clipboard' : 'Selected, Press Control C Or Command C';
  window.setTimeout(() => {
    els.copiedNote.textContent = '';
  }, 2400);
}

/* Wire up ---------------------------------------------------------------------------- */

function init() {
  initHostReadout();
  initEstimatePanel();
  drawPreview();
  drawChart();

  els.runBtn.addEventListener('click', runBench);
  els.cancelBtn.addEventListener('click', () => {
    if (state.running) {
      state.cancelled = true;
      status('Cancelling after the current step. Completed measurements are kept but no report is issued.');
    }
  });
  els.seedInput.addEventListener('change', drawPreview);
  els.genBtn.addEventListener('click', buildReport);
  els.copyBtn.addEventListener('click', copyReport);
  els.downloadBtn.addEventListener('click', downloadReport);
  els.scalingWorkload.addEventListener('change', renderScaling);
  els.shortcutsClose.addEventListener('click', () => els.shortcutsDialog.close());
  els.shortcutsBtn.addEventListener('click', () => els.shortcutsDialog.showModal());

  state.shortcutsEnabled = loadShortcutPref();
  els.shortcutsToggle.checked = state.shortcutsEnabled;
  els.shortcutsToggle.addEventListener('change', () => {
    state.shortcutsEnabled = els.shortcutsToggle.checked;
    saveShortcutPref(state.shortcutsEnabled);
    status(state.shortcutsEnabled
      ? 'Single-key shortcuts are on. Press ? outside a field for the list.'
      : 'Single-key shortcuts are off. The Shortcuts button still opens the list.');
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
    if (els.shortcutsDialog.open) return;
    if (!state.shortcutsEnabled) return;
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === '?' || key === '/') {
      event.preventDefault();
      els.shortcutsDialog.showModal();
    } else if (key === 'r') {
      event.preventDefault();
      runBench();
    } else if (key === 'g') {
      if (!els.genBtn.disabled) { event.preventDefault(); buildReport(); }
    } else if (key === 'e') {
      if (!els.downloadBtn.disabled) { event.preventDefault(); downloadReport(); }
    } else if (key === 'c') {
      if (!els.copyBtn.disabled) { event.preventDefault(); copyReport(); }
    }
  });
  els.itersInput.addEventListener('change', () => {
    els.itersInput.value = String(clampInt(els.itersInput.value, 1, 8, 5));
  });
  els.seedInput.addEventListener('change', () => {
    els.seedInput.value = String(clampInt(els.seedInput.value, 0, 999999, 1337));
  });

  window.addEventListener('resize', () => {
    window.clearTimeout(chartResizeTimer);
    chartResizeTimer = window.setTimeout(drawChart, 150);
  });

  /* Park the decorative scanline while the tab is hidden. */
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('tab-hidden', document.hidden);
  });
}

init();
