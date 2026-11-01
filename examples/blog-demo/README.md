# Blog Demo

A Clean Framework example demonstrating the new project structure with automatic file discovery.

## Project Structure

```
blog-demo/
  app/
    ui/
      pages/                    # HTML routes (auto-discovered)
        index.html          # → GET /
        about.html          # → GET /about
        blog/
          index.html        # → GET /blog
          [slug].html       # → GET /blog/:slug
      components/               # Custom elements (auto-discovered)
        Header.cln              # → <blog-header>
        Footer.cln              # → <blog-footer>
      public/                   # Static assets
        css/
          style.css
    server/
      api/                      # JSON endpoints (auto-discovered)
        posts.cln               # → GET /api/posts
      models/                   # Database models (auto-discovered)
        Post.cln
  config.cln                    # Project configuration
```

## Build & Run

```bash
# Scan project to see discovered routes
frame scan

# Build the project
frame build

# Run with Clean Server
cleen server run dist/app.wasm --port 3000
```

## Routes

| Route | File | Description |
|-------|------|-------------|
| `GET /` | `app/ui/web/pages/index.html` | Home page |
| `GET /about` | `app/ui/web/pages/about.html` | About page |
| `GET /blog` | `app/ui/web/pages/blog/index.html` | Blog listing |
| `GET /blog/:slug` | `app/ui/web/pages/blog/[slug].html` | Single post |
| `GET /api/posts` | `app/server/api/posts.cln` | Posts JSON API |

## Components

| Tag | File |
|-----|------|
| `<blog-header>` | `app/ui/web/components/Header.cln` |
| `<blog-footer>` | `app/ui/web/components/Footer.cln` |

## Key Features

1. **File-based routing**: Pages in `app/ui/web/pages/` automatically become routes
2. **Dynamic routes**: `[param]` syntax creates URL parameters
3. **Auto-discovery**: No manual route registration needed
4. **Custom elements**: Components become HTML tags
5. **Static assets**: Files in `public/` served at `/public/*`
