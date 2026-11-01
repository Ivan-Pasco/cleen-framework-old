# Frame Blog - Full-Stack Example Application

A complete blog application built with the Frame Framework, demonstrating all core features including SSR, Islands Architecture, authentication, database ORM, validation, and theming.

## Features Demonstrated

### 🚀 Framework Features

- **Server-Side Rendering (SSR)** - Fast initial page loads
- **Islands Architecture** - Selective client hydration for interactivity
- **Authentication** - Session-based auth with login/logout
- **Database ORM** - Type-safe database queries and relationships
- **Form Validation** - Client and server-side validation
- **Theming** - Multiple themes with dark mode support
- **API Generation** - OpenAPI spec and TypeScript SDK
- **Migrations** - Database schema management

### 📝 Application Features

- User registration and authentication
- Create, read, update, delete blog posts
- Comment system with nested replies
- User profiles
- Tag-based post filtering
- Search functionality
- Responsive design
- Dark mode toggle

## Project Structure

```
blog-app/
├── src/
│   ├── main.cln           # Application entry point
│   ├── models/
│   │   ├── User.cln       # User data model
│   │   ├── Post.cln       # Blog post model
│   │   └── Comment.cln    # Comment model
│   ├── components/
│   │   ├── Header.cln     # Site header with nav
│   │   ├── PostCard.cln   # Post preview card
│   │   ├── PostList.cln   # List of posts (island)
│   │   ├── CommentForm.cln # Comment submission form (island)
│   │   └── ThemeToggle.cln # Theme switcher (island)
│   └── pages/
│       ├── HomePage.cln   # Landing page
│       ├── PostPage.cln   # Single post view
│       ├── LoginPage.cln  # Login form
│       └── ProfilePage.cln # User profile
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_posts.sql
│   └── 003_create_comments.sql
└── README.md (this file)
```

## Getting Started

### Prerequisites

- Frame CLI installed
- SQLite or PostgreSQL database

### Installation

1. **Create the database:**
   ```bash
   frame db:create
   ```

2. **Run migrations:**
   ```bash
   frame db:migrate
   ```

3. **Start development server:**
   ```bash
   frame serve
   ```

4. **Visit the application:**
   Open http://localhost:3000 in your browser

### Generate API Documentation

Generate OpenAPI spec and TypeScript SDK:

```bash
# Generate OpenAPI 3.1 specification
frame api:openapi openapi.json

# Generate TypeScript SDK for frontend
frame api:sdk typescript src/api-client.ts
```

## Key Code Examples

### 1. Data Models with Relationships

```clean
// app/data/models/Post.cln
data Post:
	fields:
		integer id primary generated
		integer author_id required
		string title required
		string content required
		string slug required unique
		boolean published default: false
		integer views default: 0
		string created_at
		string updated_at

	indexes:
		author_id
		(published, created_at)

	relations:
		author: belongs_to User on author_id
```

### 2. API Endpoints

Reads use the query DSL; writes construct or load an entity and go through
`Database.save` / `Database.delete`.

```clean
// app/server/api/posts/[id].cln
endpoints:
	GET "/api/posts/:id":
		integer postId = param("id").toInteger()
		Post post = Post.first:
			where:
				id == postId
		onError:
			return notFound()
		return json({ok: true, post: post})

	DELETE "/api/posts/:id" [user, admin, editor]:
		integer postId = param("id").toInteger()
		Post post = Post.first:
			where:
				id == postId
		onError:
			return notFound()
		Database.delete(post)
		return jsonResponse("{\"ok\": true}")
```

### 3. Components

```clean
// app/ui/web/components/PostCard.cln
component: tag="post-card"
	inputs:
		title: string = ""
		excerpt: string = ""
		author: string = ""
		date: string = ""

	html:
		<article class="post-card">
			<h2>{title}</h2>
			<p>{excerpt}</p>
			<span>By {author} on {date}</span>
		</article>
```

### 4. Authentication and Roles

```clean
// app/auth/auth.cln
auth:
	session:
		cookie = "blog.sid"
		timeoutMinutes = 120
		httpOnly = true
		sameSite = "Lax"

	roles:
		admin: ["*"]
		editor: ["posts.write", "comments.write"]
		user: ["comments.write"]
```

Routes are guarded with inline role modifiers after the path:

```clean
endpoints:
	POST "/api/posts" [user, admin, editor]:
		...
```

## Architecture Highlights

### SSR + Islands = Best of Both Worlds

- **Server-Side Rendering** provides fast initial load and SEO
- **Islands Architecture** adds interactivity only where needed
- Non-interactive components stay static HTML
- Interactive islands hydrate on client (visible, idle, or on-load)

### Type-Safe Full Stack

- Database schema → Clean models → TypeScript SDK
- Single source of truth for data types
- Compile-time type checking prevents runtime errors

### Security by Default

- CSRF protection on all POST/PUT/PATCH/DELETE
- SQL injection prevention with parameterized queries
- XSS prevention with automatic HTML escaping
- HTTP-only secure cookies for sessions

## Performance

This example demonstrates Frame's performance characteristics:

- **< 50ms** First paint for SSR pages
- **< 100ms** API response times
- **Minimal JavaScript** Only islands need client-side JS
- **Progressive Enhancement** Works without JavaScript

## Learning Path

1. **Start with `src/main.cln`** - See the application entry point
2. **Explore `models/`** - Understand data modeling
3. **Read `components/`** - Learn component patterns
4. **Study `endpoints:`** - API route definitions
5. **Check `migrations/`** - Database schema evolution

## Deployment

Build for production:

```bash
# Build for server deployment
frame build --target=server

# Build for web (WASM)
frame build --target=web

# Build for mobile
frame build --target=ios
frame build --target=android
```

## Further Reading

- [Frame Framework Documentation](../../documents/README.md)
- [Islands Architecture Guide](../../system-documents/islands-architecture.md)
- [Authentication Guide](../../system-documents/authentication-guide.md)
- [Database ORM Guide](../../documents/specification/04_frame_data.md)

## License

MIT License - See LICENSE file for details

---

**This example demonstrates production-ready patterns for building modern web applications with Frame Framework.**
