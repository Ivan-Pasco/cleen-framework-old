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

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.log('FAIL: frame.canvas scene diagnostics');
  process.exit(1);
}
console.log(`PASS: frame.canvas scene diagnostics (${count} scenes)`);
