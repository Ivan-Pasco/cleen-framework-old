# Complete Demo

A full-stack example combining frame.ui pages, frame.server endpoints, a frame.data model and a frame.canvas browser scene.

## Project Structure

```
complete-demo/
├── main.cln                      # Package manifest (target: server)
├── app/
│   ├── canvas/particles.cln      # Canvas scene (separate browser module)
│   ├── data/models/User.cln      # User data model
│   ├── server/
│   │   ├── main.cln              # start: User.migrate()
│   │   └── api/
│   │       ├── main.cln          # GET /, GET /register, POST /register
│   │       └── users.cln         # /api/users endpoints
│   └── ui/web/pages/
│       ├── index.html            # Landing page with the canvas
│       ├── register.html         # Registration form (posts to /register)
│       ├── dashboard.html        # User table and stats
│       └── dashboard.cln         # Companion loader: GET /dashboard data
└── public/css/style.css
```

`main.cln` limits the server build to `shared: [app/ui, app/server, app/data]`, so `app/canvas/` is not part of the server build. frame.canvas is still in its plugin list: the build then emits the canvas runtime (`frame-canvas-bridge.js`, `frame-canvas.js`) next to the server module, and clean-server serves both.

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/complete-demo
~/.cleen/bin/cln compile main.cln -o complete-demo.wasm --plugins
DATABASE_URL=sqlite::memory: JWT_SECRET=dev-secret \
  ~/.cleen/bin/clean-server complete-demo.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh complete-demo` from the framework root.

`app/server/main.cln` creates the `users` table on start with `User.migrate()`.

The canvas scene is built on its own, because every frame.canvas bridge function runs in the browser:

```bash
~/.cleen/bin/cln compile app/canvas/particles.cln -o public/particles.wasm
```

The pages name that module on their canvas, `<canvas id="particles" ... data-scene="/public/particles.wasm">`; frame.ui adds the canvas runtime's two script tags to such a page, and the runtime starts the scene. The page itself has no script of its own.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | `render("index")` |
| GET | `/register` | `render("register")` |
| POST | `/register` | Form post: validates, hashes the password with `auth.hashPassword`, redirects (303) to `/dashboard` |
| GET | `/dashboard` | Page with data from `dashboard.cln` `load()` |
| GET | `/api/users` | Latest 50 users |
| POST | `/api/users` | Create a user (`email`, `username`, `password`) |
| GET | `/api/users/:id` | One user |
| DELETE | `/api/users/:id` | Delete a user |
| POST | `/api/users/login` | Check email and password with `auth.verifyPassword` |

User JSON returned by the API never includes `password_hash`.

## Key Code

### Data model

```clean
// app/data/models/User.cln
data User:
	fields:
		integer id primary generated
		string email required unique
		string username required
		string password_hash required
		string created_at
		boolean is_active default: true
```

### Endpoint writing through `Database.save`

```clean
// app/server/api/users.cln (excerpt)
User user = User()
user.email = email
user.username = username
user.password_hash = auth.hashPassword(password)
user.is_active = true
if not Database.save(user)
	return badRequest("Insert failed")
```

### Canvas scene

```clean
// app/canvas/particles.cln (excerpt)
canvasScene: id="particles" width=800 height=400 fps=60 background="#0d1117"

	layers:
		layer "particles" z=0

	state:
		number frameCount = 0.0

	onFrame: param="dt"
		frameCount = frameCount + dt * 60.0

		on layer "particles":
			canvas.circle x=400 y=200 radius=20 color="#ffffff30"
```

The scene draws into the page's `<canvas id="particles">` element (its `id=`), which names the module with `data-scene=`.
