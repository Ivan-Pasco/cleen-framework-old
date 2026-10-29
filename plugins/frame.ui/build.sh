#!/bin/bash
set -e
cd "$(dirname "$0")"

# Requires compiler 0.30.103+ (local variable index fix + complex-function returns fix)
CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"
if ! command -v "$CLN" &>/dev/null; then
	echo "ERROR: cln compiler not found in PATH"
	echo "Install it with: cleen install latest"
	exit 1
fi

"$CLN" compile src/main.cln -o plugin.wasm --target=plugin
echo "Built frame.ui plugin -> plugin.wasm (compiler $("$CLN" --version 2>/dev/null | awk '{print $NF}'))"

# Strip unused imports (session, auth, routing) that the compiler emits
# unconditionally but the plugin loader doesn't provide.
# Requires: wasm-tools (cargo install wasm-tools)
if ! command -v wasm-tools &>/dev/null; then
	echo "ERROR: wasm-tools not found. Install with: cargo install wasm-tools"
	echo "This step is required — without it, server bridge imports remain in the plugin"
	echo "and cause instantiation failures in UI-only projects."
	exit 1
fi
if ! command -v python3 &>/dev/null; then
	echo "ERROR: python3 not found. Install Python 3 to continue."
	exit 1
fi
wasm-tools print plugin.wasm > /tmp/frame_ui_strip.wat
python3 ../../scripts/strip-unused-wasm-imports.py /tmp/frame_ui_strip.wat /tmp/frame_ui_stripped.wat
wasm-tools parse /tmp/frame_ui_stripped.wat -o plugin.wasm
rm -f /tmp/frame_ui_strip.wat /tmp/frame_ui_stripped.wat
echo "Stripped unused imports from plugin.wasm"
# Refresh build-manifest.json to match the post-strip plugin.wasm.
# See bug #73177fafd75f.
python3 ../../scripts/refresh-manifest-hash.py .
