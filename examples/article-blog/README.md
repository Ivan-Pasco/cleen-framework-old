# Article Blog Example

A beautiful article blog demonstrating the Frame Data Plugin with an editorial magazine aesthetic.

## Features

- **Data Models**: Authors, Articles, Tags with relationships
- **CRUD Operations**: Full database operations using Frame Data
- **Responsive Design**: Mobile-first, works on all devices
- **Editorial Aesthetic**: Sophisticated typography, elegant layouts
- **Animations**: Smooth scroll-triggered card animations

## Prerequisites

- Clean Language Compiler v0.15.0+
- Clean Server v1.0.0+
- A database (SQLite for development)

## Running the Example

1. **Compile the application**:
   ```bash
   cln compile main.cln -o app.wasm --plugins
   ```

2. **Start the server with SQLite**:
   ```bash
   DATABASE_URL="sqlite:///tmp/blog.db" clean-server app.wasm --port 3000
   ```

3. **Open in browser**:
   ```
   http://localhost:3000
   ```

## Data Models

### Author
```clean
data Author
    integer id : pk, auto
    string  name : required
    string  bio
    string  avatar
    datetime createdAt : default=now
```

### Article
```clean
data Article
    integer id : pk, auto
    string  title : required
    string  slug : unique, required
    string  excerpt
    string  content : required
    string  coverImage
    string  category
    integer readTime = 5
    boolean published = false
    Author  author
    datetime publishedAt
    datetime createdAt : default=now
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Home page with featured articles |
| GET | `/articles` | Paginated article list |
| GET | `/articles/{slug}` | Article detail page |
| GET | `/api/articles` | JSON API for articles |
| GET | `/api/articles/{id}` | JSON API for single article |

## Database Operations Demonstrated

### Insert
```clean
Author author = Author()
author.name = "Elena Marchetti"
author.bio = "Senior Editor"
Database.save(author)
```

### Find with conditions
```clean
list<Article> featured = Article.find:
    where:
        published == true
    order:
        publishedAt desc
    limit: 6
```

### First (single record)
```clean
Article? article = Article.first:
    where:
        slug == slug
        published == true
```

### Count
```clean
integer authorCount = Author.count:
    where:
        id > 0
```

## Design Features

- **Typography**: Playfair Display for headlines, Source Serif 4 for body
- **Color Palette**: Warm paper tones with rust, gold, sage, and navy accents
- **Texture**: Subtle grain overlay for depth
- **Animations**: Staggered card reveals, hover effects
- **Layout**: Asymmetric grid with featured article prominence

## Customization

### Change Categories
Modify the `category` field values and update the CSS:
```css
.category-technology .card-category { color: var(--accent-navy); }
.category-culture .card-category { color: var(--accent-sage); }
.category-design .card-category { color: var(--accent-gold); }
```

### Add New Articles
Use the Frame Data syntax:
```clean
Article article = Article()
article.title = "Your Article Title"
article.slug = "your-article-slug"
article.excerpt = "Brief description..."
article.content = "<p>Full HTML content...</p>"
article.category = "Design"
article.read_time = 5
Database.save(article)
```
