# frame.server — Changelog

Extracted from plugin.toml description on 2026-07-19. Each entry below was previously packed into the plugin.toml `description` field; they are preserved verbatim here.

> Intro (pre-versioned): Server plugin for Clean Language - provides routing, request context, response helpers, and authentication guards.

## Unreleased

- Route sub-blocks (frame-server.ebnf §3.4): `guard:` (`role in [...]`, `role == "..."`, `authenticated`, boolean expressions; a failing clause answers 401), `cache:`, `middleware: [...]`, `returns:` and `handle:`. The inline `[roles] cache() middleware()` form keeps working and can be combined with them (order: SRV-B014).
- `middleware Name` declarations (`Request handle(Request req)`) are compiled: the plugin emits the handler and a `Name()` that every middleware list can call; setting `req.response` ends the request. The `Request` type gains the `response` field. Before, the declaration was dropped.
- `server: middleware: [A, B]` runs middleware for every `endpoints:` route, before its guard.

## v2.9.9

- plugin.toml: the legacy `_json_encode` / `_json_decode` bridges are no longer declared. `json.*` lowers to `_json_encode_v2` / `_json_encode_pretty_v2` / `_json_decode_v2` / `_json_get`, so nothing emits the legacy pair, and the `_json_encode` declaration (`params = ["string"]`, a ptr+len string) differed from function-registry.toml (`params = ["any"]`). clean-server keeps implementing both for modules built before Delivery 2. Every [bridge] declaration now matches the registry (`scripts/check-bridge-registry.py`).

## v2.9.8

Review fixes (spec: frame-server.ebnf, frame-server-semantics.md, plugin-contract.md §3.6).

- `middleware()` route modifier compiles and works: each middleware result is a declared `string` local, and a non-empty result short-circuits the request. It previously failed with SEM007 (undeclared `__mw_N`).
- `server: handle:` — the global error handler is parameterless and reads the error from `X-Clean-Error`, so clean-server can call it (it was never reachable before); `any <ident>:` accepts any identifier; `req.*` works inside it; raw returns are wrapped like route handlers; a `handle:` block with only typed clauses registers nothing, so the server's default 500 applies instead of an empty 200.
- `notFound(message?)`, `badRequest(message?)`, `redirect(url, status?)` accept the argument forms frame-server.ebnf §4 defines (default parameters); `notFoundMsg` stays as an alias.
- Error envelopes escape newlines, carriage returns and tabs, so a message such as a wasm trap backtrace no longer produces invalid JSON (SRV-I002).
- `routes:` `redirect:` defaults to 301 (frame-server.ebnf §10.1) and its validation accepts the `→` separator.
- An `endpoints:` block is no longer cut off after 100 routes; handler, LIVE and validation scanners have no line caps.
- LIVE: a body with `live.onClose:` but no `live.onMessage:` no longer leaks the close block into onConnect; comment-only handler sections compile.
- `PUT "` / `GET "` inside identifiers such as `INPUT "` are not taken for route headers.
- In a handler that also calls a response helper, `return "literal"` is still sent as a JSON body; `render(` / `renderWith(` count as response helpers.
- Block validation runs inside `expand_block_typed` (FRAME-SERVER-E020), so malformed guard lists and cache values are reported even when the compiler does not call the `validate` export.
- plugin.toml: `_dev_snapshot` declared (matches function-registry.toml); `registers_handler_at_arg` declared on `_http_route`, `_http_route_protected`, `_http_sse_route`, `_http_ws_route` (onConnect) and `_http_set_global_error_handler`; empty `server_init` / `per_request` lifecycle slots removed.
- Refactor: module helpers and dev-capture helpers are emitted through shared builders; patterns compile against the current API.

## v2.9.7

fix container-payload layouts in the `_json_encode_v2`, `_json_encode_pretty_v2`, and `_json_decode_v2` bridges shipped in v2.9.6. The v2.9.6 code was built against a stale BOXED_ANY_ABI.md that described tag-5/tag-6 payloads as Clean `list<any>` / `pairs<string,any>` structures (16-byte and 8-byte headers with capacity/type_id fields). Foundation `[P1-hotfix-3]` (commit 1e22de3) corrected §3.2/§3.3 to what the compiler's `__json_from_cln_list` / `__json_from_cln_pairs` helpers actually emit: JSON-tree fragments with 4-byte `count` headers only. Encode paths now read tag-5 at `[count @0][elem_ptr × count @4]` (stride 4, total 4+count*4) and tag-6 at `[count @0][(key_ptr, val_ptr) × count @4]` (stride 8, total 4+count*8). Decode paths write the same shape. All `type_id` / `capacity` / `padding` writes removed. Added a compiler-format bit-for-bit compat test to `test_json_v2.mjs` (54/54 pass). Blast radius of v2.9.6 was zero — no compiler had yet emitted `_json_encode_v2` calls, so no deployed WASM used the broken path. **v2.9.6 is BROKEN — do not use.**

## v2.9.6

BROKEN — container-offset math built against a stale spec (superseded by v2.9.7). Added `_json_encode_v2`, `_json_encode_pretty_v2`, `_json_decode_v2` for the Delivery 2 JSON migration. Do not deploy.

## v2.9.4

