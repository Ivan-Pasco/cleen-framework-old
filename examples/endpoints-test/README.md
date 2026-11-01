# Endpoints Test Example

Tests the Clean Framework HTTP routing system.

## Project Structure

```
app/
└── server/
    ├── main.cln                  → server entry (port 3000)
    └── api/
        ├── hello.cln             → GET /api/hello
        └── users/
            ├── index.cln         → GET|POST /api/users
            └── [id].cln          → GET /api/users/:id
```

## API Endpoints

| Method | Route | Response |
|--------|-------|----------|
| GET | `/api/hello` | Hello World |
| GET | `/api/users` | user list |
| POST | `/api/users` | user created |
| GET | `/api/users/:id` | User details for :id |

## Running

```bash
# Scan
frame scan

# Build
frame build

# Run
frame serve

# Test
curl http://localhost:3000/api/hello
curl http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/users
curl http://localhost:3000/api/users/123
```
