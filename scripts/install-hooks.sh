#!/bin/bash
# Install Clean Framework git hooks.
#
# Creates symlinks in .git/hooks/ pointing to scripts/hooks/.
# Idempotent: safe to run repeatedly.
#
# See tests/CONVENTIONS.md §6a for what each hook enforces.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HOOK_SOURCE_DIR="scripts/hooks"
# `git rev-parse --git-path hooks` resolves correctly in linked worktrees,
# where .git is a file and the hooks live in the main repository.
HOOK_TARGET_DIR="$(git rev-parse --git-path hooks)"

if [ ! -d "$HOOK_TARGET_DIR" ]; then
    echo "error: $HOOK_TARGET_DIR does not exist. Are you inside a git repository?" >&2
    exit 1
fi

install_hook() {
    local name="$1"
    local src="$REPO_ROOT/$HOOK_SOURCE_DIR/$name"
    local dst="$HOOK_TARGET_DIR/$name"

    if [ ! -f "$src" ]; then
        echo "warning: $src not found; skipping $name" >&2
        return
    fi

    chmod +x "$src"

    if [ -L "$dst" ]; then
        rm "$dst"
    elif [ -f "$dst" ]; then
        mv "$dst" "$dst.backup.$(date +%s)"
        echo "backed up existing $dst"
    fi

    if [ "$HOOK_TARGET_DIR" = ".git/hooks" ]; then
        ln -s "../../$HOOK_SOURCE_DIR/$name" "$dst"
    else
        ln -s "$src" "$dst"
    fi
    echo "installed: $dst -> $HOOK_SOURCE_DIR/$name"
}

install_hook pre-commit
install_hook pre-push

echo
echo "Hooks installed. Test with: git commit --allow-empty -m test"
echo "See tests/CONVENTIONS.md §6a for what each hook enforces."
