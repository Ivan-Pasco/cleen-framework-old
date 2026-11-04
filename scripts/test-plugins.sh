#!/bin/bash
# Run tests for all Frame plugins.
#
# Plugin tests in plugins/*/tests/*.cln call expand_block / validate_block,
# which are defined in plugins/*/src/main.cln. To make those references
# resolve, each test file is combined with its plugin's source before being
# passed to the compiler:
#
#   1. Split test file at the first `functions:` line.
#      Head = comments + start: + (anything before functions:)
#      Tail = the test's functions: block
#   2. Concatenate: head + plugin/src/main.cln + assert_helper + tail
#      (section order required by Clean: import/start/state/class/functions)
#   3. Run `cln check` on the combined file to verify compilation.
#
# Usage: scripts/test-plugins.sh [plugin-name ...]   (default: every plugin)
# The compiler is $CLEEN_CLN, default ~/.cleen/bin/cln (the toolchain these
# plugins are built with — never the `cln` on PATH).
#
# `cln check` is used instead of `cln test` because the plugin runtime
# imports (e.g. _state_reset_all) aren't provided by the standalone runner —
# that's a cross-component gap. Compilation parity
# catches syntax, type, and signature regressions, which is what we need
# from CI on this layer.
set -e

# The plugins target this repository's toolchain (~/.cleen). A different
# compiler on PATH is never used.
CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# The old toolchain's compiler; plain `cln` on PATH is a different toolchain.
CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"
PLUGINS_DIR="$SCRIPT_DIR/../plugins"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"
ONLY=" $* "
TMP_DIR="$(mktemp -d)"
# Old-toolchain compiler. Plain `cln` on PATH is a different toolchain.
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"
if [ ! -x "$CLN" ]; then
    echo "Compiler not found at: $CLN (set CLEEN_CLN to override)" >&2
    exit 1
fi
trap 'rm -rf "$TMP_DIR"' EXIT

# Minimal assert() implementation injected into combined test files.
# Without this, every assert() call fails validation because Clean Language
# has no built-in assert.
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
    if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $plugin_name "* ]]; then
        continue
    fi
    src_main="$plugin_dir/src/main.cln"
    tests_dir="$plugin_dir/tests"

    if [ ! -d "$tests_dir" ]; then
        echo "⚠ $plugin_name has no tests directory"
        echo ""
        ((NO_TESTS++)) || true
        continue
    fi

    if [ ! -f "$src_main" ]; then
        echo "⚠ $plugin_name has tests/ but no src/main.cln — skipping"
        echo ""
        continue
    fi

    echo "Testing $plugin_name..."

    for test_file in "$tests_dir"/*.cln; do
        [ -f "$test_file" ] || continue

        test_name=$(basename "$test_file")
        combined="$TMP_DIR/${plugin_name}-${test_name}"

        # Split the test file at the first `functions:` line.
        awk '
            BEGIN { mode = "head" }
            mode == "head" && /^functions:/ { mode = "tail" }
            mode == "head" { print > head_file; next }
            mode == "tail" { print > tail_file }
        ' head_file="$TMP_DIR/head.cln" tail_file="$TMP_DIR/tail.cln" "$test_file"

        # If the test file lacks a `functions:` line, awk leaves tail empty;
        # treat the whole file as head and add an empty tail.
        [ -f "$TMP_DIR/tail.cln" ] || : > "$TMP_DIR/tail.cln"
        [ -f "$TMP_DIR/head.cln" ] || cp "$test_file" "$TMP_DIR/head.cln"

        # Order required by Clean: start:, then all functions: blocks.
        {
            cat "$TMP_DIR/head.cln"
            cat "$src_main"
            printf '%s\n' "$ASSERT_HELPER"
            cat "$TMP_DIR/tail.cln"
        } > "$combined"

        if "$CLN" check "$combined" >/dev/null 2>&1; then
            echo "  ✓ $test_name compiles cleanly"
            ((PASSED++)) || true
        else
            echo "  ✗ $test_name failed:"
            "$CLN" check "$combined" 2>&1 | sed 's/^/      /' | head -20
            ((FAILED++)) || true
        fi
    done
    echo ""
done

echo "========================"
echo "Tests complete: $PASSED passed, $FAILED failed, $NO_TESTS plugins without tests"

if [ $FAILED -gt 0 ]; then
    exit 1
fi
