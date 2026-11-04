/**
 * Clean Canvas WASM Loader
 * Version: 2.1.0
 *
 * 2.1.0 (2026-11-04): JSON bridges — _json_encode_v2, _json_encode_pretty_v2,
 *   _json_decode_v2 and _json_get (stdlib-reference §8). Every json.* call,
 *   and the text of an `any` array or object, goes through them.
 *
 * Loads and runs Clean Language WASM modules with canvas bridge support.
 *
 * Usage:
 *   <script src="canvas-bridge.js"></script>
 *   <script src="loader.js"></script>
 *   <script>
 *     CleanCanvas.load('app.wasm').then(app => {
 *       app.start();
 *     });
 *   </script>
 */

(function() {
  'use strict';

  const WASM_PAGE_SIZE = 65536;

  // string_matches pattern table (function-registry.toml string_matches).
  const STRING_PATTERNS = [
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,                                   // 0 email
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/,                            // 1 url
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // 2 uuid
    /^\+?[0-9][0-9 ()-]{5,}[0-9]$/,                                     // 3 phone
    /^\d{4}-\d{2}-\d{2}$/,                                             // 4 date
    /^[+-]?\d+$/,                                                       // 5 integer
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/,                          // 6 number
    /^[a-zA-Z0-9]+$/,                                                   // 7 alphanumeric
  ];

  // Standard tier fallback per platform-architecture/MEMORY_POLICY.md §3
  const CANVAS_TIER_INITIAL_PAGES = 256;
  const CANVAS_TIER_MAX_PAGES = 1024;

  // --- WASM binary parsing (reads module's declared memory) ---
  // See platform-architecture/MEMORY_POLICY.md §6.2

  function _readULEB128(bytes, ref) {
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

  function _readWasmString(bytes, ref) {
    const len = _readULEB128(bytes, ref);
    const str = new TextDecoder().decode(bytes.subarray(ref.offset, ref.offset + len));
    ref.offset += len;
    return str;
  }

  function _readMemoryLimits(bytes, ref) {
    const flags = _readULEB128(bytes, ref);
    const initial = _readULEB128(bytes, ref);
    const max = (flags & 0x01) ? _readULEB128(bytes, ref) : null;
    return { initial, max };
  }

  function parseWasmMemoryDecl(wasmBuffer) {
    const bytes = new Uint8Array(wasmBuffer);
    if (bytes.length < 8) return null;
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;

    const ref = { offset: 8 };
    let fromCustom = null, fromImport = null, fromMemory = null;

    while (ref.offset < bytes.length) {
      const sectionId = bytes[ref.offset++];
      const sectionSize = _readULEB128(bytes, ref);
      const sectionEnd = ref.offset + sectionSize;

      try {
        if (sectionId === 0) {
          const name = _readWasmString(bytes, ref);
          if (name === 'clean:memory') {
            // Format: initial_pages:ULEB128, max_pages:ULEB128 (tier string may follow; ignored here)
            const initial = _readULEB128(bytes, ref);
            const max = _readULEB128(bytes, ref);
            fromCustom = { initial, max, source: 'clean:memory' };
          }
        } else if (sectionId === 2) {
          const count = _readULEB128(bytes, ref);
          for (let i = 0; i < count; i++) {
            _readWasmString(bytes, ref); // module
            _readWasmString(bytes, ref); // name
            const kind = bytes[ref.offset++];
            if (kind === 0) {
              _readULEB128(bytes, ref); // typeidx
            } else if (kind === 1) {
              ref.offset++; // reftype
              _readMemoryLimits(bytes, ref);
            } else if (kind === 2) {
              const limits = _readMemoryLimits(bytes, ref);
              if (!fromImport) fromImport = { ...limits, source: 'import' };
            } else if (kind === 3) {
              ref.offset += 2; // valtype + mut
            }
          }
        } else if (sectionId === 5) {
          const count = _readULEB128(bytes, ref);
          if (count > 0 && !fromMemory) {
            fromMemory = { ..._readMemoryLimits(bytes, ref), source: 'memory-section' };
          }
        }
      } catch (_) {
        // tolerate malformed section — fall through to next
      }

      ref.offset = sectionEnd;
    }

    return fromCustom || fromImport || fromMemory;
  }

  // --- window.__cleanRuntime registration (MEMORY_POLICY.md §9.3) ---

  function registerCleanRuntime(statsProvider) {
    if (typeof window === 'undefined') return;
    if (!window.__cleanRuntime) {
      window.__cleanRuntime = {
        _providers: [],
        memoryStats() {
          const p = this._providers[this._providers.length - 1];
          return p ? p() : null;
        }
      };
    }
    window.__cleanRuntime._providers.push(statsProvider);
  }

  /**
   * Clean Canvas Application Loader
   */
  class CleanCanvasLoader {
    constructor() {
      this.bridge = new CanvasBridge();
      this.memory = null;
      this.instance = null;
      this._initialPages = 0;
      this._maxPages = 0;
      this._growCount = 0;
      this._lastBufferSize = 0;
      this._heapPtr = 0;
    }

    _checkMemoryGrowth() {
      if (!this.memory) return;
      const size = this.memory.buffer.byteLength;
      if (size !== this._lastBufferSize) {
        const fromPages = this._lastBufferSize / WASM_PAGE_SIZE;
        const toPages = size / WASM_PAGE_SIZE;
        const fromMB = (this._lastBufferSize / (1024 * 1024)).toFixed(1);
        const toMB = (size / (1024 * 1024)).toFixed(1);
        console.warn(`[clean] Memory grew: ${fromPages} → ${toPages} pages (${fromMB} MB → ${toMB} MB)`);
        this._growCount++;
        this._lastBufferSize = size;
      }
    }

    _memoryStats() {
      const size = this.memory ? this.memory.buffer.byteLength : 0;
      return {
        currentPages: size / WASM_PAGE_SIZE,
        currentBytes: size,
        maxPages: this._maxPages,
        growCount: this._growCount,
        heapPtr: this._heapPtr,
      };
    }

    /**
     * Load a WASM module
     * @param {string} url - URL to the .wasm file
     * @param {Object} options - Load options
     * @returns {Promise<CleanCanvasApp>} Application instance
     */
    async load(url, options = {}) {
      console.log(`[CleanCanvas] Loading ${url}...`);

      // Fetch WASM first so we can inspect its memory declaration
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
      }
      const wasmBuffer = await response.arrayBuffer();

      // Resolve initial/max pages per MEMORY_POLICY.md §6.2:
      //   1. Caller override (options.memoryPages)
      //   2. Module declaration (clean:memory custom section, then import descriptor, then memory section)
      //   3. Canvas tier defaults (256 / 1024)
      const decl = parseWasmMemoryDecl(wasmBuffer);
      let initialPages, maxPages;
      if (options.memoryPages) {
        initialPages = options.memoryPages;
        maxPages = options.memoryMaxPages || options.memoryPages * 4;
      } else if (decl) {
        initialPages = decl.initial;
        maxPages = decl.max != null ? decl.max : CANVAS_TIER_MAX_PAGES;
        console.log(`[CleanCanvas] Memory from WASM ${decl.source}: initial=${initialPages} max=${maxPages}`);
      } else {
        initialPages = CANVAS_TIER_INITIAL_PAGES;
        maxPages = CANVAS_TIER_MAX_PAGES;
        console.log(`[CleanCanvas] No memory declaration found; using canvas tier defaults (${initialPages}/${maxPages})`);
      }

      this._initialPages = initialPages;
      this._maxPages = maxPages;
      this.memory = new WebAssembly.Memory({ initial: initialPages, maximum: maxPages });
      this._lastBufferSize = this.memory.buffer.byteLength;

      // Get bridge imports
      const bridgeImports = this.bridge.getImports(this.memory);

      // Create standard library imports
      const stdlibImports = this.createStdlibImports();

      // Merge all imports
      const imports = {
        env: {
          memory: this.memory,
          ...bridgeImports.env,
          ...stdlibImports
        },
        memory_runtime: this.createMemoryRuntimeImports()
      };

      try {
        const { instance } = await WebAssembly.instantiate(wasmBuffer, imports);
        this.attachInstance(instance);

        if (instance.exports.__heap_ptr && typeof instance.exports.__heap_ptr.value === 'number') {
          this._heapPtr = instance.exports.__heap_ptr.value;
        }

        // Check for module-initiated growth during instantiation/start
        this._checkMemoryGrowth();

        registerCleanRuntime(() => this._memoryStats());

        console.log('[CleanCanvas] WASM loaded successfully');
        console.log('[CleanCanvas] Exports:', Object.keys(instance.exports));

        return new CleanCanvasApp(this);
      } catch (err) {
        console.error('[CleanCanvas] Failed to load WASM:', err);
        throw err;
      }
    }

    /**
     * Wire an instantiated module: a module that defines its own memory
     * (what the compiler emits) is read and written through that memory, and
     * every host allocation comes from the module heap.
     */
    attachInstance(instance) {
      this.instance = instance;
      if (instance.exports.memory instanceof WebAssembly.Memory) {
        this.memory = instance.exports.memory;
        this._lastBufferSize = this.memory.buffer.byteLength;
      }
      this.bridge.setWasmInstance(instance, (size) => this._heapAlloc(size));
    }

    /**
     * Allocate `size` bytes on the module heap (HOST_BRIDGE / BOXED_ANY_ABI §6:
     * the module's malloc export, else its `__heap_ptr` bump pointer, kept in
     * sync so module and host allocations never overlap). 8-byte aligned;
     * grows memory when needed.
     */
    _heapAlloc(size) {
      const exports = this.instance ? this.instance.exports : {};
      if (typeof exports.malloc === 'function') {
        const p = exports.malloc(size);
        if (!p) throw new Error('malloc(' + size + ') failed');
        return p;
      }
      const heap = exports.__heap_ptr;
      if (!heap || typeof heap.value !== 'number') {
        throw new Error('module exports neither malloc nor __heap_ptr; the host cannot allocate');
      }
      const ptr = (heap.value + 7) & ~7;
      const end = ptr + Math.max(size, 0);
      const have = this.memory.buffer.byteLength;
      if (end > have) {
        this.memory.grow(Math.ceil((end - have) / WASM_PAGE_SIZE));
      }
      heap.value = end;
      this._heapPtr = end;
      this._checkMemoryGrowth();
      return ptr;
    }

    /**
     * memory_runtime imports (HOST_BRIDGE "Memory Runtime"). The compiler
     * passes (type_id, size) to mem_alloc — the same reading clean-server
     * uses; the module heap is a bump arena, so retain / release / scopes
     * have nothing to free.
     */
    createMemoryRuntimeImports() {
      const self = this;
      return {
        mem_alloc(typeId, size) {
          void typeId;
          return self._heapAlloc(size);
        },
        mem_retain(ptr) { void ptr; },
        mem_release(ptr) { void ptr; },
        mem_scope_push() {},
        mem_scope_pop() {},
      };
    }

    /**
     * Create standard library imports (print, string operations, etc.)
     */
    createStdlibImports() {
      const self = this;

      return {
        // ================================================================
        // JSON (stdlib-reference §8) — boxed-Any values per BOXED_ANY_ABI.md
        // ================================================================

        _json_encode_v2(boxedPtr) {
          return self._jsonAllocString(JSON.stringify(self._jsonRead(boxedPtr)));
        },

        _json_encode_pretty_v2(boxedPtr) {
          return self._jsonAllocString(JSON.stringify(self._jsonRead(boxedPtr), null, 2));
        },

        // Returns 0 on a parse failure (BOXED_ANY_ABI §6); the compiler
        // turns it into a raise or a null.
        _json_decode_v2(ptr, len) {
          let parsed;
          try {
            parsed = JSON.parse(self.readString(ptr, len));
          } catch (_) {
            return 0;
          }
          return self._jsonWrite(parsed);
        },

        // (source: any, path: LP string) -> any. A string source holds JSON
        // text; any other box is walked as it is. Typed leaf, or a null-tag
        // box when the path does not resolve (runtime-abi/v1.toml).
        _json_get(sourcePtr, pathPtr) {
          const path = self._readLP(pathPtr);
          let source = sourcePtr === 0 ? null : self._jsonRead(sourcePtr);
          if (typeof source === 'string') {
            try {
              source = JSON.parse(source);
            } catch (_) {
              source = null;
            }
          }
          const leaf = source === null ? undefined : self._jsonGetPath(source, path);
          return self._jsonWrite(leaf === undefined ? null : leaf);
        },

        // ================================================================
        // CONSOLE / PRINT
        // ================================================================

        print(ptr, len) {
          const str = self.readString(ptr, len);
          console.log(str);
          return 0;
        },

        print_integer(value) {
          console.log(value);
          return 0;
        },

        print_float(value) {
          console.log(value);
          return 0;
        },

        print_boolean(value) {
          console.log(value ? 'true' : 'false');
        },

        // Runtime error handler: LP message; logs and returns 0 (registry).
        error(msgPtr) {
          console.error('[CleanCanvas] ' + self._readLP(msgPtr));
          return 0;
        },

        // input(prompt): LP prompt, LP result ('' when the page cannot prompt).
        input(promptPtr) {
          const promptText = self._readLP(promptPtr);
          const answer = (typeof window !== 'undefined' && typeof window.prompt === 'function')
            ? window.prompt(promptText) : null;
          return self._writeLP(answer == null ? '' : answer);
        },

        printl(ptr, len) {
          const str = self.readString(ptr, len);
          console.log(str);
          return 0;
        },

        console_log(ptr, len) {
          const str = self.readString(ptr, len);
          console.log(str);
          return 0;
        },

        _console_info(ptr, len) {
          const str = self.readString(ptr, len);
          console.info(str);
          return 0;
        },

        console_warn(ptr, len) {
          const str = self.readString(ptr, len);
          console.warn(str);
          return 0;
        },

        console_error(ptr, len) {
          const str = self.readString(ptr, len);
          console.error(str);
          return 0;
        },

        // ================================================================
        // STRING ALLOCATION
        // ================================================================

        _alloc_string(len) {
          return self._heapAlloc(len);
        },

        // LP-pointer convention (HOST_BRIDGE "String Operations").
        string_concat(aPtr, bPtr) {
          return self._writeLP(self._readLP(aPtr) + self._readLP(bPtr));
        },

        'string.concat'(aPtr, bPtr) {
          return self._writeLP(self._readLP(aPtr) + self._readLP(bPtr));
        },

        // -1 / 0 / 1; 0 means equal (codegen tests it with i32.eqz).
        string_compare(aPtr, bPtr) {
          const a = self._readLP(aPtr);
          const b = self._readLP(bPtr);
          return a < b ? -1 : (a > b ? 1 : 0);
        },

        _state_reset_all() {},

        _state_reset_named(namePtr) {
          void namePtr;
        },

        // ================================================================
        // MATH FUNCTIONS
        // ================================================================

        math_sin(x) { return Math.sin(x); },
        math_cos(x) { return Math.cos(x); },
        math_tan(x) { return Math.tan(x); },
        math_asin(x) { return Math.asin(x); },
        math_acos(x) { return Math.acos(x); },
        math_atan(x) { return Math.atan(x); },
        math_atan2(y, x) { return Math.atan2(y, x); },
        math_sinh(x) { return Math.sinh(x); },
        math_cosh(x) { return Math.cosh(x); },
        math_tanh(x) { return Math.tanh(x); },
        math_sqrt(x) { return Math.sqrt(x); },
        math_pow(x, y) { return Math.pow(x, y); },
        math_exp(x) { return Math.exp(x); },
        math_ln(x) { return Math.log(x); },
        math_log10(x) { return Math.log10(x); },
        math_log2(x) { return Math.log2(x); },
        math_abs(x) { return Math.abs(x); },
        math_floor(x) { return Math.floor(x); },
        math_ceil(x) { return Math.ceil(x); },
        math_round(x) { return Math.round(x); },
        math_trunc(x) { return Math.trunc(x); },
        math_sign(x) { return Math.sign(x); },
        math_min(x, y) { return Math.min(x, y); },
        math_max(x, y) { return Math.max(x, y); },
        math_random() { return Math.random(); },

        // Constants
        math_pi() { return Math.PI; },
        math_e() { return Math.E; },

        // ================================================================
        // TIME FUNCTIONS
        // ================================================================

        _time_now() {
          return Date.now();
        },

        _time_now_seconds() {
          return Date.now() / 1000;
        },

        _time_performance_now() {
          return performance.now();
        },

        // ================================================================
        // LOGGING
        // ================================================================

        _log_info(ptr, len) {
          const str = self.readString(ptr, len);
          console.info('[INFO]', str);
          return 0;
        },

        _log_warn(ptr, len) {
          const str = self.readString(ptr, len);
          console.warn('[WARN]', str);
          return 0;
        },

        _log_error(ptr, len) {
          const str = self.readString(ptr, len);
          console.error('[ERROR]', str);
          return 0;
        },

        _log_debug(ptr, len) {
          const str = self.readString(ptr, len);
          console.debug('[DEBUG]', str);
          return 0;
        },

        // ================================================================
        // TYPE CONVERSION
        // ================================================================

        // Conversions return / take LP strings (registry).
        int_to_string(value) {
          return self._writeLP(String(value));
        },

        // i64 parameters arrive as BigInt.
        int64_to_string(value) {
          return self._writeLP((typeof value === 'bigint' ? value : BigInt(value)).toString());
        },

        float_to_string(value) {
          return self._writeLP(self._formatFloat(value));
        },

        string_to_int(ptr) {
          const v = parseInt(self._readLP(ptr).trim(), 10);
          return Number.isFinite(v) ? v | 0 : 0;
        },

        string_to_float(ptr) {
          const v = parseFloat(self._readLP(ptr).trim());
          return Number.isFinite(v) ? v : 0.0;
        },

        // ================================================================
        // MEMORY
        // ================================================================

        _memory_copy(dest, src, len) {
          const view = new Uint8Array(self.memory.buffer);
          view.copyWithin(dest, src, src + len);
          return 0;
        },

        _memory_fill(ptr, value, len) {
          const view = new Uint8Array(self.memory.buffer);
          view.fill(value, ptr, ptr + len);
          return 0;
        },

        // ================================================================
        // ASSERTIONS (for debugging)
        // ================================================================

        _assert(condition, msgPtr, msgLen) {
          if (!condition) {
            const msg = self.readString(msgPtr, msgLen);
            console.error('[ASSERT FAILED]', msg);
            throw new Error(`Assertion failed: ${msg}`);
          }
          return 0;
        },

        _panic(msgPtr, msgLen) {
          const msg = self.readString(msgPtr, msgLen);
          console.error('[PANIC]', msg);
          throw new Error(`Panic: ${msg}`);
        },

        // ================================================================
        // STRING STDLIB (registry hosts="all")
        // ================================================================
        // For these functions, registry says "param is length-prefixed
        // pointer" — the WASM passes a single i32 pointing to a [u32 length
        // | UTF-8 bytes] layout. Returns are length-prefixed pointers.

        bool_to_string(value) {
          return self._writeLP(value ? 'true' : 'false');
        },

        print_string(ptr, len) {
          // Registry says "Print raw string without newline" — matches the
          // existing print() behavior since the JS console always appends a
          // newline; no separate handling possible here.
          console.log(self.readString(ptr, len));
          return 0;
        },

        string_index_of(haystackPtr, needlePtr) {
          const haystack = self._readLP(haystackPtr);
          const needle = self._readLP(needlePtr);
          return haystack.indexOf(needle);
        },

        // (str_ptr, str_len, pattern_id) — registry pattern table:
        // 0=email 1=url 2=uuid 3=phone 4=date 5=integer 6=number 7=alphanumeric.
        string_matches(strPtr, strLen, patternId) {
          const pattern = STRING_PATTERNS[patternId];
          if (!pattern) return 0;
          return pattern.test(self.readString(strPtr, strLen)) ? 1 : 0;
        },

        string_repeat(strPtr, strLen, count) {
          // strLen is "raw length (ignored)" per registry — strPtr is LP.
          void strLen;
          const str = self._readLP(strPtr);
          return self._writeLP(str.repeat(Math.max(0, count | 0)));
        },

        string_substring(strPtr, start, end) {
          const str = self._readLP(strPtr);
          const s = Math.max(0, start | 0);
          const e = Math.min(str.length, Math.max(s, end | 0));
          return self._writeLP(str.substring(s, e));
        },

        string_to_bool(strPtr) {
          const v = self._readLP(strPtr).trim().toLowerCase();
          return (v === 'true' || v === '1' || v === 'yes') ? 1 : 0;
        },

        string_to_lower(strPtr) {
          return self._writeLP(self._readLP(strPtr).toLowerCase());
        },

        string_to_upper(strPtr) {
          return self._writeLP(self._readLP(strPtr).toUpperCase());
        },

        string_trim(strPtr) {
          return self._writeLP(self._readLP(strPtr).trim());
        },

        string_trim_end(strPtr) {
          return self._writeLP(self._readLP(strPtr).trimEnd());
        },

        string_trim_start(strPtr) {
          return self._writeLP(self._readLP(strPtr).trimStart());
        },

        _parse_int(ptr, len) {
          const v = parseInt(self.readString(ptr, len), 10);
          return Number.isFinite(v) ? v : 0;
        },

        _parse_float(ptr, len) {
          const v = parseFloat(self.readString(ptr, len));
          return Number.isFinite(v) ? v : 0;
        },

        math_exp2(x) {
          return Math.pow(2, x);
        },

        // ================================================================
        // CRYPTO (sync JS — registry hosts="all")
        // ================================================================
        // Browser-side SHA/HMAC use synchronous JS implementations rather
        // than crypto.subtle (which is Promise-based and can't be wrapped
        // in a sync WASM bridge call). For bytes-of-randomness functions
        // we use crypto.getRandomValues which is synchronous and built-in.
        //
        // bcrypt-based password hashing isn't natively sync-available in
        // the browser — we fall back to a PBKDF2-via-getRandomValues
        // marker scheme (hash="pbkdf2:<salt>:<digest>"). Verification
        // works against any hash produced by the same scheme. This isn't
        // bcrypt-compatible — callers should hash passwords server-side
        // for cross-host compatibility.

        _crypto_hash_sha256(ptr, len) {
          return self._writeLP(self._sha256Hex(self.readString(ptr, len)));
        },

        // SHA-256 of a length-prefixed byte buffer at handle. Handle layout
        // matches _req_body_bytes output: [4-byte LE length][bytes]. Returns
        // a length-prefixed lowercase hex string (64 chars). Companion to
        // _crypto_hash_sha256 for octet-stream inputs that must not go
        // through UTF-8 decode/re-encode. Registry entry: function-registry.toml
        // §_crypto_sha256_bytes (hosts=["all"]).
        _crypto_sha256_bytes(handle) {
          const bytes = self._readLPBytes(handle);
          return self._writeLP(self._sha256Hex(bytes));
        },

        _crypto_hash_sha512(ptr, len) {
          return self._writeLP(self._sha512Hex(self.readString(ptr, len)));
        },

        _crypto_hmac(dataPtr, dataLen, keyPtr, keyLen, algPtr, algLen) {
          const data = self.readString(dataPtr, dataLen);
          const key = self.readString(keyPtr, keyLen);
          const alg = self.readString(algPtr, algLen).toLowerCase();
          const hex = alg === 'sha512'
            ? self._hmacHex(key, data, 'sha512')
            : self._hmacHex(key, data, 'sha256');
          return self._writeLP(hex);
        },

        _crypto_random_bytes(count) {
          const n = Math.max(0, count | 0);
          const bytes = new Uint8Array(n);
          if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
          } else {
            for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
          }
          // base64-encode (browser-safe binary -> base64)
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
          return self._writeLP(b64);
        },

        _crypto_random_hex(count) {
          const n = Math.max(0, count | 0);
          const bytes = new Uint8Array(n);
          if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
          } else {
            for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
          }
          let hex = '';
          for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
          return self._writeLP(hex);
        },

        _crypto_hash_password(ptr, len) {
          const pw = self.readString(ptr, len);
          // Cross-host bcrypt is not available sync in the browser. We use
          // a PBKDF2-style sync construction (SHA-256 over salt|password,
          // iterated) so produced hashes can at least be self-consistent
          // across browser sessions. Callers needing bcrypt compatibility
          // must hash server-side.
          const salt = self._cryptoRandomHex(16);
          const digest = self._pbkdf2Hex(pw, salt, 10000);
          return self._writeLP(`pbkdf2:${salt}:${digest}`);
        },

        _crypto_verify_password(pwPtr, pwLen, hashPtr, hashLen) {
          const pw = self.readString(pwPtr, pwLen);
          const hash = self.readString(hashPtr, hashLen);
          const parts = hash.split(':');
          if (parts.length !== 3 || parts[0] !== 'pbkdf2') return 0;
          const digest = self._pbkdf2Hex(pw, parts[1], 10000);
          return digest === parts[2] ? 1 : 0;
        },

        // ================================================================
        // HTTP CLIENT (registry hosts="all")
        // ================================================================
        // The "currently no-op" functions are documented as such in the
        // registry. build_query and decode_url are pure string ops.
        // get_response_body returns the last fetch() body if one is
        // available (we don't currently model fetch state in the browser
        // bridge — returns 0 for "no response").

        http_build_query(jsonPtr, jsonLen) {
          const raw = self.readString(jsonPtr, jsonLen);
          try {
            const obj = JSON.parse(raw || '{}');
            const parts = [];
            for (const [k, v] of Object.entries(obj)) {
              if (v == null) continue;
              parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
            }
            return self._writeLP(parts.join('&'));
          } catch (e) {
            return self._writeLP('');
          }
        },

        http_decode_url(ptr, len) {
          try {
            return self._writeLP(decodeURIComponent(self.readString(ptr, len)));
          } catch {
            return self._writeLP('');
          }
        },

        http_enable_cookies() { return 0; },
        http_set_max_redirects() { return 0; },
        http_set_timeout() { return 0; },
        http_get_response_body() {
          // No response state is tracked in this host. Return 0 ("no
          // response available") per the registry contract.
          return 0;
        },

        // ================================================================
        // BUILD STATE (in-memory keystore; persists for the session only)
        // ================================================================

        _build_state_get(keyPtr, keyLen) {
          const k = self.readString(keyPtr, keyLen);
          if (!self.buildState) self.buildState = new Map();
          return self._writeLP(self.buildState.get(k) || '');
        },

        _build_state_set(keyPtr, keyLen, valPtr, valLen) {
          const k = self.readString(keyPtr, keyLen);
          const v = self.readString(valPtr, valLen);
          if (!self.buildState) self.buildState = new Map();
          self.buildState.set(k, v);
          return 0;
        },

        // ================================================================
        // ASYNC RUNTIME (no synchronous WASM async on browser host)
        // ================================================================
        // The Clean async runtime requires the host to suspend a WASM
        // function call until a JS Promise resolves. Browser WASM doesn't
        // support that without the JSPI proposal (still behind flags).
        // For now these are honest no-ops that log a warning so callers
        // know the call did not actually run; the registry contract for
        // these is "may be a no-op on hosts lacking JSPI."

        _async_await(fnNamePtr, fnNameLen, argsPtr, argsLen) {
          const name = self.readString(fnNamePtr, fnNameLen);
          console.warn(`[frame.canvas/loader] _async_await("${name}") is unsupported in the browser host without WASM JSPI; returning empty result.`);
          void argsPtr; void argsLen;
          return self._writeLP('');
        },

        _async_fire(fnNamePtr, fnNameLen, argsPtr, argsLen) {
          const name = self.readString(fnNamePtr, fnNameLen);
          console.warn(`[frame.canvas/loader] _async_fire("${name}") is unsupported in the browser host without WASM JSPI; the call did not run.`);
          void argsPtr; void argsLen;
          return 0;
        },

        // ================================================================
        // TEST INFRASTRUCTURE
        // ================================================================
        // Browser hosts don't run in-process HTTP route dispatch (that's a
        // server-side concept). These are honest stubs returning empty
        // results; tests that depend on them should run on a server host.

        _test_http_request() {
          console.warn('[frame.canvas/loader] _test_http_request is not available in browser host');
          return 0;
        },

        _test_response_body() { return self._writeLP(''); },
        _test_response_status() { return 0; },
      };
    }

    /**
     * Read string from WASM memory
     */
    readString(ptr, len) {
      if (!this.memory) return '';
      this._checkMemoryGrowth();
      const bytes = new Uint8Array(this.memory.buffer, ptr, len);
      return new TextDecoder().decode(bytes);
    }

    /**
     * Write string to WASM memory
     */
    writeString(str, ptr) {
      if (!this.memory) return 0;
      this._checkMemoryGrowth();
      const bytes = new TextEncoder().encode(str);
      const view = new Uint8Array(this.memory.buffer, ptr, bytes.length);
      view.set(bytes);
      return bytes.length;
    }

    // ======================================================================
    // LENGTH-PREFIXED STRING HELPERS
    // ======================================================================
    // The new-convention string stdlib functions read inputs as a single
    // pointer to [u32 length | bytes] and return the same layout. These
    // helpers handle both directions.

    _readLP(ptr) {
      if (!this.memory) return '';
      this._checkMemoryGrowth();
      const dv = new DataView(this.memory.buffer);
      const len = dv.getUint32(ptr, true);
      const bytes = new Uint8Array(this.memory.buffer, ptr + 4, len);
      return new TextDecoder().decode(bytes);
    }

    // Raw-bytes variant of _readLP. Returns a copy of the payload bytes at
    // an LP handle without any UTF-8 decoding. Required by binary-input
    // bridges (e.g. _crypto_sha256_bytes) whose consumers must see the exact
    // wire bytes.
    _readLPBytes(ptr) {
      if (!this.memory) return new Uint8Array(0);
      this._checkMemoryGrowth();
      const dv = new DataView(this.memory.buffer);
      const len = dv.getUint32(ptr, true);
      // Copy out of the WASM buffer — the caller may hold this after
      // subsequent allocations that could grow / relocate memory.
      return new Uint8Array(this.memory.buffer, ptr + 4, len).slice();
    }

    // Length-prefixed string on the module heap; returns its pointer.
    _writeLP(str) {
      const bytes = new TextEncoder().encode(str || '');
      const ptr = this._heapAlloc(4 + bytes.length);
      new DataView(this.memory.buffer).setUint32(ptr, bytes.length, true);
      new Uint8Array(this.memory.buffer, ptr + 4, bytes.length).set(bytes);
      return ptr;
    }

    // Same text as clean-server's float_to_string (Rust f64 Display):
    // 3 -> "3", 0.5 -> "0.5", infinities -> "inf" / "-inf".
    _formatFloat(value) {
      if (value === Infinity) return 'inf';
      if (value === -Infinity) return '-inf';
      return String(value);
    }

    // ======================================================================
    // BOXED-ANY JSON VALUES (BOXED_ANY_ABI.md §1-§3)
    // ======================================================================
    // A box is 12 bytes: [tag:i32][payload:8 bytes]. Arrays and objects
    // point at JSON-tree fragments: [count][elem_ptr x count] and
    // [count][(key_ptr, val_ptr) x count]. Everything the JSON bridges hand
    // back is allocated with the module's exported malloc (§6), so it lives
    // on the module's heap. Each access re-reads memory.buffer because malloc
    // can grow memory.

    _jsonView() {
      this._checkMemoryGrowth();
      return new DataView(this.memory.buffer);
    }

    _jsonMalloc(size) {
      return this._heapAlloc(size);
    }

    _jsonAllocString(str) {
      return this._writeLP(str);
    }

    // Throws on an invalid tag — no silent "null" fallback (D5).
    _jsonRead(ptr) {
      const tag = this._jsonView().getInt32(ptr, true);
      switch (tag) {
        case 0:
          return null;
        case 1: // i64 across offsets 4..12
          return Number(this._jsonView().getBigInt64(ptr + 4, true));
        case 2:
          return this._jsonView().getInt32(ptr + 4, true) !== 0;
        case 3:
          return this._jsonView().getFloat64(ptr + 4, true);
        case 4:
          return this._readLP(this._jsonView().getInt32(ptr + 4, true));
        case 5: {
          const arr = this._jsonView().getInt32(ptr + 4, true);
          const count = this._jsonView().getInt32(arr, true);
          const out = [];
          for (let i = 0; i < count; i++) {
            out.push(this._jsonRead(this._jsonView().getInt32(arr + 4 + i * 4, true)));
          }
          return out;
        }
        case 6: {
          const obj = this._jsonView().getInt32(ptr + 4, true);
          const count = this._jsonView().getInt32(obj, true);
          const out = {};
          for (let i = 0; i < count; i++) {
            const entry = obj + 4 + i * 8;
            const key = this._readLP(this._jsonView().getInt32(entry, true));
            out[key] = this._jsonRead(this._jsonView().getInt32(entry + 4, true));
          }
          return out;
        }
        default:
          throw new Error('invalid boxed-Any tag ' + tag + ' at ptr ' + ptr);
      }
    }

    // Writes a JSON value as a boxed-Any tree; returns the box pointer.
    _jsonWrite(value) {
      let tag = 0;
      let word = 0;
      let integer = null;
      let float = null;
      if (value === null) {
        tag = 0;
      } else if (typeof value === 'boolean') {
        tag = 2;
        word = value ? 1 : 0;
      } else if (typeof value === 'number') {
        // Safe-range integers are tag 1 (i64), everything else tag 3 (§5.2).
        if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
          tag = 1;
          integer = BigInt(value);
        } else {
          tag = 3;
          float = value;
        }
      } else if (typeof value === 'string') {
        tag = 4;
        word = this._jsonAllocString(value);
      } else if (Array.isArray(value)) {
        const elems = value.map((v) => this._jsonWrite(v));
        const arr = this._jsonMalloc(4 + elems.length * 4);
        this._jsonView().setInt32(arr, elems.length, true);
        elems.forEach((e, i) => this._jsonView().setInt32(arr + 4 + i * 4, e, true));
        tag = 5;
        word = arr;
      } else {
        // Object.entries keeps insertion order for string keys (D3).
        const entries = Object.entries(value).map(([k, v]) => [this._jsonAllocString(k), this._jsonWrite(v)]);
        const obj = this._jsonMalloc(4 + entries.length * 8);
        this._jsonView().setInt32(obj, entries.length, true);
        entries.forEach(([k, v], i) => {
          this._jsonView().setInt32(obj + 4 + i * 8, k, true);
          this._jsonView().setInt32(obj + 8 + i * 8, v, true);
        });
        tag = 6;
        word = obj;
      }
      const ptr = this._jsonMalloc(12);
      const dv = this._jsonView();
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

    // Dot-separated path: a member name, or a decimal index into an array.
    _jsonGetPath(value, path) {
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

    // ======================================================================
    // SYNCHRONOUS SHA-256 (FIPS-180-4, ~80 lines)
    // ======================================================================

    _sha256Hex(input) {
      const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];
      // Accept string (UTF-8 encode) or Uint8Array (use as-is). The bytes
      // variant is what _crypto_sha256_bytes needs — the caller reads raw
      // bytes from a length-prefixed buffer and the hash must operate on
      // those bytes without UTF-8 round-tripping.
      const enc = (input instanceof Uint8Array) ? input : new TextEncoder().encode(input);
      const bitLen = enc.length * 8;
      // pad: 0x80, zeros, 64-bit big-endian length
      const padLen = (Math.floor((enc.length + 9 + 63) / 64) * 64) - enc.length;
      const msg = new Uint8Array(enc.length + padLen);
      msg.set(enc, 0);
      msg[enc.length] = 0x80;
      const dv = new DataView(msg.buffer);
      // length in bits as 64-bit big-endian (JS numbers can't hold 64-bit; we
      // split into hi/lo using 32-bit halves — Clean inputs in practice fit)
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

    _sha256Bytes(input) {
      const hex = this._sha256Hex(input);
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }

    // ======================================================================
    // SYNCHRONOUS SHA-512 — same algorithm with 64-bit words, expressed as
    // hi/lo 32-bit pairs since JS numbers are 53-bit safe-int.
    // ======================================================================

    _sha512Hex(input) {
      // Use BigInt for clarity; sha512 isn't called in hot paths in the
      // typical browser-side Clean app.
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
      const enc = new TextEncoder().encode(input);
      const bitLen = BigInt(enc.length) * 8n;
      const padLen = (Math.floor((enc.length + 17 + 127) / 128) * 128) - enc.length;
      const msg = new Uint8Array(enc.length + padLen);
      msg.set(enc, 0);
      msg[enc.length] = 0x80;
      // 128-bit length big-endian — upper 64 bits are zero for any realistic input
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
        for (let t = 0; t < 16; t++) {
          w[t] = dv.getBigUint64(i + t * 8, false);
        }
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

    _sha512Bytes(input) {
      const hex = this._sha512Hex(input);
      const out = new Uint8Array(64);
      for (let i = 0; i < 64; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }

    // ======================================================================
    // HMAC (sha256 or sha512)
    // ======================================================================

    _hmacHex(key, data, alg) {
      const blockSize = alg === 'sha512' ? 128 : 64;
      const hash = alg === 'sha512' ? (s) => this._sha512Bytes(s) : (s) => this._sha256Bytes(s);
      const hashHex = alg === 'sha512' ? (s) => this._sha512Hex(s) : (s) => this._sha256Hex(s);

      let keyBytes = new TextEncoder().encode(key);
      if (keyBytes.length > blockSize) keyBytes = hash(key);
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
      const innerHash = hash(new TextDecoder().decode(inner));
      const outer = new Uint8Array(oKey.length + innerHash.length);
      outer.set(oKey, 0); outer.set(innerHash, oKey.length);
      return hashHex(new TextDecoder().decode(outer));
    }

    _cryptoRandomHex(byteCount) {
      const n = Math.max(0, byteCount | 0);
      const b = new Uint8Array(n);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
      else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
      let hex = '';
      for (let i = 0; i < n; i++) hex += b[i].toString(16).padStart(2, '0');
      return hex;
    }

    _pbkdf2Hex(pw, salt, iter) {
      // Minimal sync PBKDF2 over SHA-256, single-block output (32 bytes).
      // Good-enough deterministic password digest for browser fallback when
      // bcrypt isn't available. Not exposed as a general-purpose API.
      let prev = this._sha256Hex(salt + pw);
      let acc = prev;
      for (let i = 1; i < iter; i++) {
        prev = this._sha256Hex(prev);
        // XOR the hex strings as bytes
        const a = acc, b = prev;
        let out = '';
        for (let j = 0; j < a.length; j += 2) {
          const x = parseInt(a.substr(j, 2), 16) ^ parseInt(b.substr(j, 2), 16);
          out += x.toString(16).padStart(2, '0');
        }
        acc = out;
      }
      return acc;
    }

    /**
     * Clean up resources
     */
    destroy() {
      this.bridge.destroy();
      this.instance = null;
      this.memory = null;
    }
  }

  /**
   * Clean Canvas Application instance
   */
  class CleanCanvasApp {
    constructor(loader) {
      this.loader = loader;
      this.instance = loader.instance;
      this.exports = loader.instance.exports;
      this.paused = false;
    }

    /**
     * Call the start() function
     */
    start() {
      if (this.exports.start) {
        console.log('[CleanCanvas] Calling start()...');
        this.exports.start();
      } else if (this.exports._start) {
        console.log('[CleanCanvas] Calling _start()...');
        this.exports._start();
      } else if (this.exports.main) {
        console.log('[CleanCanvas] Calling main()...');
        this.exports.main();
      } else {
        console.warn('[CleanCanvas] No start(), _start(), or main() function found');
      }
      return this;
    }

    /**
     * Pause the animation loop
     */
    pause() {
      if (!this.paused) {
        this.paused = true;
        const bridge = this.loader.bridge;
        for (const [frameId, rafId] of bridge.animationFrames) {
          cancelAnimationFrame(rafId);
        }
        console.log('[CleanCanvas] Paused');
      }
      return this;
    }

    /**
     * Resume the animation loop
     */
    resume() {
      if (this.paused) {
        this.paused = false;
        const bridge = this.loader.bridge;
        const imports = bridge.getImports(this.loader.memory);

        // Re-request animation frames for all canvases
        for (const canvasId of bridge.canvases.keys()) {
          imports.env._canvas_request_frame(canvasId);
        }
        console.log('[CleanCanvas] Resumed');
      }
      return this;
    }

    /**
     * Toggle pause/resume
     */
    togglePause() {
      return this.paused ? this.resume() : this.pause();
    }

    /**
     * Get current FPS
     */
    getFPS() {
      return this.loader.bridge.fps;
    }

    /**
     * Get delta time
     */
    getDeltaTime() {
      return this.loader.bridge.deltaTime;
    }

    /**
     * Get elapsed time since start
     */
    getTime() {
      return (performance.now() - this.loader.bridge.startTime) / 1000;
    }

    /**
     * Call a named export function
     */
    call(name, ...args) {
      if (this.exports[name]) {
        return this.exports[name](...args);
      }
      console.warn(`[CleanCanvas] Function not found: ${name}`);
      return undefined;
    }

    /**
     * Check if function exists
     */
    hasFunction(name) {
      return typeof this.exports[name] === 'function';
    }

    /**
     * Get canvas bridge
     */
    get canvas() {
      return this.loader.bridge;
    }

    /**
     * Get canvas element by ID
     */
    getCanvasElement(id = 1) {
      return this.loader.bridge.getCanvasElement(id);
    }

    /**
     * Set master volume
     */
    setVolume(volume) {
      this.loader.bridge.masterVolume = volume;
      if (this.loader.bridge.currentMusicElement) {
        this.loader.bridge.currentMusicElement.volume =
          volume * this.loader.bridge.musicVolume *
          (this.loader.bridge.isMuted ? 0 : 1);
      }
      return this;
    }

    /**
     * Mute all audio
     */
    mute() {
      this.loader.bridge.isMuted = true;
      if (this.loader.bridge.currentMusicElement) {
        this.loader.bridge.currentMusicElement.volume = 0;
      }
      return this;
    }

    /**
     * Unmute all audio
     */
    unmute() {
      this.loader.bridge.isMuted = false;
      if (this.loader.bridge.currentMusicElement) {
        this.loader.bridge.currentMusicElement.volume =
          this.loader.bridge.musicVolume * this.loader.bridge.masterVolume;
      }
      return this;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
      return this.loader.bridge.isMuted ? this.unmute() : this.mute();
    }

    /**
     * Destroy the application
     */
    destroy() {
      this.loader.destroy();
    }
  }

  // ============================================================================
  // GLOBAL API
  // ============================================================================

  const CleanCanvas = {
    /**
     * Load a WASM module
     * @param {string} url - URL to the .wasm file
     * @param {Object} options - Load options
     * @returns {Promise<CleanCanvasApp>} Application instance
     */
    async load(url, options = {}) {
      const loader = new CleanCanvasLoader();
      const app = await loader.load(url, options);

      // Auto-start unless disabled
      if (options.autoStart !== false) {
        app.start();
      }

      return app;
    },

    /**
     * Create a new loader instance (for advanced use)
     */
    createLoader() {
      return new CleanCanvasLoader();
    },

    /**
     * Get version
     */
    version: '2.0.0'
  };

  // Export globally
  if (typeof window !== 'undefined') {
    window.CleanCanvas = CleanCanvas;
    window.CleanCanvasLoader = CleanCanvasLoader;
    window.CleanCanvasApp = CleanCanvasApp;
  }

  // Export for module systems
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CleanCanvas, CleanCanvasLoader, CleanCanvasApp };
  }

})();
