#!/bin/bash
set -e
cd "$(dirname "$0")"

CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"

"$CLN" compile src/main.cln -o plugin.wasm --target=plugin
echo "Built frame.storage plugin -> plugin.wasm"

# Strip unused imports (session, auth, HTTP client, file I/O, math, etc.)
# that the compiler emits unconditionally but the plugin loader doesn't provide.
# Requires: wasm-tools (cargo install wasm-tools)
if command -v wasm-tools &>/dev/null && command -v python3 &>/dev/null; then
	wasm-tools print plugin.wasm > /tmp/frame_storage_strip.wat
	python3 ../../scripts/strip-unused-wasm-imports.py /tmp/frame_storage_strip.wat /tmp/frame_storage_stripped.wat
	wasm-tools parse /tmp/frame_storage_stripped.wat -o plugin.wasm
	rm -f /tmp/frame_storage_strip.wat /tmp/frame_storage_stripped.wat
	echo "Stripped unused imports from plugin.wasm"
	# Refresh build-manifest.json to match the post-strip plugin.wasm.
	# See bug #73177fafd75f.
	python3 ../../scripts/refresh-manifest-hash.py .
else
	echo "WARNING: wasm-tools or python3 not found, skipping import stripping"
	echo "Plugin may fail to load if compiler emits unused host function imports"
fi
