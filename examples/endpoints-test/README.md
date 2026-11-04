# Endpoints Test Example

Exercises frame.server routing with static and parameterised routes.

## Project Structure

```
endpoints-test/
├── main.cln                      # Package manifest (target: server, entry app/server/main.cln)
└── app/server/
    ├── main.cln                  # server: port 3000
    └── api/
        ├── hello.cln             # GET /api/hello
        └── users/
            ├── index.cln         # GET, POST /api/users
            └── [id].cln          # GET /api/users/:id
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/endpoints-test
~/.cleen/bin/cln compile main.cln -o endpoints-test.wasm --plugins
~/.cleen/bin/clean-server endpoints-test.wasm --port 3000
```

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh endpoints-test` from the framework root.

## Test

```bash
curl http://localhost:3000/api/hello
curl http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/users
curl http://localhost:3000/api/users/123
```
