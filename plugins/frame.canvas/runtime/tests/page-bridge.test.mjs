/**
 * page-bridge.test.mjs — page.set / page.get between a canvas scene and the
 * HTML layer (CVS-I003), on a page that runs both runtimes the way a
 * frame.ui page does: frame.ui's runtime/loader.js (with a frontend module
 * using ui.setState / ui.getState) and this plugin's runtime started from
 * the page's <canvas data-scene="..."> (no script of the app's own).
 *
 * DOM: frame.ui/scripts/lib/dom_shim.mjs. Compiler: $CLEEN_CLN, else
 * ~/.cleen/bin/cln.
 *
 *   node plugins/frame.canvas/runtime/tests/page-bridge.test.mjs
 *
 * Exit 0 when every check passes, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { compiler, pluginDir, requireCompiler, runtimeDir } from './lib/harness.mjs';

const SUITE = 'frame.canvas page bridge';
requireCompiler(SUITE);

const plugins = join(pluginDir, '..');
const { createWindow, Event, CustomEvent, MutationObserver } = await import(join(plugins, 'frame.ui', 'scripts', 'lib', 'dom_shim.mjs'));

const work = mkdtempSync(join(tmpdir(), 'canvas-page-'));
function compile(name, source, overrides) {
  const file = join(work, `${name}.cln`);
  writeFileSync(file, source);
  const out = join(work, `${name}.wasm`);
  const args = ['compile', file, '-o', out, '--target', 'browser'];
  for (const o of overrides) args.push('--plugin-override', o);
  try {
    execFileSync(compiler, args, { stdio: 'pipe', cwd: work });
  } catch (err) {
    throw new Error(`${name} did not compile:\n${String(err.stdout || '')}${String(err.stderr || '')}`);
  }
  return readFileSync(out);
}

// The page layer: frame.ui frontend code.
const frontend = compile('frontend', `plugins:
\tframe.ui

start:
\tinteger s = ui.setState("difficulty", "\\"hard\\"")

functions:
\tvoid showScore()
\t\tinteger s = ui.updateElement("#score", ui.getState("score"))
`, [`frame.ui=${join(plugins, 'frame.ui')}`]);

// The canvas scene: writes its score and reads the page's difficulty.
const game = compile('Game', `plugins:
\tframe.canvas

canvasScene: id="game" width=100 height=50

\tstate:
\t\tinteger score = 0
\t\tinteger hardSeen = 0

\tdraw:
\t\tcanvas.clear color="#000000"

\tonFrame: param="dt"
\t\tinteger previous = page.get "score"
\t\tinteger missing = page.get "nothing"
\t\tpage.set "previous" value=previous
\t\tpage.set "missing" value=missing
\t\tscore = score + 7
\t\tpage.set "score" value=score
\t\tstring level = page.get "difficulty"
\t\tif level == "hard"
\t\t\thardSeen = hardSeen + 1
\t\tpage.set "hardSeen" value=hardSeen
`, [`frame.canvas=${pluginDir}`]);

const win = createWindow('<canvas id="game" width="100" height="50" data-scene="/scenes/Game.wasm"></canvas><span id="score"></span>');
const doc = win.document;
const canvasEl = doc.querySelector('#game');
const ctxCalls = [];
canvasEl.getContext = () => new Proxy({}, {
  get: (_, key) => (...args) => { ctxCalls.push([key, args]); return { addColorStop() {} }; },
  set: () => true,
});
canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
canvasEl.focus = () => {};
const loaderScript = doc.createElement('script');
loaderScript.setAttribute('data-wasm', 'frontend.wasm');
doc.currentScript = loaderScript;

const errors = [];
const fetched = [];
let raf = [];
const sandbox = {
  window: win,
  document: doc,
  console: { error: (...a) => errors.push(a.map(String).join(' ')), warn: () => {}, log: () => {}, info: () => {}, debug: () => {} },
  fetch: async (url) => {
    fetched.push(url);
    const path = new URL(url, 'https://site.test/play').pathname;
    const bytes = path === '/frontend.wasm' ? frontend : path === '/scenes/Game.wasm' ? game : null;
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  },
  requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
  cancelAnimationFrame: () => {},
  performance,
  location: { href: 'https://site.test/play' },
  navigator: {},
  Image: class { addEventListener() {} },
  WebAssembly, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, MutationObserver, Event, CustomEvent, URL,
};
win.requestAnimationFrame = sandbox.requestAnimationFrame;
vm.createContext(sandbox);
// Page order: frame.ui's runtime, then frame.canvas's (bridge, loader).
vm.runInContext(readFileSync(join(plugins, 'frame.ui', 'runtime', 'loader.js'), 'utf8'), sandbox, { filename: 'loader.js' });
vm.runInContext(readFileSync(join(runtimeDir, 'canvas-bridge.js'), 'utf8'), sandbox, { filename: 'frame-canvas-bridge.js' });
vm.runInContext(readFileSync(join(runtimeDir, 'loader.js'), 'utf8'), sandbox, { filename: 'frame-canvas.js' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 200 && !(win.__cleanRuntime && win.__cleanRuntime.getInstance); i++) await wait(5);
for (let i = 0; i < 200 && raf.length === 0; i++) await wait(5);

let failures = 0;
const check = (cond, message) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${message}`);
  }
};

check(fetched.includes('https://site.test/scenes/Game.wasm'), `the canvas runtime starts the scene its <canvas data-scene> names (fetched ${JSON.stringify(fetched)})`);
check(win.__cleanRuntime && typeof win.__cleanRuntime.registerEnv === 'function', 'frame.ui companion API is intact');
let t = 0;
for (let i = 0; i < 3; i++) {
  const due = raf;
  raf = [];
  t += 1000 / 60;
  for (const fn of due) fn(t);
}
const store = win.__cleanRuntime.pageState;
check(store && typeof store.get === 'function' && store.get('score') === '21', `page.set "score" is in the page store, JSON-encoded (got ${store && store.get('score')})`);
check(store.get('previous') === '14' && store.get('missing') === '0', `an integer receiver converts the page value; an unset key reads 0 (previous ${store.get('previous')}, missing ${store.get('missing')})`);
check(store.get('hardSeen') === '3', `page.get "difficulty" reads what ui.setState wrote (hardSeen ${store.get('hardSeen')})`);
win.__cleanRuntime.getInstance().exports.showScore();
check(doc.querySelector('#score').textContent === '21', `ui.getState("score") reads what page.set wrote (#score "${doc.querySelector('#score').textContent}")`);
check(ctxCalls.some(([k]) => k === 'fillRect'), 'the scene draws into the page canvas');
check(errors.length === 0, `no runtime errors (${errors.join(' | ')})`);

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.log(`FAIL: ${SUITE}`);
  process.exit(1);
}
console.log(`PASS: ${SUITE}`);
