# HTML-First Example

HTML pages built from components, a shared layout and a page with a companion data loader.

## Project Structure

```
html-first/
├── main.cln                          # Package manifest (target: server)
├── app/ui/web/
│   ├── pages/
│   │   ├── index.html                # /
│   │   ├── dashboard.html            # /dashboard
│   │   └── blog/
│   │       ├── index.html            # /blog
│   │       ├── [slug].html           # /blog/:slug
│   │       └── [slug].cln            # Companion loader for [slug].html
│   ├── components/
│   │   ├── Header.cln                # <app-header>
│   │   ├── Footer.cln                # <app-footer>
│   │   ├── UserBadge.cln             # <user-badge>
│   │   ├── StatCard.cln              # <stat-card>
│   │   ├── NewsletterForm.cln        # <newsletter-form>
│   │   ├── CommentForm.cln           # <comment-form>
│   │   └── ShareButton.cln           # <share-button>
│   └── layouts/
│       └── main.html
└── public/css/main.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/html-first
~/.cleen/bin/cln compile main.cln -o html-first.wasm --plugins
~/.cleen/bin/clean-server html-first.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`). frame.ui routes every page file the compiler gives it, but compiler 0.33.169 passes only the manifest's entry page and pages with a companion `.cln`, so the other plain `.html` pages return 404 until the compiler passes page files to the plugin.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh html-first` from the framework root.


## Companion Loader

A `.cln` file next to a page, with the same base name, supplies its data. From `app/ui/web/pages/blog/[slug].cln`:

```clean
functions:
	any load(Request request)
		string slug = request.params.slug
		return { slug: slug }
```

