/**
 * frame-pipeline.test.mjs — what a compiled scene draws each frame, run in
 * the browser runtime over recording page canvases (lib/harness.mjs):
 *
 *   - canvasScene fps= limits the frame rate; dt is the real time between
 *     frames (CVS-L006)
 *   - background= is the starting colour and canvas.clear's default
 *     (frame-canvas.ebnf §2, CVS-L003)
 *   - layers are composited in ascending z whatever the code order; the
 *     default layer is z=0; several `on layer` blocks add up; empty layers
 *     are skipped; canvas.clear resets the layer buffers (CVS-D001..D004,
 *     CVS-L004)
 *   - the camera: follow, deadzone, smoothing, bounds that keep the whole
 *     view inside, zoom (also from an expression), shake falloff= (spec §19)
 *
 *   node plugins/frame.canvas/runtime/tests/frame-pipeline.test.mjs
 *
 * Exit 0 when every check passes, 1 otherwise.
 */

import { checker, cleanup, compileScene, fills, installPage, loadRuntime, makeCanvas, near, quietRuntimeLogs, requireCompiler } from './lib/harness.mjs';

const SUITE = 'frame.canvas frame pipeline';
requireCompiler(SUITE);
quietRuntimeLogs();

const canvases = ['rate', 'bg', 'nobg', 'layers', 'clearing', 'cam', 'camlayers', 'shake', 'paths'].map((id) => makeCanvas(id));
const page = installPage(canvases);
const { CleanCanvasLoader } = loadRuntime();
const result = checker();
const { check } = result;

// Compile `body` as the scene `canvasScene: <header>` and start it on its own
// (no scene manager): the bridge runs its own animation loop.
async function startScene(header, body) {
  const source = `plugins:\n\tframe.canvas\n\ncanvasScene: ${header}\n\n${body}\n`;
  const loader = new CleanCanvasLoader();
  const quiet = console.log;
  console.log = () => {};
  try {
    const app = await loader.instantiate(compileScene(source, header.match(/id="([^"]+)"/)[1]));
    app.start();
    return loader;
  } finally {
    console.log = quiet;
  }
}

const silenced = (fn) => {
  const quiet = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = quiet; }
};

// Run the animation loop at 60 Hz for `n` display frames from `t0` ms.
function runFrames(n, t0 = 1000) {
  for (let i = 0; i < n; i++) silenced(() => page.frame(t0 + i * (1000 / 60)));
  return t0 + n * (1000 / 60);
}

// ---------------------------------------------------------------------------
// fps= (CVS-L006)
// ---------------------------------------------------------------------------

{
  const loader = await startScene('id="rate" width=100 height=100 fps=30', `\tstate:
\t\tinteger frames = 0
\t\tnumber lastDt = 0.0

\tonFrame: param="dt"
\t\tframes = frames + 1
\t\tlastDt = dt`);
  const vars = loader.bridge.canvasVars;
  runFrames(1, 0);
  const before = vars.get('frames');
  runFrames(60, 1000 / 60);
  const ran = vars.get('frames') - before;
  check(ran >= 29 && ran <= 31, `fps=30 runs 30 of 60 display frames a second (ran ${ran})`);
  check(near(vars.get('lastDt'), 1 / 30, 1e-3), `dt is the time between the frames that ran (got ${vars.get('lastDt')})`);
  loader.bridge.targetFps = 0;
  const base = vars.get('frames');
  runFrames(30, 3000);
  check(vars.get('frames') - base === 30, 'without a target every display frame runs');
}

// ---------------------------------------------------------------------------
// background= (frame-canvas.ebnf §2, CVS-L003)
// ---------------------------------------------------------------------------

{
  const bg = page.canvases.get('bg');
  await startScene('id="bg" width=100 height=100 background="#123456"', `\tdraw:\n\t\tcanvas.clear\n\t\tcanvas.rect x=1 y=1 width=2 height=2 color="#ff0000"`);
  check(fills(bg.ctx)[0] === '#123456', `the canvas starts in the background colour (fills: ${JSON.stringify(fills(bg.ctx))})`);
  bg.ctx.log.length = 0;
  runFrames(1, 5000);
  check(JSON.stringify(fills(bg.ctx)) === '["#123456","#ff0000"]', `canvas.clear without color= clears to background= (fills: ${JSON.stringify(fills(bg.ctx))})`);

  const nobg = page.canvases.get('nobg');
  await startScene('id="nobg" width=100 height=100', `\tdraw:\n\t\tcanvas.clear`);
  check(fills(nobg.ctx).length === 0, 'without background= nothing is drawn at start');
  runFrames(1, 6000);
  check(JSON.stringify(fills(nobg.ctx)) === '["black"]', `canvas.clear defaults to black (fills: ${JSON.stringify(fills(nobg.ctx))})`);
}

