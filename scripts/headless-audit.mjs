/* ArmBench real headless Chromium audit.
 *
 * Serves the repository over a local static server, drives the installed
 * chrome-headless-shell over the DevTools protocol, and reports four error
 * classes at a desktop and a mobile viewport:
 *
 *   - console errors   (Runtime.consoleAPICalled of type error/assert)
 *   - page errors      (Runtime.exceptionThrown)
 *   - external errors  (requests to any host other than the local server)
 *   - overflow errors  (document scroll width wider than the viewport)
 *
 * Zero dependencies: Node built-ins plus the headless shell binary that is
 * already installed on this machine under the Playwright cache. Both the
 * server and the browser are closed in finally blocks so nothing is left
 * running when the script exits.
 *
 * Usage: node scripts/headless-audit.mjs [--bin /path/to/chrome-headless-shell]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png' };

const DEFAULT_BIN = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const BIN = arg('--bin') || process.env.ARMBENCH_HEADLESS_BIN || DEFAULT_BIN;

const VIEWPORTS = [
  { width: 1440, height: 900, mobile: false, label: '1440x900 desktop' },
  { width: 390, height: 844, mobile: true, label: '390x844 mobile' },
];

function serveStatic() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function launchBrowser() {
  return new Promise((resolve, reject) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armbench-audit-'));
    const child = spawn(BIN, [
      '--remote-debugging-port=0',
      '--user-data-dir=' + userDir,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ws = null;
    const timer = setTimeout(() => reject(new Error('headless shell did not print a DevTools url')), 15000);
    child.stderr.on('data', (buf) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(buf));
      if (m && !ws) {
        ws = m[1];
        clearTimeout(timer);
        resolve({ child, ws, userDir });
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', () => { clearTimeout(timer); if (!ws) reject(new Error('headless shell exited early')); });
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', (e) => reject(new Error('cdp connect failed')));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  start() {
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) fn(msg.params || {});
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 20000);
    });
  }
}

async function auditViewport(cdp, sessionId, base, vp, counters) {
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url: base + '/index.html' }, sessionId);
  await loaded;
  await new Promise((r) => setTimeout(r, 2500));
  const overflow = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const de = document.documentElement;
      const wide = de.scrollWidth > de.clientWidth ? { doc: [de.clientWidth, de.scrollWidth] } : null;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.clientWidth === 0) continue;
        const cs = getComputedStyle(el);
        // Only content that visibly spills counts; auto, scroll, hidden and
        // clip containers are meant to hold wider content internally.
        if (cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) {
          const cls = (el.getAttribute('class') || '').slice(0, 40);
          offenders.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + (cls ? '.' + cls : '') + ' ' + el.clientWidth + '<' + el.scrollWidth);
          if (offenders.length > 9) break;
        }
      }
      return JSON.stringify({ wide, offenders });
    })()`,
    returnByValue: true,
  }, sessionId);
  const evalValue = (r) => r && r.result && r.result.value !== undefined ? r.result.value : null;
  if (overflow.exceptionDetails) {
    counters.page++;
    console.log('  overflow probe threw: ' + JSON.stringify(overflow.exceptionDetails.text || ''));
  }
  const ov = JSON.parse(evalValue(overflow) || '{}');
  if (ov.wide) {
    counters.overflow++;
    console.log('  overflow: document wider than viewport ' + JSON.stringify(ov.wide));
  }
  for (const o of ov.offenders || []) {
    counters.overflow++;
    console.log('  overflow: ' + o);
  }
  // Exercise the lab run so lazy code paths are also error-checked.
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const b = document.getElementById('lab-run-btn'); if (b) b.click(); return true; })()`,
    returnByValue: true,
  }, sessionId);
  await new Promise((r) => setTimeout(r, 4000));
  const overflow2 = await cdp.send('Runtime.evaluate', {
    expression: `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
    returnByValue: true,
  }, sessionId);
  if (evalValue(overflow2) === true) {
    counters.overflow++;
    console.log('  overflow after lab run: document wider than viewport');
  }
}

const counts = { console: 0, page: 0, external: 0, overflow: 0 };
let server;
let browser;
try {
  if (!fs.existsSync(BIN)) {
    console.error('headless shell not found at ' + BIN);
    process.exit(2);
  }
  const s = await serveStatic();
  server = s.server;
  const base = 'http://127.0.0.1:' + s.port;
  browser = await launchBrowser();
  const cdp = await Cdp.connect(browser.ws);
  cdp.start();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'assert') {
      counts.console++;
      console.log('  console ' + p.type + ': ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    counts.page++;
    const d = p.exceptionDetails || {};
    console.log('  page error: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || '').slice(0, 200));
  });
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = new URL(p.request.url);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && !u.protocol.startsWith('devtools') && !u.protocol.startsWith('about')) {
      counts.external++;
      console.log('  external request: ' + p.request.url.slice(0, 160));
    }
  });
  cdp.on('Network.loadingFailed', (p) => {
    console.log('  note: request failed ' + p.errorText + ' ' + p.type);
  });
  for (const vp of VIEWPORTS) {
    console.log('viewport ' + vp.label);
    await auditViewport(cdp, sessionId, base, vp, counts);
  }
  cdp.ws.close();
} catch (err) {
  console.error('audit error: ' + (err && err.stack ? err.stack : err));
  counts.page++;
} finally {
  try { if (browser) browser.child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  try { if (server) server.close(); } catch (e) { /* already closed */ }
  try { if (browser && browser.userDir) fs.rmSync(browser.userDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
console.log('');
console.log('headless audit summary');
console.log('  console errors:  ' + counts.console);
console.log('  page errors:     ' + counts.page);
console.log('  external errors: ' + counts.external);
console.log('  overflow errors: ' + counts.overflow);
process.exit(counts.console + counts.page + counts.external + counts.overflow === 0 ? 0 : 1);
