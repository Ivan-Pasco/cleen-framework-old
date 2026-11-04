/**
 * scene-runtime.test.mjs — end-to-end check of the frame.canvas plugin
 * against its browser runtime: compiles fixtures/scene.cln with the plugin in
 * this directory (--plugin-override), instantiates the module with the real
 * runtime/loader.js + runtime/canvas-bridge.js over a recording fake 2D
 * context, and checks what the generated code registered and drew.
 *
 *   node plugins/frame.canvas/runtime/tests/scene-runtime.test.mjs
 *
 * Needs the old-toolchain compiler: $CLEEN_CLN, else ~/.cleen/bin/cln
 * (build the plugin first). Exit 0 when every check passes, 1 otherwise.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, '..');
const pluginDir = join(runtimeDir, '..');
const compiler = process.env.CLEEN_CLN || join(homedir(), '.cleen', 'bin', 'cln');

if (!existsSync(compiler)) {
  console.log(`FAIL: frame.canvas scene runtime — compiler not found at ${compiler} (set CLEEN_CLN)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Browser fakes: just enough DOM for the bridge, plus a 2D context that
// records every call.
// ---------------------------------------------------------------------------

const drawCalls = [];
const gradientStub = () => ({ addColorStop() {} });
const ctx2d = new Proxy(
  { createLinearGradient: gradientStub, createRadialGradient: gradientStub, measureText: () => ({ width: 10 }) },
  {
    get: (target, key) => (key in target ? target[key] : (...args) => { drawCalls.push([key, args]); }),
    set: (target, key, value) => { target[key] = value; return true; },
  },
);
const pageCanvas = { tagName: 'CANVAS', style: {}, getContext: () => ctx2d, addEventListener() {}, setAttribute() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) };
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } addEventListener() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.document = {
  getElementById: (id) => (id === 'decl' ? pageCanvas : null),
  createElement: () => { throw new Error('the scene must bind to the page canvas'); },
  body: { appendChild() {} },
  addEventListener() {},
};
globalThis.window = { addEventListener() {}, dispatchEvent() {} };

const { CanvasBridge } = require(join(runtimeDir, 'canvas-bridge.js'));
globalThis.CanvasBridge = CanvasBridge;
const { CleanCanvasLoader } = require(join(runtimeDir, 'loader.js'));

// ---------------------------------------------------------------------------
// Compile and instantiate
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'canvas-scene-'));
const wasmPath = join(work, 'scene.wasm');
try {
  execFileSync(compiler, ['compile', join(here, 'fixtures', 'scene.cln'), '-o', wasmPath, '--target', 'browser',
    '--plugin-override', `frame.canvas=${pluginDir}`], { stdio: 'pipe' });
} catch (err) {
  console.log('FAIL: frame.canvas scene runtime — fixture did not compile');
  console.log(String(err.stdout || '') + String(err.stderr || ''));
  process.exit(1);
}
const module = new WebAssembly.Module(readFileSync(wasmPath));
rmSync(work, { recursive: true, force: true });

const loader = new CleanCanvasLoader();
const env = { ...loader.bridge.getImports(null).env, ...loader.createStdlibImports() };
const memoryRuntime = loader.createMemoryRuntimeImports();
const missing = WebAssembly.Module.imports(module)
  .filter((i) => i.kind === 'function' && !(i.module === 'memory_runtime' ? memoryRuntime : env)[i.name])
  .map((i) => `${i.module}.${i.name}`);

let failures = 0;
function check(cond, message) {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${message}`);
  }
}

check(missing.length === 0, `runtime provides every import the module needs (missing: ${missing.join(', ')})`);
if (missing.length > 0) {
  console.log('FAIL: frame.canvas scene runtime');
  process.exit(1);
}

const originalLog = console.log;
const printed = [];
console.log = (...args) => printed.push(args.join(' '));
const instance = new WebAssembly.Instance(module, { env, memory_runtime: memoryRuntime });
loader.attachInstance(instance);
instance.exports._start();
console.log = originalLog;

const bridge = loader.bridge;
const vars = bridge.canvasVars;

// ---------------------------------------------------------------------------
// start: — canvas, assets, layers, registrations, state, init:
// ---------------------------------------------------------------------------

check(printed.includes('boot'), 'user start: ran');
const canvas = bridge.canvases.get(1);
check(canvas && canvas.element === pageCanvas && canvas.width === 640 && canvas.height === 360,
  'canvasScene id= binds the page <canvas> at width x height (CVS-I001)');
check(bridge.namedSprites.has('hero') && bridge.namedSprites.get('hero').frameWidth === 48, 'spritesheet registered with integer frame size');
check(bridge.namedImages.has('sky'), 'image asset preloaded');
check(JSON.stringify([...bridge.namedLayers].map(([k, v]) => [k, v.z])) === '[["background",0],["world",10],["hud",100]]', 'layers declared with z');
check(vars.get('heroX') === 40 && vars.get('lives') === 3 && vars.get('attacking') === 0, 'state initialised in the store (booleans as 0 / 1)');

const slideIn = bridge.namedTweens.get('slideIn');
check(slideIn && slideIn.vars.length === 2, 'tween registers one entry per variable line');
check(slideIn && slideIn.vars[0].from === -50 && slideIn.vars[0].to === 140, 'tween from= / to= are expressions (to=heroX + 100.0)');
check(slideIn && Number.isNaN(slideIn.vars[1].from), 'omitted from= is NaN: start from the current value');
check(slideIn && slideIn.vars[0].ease === 'easeOutBack' && slideIn.vars[0].delay === 0.1, 'tween config lines');
const bob = bridge.namedTweens.get('bob');
check(bob && bob.vars[0].repeat === -1 && bob.vars[0].yoyo === true && bob.vars[0].ease === 'snap', 'repeat / yoyo / custom ease');
check(bridge.namedTweens.get('follow').vars[0].pathName === 'loop', 'along= names the path');
check(bridge.customEases.get('snap').y2 === 1.55, 'customEase registered');

const intro = bridge.namedTimelines.get('intro');
const steps = intro ? intro.config.steps.map((s) => [Math.round(s.at * 100) / 100, s.play]) : [];
check(JSON.stringify(steps) === '[[0,"slideIn"],[0.8,"bob"],[1.2,"follow"],[1.3,"bob"]]', `timeline at / after gap= / together stagger= step times (got ${JSON.stringify(steps)})`);
check(intro && Math.abs(intro.config.duration - 4.2) < 1e-9, 'timeline duration covers the longest step');
check(intro && intro.state === 'playing', 'init: `play timeline` ran');
const outro = bridge.namedTimelines.get('outro');
const outroSteps = outro ? outro.config.steps : [];
check(outroSteps.length === 3 && outroSteps[0].at === 0.5 && JSON.stringify(outroSteps[0].animate)
  === '{"varName":"heroY","from":0,"to":10,"duration":1,"delay":0.5,"ease":"easeInQuad"}', 'timeline `animate` action');
check(outroSteps.length === 3 && outroSteps[1].at === 2.25 && outroSteps[1].play === 'slideIn', 'after gap= follows the animate (delay + duration)');
check(outroSteps.length === 3 && Math.abs(outroSteps[2].at - 2.85) < 1e-9 && outroSteps[2].var === 'attacking' && outroSteps[2].set === 1,
  'onComplete: sets the variable when the timeline ends');

const fsm = bridge.namedAnimStates.get('heroFSM');
check(fsm && fsm.config.clips.attack === 'heroAttack' && fsm.config.onComplete.attack === 'idle', 'animState clips and transitions onComplete');
check(fsm && fsm.config.onComplete.hurt === 'idle', 'onComplete inside a state block');
check(fsm && fsm.state === 'running' && fsm.current === 'idle', 'init: `start animState` ran');
const idle = bridge.namedAnimSprites.get('heroIdle');
check(idle && idle.frameStart === 0 && idle.frameEnd === 3 && idle.fps === 8 && idle.loop === true, 'animSprite frames / fps / loop');

const dust = bridge.namedParticles.get('dust');
check(dust && dust.config.lifeMin === 0.3 && dust.config.angleMax === -20 && dust.config.burst === 6
  && dust.config.alphaEnd === 0 && dust.config.windX === 8, 'particles config is JSON the runtime reads');
check(bridge.gradients.get('skyFade').stops.length === 2 && bridge.gradients.get('sun').type === 'radial', 'gradients and stops');
check(bridge.namedPaths.get('loop').length >= 5, 'path segments registered');
check(bridge.cameraFollowX === 40 && bridge.cameraFollowY === 160 && bridge.cameraZoom === 1.5, 'camera follows state expressions');

// ---------------------------------------------------------------------------
// Frames and handlers
// ---------------------------------------------------------------------------

const exports = instance.exports;
bridge.deltaTime = 0.5;
exports._on_pointer_down(1, 30, 40);
check(vars.get('heroVX') === 200 && vars.get('attacking') === 1, 'onPointerDown stores state back');
check(bridge.namedParticles.get('dust').emitters.length === 1, 'emit particles at the pointer');

drawCalls.length = 0;
exports._frame_callback(1);
check(vars.get('heroX') === 140, `onFrame: heroX += heroVX * dt (got ${vars.get('heroX')})`);
check(bridge.namedAnimStates.get('heroFSM').current === 'attack', 'animState `when` transition evaluated each frame');
check(bridge.cameraFollowX === 140, 'camera target re-evaluated each frame');
check(drawCalls.some(([k]) => k === 'fillRect') && drawCalls.some(([k, a]) => k === 'fillText' && a[0] === 'Lives: 3'), 'draw: ran with state values (text value= is an expression)');
check(bridge.animationFrames.size === 1, 'the frame callback does not request another animation loop');

bridge.eventKey = 'ArrowLeft';
exports._on_key_down(1);
check(vars.get('heroVX') === -50 && vars.get('lives') === 3, 'onKeyDown reads the key; return stores state first');
bridge.eventKey = 'x';
exports._on_key_down(1);
check(vars.get('lives') === 2, 'onKeyDown without return');

if (failures > 0) {
  console.log('FAIL: frame.canvas scene runtime');
  process.exit(1);
}
console.log('PASS: frame.canvas scene runtime');
