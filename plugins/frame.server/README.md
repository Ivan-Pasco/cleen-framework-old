# frame.server Plugin

HTTP server plugin for Clean Language. Provides DSL blocks for building HTTP servers with routing, request handling, and authentication.

**Requires:** clean-server runtime

## Blocks

### endpoints

Defines HTTP endpoint handlers using a declarative syntax.

**Example:**
```clean
import:
    frame.server

endpoints:
    GET "/" -> homePage()
    GET "/api/users" -> listUsers()
    GET "/api/users/:id" -> getUser()
    POST "/api/users" -> createUser()
```

### server

Creates an HTTP server configuration.

**Attributes:**
- `port` (optional, default: 8080) - Port to listen on

**Example:**
```clean
import:
    frame.server

server: port=3000
    route: method="GET" path="/"
        return {"message": "Hello World"}
```

### route

Defines an HTTP route handler.

**Attributes:**
- `method` (required) - HTTP method (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD)
- `path` (required) - URL path pattern (must start with /)

**Example:**
```clean
route: method="GET" path="/users/:id"
    id = _req_param("id")
    return getUserById(id)
```

#### Route sub-blocks

Instead of (or as well as) the inline `[roles] cache() middleware()`
modifiers, a route can hold sub-blocks; its statements then go in `handle:`
(frame-server.ebnf §3.4, frame-server-semantics.md SRV-B014 / SRV-B015):

```clean
endpoints:
    GET "/api/reports":
        guard:
            role in ["admin", "analyst"]
            auth.can(auth.getCurrentUser(), "report.read")
        cache: "5m"
        middleware: [RateLimit]
        returns: Report
        handle:
            return json(buildReport())
```

- `guard:` — one clause per line (or one on the `guard:` line), all must
  hold: `role in ["a", "b"]`, `role == "a"`, `authenticated`, or any boolean
  expression. A failing clause answers 401 and the handler does not run.
- `cache:` — the same values as `cache()`. Declaring both is an error.
- `middleware: [A, B]` — runs after the inline `middleware()` list.
- `returns:` — the response type, for documentation only.

With both forms on one route, the request passes through: `server:
middleware:`, the inline `[roles]`, the `guard:` clauses, the cache, the
inline `middleware()` list, the `middleware:` list, then the handler.

### middleware

A middleware is either a zero-argument function returning `string` (`""` to
continue, a response to end the request), or a declaration:

```clean
middleware RateLimit
    functions:
        Request handle(Request req)
            if tooMany(req.ip)
                req.response = httpError(429, "Too many requests")
            return req
```

`handle` receives the request being handled as a `Request` (`method`,
`path`, `ip`, `headers`, `body`, `params`, `query`, `auth`) and returns it;
setting `req.response` ends the request with that response. Use either kind
by name in `middleware()`, `middleware:` or `server: middleware: [...]` (every
route). See frame-server-semantics.md SRV-B007..SRV-B009.

## Bridge Functions

Server-specific functions provided by clean-server:

### HTTP Server
- `_http_listen(port)` - Start the HTTP server
- `_http_route(method, path, handler_idx)` - Register a route handler
- `_http_route_protected(method, path, handler_idx, role)` - Register protected route

### Request Context
- `_req_param(name)` - Get path parameter
- `_req_query(name)` - Get query parameter
- `_req_header(name)` - Get request header
- `_req_body()` - Get request body
- `_req_method()` - Get HTTP method
- `_req_path()` - Get request path

### Authentication
- `_auth_get_session()` - Get current session as JSON
- `_auth_require_auth()` - Check if authenticated
- `_auth_require_role(role)` - Check if user has role
- `_auth_can(permission)` - Check permission
- `_auth_has_any_role(roles)` - Check if user has any role

## Building

```bash
./build.sh
```

## Installation

```bash
cp -r . ~/.cleen/plugins/frame.server/1.0.0/
```

## Plugin Contracts

Implements:

- [`lifecycle`](../../../foundation/spec/plugins/contracts/lifecycle.md) — `module_helpers_are_roots = true` so preamble-emitted response helpers (`json`, `redirect`, error builders) survive import-minimality BFS even when only reached through plugin-generated route handler code (closes GEN003).
- [`bridge-host-classes`](../../../foundation/spec/plugins/contracts/bridge-host-classes.md) — every bridge function is tagged `hosts = ["server"]` or `hosts = ["all"]`. Server-only bridges (request context, routing, sessions, SMTP, WebSocket/SSE) are stubbed out of client builds; pure-compute bridges (JSON, URL encoding) are shared.
