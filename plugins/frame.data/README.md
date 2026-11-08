# frame.data Plugin

ORM and database plugin for Clean Language. The language-level rules live in
the spec — this file only orients you:

- Syntax: `foundation/spec/framework/grammar/frame-data.ebnf`
- Semantics (DAT-* rules): `foundation/spec/framework/frame-data-semantics.md`
- `db.*` functions: `foundation/spec/stdlib-reference.md` §9

## Databases

frame.data supports **SQLite**, **PostgreSQL** and **MySQL 8.0+**. The
server picks the database from `DATABASE_URL` (or `clean-server --database`):

| Database | URL |
|---|---|
| SQLite | `sqlite:app.db`, `sqlite::memory:` |
| PostgreSQL | `postgres://user:pass@host/db`, `postgresql://...` |
| MySQL 8.0+ | `mysql://user:pass@host:3306/db` |

The plugin generates one SQL dialect (`$n` placeholders, `INSERT ...
RETURNING`, `CREATE INDEX IF NOT EXISTS`, `SERIAL` keys). On MySQL,
clean-server translates each statement before it runs (spec:
`foundation/spec/platform/HOST_BRIDGE.md` §Database, "SQL dialect"), so
models, queries, pagination, transactions and migrations work unchanged.
On MySQL a `string` field that is the key or `unique` becomes
`VARCHAR(255)`, and an index on a `string` column keys its first 255
characters. MariaDB is not supported.

Run the frame.data tests on MySQL with
`FRAMEWORK_TEST_MYSQL_URL=mysql://user:pass@host:port
scripts/run-framework-tests.sh unit/plugins/data` (each test gets a fresh
database).

## Data models

```clean
data Post:
	table "posts"                       // optional; default: snake_case plural
	fields:
		integer id primary generated
		string title required
		integer viewCount default: 0
	indexes:
		(viewCount, title)
	relations:
		author: belongs_to User on authorId
	queries:
		list<Post> popular(integer minViews)
			return find:
				where:
					viewCount >= minViews
```

`data M:` emits `class M` (fields plus `save()`, `delete()`, `migrate()`,
conforming to `can Persist`), the query methods of `queries:`, and the
per-model `PagedResult_M` / `CursorResult_M` classes.

## Reading

`M.find:`, `M.first:`, `M.findOrFail:`, `M.count:`, `M.exists:`,
`M.paginate:`, `M.cursor:` with the clauses `where:`, `order:`, `limit:`,
`offset:`, `select:`, `join:`, `link:`, `include:`, `group:`, `having:`,
`paginate:` and `cursor:`. Each query becomes one expression that builds the
SQL at run time. Run-time values in `where:` / `having:` (and the tenant
scope) are bound parameters; `paginate:` / `cursor:` quote them in place,
because the host binds no parameters for their condition. `limit:` /
`offset:` values must be non-negative integers. `include: <relation>` joins
the relation declared in `relations:` and returns each row of `M` once.

## Writing

`Database.save(entity)`, `Database.delete(entity)`,
`Database.deleteOrFail(entity)`, `Database.saveAll(list)`,
`Database.deleteAll(list)`. Group writes in `transaction:` (flat — no
nesting). Versioned schema changes go in `migrate "001_name":` blocks with
`up:` / `down:` SQL string literals. Raw SQL: `db.query(sql, params)`,
`db.execute(sql, params)`.

## Tenant isolation

A model with a `tenantId` (or `tenant_id`) field is tenant-scoped: inserts
take the session tenant (`tenant_getId()`, frame.auth) when the field is
empty, and every query, update and delete is limited to that tenant.

## Building and testing

```bash
CLN_COMPILER=~/.cleen/bin/cln bash build.sh
bash ../../scripts/test-plugins.sh                       # plugin helper tests (tests/)
CLEEN_SERVER=~/.cleen/bin/clean-server ../../scripts/run-framework-tests.sh unit/plugins/data
```

## Plugin contracts

- `lifecycle` — `module_helpers_are_roots = true`; `emit_module_helpers_typed`
  emits `can Persist:` and `class Database`.
- `bridge-host-classes` — every `_db_*` bridge declares `hosts = ["server"]`.
