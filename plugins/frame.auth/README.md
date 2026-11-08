# frame.auth Plugin

Authentication plugin for Clean Language. Provides DSL blocks for JWT and session-based authentication.

## Blocks

### auth

Configures authentication for the application.

**Attributes:**
- `strategy` (optional, default: "jwt") - Authentication strategy: "jwt" or "session"
- `secret` (required) - Must reference an environment variable via `env.get("VAR_NAME")`
- `expiry` (optional, default: 3600) - Token/session expiry in seconds
- `cookie` (optional, default: "session") - Cookie name for session strategy

**Example:**
```clean
import:
    frame.auth

auth: strategy="jwt" secret=env.get("JWT_SECRET")
```

### protected

Wraps routes that require authentication.

**Attributes:**
- `role` (optional) - Required user role
- `permission` (optional) - Required permission

**Example:**
```clean
protected:
    route: method="GET" path="/profile"
        return request.user

protected: role="admin"
    route: method="DELETE" path="/users/:id"
        // Only admins can delete users
```

### login

Declares the login flow (frame-auth.ebnf `login_block`). It needs the
`auth:` block and emits one function that a login endpoint calls as
`auth.login()`. One `login:` block per program.

The body runs in source order: statements (read the request, look the user
up) and these settings, each a one-line expression:

| Setting | Type | |
|---|---|---|
| `password` | string | the submitted password (required) |
| `hash` | string | the stored `auth.hashPassword` hash, `""` when there is no such user (required) |
| `userId` | integer | the user's id (required) |
| `claims` | string | the claims JSON object (default `"{}"`) |
| `issue` | `"session"` or `"jwt"` | what a successful login issues (default `"session"`) |

`auth.login()` verifies the password (an unknown user is checked against a
dummy hash, so it costs the same as a wrong password; an empty password
fails). A failure is logged
as `[WARN] frame.auth: login failed: INVALID_CREDENTIALS` and returns `""`.
On success:

- `issue = "session"`: the request's old session is deleted, a new session
  is created for `userId` with `claims` (with a new CSRF token) and its
  cookie is set; returns the session id.
- `issue = "jwt"`: returns an access token (`auth.jwt.sign`) whose claims
  are `claims` plus `"sub": "<userId>"`, and sets a refresh token
  (`auth.jwt.signRefresh` with the same claims) in the HttpOnly
  `frame.refresh` cookie for `auth.jwt.refresh`.

A statement may `return` early; `auth.login()` then returns that value.

**Example:**
```clean
login:
	any form = json.tryTextToData(body())
	string loginEmail = ""
	string submitted = ""
	if form != null
		if form.email != null
			loginEmail = form.email.toString()
		if form.password != null
			submitted = form.password.toString()
	list<User> found = User.find:
		where:
			email == loginEmail
	string stored = ""
	integer id = 0
	if found.length() > 0
		stored = found[0].passwordHash
		id = found[0].id
	password = submitted
	hash = stored
	userId = id
	claims = "{\"role\":\"user\"}"

endpoints:
	POST "/auth/login":
		if auth.login() == ""
			return unauthorized()
		return json({ok: true})
```

Rate-limit the login endpoint (AUTH-C002) with the server's rate limiting.

## Tokens

| Call | Returns |
|---|---|
| `auth.jwt.sign(claims)` | an access token (`typ` `"access"`), valid for `ttlMinutes` |
| `auth.jwt.signRefresh(claims)` | a refresh token (`typ` `"refresh"`), valid for `refreshTtlMinutes` |
| `auth.jwt.verify(token)` | the payload of a valid access token, `""` otherwise (a refresh token is refused) |
| `auth.jwt.refresh(refreshToken)` | a new access token for the refresh token's claims, `""` when it is invalid, expired, already used or not a refresh token; the rotated refresh token goes to the `frame.refresh` cookie |

A refresh token works once: `auth.jwt.refresh` consumes its `jti`. With
`jwt: enabled = false` every call returns `""`.

## Permission Checks

`auth.can(user, permission)` takes exactly two arguments: the user (the
session JSON returned by `auth.getCurrentUser()`) and a permission string
declared in the `roles:` block. It checks that user's role and returns
`false` for an empty user.

```clean
string user = auth.getCurrentUser()
if not auth.can(user, "users.delete")
    return unauthorized()
```

## Generated Code

The plugin expands DSL blocks into Clean code that uses Host Bridge functions:

- `_auth_create_token(payload, secret)` - Create JWT token
- `_auth_verify_token(token, secret)` - Verify and decode JWT
- `_auth_hash_password(password)` - Hash password with bcrypt
- `_auth_verify_password(password, hash)` - Verify password against hash
- `_crypto_random(length)` - Generate random bytes
- `_env_get(name)` - Get environment variable
- `_time_now()` - Get current timestamp

## Security Features

- HTTP-only cookies for session storage
- Secure and SameSite cookie attributes
- Automatic token expiry validation
- Role-based access control
- Permission-based access control
- Password hashing with bcrypt

## Building

```bash
./build.sh
# or
cln compile src/main.cln -o plugin.wasm
```

## Installation

```bash
cleen plugin install ./
```

## Plugin Contracts

Implements:

- [`lifecycle`](../../../foundation/spec/plugins/contracts/lifecycle.md) — `module_helpers_are_roots = true` so preamble-emitted auth helpers (`currentUser`, `hasRole`, role checks) survive the import-minimality BFS even when only reached through plugin-generated guard blocks. Applies to v1.0.0 `__preamble` output as well.
- [`bridge-host-classes`](../../../foundation/spec/plugins/contracts/bridge-host-classes.md) — every session, JWT, and crypto bridge declares `hosts = ["server"]`; client builds receive no-op stubs so the auth boundary is enforced at link time.
