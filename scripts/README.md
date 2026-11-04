# Frame Framework Scripts

The framework has no Rust crates: every plugin is Clean Language source compiled
to `plugin.wasm` by the old-toolchain compiler. All scripts default to the
old toolchain in `~/.cleen/bin` (`cln`, `clean-server`). Plain `cln` on `PATH`
is a different toolchain and is never used. Override with `CLEEN_CLN` /
`CLEEN_SERVER`.

| Script | Purpose |
|--------|---------|
| `build-all-plugins.sh` | Build every plugin (`plugins/*/build.sh`) with `~/.cleen/bin/cln`. |
| `install-plugins.sh [name ...]` | Install plugins from this checkout into `~/.cleen/plugins/<name>/<version>/`, pin `.active-version`, and mirror the files at `~/.cleen/plugins/<name>/` (where clean-server reads runtime JS). `CLEEN_PLUGINS_DIR` overrides the install root. CI uses it to test the commit under test. |
| `run-framework-tests.sh [filter]` | Compile each `.cln` test under `tests/framework/<filter>` and run it inside clean-server. Verdicts follow `tests/CONVENTIONS.md` §6. `CLEEN_TEST_PORT` sets the port (default 3334). |
| `smoke-examples.sh [name ...]` | Compile every example, boot it in clean-server on a free port (in-memory SQLite) and request its pages, GET endpoints, stylesheets and login flows. |
| `test-plugins.sh` | Type-check each `plugins/*/tests/*.cln` combined with its plugin source (`cln check`). |
| `check-test-placeholders.py` | Placeholder guard for test files (pre-commit, pre-push, CI). |
| `install-hooks.sh` | Link `scripts/hooks/pre-commit` and `pre-push` into `.git/hooks`. |
| `strip-unused-wasm-imports.py` | Used by plugin `build.sh` files to drop host imports the plugin loader does not provide. |
| `refresh-manifest-hash.py` | Used by plugin `build.sh` files to refresh `build-manifest.json` after stripping. |

## Common workflows

```bash
# Rebuild and install everything locally
./scripts/build-all-plugins.sh
./scripts/install-plugins.sh

# Run the whole framework suite (runtime, unit, integration, e2e)
./scripts/run-framework-tests.sh

# Run one suite
./scripts/run-framework-tests.sh unit/plugins/data
```
