#!/bin/bash
# Integration test: GET /_debug/capture on the compound `endpoints server:` block.
#
# Mirrors debug-capture-endpoint-test.sh (which uses the bare `server:` +
# separate `endpoints:` form). The compound form parses as block_name="endpoints"
# with a "model_name":"server" attribute — a distinct expansion path in
# frame.server that previously did NOT fire emit_dev_capture(ctx). This test
# guards the fix in frame.server 2.9.4: expand_block_typed now routes the
# compound form to expand_endpoints_typed followed by emit_dev_capture(ctx),
# so `endpoints server:` apps (like clean-errors) can self-capture.
#
# Requires:
#   - clean-server built with dev_capture.rs (register_dev_capture_functions())
#   - frame.server plugin ≥ 2.9.4 installed
#   - curl, jq
#
# Dashboard: #e4c3538d8242

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d)"
SERVER_PID=""
trap 'rm -rf "$WORK_DIR"; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

CLEAN_SERVER="${CLEAN_SERVER:-${CLEEN_SERVER:-$HOME/.cleen/bin/clean-server}}"
CLN="${CLN:-$HOME/.cleen/bin/cln}"
# Passed to clean-server with --port (port 3000 is often taken locally).
PORT="${CLEEN_TEST_PORT:-${PORT:-3475}}"
TIMEOUT=5

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
section() { echo; echo "== $1 =="; }

# ── Prereqs ─────────────────────────────────────────────────────────────
if ! command -v curl >/dev/null; then echo "SKIP: curl not installed"; exit 0; fi
if ! command -v jq >/dev/null; then echo "SKIP: jq not installed"; exit 0; fi
if [ ! -x "$CLEAN_SERVER" ]; then echo "SKIP: clean-server binary not found at $CLEAN_SERVER"; exit 0; fi
if [ ! -x "$CLN" ]; then echo "SKIP: cln compiler not found at $CLN"; exit 0; fi

# ── Test app: compound `endpoints server:` form ─────────────────────────
cat > "$WORK_DIR/main.cln" <<'EOF'
plugins:
	frame.server

start:
	printl("[boot] dev-capture-endpoint-server-test ready")

endpoints server:
	port: 3000

	GET "/ok":
		return http.respond(200, "text/plain", "ok")
	GET "/fail":
		return http.respond(500, "text/plain", "boom")
EOF

if ! "$CLN" compile --plugins "$WORK_DIR/main.cln" -o "$WORK_DIR/main.wasm" > "$WORK_DIR/compile.log" 2>&1; then
    echo "FAIL: dev-capture-endpoint-server-test (compile failed — see $WORK_DIR/compile.log)"
    cat "$WORK_DIR/compile.log"
    exit 1
fi

# ── Static guard: the compiled WASM must reference _dev_snapshot AND /_debug/capture ──
# This is the direct regression protection — without the fix in 2.9.4 both are absent.
if command -v wasm-tools >/dev/null; then
    section "static guard: emitted WASM contains dev-capture symbols"
    dev_hits=$(wasm-tools print "$WORK_DIR/main.wasm" 2>/dev/null | grep -cE "_dev_snapshot|_debug/capture" || echo 0)
    if [ "$dev_hits" -gt 0 ]; then
        pass "emitted WASM contains _dev_snapshot/_debug/capture ($dev_hits hits)"
    else
        fail "emitted WASM missing _dev_snapshot/_debug/capture — emit_dev_capture(ctx) not fired for endpoints server:"
    fi
fi

start_server() {
    local dev_flag="$1"
    if [ "$dev_flag" = "on" ]; then
        CLEAN_DEV=1 "$CLEAN_SERVER" "$WORK_DIR/main.wasm" --port "$PORT" > "$WORK_DIR/server.log" 2>&1 &
    else
        unset CLEAN_DEV
        "$CLEAN_SERVER" "$WORK_DIR/main.wasm" --port "$PORT" > "$WORK_DIR/server.log" 2>&1 &
    fi
    SERVER_PID=$!
    for i in $(seq 1 20); do
        if curl -sf "http://localhost:$PORT/ok" > /dev/null 2>&1; then return 0; fi
        sleep 0.25
    done
    return 1
}