extend dev-capture emission to the compound `endpoints server:` block. In 2.9.2/2.9.3 emit_dev_capture(ctx) fired only from expand_server_typed, which handles the bare `server:` block. Single-block apps such as clean-errors use `endpoints server:` (parser lumps the second identifier under attrs_json's model_name key), which routes through expand_endpoints_typed and therefore silently skipped dev-capture emission — the /_debug/capture route was never registered and the most bug-prone app in the ecosystem could not self-capture. The routing branch in expand_block_typed now detects `"model_name":"server"` on an endpoints block and calls emit_dev_capture(ctx) after expand_endpoints_typed. Bare `server:` + separate `endpoints:` continues to fire dev-capture exactly once from expand_server_typed (unchanged). Dashboard #e4c3538d8242.

## v2.9.3

three fixes to the emitted dev-capture handler that were exposed once cln 0.33.71+ let the emission compile through end-to-end. (1) The fragment parser used by _emit_stmt_from_source folds a statement following `if X return Y` inside a while body into the then-branch, producing an infinite loop. Rewrote countJsonArrayEntries and findMostRecentFailingStatus with explicit `else` on the increment/decrement. (2) In-WASM json.get calls the compiler stdlib's json.decode which fully parses the JSON into a WASM-memory tree; on real projects the snapshot is 500KB+ (source_tree of .cln files + base64 WASM) and blows the 32MB standard-tier memory cap. Switched all four json.get calls to the _json_get host bridge, which parses via serde_json on the host without WASM memory pressure. (3) The wrong_output_hint hint comes from the URL query string, not from path params — changed req.param(wrong_output_hint) to req.query(...). All four integration-test cases now pass end-to-end.

## v2.9.2

re-enable dev-mode capture emission. cln 0.33.71 shipped with _dev_snapshot in the embedded bridge registry, so the emit_dev_capture(ctx) call in expand_server_typed is uncommented and min_compiler_version bumped to 0.33.71. The auto-injected GET /_debug/capture handler now compiles and returns the real snapshot JSON (source_tree, current_wasm, last_log_lines, request_log, project_hash, captured_at, plus pass_criteria selected per SERVER_EXTENSIONS.md §pass_criteria rules).

## v2.9.1

hotfix for the 2.9.0 dev-capture regression. Two problems shipped in 2.9.0: (1) re-declared _dev_snapshot in [bridge], which triggered PLUGIN-REGISTRY-DRIFT on cln 0.33.70 (registry entry landed in foundation but no compiler release has it yet); (2) expand_server_typed emitted a handler that calls _dev_snapshot(), which the same shipped compiler cannot resolve at user-app codegen time → "function not found in function_map". Fix: remove the [bridge] declaration AND comment out the emit_dev_capture() call site. Source of the emit helper, dc_body_* fragments, and dev/*.cln canonicals are preserved in-tree; re-enable when cln 0.33.71+ ships with _dev_snapshot in its embedded registry, then bump min_compiler_version accordingly.

## v2.9.0

dev-mode capture endpoint — auto-injects GET /_debug/capture in expand_server_typed, gated on CLEAN_DEV=1 at both the framework endpoint and the underlying _dev_snapshot() bridge. Merges pass_criteria (per SERVER_EXTENSIONS.md §pass_criteria selection rules) into the snapshot JSON before returning it. Handler + selector helpers canonically live in plugins/frame.server/dev/{capture,pass_criteria}.cln and are mirrored inline in src/main.cln.

## v2.8.6

byte-handle bridge signature parity — _req_body_bytes returns="ptr" (was incorrectly declared as "integer" in 2.8.5) and _fs_write_bytes returns="i32" (was incorrectly declared as "integer" in 2.8.5). Both now match foundation/platform-architecture/function-registry.toml exactly. v2.8.5 shipped with these signature mismatches and failed at plugin-load with PLUGIN-REGISTRY-DRIFT — any user program calling req.body_bytes/fs.write_bytes would have errored. This release repairs that. Language surfaces (req.body_bytes, fs.write_bytes) remain "integer" at the user layer per spec/type-system.md §9b — the compiler applies the ptr/i32→integer coercion at the alias site.

## v2.8.5

opaque-byte-handle bridges — declares _req_body_bytes ([bridge]) and adds req.body_bytes / fs.write_bytes to [language].functions per foundation/spec/type-system.md §9b. Enables binary tarball upload flow (req.body_bytes → crypto.sha256 → fs.write_bytes) with no UTF-8 detour. Bridge implementations already shipped in clean-server (bridge.rs, host-bridge/wasm_linker/file_io.rs) and clean-node-server. Framework release closes the loop so downstream `cleen frame install latest` picks up the declarations.

## v2.8.4

_json_get flipped to any-in/any-out (params = ["any", "string"], returns = "any", expand_strings = false) so it accepts already-boxed values (e.g. SQL results) without double-boxing. Requires compiler 0.33.54+ (any-bridge handling + resolver guard). Coordinates with compiler prompt 172cec6f / 4de6f0df.

## v2.8.3

plugin.wasm rebuild against 2.8.2 i64 signatures using cln 0.33.27 — pairs with WS-SEND-I32-VS-I64-001 (e6e66d65) fix. Compiler team baselines registry edit against this artifact.

## v2.8.2

WS-SEND-I32-VS-I64-001 coordination (e6e66d65) — five _ws_* bridge entries and their live.* language aliases changed client_id from `integer` to `i64` to match clean-server's i64 end-to-end handling. Coordinated with compiler prompt cceb276d and server prompt fa7765e2. Compiler registry edit lands after this plugin ships. Do not touch _ws_broadcast / _ws_room_broadcast — they take room name (string), not client_id. —

## v2.8.0

Plugin Contracts v3 typed-emission migration — atomic switch from v1 string emission to v3 typed AST emission. Closes 5e144689da64, 835d361c9515, cdb735a9453a, 7f8d244b7a46. See foundation/spec/plugins/contracts/typed-emission.md.

