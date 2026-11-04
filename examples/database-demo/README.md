# Database Demo

CRUD JSON endpoints for two frame.data models, plus HTML pages.

## Project Structure

```
database-demo/
├── main.cln                       # Package manifest (target: server)
└── app/
    ├── data/models/
    │   ├── User.cln
    │   └── Post.cln
    ├── server/
    │   ├── config.cln             # server: port 3000
    │   ├── main.cln               # start: User.migrate(), Post.migrate()
    │   └── api/
    │       ├── users/index.cln    # GET, POST /api/users
    │       ├── users/[id].cln     # GET, PUT, DELETE /api/users/:id
    │       ├── posts/index.cln    # GET, POST /api/posts
    │       └── posts/[id].cln     # GET, PUT, DELETE /api/posts/:id
    └── ui/web/pages/
        ├── index.html             # /
        ├── users.html             # /users
        └── posts.html             # /posts
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/database-demo
~/.cleen/bin/cln compile main.cln -o database-demo.wasm --plugins
DATABASE_URL=sqlite::memory: ~/.cleen/bin/clean-server database-demo.wasm --port 3000
```

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh database-demo` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## Key Code

```clean
// app/data/models/User.cln
data User:
	fields:
		integer id primary generated
		string name required
		string email
		string role
		boolean active
```

```clean
// app/server/api/users/index.cln
endpoints:
	GET "/api/users":
		list<User> users = User.find:
			order: name asc
		return jsonResponse("\{\"ok\": true, \"users\": " + json.dataToText(users) + "\}")

	POST "/api/users":
		User user = User()
		user.name = body()
		user.active = true
		Database.save(user)
		return jsonResponse("\{\"ok\": true, \"message\": \"user created\", \"id\": " + user.id.toString() + "\}")
```
