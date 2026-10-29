#!/bin/bash
set -e
cd "$(dirname "$0")"

CLN="${CLN_COMPILER:-$HOME/.cleen/bin/cln}"
if ! command -v "$CLN" &>/dev/null; then
    echo "ERROR: cln compiler not found in PATH"
    exit 1
fi

# Type-check tests (test file must come first so start: precedes functions:)
echo "Type-checking tests..."
cat tests/test_expand.cln src/main.cln > /tmp/frame_client_test_combined.cln
"$CLN" check /tmp/frame_client_test_combined.cln
rm -f /tmp/frame_client_test_combined.cln

"$CLN" compile src/main.cln -o plugin.wasm --target=plugin
echo "Built frame.client plugin -> plugin.wasm (compiler $("$CLN" --version 2>/dev/null | awk '{print $NF}'))"
