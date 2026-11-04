# Full App Example

A task-management app with several pages, components, data models, session auth and role-guarded APIs.

## Project Structure

```
full-app/
├── main.cln                      # Package manifest (target: server)
├── app/
│   ├── auth/auth.cln             # auth: session and roles
│   ├── data/models/Schema.cln    # User, Project, Task data models
│   ├── server/
│   │   ├── config.cln            # server: port 3000
│   │   ├── main.cln              # start: migrate() for each model
│   │   └── api/
│   │       ├── main.cln          # GET /api/main
│   │       ├── dashboard.cln     # GET /api/dashboard
│   │       ├── projects.cln      # /api/projects CRUD
│   │       └── tasks.cln         # /api/tasks CRUD
│   └── ui/web/
│       ├── pages/
│       │   ├── index.html        # /
│       │   ├── dashboard.html    # /dashboard
│       │   ├── tasks.html        # /tasks
│       │   ├── projects.html     # /projects
│       │   ├── settings.html     # /settings
│       │   └── login.html        # /login
│       └── components/
│           ├── header.cln        # <app-header>
│           ├── sidebar.cln       # <app-sidebar>
│           ├── stats-card.cln    # <stats-card>
│           ├── task-card.cln     # <task-card>
│           ├── task-form.cln     # <task-form>
│           └── kanban-board.cln  # <kanban-board>
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/full-app
~/.cleen/bin/cln compile main.cln -o full-app.wasm --plugins
DATABASE_URL=sqlite::memory: JWT_SECRET=dev-secret \
  ~/.cleen/bin/clean-server full-app.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh full-app` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## API Endpoints

| Method | Path | Guard |
|--------|------|-------|
| GET | `/api/main` | public |
| GET | `/api/dashboard` | `[user, admin]` |
| GET / POST | `/api/projects` | `[user, admin]` |
| GET / PUT / DELETE | `/api/projects/:id` | `[user, admin]` |
| GET / POST | `/api/tasks` | `[user, admin]` |
| GET / PUT / DELETE | `/api/tasks/:id` | `[user, admin]` |
