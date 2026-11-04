# Todo App Example

A CRUD JSON API for todos with a frame.data model and one HTML page.

## Project Structure

```
todo-app/
├── main.cln                      # Package manifest (target: server)
└── app/
    ├── data/models/Todo.cln      # Todo data model
    ├── server/
    │   ├── main.cln              # start: Todo.migrate()
    │   └── api/
    │       ├── health.cln        # GET /api/health
    │       └── todos/
    │           ├── index.cln     # GET, POST /api/todos
    │           └── [id].cln      # GET, PUT, DELETE /api/todos/:id
    └── ui/web/pages/index.html   # /
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/todo-app
~/.cleen/bin/cln compile main.cln -o todo-app.wasm --plugins
DATABASE_URL=sqlite::memory: ~/.cleen/bin/clean-server todo-app.wasm --port 3000

curl http://localhost:3000/api/health
```

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh todo-app` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## Data Model

```clean
// app/data/models/Todo.cln
data Todo:
	fields:
		integer id primary generated
		string title required
		string details default: "" as "description"
		integer completed default: 0
		string created_at
```

`description` is a reserved word, so the field is named `details` and mapped onto the `description` column.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/todos` | List all todos |
| POST | `/api/todos` | Create a todo |
| GET | `/api/todos/:id` | Get a todo |
| PUT | `/api/todos/:id` | Update a todo |
| DELETE | `/api/todos/:id` | Delete a todo |
