#!/usr/bin/env node
// Layer 2 canary runner (framework/browser).
//
// Reads the compiler's canary corpus, compiles each browser-applicable
// canary to WASM with the old-toolchain compiler ($CLEEN_CLN, else
// ~/.cleen/bin/cln — never a bare `cln` from PATH), instantiates the module in
// headless Chromium via Playwright using frame.ui's own runtime loader,
// captures console output, and diffs against the canary's expected block.
//
// See: umbrella prompt 7fb425cb-79ba-11f1-9586-da25a95a496b (Layer 2, framework).
//
// Fails LOUDLY on:
//   - LinkError at instantiation
//   - Runtime trap
//   - stdout diff
//   - Missing / uncompilable canary
//
// Usage:
//   node run_canaries.mjs                 # run against local compiler checkout
//   CANARY_DIR=/path/to/canaries \        # or override
//     node run_canaries.mjs
//   node run_canaries.mjs --json          # emit machine-readable report
//   node run_canaries.mjs --filter=ui     # only run canaries whose namespace contains "ui"

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_DIR = resolve(__dirname, '..');
const PLUGINS_DIR = resolve(PLUGIN_DIR, '..');
const RUNTIME_LOADER = join(PLUGIN_DIR, 'runtime', 'loader.js');
// The compiler: $CLEEN_CLN, else ~/.cleen/bin/cln. A bare `cln` on PATH may
// belong to a different toolchain.
const CLN = process.env.CLEEN_CLN || join(homedir(), '.cleen', 'bin', 'cln');
const CLIENT_BRIDGE = join(PLUGINS_DIR, 'frame.client', 'runtime', 'bridge.js');

// Layer-2 portable + browser-only canary namespaces (per Layer 1 handoff).
// Server-only namespaces are filtered out.
const APPLICABLE = new Set([
	'console',
	'crypto',
	'math',
	'json',
	'time',
	'http_client',
	'ui',
	'canvas',
	'api',
	'storage',
]);

// Canaries deliberately skipped pending integration work outside this runner.
// canvas needs (a) frame.canvas's memory-decl parser updated to accept the
// new JSON-encoded clean:memory custom section (was ULEB128), and (b) either
// memory_runtime import wiring inside frame.canvas or a canvas bridge that
// composes cleanly with frame.ui's loader. Neither is fixable inside the
// canary runner itself.
const SKIP_WITH_REASON = new Map([
	[
		'canvas',
		'frame.canvas loader needs clean:memory JSON parser update and memory_runtime wiring; tracked in TASKS.md',
	],
]);

// Namespaces the browser deliberately does not honor at runtime (server-only
// under Layer 2 semantics). Compiled but expected to trap if actually invoked;
// canaries for these should be filtered out entirely.
const SERVER_ONLY = new Set([
	'file',
	'file_io',
	'db',
	'database',
	'session',
	'auth',
	'router',
	'email',
	'env', // env.get is a browser stub, but the canary's expected output matches on both sides
]);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const filter = (args.find((a) => a.startsWith('--filter=')) || '').slice('--filter='.length);
const canaryDirOverride = process.env.CANARY_DIR;

// ---------------------------------------------------------------------------
// Canary discovery + parsing

function parseCanaryHeader(source) {
	// Namespace: <name> [(Layer X, <hosts>)]
	// The parenthetical may span multiple lines (canvas canary's namespace
	// list runs across four comment lines). We only care about the first
	// token before the parenthesis or line break — that's the primary
	// namespace used for host-applicability filtering.
	const nsMatch = source.match(/^\/\/\s*Namespace:\s*([A-Za-z_][A-Za-z0-9_]*)/m);
	const namespace = nsMatch ? nsMatch[1].trim() : null;
	const layerMatch = source.match(/\(Layer\s+([^)]+)\)/);
	const layerLine = layerMatch ? layerMatch[1].trim() : '';

	// Expected output block — contiguous "//   <line>" following "// Expected output:"
	const expected = [];
	const lines = source.split('\n');
	let inBlock = false;
	for (const raw of lines) {
		if (!inBlock) {
			if (/^\/\/\s*Expected output:/.test(raw)) {
				inBlock = true;
				continue;
			}
			continue;
		}
		// Match "//   <text>" — two-space or greater indent after //.
		// A "// " with a single space (or a bare comment) or a non-comment line
		// terminates the block.
		const m = raw.match(/^\/\/(\s{2,})(.*)$/);
		if (m) {
			expected.push(m[2].replace(/\s+$/, ''));
		} else {
			break;
		}
	}
	return { namespace, layerLine, expected };
}