// ---------------------------------------------------------------------------
// Layers (CVS-D001..D004, CVS-L004)
// ---------------------------------------------------------------------------

{
  const el = page.canvases.get('layers');
  await startScene('id="layers" width=100 height=100', `\tlayers:
\t\tlayer "hud" z=100
\t\tlayer "sky" z=0
\t\tlayer "world" z=10
\t\tlayer "fx" z=10

\tdraw:
\t\tcanvas.clear color="#000000"
\t\ton layer "hud":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#hud"
\t\ton layer "fx":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#fx"
\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#default"
\t\ton layer "sky":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#sky1"
\t\ton layer "hud":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#hud2"
\t\ton layer "sky":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#sky2"`);
  el.ctx.log.length = 0;
  runFrames(1, 7000);
  const drawn = fills(el.ctx);
  check(JSON.stringify(drawn) === '["#000000","#default","#sky1","#sky2","#fx","#hud","#hud2"]',
    `layers composite in ascending z, default layer first at z=0, blocks add up, "world" (empty) skipped (got ${JSON.stringify(drawn)})`);
  const saves = el.ctx.log.filter((e) => e[1] === 'save').length;
  const restores = el.ctx.log.filter((e) => e[1] === 'restore').length;
  check(saves === restores, `compositing leaves the context state balanced (save ${saves}, restore ${restores})`);

  const clr = page.canvases.get('clearing');
  await startScene('id="clearing" width=100 height=100', `\tlayers:
\t\tlayer "top" z=5

\tdraw:
\t\ton layer "top":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#lost"
\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#lost2"
\t\tcanvas.clear color="#111111"
\t\ton layer "top":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#kept"`);
  clr.ctx.log.length = 0;
  runFrames(1, 8000);
  check(JSON.stringify(fills(clr.ctx)) === '["#111111","#kept"]', `canvas.clear resets every layer buffer of the frame (got ${JSON.stringify(fills(clr.ctx))})`);
}

// ---------------------------------------------------------------------------
// canvas.drawPath strokes a declared path (frame-canvas.ebnf §11, §17)
// ---------------------------------------------------------------------------

{
  const el = page.canvases.get('paths');
  await startScene('id="paths" width=100 height=100', `\tpath "wave":
\t\tmoveTo x=0 y=50
\t\tquadTo cpX=25 cpY=0 x=50 y=50
\t\tcurveTo x=100 y=50 cp1x=60 cp1y=90 cp2x=90 cp2y=90
\t\tclosed = true

\tdraw:
\t\tcanvas.clear
\t\tcanvas.drawPath "wave" stroke=3 color="#00ff00"`);
  el.ctx.log.length = 0;
  runFrames(1, 9000);
  const calls = el.ctx.log.filter((e) => e[0] === 'call').map((e) => `${e[1]}(${e[2].join(',')})`);
  const at = calls.indexOf('moveTo(0,50)');
  const segs = at === -1 ? [] : calls.slice(at, at + 5);
  check(JSON.stringify(segs) === JSON.stringify(['moveTo(0,50)', 'quadraticCurveTo(25,0,50,50)', 'bezierCurveTo(60,90,90,90,100,50)', 'closePath()', 'stroke()']),
    `canvas.drawPath replays the path (moveTo, quadTo, curveTo, closed) and strokes it (got ${JSON.stringify(segs)})`);
  const sets = el.ctx.log.filter((e) => e[0] === 'set');
  check(sets.some((e) => e[1] === 'strokeStyle' && e[2] === '#00ff00') && sets.some((e) => e[1] === 'lineWidth' && e[2] === 3),
    'canvas.drawPath strokes with its color= and stroke= width');
}

// ---------------------------------------------------------------------------
// Camera (spec §19)
// ---------------------------------------------------------------------------

// The camera transform the frame's draw: ran under (direct drawing).
function lastCameraTransform(ctx) {
  const t = ctx.log.filter((e) => e[0] === 'call' && e[1] === 'transform').pop();
  return t ? t[2] : null;
}

