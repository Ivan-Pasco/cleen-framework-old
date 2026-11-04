# Runtime Smoke Test

`smoke-test.cln` boots inside `clean-server` and checks that the toolchain
(compiler + server + host bridge) works at all. It is the fastest suite and
the one the pre-commit hook runs:

```bash
./scripts/run-framework-tests.sh runtime
```

Feature tests live next to it under `tests/framework/` (`unit/`,
`integration/`, `e2e/`); see [../README.md](../README.md) and
[tests/CONVENTIONS.md](../../CONVENTIONS.md).
