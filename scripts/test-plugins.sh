#!/bin/bash
# Run the tests of every Frame plugin.
#
# Each plugin is covered by up to two kinds of test:
#
#   1. Helper tests — plugins/<plugin>/tests/*.cln. They call the plugin's
#      parsing / validation helpers (validate_block, ...) defined in
#      plugins/<plugin>/src/main.cln. Each test file is combined with its
#      plugin's source and type-checked with `cln check`:
#        a. Split the test file at the first `functions:` line.
#           Head = comments + start: (anything before functions:)
#           Tail = the test's functions: block
#        b. Concatenate: head + plugin/src/main.cln + assert helper + tail
#           (section order required by Clean: start, then functions blocks)
#      The combined file is type-checked with `cln check`, then compiled and
#      run in clean-server (run_helper_test below). The plugin source imports
#      the compiler's typed-emission bridges (_batch_*, _emit_*), which no
#      runtime provides, so scripts/stub-wasm-imports.py turns those imports
#      into trapping stubs first. A helper test fails when the run traps
#      (a failed assert raises) or prints a FAIL line.
#
#   2. Unit suite — tests/framework/unit/plugins/<short-name>/ (frame.auth ->
#      auth). These are executed for real by run-framework-tests.sh: compiled
#      against the installed plugin and run inside clean-server.
#
# A plugin with neither is reported as "without tests" and fails the run.
#
# Usage: scripts/test-plugins.sh [--no-unit] [plugin-name ...]
#   --no-unit   only run the helper tests (the CI framework step already runs
#               every unit suite)
#   default     every plugin, both kinds of test
#
# The compiler is $CLEEN_CLN, default ~/.cleen/bin/cln (the old toolchain
# these plugins are built with — plain `cln` on PATH is a different
# toolchain). run-framework-tests.sh honours CLEEN_SERVER and
# FRAMEWORK_TEST_PORT / CLEEN_TEST_PORT.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/../plugins"
UNIT_DIR="$SCRIPT_DIR/../tests/framework/unit/plugins"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"

RUN_UNIT=true
ONLY=" "
for arg in "$@"; do
    case "$arg" in
        --no-unit) RUN_UNIT=false ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) ONLY="$ONLY$arg " ;;
    esac
done

if [ ! -x "$CLN" ]; then
    echo "Compiler not found at: $CLN (set CLEEN_CLN to override)" >&2
    exit 1
fi
SERVER="${CLEEN_SERVER:-$HOME/.cleen/bin/clean-server}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Compile a combined helper test, stub the compiler-only imports and run its
# start: block in clean-server. Succeeds when the server comes up (start:
# finished) with no FAIL line in the output.
run_helper_test() {
    local combined="$1" src_main="$2" wasm="$TMP_DIR/helper.wasm" log="$TMP_DIR/helper.log"
    "$CLN" compile "$combined" -o "$TMP_DIR/helper-raw.wasm" > "$log" 2>&1 || { cat "$log"; return 1; }
    python3 "$SCRIPT_DIR/stub-wasm-imports.py" "$TMP_DIR/helper-raw.wasm" "$wasm" "$src_main" >> "$log" 2>&1 || { cat "$log"; return 1; }
    local port
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
    "$SERVER" "$wasm" --port "$port" < /dev/null > "$log" 2>&1 &
    local pid=$! i
    for i in $(seq 1 100); do
        grep -q "Server listening" "$log" && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    local up=false
    grep -q "Server listening" "$log" && up=true
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    if [ "$up" = true ] && ! grep -q "FAIL" "$log"; then
        return 0
    fi
    grep -E "FAIL|assertion failed|rror" "$log" | head -10
    return 1
}

# Minimal assert() implementation injected into combined test files.
# Clean Language has no built-in assert.
ASSERT_HELPER='
functions:
	void assert(boolean cond)
		if not cond
			error("assertion failed")
'

echo "Testing Frame plugins..."
echo "========================"
echo ""

PASSED=0
FAILED=0
NO_TESTS=0

