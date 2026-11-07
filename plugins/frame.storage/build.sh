#!/bin/bash
# Build frame.storage (compile, strip unused imports, refresh the manifest):
# see scripts/build-plugin.sh.
exec bash "$(dirname "$0")/../../scripts/build-plugin.sh" "$(dirname "$0")"