function isApplicable(namespace) {
	if (!namespace) return false;
	// Accept namespace tokens like "canvas + camera + scene + ..." — check the
	// primary (first) name only.
	const primary = namespace.split(/[\s+]/)[0].toLowerCase();
	if (SERVER_ONLY.has(primary)) return false;
	if (SKIP_WITH_REASON.has(primary)) return false;
	return APPLICABLE.has(primary);
}

async function discoverCanaries(canaryDir) {
	const entries = await readdir(canaryDir);
	const out = [];
	for (const name of entries) {
		if (extname(name) !== '.cln') continue;
		const full = join(canaryDir, name);
		const source = await readFile(full, 'utf8');
		const { namespace, layerLine, expected } = parseCanaryHeader(source);
		out.push({ file: full, name, namespace, layerLine, expected });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Compilation

function runCln(args, cwd) {
	return new Promise((resolvePromise, reject) => {
		const proc = spawn(CLN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => (stdout += d.toString()));
		proc.stderr.on('data', (d) => (stderr += d.toString()));
		proc.on('error', reject);
		proc.on('close', (code) => {
			resolvePromise({ code, stdout, stderr });
		});
	});
}

async function compileCanary(canaryPath, outWasm) {
	// --plugins enables bridge resolution against ~/.cleen/plugins/. Without it,
	// canaries whose namespaces are plugin-backed (ui, canvas, storage, etc.)
	// compile with unresolved bridge stubs and LinkError at instantiation.
	const { code, stdout, stderr } = await runCln(
		['compile', canaryPath, '-o', outWasm, '--plugins', '--target', 'browser'],
		process.cwd()
	);
	if (code !== 0) {
		throw new Error(
			`cln compile failed (exit ${code}) for ${canaryPath}\n` +
				`stdout:\n${stdout}\nstderr:\n${stderr}`
		);
	}
}

// ---------------------------------------------------------------------------
// Static server for Chromium

function startStaticServer(rootDir) {
	return new Promise((resolvePromise) => {
		const server = createServer(async (req, res) => {
			try {
				const urlPath = (req.url || '/').split('?')[0];
				const filePath = join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
				if (!filePath.startsWith(rootDir)) {
					res.writeHead(403).end('forbidden');
					return;
				}
				const buf = await readFile(filePath);
				const ext = extname(filePath);
				const type =
					ext === '.html'
						? 'text/html; charset=utf-8'
						: ext === '.js' || ext === '.mjs'
							? 'application/javascript'
							: ext === '.wasm'
								? 'application/wasm'
								: 'application/octet-stream';
				res.writeHead(200, { 'content-type': type });
				res.end(buf);
			} catch (err) {
				res.writeHead(404).end(`not found: ${req.url}`);
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolvePromise({ server, port });
		});
	});
}

// ---------------------------------------------------------------------------
// Runner

async function runOne({ canary, runDir, browser, keepArtifacts }) {
	const workDir = join(runDir, canary.name.replace(/\.cln$/, ''));
	await mkdir(workDir, { recursive: true });
	const wasmPath = join(workDir, 'canary.wasm');

	await compileCanary(canary.file, wasmPath);

	// Namespace-based loader dispatch.
	// - api: bridges live in frame.client/runtime/bridge.js. We use frame.ui
	//   as the host loader (all base env imports come from there) and layer
	//   bridge.js on top via __cleanRuntime.registerEnv().
	// - everything else: frame.ui's loader alone.
	const primary = (canary.namespace || '').split(/[\s+]/)[0].toLowerCase();

	const loaderSrc = await readFile(RUNTIME_LOADER, 'utf8');
	await writeFile(join(workDir, 'loader.js'), loaderSrc);
	let extraScripts = '';
	if (primary === 'api') {
		const bridgeSrc = await readFile(CLIENT_BRIDGE, 'utf8');
		await writeFile(join(workDir, 'client-bridge.js'), bridgeSrc);
		// frame.client/bridge.js expects window.__cleanRuntime to already
		// exist when it runs. frame.ui/loader.js sets it up synchronously
		// at IIFE entry (before its await fetch yields), so ordering
		// `loader.js` before `client-bridge.js` in the DOM guarantees the
		// bootstrap runs first; bridge.js then registers its env imports
		// via __cleanRuntime.registerEnv(), and loader.js's post-await
		// merge picks them up before WebAssembly.instantiate.
		extraScripts = `<script src="client-bridge.js"></script>`;
	}
	const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${canary.name}</title></head>
<body>
<script src="loader.js" data-wasm="canary.wasm"></script>
${extraScripts}
</body>
</html>`;
	await writeFile(join(workDir, 'index.html'), html);

	const { server, port } = await startStaticServer(workDir);
	const url = `http://127.0.0.1:${port}/`;

	const stdout = [];
	const errors = [];
	const pageErrors = [];

	const context = await browser.newContext();
	const page = await context.newPage();

	// Capture all console.log — that's where env.print* land in the loader.
	// Errors get split two ways: the loader logs `Frame UI Loader Error: <err>`
	// via console.error when WebAssembly.instantiate throws (LinkError, trap,
	// missing import), which never surfaces as a pageerror event. We treat
	// any such console.error as a fatal trap so canaries with missing
	// browser bridge functions fail LOUDLY instead of just showing "diff".
	page.on('console', (msg) => {
		const type = msg.type();
		const text = msg.text();
		// Filter out loader-emitted diagnostic prefixes so only genuine
		// canary output (printl → console.log without a bracketed prefix)
		// is diffed against the expected block.
		const isLoaderDiagnostic = /^\[(CleanCanvas|clean|Clean|frame\.[a-z]+|FrameUI)\]/i.test(text);
		if (type === 'log') {
			if (isLoaderDiagnostic) {
				errors.push('[loader-log] ' + text);
			} else {
				stdout.push(text);
			}
		} else if (type === 'error') {
			errors.push(text);
			if (
				/Frame UI Loader Error/.test(text) ||
				/LinkError/.test(text) ||
				/WebAssembly\.instantiate/.test(text)
			) {
				pageErrors.push(text);
			}
		} else if (type === 'warning') {
			// The loader emits warnings for browser-only stubs (e.g. missing
			// contextual state) — ignore for the diff, but keep for the report.
			errors.push('[warn] ' + text);
		}
	});
	// Runtime exceptions (throws inside _start that escape the loader's
	// try/catch, uncaught async rejections) surface as pageerror events.
	page.on('pageerror', (err) => {
		pageErrors.push(err.message || String(err));
	});

	let navError = null;
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
		// _start runs synchronously after loader.js finishes fetching + instantiating
		// the WASM. Give the async chain a moment to flush before we snapshot output.
		await page.waitForTimeout(300);
	} catch (err) {
		navError = err.message || String(err);
	} finally {
		await context.close();
		await new Promise((r) => server.close(r));
	}

	if (!keepArtifacts) {
		try {
			await rm(workDir, { recursive: true, force: true });
		} catch (_) {
			// Best-effort cleanup.
		}
	}

	const actual = stdout.map((l) => l.replace(/\s+$/, ''));
	const expected = canary.expected.map((l) => l.replace(/\s+$/, ''));
	const diff = diffLines(expected, actual);

	const status =
		navError || pageErrors.length > 0
			? 'trap'
			: diff.length === 0
				? 'pass'
				: 'diff';

	return {
		canary: canary.name,
		namespace: canary.namespace,
		status,
		expected,
		actual,
		diff,
		pageErrors,
		navError,
		errors,
	};
}

function diffLines(expected, actual) {
	const diffs = [];
	const max = Math.max(expected.length, actual.length);
	for (let i = 0; i < max; i++) {
		const e = expected[i];
		const a = actual[i];
		if (e === undefined) {
			diffs.push({ line: i + 1, expected: null, actual: a });
		} else if (a === undefined) {
			diffs.push({ line: i + 1, expected: e, actual: null });
		} else if (e !== a) {
			diffs.push({ line: i + 1, expected: e, actual: a });
		}
	}
	return diffs;
}

// ---------------------------------------------------------------------------
// Entry point

async function locateCanaryDir() {
	if (canaryDirOverride) {
		if (!existsSync(canaryDirOverride)) {
			throw new Error(`CANARY_DIR does not exist: ${canaryDirOverride}`);
		}
		return canaryDirOverride;
	}
	// Sibling checkout: ../../clean-language-compiler/tests/cln/canaries
	const guesses = [
		resolve(PLUGIN_DIR, '..', '..', '..', 'clean-language-compiler', 'tests', 'cln', 'canaries'),
		resolve(PLUGIN_DIR, '..', '..', 'clean-language-compiler', 'tests', 'cln', 'canaries'),
	];
	for (const g of guesses) {
		if (existsSync(g)) return g;
	}
	throw new Error(
		'Could not locate canary corpus. Set CANARY_DIR to the path of ' +
			'clean-language-compiler/tests/cln/canaries.'
	);
}

async function main() {
	const canaryDir = await locateCanaryDir();
	if (!asJson) {
		console.error(`[canaries] corpus: ${canaryDir}`);
	}

	const all = await discoverCanaries(canaryDir);
	const applicable = all.filter((c) => isApplicable(c.namespace));
	const filtered = filter
		? applicable.filter((c) => c.namespace && c.namespace.includes(filter))
		: applicable;

	if (filtered.length === 0) {
		console.error('[canaries] no applicable canaries after filtering');
		process.exit(2);
	}

	if (!asJson) {
		console.error(
			`[canaries] running ${filtered.length} canaries ` +
				`(skipped ${all.length - applicable.length} server-only / non-portable)`
		);
	}

	const runDir = join(PLUGIN_DIR, '.canary-run');
	await mkdir(runDir, { recursive: true });

	const browser = await chromium.launch({ headless: true });

	const results = [];
	try {
		for (const canary of filtered) {
			if (!asJson) {
				process.stderr.write(`  ${canary.name.padEnd(20)} `);
			}
			let result;
			try {
				result = await runOne({
					canary,
					runDir,
					browser,
					keepArtifacts: process.env.CANARY_KEEP === '1',
				});
			} catch (err) {
				result = {
					canary: canary.name,
					namespace: canary.namespace,
					status: 'error',
					error: err.message || String(err),
				};
			}
			results.push(result);
			if (!asJson) {
				const symbol =
					result.status === 'pass'
						? 'PASS'
						: result.status === 'diff'
							? 'DIFF'
							: result.status === 'trap'
								? 'TRAP'
								: 'ERROR';
				process.stderr.write(`${symbol}\n`);
				if (result.status !== 'pass') {
					if (result.error) console.error(`      error: ${result.error}`);
					if (result.navError) console.error(`      nav error: ${result.navError}`);
					if (result.pageErrors && result.pageErrors.length) {
						for (const pe of result.pageErrors) {
							console.error(`      page error: ${pe}`);
						}
					}
					if (result.diff && result.diff.length) {
						console.error(`      expected:`);
						for (const line of result.expected) console.error(`        > ${line}`);
						console.error(`      actual:`);
						for (const line of result.actual) console.error(`        < ${line}`);
					}
				}
			}
		}
	} finally {
		await browser.close();
	}

	if (asJson) {
		process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
	}

	// Emit canary-report.json for the cross-repo L3 matrix aggregator.
	// Schema: { results: { <namespace>: { passed: bool, reason?: string } } }
	// See clean-language-compiler/scripts/canary_matrix.py.
	const reportResults = {};
	for (const r of results) {
		const key = (r.namespace || r.canary.replace(/\.cln$/, '')).split(/[\s+]/)[0].toLowerCase();
		const entry = { passed: r.status === 'pass' };
		if (!entry.passed) {
			const reason =
				r.error ||
				r.navError ||
				(r.pageErrors && r.pageErrors[0]) ||
				(r.status === 'diff' ? 'stdout diff' : r.status);
			if (reason) entry.reason = String(reason).slice(0, 500);
		}
		reportResults[key] = entry;
	}
	await writeFile(
		join(runDir, 'canary-report.json'),
		JSON.stringify({ results: reportResults }, null, 2) + '\n'
	);

	const failed = results.filter((r) => r.status !== 'pass');
	if (failed.length > 0) {
		if (!asJson) {
			console.error(`\n[canaries] ${failed.length} of ${results.length} FAILED`);
		}
		process.exit(1);
	}
	if (!asJson) {
		console.error(`\n[canaries] all ${results.length} passed`);
	}
}

main().catch((err) => {
	console.error(err.stack || err.message || err);
	process.exit(2);
});
