/**
 * scene-header.test.mjs — the canvasScene: header line (frame-canvas.ebnf §2,
 * `canvasScene: { scene_attr }`), which frame.canvas parses itself:
 *
 *   - id= is a string literal whose escapes are decoded (core grammar §1.6):
 *     id="de\"cl" binds the page canvas whose id is de"cl (CVS-I001)
 *   - quoted and unquoted values mix in any order; width= / height= / fps=
 *     take an integer literal or an identifier, background= a string literal
 *     or an identifier
 *   - attributes are separated by blanks only: a comma, an unknown or
 *     repeated attribute, a value of the wrong kind, an unknown escape and
 *     interpolation in id= are compile errors (FRAME-CANVAS-E412)
 *
 * Each scene is compiled with the plugin in this directory and run in the
 * browser runtime over recording page canvases (lib/harness.mjs).
 *
 *   node plugins/frame.canvas/runtime/tests/scene-header.test.mjs
 *
 * Exit 0 when every check passes, 1 otherwise.
 */

import { checker, cleanup, compileScene, fills, installPage, loadRuntime, makeCanvas, quietRuntimeLogs, requireCompiler } from './lib/harness.mjs';

const SUITE = 'frame.canvas scene header';
requireCompiler(SUITE);
quietRuntimeLogs();

const ids = ['de"cl', 'mixed', 'quoted', 'a\\b{c}\t', 'ident', 'decl', 'spaced'];
const canvases = ids.map((id) => makeCanvas(id));
const page = installPage(canvases);
const { CleanCanvasLoader } = loadRuntime();
const result = checker();
const { check } = result;

const DRAW = '\tdraw:\n\t\tcanvas.clear';
let label = 0;

function source(header, prelude = '') {
  return `plugins:\n\tframe.canvas\n\n${prelude}canvasScene: ${header}\n\n${DRAW}\n`;
}

// Compile and start `canvasScene: <header>`; returns the loader.
async function startScene(header, prelude = '') {
  const loader = new CleanCanvasLoader();
  const quiet = console.log;
  console.log = () => {};
  try {
    const app = await loader.instantiate(compileScene(source(header, prelude), `header${label++}`));
    app.start();
    return loader;
  } finally {
    console.log = quiet;
  }
}

// Compile `canvasScene: <header>`; returns the compiler output when it
// fails, null when it compiles.
function compileError(header) {
  try {
    compileScene(source(header), `header${label++}`);
    return null;
  } catch (err) {
    return String(err.message);
  }
}

function rejects(what, header, pattern) {
  const out = compileError(header);
  const lines = (out || '').split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ');
  check(out !== null && /FRAME-CANVAS-E412/.test(out) && pattern.test(out),
    `${what}: \`canvasScene: ${header}\` is FRAME-CANVAS-E412 matching ${pattern} (${out === null ? 'compiled' : `got: ${lines}`})`);
}

// ---------------------------------------------------------------------------
// Values: escapes, quoted / unquoted, identifiers
// ---------------------------------------------------------------------------

{
  const el = page.canvases.get('de"cl');
  await startScene('id="de\\"cl" width=321 height=123 background="#112233"');
  check(el.width === 321 && el.height === 123, `id="de\\"cl" binds the canvas de"cl and sizes it (got ${el.width}x${el.height})`);
  check(fills(el.ctx)[0] === '#112233', `background= of the escaped-id scene paints its canvas (fills: ${JSON.stringify(fills(el.ctx))})`);
}

{
  const el = page.canvases.get('a\\b{c}\t');
  await startScene('id="a\\\\b\\{c\\}\\t" width=10 height=20');
  check(el.width === 10 && el.height === 20, `id= decodes \\\\, \\{, \\} and \\t (canvas a\\b{c}<tab> got ${el.width}x${el.height})`);
}

{
  const el = page.canvases.get('mixed');
  const loader = await startScene('width=200 id="mixed"  fps=30 height=0x96 background="#0a0b0c"   // the HUD scene');
  check(el.width === 200 && el.height === 150, `mixed quoted / unquoted attributes in any order, hex height, trailing comment (got ${el.width}x${el.height})`);
  check(loader.bridge.targetFps === 30, `fps=30 among mixed attributes (got ${loader.bridge.targetFps})`);
  check(fills(el.ctx)[0] === '#0a0b0c', `background= among mixed attributes (fills: ${JSON.stringify(fills(el.ctx))})`);
}

