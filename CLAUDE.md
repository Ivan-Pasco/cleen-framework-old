# CLAUDE.md — clean-framework

This file guides work on the Clean Language Frame framework. Frame provides the plugin ecosystem (frame.server, frame.data, frame.ui, etc.) that turns Clean Language into a full-stack platform.

**Read [KNOWLEDGE.md](./KNOWLEDGE.md) before modifying plugin code** — it documents known fragile areas and plugin.toml contract rules.

## What lives here

- `plugins/frame.*/` — the 10 Clean Language plugins (see catalog below)
- `examples/` — example Frame apps
- `tests/` — test suites (see `tests/CONVENTIONS.md`)
- `scripts/` — build tooling

## The 10 plugins

| Plugin | What it adds | Prose spec | Formal spec |
|---|---|---|---|
| `frame.server` | HTTP endpoints, routing, middleware | `foundation/docs/framework/plugins/server.md` | `foundation/spec/framework/frame-server-semantics.md` + `foundation/spec/framework/grammar/frame-server.ebnf` |
| `frame.data` | ORM models, queries, migrations | `foundation/docs/framework/plugins/data.md` | `foundation/spec/framework/frame-data-semantics.md` + `foundation/spec/framework/grammar/frame-data.ebnf` |
| `frame.ui` | Components, HTML directives, styles | `foundation/docs/framework/plugins/ui.md` | `foundation/spec/framework/frame-ui-semantics.md` + `foundation/spec/framework/grammar/frame-ui.ebnf` |
| `frame.auth` | Sessions, JWT, roles, CSRF | `foundation/docs/framework/plugins/auth.md` | `foundation/spec/framework/frame-auth-semantics.md` + `foundation/spec/framework/grammar/frame-auth.ebnf` |
| `frame.canvas` | Canvas scenes, drawing, audio, input | `foundation/docs/framework/plugins/canvas.md` | `foundation/spec/framework/frame-canvas-semantics.md` + `foundation/spec/framework/grammar/frame-canvas.ebnf` |
| `frame.mcp` | MCP server tools, resources, prompts | `foundation/docs/framework/plugins/mcp.md` | `foundation/spec/framework/frame-mcp-semantics.md` + `foundation/spec/framework/grammar/frame-mcp.ebnf` |
| `frame.client` | Client-side `load:` / `form:` / `send:` | `foundation/docs/framework/plugins/client.md` | `foundation/spec/framework/grammar/frame-client.ebnf` |
| `frame.jobs` | Background jobs, scheduled tasks | `foundation/docs/framework/plugins/jobs.md` | `foundation/spec/framework/grammar/frame-jobs.ebnf` |
| `frame.locale` | Internationalization, translations | `foundation/docs/framework/plugins/locale.md` | `foundation/spec/framework/grammar/frame-locale.ebnf` |
| `frame.storage` | Server-side filesystem bridge for binary artifacts | `foundation/docs/framework/plugins/storage.md` | `foundation/spec/framework/frame-storage-semantics.md` + `foundation/spec/framework/grammar/frame-storage.ebnf` |

Framework-level docs (overview, getting started, project structure, CLI, platforms, dev guidelines, database plugins, plugin authoring) live under `foundation/docs/framework/`.

## Authority

For anything about the language or the platform, defer to the authoritative sources — do NOT restate them here:

- **Language spec:** `foundation/docs/specification/` (prose). Formal companion: `foundation/spec/` (grammar.ebnf, semantic-rules.md, type-system.md, stdlib-reference.md).
- **Plugin contract (ABI):** `foundation/spec/framework/plugin-contract.md`. Covers `plugin.toml` schema, the `expand` function signature, and the `[bridge]`, `[handles]`, and `[language]` sections.
- **Platform contracts:** `foundation/spec/platform/` — `HOST_BRIDGE.md`, `EXECUTION_LAYERS.md`, `MEMORY_MODEL.md`, `SERVER_EXTENSIONS.md`, `IDE_EXTENSION_ARCHITECTURE.md`, `ERROR_REPORTING_SPECIFICATION.md`, `function-registry.toml`.
- **Governance and cross-component work policy:** `foundation/docs/governance/` — `ARCHITECTURE_BOUNDARIES.md`, `ERROR_REPORTING_WORKFLOW.md`, `PROJECT_MANAGEMENT_PRINCIPLES.md`, `USER_TYPES_AND_ERROR_REPORTING.md`.

**Every plugin must comply with `foundation/spec/framework/plugin-contract.md`.** Every framework doc you write must match the specification, not restate it.

