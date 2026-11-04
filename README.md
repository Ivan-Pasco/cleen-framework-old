# Frame — Full-Stack Framework for Clean Language

Frame is the full-stack framework for Clean Language. Every part of it is a
Clean Language **plugin**: Clean source in `plugins/<name>/src/main.cln`,
compiled to `plugin.wasm`, described by `plugin.toml`. When an application
declares a plugin, the compiler loads it from `~/.cleen/plugins/`, lets it
expand its DSL blocks (`endpoints:`, `data`, `component:`, ...) into ordinary
Clean code, and compiles the result to WebAssembly. At run time the
application's bridge calls (`db.query`, `http.respond`, ...) are served by
`clean-server` (or, for browser targets, by the plugin's runtime JS).

This repository is the **old toolchain** (`cln` 0.33.x, `clean-server` 1.9.x),
kept in maintenance use. Its specs live in `../foundation/spec/framework/`.

## Plugins

| Plugin | Blocks | Purpose |
|--------|--------|---------|
| `frame.server` | `endpoints:`, `middleware:`, `routes:`, `server:` | HTTP routing, request/response, SSE, WebSockets, mail |
| `frame.data` | `data`, `migrate:` | Models, queries, transactions, migrations |
| `frame.auth` | `auth:`, `login:`, `roles:` | Sessions, JWT, password hashing, role guards, CSRF |
| `frame.ui` | `component:`, `page:`, `html:`, `ui:`, `styles:` | Components, server-rendered pages, browser runtime |
| `frame.client` | `load:`, `form:`, `send:` | Browser-side HTTP, forms, live data |
| `frame.canvas` | `canvasScene:` | Canvas scenes, drawing, audio, input (browser) |
| `frame.jobs` | `jobs:` | Background jobs, retries, cron schedules |
| `frame.locale` | `locale:` | Translations, plural forms, formatting |
| `frame.mcp` | `mcp:` | MCP server: tools, resources and prompts for AI agents |
| `frame.storage` | — | `storage.write/read/exists/delete` for binary files |

## Quick start

```bash
# Old-toolchain manager, compiler, server and plugins
~/.cleen/bin/cleen install latest
~/.cleen/bin/cleen server install
~/.cleen/bin/cleen frame install latest
```

A project's root `main.cln` is a package manifest; the compiler discovers the
files under `app/`:

```clean
package: TodoApp
    version: "1.0.0"

    target: server
        plugins: [frame.ui, frame.data, frame.server]
        entry: app/ui/web/pages/index.html
```

```clean
// app/data/models/Todo.cln
data Todo:
	fields:
		integer id primary generated
		string title required
		integer completed default: 0
```

```clean
// app/server/api/todos/index.cln
endpoints:
	GET "/api/todos":
		list<Todo> results = Todo.find:
			order: id desc

		return json(results)
```

```bash
cd examples/todo-app
~/.cleen/bin/cln compile main.cln -o app.wasm --plugins
DATABASE_URL=sqlite::memory: ~/.cleen/bin/clean-server app.wasm --port 3000
```

See [examples/](examples/) for complete applications.

## Repository layout

```
plugins/<name>/        plugin source, plugin.toml, build.sh, committed plugin.wasm
examples/              example applications (all compile with the current toolchain)
tests/framework/       framework test suites (runtime, unit, integration, e2e)
tests/cln/bugfixes/    regression tests for fixed framework bugs
scripts/               build, install and test scripts (see scripts/README.md)
```

## Building and testing

```bash
./scripts/build-all-plugins.sh      # rebuild every plugin.wasm with ~/.cleen/bin/cln
./scripts/install-plugins.sh        # install this checkout's plugins into ~/.cleen/plugins
./scripts/run-framework-tests.sh    # run every framework suite inside clean-server
./scripts/test-plugins.sh           # compile-check plugins/*/tests
./scripts/smoke-examples.sh         # compile, boot and request every example
./scripts/install-hooks.sh          # pre-commit / pre-push hooks
```

Test rules: [tests/CONVENTIONS.md](tests/CONVENTIONS.md).

## Specifications

- Plugin grammars: `../foundation/spec/framework/grammar/frame-*.ebnf`
- Plugin semantics: `../foundation/spec/framework/frame-*-semantics.md`
- Plugin contract: `../foundation/spec/framework/plugin-contract.md`
- Bridge functions: `../foundation/spec/platform/function-registry.toml`, `HOST_BRIDGE.md`

## License

MIT
