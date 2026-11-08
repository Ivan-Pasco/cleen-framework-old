/**
 * harness.mjs — shared pieces of the frame.canvas runtime tests that run
 * compiled scenes: a page with recording <canvas> elements, a manual
 * requestAnimationFrame, the real runtime/canvas-bridge.js + runtime/loader.js,
 * and scene compilation with the plugin in this directory
 * (--plugin-override).
 *
 * Compiler: $CLEEN_CLN, else ~/.cleen/bin/cln (build the plugin first).
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const runtimeDir = join(here, '..', '..');
export const pluginDir = join(runtimeDir, '..');
export const compiler = process.env.CLEEN_CLN || join(homedir(), '.cleen', 'bin', 'cln');

// ---------------------------------------------------------------------------
// Page: canvases whose 2D context records every call and property write
// ---------------------------------------------------------------------------

// A <canvas> element. `ctx.log` holds ['call', name, args] and
// ['set', name, value] in order; `ctx.state` the current property values.
export function makeCanvas(id, width = 300, height = 150) {
  const log = [];
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000' };
  const stack = [];
  const gradient = () => ({ addColorStop() {} });
  const methods = {
    save() { stack.push({ ...state }); },
    restore() { if (stack.length) Object.assign(state, stack.pop()); },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: (text) => ({ width: String(text).length * 6 }),
  };
  const ctx = new Proxy({ log, state }, {
    get(target, key) {
      if (key === 'log' || key === 'state') return target[key];
      if (key === 'canvas') return element;
      if (key in state) return state[key];
      return (...args) => {
        log.push(['call', key, args]);
        if (methods[key]) return methods[key](...args);
        return undefined;
      };
    },
    set(_, key, value) {
      state[key] = value;
      log.push(['set', key, value]);
      return true;
    },
  });
  const listeners = new Map();
  const element = {
    tagName: 'CANVAS',
    id,
    width,
    height,
    style: {},
    ctx,
    getContext: () => ctx,
    setAttribute() {},
    getAttribute: (name) => (name === 'data-scene' ? element.dataScene || null : null),
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: element.width, height: element.height }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    // Fire a DOM event at the canvas.
    fire(type, props = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, preventDefault() {}, button: 0, clientX: 0, clientY: 0, key: '', touches: [], ...props });
      }
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
  return element;
}

// Fill colours drawn on `ctx` (fillRect calls, with the fillStyle at the
// time), in order.
export function fills(ctx) {
  const out = [];
  let style = '#000';
  for (const entry of ctx.log) {
    if (entry[0] === 'set' && entry[1] === 'fillStyle') style = entry[2];
    if (entry[0] === 'call' && entry[1] === 'fillRect') out.push(style);
  }
  return out;
}

// Install globals for a page holding `canvases` (by id). Returns the page
// with a manual animation-frame queue: page.frame(ms) runs the callbacks
// requested so far at timestamp `ms`.
export function installPage(canvases) {
  const byId = new Map(canvases.map((c) => [c.id, c]));
  let raf = [];
  let nextRaf = 1;
  const docListeners = new Map();
  const page = {
    canvases: byId,
    hidden: false,
    frame(ms) {
      const due = raf;
      raf = [];
      for (const [, fn] of due) fn(ms);
    },
    pending: () => raf.length,
    setHidden(hidden) {
      page.hidden = hidden;
      globalThis.document.hidden = hidden;
      for (const fn of docListeners.get('visibilitychange') || []) fn({ type: 'visibilitychange' });
    },
  };
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextRaf++;
    raf.push([id, fn]);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    raf = raf.filter(([rid]) => rid !== id);
  };
  globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } addEventListener() {} };
  globalThis.document = {
    hidden: false,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return makeCanvas('');
    },
    body: { appendChild() {} },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener() {},
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  return page;
}

// The real runtime (after installPage: the bridge reads `document`).
export function loadRuntime() {
  const { CanvasBridge } = require(join(runtimeDir, 'canvas-bridge.js'));
  globalThis.CanvasBridge = CanvasBridge;
  return { CanvasBridge, ...require(join(runtimeDir, 'loader.js')) };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'canvas-harness-'));
let count = 0;

export function requireCompiler(suite) {
  if (!existsSync(compiler)) {
    console.log(`FAIL: ${suite} — compiler not found at ${compiler} (set CLEEN_CLN)`);
    process.exit(1);
  }
}

// Compile Clean source `source` for the browser; returns the module bytes.
export function compileScene(source, label = 'scene') {
  const file = join(work, `${label}-${count++}.cln`);
  writeFileSync(file, source);
  const out = file.replace(/\.cln$/, '.wasm');
  try {
    execFileSync(compiler, ['compile', file, '-o', out, '--target', 'browser',
      '--plugin-override', `frame.canvas=${pluginDir}`], { stdio: 'pipe', cwd: work });
  } catch (err) {
    throw new Error(`${label} did not compile:\n${String(err.stdout || '')}${String(err.stderr || '')}`);
  }
  const bytes = readFileSync(out);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Drop the runtime's progress lines ("[CleanCanvas] ...", "[CanvasBridge] ...").
export function quietRuntimeLogs() {
  const log = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && /^\[(CleanCanvas|CanvasBridge|clean)\]/.test(args[0])) return;
    log(...args);
  };
}

export function cleanup() {
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function checker() {
  const state = { failures: 0 };
  state.check = (cond, message) => {
    if (!cond) {
      state.failures++;
      console.log(`FAIL: ${message}`);
    }
  };
  return state;
}

export const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