{
  const el = page.canvases.get('cam');
  el.width = 400;
  const loader = await startScene('id="cam" width=400 height=200', `\tstate:
\t\tnumber px = 500.0
\t\tnumber py = 300.0
\t\tnumber zoomLevel = 2.0
\t\tnumber smooth = 0.0

\tcamera:
\t\tfollowX = px
\t\tfollowY = py
\t\tsmoothing = smooth
\t\tdeadzoneWidth = 40
\t\tdeadzoneHeight = 20
\t\tboundsX = 0
\t\tboundsY = 0
\t\tboundsWidth = 1000
\t\tboundsHeight = 400
\t\tzoom = zoomLevel

\tdraw:
\t\tcanvas.clear color="#000000"
\t\tcanvas.rect x=px y=py width=1 height=1 color="#ffffff"`);
  const b = loader.bridge;
  const vars = b.canvasVars;
  let t = runFrames(1, 10000);
  // View: 400x200 at zoom 2 -> 200x100 world units; the target starts centred.
  check(near(b.cameraX, 400) && near(b.cameraY, 250), `the camera starts centred on the target (got ${b.cameraX}, ${b.cameraY})`);
  const m = lastCameraTransform(el.ctx);
  check(m && near(m[0], 2) && near(m[3], 2) && near(m[4], -800) && near(m[5], -500), `draw: runs under the camera transform (got ${JSON.stringify(m)})`);
  check(fills(el.ctx).slice(-2)[0] === '#000000', 'canvas.clear still fills the whole canvas under a camera');

  vars.set('px', 510);
  t = runFrames(1, t);
  check(near(b.cameraX, 400), `inside the deadzone the camera holds (got ${b.cameraX})`);
  vars.set('px', 550);
  t = runFrames(1, t);
  check(near(b.cameraX, 430), `outside it the camera moves by the overshoot (got ${b.cameraX}, want 430)`);

  vars.set('px', 990);
  t = runFrames(1, t);
  check(near(b.cameraX, 800), `bounds keep the whole view inside: x <= 1000 - 200 (got ${b.cameraX})`);
  vars.set('py', 1000);
  t = runFrames(1, t);
  check(near(b.cameraY, 300), `bounds: y <= 400 - 100 (got ${b.cameraY})`);

  vars.set('zoomLevel', 4);
  t = runFrames(1, t);
  check(near(b.cameraZoom, 4), `zoom = <expression> follows the state each frame (got ${b.cameraZoom})`);

  vars.set('zoomLevel', 2);
  vars.set('py', 300);
  vars.set('px', 500);
  vars.set('smooth', 0.5);
  t = runFrames(1, t);
  t = runFrames(1, t);
  const start = b.cameraX;
  check(start + 100 + 20 < 700, 'the target ends outside the deadzone');
  vars.set('px', 700);
  t = runFrames(1, t);
  // Deadzone overshoot: 700 - (start + 100) - 20; smoothing 0.5 covers half per 1/60 s.
  const want = start + (700 - (start + 100) - 20) * 0.5;
  check(near(b.cameraX, want, 1e-6), `smoothing 0.5 closes half the distance per 1/60 s (got ${b.cameraX}, want ${want})`);
}

{
  // A layered scene: every layer is replayed under the camera; the
  // canvas.clear fill is not.
  const el = page.canvases.get('camlayers');
  await startScene('id="camlayers" width=300 height=150', `\tlayers:
\t\tlayer "hud" z=10

\tcamera:
\t\tzoom = 3

\tdraw:
\t\tcanvas.clear color="#000000"
\t\ton layer "hud":
\t\t\tcanvas.rect x=0 y=0 width=1 height=1 color="#ffffff"`);
  el.ctx.log.length = 0;
  runFrames(1, 20000);
  const sets = el.ctx.log.filter((e) => e[1] === 'setTransform').map((e) => e[2]);
  check(sets.some((a) => near(a[0], 1) && near(a[3], 1)) && sets.some((a) => near(a[0], 3) && near(a[3], 3)),
    `the clear is in screen space, the layer under zoom 3 (setTransform calls: ${JSON.stringify(sets)})`);
}

{
  const el = page.canvases.get('shake');
  const loader = await startScene('id="shake" width=100 height=100', `\tdraw:
\t\tcanvas.clear color="#000000"

\tonPointerDown:
\t\tcamera.shake intensity=8 duration=0.4 falloff="easeOut"`);
  el.fire('mousedown');
  const b = loader.bridge;
  check(b.cameraShakeIntensity === 8 && near(b.cameraShakeDuration, 0.4) && b.cameraShakeEasing === 2,
    `camera.shake reads falloff= ("easeOut" is the cubic ease-out, got easing ${b.cameraShakeEasing})`);
  el.ctx.log.length = 0;
  runFrames(1, 30000);
  const m = lastCameraTransform(el.ctx);
  check(m && Math.abs(m[4]) <= 8 && Math.abs(m[5]) <= 8 && (m[4] !== 0 || m[5] !== 0), `a shaking camera offsets the frame by at most the intensity (got ${JSON.stringify(m)})`);
}

cleanup();
if (result.failures > 0) {
  console.log(`FAIL: ${SUITE}`);
  process.exit(1);
}
console.log(`PASS: ${SUITE}`);
