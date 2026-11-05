# Clean UI Screens Example

This example places screens on an HTML page. A screen is a core `screen Name:`
block: a view with its own screen-scoped state and functions. frame.ui provides
the `<screen>` tag that places a screen on a page.

## Overview

1. **Define screens** - `screen Name:` blocks with screen-scoped state and functions
2. **Place them on a page** - Use `<screen name="Name">` tags in HTML pages
3. **Choose hydration** - SSR-only, immediate, on-visible, or on-idle hydration

## Project Structure

```
screens/
├── main.cln                      # Package manifest (target: server)
├── app/
│   └── ui/
│       └── web/
│           ├── pages/
│           │   └── index.html    # HTML page with embedded screens
│           └── screens/
│               ├── Counter.cln   # Counter screen definition
│               └── TodoList.cln  # TodoList screen definition
├── public/css/style.css
└── README.md
```

## Screen Syntax

Screens are `screen Name:` blocks with screen-scoped state and functions.
`render()` returns the screen markup through an `html:` block, and event
attributes name the screen function to call (UI-B006):

```clean
// app/ui/web/screens/Counter.cln (excerpt)
screen Counter:
	state:
		integer count = 0
		string label = "Count"

	functions:
		string render()
			html:
				<div class="counter-container">
					<p class="counter-label" id="counter-display">{label}: {count.toString()}</p>
					<div class="counter-buttons">
						<button class="btn-decrement" onclick="decrement">-</button>
						<button class="btn-increment" onclick="increment">+</button>
						<button class="btn-reset" onclick="resetCount">Reset</button>
					</div>
				</div>

		void increment()
			count = count + 1
			integer s = ui.updateElement("#counter-display", label + ": " + count.toString())

		// decrement() and resetCount() follow the same pattern
```

### State Block

Screen state is declared inside the screen and lives as long as the screen.
There is one copy of a screen's state, and only the screen's own functions can
read or change it (SCOPE005):

```clean
state:
	integer count = 0
	string name = ""
	boolean active = true
```

### Screen Functions

A screen's functions are scoped under the screen's name, so two screens can
both declare `render()`. Inside the screen they are called by their plain name;
from outside they are called as `Screen.function()`:

```clean
start:
	Counter.increment()
	string markup = Counter.render()
```

## Placing Screens

Use the `<screen>` tag in HTML pages. `name` selects the screen and `client`
selects the hydration mode; the tag has no other attributes:

```html
<!-- Server-rendered only -->
<screen name="Counter"></screen>

<!-- Immediate hydration -->
<screen name="Counter" client="on"></screen>
```

### Hydration Modes

| Mode | Description |
|------|-------------|
| `off` | Server-side render only (default) |
| `on` | Immediate hydration on page load |
| `visible` | Hydrate when element scrolls into viewport |
| `idle` | Hydrate when browser is idle |

## Running the Example

Plugins come from `~/.cleen/plugins` (installed with `cleen frame install latest`).

```bash
cd examples/screens
~/.cleen/bin/cln compile main.cln -o screens.wasm --plugins
~/.cleen/bin/clean-server screens.wasm --port 3000
```

Start the server from the example folder: `./public` is served at `/public/`, which is where the pages link their stylesheets.

Page URLs follow the file path under `app/ui/web/pages/` (`index.html` → `/`).

To compile, start and request every route in one step, run `./scripts/smoke-examples.sh screens` from the framework root.

## Generated Output

Each `<screen name="Counter" client="on">` tag renders as:

```html
<div id='screen-Counter' data-screen='Counter' data-client='on'>
	<!-- markup returned by Counter.render() -->
</div>
```

When any screen on the page uses a `client` mode other than `off`, the page's
hydration manifest lists it.
