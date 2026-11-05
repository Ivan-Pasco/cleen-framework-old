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

Generates login and registration handlers.

**Attributes:**
- `model` (required) - User model name
- `email` (optional, default: "email") - Email field name
- `password` (optional, default: "password_hash") - Password hash field name

**Example:**
```clean
login: model="User"
```

This generates:
- `_login(email, password)` - Returns `{ok: true, token, user}` or `{ok: false, error}`
- `_register(email, password)` - Creates user and returns token

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
