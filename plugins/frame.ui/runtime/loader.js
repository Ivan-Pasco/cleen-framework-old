// Frame UI Runtime Loader
// WASM loader with full browser API bridge
// Version: 2.7.0
// 2.7.0 (2026-11-04): time.* calendar bridges (stdlib-reference §12) —
//   _time_format, _time_relative, _time_parse, _time_parts, _time_add and
//   _time_diff on Unix SECONDS with IANA zones through Intl, matching
//   clean-server's results (cleanTime helpers).
// 2.6.0 (2026-11-04): declarative event attributes (UI-B006 / UI-B007) —
//   data-on-<event> markers (page mode) and on<event>="handler" attributes
//   (html: blocks, component / screen templates) dispatch to the named WASM
//   export through one document-level listener per event type, including
//   markup inserted after load. Modifiers .prevent .stop .once .passive
//   .enter .escape .space .left .right; screen-scoped exports
//   (Counter.increment) resolve inside a data-screen / data-component
//   wrapper; a missing export is a console error at dispatch time.
// 2.5.0 (2026-11-04): _json_get takes the compiler's (any, LP path) shape and
//   returns typed boxed-Any leaves (null-tag on a miss) — every json.get call
//   now lowers to this bridge (stdlib-reference §8). The boxed-Any read/write
//   logic of the _json_*_v2 bridges is shared (readBoxedAny / writeBoxedAny).
// 2.4.0 (2026-07-08): __cleanRuntime companion API — added a pre-instantiate
//   window.__cleanRuntime skeleton with registerEnv() so companion scripts
//   like frame.client/runtime/bridge.js can contribute env imports BEFORE
//   WebAssembly.instantiate. Post-instantiate wires getInstance/getMemory/
//   writeString/readString so companions can call back into the runtime.
//   Also stubbed http_set_timeout/max_redirects/enable_cookies/user_agent as
//   browser-side noops so any Clean http.* configuration call instantiates
//   cleanly. Layer 2 canary result: 7/9 pass (api.cln joins the previously
//   green set once frame.client/bridge.js runs alongside).
// 2.3.0 (2026-07-08): Layer 2 canary bridge fill-in — added math_*, _time_*,
//   http_encode_url/decode_url/build_query/get_response_*, _crypto_hash_sha256/
//   sha512/hmac/random_hex/random_bytes/hash_password/verify_password, and
//   _json_encode/decode/get bridges. Pure-JS SHA-256/512 helpers at IIFE top
//   (adapted from frame.canvas/runtime/loader.js).
//
// All interactivity uses _ui_on_event delegation + targeted DOM updates.
// WASM _start() registers handlers, handlers update DOM via bridge functions.

