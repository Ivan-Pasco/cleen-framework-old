# Auth Guards Example

Shows role guards at every level: each endpoint lists the roles allowed to call it after its path, a `routes:` guard protects a whole URL area, and a page's `<page auth / roles>` declaration protects that page.

## Project Structure

```
auth-guards/
├── main.cln                           # Package manifest (target: server)
├── app/
│   ├── server/api/
│   │   ├── public.cln                 # GET /api/public
│   │   ├── protected.cln              # GET /api/protected [user]
│   │   ├── editor/posts.cln           # GET /api/editor/posts [editor]
│   │   ├── posts/publish.cln          # POST /api/posts/publish [editor, admin]
│   │   └── admin/
│   │       ├── dashboard.cln          # GET /api/admin/dashboard [admin]
│   │       └── users/[id].cln         # GET /api/admin/users/:id [admin]
│   ├── auth/auth.cln                  # JWT bearer tokens + role permissions
│   └── ui/web/
│       ├── routes.cln                 # guard: "/admin/*" [admin]
│       └── pages/
│           ├── index.html             # /
│           ├── account.html           # /account    <page auth="required">
│           ├── editorial.html         # /editorial  <page roles="editor,admin">
│           ├── login.html             # /login      <page auth="guest">
│           ├── forbidden.html         # /forbidden
│           └── admin/panel.html       # /admin/panel (routes: guard)
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/auth-guards
~/.cleen/bin/cln compile main.cln -o auth-guards.wasm --plugins
JWT_SECRET=dev-secret ~/.cleen/bin/clean-server auth-guards.wasm --port 3000

curl http://localhost:3000/api/public       # 200
curl http://localhost:3000/api/protected    # 401 without a signed-in user
curl -i http://localhost:3000/account       # 302 to /login without a signed-in user
curl -i http://localhost:3000/editorial     # 302 to /forbidden unless the user is an editor or admin
curl http://localhost:3000/admin/panel      # 401 unless the user is an admin
```

Requests are signed in with `Authorization: Bearer <jwt>`: an HS256 token signed with `JWT_SECRET` whose claims carry `sub` (the user id) and `role`.

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`).

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh auth-guards` from the framework root.

## Guard Syntax

```clean
// app/server/api/public.cln
endpoints:
	GET "/api/public":
		return jsonResponse("{\"message\": \"This is public\"}")

// app/server/api/protected.cln
endpoints:
	GET "/api/protected" [user]:
		return jsonResponse("{\"message\": \"This is protected\"}")
```

## Page Guards

```clean
// app/ui/web/routes.cln — every page under /admin/ needs the admin role (401 otherwise)
routes:
	guard: "/admin/*" [admin]
```

```html
<!-- app/ui/web/pages/account.html — no signed-in user: redirect to /login -->
<page auth="required" />

<!-- app/ui/web/pages/editorial.html — none of the roles: redirect to /forbidden -->
<page roles="editor,admin" />

<!-- app/ui/web/pages/login.html — a signed-in user is redirected to / -->
<page auth="guest" />
```

The checks run before the page (and its companion `guard()` / `load()`) is rendered.
