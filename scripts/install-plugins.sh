#!/bin/bash
# Install the Frame plugins from this checkout into ~/.cleen/plugins/.
#
# Layout written for each plugin (matches what `cleen frame install` creates):
#   ~/.cleen/plugins/<name>/<version>/   plugin.toml, plugin.wasm, ...  (read by the compiler)
#   ~/.cleen/plugins/<name>/.active-version                             (pins <version>)
#   ~/.cleen/plugins/<name>/             same files at the top level    (read by clean-server,
#                                                                         e.g. frame.ui/runtime/loader.js)
#
# Usage: scripts/install-plugins.sh [plugin-name ...]   (default: every plugin)
#
# Environment:
#   CLEEN_CLN           compiler used when a plugin.wasm is missing
#                       (default: ~/.cleen/bin/cln — plain `cln` on PATH is a
#                       different toolchain)
#   CLEEN_PLUGINS_DIR   install root (default: ~/.cleen/plugins)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_DIR="$(cd "$SCRIPT_DIR/../plugins" && pwd)"
INSTALL_DIR="${CLEEN_PLUGINS_DIR:-$HOME/.cleen/plugins}"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"

# Files and folders that make up an installed plugin. Anything else in a
# plugin folder (scripts/, tests/, node_modules/) is development-only.
PAYLOAD=(plugin.toml plugin.wasm build-manifest.json runtime patterns templates src)

if [ $# -gt 0 ]; then
    PLUGINS=("$@")
else
    PLUGINS=()
    for dir in "$PLUGINS_DIR"/*/; do
        PLUGINS+=("$(basename "$dir")")
    done
fi

mkdir -p "$INSTALL_DIR"
INSTALLED=0
FAILED=0

for plugin_name in "${PLUGINS[@]}"; do
    plugin_dir="$PLUGINS_DIR/$plugin_name"
    if [ ! -f "$plugin_dir/plugin.toml" ]; then
        echo "  ✗ $plugin_name: no plugin.toml at $plugin_dir"
        FAILED=$((FAILED + 1))
        continue
    fi

    version=$(grep -E '^version[[:space:]]*=' "$plugin_dir/plugin.toml" | head -1 | sed -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')
    if [ -z "$version" ]; then
        echo "  ✗ $plugin_name: no version in plugin.toml"
        FAILED=$((FAILED + 1))
        continue
    fi

    if [ ! -f "$plugin_dir/plugin.wasm" ]; then
        echo "  … $plugin_name: plugin.wasm missing, building"
        if ! (cd "$plugin_dir" && CLN_COMPILER="$CLN" bash build.sh); then
            echo "  ✗ $plugin_name: build failed"
            FAILED=$((FAILED + 1))
            continue
        fi
    fi

    base="$INSTALL_DIR/$plugin_name"
    mkdir -p "$base/$version"
    for item in "${PAYLOAD[@]}"; do
        [ -e "$plugin_dir/$item" ] || continue
        rm -rf "${base:?}/$version/$item" "${base:?}/$item"
        cp -R "$plugin_dir/$item" "$base/$version/$item"
        cp -R "$plugin_dir/$item" "$base/$item"
    done
    printf '%s' "$version" > "$base/.active-version"
    echo "  ✓ $plugin_name@$version -> $base/$version"
    INSTALLED=$((INSTALLED + 1))
done

echo "Installed $INSTALLED plugin(s), $FAILED failed."
[ "$FAILED" -eq 0 ]
