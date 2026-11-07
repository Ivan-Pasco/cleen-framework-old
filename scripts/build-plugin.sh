#!/bin/bash
# Build one Frame plugin: compile src/main.cln to plugin.wasm, strip the
# host imports the compiler emits unconditionally but the plugin loader does
# not provide (scripts/strip-unused-wasm-imports.py), then refresh
# build-manifest.json so its size/sha256 describe the stripped plugin.wasm
# (cln compile records the pre-strip values; bug #73177fafd75f).
#
# Usage: scripts/build-plugin.sh <plugin-dir> [--require-strip]
#   --require-strip  fail when wasm-tools or python3 is missing instead of
#                    warning and keeping the unstripped plugin.wasm
#
# Environment: CLN_COMPILER — compiler (default ~/.cleen/bin/cln; plain `cln`
# on PATH is a different toolchain).
set -euo pipefail

PLUGIN_DIR="${1:?usage: build-plugin.sh <plugin-dir> [--require-strip]}"
REQUIRE_STRIP=false
[ "${2:-}" = "--require-strip" ] && REQUIRE_STRIP=true
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"

cd "$PLUGIN_DIR"
name="$(basename "$(pwd)")"
if ! command -v "$CLN" &>/dev/null; then
    echo "ERROR: compiler not found: $CLN (set CLN_COMPILER)" >&2
    exit 1
fi

"$CLN" compile src/main.cln -o plugin.wasm --target=plugin
echo "Built $name plugin -> plugin.wasm (compiler $("$CLN" --version 2>/dev/null | awk '{print $NF}'))"

if ! command -v wasm-tools &>/dev/null || ! command -v python3 &>/dev/null; then
    if [ "$REQUIRE_STRIP" = true ]; then
        echo "ERROR: wasm-tools and python3 are required to strip unused imports from $name" >&2
        echo "(install wasm-tools with: cargo install wasm-tools)" >&2
        exit 1
    fi
    echo "WARNING: wasm-tools or python3 not found, skipping import stripping"
    echo "Plugin may fail to load if compiler emits unused host function imports"
    exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
wasm-tools print plugin.wasm > "$work/plugin.wat"
python3 "$SCRIPT_DIR/strip-unused-wasm-imports.py" "$work/plugin.wat" "$work/stripped.wat"
wasm-tools parse "$work/stripped.wat" -o plugin.wasm
echo "Stripped unused imports from plugin.wasm"
python3 "$SCRIPT_DIR/refresh-manifest-hash.py" .
