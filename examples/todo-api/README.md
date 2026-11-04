# Todo API Example

A complete REST API example demonstrating Frame Framework plugins.

## Plugins Used

- **frame.data** - ORM with data models (User, Todo, Category)
- **frame.server** - HTTP endpoints with guards and response helpers
- **frame.auth** - Session-based authentication with role-based access control

## Project Structure

```
todo-api/
├── main.cln                    # Package manifest (target: server)
├── app/
│   ├── auth/
│   │   └── auth.cln            # Session + role configuration (auth: block)
│   ├── data/
│   │   └── models/             # User, Todo, Category, TodoCategory data blocks
│   └── server/
│       ├── main.cln            # Server entry (port, table migrations)
│       └── api/                # REST API endpoints
└── README.md
```

## API Endpoints

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/auth/register` | Register new user |
| POST | `/auth/login` | Login user |

### Protected Endpoints (requires authentication)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/logout` | Logout user |
| GET | `/auth/me` | Get current user |
| GET | `/todos` | List user's todos |
| GET | `/todos/:id` | Get single todo |
| POST | `/todos` | Create todo |
| DELETE | `/todos/:id` | Delete todo |
| PATCH | `/todos/:id/toggle` | Toggle todo completion |

### Admin Endpoints (requires admin role)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users` | List all users |
| DELETE | `/admin/users/:id` | Delete user |

## Data Models

### User
- `id` - Primary key (auto-increment)
- `email` - Unique email address
- `password_hash` - Hashed password
- `name` - Display name
- `role` - User role (default: "user")
- `created_at`, `updated_at` - Timestamps

### Todo
- `id` - Primary key (auto-increment)
- `title` - Todo title
- `description` - Todo description (field `details`, column `description`)
- `completed` - Completion status
- `priority` - Priority level (0-9)
- `owner_id` - Owning user (relation `owner`)
- `created_at`, `updated_at` - Timestamps
- `due_date` - Optional due date

### Category
- `id` - Primary key (auto-increment)
- `name` - Category name
- `color` - Hex color code
- `owner_id` - Owning user (relation `owner`)

### TodoCategory
- Junction table `todo_categories` linking todos to categories (`todo_id`, `category_id`)

## Example Requests

### Register User
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret123", "name": "John Doe"}'
```

### Login
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret123"}' \
  -c cookies.txt
```

### Create Todo
```bash
curl -X POST http://localhost:3000/todos \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"title": "Buy groceries", "description": "Milk, bread, eggs", "priority": 1}'
```

### List Todos
```bash
curl -X GET http://localhost:3000/todos \
  -b cookies.txt
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/todo-api
~/.cleen/bin/cln compile main.cln -o todo-api.wasm --plugins
DATABASE_URL=sqlite::memory: ~/.cleen/bin/clean-server todo-api.wasm --port 3000
```

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh todo-api` from the framework root.

`app/server/main.cln` creates all four tables on start with `migrate()`.

## Configuration

- `DATABASE_URL` - database connection string, e.g. `sqlite::memory:` or `sqlite:///tmp/todo.db`
- `--port` - port passed to `clean-server` (the example declares `server: port: 3000`)
- Session settings live in `app/auth/auth.cln` (`auth: session:`); JWT is disabled
