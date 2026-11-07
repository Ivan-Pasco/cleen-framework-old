/**
 * runtime-bridges.test.mjs — unit tests for the frame.canvas browser runtime
 * (runtime/loader.js + runtime/canvas-bridge.js), run with plain Node:
 *
 *   node plugins/frame.canvas/runtime/tests/runtime-bridges.test.mjs
 *
 * The real loader and bridge are loaded (no copies of their code) against a
 * fake module instance — a WebAssembly.Memory plus an exported `__heap_ptr`
 * global, the shape the compiler emits — so every value crosses real linear
 * memory. Covered:
 *   - the JSON bridges _json_encode_v2 / _json_encode_pretty_v2 /
 *     _json_decode_v2 / _json_get (function-registry.toml, BOXED_ANY_ABI.md)
 *   - stdlib imports the compiler emits (LP strings, i64 as BigInt,
 *     memory_runtime.mem_alloc, string_compare, string_matches)
 *   - the module-heap allocator shared by both files
 *   - canvas bridge argument decoding (ptr+len strings, LP returns) and the
 *     pure helpers (collision, easing, particles, tweens, animState)
 *   - every plugin.toml [bridge] function exists with the WASM arity the
 *     compiler imports it with (a string is two i32 when expand_strings).
 *
 * Exit 0 when every test passes, 1 otherwise.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, '..');
const pluginDir = join(runtimeDir, '..');

const { CanvasBridge } = require(join(runtimeDir, 'canvas-bridge.js'));
globalThis.CanvasBridge = CanvasBridge; // loader.js constructs the bridge from the global
const { CleanCanvasLoader } = require(join(runtimeDir, 'loader.js'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;

function test(name, fn) {
  try {
    fn();
    passes++;
  } catch (err) {
    failures++;
    console.log(`FAIL: ${name}\n  ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function throws(fn, pattern, what) {
  try {
    fn();
  } catch (err) {
    if (pattern && !pattern.test(String(err && err.message))) {
      throw new Error(`${what}: threw "${err.message}", expected ${pattern}`);
    }
    return;
  }
  throw new Error(`${what}: did not throw`);
}

const HEAP_BASE = 4096;

// A loader wired to a fresh fake module instance.
function freshLoader() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 64 });
  const heap = new WebAssembly.Global({ value: 'i32', mutable: true }, HEAP_BASE);
  const loader = new CleanCanvasLoader();
  loader.attachInstance({ exports: { memory, __heap_ptr: heap } });
  const env = {
    ...loader.bridge.getImports(memory).env,
    ...loader.createStdlibImports(),
  };
  return { loader, env, memory, heap, bridge: loader.bridge, mr: loader.createMemoryRuntimeImports() };
}

// Raw UTF-8 bytes at a fresh heap address: the (ptr, len) pair of an
// expand_strings parameter.
function raw(loader, text) {
  const bytes = new TextEncoder().encode(text);
  const ptr = loader._heapAlloc(bytes.length || 1);
  new Uint8Array(loader.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

const lp = (loader, text) => loader._writeLP(text);
const readLP = (loader, ptr) => loader._readLP(ptr);
const view = (loader) => new DataView(loader.memory.buffer);

// ---------------------------------------------------------------------------
// Module-heap allocator
// ---------------------------------------------------------------------------

test('heap: allocations come from __heap_ptr, 8-byte aligned, and advance it', () => {
  const { loader, heap } = freshLoader();
  const a = loader._heapAlloc(3);
  const b = loader._heapAlloc(5);
  eq(a, HEAP_BASE, 'first allocation at __heap_ptr');
  eq(b % 8, 0, 'second allocation aligned');
  ok(b >= a + 3, 'allocations do not overlap');
  eq(heap.value, b + 5, '__heap_ptr advanced past the last allocation');
});

test('heap: grows memory when an allocation passes the end', () => {
  const { loader, memory } = freshLoader();
  const before = memory.buffer.byteLength;
  const p = loader._heapAlloc(before);
  ok(memory.buffer.byteLength >= p + before, 'memory grew to fit the allocation');
});

test('heap: a module malloc export takes precedence over __heap_ptr', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const loader = new CleanCanvasLoader();
  let asked = 0;
  loader.attachInstance({ exports: { memory, malloc: (n) => { asked = n; return 512; } } });
  eq(loader._heapAlloc(24), 512, 'malloc result returned');
  eq(asked, 24, 'malloc asked for the size');
});

test('heap: a module with neither malloc nor __heap_ptr is an error', () => {
  const loader = new CleanCanvasLoader();
  loader.attachInstance({ exports: { memory: new WebAssembly.Memory({ initial: 1 }) } });
  throws(() => loader._heapAlloc(4), /neither malloc nor __heap_ptr/, 'no allocator');
});

test('memory_runtime.mem_alloc(type_id, size) allocates `size` bytes', () => {
  const { loader, mr, heap } = freshLoader();
  const p = mr.mem_alloc(7, 40);
  eq(heap.value, p + 40, 'size is the second argument');
  mr.mem_retain(p); mr.mem_release(p); mr.mem_scope_push(); mr.mem_scope_pop();
  void loader;
});

test('attachInstance reads strings through the module memory, not the loader-created one', () => {
  const { loader, bridge, memory } = freshLoader();
  eq(loader.memory === memory, true, 'loader uses exported memory');
  eq(bridge.memory === memory, true, 'bridge uses exported memory');
});

// ---------------------------------------------------------------------------
// JSON bridges (stdlib-reference §8, BOXED_ANY_ABI.md)
// ---------------------------------------------------------------------------

test('_json_encode_v2: scalars, nested containers, insertion order (D3)', () => {
  const { loader, env } = freshLoader();
  const value = { z: 1, a: [true, null, 2.5, 'x"y'], m: { k: -3 } };
  const box = loader._jsonWrite(value);
  eq(readLP(loader, env._json_encode_v2(box)), '{"z":1,"a":[true,null,2.5,"x\\"y"],"m":{"k":-3}}', 'compact JSON');
});

test('_json_encode_v2: box layout — tag at +0, i64 at +4 for integers, f64 at +4 for floats', () => {
  const { loader, env } = freshLoader();
  const i = loader._jsonWrite(42);
  eq(view(loader).getInt32(i, true), 1, 'integer tag');
  ok(view(loader).getBigInt64(i + 4, true) === 42n, 'i64 payload');
  const f = loader._jsonWrite(0.25);
  eq(view(loader).getInt32(f, true), 3, 'float tag');
  eq(view(loader).getFloat64(f + 4, true), 0.25, 'f64 payload');
  const big = loader._jsonWrite(2 ** 60);
  eq(view(loader).getInt32(big, true), 3, 'unsafe integers are tag 3 (D1)');
  eq(readLP(loader, env._json_encode_v2(i)), '42', 'encodes the integer');
});

test('_json_encode_v2: reads a hand-built box tree (keys are raw LP pointers)', () => {
  const { loader, env } = freshLoader();
  const dv = () => view(loader);
  const strBox = loader._jsonMalloc(12);
  dv().setInt32(strBox, 4, true);
  dv().setInt32(strBox + 4, lp(loader, 'hé'), true);
  const obj = loader._jsonMalloc(4 + 8);
  dv().setInt32(obj, 1, true);
  dv().setInt32(obj + 4, lp(loader, 'name'), true);
  dv().setInt32(obj + 8, strBox, true);
  const box = loader._jsonMalloc(12);
  dv().setInt32(box, 6, true);
  dv().setInt32(box + 4, obj, true);
  eq(readLP(loader, env._json_encode_v2(box)), '{"name":"hé"}', 'object with UTF-8 string');
});

test('_json_encode_v2: an invalid tag raises (no silent null)', () => {
  const { loader, env } = freshLoader();
  const box = loader._jsonMalloc(12);
  view(loader).setInt32(box, 9, true);
  throws(() => env._json_encode_v2(box), /invalid boxed-Any tag 9/, 'tag 9');
});

test('_json_encode_pretty_v2: two-space indentation', () => {
  const { loader, env } = freshLoader();
  const box = loader._jsonWrite({ a: [1] });
  eq(readLP(loader, env._json_encode_pretty_v2(box)), '{\n  "a": [\n    1\n  ]\n}', 'pretty JSON');
});

test('_json_decode_v2: (ptr, len) text to a box tree that round-trips', () => {
  const { loader, env } = freshLoader();
  const [p, n] = raw(loader, '{"b":[1,2.5,"s",false,null],"a":{"x":"ü"}}');
  const box = env._json_decode_v2(p, n);
  ok(box !== 0, 'non-zero box');
  eq(loader._jsonRead(box), { b: [1, 2.5, 's', false, null], a: { x: 'ü' } }, 'decoded value');
});

test('_json_decode_v2: parse failure returns the 0 sentinel; JSON null is a real box', () => {
  const { loader, env } = freshLoader();
  const [p, n] = raw(loader, '{"broken":');
  eq(env._json_decode_v2(p, n), 0, 'failure sentinel');
  const [q, m] = raw(loader, 'null');
  const nullBox = env._json_decode_v2(q, m);
  ok(nullBox !== 0, 'null decodes to a box');
  eq(view(loader).getInt32(nullBox, true), 0, 'null tag');
});

test('_json_decode_v2: duplicate keys resolve last-wins (D2)', () => {
  const { loader, env } = freshLoader();
  const [p, n] = raw(loader, '{"k":1,"k":2}');
  eq(loader._jsonRead(env._json_decode_v2(p, n)), { k: 2 }, 'last value kept');
});

test('_json_get: dot path into JSON text, objects and arrays', () => {
  const { loader, env } = freshLoader();
  const source = loader._jsonWrite('{"user":{"tags":["a","b"],"age":30}}');
  eq(loader._jsonRead(env._json_get(source, lp(loader, 'user.tags.1'))), 'b', 'array index');
  eq(loader._jsonRead(env._json_get(source, lp(loader, 'user.age'))), 30, 'integer leaf');
  const boxed = loader._jsonWrite({ list: [{ id: 7 }] });
  eq(loader._jsonRead(env._json_get(boxed, lp(loader, 'list.0.id'))), 7, 'walks a box tree');
});

test('_json_get: unresolved path, non-JSON text and a 0 source give a null box', () => {
  const { loader, env } = freshLoader();
  const source = loader._jsonWrite('{"a":1}');
  const missing = env._json_get(source, lp(loader, 'a.b'));
  eq(view(loader).getInt32(missing, true), 0, 'missing path is null');
  const notJson = env._json_get(loader._jsonWrite('not json'), lp(loader, 'a'));
  eq(view(loader).getInt32(notJson, true), 0, 'unparsable text is null');
  const fromZero = env._json_get(0, lp(loader, 'a'));
  eq(view(loader).getInt32(fromZero, true), 0, 'source 0 is null');
  eq(loader._jsonRead(env._json_get(loader._jsonWrite({ x: [1] }), lp(loader, 'x.y'))), null, 'named segment on an array');
});

// ---------------------------------------------------------------------------
// Stdlib imports emitted by the compiler
// ---------------------------------------------------------------------------

test('string.concat / string_concat take and return LP strings', () => {
  const { loader, env } = freshLoader();
  eq(readLP(loader, env['string.concat'](lp(loader, 'ab'), lp(loader, 'çd'))), 'abçd', 'string.concat');
  eq(readLP(loader, env.string_concat(lp(loader, ''), lp(loader, 'x'))), 'x', 'string_concat');
});

test('string_compare returns -1 / 0 / 1 with 0 for equal strings', () => {
  const { loader, env } = freshLoader();
  eq(env.string_compare(lp(loader, 'ab'), lp(loader, 'ab')), 0, 'equal');
  eq(env.string_compare(lp(loader, 'ab'), lp(loader, 'b')), -1, 'less');
  eq(env.string_compare(lp(loader, 'b'), lp(loader, 'ab')), 1, 'greater');
});

test('integer / float conversions use LP strings; i64 arrives as BigInt', () => {
  const { loader, env } = freshLoader();
  eq(readLP(loader, env.int_to_string(-12)), '-12', 'int_to_string');
  eq(readLP(loader, env.int64_to_string(9007199254740993n)), '9007199254740993', 'int64_to_string keeps 64 bits');
  eq(readLP(loader, env.float_to_string(2.5)), '2.5', 'float_to_string');
  eq(readLP(loader, env.float_to_string(3)), '3', 'whole float like the server');
  eq(env.string_to_int(lp(loader, ' 42 ')), 42, 'string_to_int');
  eq(env.string_to_int(lp(loader, 'x')), 0, 'string_to_int failure is 0');
  eq(env.string_to_float(lp(loader, '1.25')), 1.25, 'string_to_float');
  eq(env.string_to_float(lp(loader, 'nope')), 0, 'string_to_float failure is 0');
});

test('string_matches(ptr, len, pattern_id) checks the registry pattern table', () => {
  const { loader, env } = freshLoader();
  const m = (text, id) => env.string_matches(...raw(loader, text), id);
  eq([m('a@b.co', 0), m('a@b', 0)], [1, 0], 'email');
  eq([m('https://x.dev/p', 1), m('x.dev', 1)], [1, 0], 'url');
  eq([m('123e4567-e89b-12d3-a456-426614174000', 2), m('123', 2)], [1, 0], 'uuid');
  eq([m('+1 (555) 010-9999', 3), m('12', 3)], [1, 0], 'phone');
  eq([m('2026-11-04', 4), m('04/11/2026', 4)], [1, 0], 'date');
  eq([m('-17', 5), m('1.5', 5)], [1, 0], 'integer');
  eq([m('1.5e3', 6), m('1.5.3', 6)], [1, 0], 'number');
  eq([m('abc123', 7), m('abc 123', 7)], [1, 0], 'alphanumeric');
  eq(m('anything', 99), 0, 'unknown pattern id');
});

test('error(msg) logs and returns 0; input(prompt) returns an LP string', () => {
  const { loader, env } = freshLoader();
  const original = console.error;
  let logged = '';
  console.error = (s) => { logged = s; };
  try {
    eq(env.error(lp(loader, 'boom')), 0, 'error returns 0');
  } finally {
    console.error = original;
  }
  ok(logged.includes('boom'), 'error message logged');
  eq(readLP(loader, env.input(lp(loader, 'name?'))), '', 'no prompt available -> empty string');
});

// ---------------------------------------------------------------------------
// Canvas bridge decoding
// ---------------------------------------------------------------------------

test('canvas state store: names are (ptr, len); values are numbers', () => {
  const { loader, env } = freshLoader();
  env._canvas_var_set(...raw(loader, 'score'), 12);
  eq(env._canvas_var_get(...raw(loader, 'score'), -1), 12, 'stored value');
  eq(env._canvas_var_get(...raw(loader, 'missing'), 3.5), 3.5, 'default for an unknown name');
});

test('scene / page stores return LP strings on the module heap', () => {
  const { loader, env, heap } = freshLoader();
  env._scene_set(...raw(loader, 'level'), ...raw(loader, '3'));
  const before = heap.value;
  const p = env._scene_get(...raw(loader, 'level'));
  ok(p >= before - 64 && p < heap.value, 'returned pointer is a module-heap allocation');
  eq(readLP(loader, p), '3', 'scene.get');
  eq(readLP(loader, env._scene_get(...raw(loader, 'nope'))), '', 'missing key');
  env._page_set(...raw(loader, 'score'), ...raw(loader, '9'));
  eq(readLP(loader, env._page_get(...raw(loader, 'score'))), '9', 'page.get');
  eq(readLP(loader, env._anim_state_current(...raw(loader, 'noFsm'))), '', 'unknown animState');
});

test('input.lastKey returns the last key pressed as an LP string', () => {
  const { loader, env, bridge } = freshLoader();
  eq(readLP(loader, env._input_get_last_key()), '', 'no key pressed yet');
  bridge.lastKey = 'ArrowUp';
  eq(readLP(loader, env._input_get_last_key()), 'ArrowUp', 'last key');
});

test('collision helpers return 1 / 0 (CVS-P001) and a ray distance or -1 (CVS-P002)', () => {
  const { env } = freshLoader();
  eq([env._collision_circles(0, 0, 5, 8, 0, 3), env._collision_circles(0, 0, 1, 8, 0, 1)], [1, 0], 'circles');
  eq([env._collision_rects(0, 0, 10, 10, 5, 5, 10, 10), env._collision_rects(0, 0, 1, 1, 5, 5, 1, 1)], [1, 0], 'rects');
  eq([env._collision_point_rect(5, 5, 0, 0, 10, 10), env._collision_point_rect(11, 5, 0, 0, 10, 10)], [1, 0], 'pointRect');
  eq([env._collision_circle_rect(12, 5, 3, 0, 0, 10, 10), env._collision_circle_rect(20, 5, 3, 0, 0, 10, 10)], [1, 0], 'circleRect');
  eq([env._collision_point_circle(1, 1, 0, 0, 2), env._collision_point_circle(3, 3, 0, 0, 2)], [1, 0], 'pointCircle');
  eq(env._collision_ray_circle(0, 0, 1, 0, 10, 0, 2), 8, 'ray hits at distance 8');
  eq(env._collision_ray_circle(0, 0, 1, 0, 10, 5, 2), -1, 'ray misses');
});

test('easing: spec names (frame-canvas.ebnf §28) map to the runtime curves', () => {
  const { bridge } = freshLoader();
  eq(bridge._easeNameToId('easeOutQuad'), 5, 'easeOutQuad');
  eq(bridge._easeNameToId('easeInOutBack'), 21, 'easeInOutBack');
  eq(bridge._evalEaseByName('easeOutQuad', 0.5), 0.75, 'easeOutQuad(0.5)');
  for (let id = 0; id <= 21; id++) {
    const end = bridge._evalEaseId(id, 1);
    ok(Math.abs(end - 1) < 1e-9, `ease ${id} ends at 1 (got ${end})`);
  }
  ok(bridge._isKnownEase('linear') && bridge._isKnownEase('easeInSine'), 'built-ins are known');
  ok(!bridge._isKnownEase('wobble'), 'unknown name');
  bridge.customEases.set('wobble', { x1: 0.4, y1: 0, x2: 0.6, y2: 1 });
  ok(bridge._isKnownEase('wobble'), 'registered customEase is known');
});

test('tweens: a NaN from= starts at the variable value when the tween plays (CVS-A009)', () => {
  const { loader, env, bridge } = freshLoader();
  env._canvas_var_set(...raw(loader, 'x'), 10);
  env._tween_define_var(...raw(loader, 'slide'), ...raw(loader, 'x'), NaN, 20, 1, ...raw(loader, 'linear'), 0, 0, 0, ...raw(loader, ''));
  env._tween_play(...raw(loader, 'slide'));
  bridge._updateAnimations(0.5);
  eq(bridge.canvasVars.get('x'), 15, 'halfway from the value at play time');
  bridge._updateAnimations(0.5);
  eq(bridge.canvasVars.get('x'), 20, 'finished');
});

test('tweens: repeat=N plays N+1 times; with yoyo every odd play runs back (CVS-A010)', () => {
  const { loader, env, bridge } = freshLoader();
  const define = (name, repeat, yoyo) => env._tween_define_var(...raw(loader, name), ...raw(loader, 'v' + name), 0, 10, 1, ...raw(loader, 'linear'), repeat, yoyo, 0, ...raw(loader, ''));
  const run = (name, steps) => {
    env._tween_play(...raw(loader, name));
    const seen = [];
    for (const dt of steps) { bridge._updateAnimations(dt); seen.push(bridge.canvasVars.get('v' + name)); }
    return seen;
  };
  define('a', 1, 1);
  eq(run('a', [0.5, 0.5, 0.5, 0.6]), [5, 10, 5, 0], 'repeat=1 yoyo: out and back, ends at from');
  eq(bridge.namedTweens.get('a').state, 'stopped', 'repeat=1 yoyo stops after two plays');
  define('b', 2, 1);
  eq(run('b', [0.5, 1, 1, 0.75]), [5, 5, 5, 10], 'repeat=2 yoyo: out, back, out — ends at to');
  define('c', 1, 0);
  eq(run('c', [0.5, 1, 0.75]), [5, 5, 10], 'repeat=1 without yoyo restarts each play and ends at to');
});

test('path sampling follows the curve shape, not the segment endpoints', () => {
  const { loader, env, bridge } = freshLoader();
  const near = (pt, x, y, what) => ok(Math.abs(pt.x - x) < 0.05 && Math.abs(pt.y - y) < 0.05, `${what}: expected (${x}, ${y}), got (${pt.x}, ${pt.y})`);
  const name = (n) => raw(loader, n);
  env._path_begin(...name('quad'));
  env._path_move_to(...name('quad'), 0, 0);
  env._path_curve_to(...name('quad'), 50, 100, 100, 0);
  near(bridge._sampleNamedPath('quad', 0.5), 50, 50, 'quadratic midpoint');
  env._path_begin(...name('cubic'));
  env._path_move_to(...name('cubic'), 0, 0);
  env._path_cubic_to(...name('cubic'), ...[0, 100, 100, 100, 100, 0]);
  near(bridge._sampleNamedPath('cubic', 0.5), 50, 75, 'cubic midpoint');
  // arcTo x= y= is the centre: a half circle from angle 0 to pi passes
  // through the bottom of the circle (y grows downwards).
  env._path_begin(...name('arc'));
  env._path_move_to(...name('arc'), 200, 100);
  env._path_arc_to(...name('arc'), 100, 100, 100, 0, Math.PI);
  near(bridge._sampleNamedPath('arc', 0.5), 100, 200, 'arc midpoint');
  near(bridge._sampleNamedPath('arc', 1), 0, 100, 'arc end');
  // The pen jumps to the arc start, like CanvasRenderingContext2D.arc.
  env._path_begin(...name('arcJump'));
  env._path_move_to(...name('arcJump'), 100, 0);
  env._path_arc_to(...name('arcJump'), 100, 100, 50, 0, Math.PI / 2);
  near(bridge._sampleNamedPath('arcJump', 0), 100, 0, 'starts at the pen');
  // closePath returns to the start of the current sub-path.
  env._path_begin(...name('sq'));
  env._path_move_to(...name('sq'), 0, 0);
  env._path_line_to(...name('sq'), 100, 0);
  env._path_line_to(...name('sq'), 100, 100);
  env._path_close(...name('sq'));
  // 100 + 100 + 141.42 long: 90% is 107.28 along the closing diagonal.
  near(bridge._sampleNamedPath('sq', 0.9), 24.142, 24.142, 'closing diagonal');
  const tangent = bridge._sampleNamedPath('quad', 0);
  ok(Math.abs(tangent.angle - Math.atan2(100, 50)) < 0.05, `tangent at the start points at the control point (got ${tangent.angle})`);
});

test('particles: config from _particles_define_json drives spawn ranges', () => {
  const { loader, env, bridge } = freshLoader();
  const cfg = { lifeMin: 1, lifeMax: 1, speedMin: 10, speedMax: 10, angleMin: -90, angleMax: -90, sizeMin: 4, sizeMax: 4, color: '#fff', burst: 3 };
  env._particles_define_json(...raw(loader, 'puff'), ...raw(loader, JSON.stringify(cfg)));
  env._particles_emit(...raw(loader, 'puff'), 100, 100);
  const em = bridge.namedParticles.get('puff').emitters[0];
  eq(em.particles.length, 3, 'burst count');
  const p = em.particles[0];
  ok(Math.abs(p.vx) < 1e-9 && Math.abs(p.vy + 10) < 1e-9, 'angle is in degrees: -90 points up');
  eq([p.life, p.maxLife, p.size], [1, 1, 4], 'life and size from the config');
});

test('animState: onComplete moves to the next state when the clip finishes (CVS-A004)', () => {
  const { loader, env, bridge } = freshLoader();
  env._animsprite_define(...raw(loader, 'swing'), ...raw(loader, 'hero'), 0, 1, 10, 0);
  env._animsprite_define(...raw(loader, 'rest'), ...raw(loader, 'hero'), 2, 3, 10, 1);
  const cfg = { initial: 'attack', clips: { attack: 'swing', idle: 'rest' }, onComplete: { attack: 'idle' } };
  env._animstate_define_json(...raw(loader, 'fsm'), ...raw(loader, JSON.stringify(cfg)));
  env._anim_state_start(...raw(loader, 'fsm'));
  bridge._updateAnimations(0.25);
  eq(readLP(loader, env._anim_state_current(...raw(loader, 'fsm'))), 'idle', 'transitioned after the non-looping clip ended');
  env._anim_state_force(...raw(loader, 'fsm'), ...raw(loader, 'attack'));
  eq(bridge.namedAnimSprites.get('swing').finished, false, 'forcing a state restarts its clip');
});

test('timeline: steps play their tweens at their times', () => {
  const { loader, env, bridge } = freshLoader();
  env._tween_define_var(...raw(loader, 'a'), ...raw(loader, 'v'), 0, 1, 1, ...raw(loader, 'linear'), 0, 0, 0, ...raw(loader, ''));
  env._timeline_define_json(...raw(loader, 'tl'), ...raw(loader, '{"steps":[{"at":0.5,"play":"a"}],"duration":1.5}'));
  env._timeline_play(...raw(loader, 'tl'));
  bridge._updateAnimations(0.25);
  eq(bridge.namedTweens.get('a').state, 'stopped', 'not started before its time');
  bridge._updateAnimations(0.5);
  eq(bridge.namedTweens.get('a').state, 'playing', 'started at 0.5s');
});

test('timeline: animate actions and onComplete set steps', () => {
  const { loader, env, bridge } = freshLoader();
  env._canvas_var_set(...raw(loader, 'alpha'), 0);
  const cfg = { steps: [{ at: 0, animate: { varName: 'alpha', to: 1, duration: 1, ease: 'linear' } }, { at: 1, var: 'done', set: 0 }], duration: 1 };
  env._timeline_define_json(...raw(loader, 'fade'), ...raw(loader, JSON.stringify(cfg)));
  env._timeline_play(...raw(loader, 'fade'));
  bridge._updateAnimations(0.01);
  bridge._updateAnimations(0.5);
  ok(Math.abs(bridge.canvasVars.get('alpha') - 0.5) < 1e-9, `animate drives the variable (got ${bridge.canvasVars.get('alpha')})`);
  ok(!bridge.canvasVars.has('done'), 'set step waits for its time');
  bridge._updateAnimations(0.6);
  eq(bridge.canvasVars.get('done'), 0, 'set step stores 0 too (not only truthy values)');
  eq(bridge.namedTimelines.get('fade').state, 'stopped', 'timeline ends at its duration');
});

test('animate statement bridge: _tween_animate(var, to, duration, easingId) starts at the current value', () => {
  const { loader, env, bridge } = freshLoader();
  env._canvas_var_set(...raw(loader, 'x'), 4);
  env._tween_animate(...raw(loader, 'x'), 8, 1, 0);
  bridge._updateAnimations(0.25);
  eq(bridge.canvasVars.get('x'), 5, 'linear quarter of the way');
});

// ---------------------------------------------------------------------------
// time.* bridges (stdlib-reference §12) — Unix seconds; expected values are
// clean-server's (host-bridge/src/wasm_linker/env_time.rs tests)
// ---------------------------------------------------------------------------

const NEW_YEAR_2026 = 1767225600; // 2026-01-01T00:00:00Z

const timeFormat = (loader, env, ts, pattern, locale, tz) =>
  readLP(loader, env._time_format(ts, ...raw(loader, pattern), ...raw(loader, locale), ...raw(loader, tz)));
const timeParse = (loader, env, iso) => env._time_parse(...raw(loader, iso));

test('_time_now is Unix seconds as an i64 (BigInt)', () => {
  const { env } = freshLoader();
  const now = env._time_now();
  eq(typeof now, 'bigint', '_time_now type');
  ok(Math.abs(Number(now) - Date.now() / 1000) < 5, `_time_now is seconds (got ${now})`);
});

test('_time_format: pattern tokens, 12-hour clock, IANA zones', () => {
  const { loader, env } = freshLoader();
  const ts = NEW_YEAR_2026 + 14 * 3600 + 5 * 60 + 9;
  eq(timeFormat(loader, env, ts, 'YYYY-MM-DD HH:mm:ss', '', 'UTC'), '2026-01-01 14:05:09', 'tokens');
  eq(timeFormat(loader, env, ts, 'h:mm A / h a', 'en-US', 'UTC'), '2:05 PM / 2 pm', '12-hour');
  eq(timeFormat(loader, env, ts, 'YYYY-MM-DD HH:mm', '', 'America/New_York'), '2026-01-01 09:05', 'New York is UTC-5 in January');
  eq(timeFormat(loader, env, NEW_YEAR_2026, 'h A', '', 'UTC'), '12 AM', 'midnight');
  eq(timeFormat(loader, env, ts, 'HH:mm', '', 'Mars/Olympus'), '14:05', 'unknown zone is UTC');
  eq(timeFormat(loader, env, NaN, 'YYYY', '', 'UTC'), '', 'non-finite timestamp');
});

test('_time_parse: ISO 8601 to Unix seconds, -1 when invalid', () => {
  const { loader, env } = freshLoader();
  eq(timeParse(loader, env, '2026-01-01T00:00:00Z'), NEW_YEAR_2026, 'UTC');
  eq(timeParse(loader, env, '2026-01-01T00:00:00.500Z'), NEW_YEAR_2026 + 0.5, 'fraction');
  eq(timeParse(loader, env, '2026-01-01T01:00:00+01:00'), NEW_YEAR_2026, 'offset');
  eq(timeParse(loader, env, '2026-01-01'), NEW_YEAR_2026, 'date only is UTC midnight');
  eq(timeParse(loader, env, '2026-01-01T08:30'), new Date(2026, 0, 1, 8, 30).getTime() / 1000, 'no offset is local time');
  eq(timeParse(loader, env, 'yesterday'), -1, 'invalid');
  eq(timeParse(loader, env, '2026-02-30'), -1, 'no such day');
});

test('_time_parts: calendar fields JSON in a zone', () => {
  const { loader, env } = freshLoader();
  eq(JSON.parse(readLP(loader, env._time_parts(NEW_YEAR_2026, ...raw(loader, 'UTC')))),
    { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, dayOfWeek: 4, timestamp: NEW_YEAR_2026 }, 'UTC');
  const ny = JSON.parse(readLP(loader, env._time_parts(NEW_YEAR_2026, ...raw(loader, 'America/New_York'))));
  eq([ny.year, ny.day, ny.hour], [2025, 31, 19], 'New York');
});

test('_time_add: fixed units, calendar months and years', () => {
  const { loader, env } = freshLoader();
  const jan31 = timeParse(loader, env, '2026-01-31T10:00:00Z');
  const add = (n, unit) => env._time_add(jan31, n, ...raw(loader, unit));
  eq(add(1, 'months'), timeParse(loader, env, '2026-02-28T10:00:00Z'), '+1 month clamps the day');
  eq(add(-2, 'months'), timeParse(loader, env, '2025-11-30T10:00:00Z'), '-2 months');
  eq(env._time_add(timeParse(loader, env, '2024-02-29T00:00:00Z'), 1, ...raw(loader, 'years')), timeParse(loader, env, '2025-02-28T00:00:00Z'), 'leap day + 1 year');
  eq([add(90, 'seconds'), add(2, 'minutes'), add(3, 'hours'), add(1, 'days'), add(2, 'weeks')].map((v) => v - jan31), [90, 120, 10800, 86400, 1209600], 'fixed units');
  ok(Number.isNaN(add(1, 'fortnights')), 'unknown unit is NaN');
});

test('_time_diff: fractional fixed units and calendar months', () => {
  const { loader, env } = freshLoader();
  const a = timeParse(loader, env, '2026-01-01T00:00:00Z');
  const b = timeParse(loader, env, '2026-01-02T12:00:00Z');
  const diff = (from, to, unit) => env._time_diff(from, to, ...raw(loader, unit));
  eq([diff(a, b, 'days'), diff(a, b, 'hours'), diff(b, a, 'hours'), diff(a, b, 'seconds')], [1.5, 36, -36, 129600], 'fixed units');
  const jan31 = timeParse(loader, env, '2026-01-31T00:00:00Z');
  const feb28 = timeParse(loader, env, '2026-02-28T00:00:00Z');
  eq([diff(jan31, feb28, 'months'), diff(feb28, jan31, 'months')], [1, -1], 'calendar months');
  ok(Math.abs(diff(a, timeParse(loader, env, '2027-07-01T00:00:00Z'), 'years') - 1.5) < 1e-9, 'years');
  ok(Number.isNaN(diff(a, b, 'eons')), 'unknown unit is NaN');
});

test('_time_relative: wording relative to now, localized', () => {
  const { loader, env } = freshLoader();
  const now = Date.now() / 1000;
  const rel = (ts, locale) => readLP(loader, env._time_relative(ts, ...raw(loader, locale)));
  eq(rel(now - 5, 'en'), 'just now', 'just now');
  eq(rel(now - 3 * 3600, 'en'), '3 hours ago', 'past');
  eq(rel(now + 2 * 86400 + 30, 'en'), 'in 2 days', 'future');
  eq(rel(now - 60, 'en-US'), '1 minute ago', 'singular');
  eq(rel(now - 3 * 3600, 'es'), 'hace 3 horas', 'Spanish');
  eq(rel(now + 2 * 86400 + 30, 'fr'), 'dans 2 jours', 'French');
  eq(rel(now - 400 * 86400, 'de'), 'vor 1 Jahr', 'German');
});

// ---------------------------------------------------------------------------
// Bridge contract: plugin.toml [bridge] vs the runtime
// ---------------------------------------------------------------------------

test('every plugin.toml [bridge] function is implemented with its WASM arity', () => {
  const { env } = freshLoader();
  const toml = readFileSync(join(pluginDir, 'plugin.toml'), 'utf8');
  const entries = [...toml.matchAll(/\{ name = "(_[a-z0-9_]+)", params = \[([^\]]*)\][^\n]*\}/g)];
  ok(entries.length > 200, `parsed the [bridge] table (${entries.length} entries)`);
  const problems = [];
  for (const [line, name, paramList] of entries) {
    const params = paramList.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
    const expand = /expand_strings = true/.test(line);
    const arity = params.reduce((n, p) => n + (p === 'string' && expand ? 2 : 1), 0);
    if (typeof env[name] !== 'function') problems.push(`${name} missing`);
    else if (env[name].length !== arity) problems.push(`${name} takes ${env[name].length} args, WASM passes ${arity}`);
  }
  eq(problems, [], 'bridge contract');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log('FAIL: frame.canvas runtime bridges');
  process.exit(1);
}
console.log('PASS: frame.canvas runtime bridges');
