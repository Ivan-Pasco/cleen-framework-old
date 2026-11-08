/**
 * test_loader_runtime.mjs — browser runtime (runtime/loader.js) behaviour:
 * the shared heap, the length-prefixed string bridges, HMAC, list pushes,
 * ui.onEvent delegation, callback error handling, iframe messages, the
 * startup error boundary, client-side navigation and companion scripts.
 *
 * The real loader.js runs in a minimal DOM (lib/dom_shim.mjs) against real
 * compiled WASM (fixtures/loader_*.cln, browser target); the env import
 * object it instantiates the module with is captured so single bridges can
 * also be called the way compiled code calls them.
 *
 * Compiler: $CLEEN_CLN, else ~/.cleen/bin/cln.
 * Exit 0 if all tests pass, 1 otherwise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindow, Event, CustomEvent, MouseEvent, MutationObserver } from './lib/dom_shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(HERE, '..', 'runtime', 'loader.js');
const FIXTURES = path.join(HERE, 'fixtures');
const CLN = process.env.CLEEN_CLN || path.join(os.homedir(), '.cleen', 'bin', 'cln');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-ui-loader-'));

function compile(name) {
	const out = path.join(WORK, name + '.wasm');
	try {
		execFileSync(CLN, ['compile', path.join(FIXTURES, name + '.cln'), '-o', out, '--target', 'browser'], { cwd: WORK, stdio: 'pipe' });
	} catch (err) {
		throw new Error('compile failed: ' + name + '\n' + String(err.stdout || '') + String(err.stderr || ''));
	}
	return fs.readFileSync(out);
}

// Build the fixture project fixtures/<name>/ (a main.cln manifest) and
// return its frontend.wasm — the client build with client_init.
function compileProject(name) {
	const dir = path.join(WORK, name);
	fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
	try {
		execFileSync(CLN, ['compile', 'main.cln', '-o', 'app.wasm', '--plugins'], { cwd: dir, stdio: 'pipe' });
	} catch (err) {
		throw new Error('compile failed: ' + name + '\n' + String(err.stdout || '') + String(err.stderr || ''));
	}
	return fs.readFileSync(path.join(dir, 'frontend.wasm'));
}

// A DOMParser over the shim: the parsed document's body holds the markup
// between <body> and </body> (or all of it).
class ShimDOMParser {
	parseFromString(html) {
		const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
		return createWindow(m ? m[1] : html).document;
	}
}

// Boot loader.js. opts.fetch serves non-WASM URLs; opts.loading starts the
// document in readyState "loading" (the caller fires DOMContentLoaded).
async function boot(bodyHtml, wasmBytes, opts = {}) {
	const win = createWindow(bodyHtml);
	const doc = win.document;
	if (opts.loading) doc.readyState = 'loading';
	const script = doc.createElement('script');
	script.setAttribute('data-wasm', 'frontend.wasm');
	doc.currentScript = script;
	const logs = { error: [], warn: [], log: [] };
	const fetches = [];
	const pushed = [];
	win.history = { pushState: (s, t, url) => pushed.push(url), replaceState: (s, t, url) => pushed.push(url) };
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
	const sandbox = {
		window: win,
		document: doc,
		console: {
			error: (...a) => logs.error.push(a.map(String).join(' ')),
			warn: (...a) => logs.warn.push(a.map(String).join(' ')),
			log: (...a) => logs.log.push(a.map(String).join(' ')),
			info: () => {},
			debug: () => {},
		},
		fetch: async (url, init) => {
			if (url === 'frontend.wasm') {
				return { ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) };
			}
			fetches.push(url);
			if (!opts.fetch) throw new Error('unexpected fetch ' + url);
			return opts.fetch(url, init);
		},
		DOMParser: ShimDOMParser,
		WebAssembly: wasm,
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
	const ready = async () => {
		for (let i = 0; i < 200 && !(win.__cleanRuntime && win.__cleanRuntime.getInstance); i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		if (!(win.__cleanRuntime && win.__cleanRuntime.getInstance)) {
			throw new Error('loader did not finish: ' + logs.error.join('\n'));
		}
		await settle();
	};
	if (!opts.loading) await ready();
	return { win, doc, logs, fetches, pushed, ready, sandbox, imports: () => imports };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (err) {
		failures.push(name + ': ' + (err && err.message ? err.message : String(err)));
		console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : String(err)));
	}
}
function eq(actual, expected, what) {
	if (actual !== expected) throw new Error(what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// (ptr, len) of a host-written string, as compiled code passes it.
function arg(rt, s) {
	const lp = rt.writeString(s);
	return [lp + 4, new DataView(rt.getMemory().buffer).getUint32(lp, true)];
}
function lpText(rt, lp) {
	const len = new DataView(rt.getMemory().buffer).getUint32(lp, true);
	return rt.readString(lp + 4, len);
}

async function main() {
	const heapWasm = compile('loader_heap');
	const stringsWasm = compile('loader_strings');
	const eventsWasm = compile('loader_events');
	const startErrorWasm = compile('loader_start_error');
	const bindWasm = compileProject('loader_bind');

	console.log('loader runtime:');

	await test('host strings and module allocations do not overlap (shared __heap_ptr)', async () => {
		const a = 'hello-from-host-string-0123456789';
		const { doc } = await boot('<div id="src">' + a + '</div><div id="src2">second</div><div id="out"></div>', heapWasm);
		const expected = a + '|' + a + '-tail-from-wasm-concat|second|' + a.substring(0, 10) + a.toUpperCase();
		eq(doc.querySelector('#out').textContent, expected, '#out');
	});

	await test('host allocations advance the module __heap_ptr; mem_alloc is (type_id, size), 8-aligned', async () => {
		const { win, imports } = await boot('<div id="src">x</div><div id="num">1</div><div id="out"></div>', stringsWasm);
		const rt = win.__cleanRuntime;
		const heap = rt.getInstance().exports.__heap_ptr;
		const before = heap.value;
		const s = rt.writeString('abc');
		if (s < before) throw new Error('writeString below __heap_ptr: ' + s + ' < ' + before);
		if (heap.value < s + 7) throw new Error('__heap_ptr not advanced past the host string');
		const p = imports().memory_runtime.mem_alloc(5, 13);
		eq(p % 8, 0, 'mem_alloc alignment');
		if (p < s + 7) throw new Error('mem_alloc overlaps the previous host string');
		if (heap.value < p + 13) throw new Error('mem_alloc did not reserve `size` bytes (type_id taken as size?)');
		const next = rt.writeString('z');
		if (next < p + 13) throw new Error('next allocation overlaps the mem_alloc block');
	});

	await test('.replace and .toNumber read length-prefixed arguments', async () => {
		const { doc } = await boot('<div id="src">banana</div><div id="num">12.5</div><div id="out"></div>', stringsWasm);
		eq(doc.querySelector('#out').textContent, 'bXnXnX|12.5|0', '#out');
	});

	await test('_crypto_hmac works on bytes (sha256, sha512, long key)', async () => {
		const { win, imports } = await boot('<div id="src">x</div><div id="num">1</div><div id="out"></div>', stringsWasm);
		const rt = win.__cleanRuntime;
		const env = imports().env;
		const cases = [['sha256', 'key', 'The quick brown fox'], ['sha512', 'key', 'data'], ['sha256', 'k'.repeat(100), 'msg'], ['sha512', 'é'.repeat(80), 'ü']];
		for (const [alg, key, data] of cases) {
			const got = lpText(rt, env._crypto_hmac(...arg(rt, data), ...arg(rt, key), ...arg(rt, alg)));
			const want = crypto.createHmac(alg, key).update(data).digest('hex');
			eq(got, want, 'hmac ' + alg + ' key length ' + key.length);
		}
	});

	await test('password hashing is not a browser bridge (server-only bcrypt)', async () => {
		// function-registry.toml: _crypto_hash_password / _crypto_verify_password
		// are hosts = ["server"]; a browser build calling them fails at compile
		// time, so the runtime must not offer a different (non-bcrypt) hash.
		const { imports } = await boot('<div id="src">x</div><div id="num">1</div><div id="out"></div>', stringsWasm);
		const env = imports().env;
		eq(typeof env._crypto_hash_password, 'undefined', 'env._crypto_hash_password');
		eq(typeof env._crypto_verify_password, 'undefined', 'env._crypto_verify_password');
	});

	await test('cl-bind: edits in a hydrated island update the component state and its render', async () => {
		const { doc, win, logs } = await boot("<div data-island='ui-profile' data-client='on'></div><input id='loose' data-cl-bind='name'>", bindWasm);
		const out = () => doc.querySelector('#out').textContent;
		eq(out(), '/false/0/', 'initial render');
		const name = doc.querySelector('#name');
		name.value = 'bob';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		eq(out(), 'bob/false/0/', 'text input');
		eq(doc.querySelector('#name2').value, 'bob', 'other control bound to the same field');
		const agree = doc.querySelector('#agree');
		agree.checked = true;
		agree.dispatchEvent(new Event('change', { bubbles: true }));
		eq(out(), 'bob/true/0/', 'checkbox');
		const radio = doc.querySelector('#s2');
		radio.checked = true;
		radio.dispatchEvent(new Event('change', { bubbles: true }));
		eq(out(), 'bob/true/2/', 'radio');
		const color = doc.querySelector('#color');
		color.value = 'blue';
		color.dispatchEvent(new Event('change', { bubbles: true }));
		eq(out(), 'bob/true/2/blue', 'select');
		eq(doc.querySelector('#color').getAttribute('data-cl-value'), 'blue', 'select data-cl-value');
		// A text control does not commit on 'change' a second time, and a
		// bound control outside an island (not hydrated) does nothing.
		const loose = doc.querySelector('#loose');
		loose.value = 'zed';
		loose.dispatchEvent(new Event('input', { bubbles: true }));
		eq(out(), 'bob/true/2/blue', 'control outside the island');
		eq(logs.error.length, 0, 'console errors: ' + logs.error.join(' | '));
	});

	await test('list.push_f64 never writes past the list capacity', async () => {
		const { win, imports } = await boot('<div id="src">x</div><div id="num">1</div><div id="out"></div>', stringsWasm);
		const rt = win.__cleanRuntime;
		const mem = imports().memory_runtime;
		const list = mem.mem_alloc(0, 16 + 2 * 8 + 8);
		let dv = new DataView(rt.getMemory().buffer);
		dv.setInt32(list, 2, true); dv.setInt32(list + 4, 2, true);
		dv.setFloat64(list + 16 + 16, 99.5, true); // the bytes after the list
		imports().env['list.push_f64'](list, 1.25);
		dv = new DataView(rt.getMemory().buffer);
		eq(dv.getInt32(list, true), 2, 'length of a full list');
		eq(dv.getFloat64(list + 32, true), 99.5, 'bytes after the list');
		dv.setInt32(list + 4, 3, true);
		imports().env['list.push_f64'](list, 1.25);
		dv = new DataView(rt.getMemory().buffer);
		eq(dv.getInt32(list, true), 3, 'length after a push with room');
		eq(dv.getFloat64(list + 32, true), 1.25, 'pushed value');
	});

	const eventsBody = '<div class="area" id="area"><span id="inner">text</span></div><div id="log"></div>';

	await test('ui.onEvent: a type registered passive and non-passive runs each handler once', async () => {
		const { doc } = await boot(eventsBody, eventsWasm);
		await wait(20);
		doc.querySelector('#log').textContent = '';
		doc.querySelector('#inner').dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
		const log = doc.querySelector('#log').textContent.split(';').filter(Boolean).sort().join(',');
		eq(log, 'passive,wheel', 'handlers run');
	});

	await test('ui.onEvent: an event on a text node reaches the element handler', async () => {
		const { doc, logs } = await boot(eventsBody, eventsWasm);
		await wait(20);
		doc.querySelector('#log').textContent = '';
		const text = doc.querySelector('#inner').childNodes[0];
		text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
		eq(doc.querySelector('#log').textContent, 'click;', '#log');
		eq(logs.error.filter((l) => l.includes('closest')).length, 0, 'closest errors');
	});

	await test('a failing timer handler is reported and later callbacks still run', async () => {
		const { doc, logs } = await boot(eventsBody, eventsWasm);
		await wait(30);
		if (!logs.error.some((l) => l.includes('failingTimer') && l.includes('failed'))) throw new Error('no report: ' + logs.error.join(' | '));
		if (!doc.querySelector('#log').textContent.includes('later;')) throw new Error('later timer did not run');
	});

	await test('iframe messages from another origin do not reach the handler', async () => {
		const { win, doc } = await boot(eventsBody, eventsWasm);
		await wait(20);
		doc.querySelector('#log').textContent = '';
		win.dispatchEvent(new Event('message', { origin: 'https://evil.example', data: 'steal' }));
		win.dispatchEvent(new Event('message', { origin: 'http://localhost', data: 'hi' }));
		eq(doc.querySelector('#log').textContent, 'msg:hi;', '#log');
	});

	await test('an error in start: shows the fallback of the page error boundaries', async () => {
		const { doc } = await boot('<div id="out"></div><section id="b" data-fallback="Something went wrong"><p>content</p></section>', startErrorWasm);
		const b = doc.querySelector('#b');
		eq(b.innerHTML, 'Something went wrong', 'boundary content');
		eq(b.classList.contains('cl-error'), true, 'cl-error class');
	});

	const navBody = '<main id="m"><a id="next" href="/next">n</a><a id="pdf" href="/report.pdf">p</a><a id="api" href="/api/data">a</a><a id="old" href="/old">o</a></main>';
	const navFetch = async (url) => {
		const html = (body) => ({ ok: true, status: 200, redirected: false, url, headers: new Map([['content-type', 'text/html; charset=utf-8']]), text: async () => body });
		if (url === '/next') return html('<html><body><main>NEXT</main></body></html>');
		if (url === '/old') return { ...html('<html><body><main>LOGIN</main></body></html>'), redirected: true, url: 'http://localhost/login' };
		if (url === '/api/data') return { ok: true, status: 200, redirected: false, url, headers: new Map([['content-type', 'application/json']]), text: async () => '{}' };
		throw new Error('unexpected ' + url);
	};
	const click = (el, init = {}) => {
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
		el.dispatchEvent(ev);
		return ev;
	};

	await test('navigation leaves modified, non-primary and already-handled clicks to the browser', async () => {
		const { doc, fetches } = await boot(navBody, startErrorWasm, { fetch: navFetch });
		const link = doc.querySelector('#next');
		eq(click(link, { ctrlKey: true }).defaultPrevented, false, 'ctrl-click prevented');
		eq(click(link, { metaKey: true }).defaultPrevented, false, 'meta-click prevented');
		eq(click(link, { button: 1 }).defaultPrevented, false, 'middle click prevented');
		const handled = (e) => e.preventDefault();
		link.addEventListener('click', handled);
		click(link);
		link.removeEventListener('click', handled);
		await settle();
		eq(fetches.length, 0, 'fetches');
	});

	await test('navigation does not intercept links to files', async () => {
		const { doc, fetches } = await boot(navBody, startErrorWasm, { fetch: navFetch });
		eq(click(doc.querySelector('#pdf')).defaultPrevented, false, 'pdf link prevented');
		await settle();
		eq(fetches.length, 0, 'fetches');
	});

	await test('navigation swaps an HTML page in with one request; a redirect lands on its URL', async () => {
		const { win, doc, fetches, pushed } = await boot(navBody, startErrorWasm, { fetch: navFetch });
		eq(click(doc.querySelector('#next')).defaultPrevented, true, 'page link prevented');
		await wait(10);
		eq(doc.querySelector('#m').textContent, 'NEXT', 'main content');
		eq(fetches.join(','), '/next', 'requests');
		eq(pushed.join(','), '/next', 'history');
		doc.querySelector('#m').innerHTML = '<a id="old" href="/old">o</a>';
		click(doc.querySelector('#old'));
		await wait(10);
		eq(doc.querySelector('#m').textContent, 'LOGIN', 'redirected content');
		eq(pushed[pushed.length - 1], '/login', 'history after a redirect');
		eq(win.location.href, 'http://localhost/', 'no full navigation');
	});

	await test('a non-HTML answer is opened by the browser (no second request from the runtime)', async () => {
		const { win, doc, fetches } = await boot(navBody, startErrorWasm, { fetch: navFetch });
		click(doc.querySelector('#api'));
		await wait(10);
		eq(fetches.join(','), '/api/data', 'runtime requests');
		eq(win.location.href, '/api/data', 'location');
	});

	await test('the WASM is instantiated only after the document is parsed (companion scripts first)', async () => {
		const booted = await boot('<div id="src">a</div><div id="num">1</div><div id="out"></div>', stringsWasm, { loading: true });
		await wait(20);
		if (booted.win.__cleanRuntime.getInstance) throw new Error('instantiated while the document was still loading');
		let called = false;
		booted.win.__cleanRuntime.registerEnv({ string_to_float: () => { called = true; return 7; } });
		booted.doc.readyState = 'interactive';
		booted.doc.dispatchEvent(new Event('DOMContentLoaded'));
		await booted.ready();
		eq(called, true, 'companion import used');
		eq(booted.doc.querySelector('#out').textContent, 'X|7|7', '#out');
	});

	console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
	fs.rmSync(WORK, { recursive: true, force: true });
	process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
