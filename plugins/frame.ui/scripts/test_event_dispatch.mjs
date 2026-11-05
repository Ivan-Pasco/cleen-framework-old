/**
 * test_event_dispatch.mjs — declarative event attributes in the browser
 * runtime (frame-ui-semantics UI-B006 / UI-B007 / UI-B009).
 *
 * Runs the real runtime/loader.js against real compiled WASM inside a
 * minimal DOM (lib/dom_shim.mjs). Nothing is mirrored or mocked from the
 * loader itself.
 *
 *   1. fixtures/event_dispatch_page.cln is compiled for the server and run
 *      with a print-only harness: its stdout is the page markup frame.ui
 *      renders in page mode (event attributes → data-on-* markers).
 *   2. That markup becomes the document body; fixtures/event_dispatch.cln
 *      (browser target, the handlers + a screen rendered through an html:
 *      block that keeps `onclick="..."` as written) is loaded by loader.js.
 *   3. DOM events are dispatched and the handlers' effects read back.
 *
 * examples/browser-counter is loaded the same way as a regression check of
 * the ui.onEvent registration path.
 *
 * Compiler: $CLEEN_CLN, else ~/.cleen/bin/cln.
 * Exit 0 if all tests pass, 1 otherwise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindow, Event, CustomEvent, MouseEvent, KeyboardEvent, MutationObserver } from './lib/dom_shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const FRAMEWORK_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const LOADER = path.join(PLUGIN_ROOT, 'runtime', 'loader.js');
const CLN = process.env.CLEEN_CLN || path.join(os.homedir(), '.cleen', 'bin', 'cln');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-ui-events-'));

function compile(src, out, target) {
	const args = ['compile', src, '-o', path.join(WORK, out)];
	if (target) args.push('--target', target);
	try {
		execFileSync(CLN, args, { cwd: path.dirname(src), stdio: 'pipe' });
	} catch (err) {
		throw new Error('compile failed: ' + src + '\n' + String(err.stdout || '') + String(err.stderr || ''));
	}
	return fs.readFileSync(path.join(WORK, out));
}

// Run a server-target module whose start: prints markup. Only print/printl
// do anything; every other import is inert. Returns the printed text.
function runPrinter(bytes) {
	const mod = new WebAssembly.Module(bytes);
	let inst;
	let out = '';
	const imports = {};
	for (const imp of WebAssembly.Module.imports(mod)) {
		imports[imp.module] = imports[imp.module] || {};
		imports[imp.module][imp.name] = (...a) => {
			if (imp.name === 'print' || imp.name === 'printl') {
				out += new TextDecoder().decode(new Uint8Array(inst.exports.memory.buffer, a[0], a[1]));
				if (imp.name === 'printl') out += '\n';
			}
			return 0;
		};
	}
	inst = new WebAssembly.Instance(mod, imports);
	inst.exports._start();
	return out.trim();
}

// Load runtime/loader.js against `bodyHtml` with `wasmBytes` served as the
// frontend module. Resolves once _start() has run.
async function boot(bodyHtml, wasmBytes) {
	const win = createWindow(bodyHtml);
	const doc = win.document;
	const script = doc.createElement('script');
	script.setAttribute('data-wasm', 'frontend.wasm');
	doc.currentScript = script;
	const logs = { error: [], warn: [], log: [] };
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
		fetch: async () => ({ ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) }),
		WebAssembly,
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
	win.__cleanRuntime = undefined;
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(LOADER, 'utf8'), sandbox, { filename: 'loader.js' });
	for (let i = 0; i < 200; i++) {
		if (win.__cleanRuntime && win.__cleanRuntime.getInstance) break;
		await new Promise(r => setTimeout(r, 5));
	}
	if (!(win.__cleanRuntime && win.__cleanRuntime.getInstance)) {
		throw new Error('loader did not finish: ' + logs.error.join('\n'));
	}
	await settle();
	return { win, doc, logs };
}

const settle = () => new Promise(r => setTimeout(r, 0));

const click = (el) => {
	const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
	el.dispatchEvent(ev);
	return ev;
};
const key = (el, k) => {
	const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k });
	el.dispatchEvent(ev);
	return ev;
};

// ---------------------------------------------------------------------------

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

async function main() {
	const fixtures = path.join(HERE, 'fixtures');
	const pageHtml = runPrinter(compile(path.join(fixtures, 'event_dispatch_page.cln'), 'page.wasm'));
	const frontend = compile(path.join(fixtures, 'event_dispatch.cln'), 'frontend.wasm', 'browser');

	console.log('event dispatch (UI-B006 / UI-B007):');

	await test('page-mode markup carries data-on-* markers', async () => {
		if (!pageHtml.includes("data-on-click='topClick'")) throw new Error('unexpected page markup: ' + pageHtml);
	});

	const { doc, logs } = await boot('<div id="app">' + pageHtml + '</div>', frontend);
	const log = () => doc.querySelector('#log').textContent;
	const reset = () => { logs.error.length = 0; };

	await test('data-on-click dispatches the exported handler; ui.eventAttr reads the element', async () => {
		click(doc.querySelector('#b1'));
		eq(log(), 'topClick:42;', '#log');
	});

	await test('.prevent cancels the default action of submit', async () => {
		const before = log();
		const ev = new Event('submit', { bubbles: true, cancelable: true });
		doc.querySelector('#f1').dispatchEvent(ev);
		eq(log(), before + 'saveForm;', '#log');
		eq(ev.defaultPrevented, true, 'defaultPrevented');
	});

	await test('a click inside a form without a handler does not dispatch the form handler', async () => {
		const before = log();
		click(doc.querySelector('#b2'));
		eq(log(), before, '#log');
	});

	await test('handlers on ancestors run in bubbling order', async () => {
		const before = log();
		click(doc.querySelector('#b4'));
		eq(log(), before + 'innerClick;outerClick;', '#log');
	});

	await test('.stop stops the event before ancestor handlers', async () => {
		const before = log();
		click(doc.querySelector('#b3'));
		eq(log(), before + 'innerClick;', '#log');
	});

	await test('several modifiers (onclick.stop.prevent) all apply', async () => {
		const before = log();
		const ev = click(doc.querySelector('#b6'));
		eq(log(), before + 'innerClick;', '#log');
		eq(ev.defaultPrevented, true, 'defaultPrevented');
	});

	await test('.once dispatches a single time', async () => {
		const before = log();
		click(doc.querySelector('#b5'));
		click(doc.querySelector('#b5'));
		eq(log(), before + 'onceClick;', '#log');
	});

	await test('.enter filters keydown by key', async () => {
		const before = log();
		key(doc.querySelector('#i1'), 'a');
		eq(log(), before, '#log after "a"');
		key(doc.querySelector('#i1'), 'Enter');
		eq(log(), before + 'enterKey;', '#log after Enter');
	});

	await test('non-bubbling events (focus) dispatch on their own element', async () => {
		const before = log();
		doc.querySelector('#i2').dispatchEvent(new Event('focus', { bubbles: false }));
		eq(log(), before + 'focused;', '#log');
	});

	await test('a missing handler export is reported to the console when the event fires', async () => {
		reset();
		click(doc.querySelector('#b7'));
		const msg = logs.error.find(m => m.includes('doesNotExist'));
		if (!msg) throw new Error('no console error naming doesNotExist; got ' + JSON.stringify(logs.error));
	});

	await test('onclick="name" from an html: block is taken over by the runtime (no inline handler left)', async () => {
		const btn = doc.querySelector('#inc');
		if (!btn) throw new Error('screen markup was not rendered');
		eq(btn.getAttribute('onclick'), null, 'inline onclick attribute');
	});

	await test('a screen handler resolves to the screen-scoped export (Counter.increment)', async () => {
		click(doc.querySelector('#inc'));
		click(doc.querySelector('#inc'));
		eq(doc.querySelector('#count').textContent, '2', '#count');
	});

	await test('onkeydown.escape from an html: block filters by key', async () => {
		key(doc.querySelector('#esc'), 'Enter');
		eq(doc.querySelector('#count').textContent, '2', '#count after Enter');
		key(doc.querySelector('#esc'), 'Escape');
		eq(doc.querySelector('#count').textContent, 'esc', '#count after Escape');
	});

	await test('markup inserted after load is dispatched (delegation)', async () => {
		const host = doc.createElement('div');
		doc.body.appendChild(host);
		host.innerHTML = '<button id="dyn" data-id="7" onclick="topClick">d</button><button id="dyn2" data-id="8" data-on-click="topClick">e</button>';
		await settle();
		const before = log();
		click(doc.querySelector('#dyn'));
		click(doc.querySelector('#dyn2'));
		eq(log(), before + 'topClick:7;topClick:8;', '#log');
	});

	console.log('examples/browser-counter (ui.onEvent):');
	const counterHtml = fs.readFileSync(path.join(FRAMEWORK_ROOT, 'examples', 'browser-counter', 'index.html'), 'utf8');
	const body = counterHtml.slice(counterHtml.indexOf('<body>') + 6, counterHtml.indexOf('<script'));
	const counterWasm = compile(path.join(FRAMEWORK_ROOT, 'examples', 'browser-counter', 'main.cln'), 'counter.wasm', 'browser');
	const counter = await boot(body, counterWasm);

	await test('increment / decrement / reset handlers dispatch', async () => {
		const d = counter.doc;
		click(d.querySelector('.btn-increment'));
		click(d.querySelector('.btn-increment'));
		click(d.querySelector('.btn-increment'));
		click(d.querySelector('.btn-decrement'));
		eq(d.querySelector('#count-value').textContent, '2', '#count-value');
		eq(d.querySelector('#clicks-value').textContent, '4', '#clicks-value');
		click(d.querySelector('.btn-reset'));
		eq(d.querySelector('#count-value').textContent, '0', '#count-value after reset');
		click(d.querySelector('.btn-theme'));
		eq(d.querySelector('.dashboard').classList.contains('light'), true, '.dashboard.light');
		eq(counter.logs.error.length, 0, 'console errors (' + counter.logs.error.join(' | ') + ')');
	});

	fs.rmSync(WORK, { recursive: true, force: true });
	console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
	if (failures.length) process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
