/**
 * test_json_v2.mjs — Unit tests for the _json_encode_v2, _json_encode_pretty_v2, _json_get,
 * and _json_decode_v2 browser-runtime bridge functions.
 *
 * This file ports the algorithm from runtime/loader.js into a hermetic Node.js
 * harness backed by a real WebAssembly.Memory instance. No compiler, no WASM
 * binary, and no browser globals are required — the bridge logic is what's
 * under test here.
 *
 * IMPORTANT MAINTENANCE NOTE: Any change to the _json_encode_v2,
 * _json_encode_pretty_v2, _json_decode_v2 or _json_get implementations (and
 * the readBoxedAny / writeBoxedAny / jsonGetPath helpers they share) in
 * runtime/loader.js MUST be mirrored here. This duplication is intentional
 * and will be eliminated in [P4b] when we have a real WASM harness and the
 * canary runner (run_canaries.mjs) covers these bridges end-to-end.
 *
 * Spec refs:
 *   foundation/spec/platform/BOXED_ANY_ABI.md §3–§5
 *   foundation/spec/platform/MEMORY_MODEL.md §List / §Pairs / §String
 *   foundation/spec/platform/runtime-abi/v1.toml lines 1521–1546
 *
 * Exit 0 if all tests pass. Exit 1 with a failure summary otherwise.
 */

// ---------------------------------------------------------------------------
// Minimal fake WASM environment
// ---------------------------------------------------------------------------

const WASM_PAGE_SIZE = 65536;

// 4 initial pages = 256 KB. Enough for all test allocations; ensureCapacity
// grows it as needed.
const memory = new WebAssembly.Memory({ initial: 4 });

// heapPtr starts at 1024 (DATA_SECTION_START), safely above the null guard at 0.
// In the real loader this is initialised from __heap_ptr export after instantiation.
let heapPtr = 1024;

function checkMemoryGrowth() {
    // No-op in test harness (memory growth is observable but not logged).
}

function ensureCapacity(endOffset) {
    const currentBytes = memory.buffer.byteLength;
    if (endOffset <= currentBytes) return;
    const currentPages = currentBytes / WASM_PAGE_SIZE;
    const neededPages = Math.ceil(endOffset / WASM_PAGE_SIZE);
    const growBy = neededPages - currentPages;
    const growPages = Math.max(growBy * 2, 1);
    try {
        memory.grow(growPages);
    } catch (_) {
        memory.grow(growBy);
    }
}