stop_server() {
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
        SERVER_PID=""
    fi
}

# ── Case 1: CLEAN_DEV unset → 404 ────────────────────────────────────────
section "CLEAN_DEV unset → 404"
if start_server off; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -m $TIMEOUT "http://localhost:$PORT/_debug/capture")
    if [ "$code" = "404" ]; then pass "returns 404 when CLEAN_DEV unset"; else fail "expected 404, got $code"; fi
    stop_server
else
    fail "server failed to start (CLEAN_DEV unset)"
fi

# ── Case 2: CLEAN_DEV=1 → 200 with expected shape ────────────────────────
section "CLEAN_DEV=1 → 200 with snapshot shape"
if start_server on; then
    curl -sf -m $TIMEOUT "http://localhost:$PORT/ok" > /dev/null
    curl -s -m $TIMEOUT -o /dev/null "http://localhost:$PORT/fail"

    body="$(curl -sf -m $TIMEOUT "http://localhost:$PORT/_debug/capture")"
    if [ -z "$body" ]; then
        fail "capture returned empty body"
    else
        for key in source_tree current_wasm last_log_lines request_log project_hash captured_at; do
            if echo "$body" | jq -e ".$key" > /dev/null 2>&1; then
                pass "response contains $key"
            else
                fail "response missing $key"
            fi
        done

        kind="$(echo "$body" | jq -r '.pass_criteria.kind // empty')"
        if [ "$kind" = "runtime_crash" ]; then
            pass "pass_criteria.kind == runtime_crash after 500 request"
        else
            fail "pass_criteria.kind expected runtime_crash, got '$kind'"
        fi

        expected_status="$(echo "$body" | jq -r '.pass_criteria.expected_status // empty')"
        if [ "$expected_status" = "200" ]; then
            pass "pass_criteria.expected_status == 200 (default)"
        else
            fail "pass_criteria.expected_status expected 200, got '$expected_status'"
        fi
    fi
    stop_server
else
    fail "server failed to start (CLEAN_DEV=1)"
fi

# ── Case 3: pass_criteria omitted when no failing requests ───────────────
section "no failing requests → pass_criteria omitted"
if start_server on; then
    curl -sf -m $TIMEOUT "http://localhost:$PORT/ok" > /dev/null
    body="$(curl -sf -m $TIMEOUT "http://localhost:$PORT/_debug/capture")"
    kind="$(echo "$body" | jq -r '.pass_criteria.kind // empty')"
    if [ -z "$kind" ]; then
        pass "pass_criteria omitted with clean log"
    else
        fail "pass_criteria should be omitted, got kind=$kind"
    fi
    stop_server
fi

# ── Case 4: wrong_output_hint wins over crash log ────────────────────────
section "wrong_output_hint is authoritative"
if start_server on; then
    curl -s -m $TIMEOUT -o /dev/null "http://localhost:$PORT/fail"
    body="$(curl -sf -m $TIMEOUT "http://localhost:$PORT/_debug/capture?wrong_output_hint=expected_greeting")"
    kind="$(echo "$body" | jq -r '.pass_criteria.kind // empty')"
    regex="$(echo "$body" | jq -r '.pass_criteria.expected_stdout_regex // empty')"
    if [ "$kind" = "wrong_output" ] && [ "$regex" = "expected_greeting" ]; then
        pass "hint produces wrong_output with expected_stdout_regex=hint"
    else
        fail "expected wrong_output/expected_greeting, got kind=$kind regex=$regex"
    fi
    stop_server
fi

# ── Summary ─────────────────────────────────────────────────────────────
echo
if [ "$FAIL_COUNT" -eq 0 ]; then
    echo "PASS: debug-capture-endpoint-server-test ($PASS_COUNT checks)"
    exit 0
else
    echo "FAIL: debug-capture-endpoint-server-test ($FAIL_COUNT failed / $PASS_COUNT passed)"
    exit 1
fi
