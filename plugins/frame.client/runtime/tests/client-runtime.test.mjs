/**
 * client-runtime.test.mjs — frame.client's load: / form: / send: blocks and
 * its browser bridges (runtime/bridge.js), end to end in the browser runtime.
 *
 * Each fixture (fixtures/client_*.cln) is compiled for the browser with the
 * installed plugins; frame.ui's runtime/loader.js and this plugin's
 * runtime/bridge.js are loaded, in the page order (loader first), into a
 * minimal DOM (frame.ui/scripts/lib/dom_shim.mjs). fetch is answered from a
 * table and every request is recorded, so the tests read the URL and body
 * the generated code sends and the state its callbacks see.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS = path.resolve(HERE, '..', '..', '..');
const { createWindow, Event, CustomEvent, MutationObserver } = await import(path.join(PLUGINS, 'frame.ui', 'scripts', 'lib', 'dom_shim.mjs'));
const LOADER = path.join(PLUGINS, 'frame.ui', 'runtime', 'loader.js');
const BRIDGE = path.join(HERE, '..', 'bridge.js');
const CLN = process.env.CLEEN_CLN || path.join(os.homedir(), '.cleen', 'bin', 'cln');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-client-runtime-'));

function compile(name) {
	const out = path.join(WORK, name + '.wasm');
	try {
		execFileSync(CLN, ['compile', path.join(HERE, 'fixtures', name + '.cln'), '-o', out, '--target', 'browser'], { cwd: WORK, stdio: 'pipe' });
	} catch (err) {
		throw new Error('compile failed: ' + name + '\n' + String(err.stdout || '') + String(err.stderr || ''));
	}
	return fs.readFileSync(out);
}

class TestFile {
	constructor(name) { this.name = name; }
}

// FormData over the shim's form controls: [name, value] in document order,
// a file input contributing the File objects in its `files`.
class ShimFormData {
	constructor(form) {
		this.entries = [];
		for (const el of form.querySelectorAll('[name]')) {
			const name = el.getAttribute('name');
			if (el.getAttribute('type') === 'file') {
				for (const f of el.files || []) this.entries.push([name, f]);
			} else {
				this.entries.push([name, el.value]);
			}
		}
	}
	forEach(fn) { for (const [k, v] of this.entries) fn(v, k); }
}

async function boot(bodyHtml, wasmBytes, responses) {
	const win = createWindow(bodyHtml);
	const doc = win.document;
	const script = doc.createElement('script');
	script.setAttribute('data-wasm', 'frontend.wasm');
	doc.currentScript = script;
	const errors = [];
	const requests = [];
	const sandbox = {
		window: win,
		document: doc,
		console: { error: (...a) => errors.push(a.map(String).join(' ')), warn: () => {}, log: () => {}, info: () => {}, debug: () => {} },
		fetch: async (url, init) => {
			if (url === 'frontend.wasm') {
				return { ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) };
			}
			requests.push({ url, method: init && init.method, body: init && init.body, headers: (init && init.headers) || {} });
			const r = responses[url] || { status: 404, body: '{"error":"not found"}' };
			return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body, headers: new Map([['content-type', 'application/json']]) };
		},
		FormData: ShimFormData,
		File: TestFile,
		AbortController,
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
	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(LOADER, 'utf8'), sandbox, { filename: 'loader.js' });
	vm.runInContext(fs.readFileSync(BRIDGE, 'utf8'), sandbox, { filename: 'frame-client.js' });
	for (let i = 0; i < 200 && !(win.__cleanRuntime && win.__cleanRuntime.getInstance); i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	if (!(win.__cleanRuntime && win.__cleanRuntime.getInstance)) throw new Error('loader did not finish: ' + errors.join('\n'));
	await wait(20);
	return { win, doc, errors, requests, exports: win.__cleanRuntime.getInstance().exports };
}

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
const text = (doc, sel) => doc.querySelector(sel).textContent;

async function main() {
	console.log('frame.client runtime:');

	await test('form: the JSON body escapes field values; "~" / "|" / "required" in a default stay text', async () => {
		const { doc, requests } = await boot('<div id="out"></div>', compile('client_form'), { '/api/tasks': { status: 201, body: '{}' } });
		eq(requests.length, 1, 'requests');
		const sent = JSON.parse(requests[0].body);
		eq(sent.title, 'Say "hi" \\ bye', 'title');
		eq(sent.note, 'a~b|c (not required)', 'note');
		eq(Object.keys(sent).join(','), 'title,note', 'body keys');
		// emit "clearCache" is a callback, not the clear action: fields keep
		// their values; the callback runs with submitting already false.
		eq(text(doc, '#out'), 'ok=Saved submitting=false title=[Say "hi" \\ bye] note=[a~b|c (not required)]', '#out');
	});

	await test('form: only the `required` word makes a field required; `clear` resets fields', async () => {
		const { doc, requests } = await boot('<div id="out"></div>', compile('client_form_clear'), { '/api/notes': { status: 200, body: '{}' } });
		eq(requests.length, 1, 'requests (an empty optional field must not block the submit)');
		eq(requests[0].body, '{"note":"","body":"text"}', 'body');
		eq(text(doc, '#out'), 'note=[not required] body=[] err=[]', '#out');
	});

	await test('send: {placeholder} values are URL-encoded; with: values are JSON-escaped', async () => {
		const { requests } = await boot('<div id="out"></div>', compile('client_send'), { '/api/users/..%2Fadmin%3Fx%3D1': { status: 200, body: '{}' } });
		eq(requests.length, 1, 'requests (the second call waits for the pending one)');
		eq(requests[0].url, '/api/users/..%2Fadmin%3Fx%3D1', 'url');
		eq(requests[0].method, 'PATCH', 'method');
		eq(requests[0].body, '{"name":"N\\"q"}', 'body');
	});

	await test('send: callbacks run after <name>Pending is cleared (success and error)', async () => {
		const ok = await boot('<div id="out"></div>', compile('client_send'), { '/api/users/..%2Fadmin%3Fx%3D1': { status: 200, body: '{}' } });
		eq(text(ok.doc, '#out'), 'done pending=false ok=true', 'success callback');
		const bad = await boot('<div id="out"></div>', compile('client_send'), { '/api/users/..%2Fadmin%3Fx%3D1': { status: 409, body: '{"error":"taken"}' } });
		eq(text(bad.doc, '#out'), 'failed pending=false err=taken', 'error callback');
	});

	await test('a response callback that fails runs once and is reported', async () => {
		const { doc, errors } = await boot('<div id="out"></div>', compile('client_send_throw'), { '/api/ping': { status: 200, body: '{}' } });
		eq(text(doc, '#out'), 'pinged;', '#out');
		if (!errors.some((e) => e.includes('failed'))) throw new Error('failure not reported: ' + errors.join(' | '));
	});

	await test('load: compiles and loads every source in order; at path, loadError and on error', async () => {
		const { doc, requests, exports } = await boot('<div id="out"></div><div id="out2"></div>', compile('client_load'), {
			'/api/user': { status: 200, body: '{"name":"Ann"}' },
			'/api/stats': { status: 500, body: '{}' },
		});
		eq(requests.map((r) => r.method + ' ' + r.url).join(','), 'GET /api/user,GET /api/stats', 'requests');
		exports.show();
		eq(text(doc, '#out'), 'loading=false err=Failed to load stats user=Ann', '#out');
		eq(text(doc, '#out2'), 'stats failed', 'on error handler');
	});

	await test('api.submit: repeated fields become an array; a file is sent as form data', async () => {
		const page = '<form id="f"><input name="tag" value="a"><input name="tag" value="b"><input name="title" value="t"><input id="file" type="file" name="doc"></form><div id="out"></div>';
		const json = await boot(page, compile('client_submit'), { '/api/submit': { status: 200, body: '{}' } });
		json.exports.sendForm();
		await wait(20);
		eq(json.requests[0].body, '{"tag":["a","b"],"title":"t"}', 'JSON body');
		eq(json.requests[0].headers['Content-Type'], 'application/json', 'JSON content type');
		eq(text(json.doc, '#out'), 'status=200', '#out');

		const multi = await boot(page, compile('client_submit'), { '/api/submit': { status: 200, body: '{}' } });
		multi.doc.querySelector('#file').files = [new TestFile('report.pdf')];
		multi.exports.sendForm();
		await wait(20);
		const body = multi.requests[0].body;
		if (!(body instanceof ShimFormData)) throw new Error('expected a FormData body, got ' + JSON.stringify(body));
		eq(multi.requests[0].headers['Content-Type'], undefined, 'multipart content type left to the browser');
	});

	console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
	fs.rmSync(WORK, { recursive: true, force: true });
	process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