{
  // Only quoted values: the form a compiler could take for its own
  // key="value" attributes; the plugin's reading is the same either way.
  const el = page.canvases.get('quoted');
  await startScene('id="quoted" background="#abcdef"');
  check(el.width === 800 && el.height === 600, `width= / height= default to 800 x 600 (got ${el.width}x${el.height})`);
  check(fills(el.ctx)[0] === '#abcdef', `background= of a quoted-only header (fills: ${JSON.stringify(fills(el.ctx))})`);
}

{
  const el = page.canvases.get('ident');
  const prelude = 'state:\n\tinteger sceneWidth = 240\n\tstring sceneBackground = "#445566"\n\n';
  await startScene('id="ident" width=sceneWidth height=120 background=sceneBackground', prelude);
  check(el.width === 240 && el.height === 120, `width= takes an identifier (got ${el.width}x${el.height})`);
  check(fills(el.ctx)[0] === '#445566', `background= takes an identifier (fills: ${JSON.stringify(fills(el.ctx))})`);
}

{
  const el = page.canvases.get('spaced');
  await startScene('id = "spaced" width = 64 height=32');
  check(el.width === 64 && el.height === 32, `blanks around = are allowed (got ${el.width}x${el.height})`);
}

// ---------------------------------------------------------------------------
// Rejected headers (FRAME-CANVAS-E412)
// ---------------------------------------------------------------------------

rejects('comma after a quoted value', 'id="decl", width=640', /not commas/);
rejects('comma after an unquoted value', 'width=640, id="decl"', /not commas/);
rejects('leading comma', ', width=640', /not commas/);
rejects('unknown attribute', 'width=100 title="x"', /unknown header attribute 'title'/);
rejects('repeated attribute', 'width=100 width=200', /width= is given twice/);
rejects('unquoted id', 'width=100 id=game', /id= takes a string literal/);
rejects('string width', 'height=100 width="800"', /width= takes an integer literal or a variable name/);
rejects('number fps', 'width=100 fps=29.97', /fps= takes an integer literal or a variable name/);
rejects('background expression', 'width=100 background=1+2', /background= takes a string literal or a variable name/);
rejects('unknown escape', 'width=100 id="a\\qb"', /unknown escape '\\q'/);
rejects('interpolation in id', 'width=100 id="a{b}"', /cannot interpolate/);
rejects('missing value', 'width=100 height=', /'height' needs a value/);
rejects('missing =', 'width=100 height', /'height' needs a value/);
{
  // The compiler's lexer may reject an unclosed string before the plugin.
  const out = compileError('width=100 id="abc');
  check(out !== null && /not closed|Unterminated string/.test(out), `an unclosed id= string does not compile (${out === null ? 'compiled' : 'rejected'})`);
}
rejects('no space between attributes', 'width=100 id="a"height=5', /put a space between header attributes/);

{
  // A header of quoted values only, with a comma. The plugin rejects it
  // (as above); a compiler that still reads key="value" header lines itself
  // hands the plugin the attributes without the line, and the scene must
  // then run on the canvas "decl" — never one named `"decl",`.
  const header = 'id="decl", background="#112233"';
  const out = compileError(header);
  if (out !== null) {
    check(/FRAME-CANVAS-E412/.test(out) && /not commas/.test(out), `quoted-only header with a comma is FRAME-CANVAS-E412 (got: ${out.split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ')})`);
  } else {
    const el = page.canvases.get('decl');
    await startScene(header);
    check(el.width === 800 && fills(el.ctx)[0] === '#112233', `quoted-only header read by the compiler binds the canvas "decl" (fills: ${JSON.stringify(fills(el.ctx))})`);
  }
}

cleanup();
if (result.failures > 0) {
  console.log(`FAIL: ${SUITE}`);
  process.exit(1);
}
console.log(`PASS: ${SUITE}`);
