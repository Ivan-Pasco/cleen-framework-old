# frame.ui Plugin

UI components plugin for Clean Language. Provides DSL blocks for building reactive UI components with SSR and hydration support.

## Blocks

### component

Defines a reusable UI component with props, state, and render method.

**Attributes:**
- `name` (required) - Component class name (PascalCase)
- `client` (optional, default: "off") - Hydration mode:
  - `off` - No client-side JavaScript
  - `on` - Hydrate immediately
  - `visible` - Hydrate when visible
  - `idle` - Hydrate when browser is idle
  - `only` - Client-side only (no SSR)

**Example:**
```clean
import:
    frame.ui

component: name="Counter" client="on"
    inputs:
        integer initialValue = 0

    state:
        integer count = 0

    render()
        return "<div class=\"counter\">
            <span>" + count().toString() + "</span>
            <button onclick=\"increment()\">+</button>
        </div>"

    increment()
        setCount(count() + 1)
```

### layout

Defines a layout wrapper with slot support.

**Attributes:**
- `name` (required) - Layout class name

**Example:**
```clean
layout: name="MainLayout"
    return "<!DOCTYPE html>
    <html>
    <head>
        <title>My App</title>
    </head>
    <body>
        <nav>...</nav>
        <main>" + _slot() + "</main>
        <footer>...</footer>
    </body>
    </html>"
```

### page

Defines a page class (frame-ui.ebnf `page_block`). The class name follows
`page`; the URL comes from the file path under `app/ui/web/pages/`, or from
an `at "/path"` annotation when it must differ. The header takes no
`key="value"` attributes (`page: name="..." path="..."` is error
FRAME-UI-E017).

**Example:**
```clean
page HomePage:
	<h1>Welcome</h1>
	<p>This is the home page.</p>
```

## Hydration Modes

| Mode | SSR | Client Hydration | Use Case |
|------|-----|------------------|----------|
| `off` | Yes | No | Static content |
| `on` | Yes | Immediate | Interactive content |
| `visible` | Yes | On visibility | Below-fold content |
| `idle` | Yes | When idle | Low-priority interactivity |
| `only` | No | Immediate | Client-only widgets |

## Generated Code

Components generate a class with:
- Props as read-only fields
- State with getter/setter methods
- `render()` - Returns HTML string
- `renderSSR()` - Returns HTML with hydration attributes

## Building

```bash
./build.sh
# or
cln compile src/main.cln -o plugin.wasm
```

## Installation

```bash
cleen plugin install ./
```

## Plugin Contracts

Implements:

- [`lifecycle`](../../../foundation/spec/plugins/contracts/lifecycle.md) —
  - `module_helpers_are_roots = true` keeps preamble-emitted SSR helpers (`render`, `renderWith`) and their `_ui_render_page` bridge import reachable across the BFS.
  - `client_init = "emit_ui_client_init"` is invoked once per client-mode build; the slot emits instantiation + `onMount()` calls for every component with `client != "off"`. Closes HYDRATE_AUTO.
- [`artifacts`](../../../foundation/spec/plugins/contracts/artifacts.md) — declares `frontend.wasm` as a side-channel build artifact emitted via `from_module = "client_only_build"`, predicated on `has_build_state.frame.ui:components`. Drives BUILD_FRONTEND.
- [`bridge-host-classes`](../../../foundation/spec/plugins/contracts/bridge-host-classes.md) — every `_ui_*` bridge declares `hosts = [...]` (most are `["browser", "server"]` with `browser_impl = "real"` / `server_impl = "stub"`). One `callback=` entry routes `_ui_render_page` through the right host class. Closes SRV001 / SRV004.
