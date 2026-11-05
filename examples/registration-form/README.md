# Registration Form Example

A server-rendered registration form component that posts to a validating JSON endpoint.

## Project Structure

```
registration-form/
├── main.cln                                # Package manifest (target: server)
├── app/
│   ├── server/api/register.cln             # POST /api/register
│   └── ui/web/
│       ├── components/RegistrationForm.cln # <registration-form>
│       ├── pages/index.html                # /
│       └── styles/theme.cln                # styles Theme: design tokens
└── public/css/theme.css
```

## Build and Run

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/registration-form
~/.cleen/bin/cln compile main.cln -o registration-form.wasm --plugins
~/.cleen/bin/clean-server registration-form.wasm --port 3000

curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Ada", "email": "ada@example.com", "password": "secret123"}'
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`).

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh registration-form` from the framework root.

## Validation

`POST /api/register` expects a JSON body with `name`, `email` and `password`, and returns `400` when a field is missing, the name is shorter than 2 characters, the email has no `@` or the password is shorter than 8 characters. From `app/server/api/register.cln`:

```clean
if name.length() < 2
	return badRequest("Name must be at least 2 characters")

if email.indexOf("@") < 0
	return badRequest("Invalid email address")
```

## Component

`RegistrationForm.cln` declares `component: tag="registration-form", client="off"`, so it is rendered on the server only.
