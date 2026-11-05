# Blog App Example

A blog with users, posts and comments: HTML pages and components (frame.ui), a JSON API (frame.server), data models (frame.data) and session auth with roles (frame.auth).

## Project Structure

```
blog-app/
├── main.cln                          # Package manifest (target: server)
└── app/
    ├── auth/auth.cln                 # auth: session and roles
    ├── data/
    │   ├── migrations/               # Reference SQL schema for users, posts, comments
    │   │   ├── 001_create_users.sql
    │   │   ├── 002_create_posts.sql
    │   │   └── 003_create_comments.sql
    │   └── models/
    │       ├── User.cln
    │       ├── Post.cln
    │       └── Comment.cln
    ├── server/
    │   ├── main.cln                  # start: migrate() for each model
    │   └── api/
    │       ├── auth/login.cln, register.cln, logout.cln
    │       ├── posts/index.cln, [id].cln
    │       ├── comments/index.cln, [id].cln
    │       ├── me.cln
    │       ├── user.cln
    │       └── admin/stats.cln, users.cln, user.cln
    └── ui/web/
        ├── components/
        │   ├── Header.cln            # <app-header>
        │   ├── Footer.cln            # <app-footer>
        │   └── PostCard.cln          # <post-card>
        └── pages/
            ├── index.html            # /
            ├── posts.html            # /posts
            ├── post/[slug].html      # /post/:slug
            ├── login.html            # /login
            ├── register.html         # /register
            └── dashboard.html        # /dashboard
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/blog-app
~/.cleen/bin/cln compile main.cln -o blog-app.wasm --plugins
DATABASE_URL=sqlite::memory: JWT_SECRET=dev-secret \
  ~/.cleen/bin/clean-server blog-app.wasm --port 3000

curl http://localhost:3000/api/posts
```

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`). frame.ui routes every page file the compiler gives it, but compiler 0.33.169 passes only the manifest's entry page and pages with a companion `.cln`, so the other plain `.html` pages return 404 until the compiler passes page files to the plugin.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh blog-app` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`. Register and login call `auth.setSession(...)`, which sets the `blog.sid` session cookie.

## API Endpoints

| Method | Path | Guard |
|--------|------|-------|
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | `[user, admin]` |
| GET | `/api/posts` | public |
| GET | `/api/posts/:id` | public |
| POST | `/api/posts` | `[user, admin, editor]` |
| PUT / DELETE | `/api/posts/:id` | `[user, admin, editor]` |
| GET | `/api/comments` | public |
| POST | `/api/comments` | `[user, admin]` |
| DELETE | `/api/comments/:id` | `[user, admin]` |
| GET / PUT | `/api/me` | `[user, admin]` |
| GET | `/api/user` | `[user, admin]` |
| GET | `/api/admin/stats` | `[admin]` |
| GET | `/api/admin/users` | `[admin]` |
| DELETE | `/api/admin/user` | `[admin]` |

## Key Code

### Data model with indexes and relations

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

### Endpoints

Reads use the query DSL; writes load an entity and go through `Database.save` / `Database.delete`.

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

### Component

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

### Auth and roles

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

Routes are guarded with role lists after the path, e.g. `POST "/api/posts" [user, admin, editor]:`.
