# HTML Simple Example

Two static HTML pages built with frame.ui.

## Project Structure

```
html-simple/
├── main.cln                  # Package manifest (target: web, plugins: frame.ui)
├── app/ui/web/pages/
│   ├── index.html            # /
│   └── about.html            # /about
└── public/css/style.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/html-simple
~/.cleen/bin/cln compile main.cln -o html-simple.wasm --plugins
~/.cleen/bin/clean-server html-simple.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`), but the current frame.ui does not route plain `.html` pages yet, so those URLs return 404 for now.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh html-simple` from the framework root.
