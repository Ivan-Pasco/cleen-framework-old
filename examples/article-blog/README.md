# Article Blog Example

An editorial-style article blog built with frame.ui pages and components, a frame.data `Article` model and a small JSON API.

## Project Structure

```
article-blog/
├── main.cln                         # Package manifest (target: server)
├── app/
│   ├── data/models/Article.cln      # Article data model
│   ├── server/
│   │   ├── main.cln                 # start: Article.migrate()
│   │   └── api/articles.cln         # /api/articles endpoints
│   └── ui/web/
│       ├── components/
│       │   ├── Header.cln           # <site-header>
│       │   ├── Footer.cln           # <site-footer>
│       │   └── article-card.cln     # <article-card>
│       └── pages/
│           ├── index.html           # /
│           ├── about.html           # /about
│           └── articles/
│               ├── index.html       # /articles
│               └── [slug].html      # /articles/:slug
└── public/css/main.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/article-blog
~/.cleen/bin/cln compile main.cln -o article-blog.wasm --plugins
DATABASE_URL="sqlite:///tmp/blog.db" ~/.cleen/bin/clean-server article-blog.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`). frame.ui routes every page file the compiler gives it, but compiler 0.33.169 passes only the manifest's entry page and pages with a companion `.cln`, so the other plain `.html` pages return 404 until the compiler passes page files to the plugin.

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh article-blog` from the framework root.

`app/server/main.cln` creates the tables on start with `Model.migrate()`.

## Data Model

`app/data/models/Article.cln`:

```clean
data Article:
	fields:
		integer id primary generated
		string title required
		string slug required unique
		string excerpt
		string content
		string category
		string author
		integer read_time
		string created_at
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/articles` | All articles, newest first |
| GET | `/api/articles/:slug` | One article by slug |

## Queries Used

From `app/server/api/articles.cln`:

```clean
list<Article> articles = Article.find:
	order: created_at desc

Article? article = Article.first:
	where:
		slug == articleSlug
onError:
	return notFound()
if article == none
	return notFound()
```

Writes go through `Database.save(entity)`:

```clean
Article article = Article()
article.title = "Your Article Title"
article.slug = "your-article-slug"
article.category = "Design"
article.read_time = 5
Database.save(article)
```