function readString(ptr, len) {
    const bytes = new Uint8Array(memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
}

function writeString(str) {
    const bytes = new TextEncoder().encode(str);
    const ptr = heapPtr;
    const padding = (4 - (bytes.length % 4)) % 4;
    const totalSize = bytes.length + 4 + padding;
    ensureCapacity(ptr + totalSize);
    new DataView(memory.buffer).setUint32(ptr, bytes.length, true);
    new Uint8Array(memory.buffer, ptr, bytes.length + 4).set(bytes, 4);
    heapPtr += totalSize;
    return ptr;
}

// allocBytes: raw bump allocator for fixed-size blocks (boxed-Any, list/pairs headers).
// Ported from the allocBytes helper added to loader.js.
function allocBytes(size) {
    const padded = size + ((8 - (size % 8)) % 8);
    const p = heapPtr;
    ensureCapacity(p + padded);
    heapPtr += padded;
    return p;
}

// dv(): always returns a fresh DataView — required because memory may grow
// on any allocBytes/writeString call, invalidating prior DataView snapshots.
function dv() {
    return new DataView(memory.buffer);
}

// ---------------------------------------------------------------------------
// Bridge implementations (mirrored verbatim from loader.js)
// ---------------------------------------------------------------------------

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

function _json_encode_v2(boxedAnyPtr) {
	return writeString(JSON.stringify(readBoxedAny(boxedAnyPtr)));
}

function _json_encode_pretty_v2(boxedAnyPtr) {
	return writeString(JSON.stringify(readBoxedAny(boxedAnyPtr), null, 2));
}

function _json_decode_v2(bytesPtr, len) {
	// Returns 0 (null sentinel) on JSON.parse failure — never throws.
	// The compiler emits a post-call null-check per BOXED_ANY_ABI §6.
	let parsed;
	try {
		parsed = JSON.parse(readString(bytesPtr, len));
	} catch (_) {
		return 0;
	}
	return writeBoxedAny(parsed);
}

// _json_get(source: any, path: LP string) -> any. A string source
// holds JSON text and is parsed; any other box is walked as it is.
// Returns the leaf as a typed box, or a null-tag box when the path
// does not resolve (runtime-abi/v1.toml).
function _json_get(sourcePtr, pathPtr) {
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
}

// ---------------------------------------------------------------------------
// Test helpers — read back a decoded LP string result from memory
// ---------------------------------------------------------------------------

function readResultString(lpPtr) {
    // lpPtr points to a length-prefixed string written by writeString.
    return readLPString(lpPtr);
}

// Read the tag of a decoded boxed-Any result.
function readTag(ptr) {
    return dv().getInt32(ptr, true);
}

// Read the i32 at ptr+4 (value low word).
function readValueI32(ptr) {
    return dv().getInt32(ptr + 4, true);
}

// Read the i64 at ptr+4 as a JS number.
function readValueI64(ptr) {
    return Number(dv().getBigInt64(ptr + 4, true));
}

// Read the f64 at ptr+4.
function readValueF64(ptr) {
    return dv().getFloat64(ptr + 4, true);
}

// Read the LP string via the i32 pointer stored at ptr+4.
function readValueString(ptr) {
    const lpPtr = dv().getInt32(ptr + 4, true);
    return readLPString(lpPtr);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, extra) {
    if (condition) {
        console.log('PASS ' + name);
        passed++;
    } else {
        const msg = 'FAIL ' + name + (extra !== undefined ? ' — ' + extra : '');
        console.error(msg);
        failures.push(msg);
        failed++;
    }
}

function assertEq(name, actual, expected) {
    const ok = actual === expected;
    assert(name, ok, ok ? undefined : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// Helper: write a JSON string into WASM memory as a raw (non-LP) byte sequence
// and call _json_decode_v2(ptr, len). Returns the boxed-Any pointer.
function decode(jsonText) {
    const bytes = new TextEncoder().encode(jsonText);
    // Allocate raw bytes (no LP prefix — _json_decode_v2 takes (ptr, len)).
    const ptr = allocBytes(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return _json_decode_v2(ptr, bytes.length);
}

// Helper: build a boxed-Any in memory directly and encode it.
function encode(value) {
    const ptr = writeBoxedAny(value);
    const resultLp = _json_encode_v2(ptr);
    return readResultString(resultLp);
}

function encodePretty(value) {
    const ptr = writeBoxedAny(value);
    const resultLp = _json_encode_pretty_v2(ptr);
    return readResultString(resultLp);
}

// ---------------------------------------------------------------------------
// Tests — encode
// ---------------------------------------------------------------------------

assertEq('encode null',    encode(null),    'null');
assertEq('encode true',    encode(true),    'true');
assertEq('encode false',   encode(false),   'false');
assertEq('encode integer 42', encode(42), '42');
assertEq('encode Number.MAX_SAFE_INTEGER', encode(Number.MAX_SAFE_INTEGER), '9007199254740991');
assertEq('encode number 3.14', encode(3.14), '3.14');
assertEq('encode string "hello"', encode('hello'), '"hello"');

// String with embedded quotes and newline
const strWithSpecials = 'a"b\nc';
assertEq('encode string with quotes and newline', encode(strWithSpecials), JSON.stringify(strWithSpecials));

assertEq('encode empty array', encode([]), '[]');
assertEq('encode empty object', encode({}), '{}');

assertEq('encode array [1,"two",true,null]', encode([1, 'two', true, null]),
    '[1,"two",true,null]');

assertEq('encode object {a:1,b:"x"}', encode({ a: 1, b: 'x' }),
    '{"a":1,"b":"x"}');

assertEq('encode nested {a:[1,{b:2}]}', encode({ a: [1, { b: 2 }] }),
    '{"a":[1,{"b":2}]}');

// Pretty encode
assertEq('encode pretty {a:1}', encodePretty({ a: 1 }),
    JSON.stringify({ a: 1 }, null, 2));

// ---------------------------------------------------------------------------
// Tests — decode
// ---------------------------------------------------------------------------

{
    const ptr = decode('null');
    assert('decode "null" returns non-zero', ptr !== 0);
    assertEq('decode "null" tag', readTag(ptr), 0);
}

{
    const ptr = decode('true');
    assert('decode "true" returns non-zero', ptr !== 0);
    assertEq('decode "true" tag', readTag(ptr), 2);
    assertEq('decode "true" value', readValueI32(ptr), 1);
}

{
    const ptr = decode('false');
    assert('decode "false" returns non-zero', ptr !== 0);
    assertEq('decode "false" tag', readTag(ptr), 2);
    assertEq('decode "false" value', readValueI32(ptr), 0);
}

{
    const ptr = decode('42');
    assert('decode "42" returns non-zero', ptr !== 0);
    assertEq('decode "42" tag', readTag(ptr), 1); // integer path
    assertEq('decode "42" value', readValueI64(ptr), 42);
}

{
    const ptr = decode('3.14');
    assert('decode "3.14" returns non-zero', ptr !== 0);
    assertEq('decode "3.14" tag', readTag(ptr), 3); // float path
    // Floating-point round-trip comparison with tolerance
    const actual = readValueF64(ptr);
    assert('decode "3.14" value approx', Math.abs(actual - 3.14) < 1e-10,
        'got ' + actual);
}

{
    const ptr = decode('"hello"');
    assert('decode string "hello" returns non-zero', ptr !== 0);
    assertEq('decode string "hello" tag', readTag(ptr), 4);
    assertEq('decode string "hello" value', readValueString(ptr), 'hello');
}

{
    const ptr = decode('[1,2,3]');
    assert('decode array [1,2,3] returns non-zero', ptr !== 0);
    assertEq('decode array [1,2,3] tag', readTag(ptr), 5);
    const listPtr = dv().getInt32(ptr + 4, true);
    // JSON-tree Array (§3.2): count at offset 0, elem_ptrs at offset 4, stride 4.
    assertEq('decode array [1,2,3] count', dv().getInt32(listPtr, true), 3);
    for (let i = 0; i < 3; i++) {
        const elemPtr = dv().getInt32(listPtr + 4 + i * 4, true);
        assertEq('decode array [1,2,3] element ' + i + ' tag', readTag(elemPtr), 1);
        assertEq('decode array [1,2,3] element ' + i + ' value', readValueI64(elemPtr), i + 1);
    }
}

{
    const ptr = decode('{"a":1}');
    assert('decode object {"a":1} returns non-zero', ptr !== 0);
    assertEq('decode object {"a":1} tag', readTag(ptr), 6);
    const pairsPtr = dv().getInt32(ptr + 4, true);
    // JSON-tree Object (§3.3): count at offset 0, entries at offset 4, stride 8.
    assertEq('decode object {"a":1} count', dv().getInt32(pairsPtr, true), 1);
    const keyLpPtr = dv().getInt32(pairsPtr + 4, true);
    const valPtr   = dv().getInt32(pairsPtr + 4 + 4, true);
    assertEq('decode object {"a":1} key', readLPString(keyLpPtr), 'a');
    assertEq('decode object {"a":1} value tag', readTag(valPtr), 1);
    assertEq('decode object {"a":1} value', readValueI64(valPtr), 1);
}

// Failure cases — _json_decode_v2 must return 0
assertEq('decode malformed "[1,2," returns 0', decode('[1,2,'), 0);
assertEq('decode "not json" returns 0',        decode('not json'), 0);
assertEq('decode empty string returns 0',      decode(''), 0);

// ---------------------------------------------------------------------------
// Roundtrip test
// ---------------------------------------------------------------------------

{
    const original = { nested: { list: [1, 2, 3], nil: null, flag: true, pi: 3.14, str: 'hi' } };
    const originalJson = JSON.stringify(original);

    // Decode into WASM memory, then encode back to a JSON string.
    const decodedPtr = decode(originalJson);
    assert('roundtrip decode returns non-zero', decodedPtr !== 0);
    const encodedLp = _json_encode_v2(decodedPtr);
    const roundtripped = readResultString(encodedLp);

    // Compare stringified forms — structural equality, not pointer equality.
    assertEq('decode+encode roundtrip preserves structure',
        roundtripped,
        JSON.stringify(JSON.parse(originalJson)));
}

// ---------------------------------------------------------------------------
// Hand-built tag-5 boxed-Any encoding correctness
// ---------------------------------------------------------------------------

{
    // Build [42, "x", true, null] by hand as a JSON-tree Array fragment
    // ([count][elem_ptrs], stride 4, total 4 + count*4), then encode.
    const elems = [42, 'x', true, null];
    const elemPtrs = elems.map(writeBoxedAny);
    const listPtr = allocBytes(4 + elemPtrs.length * 4);
    dv().setInt32(listPtr, elemPtrs.length, true);
    for (let i = 0; i < elemPtrs.length; i++) {
        dv().setInt32(listPtr + 4 + i * 4, elemPtrs[i], true);
    }
    const boxedPtr = allocBytes(12);
    dv().setInt32(boxedPtr,     5, true);
    dv().setInt32(boxedPtr + 4, listPtr, true);
    dv().setInt32(boxedPtr + 8, 0, true);

    const resultLp = _json_encode_v2(boxedPtr);
    const result = readResultString(resultLp);
    assertEq('hand-built tag-5 array encodes correctly', result,
        JSON.stringify([42, 'x', true, null]));
}

// ---------------------------------------------------------------------------
// Hand-built tag-6 boxed-Any encoding preserves insertion order
// ---------------------------------------------------------------------------

{
    // Build {z: 1, a: 2} by hand as a JSON-tree Object fragment
    // ([count][(key_ptr, val_ptr) × count], stride 8, total 4 + count*8).
    // Insertion order is z then a; JSON.stringify must emit keys in the same order.
    const entries = [['z', 1], ['a', 2]];
    const encodedEntries = entries.map(([k, v]) => [writeString(k), writeBoxedAny(v)]);
    const pairsPtr = allocBytes(4 + encodedEntries.length * 8);
    dv().setInt32(pairsPtr, encodedEntries.length, true);
    for (let i = 0; i < encodedEntries.length; i++) {
        const [kp, vp] = encodedEntries[i];
        dv().setInt32(pairsPtr + 4 + i * 8,     kp, true);
        dv().setInt32(pairsPtr + 4 + i * 8 + 4, vp, true);
    }
    const boxedPtr = allocBytes(12);
    dv().setInt32(boxedPtr,     6, true);
    dv().setInt32(boxedPtr + 4, pairsPtr, true);
    dv().setInt32(boxedPtr + 8, 0, true);

    const resultLp = _json_encode_v2(boxedPtr);
    const result = readResultString(resultLp);
    // Must be z before a (insertion order, D3).
    assertEq('hand-built tag-6 object preserves insertion order (z before a)',
        result, '{"z":1,"a":2}');
}

// ---------------------------------------------------------------------------
// Compiler bit-for-bit compat: hardcode a JSON-tree Array fragment matching
// what __json_from_cln_list produces, without going through writeBoxedAny's
// container path. Confirms the encode-side offset math matches the compiler
// helpers in clean-language-compiler/src/stdlib/json_class.rs (§3.2).
// ---------------------------------------------------------------------------

{
    // Three tag-1 boxed-Any integer blocks (12 bytes each).
    const box1 = allocBytes(12);
    dv().setInt32(box1, 1, true); dv().setBigInt64(box1 + 4, 1n, true);
    const box2 = allocBytes(12);
    dv().setInt32(box2, 1, true); dv().setBigInt64(box2 + 4, 2n, true);
    const box3 = allocBytes(12);
    dv().setInt32(box3, 1, true); dv().setBigInt64(box3 + 4, 3n, true);

    // Compiler-format Array fragment: exactly [count=3, p1, p2, p3], no header.
    const arrPtr = allocBytes(4 + 3 * 4);
    dv().setInt32(arrPtr,      3,    true);
    dv().setInt32(arrPtr + 4,  box1, true);
    dv().setInt32(arrPtr + 8,  box2, true);
    dv().setInt32(arrPtr + 12, box3, true);

    // Boxed-Any tag-5 wrapper.
    const boxedPtr = allocBytes(12);
    dv().setInt32(boxedPtr,     5,      true);
    dv().setInt32(boxedPtr + 4, arrPtr, true);
    dv().setInt32(boxedPtr + 8, 0,      true);

    const resultLp = _json_encode_v2(boxedPtr);
    const result = readResultString(resultLp);
    assertEq('compiler-format tag-5 Array fragment ([1,2,3]) encodes bit-for-bit',
        result, '[1,2,3]');
}

// ---------------------------------------------------------------------------
// Tests — _json_get(source: any, path: LP string) -> any
// (runtime-abi/v1.toml: typed leaf, null-tag box on a miss)
// ---------------------------------------------------------------------------

function lpPath(path) {
    return writeString(path);
}

{
    const doc = '{"data":{"rows":[{"name":"Welcome","n":7},{"name":"Two"}]},"ok":true}';
    const tree = decode(doc);
    const text = writeBoxedAny(doc); // String-tagged box holding JSON text

    for (const [label, source] of [['tree', tree], ['text', text]]) {
        const name = _json_get(source, lpPath('data.rows.1.name'));
        assertEq(label + ': _json_get string leaf tag', readTag(name), 4);
        assertEq(label + ': _json_get string leaf value', readValueString(name), 'Two');

        const n = _json_get(source, lpPath('data.rows.0.n'));
        assertEq(label + ': _json_get integer leaf tag', readTag(n), 1);
        assertEq(label + ': _json_get integer leaf value', readValueI64(n), 7);

        const ok = _json_get(source, lpPath('ok'));
        assertEq(label + ': _json_get boolean leaf tag', readTag(ok), 2);

        const row = _json_get(source, lpPath('data.rows.0'));
        assertEq(label + ': _json_get object leaf encodes', readResultString(_json_encode_v2(row)),
            '{"name":"Welcome","n":7}');

        for (const missing of ['data.rows.9.name', 'data.missing', 'ok.child', 'data.rows.x']) {
            const miss = _json_get(source, lpPath(missing));
            assert(label + ': _json_get miss "' + missing + '" returns a box', miss !== 0);
            assertEq(label + ': _json_get miss "' + missing + '" is null-tag', readTag(miss), 0);
        }
    }

    assertEq('_json_get on a null source is null-tag', readTag(_json_get(0, lpPath('a'))), 0);
    const invalid = writeBoxedAny('not json');
    assertEq('_json_get on invalid JSON text is null-tag', readTag(_json_get(invalid, lpPath('a'))), 0);
    const numericKey = decode('{"0":"zero"}');
    assertEq('_json_get numeric segment on an object is a member name',
        readValueString(_json_get(numericKey, lpPath('0'))), 'zero');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
console.log('\n' + passed + '/' + total + ' tests passed' +
    (failed > 0 ? ' (' + failed + ' failed)' : '') + '.');

if (failed > 0) {
    console.error('\nFailed tests:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
process.exit(0);