(async function() {
	const script = document.currentScript;
	const wasmPath = script.dataset.wasm || 'frontend.wasm';

	const WASM_PAGE_SIZE = 65536;

	// --- State ---
	let memory, instance;
	// --- Pre-instantiate __cleanRuntime bootstrap ---
	// Companion scripts like frame.client's runtime (frame-client.js), placed
	// after this script, need a synchronous registerEnv() so they can
	// contribute bridge functions BEFORE WebAssembly.instantiate. We create
	// the skeleton here at IIFE start, wait for the document to finish
	// parsing below (so every companion has run), and merge whatever
	// _pendingEnv holds into the bridge object right before instantiating.
	// writeString / readString / getInstance are wired up below once memory +
	// instance exist.
	if (typeof window !== 'undefined' && !window.__cleanRuntime) {
		window.__cleanRuntime = {
			_pendingEnv: {},
			_providers: [],
			registerEnv(obj) {
				if (obj && typeof obj === 'object') {
					Object.assign(this._pendingEnv, obj);
				}
			},
			memoryStats() {
				const p = this._providers[this._providers.length - 1];
				return p ? p() : null;
			},
			// getInstance / writeString / readString are added after
			// WebAssembly.instantiate resolves — see below.
		};
	}
	// heapPtr MUST be initialized from the WASM module's __heap_ptr export.
	// See platform-architecture/MEMORY_POLICY.md §7.2.
	let heapPtr = -1;
	// scopeMarks — stack of heapPtr snapshots pushed by _arena_scope_push and
	// popped by _arena_scope_pop. Bracket-emitted by the compiler's dual-
	// accumulator loop rewrite (rewrite_dual_accumulator_loops); see the
	// bridge registration below and prompt 8ac2c282-7bbe-11f1 for the
	// contract.
	const scopeMarks = [];
	let currentEvent = null;
	let currentEventTarget = null;
	const componentRegistry = new Map();
	const slotStore = new Map();
	const stateStore = new Map();
	const registeredEventTypes = new Set();
	const eventHandlers = new Map(); // "selector\0eventType" -> [handlerIdx, ...]
	let loadedPages = null;            // lazy Map<path, html>


	// --- Memory observability (MEMORY_POLICY.md §9.3) ---

	const memStats = {
		maxPages: null,
		growCount: 0,
		lastBufferSize: 0,
	};

	function checkMemoryGrowth() {
		if (!memory) return;
		const size = memory.buffer.byteLength;
		if (size !== memStats.lastBufferSize) {
			const fromPages = memStats.lastBufferSize / WASM_PAGE_SIZE;
			const toPages = size / WASM_PAGE_SIZE;
			const fromMB = (memStats.lastBufferSize / (1024 * 1024)).toFixed(1);
			const toMB = (size / (1024 * 1024)).toFixed(1);
			console.warn(`[clean] Memory grew: ${fromPages} → ${toPages} pages (${fromMB} MB → ${toMB} MB)`);
			memStats.growCount++;
			memStats.lastBufferSize = size;
		}
	}

	// Ensure `memory.buffer` has at least `endOffset` bytes available. Called
	// from writeString before the write. Without this, a bump-allocated write
	// past the current buffer end causes a WASM-side "memory access out of
	// bounds" trap on the next read (fingerprint d2ad4501bae5 — arithmetic
	// combining two bridge-returned string .length() values).
	function ensureCapacity(endOffset) {
		if (!memory) return;
		const currentBytes = memory.buffer.byteLength;
		if (endOffset <= currentBytes) return;
		const currentPages = currentBytes / WASM_PAGE_SIZE;
		const neededPages = Math.ceil(endOffset / WASM_PAGE_SIZE);
		const growBy = neededPages - currentPages;
		// Grow with headroom (double the deficit, minimum 1 page) to avoid
		// grow-per-call in tight loops.
		const growPages = Math.max(growBy * 2, 1);
		try {
			memory.grow(growPages);
		} catch (e) {
			// Fall back to the minimum needed; if this also fails, the trap
			// message will identify the cause.
			memory.grow(growBy);
		}
		checkMemoryGrowth();
	}

	function memoryStats() {
		const size = memory ? memory.buffer.byteLength : 0;
		return {
			currentPages: size / WASM_PAGE_SIZE,
			currentBytes: size,
			maxPages: memStats.maxPages,
			growCount: memStats.growCount,
			heapPtr: currentHeapTop(),
		};
	}

	// --- WASM memory-section parsing (for maxPages) ---

	function readULEB128(bytes, ref) {
		let result = 0, shift = 0, byte;
		do {
			if (ref.offset >= bytes.length) throw new Error('ULEB128 truncated');
			byte = bytes[ref.offset++];
			result |= (byte & 0x7f) << shift;
			shift += 7;
			if (shift > 35) throw new Error('ULEB128 overflow');
		} while (byte & 0x80);
		return result >>> 0;
	}

	function parseMaxPages(wasmBuffer) {
		const bytes = new Uint8Array(wasmBuffer);
		if (bytes.length < 8) return null;
		if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
		const ref = { offset: 8 };
		while (ref.offset < bytes.length) {
			const sectionId = bytes[ref.offset++];
			const sectionSize = readULEB128(bytes, ref);
			const sectionEnd = ref.offset + sectionSize;
			try {
				if (sectionId === 5) {
					const count = readULEB128(bytes, ref);
					if (count > 0) {
						const flags = readULEB128(bytes, ref);
						readULEB128(bytes, ref); // initial
						if (flags & 0x01) return readULEB128(bytes, ref);
						return null;
					}
				}
			} catch (_) { /* fall through */ }
			ref.offset = sectionEnd;
		}
		return null;
	}

	// --- time.* (stdlib-reference §12) ---
	// Pure helpers behind the _time_format / _time_relative / _time_parse /
	// _time_parts / _time_add / _time_diff bridges. Timestamps are Unix SECONDS
	// (f64). A time zone is an IANA name ("" = the local zone; an unknown name
	// falls back to UTC). Results match clean-server's host bridge
	// (host-bridge/src/wasm_linker/env_time.rs).
	const cleanTime = (() => {
		const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
		const FIXED_UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
		const zoneFormats = new Map();

		// Intl formatter for an IANA zone, or null when the zone is unknown.
		function zoneFormat(zone) {
			if (!zoneFormats.has(zone)) {
				let fmt = null;
				try {
					fmt = new Intl.DateTimeFormat('en-US', {
						timeZone: zone, hourCycle: 'h23', weekday: 'short',
						year: 'numeric', month: 'numeric', day: 'numeric',
						hour: 'numeric', minute: 'numeric', second: 'numeric',
					});
				} catch (_) {
					fmt = null;
				}
				zoneFormats.set(zone, fmt);
			}
			return zoneFormats.get(zone);
		}

		// Calendar fields of `ts` in `tz`; null for a non-finite or out-of-range ts.
		function fields(ts, tz) {
			if (!Number.isFinite(ts)) return null;
			const d = new Date(Math.floor(ts) * 1000);
			if (Number.isNaN(d.getTime())) return null;
			const zone = String(tz || '').trim();
			if (zone === '') {
				return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() };
			}
			const fmt = zoneFormat(zone);
			if (!fmt) {
				return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() };
			}
			const p = {};
			for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
			return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS[p.weekday] };
		}

		const pad = (n, width) => String(n).padStart(width, '0');

		// time.format: tokens YYYY MM DD HH mm ss h A a; every other character
		// is copied. "" for a non-finite timestamp.
		function format(ts, pattern, tz) {
			const f = fields(ts, tz);
			if (!f) return '';
			const hour12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
			const pm = f.hour >= 12;
			const text = String(pattern);
			let out = '';
			let i = 0;
			while (i < text.length) {
				if (text.startsWith('YYYY', i)) { out += pad(f.year, 4); i += 4; }
				else if (text.startsWith('MM', i)) { out += pad(f.month, 2); i += 2; }
				else if (text.startsWith('DD', i)) { out += pad(f.day, 2); i += 2; }
				else if (text.startsWith('HH', i)) { out += pad(f.hour, 2); i += 2; }
				else if (text.startsWith('mm', i)) { out += pad(f.minute, 2); i += 2; }
				else if (text.startsWith('ss', i)) { out += pad(f.second, 2); i += 2; }
				else if (text[i] === 'h') { out += String(hour12); i += 1; }
				else if (text[i] === 'A') { out += pm ? 'PM' : 'AM'; i += 1; }
				else if (text[i] === 'a') { out += pm ? 'pm' : 'am'; i += 1; }
				else {
					const ch = String.fromCodePoint(text.codePointAt(i));
					out += ch;
					i += ch.length;
				}
			}
			return out;
		}

		function daysInMonth(year, month) {
			const d = new Date(0);
			d.setUTCFullYear(year, month, 0);
			return d.getUTCDate();
		}

		function validDate(year, month, day) {
			return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
		}

		// Unix seconds of a UTC calendar date-time (years below 100 included).
		function utcSeconds(year, month, day, hour, minute, second) {
			const d = new Date(0);
			d.setUTCFullYear(year, month - 1, day);
			d.setUTCHours(hour, minute, second, 0);
			return d.getTime() / 1000;
		}

		// time.parse: ISO 8601 to fractional Unix seconds; -1 when invalid.
		// RFC 3339 with an offset; a date-only string is UTC midnight; a
		// date-time without an offset is local time (-1 inside a DST gap).
		function parse(input) {
			const s = String(input).trim();
			let m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
			if (m) {
				const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
				if (!validDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return -1;
				let offset = 0;
				if (m[8] !== 'Z' && m[8] !== 'z') {
					const oh = Number(m[8].slice(1, 3));
					const om = Number(m[8].slice(4, 6));
					if (oh > 23 || om > 59) return -1;
					offset = (m[8][0] === '-' ? -1 : 1) * (oh * 3600 + om * 60);
				}
				return utcSeconds(y, mo, d, h, mi, sec) - offset + (m[7] ? Number('0' + m[7]) : 0);
			}
			m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
			if (m) {
				const [y, mo, d] = m.slice(1, 4).map(Number);
				return validDate(y, mo, d) ? utcSeconds(y, mo, d, 0, 0, 0) : -1;
			}
			m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(s);
			if (m) {
				const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
				const sec = m[6] ? Number(m[6]) : 0;
				if (!validDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return -1;
				const local = new Date(2000, 0, 1);
				local.setFullYear(y, mo - 1, d);
				local.setHours(h, mi, sec, 0);
				if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d ||
					local.getHours() !== h || local.getMinutes() !== mi) return -1;
				return local.getTime() / 1000 + (m[7] ? Number('0' + m[7]) : 0);
			}
			return -1;
		}

		// time.parts: calendar components of `ts` in `tz` as JSON.
		function parts(ts, tz) {
			const f = fields(ts, tz);
			if (!f) return '{}';
			return JSON.stringify({ year: f.year, month: f.month, day: f.day, hour: f.hour, minute: f.minute, second: f.second, dayOfWeek: f.weekday, timestamp: ts });
		}

		// `ts` moved by `months` calendar months (UTC), the day clamped to the
		// target month's last day (2026-01-31 + 1 month = 2026-02-28).
		function addMonths(ts, months) {
			if (!Number.isFinite(ts)) return NaN;
			const secs = Math.floor(ts);
			const nanos = Math.min(Math.round((ts - secs) * 1e9), 999999999);
			const d = new Date(secs * 1000);
			if (Number.isNaN(d.getTime())) return NaN;
			const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
			const year = Math.floor(total / 12);
			const month = total - year * 12 + 1;
			const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
			return utcSeconds(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) + nanos / 1e9;
		}

		// time.add: `ts` plus `amount` units; NaN for an unknown unit.
		function add(ts, amount, unit) {
			const u = String(unit).trim().toLowerCase();
			if (Object.prototype.hasOwnProperty.call(FIXED_UNITS, u)) return ts + amount * FIXED_UNITS[u];
			if (u === 'months') return addMonths(ts, amount);
			if (u === 'years') return addMonths(ts, amount * 12);
			return NaN;
		}

		// Calendar months from `from` to `to` (to >= from): whole months by
		// calendar stepping plus the elapsed share of the next month.
		function monthsBetween(from, to) {
			let whole = 0;
			while (addMonths(from, whole + 1) <= to) whole++;
			const start = addMonths(from, whole);
			const span = addMonths(from, whole + 1) - start;
			return whole + (span > 0 ? (to - start) / span : 0);
		}

		// time.diff: `to - from` in `unit`, fractional; NaN for an unknown unit.
		function diff(from, to, unit) {
			const u = String(unit).trim().toLowerCase();
			if (Object.prototype.hasOwnProperty.call(FIXED_UNITS, u)) return (to - from) / FIXED_UNITS[u];
			const months = () => (to >= from ? monthsBetween(from, to) : -monthsBetween(to, from));
			if (u === 'months') return months();
			if (u === 'years') return months() / 12;
			return NaN;
		}

		const RELATIVE_WORDS = {
			es: { now: 'ahora mismo', units: [['minuto', 'minutos'], ['hora', 'horas'], ['día', 'días'], ['mes', 'meses'], ['año', 'años']], past: (n, w) => `hace ${n} ${w}`, future: (n, w) => `dentro de ${n} ${w}` },
			fr: { now: "à l'instant", units: [['minute', 'minutes'], ['heure', 'heures'], ['jour', 'jours'], ['mois', 'mois'], ['an', 'ans']], past: (n, w) => `il y a ${n} ${w}`, future: (n, w) => `dans ${n} ${w}` },
			de: { now: 'gerade eben', units: [['Minute', 'Minuten'], ['Stunde', 'Stunden'], ['Tag', 'Tagen'], ['Monat', 'Monaten'], ['Jahr', 'Jahren']], past: (n, w) => `vor ${n} ${w}`, future: (n, w) => `in ${n} ${w}` },
			pt: { now: 'agora mesmo', units: [['minuto', 'minutos'], ['hora', 'horas'], ['dia', 'dias'], ['mês', 'meses'], ['ano', 'anos']], past: (n, w) => `há ${n} ${w}`, future: (n, w) => `em ${n} ${w}` },
			en: { now: 'just now', units: [['minute', 'minutes'], ['hour', 'hours'], ['day', 'days'], ['month', 'months'], ['year', 'years']], past: (n, w) => `${n} ${w} ago`, future: (n, w) => `in ${n} ${w}` },
		};

		// time.relative: wording of `ts` relative to `now` (Unix seconds), with
		// the common Intl.RelativeTimeFormat breakpoints. English, Spanish,
		// French, German and Portuguese are worded natively; other locales
		// use English.
		function relative(ts, now, locale) {
			const lang = String(locale || '').split(/[-_]/)[0].toLowerCase();
			const words = RELATIVE_WORDS[lang] || RELATIVE_WORDS.en;
			const delta = ts - now;
			const abs = Math.abs(delta);
			if (abs < 45) return words.now;
			let unit;
			let n;
			if (abs < 45 * 60) { unit = 0; n = Math.round(abs / 60); }
			else if (abs < 22 * 3600) { unit = 1; n = Math.round(abs / 3600); }
			else if (abs < 26 * 86400) { unit = 2; n = Math.round(abs / 86400); }
			else if (abs < 320 * 86400) { unit = 3; n = Math.round(abs / (30.4375 * 86400)); }
			else { unit = 4; n = Math.round(abs / (365.25 * 86400)); }
			if (!(n >= 1)) n = 1;
			const word = words.units[unit][n === 1 ? 0 : 1];
			return delta < 0 ? words.past(n, word) : words.future(n, word);
		}

		return { format, relative, parse, parts, add, diff };
	})();

	// --- Memory Helpers ---

	function readString(ptr, len) {
		checkMemoryGrowth();
		const bytes = new Uint8Array(memory.buffer, ptr, len);
		return new TextDecoder().decode(bytes);
	}

	// Read a length-prefixed byte buffer at handle and return a copy of the
	// payload as a Uint8Array. Required by binary-input bridges (e.g.
	// _crypto_sha256_bytes) that must not UTF-8 round-trip the payload.
	// Handle layout: [4-byte LE length][bytes]. The copy protects against
	// subsequent allocations that could grow / relocate memory.
	function readLPBytes(handle) {
		checkMemoryGrowth();
		const dv = new DataView(memory.buffer);
		const len = dv.getUint32(handle, true);
		return new Uint8Array(memory.buffer, handle + 4, len).slice();
	}

	// --- Host allocations (MEMORY_MODEL.md "Host → WASM") ---
	// The module and the host share one bump heap. Every host allocation goes
	// through the module's exported malloc when it has one (it advances
	// __heap_ptr and grows memory itself); otherwise the host bumps the
	// exported __heap_ptr global: it starts from the larger of its own offset
	// and __heap_ptr (the module may have allocated since) and writes the new
	// end back, so the module's next allocation starts past the host's bytes
	// (same contract as wasmtime_runner's allocate_string_in_memory).
	function heapGlobal() {
		return instance && instance.exports.__heap_ptr;
	}

	function currentHeapTop() {
		const g = heapGlobal();
		return g && g.value > heapPtr ? g.value : heapPtr;
	}

	function setHeapTop(top) {
		heapPtr = top;
		const g = heapGlobal();
		if (g) g.value = top;
	}

	function hostAlloc(size) {
		const exportsObj = instance && instance.exports;
		if (exportsObj && typeof exportsObj.malloc === 'function') {
			const p = exportsObj.malloc(size);
			if (!p) throw new Error('Frame UI: WASM malloc(' + size + ') failed (out of memory)');
			checkMemoryGrowth();
			heapPtr = currentHeapTop();
			return p;
		}
		const start = (currentHeapTop() + 7) & ~7;
		const end = start + ((size + 7) & ~7);
		ensureCapacity(end);
		setHeapTop(end);
		return start;
	}

	function writeString(str) {
		checkMemoryGrowth();
		const bytes = new TextEncoder().encode(str);
		// Allocate (and grow memory) BEFORE constructing views, so both the
		// length header and the payload land in valid buffer bytes.
		const ptr = hostAlloc(bytes.length + 4);
		new DataView(memory.buffer).setUint32(ptr, bytes.length, true);
		new Uint8Array(memory.buffer, ptr + 4, bytes.length).set(bytes);
		return ptr;
	}

	// --- Event Delegation ---

	// Call the module export `name` from an asynchronous callback (an event,
	// a timer, an observer, a clipboard promise, ...). A missing export or a
	// trap in the handler is reported on the console with the context it
	// came from; it never escapes into the caller's promise chain, so the
	// callback's own error path does not run for a handler failure. Returns
	// true when the handler ran to completion.
	function invokeExport(name, context, ...args) {
		const fn = instance && instance.exports[name];
		if (!fn) {
			console.error(
				'[frame.ui] ' + context + ' handler export "' + name +
				'" not found. Declare it as a top-level function in your Clean source.'
			);
			return false;
		}
		try {
			fn(...args);
			return true;
		} catch (err) {
			console.error('[frame.ui] ' + context + ' handler "' + name + '" failed: ' + (err && err.message ? err.message : String(err)));
			return false;
		}
	}

	// The element an event starts from: its target, or the target's parent
	// element when the target is a text node (the document and window have
	// no element to match against).
	function eventElement(e) {
		const t = e.target;
		if (!t) return null;
		if (t.nodeType === 1) return t;
		return t.parentElement || null;
	}

	// One document listener per (event type, passive). eventHandlers keys are
	// "selector\0type\0passive" and each listener runs only the handlers
	// registered with its own passive flag, so a type registered both ways
	// still runs every handler once.
	function ensureDocumentListener(eventType, passive) {
		const flag = passive ? 'passive' : '';
		const key = eventType + '\0' + flag;
		if (registeredEventTypes.has(key)) return;
		registeredEventTypes.add(key);

		const options = passive ? { passive: true } : false;
		document.addEventListener(eventType, (e) => {
			const origin = eventElement(e);
			if (!origin || typeof origin.closest !== 'function') return;
			for (const [hkey, handlers] of eventHandlers) {
				const parts = hkey.split('\0');
				const selector = parts[0];
				if (parts[1] !== eventType || parts[2] !== flag) continue;

				const target = origin.closest(selector);
				if (target) {
					handlers.forEach(handlerName => {
						currentEvent = e;
						currentEventTarget = target;
						try {
							invokeExport(handlerName, 'Event');
						} finally {
							currentEvent = null;
							currentEventTarget = null;
						}
					});
				}
			}
		}, options);
	}

	// --- Declarative event attributes (UI-B006 / UI-B007 / UI-B009) ---
	//
	// frame.ui writes an event attribute into the markup in one of two forms:
	//   page mode (page blocks, HTML entry pages):
	//     onclick.stop="save"  →  data-on-click='save' data-on-click-stop='true'
	//     (several modifiers arrive as one marker: data-on-click-stop.prevent)
	//   html: blocks, component and screen templates:
	//     onclick.stop="save"  →  kept as written
	// The runtime takes the written form over as data-on-* (so the browser
	// never treats the handler name as inline script) and dispatches every
	// data-on-<event> through one document-level listener per event type, so
	// markup inserted later needs no extra wiring. The handler is the export
	// named by the attribute; inside a screen / component wrapper the scoped
	// export (Counter.increment) is used when the plain name is not exported.
	// A name that resolves to nothing is a console error when the event fires.

	const DECLARATIVE_EVENT_TYPES = new Set([
		'click', 'input', 'change', 'submit', 'focus', 'blur',
		'keydown', 'keyup', 'keypress',
		'mouseover', 'mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'mousemove', 'contextmenu',
		'dragstart', 'dragend', 'dragenter', 'dragover', 'dragleave', 'drop',
		'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerenter', 'pointerleave',
		'wheel', 'scroll',
	]);
	// Listened for in the capture phase and dispatched on their target only.
	const NON_BUBBLING_EVENT_TYPES = new Set(['focus', 'blur', 'mouseenter', 'mouseleave', 'pointerenter', 'pointerleave', 'scroll']);
	const KEY_MODIFIERS = { enter: ['Enter'], escape: ['Escape', 'Esc'], space: [' ', 'Spacebar'] };
	const BUTTON_MODIFIERS = { left: 0, right: 2 };
	const KNOWN_MODIFIERS = new Set(['prevent', 'stop', 'once', 'passive', 'enter', 'escape', 'space', 'left', 'right']);
	const HANDLER_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
	const declarativeTypesSeen = new Set();
	const declarativeTypesListening = new Set();
	const warnedModifiers = new Set();
	let declarativeReady = false;

	function listenDeclarative(type) {
		declarativeTypesSeen.add(type);
		if (!declarativeReady || declarativeTypesListening.has(type)) return;
		declarativeTypesListening.add(type);
		document.addEventListener(type, dispatchDeclarativeEvent, NON_BUBBLING_EVENT_TYPES.has(type));
	}

	// Rewrite written event attributes on el to data-on-* and make sure the
	// event types el handles have a document listener.
	function normalizeElementEvents(el) {
		const attrs = el.attributes;
		if (!attrs) return;
		for (const attr of Array.from(attrs)) {
			const name = attr.name;
			if (name.startsWith('data-on-')) {
				const type = name.slice(8);
				if (DECLARATIVE_EVENT_TYPES.has(type)) listenDeclarative(type);
				continue;
			}
			if (!name.startsWith('on')) continue;
			const parts = name.split('.');
			const type = parts[0].slice(2);
			const handler = attr.value.trim();
			if (!DECLARATIVE_EVENT_TYPES.has(type) || !HANDLER_NAME.test(handler)) continue;
			el.removeAttribute(name);
			el.setAttribute('data-on-' + type, handler);
			for (const modifier of parts.slice(1)) {
				if (modifier) el.setAttribute('data-on-' + type + '-' + modifier, 'true');
			}
			listenDeclarative(type);
		}
	}

	function normalizeEventAttributes(root) {
		if (!root) return;
		if (root.nodeType === 1) normalizeElementEvents(root);
		if (root.querySelectorAll) root.querySelectorAll('*').forEach(normalizeElementEvents);
	}

	// Modifiers of el's data-on-<type> handler: every data-on-<type>-<suffix>
	// marker whose value is not "false"; a suffix may hold several
	// dot-separated modifiers.
	function eventModifiers(el, type) {
		const prefix = 'data-on-' + type + '-';
		const modifiers = new Set();
		for (const attr of Array.from(el.attributes)) {
			if (!attr.name.startsWith(prefix) || attr.value === 'false') continue;
			for (const m of attr.name.slice(prefix.length).split('.')) {
				if (m) modifiers.add(m);
			}
		}
		return modifiers;
	}

	// Key (.enter/.escape/.space) and button (.left/.right) modifiers filter
	// which events reach the handler.
	function modifiersAccept(e, modifiers) {
		const keys = [];
		const buttons = [];
		for (const m of modifiers) {
			if (KEY_MODIFIERS[m]) keys.push(...KEY_MODIFIERS[m]);
			else if (m in BUTTON_MODIFIERS) buttons.push(BUTTON_MODIFIERS[m]);
			else if (!KNOWN_MODIFIERS.has(m) && !warnedModifiers.has(m)) {
				warnedModifiers.add(m);
				console.warn('[frame.ui] Unknown event modifier ".' + m + '" ignored. Valid modifiers: .' + Array.from(KNOWN_MODIFIERS).join(', .'));
			}
		}
		if (keys.length && !keys.includes(e.key)) return false;
		if (buttons.length && !buttons.includes(e.button)) return false;
		return true;
	}

	function removeDeclarativeHandler(el, type) {
		const prefix = 'data-on-' + type + '-';
		for (const attr of Array.from(el.attributes)) {
			if (attr.name === 'data-on-' + type || attr.name.startsWith(prefix)) el.removeAttribute(attr.name);
		}
	}

	// The export a handler name refers to from el: the plain export, else the
	// export scoped by the nearest enclosing screen / component wrapper.
	function resolveHandler(name, el) {
		const exports = instance.exports;
		if (typeof exports[name] === 'function') return exports[name];
		for (let cursor = el; cursor && cursor.nodeType === 1; cursor = cursor.parentElement) {
			const scope = cursor.getAttribute('data-screen') || cursor.getAttribute('data-component');
			if (scope && typeof exports[scope + '.' + name] === 'function') return exports[scope + '.' + name];
		}
		return null;
	}

	function invokeDeclarativeHandler(name, el, e) {
		const fn = resolveHandler(name, el);
		if (!fn) {
			console.error(
				'[frame.ui] Event handler export "' + name + '" (data-on-' + e.type +
				') not found. Declare it as a top-level function in your Clean source.'
			);
			return;
		}
		if (fn.length > 0) {
			console.error(
				'[frame.ui] Event handler "' + name + '" takes parameters. Event handlers take none — ' +
				'read event data with ui.eventValue() / ui.eventAttr() inside the handler.'
			);
			return;
		}
		const prevEvent = currentEvent;
		const prevTarget = currentEventTarget;
		currentEvent = e;
		currentEventTarget = el;
		try {
			fn();
		} catch (err) {
			const boundary = findBoundary(el);
			if (boundary) {
				renderBoundaryFallback(boundary, err.message || String(err));
			} else {
				console.error('[frame.ui] Event handler "' + name + '" failed: ' + (err.message || String(err)));
			}
		} finally {
			currentEvent = prevEvent;
			currentEventTarget = prevTarget;
		}
		checkMemoryGrowth();
	}

	function dispatchDeclarativeEvent(e) {
		const type = e.type;
		const attrName = 'data-on-' + type;
		const bubbles = !NON_BUBBLING_EVENT_TYPES.has(type);
		let el = e.target;
		if (el && el.nodeType !== 1) el = el.parentElement || null;
		while (el && el.nodeType === 1) {
			const handler = el.getAttribute(attrName);
			if (handler !== null && handler.trim() !== '') {
				const modifiers = eventModifiers(el, type);
				if (modifiersAccept(e, modifiers)) {
					if (modifiers.has('prevent') && !modifiers.has('passive')) e.preventDefault();
					if (modifiers.has('once')) removeDeclarativeHandler(el, type);
					invokeDeclarativeHandler(handler.trim(), el, e);
					if (modifiers.has('stop')) {
						e.stopPropagation();
						return;
					}
				}
			}
			if (!bubbles) return;
			el = el.parentElement;
		}
	}

	// Called once the WASM instance exists: attach the listeners collected
	// so far and keep later markup (any insertion path) normalized.
	function initDeclarativeEvents() {
		declarativeReady = true;
		normalizeEventAttributes(document);
		for (const type of declarativeTypesSeen) listenDeclarative(type);
		if (typeof MutationObserver === 'undefined') return;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === 'attributes') {
					normalizeElementEvents(record.target);
				} else {
					record.addedNodes.forEach(node => normalizeEventAttributes(node));
				}
			}
		});
		observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
	}

	// Take over written handlers in the server-rendered markup right away,
	// before the module loads, so none of them runs as inline script.
	normalizeEventAttributes(document);

	// --- §FEXT-5: Incremental DOM Patching Helper ---
	// Recursively diffs oldNode against newNode, applying the minimum set of
	// mutations. Keyed elements (key="X") are matched by key, not position.
	// Focused elements are never removed; data-component elements are atomic.

	function patchNode(oldNode, newNode) {
		const oldChildren = Array.from(oldNode.childNodes);
		const newChildren = Array.from(newNode.childNodes);

		// Build keyed maps for element nodes
		const oldKeyed = {};
		const newKeyed = {};
		oldChildren.forEach(c => { if (c.nodeType === 1 && c.getAttribute('key')) oldKeyed[c.getAttribute('key')] = c; });
		newChildren.forEach(c => { if (c.nodeType === 1 && c.getAttribute('key')) newKeyed[c.getAttribute('key')] = c; });

		// Remove old keyed elements that are not in the new tree
		Object.keys(oldKeyed).forEach(k => {
			if (!newKeyed[k]) oldNode.removeChild(oldKeyed[k]);
		});

		// Apply new children in order
		let cursor = oldNode.firstChild;
		newChildren.forEach(newChild => {
			if (newChild.nodeType === 3) {
				// Text node
				if (cursor && cursor.nodeType === 3) {
					if (cursor.nodeValue !== newChild.nodeValue) cursor.nodeValue = newChild.nodeValue;
					cursor = cursor.nextSibling;
				} else {
					oldNode.insertBefore(document.createTextNode(newChild.nodeValue), cursor);
				}
				return;
			}
			if (newChild.nodeType !== 1) return;

			const key = newChild.getAttribute('key');
			let match = key ? oldKeyed[key] : null;

			if (!match) {
				// Position-based: find first unkeyed node of same tag
				let c = cursor;
				while (c) {
					if (c.nodeType === 1 && c.tagName === newChild.tagName && !c.getAttribute('key')) {
						match = c;
						break;
					}
					c = c.nextSibling;
				}
			}

			if (!match) {
				// Insert new
				oldNode.insertBefore(newChild.cloneNode(true), cursor);
				return;
			}

			// Move to correct position if needed
			if (match !== cursor) oldNode.insertBefore(match, cursor);

			// Focused element: update attributes only, skip children
			if (document.activeElement === match) {
				patchAttrs(match, newChild);
				cursor = match.nextSibling;
				return;
			}

			// data-component: atomic — attributes only, no child recursion
			if (match.hasAttribute('data-component')) {
				patchAttrs(match, newChild);
				cursor = match.nextSibling;
				return;
			}

			patchAttrs(match, newChild);
			patchNode(match, newChild);
			cursor = match.nextSibling;
		});

		// Remove trailing old nodes
		while (cursor) {
			const next = cursor.nextSibling;
			oldNode.removeChild(cursor);
			cursor = next;
		}
	}

	function patchAttrs(oldEl, newEl) {
		// Remove attributes not in new
		Array.from(oldEl.attributes).forEach(a => {
			if (!newEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name);
		});
		// Set new / changed attributes
		Array.from(newEl.attributes).forEach(a => {
			if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value);
		});
	}

	// --- §FEXT-3: cl-preview iframe runtime script ---
	// Injected into preview iframes so clicks post designer-select messages.
	const IFRAME_PREVIEW_SCRIPT = `(function(){
  document.addEventListener('click',function(e){
    e.preventDefault();
    var el=e.target;
    var r=el.getBoundingClientRect();
    window.parent.postMessage(JSON.stringify({
      type:'designer-select',
      selector:el.id?'#'+el.id:el.tagName.toLowerCase(),
      tagName:el.tagName.toLowerCase(),
      bounds:{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom},
      attrs:Array.from(el.attributes).map(function(a){return{name:a.name,value:a.value};})
    }),'*');
  },true);
})();`;

	// --- Crypto helpers (pure-JS SHA-256/512 + HMAC) ---
	// Adapted from plugins/frame.canvas/runtime/loader.js so the browser bridge
	// can satisfy Layer 2's crypto.* canary synchronously. WASM's bridge
	// boundary is synchronous, so we cannot use crypto.subtle.digest (which is
	// Promise-returning). TASKS.md tracks the shared clean-stdlib.js extraction
	// that would deduplicate this between frame.ui and frame.canvas.

	function sha256Hex(input) {
		const K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
		];
		// Accept string (UTF-8 encode) or Uint8Array (use as-is). The bytes
		// variant is what _crypto_sha256_bytes needs — the caller reads raw
		// bytes from a length-prefixed buffer and the hash must operate on
		// those bytes without UTF-8 round-tripping.
		const enc = (typeof input === 'string') ? new TextEncoder().encode(input) : input;
		const bitLen = enc.length * 8;
		const padLen = (Math.floor((enc.length + 9 + 63) / 64) * 64) - enc.length;
		const msg = new Uint8Array(enc.length + padLen);
		msg.set(enc, 0);
		msg[enc.length] = 0x80;
		const dv = new DataView(msg.buffer);
		dv.setUint32(msg.length - 8, Math.floor(bitLen / 0x100000000), false);
		dv.setUint32(msg.length - 4, bitLen >>> 0, false);
		let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
		let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
		const w = new Uint32Array(64);
		const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
		for (let i = 0; i < msg.length; i += 64) {
			for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
			for (let t = 16; t < 64; t++) {
				const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
				const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
			}
			let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
			for (let t = 0; t < 64; t++) {
				const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				const ch = (e & f) ^ (~e & g);
				const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
				const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				const maj = (a & b) ^ (a & c) ^ (b & c);
				const t2 = (S0 + maj) >>> 0;
				hh = g; g = f; f = e; e = (d + t1) >>> 0;
				d = c; c = b; b = a; a = (t1 + t2) >>> 0;
			}
			h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
			h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
		}
		const toHex = (n) => n.toString(16).padStart(8, '0');
		return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
	}

	function sha256Bytes(input) {
		const hex = sha256Hex(input);
		const out = new Uint8Array(32);
		for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
		return out;
	}

	function sha512Hex(input) {
		const K = [
			0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
			0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
			0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
			0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
			0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
			0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
			0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
			0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
			0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
			0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
			0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
			0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
			0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
			0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
			0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
			0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
			0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
			0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
			0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
			0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
		];
		const enc = (typeof input === 'string') ? new TextEncoder().encode(input) : input;
		const bitLen = BigInt(enc.length) * 8n;
		const padLen = (Math.floor((enc.length + 17 + 127) / 128) * 128) - enc.length;
		const msg = new Uint8Array(enc.length + padLen);
		msg.set(enc, 0);
		msg[enc.length] = 0x80;
		const dv = new DataView(msg.buffer);
		dv.setBigUint64(msg.length - 8, bitLen, false);
		const MASK64 = 0xffffffffffffffffn;
		let h = [
			0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
			0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
		];
		const rotr = (x, n) => ((x >> n) | ((x << (64n - n)) & MASK64)) & MASK64;
		const w = new Array(80);
		for (let i = 0; i < msg.length; i += 128) {
			for (let t = 0; t < 16; t++) w[t] = dv.getBigUint64(i + t * 8, false);
			for (let t = 16; t < 80; t++) {
				const s0 = rotr(w[t - 15], 1n) ^ rotr(w[t - 15], 8n) ^ (w[t - 15] >> 7n);
				const s1 = rotr(w[t - 2], 19n) ^ rotr(w[t - 2], 61n) ^ (w[t - 2] >> 6n);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & MASK64;
			}
			let [a, b, c, d, e, f, g, hh] = h;
			for (let t = 0; t < 80; t++) {
				const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
				const ch = (e & f) ^ ((~e) & MASK64 & g);
				const t1 = (hh + S1 + ch + K[t] + w[t]) & MASK64;
				const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
				const maj = (a & b) ^ (a & c) ^ (b & c);
				const t2 = (S0 + maj) & MASK64;
				hh = g; g = f; f = e; e = (d + t1) & MASK64;
				d = c; c = b; b = a; a = (t1 + t2) & MASK64;
			}
			h = [
				(h[0] + a) & MASK64, (h[1] + b) & MASK64, (h[2] + c) & MASK64, (h[3] + d) & MASK64,
				(h[4] + e) & MASK64, (h[5] + f) & MASK64, (h[6] + g) & MASK64, (h[7] + hh) & MASK64,
			];
		}
		return h.map(x => x.toString(16).padStart(16, '0')).join('');
	}

	function sha512Bytes(input) {
		const hex = sha512Hex(input);
		const out = new Uint8Array(64);
		for (let i = 0; i < 64; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
		return out;
	}

	function hmacHex(key, data, alg) {
		const blockSize = alg === 'sha512' ? 128 : 64;
		const hash = alg === 'sha512' ? sha512Bytes : sha256Bytes;
		const hashHex = alg === 'sha512' ? sha512Hex : sha256Hex;
		// Every step works on bytes: the inner digest is binary and must not
		// pass through a text decoder.
		let keyBytes = new TextEncoder().encode(key);
		if (keyBytes.length > blockSize) keyBytes = hash(keyBytes);
		if (keyBytes.length < blockSize) {
			const padded = new Uint8Array(blockSize);
			padded.set(keyBytes);
			keyBytes = padded;
		}
		const oKey = new Uint8Array(blockSize);
		const iKey = new Uint8Array(blockSize);
		for (let i = 0; i < blockSize; i++) {
			oKey[i] = keyBytes[i] ^ 0x5c;
			iKey[i] = keyBytes[i] ^ 0x36;
		}
		const dataBytes = new TextEncoder().encode(data);
		const inner = new Uint8Array(iKey.length + dataBytes.length);
		inner.set(iKey, 0); inner.set(dataBytes, iKey.length);
		const innerHash = hash(inner);
		const outer = new Uint8Array(oKey.length + innerHash.length);
		outer.set(oKey, 0); outer.set(innerHash, oKey.length);
		return hashHex(outer);
	}

	function cryptoRandomHex(byteCount) {
		const n = Math.max(0, byteCount | 0);
		const b = new Uint8Array(n);
		if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
		else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
		let hex = '';
		for (let i = 0; i < n; i++) hex += b[i].toString(16).padStart(2, '0');
		return hex;
	}

	function cryptoRandomBase64(byteCount) {
		const n = Math.max(0, byteCount | 0);
		const b = new Uint8Array(n);
		if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
		else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
		let bin = '';
		for (let i = 0; i < n; i++) bin += String.fromCharCode(b[i]);
		return btoa(bin);
	}

	// --- allocBytes: fixed-size blocks in WASM linear memory ---
	// Used by the _v2 JSON bridges to allocate boxed-Any blocks (12 bytes),
	// list headers (16 + N*4 bytes), and pairs headers (8 + N*8 bytes).
	// IMPORTANT: callers MUST refresh any DataView they hold after any call to
	// allocBytes or writeString, because either can grow WASM memory and
	// invalidate existing DataView snapshots.
	function allocBytes(size) {
		return hostAlloc(size);
	}

	// --- Boxed-Any JSON values (BOXED_ANY_ABI.md §1–§3) ---
	// Shared by the _json_*_v2 bridges and _json_get. A box is 12 bytes:
	// [tag:i32][payload:8 bytes]. Arrays and objects point at JSON-tree
	// fragments — [count][elem_ptr × count] and [count][(key_ptr, val_ptr) ×
	// count] — NOT Clean list<any> / pairs<string,any>. Every access
	// re-acquires the DataView: writeString / allocBytes can grow memory.
	const jsonView = () => new DataView(memory.buffer);

	function readLPString(lpPtr) {
		return readString(lpPtr + 4, jsonView().getUint32(lpPtr, true));
	}

	// Throws on an invalid tag — no silent "null" fallback (D5 / BOXED_ANY_ABI §6).
	function readBoxedAny(ptr) {
		const tag = jsonView().getInt32(ptr, true);
		switch (tag) {
			case 0: // Null
				return null;
			case 1: // Integer: i64 across offsets 4..12. Number(BigInt) loses
				// precision above 2^53, symmetric with the decode partition (§5.2).
				return Number(jsonView().getBigInt64(ptr + 4, true));
			case 2: // Boolean
				return jsonView().getInt32(ptr + 4, true) !== 0;
			case 3: // Number: f64 at offset 4
				return jsonView().getFloat64(ptr + 4, true);
			case 4: // String: LP pointer at offset 4
				return readLPString(jsonView().getInt32(ptr + 4, true));
			case 5: { // Array fragment (§3.2), stride 4
				const listPtr = jsonView().getInt32(ptr + 4, true);
				const count = jsonView().getInt32(listPtr, true);
				const result = [];
				for (let i = 0; i < count; i++) {
					result.push(readBoxedAny(jsonView().getInt32(listPtr + 4 + i * 4, true)));
				}
				return result;
			}
			case 6: { // Object fragment (§3.3), stride 8. Memory order is
				// insertion order (D3); key_ptr is a raw LP string.
				const pairsPtr = jsonView().getInt32(ptr + 4, true);
				const count = jsonView().getInt32(pairsPtr, true);
				const result = {};
				for (let i = 0; i < count; i++) {
					const entry = pairsPtr + 4 + i * 8;
					const key = readLPString(jsonView().getInt32(entry, true));
					result[key] = readBoxedAny(jsonView().getInt32(entry + 4, true));
				}
				return result;
			}
			default:
				throw new Error('invalid boxed-Any tag ' + tag + ' at ptr ' + ptr);
		}
	}

	// Writes a JSON value as a boxed-Any tree and returns the box pointer.
	// Children are written first: their pointers stay valid when memory grows.
	function writeBoxedAny(value) {
		let tag;
		let word = 0;
		let float = null;
		let integer = null;
		if (value === null) {
			tag = 0;
		} else if (typeof value === 'boolean') {
			tag = 2;
			word = value ? 1 : 0;
		} else if (typeof value === 'number') {
			// Integers in the safe range → tag 1 (i64), everything else → tag 3 (§5.2).
			if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
				tag = 1;
				integer = BigInt(value);
			} else {
				tag = 3;
				float = value;
			}
		} else if (typeof value === 'string') {
			tag = 4;
			word = writeString(value);
		} else if (Array.isArray(value)) {
			const elemPtrs = value.map(writeBoxedAny);
			const listPtr = allocBytes(4 + elemPtrs.length * 4);
			jsonView().setInt32(listPtr, elemPtrs.length, true);
			for (let i = 0; i < elemPtrs.length; i++) {
				jsonView().setInt32(listPtr + 4 + i * 4, elemPtrs[i], true);
			}
			tag = 5;
			word = listPtr;
		} else {
			// Object.entries preserves insertion order for string keys (D3).
			const entries = Object.entries(value).map(([k, v]) => [writeString(k), writeBoxedAny(v)]);
			const pairsPtr = allocBytes(4 + entries.length * 8);
			jsonView().setInt32(pairsPtr, entries.length, true);
			for (let i = 0; i < entries.length; i++) {
				jsonView().setInt32(pairsPtr + 4 + i * 8, entries[i][0], true);
				jsonView().setInt32(pairsPtr + 8 + i * 8, entries[i][1], true);
			}
			tag = 6;
			word = pairsPtr;
		}
		const ptr = allocBytes(12);
		const dv = jsonView();
		dv.setInt32(ptr, tag, true);
		if (integer !== null) {
			dv.setBigInt64(ptr + 4, integer, true);
		} else if (float !== null) {
			dv.setFloat64(ptr + 4, float, true);
		} else {
			dv.setInt32(ptr + 4, word, true);
			dv.setInt32(ptr + 8, 0, true);
		}
		return ptr;
	}

	// Follows a dot-separated path. A segment selects an object member by
	// name, or an array element when it is a decimal index. undefined on a miss.
	function jsonGetPath(value, path) {
		let node = value;
		for (const segment of path.split('.')) {
			if (Array.isArray(node)) {
				node = /^[0-9]+$/.test(segment) ? node[Number(segment)] : undefined;
			} else if (node !== null && typeof node === 'object') {
				node = Object.prototype.hasOwnProperty.call(node, segment) ? node[segment] : undefined;
			} else {
				return undefined;
			}
			if (node === undefined) return undefined;
		}
		return node;
	}

	// --- Bridge Object ---

	const bridge = {
		memory_runtime: {
			// Memory management — spec: platform-architecture/HOST_BRIDGE.md
			// runtime-abi v1: mem_alloc(type_id, size) -> ptr (8-byte aligned).
			mem_alloc: (typeId, size) => hostAlloc(size),
			mem_retain: (ptr) => {},
			mem_release: (ptr) => {},
			mem_scope_push: () => {},
			mem_scope_pop: () => {},
		},
		env: {
			// Console
			print: (ptr, len) => console.log(readString(ptr, len)),
			printl: (ptr, len) => console.log(readString(ptr, len)),
			print_integer: (ptr, len) => console.log(readString(ptr, len)),
			print_float:   (ptr, len) => console.log(readString(ptr, len)),
			print_boolean: (ptr, len) => console.log(readString(ptr, len)),
			'string.concat': (hptr1, hptr2) => {
				const dv = new DataView(memory.buffer);
				const s1 = readString(hptr1 + 4, dv.getUint32(hptr1, true));
				const s2 = readString(hptr2 + 4, dv.getUint32(hptr2, true));
				return writeString(s1 + s2);
			},

			// ========== HTML Rendering ==========

			_html_escape: (strPtr, strLen) => {
				const str = readString(strPtr, strLen);
				const escaped = str
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#039;');
				return writeString(escaped);
			},

			_html_raw: (strPtr, strLen) => {
				return writeString(readString(strPtr, strLen));
			},

			// ========== Component Registry ==========

			_ui_register_component: (tagPtr, tagLen, classPtr, classLen) => {
				componentRegistry.set(readString(tagPtr, tagLen), readString(classPtr, classLen));
				return 0;
			},

			_ui_get_component: (tagPtr, tagLen) => {
				return writeString(componentRegistry.get(readString(tagPtr, tagLen)) || '');
			},

			// Page template loading and component-HTML registration. These are
			// primarily server-side concerns but the registry lists hosts =
			// ["browser", "server"] so the client-side loader must handle them
			// too. The bridge is synchronous to WASM, so in the browser the
			// template is read with a synchronous request (the first call
			// returns the page, not ""); a missing template is "" as on the
			// server. Results are cached per path.
			_ui_load_page: (pathPtr, pathLen) => {
				const path = readString(pathPtr, pathLen);
				if (!loadedPages) loadedPages = new Map();
				if (!loadedPages.has(path)) {
					let text = '';
					try {
						const req = new XMLHttpRequest();
						req.open('GET', path, false);
						req.send(null);
						if (req.status >= 200 && req.status < 300) text = req.responseText || '';
					} catch (err) {
						console.error('[frame.ui] _ui_load_page("' + path + '") failed: ' + (err && err.message ? err.message : String(err)));
					}
					loadedPages.set(path, text);
				}
				return writeString(loadedPages.get(path));
			},

			// The browser renders no page templates (there is no browser
			// _ui_render_page), so a registered component template has no
			// consumer here; the call succeeds as the registry specifies.
			_ui_register_component_html: (tagPtr, tagLen, htmlPtr, htmlLen) => 1,

			// ========== Slot Management ==========

			_ui_set_slot: (namePtr, nameLen, contentPtr, contentLen) => {
				slotStore.set(readString(namePtr, nameLen), readString(contentPtr, contentLen));
				return 0;
			},

			_ui_get_slot: (namePtr, nameLen) => {
				return writeString(slotStore.get(readString(namePtr, nameLen)) || '');
			},

			// ========== Event Handler Registration ==========

			_ui_on_event: (selectorPtr, selectorLen, eventTypePtr, eventTypeLen, handlerPtr, handlerLen) => {
				const selector = readString(selectorPtr, selectorLen);
				// eventType may carry a :passive suffix from the plugin runtime
				const rawEventType = readString(eventTypePtr, eventTypeLen);
				const passive = rawEventType.endsWith(':passive');
				const eventType = passive ? rawEventType.slice(0, -8) : rawEventType;
				const handlerName = readString(handlerPtr, handlerLen);
				const key = selector + '\0' + eventType + '\0' + (passive ? 'passive' : '');

				if (!eventHandlers.has(key)) {
					eventHandlers.set(key, []);
				}
				eventHandlers.get(key).push(handlerName);
				ensureDocumentListener(eventType, passive);
				return 0;
			},

			// ========== State Management ==========

			_ui_set_state: (idPtr, idLen, jsonPtr, jsonLen) => {
				stateStore.set(readString(idPtr, idLen), readString(jsonPtr, jsonLen));
				return 0;
			},

			_ui_get_state: (idPtr, idLen) => {
				const key = readString(idPtr, idLen);
				return writeString(stateStore.has(key) ? stateStore.get(key) : '');
			},

			_state_reset_all: () => {},
			_state_reset_named: () => {},

			// Compiler-emitted arena-scope markers. Contract confirmed by
			// compiler team via prompt 8ac2c282-7bbe-11f1:
			// - Only emitted around HIR-rewritten dual-accumulator loops
			//   (rewrite_dual_accumulator_loops, src/hir/hir_builder.rs) as
			//   a triangular-sum OOM guard, NOT around every function call.
			// - push() snapshots heapPtr and returns a 1-based depth counter.
			// - pop(handle) resets heapPtr to the snapshot at target depth;
			//   handle <= 0 is a no-op. Reference impl in wasmtime_runner.rs.
			// - The earlier no-op stub (commit ad75d7a) satisfied host-parity
			//   but was contract-broken: returning 0 makes the paired pop a
			//   no-op, defeating the compiler's OOM guard for the rewritten
			//   loops. This impl matches the reference semantics.
			_arena_scope_push: () => {
				scopeMarks.push(currentHeapTop());
				return scopeMarks.length;
			},
			_arena_scope_pop: (handle) => {
				if (handle <= 0) return;
				let resetTo = null;
				while (scopeMarks.length >= handle) {
					const mark = scopeMarks.pop();
					if (resetTo === null) resetTo = mark;
				}
				if (resetTo !== null) setHeapTop(resetTo);
			},

			// ========== DOM Manipulation ==========

			_ui_update_element: (selectorPtr, selectorLen, contentPtr, contentLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) {
					el.innerHTML = readString(contentPtr, contentLen);
					normalizeEventAttributes(el);
					return 0;
				}
				return -1;
			},

			_ui_update_attr: (selectorPtr, selectorLen, attrPtr, attrLen, valPtr, valLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) { el.setAttribute(readString(attrPtr, attrLen), readString(valPtr, valLen)); return 0; }
				return -1;
			},

			// ========== Form Binding ==========

			_ui_bind_input: (selectorPtr, selectorLen, pathPtr, pathLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const path = readString(pathPtr, pathLen);
				const el = document.querySelector(selector);
				if (!el) return -1;

				el.addEventListener('input', () => {
					stateStore.set(path, JSON.stringify(el.value));
					const setterName = 'set_' + path.replace(/\./g, '_');
					if (instance.exports[setterName]) {
						instance.exports[setterName](writeString(el.value));
					}
				});
				return 0;
			},

			// ========== Validation ==========

			_ui_validate: (valuePtr, valueLen, rulePtr, ruleLen) => {
				const value = readString(valuePtr, valueLen);
				const rule = readString(rulePtr, ruleLen);
				let error = '';
				switch (rule) {
					case 'required': if (!value.trim()) error = 'This field is required'; break;
					case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) error = 'Invalid email'; break;
					case 'url': try { new URL(value); } catch { error = 'Invalid URL'; } break;
				}
				return writeString(error);
			},

			// ========== Event Handler Context ==========

			_ui_event_attr: (attrPtr, attrLen) => {
				if (!currentEventTarget) return writeString('');
				return writeString(currentEventTarget.getAttribute(readString(attrPtr, attrLen)) || '');
			},

			_ui_event_value: () => {
				if (!currentEventTarget) return writeString('');
				if (currentEventTarget.tagName === 'INPUT' || currentEventTarget.tagName === 'TEXTAREA' || currentEventTarget.tagName === 'SELECT') {
					return writeString(currentEventTarget.value || '');
				}
				return writeString(currentEventTarget.textContent || '');
			},

			_ui_event_closest_attr: (selectorPtr, selectorLen, attrPtr, attrLen) => {
				if (!currentEvent) return writeString('');
				const el = currentEvent.target.closest(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				return writeString(el.getAttribute(readString(attrPtr, attrLen)) || '');
			},

			_ui_event_type: () => {
				if (!currentEvent) return writeString('');
				return writeString(currentEvent.type);
			},

			// ========== Clipboard ==========

			_ui_clipboard_write: (textPtr, textLen) => {
				navigator.clipboard.writeText(readString(textPtr, textLen)).catch(() => {});
				return 0;
			},

			// ========== URL / Location ==========

			_ui_location_href: (urlPtr, urlLen) => {
				window.location.href = readString(urlPtr, urlLen);
				return 0;
			},

			_ui_location_query: (paramPtr, paramLen) => {
				const value = new URLSearchParams(window.location.search).get(readString(paramPtr, paramLen)) || '';
				return writeString(value);
			},

			_ui_location_path: () => {
				return writeString(window.location.pathname);
			},

			// ========== DOM Query (single element) ==========

			_ui_get_text: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				return writeString(el ? (el.textContent || '') : '');
			},

			_ui_get_attr: (selectorPtr, selectorLen, attrPtr, attrLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				return writeString(el ? (el.getAttribute(readString(attrPtr, attrLen)) || '') : '');
			},

			_ui_toggle_class: (selectorPtr, selectorLen, classPtr, classLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.classList.toggle(readString(classPtr, classLen));
				return 0;
			},

			_ui_add_class: (selectorPtr, selectorLen, classPtr, classLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.classList.add(readString(classPtr, classLen));
				return 0;
			},

			_ui_remove_class: (selectorPtr, selectorLen, classPtr, classLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.classList.remove(readString(classPtr, classLen));
				return 0;
			},

			_ui_set_style: (selectorPtr, selectorLen, propPtr, propLen, valPtr, valLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.style[readString(propPtr, propLen)] = readString(valPtr, valLen);
				return 0;
			},

			_ui_update_element_self: (contentPtr, contentLen) => {
				if (!currentEventTarget) return -1;
				currentEventTarget.textContent = readString(contentPtr, contentLen);
				return 0;
			},

			// ========== DOM Batch (querySelectorAll) ==========

			_ui_query_set_style: (selectorPtr, selectorLen, propPtr, propLen, valPtr, valLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const prop = readString(propPtr, propLen);
				const val = readString(valPtr, valLen);
				document.querySelectorAll(selector).forEach(el => { el.style[prop] = val; });
				return 0;
			},

			_ui_query_set_attr: (selectorPtr, selectorLen, attrPtr, attrLen, valPtr, valLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const attr = readString(attrPtr, attrLen);
				const val = readString(valPtr, valLen);
				document.querySelectorAll(selector).forEach(el => el.setAttribute(attr, val));
				return 0;
			},

			_ui_query_add_class: (selectorPtr, selectorLen, classPtr, classLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const cls = readString(classPtr, classLen);
				document.querySelectorAll(selector).forEach(el => el.classList.add(cls));
				return 0;
			},

			_ui_query_remove_class: (selectorPtr, selectorLen, classPtr, classLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const cls = readString(classPtr, classLen);
				document.querySelectorAll(selector).forEach(el => el.classList.remove(cls));
				return 0;
			},

			_ui_filter_by_attr: (selectorPtr, selectorLen, attrPtr, attrLen, valPtr, valLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const attr = readString(attrPtr, attrLen);
				const val = readString(valPtr, valLen);
				document.querySelectorAll(selector).forEach(el => {
					if (val === '*' || el.getAttribute(attr) === val) {
						el.style.display = '';
					} else {
						el.style.display = 'none';
					}
				});
				return 0;
			},

			_ui_filter_by_text: (selectorPtr, selectorLen, nameAttrPtr, nameAttrLen, descAttrPtr, descAttrLen, queryPtr, queryLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const nameAttr = readString(nameAttrPtr, nameAttrLen);
				const descAttr = readString(descAttrPtr, descAttrLen);
				const query = readString(queryPtr, queryLen).toLowerCase();
				document.querySelectorAll(selector).forEach(el => {
					if (query.length === 0) {
						el.style.display = '';
					} else {
						const name = (el.getAttribute(nameAttr) || '').toLowerCase();
						const desc = (el.getAttribute(descAttr) || '').toLowerCase();
						el.style.display = (name.indexOf(query) !== -1 || desc.indexOf(query) !== -1) ? '' : 'none';
					}
				});
				return 0;
			},

			// ========== IntersectionObserver ==========

			_ui_observe_visible: (selectorPtr, selectorLen, classPtr, classLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const cls = readString(classPtr, classLen);
				if (!('IntersectionObserver' in window)) {
					document.querySelectorAll(selector).forEach(el => el.classList.add(cls));
					return 0;
				}
				const observer = new IntersectionObserver((entries) => {
					entries.forEach(entry => {
						if (entry.isIntersecting) {
							entry.target.classList.add(cls);
							observer.unobserve(entry.target);
						}
					});
				}, { threshold: 0.1 });
				document.querySelectorAll(selector).forEach(el => observer.observe(el));
				return 0;
			},

			// ========== Timers ==========

			_ui_set_timeout: (handlerPtr, handlerLen, delayMs) => {
				const handlerName = readString(handlerPtr, handlerLen);
				setTimeout(() => {
					currentEvent = null;
					currentEventTarget = null;
					invokeExport(handlerName, 'setTimeout');
				}, delayMs);
				return 0;
			},

			// ========== Stylesheet linking (auto-link for theme.css and components/<tag>.css) ==========

			_ui_inject_head_link: (hrefPtr, hrefLen) => {
				const href = readString(hrefPtr, hrefLen);
				if (document.querySelector('link[rel="stylesheet"][href="' + href + '"]')) return 0;
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = href;
				document.head.appendChild(link);
				return 0;
			},

			// ========== Layout Loading ==========

			_ui_load_layout: (namePtr, nameLen) => {
				const name = readString(namePtr, nameLen);
				// Layout loading requires server-side fetch; return empty on client
				console.warn('_ui_load_layout is server-side only, called with:', name);
				return writeString('');
			},

			// ========== Form Helpers ==========

			_ui_input_value: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				return writeString(el.value || el.textContent || '');
			},

			_ui_form_json: (selectorPtr, selectorLen) => {
				const form = document.querySelector(readString(selectorPtr, selectorLen));
				if (!form) return writeString('{}');
				const data = {};
				form.querySelectorAll('[name]').forEach(el => {
					if (el.type === 'checkbox') {
						data[el.name] = el.checked;
					} else if (el.type === 'radio') {
						if (el.checked) data[el.name] = el.value;
					} else {
						data[el.name] = el.value;
					}
				});
				return writeString(JSON.stringify(data));
			},

			_ui_form_data: (selectorPtr, selectorLen) => {
				const form = document.querySelector(readString(selectorPtr, selectorLen));
				if (!form) return writeString('');
				const parts = [];
				form.querySelectorAll('[name]').forEach(el => {
					if (el.type === 'checkbox') {
						if (el.checked) parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value || 'on'));
					} else if (el.type === 'radio') {
						if (el.checked) parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value));
					} else {
						parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value));
					}
				});
				return writeString(parts.join('&'));
			},

			_ui_checked: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return 0;
				return el.checked ? 1 : 0;
			},

			_ui_set_input: (selectorPtr, selectorLen, valPtr, valLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return -1;
				el.value = readString(valPtr, valLen);
				return 0;
			},

			// FRAMEUI002: Programmatically submit a form (needed for keyboard shortcut handlers)
			_ui_form_submit: (selectorPtr, selectorLen) => {
				const form = document.querySelector(readString(selectorPtr, selectorLen));
				if (!form) return -1;
				form.requestSubmit ? form.requestSubmit() : form.submit();
				return 0;
			},

			// FRAMEUI003: Get textarea selection as JSON {text, start, end}
			_ui_get_selection: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('{"text":"","start":0,"end":0}');
				const start = el.selectionStart || 0;
				const end = el.selectionEnd || 0;
				const text = (el.value || '').substring(start, end);
				return writeString(JSON.stringify({ text, start, end }));
			},

			// FRAMEUI003: Wrap selection (or insert at cursor) with before/after markers
			// Returns the new cursor position after the inserted text
			_ui_insert_at_cursor: (selectorPtr, selectorLen, beforePtr, beforeLen, afterPtr, afterLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return -1;
				const before = readString(beforePtr, beforeLen);
				const after = readString(afterPtr, afterLen);
				const start = el.selectionStart || 0;
				const end = el.selectionEnd || 0;
				const val = el.value || '';
				const selected = val.substring(start, end);
				const newVal = val.substring(0, start) + before + selected + after + val.substring(end);
				el.value = newVal;
				const newCursor = start + before.length + selected.length + after.length;
				el.selectionStart = newCursor;
				el.selectionEnd = newCursor;
				el.focus();
				el.dispatchEvent(new Event('input', { bubbles: true }));
				return newCursor;
			},

			// FRAMEUI004: Word-level text diff between two elements, rendered into a third
			_ui_text_diff: (aPtr, aLen, bPtr, bLen, outPtr, outLen) => {
				const elA = document.querySelector(readString(aPtr, aLen));
				const elB = document.querySelector(readString(bPtr, bLen));
				const elOut = document.querySelector(readString(outPtr, outLen));
				if (!elA || !elB || !elOut) return -1;
				const tokA = (elA.textContent || '').split(/(\s+)/);
				const tokB = (elB.textContent || '').split(/(\s+)/);
				const m = tokA.length, n = tokB.length;
				// LCS table
				const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
				for (let i = m - 1; i >= 0; i--)
					for (let j = n - 1; j >= 0; j--)
						dp[i][j] = tokA[i] === tokB[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
				// Trace diff
				const frag = document.createDocumentFragment();
				let i = 0, j = 0;
				while (i < m || j < n) {
					if (i < m && j < n && tokA[i] === tokB[j]) {
						frag.appendChild(document.createTextNode(tokA[i]));
						i++; j++;
					} else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) {
						const sp = document.createElement('span');
						sp.className = 'diff-added';
						sp.textContent = tokB[j];
						frag.appendChild(sp);
						j++;
					} else {
						const sp = document.createElement('span');
						sp.className = 'diff-removed';
						sp.textContent = tokA[i];
						frag.appendChild(sp);
						i++;
					}
				}
				elOut.innerHTML = '';
				elOut.appendChild(frag);
				return 0;
			},

			// ========== Stdlib Bridge (compiler-emitted imports) ==========
			// These functions are emitted as WASM imports for any program that
			// uses string ops, float formatting, or list operations. The browser
			// host must provide them so the module can instantiate.

			// Clean's error() builtin — emitted whenever user code or stdlib calls
			// error(msg). Throws so the surrounding error boundary catches it.
			error: (ptr, len) => {
				throw new Error(readString(ptr, len));
			},

			// _server_sleep — emitted transitively when client code touches any
			// later/background stdlib helper. Sleep has no browser semantics, so
			// this is a no-op stub. Without it the WASM module fails to instantiate
			// with a LinkError and the entire UI bridge silently dies.
			_server_sleep: (_ms) => 0,

			// String operations
			string_compare: (hptr1, hptr2) => {
				const dv = new DataView(memory.buffer);
				const a = readString(hptr1 + 4, dv.getUint32(hptr1, true));
				const b = readString(hptr2 + 4, dv.getUint32(hptr2, true));
				return a < b ? -1 : a > b ? 1 : 0;
			},

			// string_replace(str, find, replacement): three length-prefixed
			// pointers (function-registry.toml). Every occurrence is replaced,
			// as `.replace(old, new)` is specified (specification §16) and
			// clean-server implements it; an empty `find` returns str.
			string_replace: (strPtr, findPtr, replacementPtr) => {
				const str = readLPString(strPtr);
				const find = readLPString(findPtr);
				return writeString(find === '' ? str : str.split(find).join(readLPString(replacementPtr)));
			},

			'string.split': (strPtr, strLen, sepPtr, sepLen) => {
				const str = readString(strPtr, strLen);
				const sep = readString(sepPtr, sepLen);
				const parts = sep === '' ? [str] : str.split(sep);
				const count = parts.length;
				// Allocate list header (16 bytes) + pointer slots (count * 4 bytes each)
				const listPtr = hostAlloc(16 + count * 4);
				// Write each part string, collect pointers (after all allocs, buffer may grow)
				const ptrs = parts.map(p => writeString(p));
				// Write list header using fresh DataView (memory may have grown)
				const dv = new DataView(memory.buffer);
				dv.setInt32(listPtr,      count, true); // length
				dv.setInt32(listPtr + 4,  count, true); // capacity
				dv.setInt32(listPtr + 8,  1,     true); // type_id = 1 (string)
				dv.setInt32(listPtr + 12, 0,     true); // padding
				for (let i = 0; i < count; i++) {
					new DataView(memory.buffer).setInt32(listPtr + 16 + i * 4, ptrs[i], true);
				}
				return listPtr;
			},

			// Type conversions
			float_to_string: (value) => {
				return writeString(String(value));
			},

			int_to_string: (value) => {
				return writeString(String(value));
			},

			int64_to_string: (value) => {
				return writeString((typeof value === 'bigint' ? value : BigInt(value)).toString());
			},

			// string_to_float(str): one length-prefixed pointer
			// (function-registry.toml, alias string.toNumber); 0.0 when the
			// text is not a number.
			string_to_float: (strPtr) => {
				const n = parseFloat(readLPString(strPtr));
				return Number.isNaN(n) ? 0.0 : n;
			},

			// ========== math.* bridges ==========
			// All entries here are emitted as WASM imports whenever any Clean
			// program references the math namespace. The compiler emits
			// math_random unconditionally (codegen_registration.rs), so it must
			// be supplied even for programs that don't call math.random. Pure-
			// WASM intrinsics (sqrt / abs / min / max / floor / ceil / round /
			// trunc / sign) are compiled inline and never appear as imports.
			math_pow:    (base, exp) => Math.pow(base, exp),
			math_sin:    (x) => Math.sin(x),
			math_cos:    (x) => Math.cos(x),
			math_tan:    (x) => Math.tan(x),
			math_asin:   (x) => Math.asin(x),
			math_acos:   (x) => Math.acos(x),
			math_atan:   (x) => Math.atan(x),
			math_atan2:  (y, x) => Math.atan2(y, x),
			math_sinh:   (x) => Math.sinh(x),
			math_cosh:   (x) => Math.cosh(x),
			math_tanh:   (x) => Math.tanh(x),
			math_ln:     (x) => Math.log(x),
			math_log10:  (x) => Math.log10(x),
			math_log2:   (x) => Math.log2(x),
			math_exp:    (x) => Math.exp(x),
			math_exp2:   (x) => Math.pow(2, x),
			math_random: () => Math.random(),

			// ========== time.* bridges ==========
			// _time_now returns Unix seconds as i64 (BigInt in JS-WASM boundary).
			// _time_now_seconds returns fractional seconds; _time_performance_now
			// returns high-res monotonic milliseconds. The six calendar bridges
			// below use cleanTime (stdlib-reference §12, function-registry.toml).
			_time_now:             () => BigInt(Math.floor(Date.now() / 1000)),
			_time_now_seconds:     () => Date.now() / 1000,
			_time_performance_now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
			_time_format: (ts, patternPtr, patternLen, localePtr, localeLen, tzPtr, tzLen) =>
				writeString(cleanTime.format(ts, readString(patternPtr, patternLen), readString(tzPtr, tzLen))),
			_time_relative: (ts, localePtr, localeLen) =>
				writeString(cleanTime.relative(ts, Date.now() / 1000, readString(localePtr, localeLen))),
			_time_parse: (isoPtr, isoLen) => cleanTime.parse(readString(isoPtr, isoLen)),
			_time_parts: (ts, tzPtr, tzLen) => writeString(cleanTime.parts(ts, readString(tzPtr, tzLen))),
			_time_add: (ts, amount, unitPtr, unitLen) => cleanTime.add(ts, amount, readString(unitPtr, unitLen)),
			_time_diff: (from, to, unitPtr, unitLen) => cleanTime.diff(from, to, readString(unitPtr, unitLen)),

			// ========== http_* bridges (URL helpers + response accessors) ==========
			// Only URL helpers and getResponseHeaders/Code run on the browser side;
			// the network verbs (http_get / http_post / etc) live in the server-
			// guard throw block further down because the browser has no synchronous
			// HTTP client. Callers that need async browser fetch use _ui_fetch_cb.
			http_encode_url: (ptr, len) => writeString(encodeURIComponent(readString(ptr, len))),
			http_decode_url: (ptr, len) => {
				try {
					return writeString(decodeURIComponent(readString(ptr, len)));
				} catch (_) {
					return writeString(readString(ptr, len));
				}
			},
			http_build_query: (ptr, len) => {
				// Matches clean-server semantics: accepts a JSON object of
				// key-value pairs and produces a url-encoded query string. A
				// non-JSON string is treated as an already-formed query and
				// returned unchanged.
				const input = readString(ptr, len);
				try {
					const obj = JSON.parse(input);
					if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
						const parts = [];
						for (const [k, v] of Object.entries(obj)) {
							const val = typeof v === 'string' ? v : String(v);
							parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
						}
						return writeString(parts.join('&'));
					}
				} catch (_) { /* fall through */ }
				return writeString(input);
			},
			// The browser is a client, not a request handler; there is no
			// "last response" to inspect. Return 0 (JSON null) so the compiled
			// wrappers see a null result — .length() on null resolves to 0.
			http_get_response_code:    () => 0,
			http_get_response_headers: () => 0,

			// Client-configuration setters. These have no browser semantics
			// (the browser fetch client is not a persistent Http object we
			// can reconfigure), so they are no-ops. They must exist so any
			// program touching http.setTimeout / http.setMaxRedirects /
			// http.enableCookies / http.setUserAgent can instantiate.
			http_set_timeout:        (_ms) => 0,
			http_set_max_redirects:  (_n) => 0,
			http_enable_cookies:     (_b) => 0,
			http_set_user_agent:     (_ptr, _len) => 0,

			// ========== _crypto_* bridges (SHA-256/512, HMAC, random) ==========
			// The frame.auth 'crypto' namespace lowers to these bridges. Real
			// synchronous implementations are required — see the SHA-256/512
			// and HMAC helpers at the top of the IIFE.
			_crypto_hash_sha256: (ptr, len) => writeString(sha256Hex(readString(ptr, len))),
			// SHA-256 of a length-prefixed byte buffer at handle. Handle layout
			// matches _req_body_bytes output: [4-byte LE length][bytes]. Returns
			// a length-prefixed lowercase hex string (64 chars). Companion to
			// _crypto_hash_sha256 for octet-stream inputs that must not go
			// through UTF-8 decode/re-encode. Registry: function-registry.toml
			// §_crypto_sha256_bytes (hosts=["all"]).
			_crypto_sha256_bytes: (handle) => writeString(sha256Hex(readLPBytes(handle))),
			_crypto_hash_sha512: (ptr, len) => writeString(sha512Hex(readString(ptr, len))),
			_crypto_hmac: (dataPtr, dataLen, keyPtr, keyLen, algPtr, algLen) => {
				const data = readString(dataPtr, dataLen);
				const key = readString(keyPtr, keyLen);
				const alg = readString(algPtr, algLen).toLowerCase();
				return writeString(hmacHex(key, data, alg === 'sha512' ? 'sha512' : 'sha256'));
			},
			_crypto_random_hex:   (count) => writeString(cryptoRandomHex(count)),
			_crypto_random_bytes: (count) => writeString(cryptoRandomBase64(count)),
			// No _crypto_hash_password / _crypto_verify_password: password hashing
			// is bcrypt and server-only (function-registry.toml hosts = ["server"]),
			// so a browser build that calls it fails at compile time.

			// ========== legacy _json_encode / _json_decode (browser-side) ==========
			// _json_encode round-trips through JSON.parse/stringify so the
			// caller can rely on normalized output; non-JSON strings are
			// encoded as JSON string values (matching server semantics).
			// _json_decode returns the input unchanged when it parses, or an
			// error object payload when it doesn't.
			_json_encode: (ptr, len) => {
				const input = readString(ptr, len);
				try {
					return writeString(JSON.stringify(JSON.parse(input)));
				} catch (_) {
					return writeString(JSON.stringify(input));
				}
			},
			_json_decode: (ptr, len) => {
				const input = readString(ptr, len);
				try {
					JSON.parse(input);
					return writeString(input);
				} catch (e) {
					return writeString(JSON.stringify({ error: e.message || 'parse failure' }));
				}
			},
			// ========== _json_*_v2 bridges and _json_get ==========
			// The boxed-Any layout of BOXED_ANY_ABI.md (12-byte tag+payload
			// boxes, JSON-tree array/object fragments) — see readBoxedAny /
			// writeBoxedAny. They co-exist with the legacy _json_encode /
			// _json_decode bridges above, preserved for frame.server 2.9.5.
			//
			// Spec refs: foundation/spec/stdlib-reference.md §8,
			//            foundation/spec/platform/BOXED_ANY_ABI.md §3–§6,
			//            foundation/spec/platform/runtime-abi/v1.toml (JSON group).

			_json_encode_v2: (boxedAnyPtr) => writeString(JSON.stringify(readBoxedAny(boxedAnyPtr))),

			_json_encode_pretty_v2: (boxedAnyPtr) =>
				writeString(JSON.stringify(readBoxedAny(boxedAnyPtr), null, 2)),

			_json_decode_v2: (bytesPtr, len) => {
				// Returns 0 (null sentinel) on JSON.parse failure — never throws.
				// The compiler emits a post-call null-check per BOXED_ANY_ABI §6.
				let parsed;
				try {
					parsed = JSON.parse(readString(bytesPtr, len));
				} catch (_) {
					return 0;
				}
				return writeBoxedAny(parsed);
			},

			// _json_get(source: any, path: LP string) -> any. A string source
			// holds JSON text and is parsed; any other box is walked as it is.
			// Returns the leaf as a typed box, or a null-tag box when the path
			// does not resolve (runtime-abi/v1.toml).
			_json_get: (sourcePtr, pathPtr) => {
				const path = readLPString(pathPtr);
				let source = sourcePtr === 0 ? null : readBoxedAny(sourcePtr);
				if (typeof source === 'string') {
					try {
						source = JSON.parse(source);
					} catch (_) {
						source = null;
					}
				}
				const leaf = source === null ? undefined : jsonGetPath(source, path);
				return writeBoxedAny(leaf === undefined ? null : leaf);
			},

			// List operations — layout: [length:i32][capacity:i32][type_id:i32][pad:i32][elements...]
			// A full list (length == capacity) is left as it is, like
			// clean-server: writing past the capacity would overwrite whatever
			// the heap holds after the list.
			'list.push_f64': (listPtr, value) => {
				const dv = new DataView(memory.buffer);
				const len = dv.getInt32(listPtr, true);
				const capacity = dv.getInt32(listPtr + 4, true);
				if (len >= capacity) {
					console.error('[frame.ui] list.push_f64: list is full (length=' + len + ', capacity=' + capacity + ')');
					return listPtr;
				}
				dv.setFloat64(listPtr + 16 + len * 8, value, true);
				dv.setInt32(listPtr, len + 1, true);
				return listPtr;
			},

			// ========== §FEXT-1: Drag Data Transfer ==========
			// Stores drag transfer data for the current drag operation.
			// Called from ondragstart handlers; read in ondrop handlers.

			_ui_set_drag_data: (keyPtr, keyLen, valPtr, valLen) => {
				if (!window.__cleanDragData) window.__cleanDragData = {};
				window.__cleanDragData[readString(keyPtr, keyLen)] = readString(valPtr, valLen);
				return 0;
			},

			_ui_get_drag_data: (keyPtr, keyLen) => {
				const data = window.__cleanDragData || {};
				return writeString(data[readString(keyPtr, keyLen)] || '');
			},

			// ========== §FEXT-1: Extended Event Data Accessor ==========
			// Returns a JSON string with all fields for the current event.
			// Covers drag, pointer, wheel, and scroll event families.
			// Handlers access event fields via ui.eventDataJson() then json.get().

			_ui_event_data_json: () => {
				if (!currentEvent) return writeString('{}');
				const e = currentEvent;
				const type = e.type;
				if (type === 'contextmenu') {
					return writeString(JSON.stringify({
						clientX: e.clientX || 0, clientY: e.clientY || 0,
						offsetX: e.offsetX || 0, offsetY: e.offsetY || 0,
						targetId: (e.target && e.target.id) || '',
						ctrlKey: e.ctrlKey || false,
						shiftKey: e.shiftKey || false,
						altKey: e.altKey || false
					}));
				}
				if (type.startsWith('drag') || type === 'drop') {
					return writeString(JSON.stringify({
						clientX: e.clientX || 0, clientY: e.clientY || 0,
						offsetX: e.offsetX || 0, offsetY: e.offsetY || 0,
						targetId: (e.target && e.target.id) || '',
						dataKey: '', dataValue: ''
					}));
				}
				if (type.startsWith('pointer')) {
					return writeString(JSON.stringify({
						clientX: e.clientX || 0, clientY: e.clientY || 0,
						offsetX: e.offsetX || 0, offsetY: e.offsetY || 0,
						pointerId: e.pointerId || 0,
						pressure: e.pressure || 0,
						pointerType: e.pointerType || 'mouse'
					}));
				}
				if (type === 'wheel') {
					return writeString(JSON.stringify({
						deltaX: e.deltaX || 0, deltaY: e.deltaY || 0,
						deltaMode: e.deltaMode || 0,
						clientX: e.clientX || 0, clientY: e.clientY || 0,
						ctrlKey: e.ctrlKey || false
					}));
				}
				if (type === 'scroll') {
					const el = e.target;
					return writeString(JSON.stringify({
						scrollX: el ? el.scrollLeft : 0,
						scrollY: el ? el.scrollTop : 0,
						targetId: (el && el.id) || ''
					}));
				}
				return writeString('{}');
			},

			// ========== §FEXT-2: DOM Query Functions (browser-only) ==========
			// Server stubs return "" for these functions (see cross-component prompt).

			_ui_get_bounds: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				const r = el.getBoundingClientRect();
				return writeString(JSON.stringify({
					x: r.x, y: r.y, width: r.width, height: r.height,
					top: r.top, left: r.left, right: r.right, bottom: r.bottom
				}));
			},

			_ui_get_offset_bounds: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				return writeString(JSON.stringify({
					x: el.offsetLeft, y: el.offsetTop,
					width: el.offsetWidth, height: el.offsetHeight,
					top: el.offsetTop, left: el.offsetLeft,
					right: el.offsetLeft + el.offsetWidth,
					bottom: el.offsetTop + el.offsetHeight
				}));
			},

			_ui_get_scroll: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				return writeString(JSON.stringify({
					scrollX: el.scrollLeft, scrollY: el.scrollTop,
					scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight
				}));
			},

			_ui_set_scroll: (selectorPtr, selectorLen, x, y) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) { el.scrollLeft = x; el.scrollTop = y; }
				return 0;
			},

			_ui_query_all: (selectorPtr, selectorLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const els = Array.from(document.querySelectorAll(selector));
				const paths = els.map(el => {
					if (el.id) return '#' + el.id;
					let path = el.tagName.toLowerCase();
					if (el.parentElement) {
						const siblings = Array.from(el.parentElement.children);
						const idx = siblings.indexOf(el) + 1;
						path = el.tagName.toLowerCase() + ':nth-child(' + idx + ')';
					}
					return path;
				});
				return writeString(JSON.stringify(paths));
			},

			_ui_get_computed_style: (selectorPtr, selectorLen, propPtr, propLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (!el) return writeString('');
				return writeString(getComputedStyle(el).getPropertyValue(readString(propPtr, propLen)) || '');
			},

			// ========== §FEXT-3: iframe Communication Bridge (browser-only) ==========

			_ui_iframe_send: (selectorPtr, selectorLen, msgPtr, msgLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el && el.contentWindow) {
					el.contentWindow.postMessage(readString(msgPtr, msgLen), '*');
				}
				return 0;
			},

			_ui_iframe_on_message: (handlerPtr, handlerLen) => {
				const handlerName = readString(handlerPtr, handlerLen);
				window.__cleanIframeHandler = handlerName;
				if (!window.__cleanIframeListenerAdded) {
					window.__cleanIframeListenerAdded = true;
					// Only messages from this page's own origin (its cl-preview
					// iframes and same-origin frames) reach the handler; any
					// other window could post to this page.
					window.addEventListener('message', (e) => {
						const name = window.__cleanIframeHandler;
						if (!name) return;
						if (e.origin !== window.location.origin) return;
						invokeExport(name, 'iframe message', writeString(e.origin),
							writeString(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)));
					});
				}
				return 0;
			},

			_ui_iframe_get_bounds: (iframeSelPtr, iframeSelLen, innerSelPtr, innerSelLen) => {
				const iframe = document.querySelector(readString(iframeSelPtr, iframeSelLen));
				if (!iframe || !iframe.contentDocument) return writeString('');
				try {
					const el = iframe.contentDocument.querySelector(readString(innerSelPtr, innerSelLen));
					if (!el) return writeString('');
					const r = el.getBoundingClientRect();
					return writeString(JSON.stringify({
						x: r.x, y: r.y, width: r.width, height: r.height,
						top: r.top, left: r.left, right: r.right, bottom: r.bottom
					}));
				} catch (_) {
					return writeString('');
				}
			},

			_ui_iframe_inject: (selectorPtr, selectorLen, scriptPtr, scriptLen) => {
				const iframe = document.querySelector(readString(selectorPtr, selectorLen));
				if (!iframe || !iframe.contentDocument) return 0;
				try {
					const script = iframe.contentDocument.createElement('script');
					script.textContent = readString(scriptPtr, scriptLen);
					iframe.contentDocument.head.appendChild(script);
					return 1;
				} catch (_) {
					return 0;
				}
			},

			// ========== §FEXT-5: Incremental DOM Patching ==========
			// Diffs the current DOM subtree at selector against newHtml and applies
			// only the mutations needed to bring it into agreement.

			_ui_patch: (selectorPtr, selectorLen, newHtmlPtr, newHtmlLen) => {
				const root = document.querySelector(readString(selectorPtr, selectorLen));
				if (!root) return -1;
				const newHtml = readString(newHtmlPtr, newHtmlLen);
				const tmp = document.createElement('div');
				tmp.innerHTML = newHtml;
				patchNode(root, tmp);
				normalizeEventAttributes(root);
				return 0;
			},

			// ========== Keyboard Shortcuts ==========

			_ui_shortcut_register: (keysPtr, keysLen, handlerPtr, handlerLen, scopePtr, scopeLen) => {
				const keys = readString(keysPtr, keysLen).toLowerCase();
				const handlerName = readString(handlerPtr, handlerLen);
				const scope = readString(scopePtr, scopeLen);

				const parts = keys.split('+');
				const keyName = parts[parts.length - 1];
				const needsCtrl = parts.includes('ctrl');
				const needsMeta = parts.includes('meta');
				const needsMod = parts.includes('mod');
				const needsShift = parts.includes('shift');
				const needsAlt = parts.includes('alt');

				const isMac = typeof navigator !== 'undefined' && !/Win|Linux/.test(navigator.platform);

				const KEY_ALIASES = {
					'escape': 'Escape', 'delete': 'Delete', 'backspace': 'Backspace',
					'enter': 'Enter', 'tab': 'Tab', 'space': ' '
				};
				const resolvedKey = KEY_ALIASES[keyName] || keyName;

				if (!window.__cleanShortcuts) {
					window.__cleanShortcuts = new Map();
					window.__cleanShortcutIdCounter = 0;
					document.addEventListener('keydown', (e) => {
						for (const [, reg] of window.__cleanShortcuts) {
							let modifierMatch;
							if (reg.needsMod) {
								modifierMatch = (isMac ? e.metaKey : e.ctrlKey) &&
									(reg.needsShift === e.shiftKey) &&
									(reg.needsAlt === e.altKey);
							} else {
								modifierMatch = (reg.needsCtrl === e.ctrlKey) &&
									(reg.needsMeta === e.metaKey) &&
									(reg.needsShift === e.shiftKey) &&
									(reg.needsAlt === e.altKey);
							}

							if (!modifierMatch) continue;
							if (e.key !== reg.resolvedKey) continue;

							if (reg.scope !== 'global') {
								const active = document.activeElement;
								if (!active || !active.closest(reg.scope)) continue;
							}

							e.preventDefault();
							currentEvent = e;
							currentEventTarget = e.target;
							try {
								invokeExport(reg.handlerName, 'shortcut');
							} finally {
								currentEvent = null;
								currentEventTarget = null;
							}
						}
					});
				}

				const id = ++window.__cleanShortcutIdCounter;
				window.__cleanShortcuts.set(id, {
					resolvedKey,
					needsCtrl, needsMeta, needsMod, needsShift, needsAlt,
					handlerName, scope
				});

				return id;
			},

			_ui_shortcut_remove: (id) => {
				if (window.__cleanShortcuts) window.__cleanShortcuts.delete(id);
			},

			_ui_shortcut_clear: () => {
				if (window.__cleanShortcuts) window.__cleanShortcuts.clear();
			},

			// ========== CSS Variable Manipulation ==========

			_ui_set_css_var: (namePtr, nameLen, valPtr, valLen) => {
				document.documentElement.style.setProperty(
					readString(namePtr, nameLen),
					readString(valPtr, valLen)
				);
			},

			_ui_set_css_var_on: (selectorPtr, selectorLen, namePtr, nameLen, valPtr, valLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.style.setProperty(readString(namePtr, nameLen), readString(valPtr, valLen));
			},

			_ui_get_css_var: (namePtr, nameLen) => {
				const val = getComputedStyle(document.documentElement)
					.getPropertyValue(readString(namePtr, nameLen)).trim();
				return writeString(val);
			},

			_ui_apply_css_vars: (jsonPtr, jsonLen) => {
				let tokens;
				try { tokens = JSON.parse(readString(jsonPtr, jsonLen)); } catch (_) { return; }
				const root = document.documentElement;
				for (const [k, v] of Object.entries(tokens)) {
					root.style.setProperty(k, String(v));
				}
			},

			// ========== Focus Management ==========

			_ui_focus: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.focus();
			},

			_ui_blur: (selectorPtr, selectorLen) => {
				const el = document.querySelector(readString(selectorPtr, selectorLen));
				if (el) el.blur();
			},

			_ui_get_focus: () => {
				const el = document.activeElement;
				if (!el || el === document.body) return writeString('');
				if (el.id) return writeString('#' + el.id);
				if (el.parentElement) {
					const siblings = Array.from(el.parentElement.children);
					const idx = siblings.indexOf(el) + 1;
					return writeString(el.tagName.toLowerCase() + ':nth-child(' + idx + ')');
				}
				return writeString(el.tagName.toLowerCase());
			},

			_ui_focus_trap: (selectorPtr, selectorLen) => {
				const container = document.querySelector(readString(selectorPtr, selectorLen));
				if (!container) return 0;

				const restoreTarget = document.activeElement;
				const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

				const handler = (e) => {
					if (e.key !== 'Tab') return;
					const focusable = Array.from(container.querySelectorAll(FOCUSABLE)).filter(el => !el.closest('[hidden]'));
					if (focusable.length === 0) { e.preventDefault(); return; }
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					if (e.shiftKey) {
						if (document.activeElement === first) { e.preventDefault(); last.focus(); }
					} else {
						if (document.activeElement === last) { e.preventDefault(); first.focus(); }
					}
				};

				container.addEventListener('keydown', handler);
				if (!window.__cleanFocusTraps) {
					window.__cleanFocusTraps = new Map();
					window.__cleanFocusTrapIdCounter = 0;
				}
				const id = ++window.__cleanFocusTrapIdCounter;
				window.__cleanFocusTraps.set(id, { container, handler, restoreTarget });
				return id;
			},

			_ui_focus_trap_release: (id) => {
				if (!window.__cleanFocusTraps) return;
				const trap = window.__cleanFocusTraps.get(id);
				if (!trap) return;
				trap.container.removeEventListener('keydown', trap.handler);
				if (trap.restoreTarget && trap.restoreTarget.focus) trap.restoreTarget.focus();
				window.__cleanFocusTraps.delete(id);
			},

			// ========== Browser Storage ==========

			_storage_local_get: (keyPtr, keyLen) => {
				return writeString(localStorage.getItem(readString(keyPtr, keyLen)) ?? '');
			},

			_storage_local_set: (keyPtr, keyLen, valPtr, valLen) => {
				localStorage.setItem(readString(keyPtr, keyLen), readString(valPtr, valLen));
			},

			_storage_local_remove: (keyPtr, keyLen) => {
				localStorage.removeItem(readString(keyPtr, keyLen));
			},

			_storage_local_clear: () => {
				localStorage.clear();
			},

			_storage_session_get: (keyPtr, keyLen) => {
				return writeString(sessionStorage.getItem(readString(keyPtr, keyLen)) ?? '');
			},

			_storage_session_set: (keyPtr, keyLen, valPtr, valLen) => {
				sessionStorage.setItem(readString(keyPtr, keyLen), readString(valPtr, valLen));
			},

			_storage_session_remove: (keyPtr, keyLen) => {
				sessionStorage.removeItem(readString(keyPtr, keyLen));
			},

			_storage_session_clear: () => {
				sessionStorage.clear();
			},

			// ========== File Download ==========

			_ui_download_text: (filenamePtr, filenameLen, contentPtr, contentLen, mimePtr, mimeLen) => {
				const filename = readString(filenamePtr, filenameLen);
				const content = readString(contentPtr, contentLen);
				const mimeType = readString(mimePtr, mimeLen) || 'text/plain';
				const blob = new Blob([content], { type: mimeType });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = filename;
				a.style.display = 'none';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				setTimeout(() => URL.revokeObjectURL(url), 0);
			},

			_ui_download_url: (urlPtr, urlLen, filenamePtr, filenameLen) => {
				const a = document.createElement('a');
				a.href = readString(urlPtr, urlLen);
				a.download = readString(filenamePtr, filenameLen);
				a.style.display = 'none';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			},

			// ========== Clipboard API (async with callbacks) ==========

			_ui_clipboard_write_cb: (textPtr, textLen, successPtr, successLen, errorPtr, errorLen) => {
				const text = readString(textPtr, textLen);
				const successName = readString(successPtr, successLen);
				const errorName = readString(errorPtr, errorLen);
				navigator.clipboard.writeText(text).then(() => {
					if (successName) invokeExport(successName, 'clipboard write');
				}, (e) => {
					if (errorName) invokeExport(errorName, 'clipboard write', writeString((e && e.message) || 'clipboard write failed'));
				});
			},

			_ui_clipboard_read_cb: (successPtr, successLen, errorPtr, errorLen) => {
				const successName = readString(successPtr, successLen);
				const errorName = readString(errorPtr, errorLen);
				navigator.clipboard.readText().then((text) => {
					if (successName) invokeExport(successName, 'clipboard read', writeString(text));
				}, (e) => {
					if (errorName) invokeExport(errorName, 'clipboard read', writeString((e && e.message) || 'clipboard read failed'));
				});
			},

			// ========== HTTP fetch with custom headers (async with callback) ==========

			_ui_fetch_cb: (urlPtr, urlLen, methodPtr, methodLen, headersPtr, headersLen, bodyPtr, bodyLen, handlerPtr, handlerLen) => {
				if (typeof fetch !== 'function') {
					console.warn('[frame.ui] _ui_fetch_cb: window.fetch not available');
					return 0;
				}
				const url = readString(urlPtr, urlLen);
				const method = readString(methodPtr, methodLen) || 'GET';
				const headersJson = readString(headersPtr, headersLen);
				const body = readString(bodyPtr, bodyLen);
				const handlerName = readString(handlerPtr, handlerLen);
				let headers = {};
				if (headersJson) {
					try {
						const parsed = JSON.parse(headersJson);
						if (parsed && typeof parsed === 'object') headers = parsed;
					} catch (e) {
						console.warn('[frame.ui] _ui_fetch_cb: invalid headers JSON: ' + (e.message || e));
					}
				}
				const init = { method, headers };
				const upperMethod = method.toUpperCase();
				if (body && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
					init.body = body;
				}
				const invoke = (status, responseBody) => {
					if (!handlerName) return;
					invokeExport(handlerName, '_ui_fetch_cb', status | 0, writeString(responseBody == null ? '' : String(responseBody)));
				};
				// The handler runs exactly once: a failure inside it is reported
				// by invokeExport, never routed to the fetch-failure branch.
				fetch(url, init).then((res) => {
					const status = res.status;
					res.text().then((text) => invoke(status, text), (e) => {
						invoke(status, e && e.message ? e.message : '');
					});
				}, (e) => {
					invoke(0, e && e.message ? e.message : 'fetch failed');
				});
				return 1;
			},

			// ========== Resize and Intersection Observers ==========

			_ui_resize_observe: (selectorPtr, selectorLen, handlerPtr, handlerLen) => {
				const selector = readString(selectorPtr, selectorLen);
				const handlerName = readString(handlerPtr, handlerLen);
				const el = document.querySelector(selector);
				if (!el) {
					console.warn('[frame.ui] _ui_resize_observe: no element matched "' + selector + '"');
					return 0;
				}
				if (!window.__cleanResizeObservers) window.__cleanResizeObservers = new Map();
				const id = (window.__cleanResizeObserverIdCounter = (window.__cleanResizeObserverIdCounter || 0) + 1);
				const observer = new ResizeObserver((entries) => {
					for (const entry of entries) {
						invokeExport(handlerName, 'resize observer', writeString(JSON.stringify({
							width: entry.contentRect.width,
							height: entry.contentRect.height,
							selector
						})));
					}
				});
				observer.observe(el);
				window.__cleanResizeObservers.set(id, observer);
				return id;
			},

			_ui_resize_unobserve: (id) => {
				if (!window.__cleanResizeObservers) return;
				const observer = window.__cleanResizeObservers.get(id);
				if (observer) {
					observer.disconnect();
					window.__cleanResizeObservers.delete(id);
				}
			},

			_ui_intersect_observe: (selectorPtr, selectorLen, handlerPtr, handlerLen, threshold) => {
				const selector = readString(selectorPtr, selectorLen);
				const handlerName = readString(handlerPtr, handlerLen);
				const el = document.querySelector(selector);
				if (!el) {
					console.warn('[frame.ui] _ui_intersect_observe: no element matched "' + selector + '"');
					return 0;
				}
				if (!window.__cleanIntersectObservers) window.__cleanIntersectObservers = new Map();
				const id = (window.__cleanIntersectObserverIdCounter = (window.__cleanIntersectObserverIdCounter || 0) + 1);
				const observer = new IntersectionObserver((entries) => {
					for (const entry of entries) {
						invokeExport(handlerName, 'intersection observer', writeString(JSON.stringify({
							selector,
							ratio: entry.intersectionRatio,
							isVisible: entry.isIntersecting
						})));
					}
				}, { threshold: [threshold] });
				observer.observe(el);
				window.__cleanIntersectObservers.set(id, observer);
				return id;
			},

			_ui_intersect_unobserve: (id) => {
				if (!window.__cleanIntersectObservers) return;
				const observer = window.__cleanIntersectObservers.get(id);
				if (observer) {
					observer.disconnect();
					window.__cleanIntersectObservers.delete(id);
				}
			},

			// ========== Toast / Notification System ==========

			_ui_toast: (textPtr, textLen, variantPtr, variantLen, duration, positionPtr, positionLen) => {
				const text = readString(textPtr, textLen);
				const variant = readString(variantPtr, variantLen) || 'info';
				const position = readString(positionPtr, positionLen) || 'bottom-right';

				if (!window.__cleanToastStyleInjected) {
					window.__cleanToastStyleInjected = true;
					const style = document.createElement('style');
					style.textContent = '.toast{background:var(--color-surface-raised,#fff);color:var(--color-text-primary,#111);border-radius:var(--radius-md,6px);box-shadow:var(--shadow-sm,0 2px 8px rgba(0,0,0,.15));padding:12px 16px;margin:8px;display:flex;align-items:center;gap:8px;animation:toast-in 150ms ease}.toast--success{background:var(--color-success-surface,var(--color-brand-primary,#22c55e))}.toast--error{background:var(--color-error-surface,#ef4444)}.toast--warning{background:var(--color-warning-surface,#f59e0b)}#toast-container{position:fixed;z-index:9999;display:flex;flex-direction:column}#toast-container.bottom-right{bottom:16px;right:16px}#toast-container.top-right{top:16px;right:16px}#toast-container.bottom-center{bottom:16px;left:50%;transform:translateX(-50%)}#toast-container.top-center{top:16px;left:50%;transform:translateX(-50%)}#toast-container.bottom-left{bottom:16px;left:16px}#toast-container.top-left{top:16px;left:16px}@keyframes toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.toast__close{background:none;border:none;cursor:pointer;padding:0 4px;opacity:.7;font-size:1rem;line-height:1}';
					document.head.appendChild(style);
				}

				let container = document.getElementById('toast-container');
				if (!container) {
					container = document.createElement('div');
					container.id = 'toast-container';
					container.className = position;
					document.body.appendChild(container);
				} else if (!container.className) {
					container.className = position;
				}

				if (!window.__cleanToasts) window.__cleanToasts = new Map();
				const id = (window.__cleanToastIdCounter = (window.__cleanToastIdCounter || 0) + 1);

				const toast = document.createElement('div');
				toast.className = 'toast' + (variant ? ' toast--' + variant : '');
				toast.setAttribute('data-toast-id', String(id));

				const label = document.createElement('span');
				label.textContent = text;

				const closeBtn = document.createElement('button');
				closeBtn.className = 'toast__close';
				closeBtn.setAttribute('aria-label', 'Dismiss');
				closeBtn.textContent = '×';
				closeBtn.addEventListener('click', () => dismissToast(id));

				toast.appendChild(label);
				toast.appendChild(closeBtn);
				container.appendChild(toast);

				window.__cleanToasts.set(id, toast);

				if (duration > 0) {
					setTimeout(() => dismissToast(id), duration);
				}

				return id;
			},

			_ui_toast_dismiss: (id) => {
				dismissToast(id);
			},

			_ui_toast_dismiss_all: () => {
				if (!window.__cleanToasts) return;
				for (const id of Array.from(window.__cleanToasts.keys())) {
					dismissToast(id);
				}
			},

			// ========== §14: Client-Side Navigation and History API ==========

			_ui_navigate: (pathPtr, pathLen) => {
				navigate(readString(pathPtr, pathLen), false);
			},

			_ui_history_push: (pathPtr, pathLen, titlePtr, titleLen) => {
				window.history.pushState({}, readString(titlePtr, titleLen), readString(pathPtr, pathLen));
			},

			_ui_history_replace: (pathPtr, pathLen, titlePtr, titleLen) => {
				window.history.replaceState({}, readString(titlePtr, titleLen), readString(pathPtr, pathLen));
			},

			_ui_history_back: () => {
				window.history.back();
			},

			_ui_history_forward: () => {
				window.history.forward();
			},

			_ui_current_path: () => {
				return writeString(window.location.pathname + window.location.search);
			},

			// ========== frame.locale — browser i18n ==========
			// Translation lookup, plural selection, number/currency/date formatting.
			// Translation bundles are loaded by the SSR renderer as window.__CLEAN_I18N__
			// = Record<localeCode, Record<key, string | {zero,one,two,few,many,other}>>.
			// All 7 functions are hosts=["all"] — they run in both server and browser.
			// _i18n_load (hosts=["server"]) stays in the server-guard stubs below.

			_i18n_locale: () => {
				// Returns the active locale from the document's lang attribute.
				// Falls back to 'en' when the attribute is absent or empty.
				const locale = document.documentElement.lang || 'en';
				return writeString(locale);
			},

			_i18n_set_locale: (localePtr, localeLen) => {
				// Sets the active locale on the document root element.
				// Automatically configures LTR/RTL directionality based on the
				// primary language tag. Fires a cl-locale-change custom event so
				// that reactive components can re-render their translated strings.
				const locale = readString(localePtr, localeLen);
				const rtlTags = new Set(['ar', 'he', 'fa', 'ur', 'ku', 'dv', 'ps']);
				const primaryTag = locale.split('-')[0].toLowerCase();
				document.documentElement.lang = locale;
				document.documentElement.dir = rtlTags.has(primaryTag) ? 'rtl' : 'ltr';
				window.dispatchEvent(new CustomEvent('cl-locale-change', { detail: { locale } }));
			},

			_i18n_t: (keyPtr, keyLen, argsPtr, argsLen) => {
				// Translates a dot-separated key using the window.__CLEAN_I18N__ bundle.
				// Falls back: active locale → document lang → 'en' → key verbatim.
				// argsPtr/argsLen is a JSON object string for {placeholder} substitution.
				const key = readString(keyPtr, keyLen);
				const argsStr = readString(argsPtr, argsLen);
				const bundles = window.__CLEAN_I18N__ ?? {};
				const locale = document.documentElement.lang || 'en';
				const fallback = 'en';

				const resolveKey = (bundle, dotKey) => {
					// Walk dot-separated key path into the bundle object.
					const parts = dotKey.split('.');
					let node = bundle;
					for (const part of parts) {
						if (node == null || typeof node !== 'object') return undefined;
						node = node[part];
					}
					// Accept a plain string value; reject objects (those are plural maps).
					return typeof node === 'string' ? node : undefined;
				};

				const substitute = (template, args) => {
					if (!args || typeof args !== 'object') return template;
					return template.replace(/\{(\w+)\}/g, (_, k) => (k in args ? String(args[k]) : `{${k}}`));
				};

				let args = {};
				if (argsStr && argsStr !== '{}') {
					try { args = JSON.parse(argsStr); } catch (_) { /* malformed JSON — use empty args */ }
				}

				const template =
					resolveKey(bundles[locale], key) ??
					resolveKey(bundles[fallback], key) ??
					key; // ultimate fallback: return the key verbatim

				return writeString(substitute(template, args));
			},

			_i18n_t_count: (keyPtr, keyLen, countArg, argsPtr, argsLen) => {
				// count is an i64 (function-registry.toml) — a BigInt at the
				// JS-WASM boundary. Plural selection works on a JS number.
				const count = Number(countArg);
				// Selects the correct plural form from the bundle, then substitutes.
				// Plural maps: key_zero / key_one / key_two / key_few / key_many / key_other
				// Uses Intl.PluralRules for CLDR-accurate category selection.
				// count is injected as {count} regardless of user-supplied args.
				const key = readString(keyPtr, keyLen);
				const argsStr = readString(argsPtr, argsLen);
				const bundles = window.__CLEAN_I18N__ ?? {};
				const locale = document.documentElement.lang || 'en';
				const fallback = 'en';

				const substitute = (template, args) => {
					if (!args || typeof args !== 'object') return template;
					return template.replace(/\{(\w+)\}/g, (_, k) => (k in args ? String(args[k]) : `{${k}}`));
				};

				const pickPluralKey = (bundle, baseKey, n) => {
					// Walk to the parent node then test CLDR suffixes.
					const parts = baseKey.split('.');
					let parent = bundle;
					for (const part of parts) {
						if (parent == null || typeof parent !== 'object') return undefined;
						parent = parent[part];
					}
					// parent is now the leaf — but plural keys live as siblings of the base key,
					// using the convention <lastSegment>_<category>. Re-walk from the grandparent.
					const grandParentParts = parts.slice(0, -1);
					const leafName = parts[parts.length - 1];
					let grandParent = bundle;
					for (const part of grandParentParts) {
						if (grandParent == null || typeof grandParent !== 'object') return undefined;
						grandParent = grandParent[part];
					}
					if (grandParent == null || typeof grandParent !== 'object') return undefined;

					// zero check first — explicit zero key takes priority over plural rules
					if (n === 0 && typeof grandParent[`${leafName}_zero`] === 'string') {
						return grandParent[`${leafName}_zero`];
					}

					let category;
					try {
						category = new Intl.PluralRules(locale).select(n);
					} catch (_) {
						category = n === 1 ? 'one' : 'other';
					}

					// Try the CLDR category, then fall back to _other.
					return (
						(typeof grandParent[`${leafName}_${category}`] === 'string'
							? grandParent[`${leafName}_${category}`]
							: undefined) ??
						(typeof grandParent[`${leafName}_other`] === 'string'
							? grandParent[`${leafName}_other`]
							: undefined)
					);
				};

				let args = {};
				if (argsStr && argsStr !== '{}') {
					try { args = JSON.parse(argsStr); } catch (_) { /* malformed JSON */ }
				}
				args.count = count; // always inject {count}

				const template =
					pickPluralKey(bundles[locale], key, count) ??
					pickPluralKey(bundles[fallback], key, count) ??
					key;

				return writeString(substitute(template, args));
			},

			_i18n_format_number: (value, localePtr, localeLen, optionsPtr, optionsLen) => {
				// Formats a number using Intl.NumberFormat.
				// locale: BCP 47 string — empty string uses the document's active locale.
				// options: JSON object string matching Intl.NumberFormat options.
				const localeStr = readString(localePtr, localeLen) || document.documentElement.lang || 'en';
				const optionsStr = readString(optionsPtr, optionsLen);
				let options = {};
				if (optionsStr && optionsStr !== '{}') {
					try { options = JSON.parse(optionsStr); } catch (_) { /* use empty options */ }
				}
				try {
					return writeString(new Intl.NumberFormat(localeStr, options).format(value));
				} catch (_) {
					return writeString(String(value));
				}
			},

			_i18n_format_currency: (value, currencyPtr, currencyLen, localePtr, localeLen) => {
				// Formats a number as a currency amount using Intl.NumberFormat.
				// currency: ISO 4217 code (e.g. "USD", "EUR", "GBP").
				// locale: BCP 47 string — empty string uses the document's active locale.
				const currency = readString(currencyPtr, currencyLen);
				const localeStr = readString(localePtr, localeLen) || document.documentElement.lang || 'en';
				try {
					return writeString(
						new Intl.NumberFormat(localeStr, { style: 'currency', currency }).format(value)
					);
				} catch (_) {
					// Fall back to plain number if the currency code is invalid or Intl fails.
					return writeString(String(value));
				}
			},

			_i18n_format_date: (timestampMs, formatPtr, formatLen, localePtr, localeLen) => {
				// Formats a Unix-millisecond timestamp using Intl.DateTimeFormat.
				// format: "short" | "medium" | "long" | "full"
				//   Custom CLDR patterns are not yet supported — they fall back to "medium"
				//   and emit a console.warn so developers know to use a named style.
				// locale: BCP 47 string — empty string uses the document's active locale.
				const format = readString(formatPtr, formatLen) || 'medium';
				const localeStr = readString(localePtr, localeLen) || document.documentElement.lang || 'en';
				const date = new Date(timestampMs);

				/** @type {Record<string, Intl.DateTimeFormatOptions>} */
				const styleMap = {
					short:  { dateStyle: 'short' },
					medium: { dateStyle: 'medium' },
					long:   { dateStyle: 'long' },
					full:   { dateStyle: 'full' },
				};

				let dtfOptions;
				if (format in styleMap) {
					dtfOptions = styleMap[format];
				} else {
					// CLDR pattern strings (e.g. "yyyy-MM-dd") are not supported by Intl.DateTimeFormat.
					// Log a warning and fall back to "medium" so the page remains functional.
					console.warn(
						`[frame.locale] Custom CLDR date pattern "${format}" is not supported in the browser. ` +
						'Use "short", "medium", "long", or "full". Falling back to "medium".'
					);
					dtfOptions = styleMap.medium;
				}

				try {
					return writeString(new Intl.DateTimeFormat(localeStr, dtfOptions).format(date));
				} catch (_) {
					return writeString(date.toLocaleDateString());
				}
			},

			// Console input — no-op stubs (browser has no console input)
			input:         (_ptr) => writeString(''),
			input_integer: (_ptr) => 0,
			input_float:   (_ptr) => 0.0,
			input_yesno:   (_ptr) => 0,
			input_range:   (_ptr, _a, _b, _c) => 0,

			// ========== §SERVER-GUARD: Server-only bridge stubs ==========
			// These functions are server-only (frame.server, frame.data, frame.auth,
			// frame.jobs, frame.mcp, frame.locale [_i18n_load only], and frame.ui SSR). They appear as
			// WASM imports when server-side modules (app/logic/, app/data/models/,
			// app/state/) are incorrectly included in the client build due to compiler
			// tree-shaking limitations (CLIENT_PULLS_SERVER). Providing stubs here
			// allows WebAssembly.instantiate to succeed; if any stub is actually called
			// at runtime, it throws a clear diagnostic error.
			...((() => {
				const _sg = (n) => () => { throw new Error(`[Frame] '${n}' is server-only and cannot run in the browser. A server-side module was incorrectly included in the client WASM build (CLIENT_PULLS_SERVER).`); };
				return {
					// frame.ui — server-only SSR rendering (hosts = ["server"])
					// _ui_render_page is declared in plugin.toml with hosts=["server"] and has
					// no browser implementation. When CLIENT_PULLS_SERVER pulls the preamble
					// SSR helpers (render/renderWith) into the client build, this import appears
					// in frontend.wasm and causes a WebAssembly.instantiate LinkError without
					// this stub. Fixed in v2.12.9.
					_ui_render_page: _sg('_ui_render_page'),

					// frame.server — routing & response
					_http_listen: _sg('_http_listen'),
					_http_route: _sg('_http_route'),
					_http_redirect_route: _sg('_http_redirect_route'),
					_http_route_protected: _sg('_http_route_protected'),
					_http_sse_route: _sg('_http_sse_route'),
					_http_ws_route: _sg('_http_ws_route'),
					_http_serve_static: _sg('_http_serve_static'),
					_http_respond: _sg('_http_respond'),
					_http_redirect: _sg('_http_redirect'),
					_http_set_header: _sg('_http_set_header'),
					_http_no_cache: _sg('_http_no_cache'),
					_http_set_cache: _sg('_http_set_cache'),
					_res_set_header: _sg('_res_set_header'),
					_res_redirect: _sg('_res_redirect'),
					_res_status: _sg('_res_status'),
					_res_body: _sg('_res_body'),
					_res_json: _sg('_res_json'),
					_res_download: _sg('_res_download'),
					// frame.server — request context
					_req_param: _sg('_req_param'),
					_req_param_int: _sg('_req_param_int'),
					_req_query: _sg('_req_query'),
					_req_header: _sg('_req_header'),
					_req_headers: _sg('_req_headers'),
					_req_body: _sg('_req_body'),
					_req_body_field: _sg('_req_body_field'),
					_req_form: _sg('_req_form'),
					_req_method: _sg('_req_method'),
					_req_path: _sg('_req_path'),
					_req_ip: _sg('_req_ip'),
					_req_cookie: _sg('_req_cookie'),
					// frame.server — WebSocket
					_ws_send: _sg('_ws_send'),
					_ws_broadcast: _sg('_ws_broadcast'),
					_ws_close: _sg('_ws_close'),
					_ws_client_id: _sg('_ws_client_id'),
					_ws_message: _sg('_ws_message'),
					_ws_room_join: _sg('_ws_room_join'),
					_ws_room_leave: _sg('_ws_room_leave'),
					_ws_room_broadcast: _sg('_ws_room_broadcast'),
					// frame.server — SSE
					_sse_emit: _sg('_sse_emit'),
					_sse_emit_event: _sg('_sse_emit_event'),
					_sse_close: _sg('_sse_close'),
					_sse_retry: _sg('_sse_retry'),
					_sse_is_connected: _sg('_sse_is_connected'),
					// frame.server — email
					_email_configure: _sg('_email_configure'),
					_email_send: _sg('_email_send'),
					_email_last_error: _sg('_email_last_error'),
					// frame.server — auth guards (server-side enforcement)
					_auth_require_auth: _sg('_auth_require_auth'),
					_auth_require_role: _sg('_auth_require_role'),
					_auth_can: _sg('_auth_can'),
					_auth_has_any_role: _sg('_auth_has_any_role'),
					_auth_get_session: _sg('_auth_get_session'),
					// frame.server — HTTP client (server-side outbound requests)
					http_get: _sg('http_get'),
					http_post: _sg('http_post'),
					http_put: _sg('http_put'),
					http_patch: _sg('http_patch'),
					http_delete: _sg('http_delete'),
					http_head: _sg('http_head'),
					http_options: _sg('http_options'),
					http_post_json: _sg('http_post_json'),
					http_put_json: _sg('http_put_json'),
					http_patch_json: _sg('http_patch_json'),
					http_post_form: _sg('http_post_form'),
					http_get_with_headers: _sg('http_get_with_headers'),
					http_post_with_headers: _sg('http_post_with_headers'),
					http_put_with_headers: _sg('http_put_with_headers'),
					http_patch_with_headers: _sg('http_patch_with_headers'),
					http_delete_with_headers: _sg('http_delete_with_headers'),
					// frame.server — JSON utilities
					// frame.data — database
					_db_query: _sg('_db_query'),
					_db_execute: _sg('_db_execute'),
					_db_begin: _sg('_db_begin'),
					_db_commit: _sg('_db_commit'),
					_db_rollback: _sg('_db_rollback'),
					_db_configure: _sg('_db_configure'),
					_db_register_migration: _sg('_db_register_migration'),
					_db_migration_diff: _sg('_db_migration_diff'),
					_db_run_migrations: _sg('_db_run_migrations'),
					_db_rollback_migration: _sg('_db_rollback_migration'),
					_db_migration_status: _sg('_db_migration_status'),
					_db_paginate: _sg('_db_paginate'),
					_db_cursor_page: _sg('_db_cursor_page'),
					_db_valid_field: _sg('_db_valid_field'),
					// frame.auth — JWT, sessions, roles
					_env_get: _sg('_env_get'),
					_jwt_sign: _sg('_jwt_sign'),
					_jwt_verify: _sg('_jwt_verify'),
					_jwt_decode: _sg('_jwt_decode'),
					_session_store: _sg('_session_store'),
					_session_get: _sg('_session_get'),
					_session_delete: _sg('_session_delete'),
					_session_exists: _sg('_session_exists'),
					_session_set_csrf: _sg('_session_set_csrf'),
					_session_get_csrf: _sg('_session_get_csrf'),
					_http_set_cookie: _sg('_http_set_cookie'),
					_roles_register: _sg('_roles_register'),
					_role_has_permission: _sg('_role_has_permission'),
					_role_get_permissions: _sg('_role_get_permissions'),
					_auth_set_session: _sg('_auth_set_session'),
					_auth_clear_session: _sg('_auth_clear_session'),
					_auth_user_id: _sg('_auth_user_id'),
					_auth_user_role: _sg('_auth_user_role'),
					// frame.jobs — background jobs & scheduling
					_job_register: _sg('_job_register'),
					_job_enqueue: _sg('_job_enqueue'),
					_job_enqueue_at: _sg('_job_enqueue_at'),
					_job_cancel: _sg('_job_cancel'),
					_job_status: _sg('_job_status'),
					_job_result: _sg('_job_result'),
					_job_current_id: _sg('_job_current_id'),
					_job_current_args: _sg('_job_current_args'),
					_job_current_attempt: _sg('_job_current_attempt'),
					_job_fail: _sg('_job_fail'),
					_job_succeed: _sg('_job_succeed'),
					_job_retry_after: _sg('_job_retry_after'),
					_schedule_cron: _sg('_schedule_cron'),
					_schedule_cancel: _sg('_schedule_cancel'),
					// frame.mcp — MCP server
					_mcp_http_accept: _sg('_mcp_http_accept'),
					_mcp_http_serve: _sg('_mcp_http_serve'),
					_mcp_log: _sg('_mcp_log'),
					_mcp_sse_send: _sg('_mcp_sse_send'),
					_mcp_stdio_read: _sg('_mcp_stdio_read'),
					_mcp_stdio_write: _sg('_mcp_stdio_write'),
					// frame.locale — _i18n_load is server-only (reads from disk); throw on browser call
					_i18n_load: _sg('_i18n_load'),
				};
			})()),

		}
	};

	// --- §14: Client-Side Navigation ---

	async function navigate(path, replaceState) {
		const main = document.querySelector('main') || document.querySelector('#app');
		if (!main) {
			window.location.href = path;
			return;
		}

		if (main.hasAttribute('data-cl-transition') || document.querySelector('[cl-transition]')) {
			main.classList.add('cl-leaving');
		}

		// The page is fetched once. An HTML answer is swapped in whatever its
		// status (a 404 or error page renders in place, a redirect lands on
		// its target URL); anything else cannot be shown in place, so the
		// browser navigates to it.
		let html;
		let finalPath = path;
		try {
			const res = await fetch(path, { headers: { 'X-Clean-Navigate': '1' } });
			const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
			if (type && type.indexOf('text/html') === -1) {
				window.location.href = path;
				return;
			}
			if (res.redirected && res.url) {
				const landed = new URL(res.url, window.location.href);
				if (landed.origin === window.location.origin) finalPath = landed.pathname + landed.search + landed.hash;
			}
			html = await res.text();
		} catch (_) {
			window.location.href = path;
			return;
		}

		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		const newMain = doc.querySelector('main') || doc.querySelector('#app');

		if (!newMain) {
			window.location.href = path;
			return;
		}

		if (replaceState) {
			window.history.replaceState({}, '', finalPath);
		} else {
			window.history.pushState({}, '', finalPath);
		}

		const tmp = document.createElement('div');
		tmp.innerHTML = newMain.innerHTML;
		patchNode(main, tmp);

		main.classList.remove('cl-leaving');
		main.classList.add('cl-entering');
		setTimeout(() => { main.classList.remove('cl-entering'); }, 150);

		window.scrollTo(0, 0);

		initStreamElements(main);
		initPreviewIframes(main);
		initNavigation();
		initErrorBoundaries(main);
	}

	function initNavigation() {
		if (window.__cleanNavInitialized) return;
		window.__cleanNavInitialized = true;

		document.addEventListener('click', (e) => {
			// Leave the click to the browser when a handler already took it,
			// for any button but the primary one, and with a modifier key
			// (open in a new tab / window, download).
			if (e.defaultPrevented) return;
			if (e.button !== undefined && e.button !== 0) return;
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			let el = e.target;
			while (el && el.tagName !== 'A') {
				el = el.parentElement;
			}
			if (!el) return;
			if (el.tagName !== 'A') return;
			if (el.target) return;
			if (el.hasAttribute('download')) return;
			if (el.hasAttribute('cl-external')) return;

			const href = el.getAttribute('href');
			if (!href) return;
			if (href.startsWith('#')) return;
			if (href.startsWith('mailto:') || href.startsWith('tel:')) return;

			let url;
			try {
				url = new URL(href, window.location.href);
			} catch (_) {
				return;
			}

			if (url.origin !== window.location.origin) return;
			// A link to a file (report.pdf, data.json, ...) is not a page.
			const last = url.pathname.split('/').pop();
			const dot = last.lastIndexOf('.');
			if (dot > 0 && !/^html?$/i.test(last.slice(dot + 1))) return;

			e.preventDefault();
			navigate(url.pathname + url.search + url.hash, false);
		});

		window.addEventListener('popstate', () => {
			navigate(window.location.pathname + window.location.search, true);
		});
	}

	// --- §16: Error Boundary ---

	function initErrorBoundaries(root) {
		const scope = root || document;
		scope.querySelectorAll('[data-fallback]').forEach(el => {
			el.addEventListener('cl-error', (e) => {
				renderBoundaryFallback(el, e.detail && e.detail.message ? e.detail.message : String(e.detail || ''));
			});
		});
	}

	function renderBoundaryFallback(el, errorMessage) {
		const componentName = el.getAttribute('data-component') || 'unknown';
		const fallback = el.getAttribute('data-fallback') || '';
		console.error('[Clean Error Boundary] ' + componentName + ': ' + errorMessage);
		el.innerHTML = fallback;
		el.classList.add('cl-error');
	}

	// The nearest error boundary enclosing el (el itself included).
	function findBoundary(el) {
		let cursor = el;
		while (cursor) {
			if (cursor.hasAttribute && cursor.hasAttribute('data-fallback')) return cursor;
			cursor = cursor.parentElement;
		}
		return null;
	}

	// An error thrown by _start() belongs to no single element: every error
	// boundary on the page shows its fallback. Returns how many there were.
	function renderStartupFailure(errorMessage) {
		const boundaries = document.querySelectorAll('[data-fallback]');
		boundaries.forEach(el => renderBoundaryFallback(el, errorMessage));
		return boundaries.length;
	}

	// --- §FEXT-4: cl-stream initialization (extracted for reuse by navigation) ---

	function initStreamElements(root) {
		const scope = root || document;
		scope.querySelectorAll('[data-cl-stream]').forEach(el => {
			if (el.__cleanEventSource) return;
			const url = el.getAttribute('data-cl-stream');
			if (!url) return;
			const es = new EventSource(url);
			es.onmessage = (ev) => { el.innerHTML = ev.data; };
			es.onerror = () => {};
			el.__cleanEventSource = es;
		});
	}

	// --- §FEXT-3: cl-preview initialization (extracted for reuse by navigation) ---

	function initPreviewIframes(root) {
		const scope = root || document;
		scope.querySelectorAll('iframe[data-cl-preview]').forEach(iframe => {
			if (iframe.__cleanPreviewInjected) return;
			iframe.__cleanPreviewInjected = true;
			const inject = () => {
				try {
					if (iframe.contentDocument) {
						const script = iframe.contentDocument.createElement('script');
						script.textContent = IFRAME_PREVIEW_SCRIPT;
						(iframe.contentDocument.head || iframe.contentDocument.documentElement).appendChild(script);
					}
				} catch (_) {}
			};
			if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
				inject();
			} else {
				iframe.addEventListener('load', inject);
			}
		});
	}

	function dismissToast(id) {
		if (!window.__cleanToasts) return;
		const toast = window.__cleanToasts.get(id);
		if (!toast) return;
		toast.style.transition = 'opacity 150ms ease, transform 150ms ease';
		toast.style.opacity = '0';
		toast.style.transform = 'translateY(8px)';
		setTimeout(() => {
			if (toast.parentNode) toast.parentNode.removeChild(toast);
			if (window.__cleanToasts) window.__cleanToasts.delete(id);
		}, 160);
	}

	// --- WASM Loading ---

	try {
		const response = await fetch(wasmPath);
		const bytes = await response.arrayBuffer();

		memStats.maxPages = parseMaxPages(bytes);

		// Companion runtimes (frame.client's frame-client.js, ...) are
		// <script>s after this one. Wait until the document is parsed — every
		// classic and deferred script before DOMContentLoaded has run — so
		// their registerEnv() calls are in before the imports are fixed,
		// however fast the WASM fetch was.
		if (typeof document !== 'undefined' && document.readyState === 'loading') {
			await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
		}

		// Merge companion-registered env imports into the bridge before
		// instantiation.
		if (typeof window !== 'undefined' && window.__cleanRuntime && window.__cleanRuntime._pendingEnv) {
			Object.assign(bridge.env, window.__cleanRuntime._pendingEnv);
		}

		const module = await WebAssembly.instantiate(bytes, bridge);
		instance = module.instance;
		memory = instance.exports.memory;
		memStats.lastBufferSize = memory.buffer.byteLength;

		// __heap_ptr is authoritative per MEMORY_POLICY.md §7.2.
		// A missing export means the module was compiled without the runtime heap setup —
		// falling back to a hardcoded offset would corrupt the data section.
		const heapPtrExport = instance.exports.__heap_ptr;
		if (!heapPtrExport || typeof heapPtrExport.value !== 'number') {
			throw new Error(
				'Frame UI: WASM module missing __heap_ptr export. ' +
				'Recompile with a compiler that emits the runtime heap pointer.'
			);
		}
		heapPtr = heapPtrExport.value;

		if (typeof window !== 'undefined' && window.__cleanRuntime) {
			// The skeleton was created at the top of this script.
			window.__cleanRuntime._providers.push(memoryStats);
			// Wire up the runtime accessors companion bridges need. Safe to
			// overwrite — the pre-instantiate bootstrap only had placeholders.
			window.__cleanRuntime.getInstance = () => instance;
			window.__cleanRuntime.getMemory = () => memory;
			window.__cleanRuntime.writeString = writeString;
			window.__cleanRuntime.readString = readString;
		}

		checkMemoryGrowth();

		// UI-B006 / UI-B007: dispatch declarative event attributes
		// (data-on-* / on<event>="handler") to the module's exports.
		initDeclarativeEvents();

		// Call _start — registers event handlers via _ui_on_event.
		// Wrapped in try/catch so an error during startup triggers the error boundary
		// for any component boundary element that is already in the DOM.
		try {
			if (instance.exports._start) {
				instance.exports._start();
			} else if (instance.exports.start) {
				instance.exports.start();
			}
		} catch (startErr) {
			const message = startErr.message || String(startErr);
			if (renderStartupFailure(message) === 0) {
				console.error('[Clean Error Boundary] start: ' + message);
			}
		}

		checkMemoryGrowth();

		// §FEXT-4: cl-stream — open EventSource connections for elements with data-cl-stream.
		initStreamElements(document);

		// §FEXT-3: cl-preview — inject selection runtime script into preview iframes.
		initPreviewIframes(document);

		// §14: Client-side navigation — intercept same-origin link clicks.
		initNavigation();

		// §16: Error boundaries — attach cl-error listeners to data-fallback elements.
		initErrorBoundaries(document);

	} catch (err) {
		console.error('Frame UI Loader Error:', err);
	}
})();
