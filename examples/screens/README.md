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
└── README.md
```

## Screen Syntax

Screens are `screen Name:` blocks with screen-scoped state and functions.
`render()` returns the screen markup through an `html:` block, and event
attributes name the screen function to call (UI-B006):

```clean
screen Counter:
	state:
		integer count = 0
		string label = "Count"

	functions:
		string render()
			html:
				<div class="counter-container">
					<p id="counter-display">{label}: {count.toString()}</p>
					<button onclick="increment">+</button>
				</div>

		void increment()
			count = count + 1
			integer s = ui.updateElement("#counter-display", label + ": " + count.toString())
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

```bash
# Build the example
frame build

# Start the development server
frame serve

# Open in browser
open http://localhost:3000
```

## Generated Output

Each `<screen name="Counter" client="on">` tag renders as:

```html
<div id='screen-Counter' data-screen='Counter' data-client='on'>
	<!-- markup returned by Counter.render() -->
</div>
```

When any screen on the page uses a `client` mode other than `off`, the page's
hydration manifest lists it.
