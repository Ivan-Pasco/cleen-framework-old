#!/bin/bash
# Build every Frame plugin from source (plugins/*/build.sh).
#
# Environment:
#   CLEEN_CLN   compiler (default: ~/.cleen/bin/cln — plain `cln` on PATH is a
#               different toolchain). Passed to each build.sh as CLN_COMPILER.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/../plugins"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"

if [ ! -x "$CLN" ]; then
    echo "Compiler not found at: $CLN (set CLEEN_CLN to override)" >&2
    exit 1
fi

echo "Building Frame plugins with $("$CLN" --version)"
echo "========================="

BUILT=0
FAILED=0

for plugin_dir in "$PLUGINS_DIR"/*/; do
    plugin_name=$(basename "$plugin_dir")
    if [ ! -f "$plugin_dir/build.sh" ]; then
        echo "  ✗ $plugin_name has no build.sh"
        FAILED=$((FAILED + 1))
        continue
    fi
    if (cd "$plugin_dir" && CLN_COMPILER="$CLN" bash build.sh); then
        echo "  ✓ $plugin_name"
        BUILT=$((BUILT + 1))
    else
        echo "  ✗ $plugin_name build failed"
        FAILED=$((FAILED + 1))
    fi
done

echo "========================="
echo "Build complete: $BUILT succeeded, $FAILED failed"
[ "$FAILED" -eq 0 ]
