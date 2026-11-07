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
check(JSON.stringify(bridge.namedTweens.get('follow').vars.map((v) => [v.varName, v.pathAxis]))
  === '[["followX",0],["followY",1],["followAngle",2]]', 'path tween: X, Y, then the orient angle variable (CVS-A011, CVS-A012)');
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
check(dust && dust.config.shape === 'rect' && dust.config.sizeMin === 3 && dust.config.sizeMax === 3,
  `particle shape / size are not overwritten by the emitter: block (got ${dust && JSON.stringify(dust.config)})`);
check(dust && dust.config.emitterShape === 'circle' && dust.config.emitterRadius === 12, 'emitter: shape / radius describe the spawn area');
check(dust && dust.config.alphaStart === 1 && dust.config.alphaEnd === 0, 'overLifetime alpha = a..b (frame-canvas.ebnf §10 value_range)');
check(dust && dust.config.speedStart === 1 && dust.config.speedEnd === 0.5 && dust.config.colorStart === '#ffffff'
  && dust.config.colorEnd === '#000000', 'overLifetime speed / color ramps');
check(bridge.gradients.get('skyFade').stops.length === 2 && bridge.gradients.get('sun').type === 'radial', 'gradients and stops');
check(bridge.namedPaths.get('loop').length >= 5, 'path segments registered');
check(JSON.stringify(bridge.namedPaths.get('wave')) === '[{"op":"move","x":0,"y":0},{"op":"curve","cpx":50,"cpy":-40,"x":100,"y":0}]',
  `quadTo cpX= cpY= is a quadratic segment (got ${JSON.stringify(bridge.namedPaths.get('wave'))})`);
check(bridge.cameraFollowX === 40 && bridge.cameraFollowY === 160 && bridge.cameraZoom === 1.5, 'camera follows state expressions');

// A path tween writes the path position into its X / Y variables and the
// travel direction, in degrees, into the angle variable.
{
  const follow = bridge.namedTweens.get('follow');
  const saved = new Map(vars);
  follow.state = 'playing';
  follow.elapsed = 0;
  follow.vars.forEach((v) => { v.done = false; });
  const others = [...bridge.namedTweens].filter(([name]) => name !== 'follow').map(([, tw]) => [tw, tw.state]);
  others.forEach(([tw]) => { tw.state = 'stopped'; });
  const timelines = [...bridge.namedTimelines.values()].map((tl) => [tl, tl.state]);
  timelines.forEach(([tl]) => { tl.state = 'stopped'; });
  bridge._updateAnimations(1.5);
  const mid = bridge._sampleNamedPath('loop', 0.5);
  check(Math.abs(vars.get('followX') - mid.x) < 1e-9 && Math.abs(vars.get('followY') - mid.y) < 1e-9,
    `along= writes the path point to the X / Y variables (got ${vars.get('followX')}, ${vars.get('followY')}; path ${mid.x}, ${mid.y})`);
  check(Math.abs(vars.get('followAngle') - mid.angle * 180 / Math.PI) < 1e-9, `orient writes the travel direction in degrees (got ${vars.get('followAngle')})`);
  follow.state = 'stopped';
  timelines.forEach(([tl, state]) => { tl.state = state; });
  others.forEach(([tw, state]) => { tw.state = state; });
  for (const [k, v] of saved) vars.set(k, v);
}

// ---------------------------------------------------------------------------
// Frames and handlers
// ---------------------------------------------------------------------------

const exports = instance.exports;
bridge.deltaTime = 0.5;
exports._on_pointer_down(1, 30, 40);
check(vars.get('heroVX') === 200 && vars.get('attacking') === 1, 'onPointerDown stores state back');
check(bridge.namedParticles.get('dust').emitters.length === 1, 'emit particles at the pointer');

// The hero sheet's image never loads under Node: mark it loaded (4 frames
// per row) so the sprite draws reach the 2D context.
Object.assign(bridge.namedSprites.get('hero'), { loaded: true, framesPerRow: 4, totalFrames: 8 });
drawCalls.length = 0;
bridge.lastKey = 'q';
exports._frame_callback(1);
check(vars.get('heroX') === 140, `onFrame: heroX += heroVX * dt (got ${vars.get('heroX')})`);
check(bridge.namedAnimStates.get('heroFSM').current === 'attack', 'animState `when` transition evaluated each frame');
check(bridge.cameraFollowX === 140, 'camera target re-evaluated each frame');
check(drawCalls.some(([k, a]) => k === 'fillText' && a[0] === 'Key: q'), 'input.lastKey is the last key pressed (a string)');
check(drawCalls.some(([k, a]) => k === 'fillText' && a[0] === 'x=3 y=3' && a[1] === 10 && a[2] === 60),
  'an `x=` / ` y=` inside a string literal is text, not an attribute');
check(drawCalls.some(([k]) => k === 'fillRect') && drawCalls.some(([k, a]) => k === 'fillText' && a[0] === 'Lives: 3'), 'draw: ran with state values (text value= is an expression)');
// canvas.sprite anchorX / anchorY (CVS-C006): x, y name the point at
// (anchorX, anchorY) of the 48x64 frame; with a transform it is the pivot.
const images = drawCalls.filter(([k]) => k === 'drawImage').map(([, a]) => a.slice(1).map((v) => Math.round(v * 1000) / 1000));
check(images.length === 5, `five sprites drawn (got ${images.length})`);
check(JSON.stringify(images[1]) === '[48,0,48,64,276,136,48,64]', `anchorX=0.5 anchorY=1 offsets by half the width and the full height (got ${JSON.stringify(images[1])})`);
check(JSON.stringify(images[2] && images[2].slice(4)) === '[-38,-12,48,64]', `state= sprite honours anchors given as expressions (got ${JSON.stringify(images[2])})`);
const transformCalls = drawCalls.filter(([k]) => k === 'translate' || k === 'rotate' || k === 'drawImage').map(([k, a]) => [k, ...a.slice(k === 'drawImage' ? 5 : 0).map((v) => Math.round(v * 1000) / 1000)]);
check(transformCalls.some((c, i) => JSON.stringify(c) === '["translate",100,100]'
  && JSON.stringify(transformCalls[i + 1]) === '["rotate",1.571]'
  && JSON.stringify(transformCalls[i + 2]) === '["drawImage",-24,-32,48,64]'),
  `rotation pivots on the anchor point (got ${JSON.stringify(transformCalls)})`);
check(transformCalls.some((c) => JSON.stringify(c) === '["translate",62,92]'), 'flipped sprite: anchorX shifts the frame before the flip');
check(bridge.animationFrames.size === 1, 'the frame callback does not request another animation loop');

// `return` inside open scopes (on layer, canvas.clip, canvas.save) closes
// them first: the 2D state stack is balanced at the end of the frame.
vars.set('skipRest', 1);
drawCalls.length = 0;
exports._frame_callback(1);
vars.set('skipRest', 0);
const saves = drawCalls.filter(([k]) => k === 'save').length;
const restores = drawCalls.filter(([k]) => k === 'restore').length;
check(saves > 0 && saves === restores, `return inside scoped blocks restores every save (save ${saves}, restore ${restores})`);
check(bridge.currentLayer === null, 'return inside on layer ends the layer');

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
