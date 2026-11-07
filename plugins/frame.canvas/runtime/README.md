# Clean Canvas Browser Runtime

Browser host for `canvasScene:` applications compiled with the frame.canvas plugin.

## Files

| File | Description |
|------|-------------|
| `canvas-bridge.js` | Implements every `[bridge]` function declared in `../plugin.toml` (canvas, sprites, tweens, timelines, animState, particles, audio, input, collision, camera, scenes, page bridge) |
| `loader.js` | Instantiates the module: canvas bridge + stdlib imports (`env`) + `memory_runtime`, JSON bridges, module-heap allocation |
| `shell.html` | Page template that loads `app.wasm` (`?wasm=` overrides the path; only a same-origin relative path is loaded) |
| `examples/*.cln` | Hand-written example scenes |
| `tests/` | Node tests for the runtime (see below) |

## Use

```html
<canvas id="main" width="800" height="600"></canvas>
<script src="canvas-bridge.js"></script>
<script src="loader.js"></script>
<script>
  CleanCanvas.load('app.wasm');   // calls _start(); the scene starts its frame loop
</script>
```

The scene's `id=` names the page's `<canvas id="...">` (CVS-I001); when no such
element exists the bridge creates one inside `#canvas-container` (or `<body>`).

## Conventions

- String parameters declared with `expand_strings = true` arrive as `(ptr, len)`.
  String results are length-prefixed (`[u32 length][UTF-8 bytes]`) and allocated
  on the module heap (`malloc` export, else the `__heap_ptr` bump pointer); a
  bridge without the loader's allocator cannot return strings.
- `integer` is i32 except where the registry says i64 (`int64_to_string`, JSON
  integers): i64 values cross as `BigInt`.
- Each frame the runtime advances tweens / timelines / animSprites / particles,
  then calls the module's `_frame_callback(canvasId)` (onFrame:, animState
  transitions, camera follow, draw:), then draws live particles.
- Event handlers are exported as `_on_pointer_down(cv, x, y)`, `_on_pointer_move`,
  `_on_pointer_up`, `_on_key_down(cv)`, `_on_key_up(cv)` (the key comes from
  `_canvas_event_key`), `_on_exit`, `_on_pause`, `_on_resume`.

## Tests

```bash
# Runtime unit tests (no compiler needed)
node plugins/frame.canvas/runtime/tests/runtime-bridges.test.mjs

# Plugin + runtime end to end (compiles tests/fixtures/scene.cln with
# $CLEEN_CLN or ~/.cleen/bin/cln and the plugin in this directory)
node plugins/frame.canvas/runtime/tests/scene-runtime.test.mjs

# Compile-time checks: invalid scenes fail with the CVS rule they break
node plugins/frame.canvas/runtime/tests/scene-diagnostics.test.mjs
```

Each prints one `PASS:` / `FAIL:` line and exits non-zero on failure.
