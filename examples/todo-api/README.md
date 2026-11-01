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
| PUT | `/todos/:id` | Update todo |
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
- `created_at` - Creation timestamp

### Todo
- `id` - Primary key (auto-increment)
- `title` - Todo title
- `description` - Todo description (field `details`, column `description`)
- `completed` - Completion status
- `priority` - Priority level (0-9)
- `owner_id` - Owning user (relation `owner`)
- `created_at` - Creation timestamp
- `due_date` - Optional due date

### Category
- `id` - Primary key (auto-increment)
- `name` - Category name
- `color` - Hex color code
- `owner_id` - Owning user (relation `owner`)

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

## Running

```bash
# Development server
frame serve

# Production build
frame build --target=server

# Run with Docker
docker build -t todo-api .
docker run -p 3000:3000 todo-api
```

## Configuration

Environment variables:
- `PORT` - Server port (default: 3000)
- `DATABASE_URL` - Database connection string
- `SESSION_SECRET` - Session encryption secret
