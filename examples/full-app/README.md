# Full App Example

A complete full-stack task management application with multiple pages, components, and database integration.

## Project Structure

```
app/
├── ui/web/
│   ├── pages/
│   │   ├── index.html        → GET /
│   │   ├── dashboard.html    → GET /dashboard
│   │   ├── tasks.html        → GET /tasks
│   │   ├── projects.html     → GET /projects
│   │   ├── settings.html     → GET /settings
│   │   └── login.html        → GET /login
│   └── components/
│       ├── header.cln            → <app-header>
│       ├── sidebar.cln           → <app-sidebar>
│       ├── stats-card.cln        → <stats-card>
│       ├── task-card.cln         → <task-card>
│       ├── task-form.cln         → <task-form>
│       └── kanban-board.cln      → <kanban-board>
├── auth/
│   └── auth.cln              → session auth, roles
├── data/
│   └── models/
│       └── Schema.cln        → User, Project, Task data blocks
└── server/
    ├── config.cln            → server port
    └── api/
        ├── main.cln          → GET /api/main
        ├── dashboard.cln     → GET /api/dashboard
        ├── projects.cln      → /api/projects CRUD
        └── tasks.cln         → /api/tasks CRUD
assets/
├── index.html
└── styles.css
```

## Features

- Task management with Kanban board
- Project organization
- User settings
- Dashboard with statistics
- Authentication flow

## Running

```bash
# Scan
frame scan

# Build
frame build

# Run
frame serve
```
