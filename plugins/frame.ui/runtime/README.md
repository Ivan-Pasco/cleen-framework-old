# Frame UI Runtime

This directory contains the browser runtime for Frame UI applications.

## Files

- `shell.html` - HTML template that hosts the application
- `loader.js` - WASM loader with plugin-extensible bridge (v3.0)

## Architecture: Plugin-Extensible Runtime

The loader uses a **shared runtime pattern** that allows multiple plugins to contribute bridge functions to a single WASM instance.

### Load Order

```html
<script src="loader.js" data-wasm="app.wasm"></script>  <!-- frame.ui (always first) -->
<script src="frame-client.js"></script>                 <!-- frame.client (optional) -->
```

frame.ui writes both tags into an HTML entry page that loads the runtime when the build includes frame.client (`frame-client.js` is frame.client's `runtime/bridge.js`, emitted as a build artifact and served at `/frame-client.js`).

### How It Works

1. `loader.js` creates `window.__cleanRuntime` (with `registerEnv()`) as soon as it runs
2. Companion runtimes after it (e.g. `frame-client.js`) register their bridge functions via `registerEnv()`
3. `loader.js` waits until the document is parsed (so every companion has run), merges the registered functions into its own and instantiates the WASM
5. Calls `_start()` -- the WASM module registers event handlers
6. Events dispatch to named handler functions via internal indices

### Shared Runtime API (`window.__cleanRuntime`)

| Method | Description |
|--------|-------------|
| `readString(ptr, len)` | Read string from WASM memory |
| `writeString(str)` | Write string to WASM memory, returns pointer |
| `getMemory()` | Get the WASM memory (available after loading) |
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

### Two-way binding (`cl-bind`, UI-B005)

frame.ui renders a bound control with `data-cl-bind='field'` and the field's current value (`value`, `checked`, textarea text, or `data-cl-value` plus a `selected` option for a select). Inside a hydrated component island (`data-island='tag'`) an edit calls the export `<tag without hyphens>_bind(field, value)`: text controls on every `input` event, checkboxes (`"true"` / `"false"`), radios (their value, once checked) and selects on `change`. The export sets the component's field and patches the island with the new render; the other bound controls in the island are then set to the rendered values. Outside an island `cl-bind` does nothing (the component is not hydrated).

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
<script src="loader.js" data-wasm="app.wasm"></script>
<script src="frame-client.js"></script>
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
    frame-client.js (frame.client runtime)
    loader.js       (frame.ui runtime + WASM loader)
    frontend.wasm   (browser - UI + client)
    backend.wasm    (server - API endpoints)
```

Run the backend with clean-server:
```bash
clean-server backend.wasm -p 3000
```
