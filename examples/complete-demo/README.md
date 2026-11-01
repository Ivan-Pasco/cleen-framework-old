# Complete Demo

A full-stack Clean Framework application demonstrating all core plugins working together.

## Features

- **Database Access** - User model with SQLite using frame.data
- **Registration Form** - Form validation and submission using frame.ui
- **Authentication** - Session-based auth with password hashing using frame.auth
- **API Endpoints** - RESTful API using frame.server
- **Canvas Animation** - Interactive particle system using frame.canvas

## Project Structure

```
complete-demo/
├── main.cln                    # Main application config
├── app/
│   ├── pages/                 # SSR HTML pages (frame.ui)
│   │   ├── index.html         # Landing page with animation
│   │   ├── register.html      # Registration form
│   │   └── dashboard.html     # User dashboard
│   │
│   ├── api/                   # API endpoints (frame.server)
│   │   └── users.cln          # User registration/login/list
│   │
│   ├── data/                  # Data models (frame.data)
│   │   └── User.cln           # User model with CRUD
│   │
│   ├── auth/                  # Auth config (frame.auth)
│   │   └── config.cln         # Sessions, password hashing
│   │
│   ├── canvas/                # Canvas apps (frame.canvas)
│   │   └── particles.cln      # Particle animation
│   │
│   └── components/            # Reusable components
│
└── public/
    └── css/
        └── style.css          # Application styles
```

## Running the Demo

```bash
# Navigate to the example
cd examples/complete-demo

# Start the development server
cleen serve

# Open in browser
open http://localhost:3000
```

## Pages

### Home (/)
Landing page with:
- Interactive particle animation background
- Feature highlights
- Call-to-action buttons

### Register (/register)
Registration form with:
- Client-side validation
- Password confirmation
- Server-side validation
- Auto-login after registration

### Dashboard (/dashboard)
User dashboard with:
- Stats cards (total users, active users, new today)
- User table from database
- Embedded canvas animation

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/users/register | Register new user |
| POST | /api/users/login | Login user |
| GET | /api/users | List all users |
| GET | /api/users/:id | Get user by ID |

## Plugins Used

1. **frame.data** - ORM for User model
2. **frame.server** - API endpoints
3. **frame.auth** - Authentication & sessions
4. **frame.ui** - SSR pages & forms
5. **frame.canvas** - Particle animation (browser module, see below)

## Key Concepts Demonstrated

### Folder Conventions
Each folder maps to a specific plugin:
- `pages/` → frame.ui (HTML pages)
- `api/` → frame.server (endpoints)
- `data/` → frame.data (models)
- `auth/` → frame.auth (config)
- `canvas/` → frame.canvas (animations)

### File Extensions
- `.html` for SSR pages (full editor support)
- `.css` for styles (full editor support)
- `.cln` for Clean Language logic

### Clean Templating in HTML
```html
<h1>Welcome, {{ user.name }}</h1>
<ul cl-iterate="item in items">
    <li>{{ item.title }}</li>
</ul>
<div cl-if="user.isAdmin">Admin content</div>
```

### Type-Safe Data Models
```clean
data User:
    fields:
        id: integer primary autoincrement
        email: string unique
        username: string
```

### Declarative Endpoints
```clean
endpoints:
    POST "/api/users/register":
        string email = req.json(User).email
        string password = req.json(User).password
        // Type-safe request handling
```

### Canvas Animations

Canvas scenes run in the browser: every frame.canvas bridge function is
browser-only, so `app/canvas/` is not part of the server build (`main.cln`
limits the server build to `shared: [app/ui, app/server, app/data]`). The
scene is its own browser module and draws into the page's
`<canvas id="particles">` element:

```bash
cln compile app/canvas/particles.cln -o public/particles.wasm
```

```clean
canvasScene: id="particles" width=800 height=400 fps=60 background="#0d1117"
    state:
        number frameCount = 0.0

    onFrame: param="dt"
        frameCount = frameCount + dt * 60.0
        canvas.circle x=400 y=200 radius=20 color="#ffffff30"
```
