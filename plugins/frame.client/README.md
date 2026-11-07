# frame.client

Client-side communication plugin for Clean Language. Provides HTTP API calls, WebSocket live connections, Server-Sent Events feeds, and the declarative `load:`, `form:` and `send:` blocks.

## Namespaces

| Namespace | Protocol | Purpose |
|-----------|----------|---------|
| `api.*` | HTTP | Call APIs, submit forms, read responses |
| `live.*` | WebSocket | Bidirectional real-time connections |
| `feed.*` | SSE | Server-push event streams |

## Usage

An `api.*` request is awaited with `later`: the statements after it run when the response has arrived, and the response is read on the variable.

```clean
plugins:
	frame.ui
	frame.client

start:
	integer s = ui.onEvent("#load-btn", "click", "loadUsers")

functions:
	void loadUsers()
		later res = api.get("/api/users/1")
		if res.ok
			string name = res.json("name")
			integer s = ui.updateElement("#user-name", name)
		else
			integer s = ui.updateElement("#user-name", "Could not load the user")
```

Never pass a handler name to `api.get` / `post` / `put` / `patch` / `delete` / `submit`.

## API Functions (HTTP)

### Requests

| Function | Description |
|----------|-------------|
| `later res = api.get(url)` | GET request |
| `later res = api.post(url, body)` | POST with a JSON body |
| `later res = api.put(url, body)` | PUT with a JSON body |
| `later res = api.patch(url, body)` | PATCH with a JSON body |
| `later res = api.delete(url)` | DELETE request |
| `later res = api.submit(formSelector, url, method)` | Send a form's fields as JSON (repeated fields as arrays; a form with a chosen file goes as multipart form data) |
| `api.header(name, value)` | Set a header for the next request only |
| `api.timeout(ms)` | Set the timeout of the next request |
| `api.auth(scheme, credential)` | Set auth (`bearer` / `basic`) for all later requests |
| `api.clearAuth()` | Clear stored auth |

### Response (on the `later` variable)

| Property | Description |
|----------|-------------|
| `res.ok` | `true` if the status is 200-299 |
| `res.status` | HTTP status code (0 = network error) |
| `res.body` | Response body string |
| `res.json(path)` | Value at a dot-path in the JSON body |
| `res.header(name)` | Response header value |

## Declarative Blocks

```clean
load:
	users from "/api/users" at "data"
	stats from "/api/stats" on error: "statsFailed"

form: post "/api/tasks"
	title required
	note default="none"
	on success: clear emit "loadTasks"
	on error: show

send: deleteTask delete "/api/tasks/{taskId}"
	on success: emit "loadTasks"
	on error: emit "showError"
```

- `load:` declares `boolean loading = true`, `string loadError = ""` and one `any` variable per source, and fetches the sources in order when the page starts; `loading` becomes `false` after the last response.
- `form:` declares one string variable per field, `submitting`, `formError` and `formSuccess`, and a `void submit()` that checks the `required` fields, sends the fields as a JSON body and, once the response arrives, clears `submitting` before setting `formSuccess` / `formError`, clearing the fields (`clear`) and calling the `emit` callback.
- `send:` declares `<name>Pending`, `<name>Success` and `<name>Error` and a `void <name>()` that sends the request (the `with:` variables as a JSON body) and clears `<name>Pending` before its callbacks run.

`{name}` (send:) and `{query.name}` (load:) placeholders in a URL are percent-encoded; body values are JSON-encoded.

## Live Functions (WebSocket)

Handlers are exported function names.

| Function | Description |
|----------|-------------|
| `live.open(url, "onMsg", "onClose", "onError")` | Open connection, returns ID |
| `live.send(connId, message)` | Send message |
| `live.close(connId)` | Close connection |
| `live.state(connId)` | "connecting", "open", "closing", "closed" |
| `live.message()` | Message data (in handler) |
| `live.connId()` | Connection ID (in handler) |
| `live.closeCode()` | Close code (in handler) |
| `live.closeReason()` | Close reason (in handler) |
| `live.error()` | Error message (in handler) |

## Feed Functions (SSE)

| Function | Description |
|----------|-------------|
| `feed.open(url, "onMsg", "onError")` | Open feed, returns ID |
| `feed.on(connId, eventName, "handler")` | Listen for a named event |
| `feed.close(connId)` | Close feed |
| `feed.data()` | Event data (in handler) |
| `feed.eventType()` | Event type name (in handler) |
| `feed.lastId()` | Last event ID (in handler) |
| `feed.connId()` | Connection ID (in handler) |

## Form Helpers

Form reading helpers are in **frame.ui** (not frame.client), since reading DOM inputs is a UI operation:

| Function | Description |
|----------|-------------|
| `ui.inputValue(selector)` | Read input value |
| `ui.formJson(selector)` | Collect form as JSON string |
| `ui.formData(selector)` | Collect form as URL-encoded |
| `ui.checked(selector)` | Checkbox state (0/1) |
| `ui.setInput(selector, value)` | Set input value |

## Runtime Architecture

`src/main.cln` (built to `plugin.wasm`) expands the `load:`, `form:` and `send:` blocks. The browser side of the bridges is `runtime/bridge.js`: the build writes it next to the output as the `frame-client.js` artifact, clean-server serves it at `/frame-client.js`, and frame.ui adds it to the pages that load the browser runtime, right after the loader:

```html
<script src="/loader.js" data-wasm="/frontend.wasm"></script>
<script src="/frame-client.js"></script>
```

It registers its functions through `window.__cleanRuntime.registerEnv()`; `loader.js` instantiates the WASM once the document is parsed, so they are part of the imports.

Tests: `runtime/tests/client-runtime.test.mjs` (browser runtime) and `tests/test_expand.cln` (run by `scripts/test-plugins.sh`).

## Specification

Grammar: `foundation/spec/framework/grammar/frame-client.ebnf`. Prose: `foundation/docs/framework/plugins/client.md`.
