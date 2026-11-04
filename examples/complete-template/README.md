# Clean Framework Starter Template

A minimal starter project with one page, one component and one API endpoint.

## Project Structure

```
complete-template/
├── main.cln                     # Package manifest (target: server)
├── app/
│   ├── server/api/hello.cln     # GET /api/hello
│   └── ui/web/
│       ├── components/Header.cln  # <app-header>
│       └── pages/index.html     # /
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/complete-template
~/.cleen/bin/cln compile main.cln -o complete-template.wasm --plugins
~/.cleen/bin/clean-server complete-template.wasm --port 3000

curl http://localhost:3000/api/hello
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh complete-template` from the framework root.

## Customization

1. **Pages**: add `.html` files in `app/ui/web/pages/`
2. **Components**: add `.cln` files with a `component: tag="..."` block in `app/ui/web/components/`
3. **API routes**: add `.cln` files with an `endpoints:` block in `app/server/api/`
4. **Plugins**: list them under `target: server` → `plugins:` in `main.cln`
