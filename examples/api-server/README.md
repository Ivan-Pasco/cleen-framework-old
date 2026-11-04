# API Server Example

A JSON API with JWT authentication, frame.data models and role-guarded endpoints.

## Plugins Used

- `frame.server` - endpoints and routing
- `frame.data` - `User`, `Post` and `Comment` models
- `frame.auth` - JWT configuration and role guards

## Project Structure

```
api-server/
├── main.cln                        # Package manifest (target: server)
├── app/
│   ├── data/models/
│   │   ├── User.cln
│   │   ├── Post.cln
│   │   └── Comment.cln
│   ├── server/
│   │   ├── main.cln                # Server entry: port, auth: jwt, table migrations
│   │   └── api/
│   │       ├── health.cln
│   │       ├── login.cln
│   │       ├── register.cln
│   │       ├── profile.cln
│   │       ├── posts/index.cln
│   │       ├── posts/[id].cln
│   │       ├── comments/index.cln
│   │       └── admin/
│   │           ├── posts/index.cln
│   │           └── users/index.cln, users/[id].cln
│   └── ui/web/pages/index.html
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/api-server
~/.cleen/bin/cln compile main.cln -o api-server.wasm --plugins
JWT_SECRET=dev-secret DATABASE_URL=sqlite::memory: \
  ~/.cleen/bin/clean-server api-server.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh api-server` from the framework root.

`app/server/main.cln` creates the tables on start with `migrate()`.

## API Endpoints

| Method | Path | Guard |
|--------|------|-------|
| GET | `/api/health` | public |
| POST | `/api/login` | public |
| POST | `/api/register` | public |
| GET | `/api/posts` | public (published posts) |
| GET | `/api/posts/:id` | public |
| GET | `/api/comments` | public |
| GET / PUT | `/api/profile` | `[user, admin]` |
| POST | `/api/posts` | `[user, admin]` |
| PUT / DELETE | `/api/posts/:id` | `[user, admin]` |
| POST | `/api/comments` | `[user, admin]` |
| GET | `/api/admin/users` | `[admin]` |
| DELETE | `/api/admin/users/:id` | `[admin]` |
| GET | `/api/admin/posts` | `[admin]` |

## Auth Configuration

From `app/server/main.cln`:

```clean
auth:
	jwt:
		enabled = true
		secret = env.get("JWT_SECRET")
		alg = "HS256"
		ttlMinutes = 60
```

## Environment Variables

- `JWT_SECRET` - secret key for JWT signing (required by frame.auth)
- `DATABASE_URL` - database connection string, e.g. `sqlite::memory:`
