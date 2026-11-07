#!/bin/bash
# Run the tests of every Frame plugin.
#
# Each plugin is covered by up to two kinds of test:
#
#   1. Helper tests — plugins/<plugin>/tests/*.cln. They call the plugin's
#      parsing / validation / source-generation helpers (validate_block, ...)
#      defined in plugins/<plugin>/src/main.cln. Each test file is combined
#      with its plugin's source, compiled and run in clean-server:
#        a. Split the test file at the first `functions:` line.
#           Head = comments + start: (anything before functions:)
#           Tail = the test's functions: block
#        b. Concatenate: head + a final `printl("PASS: ...")` line +
#           plugin/src/main.cln + assert helper + tail (section order
#           required by Clean: start, then functions blocks).
#        c. The plugin source declares the compiler's typed-emission bridges
#           (_emit_*, _batch_*, _expr_*, ...) as externals; only the compiler
#           provides them, so in the combined file each becomes a function
#           that fails the run if a helper ever calls it.
#      A test passes when the run prints its PASS: line; a failed assert()
#      stops the run with an error before it.
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
# toolchain); the server is $CLEEN_SERVER, default ~/.cleen/bin/clean-server.
# Both kinds of test honour FRAMEWORK_TEST_PORT / CLEEN_TEST_PORT.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/../plugins"
UNIT_DIR="$SCRIPT_DIR/../tests/framework/unit/plugins"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"
SERVER="${CLEEN_SERVER:-$HOME/.cleen/bin/clean-server}"
TEST_PORT="${FRAMEWORK_TEST_PORT:-${CLEEN_TEST_PORT:-3334}}"

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
if [ ! -x "$SERVER" ]; then
    echo "clean-server not found at: $SERVER (set CLEEN_SERVER to override)" >&2
    exit 1
fi
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Minimal assert() implementation injected into combined test files.
# Clean Language has no built-in assert.
ASSERT_HELPER='
functions:
	void assert(boolean cond)
		if not cond
			error("FAIL: assertion failed")
'

# Turn the typed-emission bridge externals of a plugin source into
# functions that stop the run when called (step c above).
trap_compiler_bridges() {
    python3 - "$1" <<'PY'
import re, sys
path = sys.argv[1]
lines = open(path).read().split('\n') + ['']
returns = {'integer': 'return 0', 'string': 'return ""', 'boolean': 'return false'}
bridge = re.compile(r'^\t(\w+)\s+(_(?:emit|batch|expr|stmt|type|ctx|inject|transform|ast)\w*)\(.*\)\s*$')
out, kept, traps, in_ext = [], [], [], False

def close_block():
    if any(l.strip() and not l.strip().startswith('//') for l in kept):
        out.append('external:')
        out.extend(kept)
    if traps:
        out.append('functions:')
        out.extend(traps)

for line in lines:
    if re.match(r'^external:\s*$', line):
        in_ext, kept, traps = True, [], []
        continue
    if in_ext and line.strip() and not line[0].isspace():
        in_ext = False
        close_block()
    if in_ext:
        m = bridge.match(line)
        if m:
            traps.append(line)
            traps.append('\t\terror("FAIL: %s is a compiler typed-emission bridge; a helper test cannot call it")' % m.group(2))
            if m.group(1) in returns:
                traps.append('\t\t' + returns[m.group(1)])
        else:
            kept.append(line)
        continue
    out.append(line)
if in_ext:
    close_block()
open(path, 'w').write('\n'.join(out))
PY
}

# Compile and run a combined helper test; print its output.
run_helper_test() {
    local combined="$1" verdict="$2"
    local wasm="${combined%.cln}.wasm" log="${combined%.cln}.log"
    if ! "$CLN" compile "$combined" -o "$wasm" > "$log" 2>&1; then
        grep -E '^error' "$log" | head -10
        return 1
    fi
    pkill -f "clean-server.*--port $TEST_PORT\$" 2>/dev/null || true
    "$SERVER" "$wasm" --port "$TEST_PORT" < /dev/null > "$log" 2>&1 &
    local pid=$! waited=0
    while [ $waited -lt 150 ] && kill -0 "$pid" 2>/dev/null && ! grep -qE "^$verdict\$|FAIL:|listening" "$log"; do
        sleep 0.1
        waited=$((waited + 1))
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    if grep -q "FAIL:" "$log" || ! grep -qE "^$verdict\$" "$log"; then
        grep -E 'FAIL:|error|Error' "$log" | grep -v ' INFO ' | head -10
        return 1
    fi
    return 0
}

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

                verdict="PASS: $plugin_name-$test_name"
                {
                    cat "$TMP_DIR/head.cln"
                    printf '\tprintl("%s")\n\n' "$verdict"
                    cat "$src_main"
                    printf '%s\n' "$ASSERT_HELPER"
                    cat "$TMP_DIR/tail.cln"
                } > "$combined"
                trap_compiler_bridges "$combined"

                if output="$(run_helper_test "$combined" "$verdict")"; then
                    echo "  ✓ $test_name passes against src/main.cln"
                    ((PASSED++)) || true
                else
                    echo "  ✗ $test_name failed:"
                    echo "$output" | sed 's/^/      /' | head -20
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
