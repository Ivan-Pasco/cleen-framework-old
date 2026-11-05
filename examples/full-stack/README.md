# Full-Stack Example

Users, posts and comments with session auth and roles, JSON endpoints, components and HTML pages.

## Project Structure

```
full-stack/
├── main.cln                        # Package manifest (target: server)
└── app/
    ├── auth/auth.cln               # auth: session and roles
    ├── data/models/
    │   ├── User.cln
    │   ├── Post.cln
    │   └── Comment.cln
    ├── server/
    │   ├── config.cln              # server: port 3000
    │   ├── main.cln                # start: migrate() for each model
    │   └── api/
    │       ├── login.cln, logout.cln, register.cln, me.cln
    │       ├── posts/index.cln, [id].cln
    │       ├── comments/index.cln, [id].cln
    │       ├── users/index.cln, [id].cln
    │       └── admin/stats.cln
    └── ui/web/
        ├── components/
        │   ├── Button.cln          # <ui-button>
        │   ├── Card.cln            # <ui-card>
        │   └── Navbar.cln          # <app-navbar>
        └── pages/
            ├── index.html          # /
            ├── login.html          # /login
            ├── dashboard.html      # /dashboard
            ├── posts.html          # /posts
            ├── users.html          # /users
            └── admin.html          # /admin
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/full-stack
~/.cleen/bin/cln compile main.cln -o full-stack.wasm --plugins
DATABASE_URL=sqlite::memory: JWT_SECRET=dev-secret \
  ~/.cleen/bin/clean-server full-stack.wasm --port 3000
```

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`). frame.ui routes every page file the compiler gives it, but compiler 0.33.169 passes only the manifest's entry page and pages with a companion `.cln`, so the other plain `.html` pages return 404 until the compiler passes page files to the plugin.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh full-stack` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## API Endpoints

| Method | Path | Guard |
|--------|------|-------|
| POST | `/api/register`, `/api/login`, `/api/logout` | public |
| GET / PUT | `/api/me` | `[user, admin]` |
| GET | `/api/posts`, `/api/posts/:id` | public |
| POST | `/api/posts` | `[user, admin]` |
| PUT / DELETE | `/api/posts/:id` | `[user, admin]` |
| GET | `/api/comments` | public |
| POST | `/api/comments` | `[user, admin]` |
| DELETE | `/api/comments/:id` | `[user, admin]` |
| GET / POST | `/api/users` | `[admin]` |
| GET / PUT / DELETE | `/api/users/:id` | `[admin]` |
| GET | `/api/admin/stats` | `[admin]` |

## Auth Configuration

```clean
// app/auth/auth.cln
auth:
	session:
		cookie = "fullstack.sid"
		timeoutMinutes = 120
		httpOnly = true
		sameSite = "Lax"

	roles:
		admin: ["*"]
		user: ["posts.write", "comments.write"]
```
