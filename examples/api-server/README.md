# API Server Example

A RESTful API server demonstrating the Frame plugin system with authentication, ORM, and routing.

## Features

- JWT authentication
- User registration and login
- CRUD operations for posts and comments
- Role-based access control (user/admin)
- Protected routes

## Plugins Used

- `frame.server` - HTTP server and routing
- `frame.data` - ORM and database operations
- `frame.auth` - JWT authentication and authorization

## Running

```bash
# Install plugins
cleen plugin install frame.server frame.data frame.auth

# Compile
cln compile main.cln -o api-server.wasm

# Run (requires host bridge runtime)
./host-bridge run api-server.wasm
```

## API Endpoints

### Public

- `GET /health` - Health check
- `POST /api/login` - User login
- `POST /api/register` - User registration
- `GET /api/posts` - List published posts
- `GET /api/posts/:slug` - Get post by slug

### Protected (require authentication)

- `GET /api/profile` - Get current user
- `PUT /api/profile` - Update profile
- `POST /api/posts` - Create post
- `PUT /api/posts/:id` - Update post (owner only)
- `DELETE /api/posts/:id` - Delete post (owner only)
- `POST /api/posts/:id/comments` - Add comment

### Admin (require admin role)

- `GET /api/admin/users` - List all users
- `DELETE /api/admin/users/:id` - Delete user
- `GET /api/admin/posts` - List all posts

## Environment Variables

- `JWT_SECRET` - Secret key for JWT signing
