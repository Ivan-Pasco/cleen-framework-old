# Clean Framework Test Suite

Every test is a `.cln` program that runs inside the real `clean-server`
runtime against the real host bridge — no mocks. Rules (naming, assertions,
verdict lines, placeholder guard) are in [../CONVENTIONS.md](../CONVENTIONS.md).

## Layout

```
tests/framework/
├── runtime/              # toolchain smoke test
├── unit/
│   ├── bridge/           # host bridge contract tests (crypto, db, env, http, log, time)
│   ├── ui/               # html: block rendering
│   └── plugins/<name>/   # one folder per plugin (auth, canvas, client, data, jobs,
│                         #   locale, mcp, server, storage, ui)
├── integration/          # cross-plugin tests; dev-capture/ holds two shell tests
├── e2e/                  # whole applications
├── utils/assertions.cln  # assertion helpers (tests/CONVENTIONS.md §4)
└── output/               # compiled test WASM (generated, git-ignored)
```

Regression tests for fixed bugs live in `tests/cln/bugfixes/` and run with
the same runner.

## Running

```bash
./scripts/run-framework-tests.sh                     # runtime, unit, integration, e2e, cln/bugfixes
./scripts/run-framework-tests.sh unit/plugins/data   # one suite
./scripts/run-framework-tests.sh -v e2e              # verbose
./scripts/run-framework-tests.sh -c unit             # compile only
bash tests/framework/integration/dev-capture/debug-capture-endpoint-test.sh
```

The runner uses `~/.cleen/bin/cln` and `~/.cleen/bin/clean-server`
(override with `CLEEN_CLN` / `CLEEN_SERVER`), binds each test server to
port 3334 (`CLEEN_TEST_PORT`), and exports `DATABASE_URL=sqlite::memory:`
and a random `JWT_SECRET` unless they are already set.

## How a test is run

1. The file is compiled with `cln compile <file> -o output/<name>.wasm --plugins`.
2. `clean-server output/<name>.wasm --port $CLEEN_TEST_PORT` is started.
3. If the source declares an endpoint at `"/test"` (`GET`, `POST`, ...,
   `FEED`), the runner requests it once the server is listening; a
   `LIVE "/test"` endpoint is opened with a WebSocket handshake. Lines
   `// test-request-header: Name: value` (repeatable) and
   `// test-request-query: key=value&...` add request headers and a query
   string to that request.
4. The verdict comes from the server output: any `FAIL:` line fails the
   test; otherwise a `PASS:` line passes it; no verdict line is a failure.

## Writing a test

A boot-time test prints its verdict from `start:`:

```clean
// Test: bridge/env — verifies portable env bridge.

start:
	string missing = env.get("__CLN_FRAMEWORK_NEVER_SET_TEST_VAR__")
	boolean ok_missing = missing.length() == 0

	if ok_missing
		printl("PASS: bridge-env")
	else
		printl("FAIL: bridge-env")
```

A test that needs request context declares its plugins and a `"/test"`
endpoint, and prints the verdict from the handler (see
`unit/plugins/locale/plural-forms-test.cln`). Copy the header and
`plugins:` form from an existing test in the same folder.
