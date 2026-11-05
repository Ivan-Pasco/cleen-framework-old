# Frame UI Runtime

This directory contains the browser runtime for Frame UI applications.

## Files

- `shell.html` - HTML template that hosts the application
- `loader.js` - WASM loader with plugin-extensible bridge (v3.0)

## Architecture: Plugin-Extensible Runtime

The loader uses a **shared runtime pattern** that allows multiple plugins to contribute bridge functions to a single WASM instance.

### Load Order

```html
<script src="bridge.js"></script>         <!-- frame.client (optional) -->
<script src="loader.js" data-wasm="app.wasm"></script>  <!-- frame.ui (always last) -->
```

### How It Works

1. `loader.js` Phase 1 creates `window.__cleanRuntime` with shared memory helpers
2. `loader.js` Phase 2 registers frame.ui bridge functions via `registerEnv()`
3. Plugin bridges (e.g., `bridge.js` from frame.client) register their functions via `registerEnv()`
4. `loader.js` Phase 3 collects all registered functions and instantiates WASM
5. Calls `_start()` -- the WASM module registers event handlers
6. Events dispatch to named handler functions via internal indices

### Shared Runtime API (`window.__cleanRuntime`)

| Method | Description |
|--------|-------------|
| `readString(ptr, len)` | Read string from WASM memory |
| `writeString(str)` | Write string to WASM memory, returns pointer |
| `memAlloc(size)` | Allocate bytes on WASM heap |
| `getInstance()` | Get WASM instance (available after loading) |
| `registerEnv(fns)` | Register bridge functions (call before WASM loads) |

## Bridge Functions

All bridge functions use WASM pointer+length format for strings. Handler parameters accept the exported function name as a string (looked up via `instance.exports[name]`).

### Event Registration

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_onEvent` | selector, event_type, handler_name | integer | Register event handler via document-level delegation. `handler_name` must match a top-level function export. |

### Declarative Event Attributes (UI-B006 / UI-B007)

Event attributes in templates need no `ui.onEvent` call. The loader reads both forms frame.ui emits:

- page mode (`page` blocks, HTML entry pages): `data-on-click='save'` plus one `data-on-click-<modifier>='true'` marker (several modifiers may share one marker: `data-on-click-stop.prevent`).
- `html:` blocks, component and screen templates: `onclick="save"` / `onsubmit.prevent="save"` as written. The loader rewrites these to the `data-on-*` form before the module loads, so the browser never runs the handler name as inline script.

One document-level listener per event type dispatches to `instance.exports[name]`; inside a `data-screen` / `data-component` wrapper the scoped export (`Counter.increment`) is used when the plain name is not exported. Handlers take no parameters (read event data with the event-context functions below). A missing export is a console error when the event fires. Markup inserted later (bridge calls, navigation, any DOM insertion) is picked up automatically.

Modifiers: `.prevent`, `.stop` (no ancestor handlers run), `.once`, `.passive` (no `preventDefault`), `.enter` / `.escape` / `.space` (key filter), `.left` / `.right` (mouse button filter). `focus`, `blur`, `mouseenter`, `mouseleave`, `pointerenter`, `pointerleave` and `scroll` do not bubble: only the element's own handler runs.

Tests: `node scripts/test_event_dispatch.mjs` (compiles `scripts/fixtures/*.cln` with `$CLEEN_CLN` or `~/.cleen/bin/cln`).

### Event Context (inside handler)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_eventAttr` | attr_name | string | Get attribute from event target |
| `_ui_eventValue` | -- | string | Get value (inputs) or textContent of event target |
| `_ui_eventClosestAttr` | selector, attr_name | string | Find closest ancestor, get its attribute |
| `_ui_eventType` | -- | string | Get event type (click, input, etc.) |

### DOM Manipulation (single element)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_updateElement` | selector, content | integer | Set innerHTML |
| `_ui_updateAttr` | selector, attr, value | integer | Set attribute |
| `_ui_getText` | selector | string | Get textContent |
| `_ui_getAttr` | selector, attr | string | Get attribute |
| `_ui_toggleClass` | selector, class | integer | Toggle CSS class |
| `_ui_addClass` | selector, class | integer | Add CSS class |
| `_ui_removeClass` | selector, class | integer | Remove CSS class |
| `_ui_setStyle` | selector, property, value | integer | Set inline style |
| `_ui_updateElementSelf` | content | integer | Update event target's textContent |

### DOM Batch (querySelectorAll)

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_querySetStyle` | selector, property, value | integer | Set style on ALL matching elements |
| `_ui_querySetAttr` | selector, attr, value | integer | Set attribute on ALL matching |
| `_ui_queryAddClass` | selector, class | integer | Add class to ALL matching |
| `_ui_queryRemoveClass` | selector, class | integer | Remove class from ALL matching |
| `_ui_filterByAttr` | selector, attr, value | integer | Show matching, hide others |
| `_ui_filterByText` | selector, name_attr, desc_attr, query | integer | Filter by text search |

### Form Helpers

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_inputValue` | selector | string | Get input/textarea/select value |
| `_ui_formJson` | selector | string | Collect form as JSON string |
| `_ui_formData` | selector | string | Collect form as URL-encoded |
| `_ui_checked` | selector | integer | Checkbox state (0/1) |
| `_ui_setInput` | selector, value | integer | Set input value |

### Browser APIs

| Function | Params | Returns | Description |
|----------|--------|---------|-------------|
| `_ui_clipboardWrite` | text | integer | Copy text to clipboard |
| `_ui_locationHref` | url | integer | Navigate to URL |
| `_ui_locationQuery` | param | string | Get URL query parameter |
| `_ui_locationPath` | -- | string | Get current pathname |
| `_ui_observeVisible` | selector, class | integer | Add class when visible (one-shot) |
| `_ui_setTimeout` | handler_name, delay_ms | integer | Call exported handler by name after delay |
| `_ui_injectHeadCss` | css | integer | Inject CSS into page head |

## Usage

### Compile

```bash
cln compile app/client/main.cln -o dist/app.wasm --plugins
```

### Deploy

Copy runtime files to your dist folder:

```html
<script src="bridge.js"></script>
<script src="loader.js" data-wasm="app.wasm"></script>
```

### Example

```clean
import frame.ui
import frame.client

start:
    integer s = ui.onEvent(".copy-btn", "click", "copyCode")
    s = ui.onEvent(".search-input", "input", "searchCards")
    s = api.get("/api/data", "onDataLoaded")

functions:
    copyCode()
        string code = ui.eventClosestAttr(".code-window", "data-code")
        integer s = ui.clipboardWrite(code)
        s = ui.updateElementSelf("Copied!")
        s = ui.setTimeout("resetCopyBtn", 2000)

    resetCopyBtn()
        integer s = ui.updateElementSelf("Copy")

    searchCards()
        string query = ui.eventValue()
        integer s = ui.filterByText(".card", "data-name", "data-desc", query)

    onDataLoaded()
        if api.ok() == 1
            string body = api.body()
            integer s = ui.updateElement("#content", body)
```

## Fullstack Apps

Fullstack apps produce two WASM files:

```
dist/
    index.html      (shell + loader)
    bridge.js       (frame.client runtime)
    loader.js       (frame.ui runtime + WASM loader)
    frontend.wasm   (browser - UI + client)
    backend.wasm    (server - API endpoints)
```

Run the backend with clean-server:
```bash
clean-server backend.wasm -p 3000
```
