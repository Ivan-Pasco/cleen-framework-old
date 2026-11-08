/**
 * scene-diagnostics.test.mjs — compile-time checks of the frame.canvas
 * plugin: each case is a small scene compiled with the plugin in this
 * directory (--plugin-override); a scene that breaks a rule of
 * foundation/spec/framework/frame-canvas-semantics.md must fail with an error
 * naming that rule, and the valid scenes next to them must compile.
 *
 *   node plugins/frame.canvas/runtime/tests/scene-diagnostics.test.mjs
 *
 * Needs the old-toolchain compiler: $CLEEN_CLN, else ~/.cleen/bin/cln
 * (build the plugin first). Exit 0 when every check passes, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..', '..');
const compiler = process.env.CLEEN_CLN || join(homedir(), '.cleen', 'bin', 'cln');

if (!existsSync(compiler)) {
  console.log(`FAIL: frame.canvas scene diagnostics — compiler not found at ${compiler} (set CLEEN_CLN)`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'canvas-diag-'));
let failures = 0;
let count = 0;

// Compile `scene` (the canvasScene body, tab-indented one level) and return
// [ok, output].
function compile(scene) {
  const file = join(work, `case${count++}.cln`);
  writeFileSync(file, `plugins:\n\tframe.canvas\n\nstart:\n\tprintl("boot")\n\ncanvasScene: id="c" width=100 height=100\n\n${scene}\n`);
  try {
    const out = execFileSync(compiler, ['compile', file, '-o', file.replace(/\.cln$/, '.wasm'), '--target', 'browser',
      '--plugin-override', `frame.canvas=${pluginDir}`], { stdio: 'pipe' });
    return [true, String(out)];
  } catch (err) {
    return [false, String(err.stdout || '') + String(err.stderr || '')];
  }
}

function rejects(what, scene, pattern) {
  const [ok, out] = compile(scene);
  if (ok || !pattern.test(out)) {
    failures++;
    const lines = out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join(' | ');
    console.log(`FAIL: ${what} — expected an error matching ${pattern}, ${ok ? 'compiled' : `got: ${lines}`}`);
  }
}

function accepts(what, scene) {
  const [ok, out] = compile(scene);
  if (!ok) {
    failures++;
    const lines = out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join(' | ');
    console.log(`FAIL: ${what} — expected to compile, got: ${lines}`);
  }
}

const STATE = `\tstate:\n\t\tnumber shipX = 0.0\n\t\tnumber shipY = 0.0\n\t\tnumber shipAngle = 0.0\n`;
const PATH = `\tpath "orbit":\n\t\tmoveTo x=0 y=0\n\t\tlineTo x=10 y=0\n`;
const DRAW = `\tdraw:\n\t\tcanvas.clear\n`;

// --- tweens (CVS-A008, CVS-A011, CVS-A012, CVS-X006) ----------------------

accepts('path tween with orient and its angle variable',
  `${STATE}\n\ttween "fly":\n\t\talong = "orbit"\n\t\tshipX to=0\n\t\tshipY to=0\n\t\torient = true\n\n${PATH}\n${DRAW}`);
rejects('tween of a variable that is not in state:',
  `${STATE}\n\ttween "t":\n\t\tspeed to=1.0\n\n${DRAW}`, /speed.*not declared in state: \(CVS-A008\)/);
rejects('along= naming an undeclared path',
  `${STATE}\n\ttween "fly":\n\t\talong = "nope"\n\t\tshipX to=0\n\t\tshipY to=0\n\n${PATH}\n${DRAW}`, /no path "nope" is declared.*CVS-X006/);
rejects('path tween with one variable line',
  `${STATE}\n\ttween "fly":\n\t\talong = "orbit"\n\t\tshipX to=0\n\n${PATH}\n${DRAW}`, /exactly two variable lines.*CVS-A011/);
rejects('orient = true without the angle variable in state:',
  `\tstate:\n\t\tnumber shipX = 0.0\n\t\tnumber shipY = 0.0\n\n\ttween "fly":\n\t\talong = "orbit"\n\t\tshipX to=0\n\t\tshipY to=0\n\t\torient = true\n\n${PATH}\n${DRAW}`, /shipAngle.*declare it in state: \(CVS-A012\)/);
rejects('orient = true without along=',
  `${STATE}\n\ttween "spin":\n\t\tshipAngle to=90\n\t\torient = true\n\n${DRAW}`, /orient = true without along.*CVS-A012/);

// --- names of scene resources (CVS-D007, CVS-D009, CVS-D012, CVS-A005, CVS-P005)

const ASSETS = `\tassets:\n\t\tspritesheet "hero" src="hero.png" frameWidth=8 frameHeight=8\n\t\timage "logo" src="logo.png"\n`;
const DECLS = `\ttween "t":\n\t\tshipX to=1.0\n\n\ttimeline "tl":\n\t\tat 0.0:\n\t\t\ttween "t"\n\n\tpath "mask":\n\t\tmoveTo x=0 y=0\n\t\tlineTo x=10 y=0\n\n\tgradient "g" linear x1=0 y1=0 x2=10 y2=0:\n\t\tstop 0.0 color="#000000"\n\t\tstop 1.0 color="#ffffff"\n`;
const scene = (init, draw) => `${ASSETS}\n${STATE}\n${DECLS}\n\tinit:\n${init.map((l) => `\t\t${l}\n`).join('')}\n\tdraw:\n\t\tcanvas.clear\n${draw.map((l) => `\t\t${l}\n`).join('')}`;

accepts('declared resources', scene(['play tween "t"', 'play timeline "tl"'], [
  'canvas.clip path="mask":', '\tcanvas.rect x=0 y=0 width=1 height=1 gradient="g"',
  'canvas.sprite "hero" x=0 y=0 clip=0', 'canvas.image src="logo" x=0 y=0']));
rejects('canvas.clip path= naming an undeclared path', scene([], ['canvas.clip path="ghost":', '\tcanvas.clear']), /path="ghost" names no path declared.*CVS-X006/);
rejects('gradient= naming an undeclared gradient', scene([], ['canvas.rect x=0 y=0 width=1 height=1 gradient="nope"']), /gradient "nope" is not declared.*CVS-D007/);
rejects('canvas.sprite naming a file instead of a spritesheet asset', scene([], ['canvas.sprite "hero.png" x=0 y=0 clip=0']), /canvas.sprite "hero.png" is not a `spritesheet` asset.*CVS-D009/);
rejects('canvas.image src= naming a file instead of an image asset', scene([], ['canvas.image src="images/logo.png" x=0 y=0']), /canvas.image src="images\/logo.png" is not an `image` asset.*CVS-D009/);
rejects('canvas.sprite state= naming an undeclared animState', scene([], ['canvas.sprite "hero" x=0 y=0 state="fsm"']), /state="fsm" names no animState.*CVS-A005/);
rejects('play tween naming an undeclared tween', scene(['play tween "nosuch"'], []), /tween "nosuch" is not declared/);
rejects('play timeline naming an undeclared timeline', scene(['play timeline "nosuch"'], []), /timeline "nosuch" is not declared/);
rejects('start animState naming an undeclared animState', scene(['start animState "nosuch"'], []), /animState "nosuch" is not declared.*CVS-A005/);
rejects('emit particles naming an undeclared emitter', scene(['emit particles "nosuch" x=0 y=0'], []), /particles "nosuch" is not declared.*CVS-P005/);

// --- canvas.save / canvas.restore balance (CVS-X007) -----------------------

const drawOnly = (lines) => `\tdraw:\n${lines.map((l) => `\t\t${l}\n`).join('')}`;
accepts('balanced save / restore, also inside a branch', drawOnly(['canvas.save', 'canvas.translate x=1 y=1', 'if 1 > 0',
  '\tcanvas.save', '\tcanvas.restore', 'canvas.restore']));
rejects('canvas.save without restore', drawOnly(['canvas.save']), /1 canvas.save without a matching canvas.restore.*CVS-X007/);
rejects('canvas.restore before any save', drawOnly(['canvas.restore']), /canvas.restore has no canvas.save before it.*CVS-X007/);
rejects('save inside a branch, restore after it', drawOnly(['if 1 > 0', '\tcanvas.save', 'canvas.restore']), /CVS-X007/);

// --- particles sub-blocks (frame-canvas.ebnf §10) -------------------------

accepts('particles with every sub-block', `\tparticles "p":\n\t\tsize = 3\n\t\tshape = "rect"\n\t\temitter:\n\t\t\trate = 10\n\t\t\tshape = "circle"\n\t\t\tradius = 50\n\t\toverLifetime:\n\t\t\tspeed = 1.0 -> 0.0\n\t\t\tcolor = "#ff0000" -> "#0000ff"\n\t\t\talpha = 1.0..0.0\n\t\tforces:\n\t\t\tgravity = 10\n\n${DRAW}`);
rejects('particle attribute in the wrong sub-block', `\tparticles "p":\n\t\temitter:\n\t\t\tgravity = 10\n\n${DRAW}`, /FRAME-CANVAS-E721|'gravity = 10' is not a valid emitter attribute/);
rejects('unknown particles sub-block', `\tparticles "p":\n\t\tspawn:\n\t\t\trate = 10\n\n${DRAW}`, /unknown sub-block 'spawn:'/);

// --- path commands (frame-canvas.ebnf §11) --------------------------------

rejects('unknown path command', `\tpath "p":\n\t\tmoveTo x=0 y=0\n\t\tsplineTo x=1 y=1\n\n${DRAW}`, /unknown command 'splineTo x=1 y=1'/);

accepts('quadTo path segment', `\tpath "q":\n\t\tmoveTo x=0 y=0\n\t\tquadTo cpX=5 cpY=5 x=10 y=0\n\n${DRAW}`);

// --- canvas.drawPath (frame-canvas.ebnf §17, CVS-X006) --------------------

accepts('canvas.drawPath naming a declared path', `${PATH}\n\tdraw:\n\t\tcanvas.drawPath "orbit" stroke=2 color="#ffffff"\n`);
rejects('canvas.drawPath naming an undeclared path', `${PATH}\n\tdraw:\n\t\tcanvas.drawPath "ghost" stroke=2 color="#ffffff"\n`,
  /canvas.drawPath "ghost" names no path declared.*CVS-X006/);

// --- one canvasScene: per file (CVS-S011) ---------------------------------

{
  const file = join(work, `case${count++}.cln`);
  const twoScenes = 'plugins:\n\tframe.canvas\n\ncanvasScene: id="menu" width=100 height=100\n\n\tdraw:\n\t\tcanvas.clear\n\n'
    + 'canvasScene: id="game" width=100 height=100\n\n\tdraw:\n\t\tcanvas.clear\n';
  writeFileSync(file, twoScenes);
  const run = (args) => {
    try {
      return [true, String(execFileSync(compiler, args, { stdio: 'pipe' }))];
    } catch (err) {
      return [false, String(err.stdout || '') + String(err.stderr || '')];
    }
  };
  const [built, out] = run(['compile', file, '-o', file.replace(/\.cln$/, '.wasm'), '--target', 'browser',
    '--plugin-override', `frame.canvas=${pluginDir}`]);
  if (built || !/CVS-S011/.test(out) || /already defined/.test(out)) {
    failures++;
    const lines = out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join(' | ');
    console.log(`FAIL: two canvasScene: blocks in one file fail with CVS-S011, not a class clash — ${built ? 'compiled' : `got: ${lines}`}`);
  }
  const [, lintOut] = run(['lint', file, '--plugin-override', `frame.canvas=${pluginDir}`]);
  if (!/FRAME-CANVAS-E411\] \S+:9:1 .*CVS-S011/.test(lintOut)) {
    failures++;
    console.log(`FAIL: cln lint reports the second canvasScene: at its line (CVS-S011) — got: ${lintOut.split('\n').filter((l) => /E411|error/.test(l)).slice(0, 2).join(' | ')}`);
  }
}

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.log('FAIL: frame.canvas scene diagnostics');
  process.exit(1);
}
console.log(`PASS: frame.canvas scene diagnostics (${count} scenes)`);