## Plugin ABI (short summary; contract is authoritative)

Plugins are WASM modules that export a function named `expand`. It receives a JSON string describing a framework block (`{"name": "...", "content": "...", "attributes": {...}}`) and returns a JSON string containing the emitted Clean Language statements (or an error record). Expansion is recursive: emitted code may contain further framework blocks; the compiler keeps expanding until none remain.

**Do NOT describe the Host Bridge as a JSON envelope layer.** That was a v1 design that was never implemented. The actual Host Bridge is raw WASM imports using `(ptr, len)` string pairs and length-prefixed returns. See `foundation/spec/platform/HOST_BRIDGE.md` and `foundation/spec/platform/function-registry.toml`.

## Development rules

### No placeholder implementations
No functions that return dummy values (`return 0`, `return false`, `todo!()`). All plugin code must be fully functional.

### JavaScript is never acceptable in Clean projects
Never write `<script>` tags, `.js` files, or inline DOM API calls in examples or plugin templates. If a UI interaction isn't expressible via `_ui_*` bridge functions in `frame.ui`, file a GitHub issue (label `compiler-old`) in `Ivan-Pasco/cleen-framework-old` for frame.ui and stop. JavaScript simulations lie about framework capabilities and diverge from real behavior. Static HTML/CSS only; dynamic behavior comes from compiled Clean.

### Folder ownership
Plugins claim folders via `plugin.toml [owned_folders]`. Files inside owned folders get the plugin's DSL applied automatically (`implicit_import = true`). See `foundation/docs/framework/PROJECT_STRUCTURE.md` for the ownership table.

### Testing
- Real bridge only — every test runs inside `clean-server`; no mocks.
- Every plugin edit updates the matching unit test folder at `tests/framework/unit/plugins/<name>/`.
- Every bug-fix PR includes a failing-first test.
- Do NOT add `--no-verify` to `git commit` or `git push`. The hooks are the point.
- Full rules: `tests/CONVENTIONS.md`.

## Cross-component work

You are a Team Developer AI. When you discover something in another component, use the correct channel:

| What you found | Channel |
|---|---|
| A bug (crash, wrong output, spec violation, regression) | GitHub issue labeled `compiler-old` in the repo that owns the fix (`Ivan-Pasco/clean-language-compiler-old`, `clean-server-old`, `cleen-framework-old`, `clean-language-manager-old`); close it with `fixes #N` in the commit message. The errors dashboard and `report_error` are offline. |
| A design proposal, schema request, architectural ask, or handoff | GitHub issue in the owning repo (the errors.cleanlanguage.dev prompts board is offline) |

Do NOT edit code in other components directly. Do NOT write bug reports as markdown files — file an issue so the fix can close it.

Full policy: `foundation/docs/governance/USER_TYPES_AND_ERROR_REPORTING.md`.

## Documentation sync

When you change a plugin's contract or behavior, update BOTH in the same commit:
- Formal spec: `foundation/spec/framework/frame-<plugin>-semantics.md` (and the grammar under `foundation/spec/framework/grammar/frame-<plugin>.ebnf` if syntax changed).
- Prose companion: `foundation/docs/framework/plugins/<plugin>.md`.

When you change bridge signatures, update:
- `foundation/spec/platform/function-registry.toml` (machine-readable registry).
- `foundation/spec/platform/HOST_BRIDGE.md` (Layer 2) or `foundation/spec/platform/SERVER_EXTENSIONS.md` (Layer 3).

## Common commands

The old toolchain lives in `~/.cleen/bin` (`cln`, `clean-server`); plain `cln` on PATH is a different toolchain. The scripts default to `~/.cleen/bin` (override with `CLEEN_CLN` / `CLEEN_SERVER`).

```bash
# Build one plugin / all plugins
(cd plugins/frame.data && CLN_COMPILER=~/.cleen/bin/cln bash build.sh)
./scripts/build-all-plugins.sh

# Install this checkout's plugins into ~/.cleen/plugins
./scripts/install-plugins.sh

# Run all framework tests, or one suite
./scripts/run-framework-tests.sh
./scripts/run-framework-tests.sh unit/plugins/data

# Compile-check plugins/*/tests
./scripts/test-plugins.sh
```

## Getting help

1. Check the relevant plugin spec at `foundation/docs/framework/plugins/<name>.md`.
2. Check the plugin contract at `foundation/spec/framework/plugin-contract.md`.
3. Search open bugs: `gh issue list -R Ivan-Pasco/cleen-framework-old --label compiler-old`.
