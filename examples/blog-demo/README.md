# Blog Demo

A small blog showing the project layout: HTML pages, components, a data model and a JSON API.

## Project Structure

```
blog-demo/
├── main.cln                      # Package manifest (target: server)
├── app/
│   ├── data/models/Post.cln      # Post data model
│   ├── server/
│   │   ├── main.cln              # start: Post.migrate()
│   │   └── api/posts.cln         # /api/posts endpoints
│   └── ui/web/
│       ├── components/
│       │   ├── Header.cln        # <blog-header>
│       │   └── Footer.cln        # <blog-footer>
│       └── pages/
│           ├── index.html        # /
│           ├── about.html        # /about
│           └── blog/
│               ├── index.html    # /blog
│               └── [slug].html   # /blog/:slug
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/blog-demo
~/.cleen/bin/cln compile main.cln -o blog-demo.wasm --plugins
DATABASE_URL=sqlite::memory: ~/.cleen/bin/clean-server blog-demo.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh blog-demo` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## API Endpoints

| Method | Path | File |
|--------|------|------|
| GET | `/api/posts` | `app/server/api/posts.cln` |
| GET | `/api/posts/:slug` | `app/server/api/posts.cln` |

## Conventions Shown

1. Pages in `app/ui/web/pages/` map to routes by path; `index.html` maps to the folder URL.
2. `[param]` in a file name is a URL parameter (`[slug].html` → `/blog/:slug`).
3. Components in `app/ui/web/components/` declare their tag with `component: tag="..."`.
4. Endpoint files in `app/server/api/` are discovered automatically.
