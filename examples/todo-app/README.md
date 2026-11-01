# Todo App Example

A REST API example demonstrating CRUD operations with Clean Framework.

## Project Structure

```
app/
├── data/
│   └── models/
│       └── Todo.cln          → Todo data model
├── ui/
│   └── web/
│       └── pages/
│           └── index.html    → GET /
└── server/
    └── api/
        ├── health.cln            → GET /api/health
        └── todos/
            ├── index.cln         → GET|POST /api/todos
            └── [id].cln          → GET|PUT|DELETE /api/todos/:id
```

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Home page |
| GET | `/api/health` | Health check |
| GET | `/api/todos` | List all todos |
| POST | `/api/todos` | Create a todo |
| GET | `/api/todos/:id` | Get a todo |
| PUT | `/api/todos/:id` | Update a todo |
| DELETE | `/api/todos/:id` | Delete a todo |

## Running

```bash
# Scan the project
frame scan

# Build
frame build

# Run
frame serve
```