for plugin_dir in "$PLUGINS_DIR"/*/; do
    plugin_name=$(basename "$plugin_dir")
    if [ "$ONLY" != " " ] && [[ "$ONLY" != *" $plugin_name "* ]]; then
        continue
    fi
    src_main="$plugin_dir/src/main.cln"
    tests_dir="$plugin_dir/tests"
    short_name="${plugin_name#frame.}"
    unit_suite="$UNIT_DIR/$short_name"

    has_helper_tests=false
    if [ -d "$tests_dir" ] && ls "$tests_dir"/*.cln >/dev/null 2>&1; then
        has_helper_tests=true
    fi
    has_unit_suite=false
    if [ -d "$unit_suite" ] && ls "$unit_suite"/*.cln >/dev/null 2>&1; then
        has_unit_suite=true
    fi

    if [ "$has_helper_tests" = false ] && [ "$has_unit_suite" = false ]; then
        echo "⚠ $plugin_name has no tests (plugins/$plugin_name/tests/ or tests/framework/unit/plugins/$short_name/)"
        echo ""
        ((NO_TESTS++)) || true
        continue
    fi

    echo "Testing $plugin_name..."

    if [ "$has_helper_tests" = true ]; then
        if [ ! -f "$src_main" ]; then
            echo "  ✗ tests/ present but no src/main.cln"
            ((FAILED++)) || true
        else
            for test_file in "$tests_dir"/*.cln; do
                test_name=$(basename "$test_file")
                combined="$TMP_DIR/${plugin_name}-${test_name}"
                rm -f "$TMP_DIR/head.cln" "$TMP_DIR/tail.cln"

                awk '
                    BEGIN { mode = "head" }
                    mode == "head" && /^functions:/ { mode = "tail" }
                    mode == "head" { print > head_file; next }
                    mode == "tail" { print > tail_file }
                ' head_file="$TMP_DIR/head.cln" tail_file="$TMP_DIR/tail.cln" "$test_file"
                [ -f "$TMP_DIR/head.cln" ] || : > "$TMP_DIR/head.cln"
                [ -f "$TMP_DIR/tail.cln" ] || : > "$TMP_DIR/tail.cln"

                {
                    cat "$TMP_DIR/head.cln"
                    cat "$src_main"
                    printf '%s\n' "$ASSERT_HELPER"
                    cat "$TMP_DIR/tail.cln"
                } > "$combined"

                if "$CLN" check "$combined" >/dev/null 2>&1; then
                    if run_out=$(run_helper_test "$combined" "$src_main"); then
                        echo "  ✓ $test_name passes against src/main.cln"
                        ((PASSED++)) || true
                    else
                        echo "  ✗ $test_name failed when run:"
                        printf '%s\n' "$run_out" | sed 's/^/      /' | head -20
                        ((FAILED++)) || true
                    fi
                else
                    echo "  ✗ $test_name failed:"
                    "$CLN" check "$combined" 2>&1 | sed 's/^/      /' | head -20
                    ((FAILED++)) || true
                fi
            done
        fi
    fi

    if [ "$has_unit_suite" = true ] && [ "$RUN_UNIT" = true ]; then
        log="$TMP_DIR/${plugin_name}-unit.log"
        if "$SCRIPT_DIR/run-framework-tests.sh" "unit/plugins/$short_name" >"$log" 2>&1; then
            count=$(grep -c '\[PASS\].*unit/plugins/' "$log" || true)
            echo "  ✓ unit suite unit/plugins/$short_name ($count passed)"
            ((PASSED++)) || true
        else
            echo "  ✗ unit suite unit/plugins/$short_name failed:"
            grep -E '\[FAIL\]|FAIL:' "$log" | sed 's/^/      /' | head -20
            ((FAILED++)) || true
        fi
    fi
    echo ""
done

echo "========================"
echo "Tests complete: $PASSED passed, $FAILED failed, $NO_TESTS plugins without tests"

if [ $FAILED -gt 0 ] || [ $NO_TESTS -gt 0 ]; then
    exit 1
fi
