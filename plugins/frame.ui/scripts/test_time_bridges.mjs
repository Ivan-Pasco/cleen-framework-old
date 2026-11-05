/**
 * test_time_bridges.mjs — the time.* bridges of the browser runtime
 * (stdlib-reference §12, function-registry.toml): _time_now, _time_format,
 * _time_relative, _time_parse, _time_parts, _time_add, _time_diff.
 *
 * The real runtime/loader.js is booted in a minimal DOM (lib/dom_shim.mjs)
 * with a module that exports only `memory` and `__heap_ptr`; the env import
 * object the loader instantiates it with is captured and each bridge is
 * called the way compiled code calls it — strings as (ptr, len) in linear
 * memory, string results as length-prefixed pointers. Timestamps are Unix
 * seconds. Expected values are clean-server's
 * (host-bridge/src/wasm_linker/env_time.rs tests).
 *
 * Exit 0 if all tests pass, 1 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createWindow, Event, CustomEvent, MutationObserver } from './lib/dom_shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, '..', 'runtime', 'loader.js');

// (module (memory (export "memory") 1)
//         (global (export "__heap_ptr") (mut i32) (i32.const 4096)))
const MODULE_BYTES = new Uint8Array([
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
	0x05, 0x03, 0x01, 0x00, 0x01,
	0x06, 0x07, 0x01, 0x7f, 0x01, 0x41, 0x80, 0x20, 0x0b,
	0x07, 0x17, 0x02,
	0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
	0x0a, 0x5f, 0x5f, 0x68, 0x65, 0x61, 0x70, 0x5f, 0x70, 0x74, 0x72, 0x03, 0x00,
]);

// Boot the loader; resolve with the env imports and the module memory.
async function boot() {
	const win = createWindow('<div id="app"></div>');
	const doc = win.document;
	const script = doc.createElement('script');
	script.setAttribute('data-wasm', 'frontend.wasm');
	doc.currentScript = script;
	let imports = null;
	const wasm = new Proxy(WebAssembly, {
		get(target, prop) {
			if (prop === 'instantiate') {
				return (bytes, importObject) => {
					imports = importObject;
					return target.instantiate(bytes, importObject);
				};
			}
			return target[prop];
		},
	});
	const errors = [];
	const sandbox = {
		window: win,
		document: doc,
		console: { error: (...a) => errors.push(a.map(String).join(' ')), warn: () => {}, log: () => {}, info: () => {}, debug: () => {} },
		fetch: async () => ({ ok: true, arrayBuffer: async () => MODULE_BYTES.slice().buffer }),
		WebAssembly: wasm,
		Intl,
		TextEncoder,
		TextDecoder,
		setTimeout,
		clearTimeout,
		queueMicrotask,
		MutationObserver,
		Event,
		CustomEvent,
		URL,
	};
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(LOADER, 'utf8'), sandbox, { filename: 'loader.js' });
	for (let i = 0; i < 200 && !(win.__cleanRuntime && win.__cleanRuntime.getInstance); i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	if (!(win.__cleanRuntime && win.__cleanRuntime.getInstance)) {
		throw new Error('loader did not finish: ' + errors.join('\n'));
	}
	return { env: imports.env, memory: win.__cleanRuntime.getMemory() };
}

let scratch = 60000;
// UTF-8 bytes of `text` in linear memory: the (ptr, len) of a string argument.
function raw(memory, text) {
	const bytes = new TextEncoder().encode(text);
	const ptr = scratch;
	new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
	scratch += bytes.length + 8;
	return [ptr, bytes.length];
}
// A length-prefixed string result.
function readLP(memory, ptr) {
	const len = new DataView(memory.buffer).getUint32(ptr, true);
	return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 4, len));
}

let passed = 0;
const failures = [];
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (err) {
		failures.push(name);
		console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : String(err)));
	}
}
function eq(actual, expected, what) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(what + ': expected ' + e + ', got ' + a);
}
function ok(cond, what) {
	if (!cond) throw new Error(what);
}

const NEW_YEAR_2026 = 1767225600; // 2026-01-01T00:00:00Z

async function main() {
	const { env, memory } = await boot();
	const str = (text) => raw(memory, text);
	const call = (name, ...args) => {
		if (typeof env[name] !== 'function') throw new Error(name + ' is not provided by the loader');
		return env[name](...args);
	};
	const format = (ts, pattern, locale, tz) => readLP(memory, call('_time_format', ts, ...str(pattern), ...str(locale), ...str(tz)));
	const parse = (iso) => call('_time_parse', ...str(iso));
	const parts = (ts, tz) => JSON.parse(readLP(memory, call('_time_parts', ts, ...str(tz))));
	const add = (ts, n, unit) => call('_time_add', ts, n, ...str(unit));
	const diff = (from, to, unit) => call('_time_diff', from, to, ...str(unit));
	const relative = (ts, locale) => readLP(memory, call('_time_relative', ts, ...str(locale)));

	console.log('time.* bridges (stdlib-reference §12):');

	test('_time_now is Unix seconds as an i64 (BigInt)', () => {
		const now = call('_time_now');
		eq(typeof now, 'bigint', 'type');
		ok(Math.abs(Number(now) - Date.now() / 1000) < 5, 'seconds, got ' + now);
	});

	test('_time_format: tokens, 12-hour clock, IANA zones', () => {
		const ts = NEW_YEAR_2026 + 14 * 3600 + 5 * 60 + 9;
		eq(format(ts, 'YYYY-MM-DD HH:mm:ss', '', 'UTC'), '2026-01-01 14:05:09', 'tokens');
		eq(format(ts, 'h:mm A / h a', 'en-US', 'UTC'), '2:05 PM / 2 pm', '12-hour');
		eq(format(ts, 'YYYY-MM-DD HH:mm', '', 'America/New_York'), '2026-01-01 09:05', 'New York is UTC-5 in January');
		eq(format(ts, 'DD/MM/YYYY HH:mm', 'ja-JP', 'Asia/Tokyo'), '01/01/2026 23:05', 'Tokyo');
		eq(format(NEW_YEAR_2026, 'h A', '', 'UTC'), '12 AM', 'midnight');
		eq(format(ts, 'HH:mm', '', 'Mars/Olympus'), '14:05', 'unknown zone is UTC');
		eq(format(NaN, 'YYYY', '', 'UTC'), '', 'non-finite timestamp');
	});

	test('_time_parse: ISO 8601 to Unix seconds, -1 when invalid', () => {
		eq(parse('2026-01-01T00:00:00Z'), NEW_YEAR_2026, 'UTC');
		eq(parse('2026-01-01T00:00:00.500Z'), NEW_YEAR_2026 + 0.5, 'fraction');
		eq(parse('2026-01-01T01:00:00+01:00'), NEW_YEAR_2026, 'offset');
		eq(parse('2026-01-01'), NEW_YEAR_2026, 'date only is UTC midnight');
		eq(parse('2026-01-01T08:30:00'), new Date(2026, 0, 1, 8, 30).getTime() / 1000, 'no offset is local time');
		eq(parse('yesterday'), -1, 'invalid');
		eq(parse('2026-13-01'), -1, 'no such month');
	});

	test('_time_parts: calendar fields JSON in a zone', () => {
		eq(parts(NEW_YEAR_2026, 'UTC'), { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, dayOfWeek: 4, timestamp: NEW_YEAR_2026 }, 'UTC');
		const ny = parts(NEW_YEAR_2026, 'America/New_York');
		eq([ny.year, ny.month, ny.day, ny.hour, ny.dayOfWeek], [2025, 12, 31, 19, 3], 'New York');
		eq(parts(NEW_YEAR_2026 + 0.25, 'UTC').timestamp, NEW_YEAR_2026 + 0.25, 'fractional timestamp');
	});

	test('_time_add: fixed units, calendar months and years', () => {
		const jan31 = parse('2026-01-31T10:00:00Z');
		eq(add(jan31, 1, 'months'), parse('2026-02-28T10:00:00Z'), '+1 month clamps the day');
		eq(add(jan31, -2, 'months'), parse('2025-11-30T10:00:00Z'), '-2 months');
		eq(add(parse('2024-02-29T00:00:00Z'), 1, 'years'), parse('2025-02-28T00:00:00Z'), 'leap day + 1 year');
		eq(['seconds', 'minutes', 'hours', 'days', 'weeks'].map((u, i) => add(jan31, [90, 2, 3, 1, 2][i], u) - jan31), [90, 120, 10800, 86400, 1209600], 'fixed units');
		ok(Number.isNaN(add(jan31, 1, 'fortnights')), 'unknown unit is NaN');
	});

	test('_time_diff: fractional fixed units and calendar months', () => {
		const a = parse('2026-01-01T00:00:00Z');
		const b = parse('2026-01-02T12:00:00Z');
		eq([diff(a, b, 'days'), diff(a, b, 'hours'), diff(b, a, 'hours'), diff(a, b, 'seconds')], [1.5, 36, -36, 129600], 'fixed units');
		eq([diff(parse('2026-01-31T00:00:00Z'), parse('2026-02-28T00:00:00Z'), 'months'), diff(parse('2026-02-28T00:00:00Z'), parse('2026-01-31T00:00:00Z'), 'months')], [1, -1], 'calendar months');
		ok(Math.abs(diff(a, parse('2027-07-01T00:00:00Z'), 'years') - 1.5) < 1e-9, 'years');
		ok(Number.isNaN(diff(a, b, 'eons')), 'unknown unit is NaN');
	});

	test('_time_relative: wording relative to now, localized', () => {
		const now = Date.now() / 1000;
		eq(relative(now - 5, 'en'), 'just now', 'just now');
		eq(relative(now - 3 * 3600, 'en'), '3 hours ago', 'past');
		eq(relative(now + 2 * 86400 + 30, 'en'), 'in 2 days', 'future');
		eq(relative(now - 60, 'en-US'), '1 minute ago', 'singular');
		eq(relative(now - 3 * 3600, 'es'), 'hace 3 horas', 'Spanish');
		eq(relative(now + 2 * 86400 + 30, 'fr'), 'dans 2 jours', 'French');
		eq(relative(now - 400 * 86400, 'de'), 'vor 1 Jahr', 'German');
		eq(relative(now - 31 * 86400, 'pt-BR'), 'há 1 mês', 'Portuguese');
	});

	console.log(passed + ' passed, ' + failures.length + ' failed');
	if (failures.length > 0) {
		console.log('FAIL: frame.ui time bridges');
		process.exit(1);
	}
	console.log('PASS: frame.ui time bridges');
}

main().catch((err) => {
	console.log('FAIL: frame.ui time bridges — ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
