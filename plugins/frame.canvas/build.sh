#!/bin/bash
set -e
cd "$(dirname "$0")"
"${CLN_COMPILER:-$HOME/.cleen/bin/cln}" compile src/main.cln -o plugin.wasm --target=plugin
echo "Built frame.canvas plugin -> plugin.wasm"
