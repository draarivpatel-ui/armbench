/**
 * Minimal DOM and canvas adapter for booting the real browser app under node:test.
 * It parses the shipped index.html, exposes getElementById and querySelector,
 * records event listeners, and stubs the canvas 2d context. No dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

class ClassList {
  constructor(el) { this.el = el; }
  get list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  contains(v) { return this.list.includes(v); }
  add(...v) { this.el.setAttribute('class', [...new Set([...this.list, ...v])].join(' ')); }
  remove(...v) { this.el.setAttribute('class', this.list.filter((x) => !v.includes(x)).join(' ')); }
  toggle(v, force) {
    const on = force === undefined ? !this.contains(v) : !!force;
    if (on) this.add(v); else this.remove(v);
    return on;
  }
}

class Element {
  constructor(tag, doc) {
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {}, getPropertyValue() { return ''; } };
    this.dataset = {};
    this.classList = new ClassList(this);
    this._value = undefined;
    this._text = '';
    this.disabled = false;
    this._initialDisabled = false;
    this.open = false;
    this.colSpan = 1;
    this._context = null;
  }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  setAttribute(n, v) { this.attributes.set(n, String(v)); }
  removeAttribute(n) { this.attributes.delete(n); }
  hasAttribute(n) { return this.attributes.has(n); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() {
    return this.nodeType === 3 ? this._text : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren();
    if (String(v) !== '') this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = v; }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return sel ? (sel._value !== undefined ? sel._value : sel.getAttribute('value') || sel.textContent) : '';
    }
    if (this.localName === 'textarea') return this.textContent;
    return this.getAttribute('value') || '';
  }
  set value(v) { this._value = String(v); }
  getContext() {
    if (!this._context) this._context = makeContext();
    return this._context;
  }
  get clientWidth() { return Number(this.getAttribute('width')) || 600; }
  get clientHeight() { return Number(this.getAttribute('height')) || 360; }
  get parentElementOrDefault() { return this.parentElement; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { this.appendChild(this.ownerDocument.createTextNode(n)); continue; }
      if (n && n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event = {}) {
    const e = {
      type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {},
      key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, ...event,
    };
    for (const fn of this.listeners.get(type) || []) fn.call(this, e);
    return e;
  }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 240 }; }
  close() { this.open = false; }
  showModal() { this.open = true; }
}

class TextNode {
  constructor(text) { this._text = String(text); this.nodeType = 3; this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

function matches(node, selector) {
  return selector.split(',').some((part) => {
    const s = part.trim();
    if (s.startsWith('#')) return node.id === s.slice(1);
    if (s.startsWith('.')) return node.classList.contains(s.slice(1));
    if (s.startsWith('[')) {
      const m = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(s);
      return !!m && node.hasAttribute(m[1]) && (m[2] === undefined || node.getAttribute(m[1]) === m[2]);
    }
    return node.localName === s.toLowerCase();
  });
}

function makeContext() {
  const noop = () => {};
  return {
    canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
    globalAlpha: 1, calls: [],
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    rect() {}, clip() {}, stroke() {}, fill() {}, fillRect() {}, clearRect() {},
    strokeRect() {}, arc() {}, fillText() {}, setLineDash() {}, scale() {}, translate() {},
    putImageData() {}, drawImage() {}, createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    createRadialGradient() { return { addColorStop: noop }; },
    createLinearGradient() { return { addColorStop: noop }; },
    measureText(t) { return { width: String(t).length * 6 }; },
  };
}

function parseHtml(html, doc) {
  const root = new Element('fragment', doc);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)([^>]*?)(\/)?>|([^<]+)/g;
  let m;
  const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) {
      const text = m[5];
      if (text.trim()) stack[stack.length - 1].appendChild(new TextNode(text));
      continue;
    }
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClose = !!m[4] || voidTags.has(tag);
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].localName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = new Element(tag, doc);
    for (const a of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
    }
    if (el.hasAttribute('disabled')) el.disabled = true;
    if (el.hasAttribute('readonly')) el.readOnly = true;
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !['script', 'style', 'textarea', 'title'].includes(tag)) stack.push(el);
    if (['script', 'style', 'textarea', 'title'].includes(tag)) {
      const end = html.indexOf('</' + tag, re.lastIndex);
      if (end >= 0) {
        const inner = html.slice(re.lastIndex, end);
        el.appendChild(new TextNode(inner));
        re.lastIndex = html.indexOf('>', end) + 1;
      }
    }
  }
  return root;
}

export function boot(options = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const errors = [];
  const doc = {
    readyState: 'complete',
    activeElement: null,
    hidden: false,
    body: null,
    documentElement: null,
    createElement: (tag) => new Element(tag, doc),
    createTextNode: (text) => new TextNode(text),
    getElementById(id) { return this._byId.get(id) || null; },
    querySelector(sel) { return this._root.querySelector(sel); },
    querySelectorAll(sel) { return this._root.querySelectorAll(sel); },
    createElementNS(ns, tag) { const el = new Element(tag, doc); el.namespaceURI = ns; return el; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    _listeners: {},
    _byId: new Map(),
    execCommand() { return true; },
  };
  doc._root = parseHtml(html, doc);
  doc.body = doc._root.querySelector('body') || new Element('body', doc);
  doc.documentElement = doc._root.querySelector('html') || new Element('html', doc);
  const indexIds = () => {
    doc._byId.clear();
    const walk = (n) => { if (n.id) doc._byId.set(n.id, n); for (const c of n.children) walk(c); };
    walk(doc._root);
  };
  indexIds();

  const sandbox = {
    document: doc,
    window: {
      devicePixelRatio: 1,
      localStorage: options.localStorage,
      addEventListener(type, fn) { (sandbox.window._listeners[type] ||= []).push(fn); },
      _listeners: {},
      setTimeout: (fn, ms) => { if (!options.deferTimers && !ms) fn(); return 1; },
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {},
    },
    navigator: {
      userAgent: 'node dom harness', platform: 'arm64 test host', hardwareConcurrency: 8,
      clipboard: { writeText: async () => {} },
    },
    history: { replaceState() {} },
    performance: { now: () => Date.now() },
    getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }),
    ImageData: class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    TextEncoder, Uint8ClampedArray, Uint32Array, Math, Date, Number, String, Array, Object,
    JSON, Promise, Set, Map, isFinite, parseInt, parseFloat, console,
    setTimeout: (fn, ms) => { if (!options.deferTimers && !ms) fn(); return 1; },
    clearTimeout() {},
    requestAnimationFrame() { return 1; },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = doc;
  sandbox.window.location = options.location ||
    { hash: '', origin: 'http://harness.local', pathname: '/index.html', href: 'http://harness.local/index.html' };

  // Strip every ESM import line and evaluate the app body against the
  // imported core and lab modules, concatenated in dependency order.
  const body = appJs.replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/gm, '');
  const core = fs.readFileSync(path.join(ROOT, 'js/armbench-core.js'), 'utf8')
    .replace(/^export /gm, '');
  const lab = fs.readFileSync(path.join(ROOT, 'js/bench-lab.js'), 'utf8')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/gm, '')
    .replace(/^export /gm, '');
  const aliases = `
    const buildReportText = generateReport;
  `;
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(core + '\n' + lab + '\n' + aliases + '\n' + body + '\n;globalThis.__core = { makeImage, planRun, executeStep, workloadById, ESTIMATE_MODEL, estimateFromLocal, estimateFactor, badgeFor, BASIS, runTelemetry, speedupBetween, timingStats, generateReport, fmt, fmtInt };', context, { filename: 'app-boot.js' });
  } catch (err) {
    errors.push(String(err && err.stack ? err.stack : err));
  }
  indexIds();
  return {
    doc, errors, sandbox,
    get(id) { indexIds(); return doc.getElementById(id); },
    key(id, key, init = {}) {
      indexIds();
      for (const fn of doc._listeners.keydown || []) {
        fn({ key, code: key, target: doc.getElementById(id) || doc.body, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, ...init });
      }
    },
    globalKey(key, init = {}) {
      indexIds();
      for (const fn of doc._listeners.keydown || []) {
        fn({ key, code: key, target: doc.body, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, ...init });
      }
    },
    async settle(ms = 5) { await new Promise((r) => setTimeout(r, ms)); },
  };
}
