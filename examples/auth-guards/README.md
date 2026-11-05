# Auth Guards Example

Shows frame.server role guards: each endpoint lists the roles allowed to call it after its path.

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
│   └── ui/web/pages/index.html        # /
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
```

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
