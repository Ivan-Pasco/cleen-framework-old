# Clean Framework Test Conventions

Authoritative rules for every test file under `tests/`. Read before adding or modifying a test.

The suite layout and how the runner drives a test are described in
[framework/README.md](./framework/README.md). These rules are enforced by
`scripts/check-test-placeholders.py`, the git hooks and the `test-policy`
and `test` CI workflows.

## 1. Tests are `.cln` only

No Rust tests, no JS tests, no shell-based assertions. The runner (`scripts/run-framework-tests.sh`) compiles `.cln` files and runs them inside `clean-server`. Any other test format is invisible to the harness.

## 2. Real bridge only — no mocks

Every test must call real bridge functions via the same `clean-server` runtime that ships to users. The old `bridge_mocks.cln` helper has been removed and the placeholder guard rejects any reference to it. Mocks let bridge drift go undetected; the whole point of this suite is to catch that drift.

If a test needs an isolated database, use SQLite `:memory:` (the framework default for tests). PostgreSQL integration tests run only in CI via the workflow.

## 3. Dot notation, not underscore bridges

Application-facing code — including tests — uses dot notation: `db.query(...)`, `http.respond(...)`, `auth.signToken(...)`. Never use the underscore form (`_db_query`, `_http_respond`) in test source. Underscores are the internal host bridge identifiers; tests live at the application layer.

When converting an older test, convert it to dot notation in the same pass.

## 4. Assertion style

Use the helpers in `tests/framework/utils/assertions.cln`:

- `assertEqual`, `assertEqualInt`, `assertTrue`, `assertFalse`
- `assertContains`, `assertNotContains`, `assertStartsWith`, `assertEndsWith`
- `assertEmpty`, `assertNotEmpty`, `assertGreaterThan`, `assertLessThan`
- `assertOccurrences`
- `logPass(name)`, `logFail(name, reason)`, `logSection(name)`

Each assertion returns `boolean` and prints exactly one line on failure beginning with `FAIL:`. The runner greps for `FAIL:` to detect a failed test, so do not print `FAIL:` for any other reason.

Every test file ends with a single `PASS: <suite-name>` or `FAIL: <suite-name>` line summarising the whole file. Track passes/fails locally with an integer counter; if the counter is non-zero on a failure path, the suite is failing.

## 5. Naming

- File name: `<feature>-test.cln` (kebab-case). Examples: `token-signverify-test.cln`, `sqlite-crud-test.cln`, `http-route-test.cln`.
- Place the file in the folder matching its scope:
  - `tests/framework/unit/plugins/<plugin>/` — unit test exercising one plugin
  - `tests/framework/unit/bridge/` — host bridge contract test
  - `tests/framework/integration/` — cross-plugin test
  - `tests/framework/e2e/` — full app boot + HTTP roundtrip
  - `tests/cln/bugfixes/` — regression test for a fixed bug (`// Fixed in:` header)
  - `plugins/<plugin>/tests/` — plugin-internal compile/smoke test (one per plugin, optional)

## 6. Suite output contract

A test passes when the runner sees a `PASS:` line and no `FAIL:` line in the suite's combined output. Any of the following causes a failure:

- One or more `FAIL:` lines
- A WASM trap, runtime error, or server crash
- No `PASS:` line within the suite timeout

A test that compiles but produces no output is **not** a pass — the runner used to flag it as "(executed)" success; this is no longer acceptable for new tests. Every suite must end with an explicit `PASS:` line.

## 6a. Automated enforcement

The `scripts/check-test-placeholders.py` guard blocks placeholder patterns
before they land. It runs on:

- `pre-commit` git hook — checks staged `.cln` test files.
- `pre-push` git hook — checks the full test tree.
- `test-policy.yml` CI job — on every push and PR.
- `test.yml` CI job — as the fail-fast gate before compiling anything.

Install the hooks with `./scripts/install-hooks.sh`. Do not skip them with
`--no-verify`; that flag is reserved for genuine hook-infrastructure bugs
and every use requires a commit-message note.

If a test genuinely cannot be written until an upstream fix ships, add the
file to [PENDING.md](./PENDING.md) with the upstream issue. `PENDING.md` is not a substitute for
writing the test; it is a licence to wait.

## 7. Bug discovery — report and stop

If a test reveals a bug in the compiler, server, or a plugin, do **not** patch around it in the test. File a GitHub issue (label `compiler-old`) in the repo that owns the fix, then stop work on that test until the upstream fix lands. The test stays in the repo, failing, with a comment naming the issue, and is listed in [PENDING.md](./PENDING.md).

This is the explicit policy for this remediation effort: tests document reality. We do not have skipped or xfail tests accumulating silently.

## 8. CI is the source of truth

`make test` or `./scripts/run-framework-tests.sh` must produce the same result locally and in CI. If local passes and CI fails, the test depends on local state (installed plugin version, env var, file path) — fix that, do not retry.

The runner exits non-zero on any failure. CI gates merges on this exit code.

## 9. What "real" looks like (anti-patterns)

Banned patterns — these are the placeholder style we are removing:

```clean
// WRONG — string-matching pretend test
string code = "Auth.createToken(userId, claims)"
if code.contains("createToken")
    printl("PASS: token creation works")
```

Required pattern — actually call the function and assert on its result:

```clean
// CORRECT — exercises the real bridge
string token = auth.signToken("user-123", "{\"role\":\"admin\"}")
boolean ok = assertNotEmpty(token, "auth.signToken returns a token")
any claims = auth.verifyToken(token)
ok = ok && assertEqual(claims.sub, "user-123", "verifyToken roundtrip")
if ok
    printl("PASS: auth-token-signverify")
else
    printl("FAIL: auth-token-signverify")
```

If you find yourself writing assertions about string literals that look like code, stop — you are writing a placeholder, not a test.
