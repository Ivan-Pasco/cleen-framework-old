# Clean Canvas Browser Runtime

Browser host for `canvasScene:` applications compiled with the frame.canvas plugin.

## Files

| File | Description |
|------|-------------|
| `canvas-bridge.js` | Implements every `[bridge]` function declared in `../plugin.toml` (canvas, sprites, tweens, timelines, animState, particles, audio, input, collision, camera, scenes, page bridge) |
| `loader.js` | Instantiates scene modules: canvas bridge + stdlib imports (`env`) + `memory_runtime`, JSON bridges, module-heap allocation; runs the scene stack (`CleanCanvasScenes`) |
| `shell.html` | Stand-alone page template that loads `app.wasm` (`?wasm=` overrides the path; only a same-origin relative path is loaded) |
| `examples/*.cln` | Hand-written example scenes |
| `tests/` | Node tests for the runtime (see below) |

The plugin ships both scripts as build artifacts (`plugin.toml [[artifacts]]`):
a build that loads frame.canvas writes `frame-canvas-bridge.js` and
`frame-canvas.js` next to its output, and clean-server serves them at
`/frame-canvas-bridge.js` and `/frame-canvas.js`.

## Use on a page

A page names the scene module on its canvas; it needs no script of its own:

```html
<canvas id="game" width="800" height="600" data-scene="/public/Menu.wasm"></canvas>
```

frame.ui adds the two runtime scripts (bridge first) to every page with a
`data-scene=` canvas, and `frame-canvas.js` starts each such canvas's scene
(`CleanCanvas.boot()`). The scene's `id=` names the canvas it draws on
(CVS-I001). Add `frame.canvas` to the server build's plugins so the build
emits the runtime; build each scene file to its own module
(`cln compile app/canvas/scenes/Menu.cln -o public/Menu.wasm`).

From script (the stand-alone shell): `CleanCanvas.load('app.wasm')`.

## Scenes

A canvas app is a stack of scenes. Each scene file compiles to its own
module, and scene `"Name"` is the module `Name.wasm` next to the first
scene's module (`scene.change "levels/Two"` loads `levels/Two.wasm`).

- `scene.change` / `scene.changeTo` end every scene of the stack (`onExit:`)
  and start the named scene from its declared state (CVS-S001, CVS-S008).
  `changeTo` draws its `transition=` over `duration=` seconds: `fadeOut`
  (also `fade`), `crossfade`, `slideLeft`, `slideRight`, `slideUp`,
  `slideDown`, `instant` (the default).
- `scene.push` starts the named scene on top; the covered scene gets
  `onPause:` and keeps running underneath without input (CVS-S007).
  `scene.pop` ends the top scene; the one below gets `onResume:`. The last
  scene cannot be popped (CVS-X009).
- `scene.set` values are read by the next scene's `init:` with `scene.get`
  (the receiving variable's type converts the value, CVS-S004) and dropped
  after it (CVS-S003).
- A hidden tab pauses the top scene (`onPause:`) and stops the frame loop;
  showing it resumes them (CVS-S009).

Scene requests made in a frame or a handler run after it returns.

## Frames

Each frame the runtime advances tweens / timelines / animSprites /
particles, then calls the module's `_frame_callback(canvasId)` (onFrame:,
animState transitions, camera, draw:, `_canvas_present`), then draws the
live particles.

- `fps=` limits the frame rate; `dt` is the real time between frames
  (CVS-L006). `background=` is the starting colour and `canvas.clear`'s
  default (black without it).
- A scene with `layers:`, and every scene the scene manager runs, records
  its frame and composites it when the frame ends: the `canvas.clear` fill,
  then the layers that were drawn in ascending `z` (default layer first at
  `z=0`, equal `z` in declaration order), then the particles
  (CVS-D001..D004). `canvas.clear` drops what the frame's layers recorded so
  far (CVS-L004).
- A scene with a `camera:` block (or `camera.*` calls) draws through the
  camera. `cameraX` / `cameraY` are the world point at the canvas top-left;
  `followX` / `followY` centre the target, moving only by how far it leaves
  the deadzone, `smoothing` (0 snaps, near 1 is slow) per 1/60 s, and the
  bounds keep the whole `width / zoom` x `height / zoom` view inside them.
  `camera.shake` decays by its `falloff=` easing. The camera applies to the
  layers and particles, not to the `canvas.clear` fill.

## Page bridge

`page.set "k" value=v` / `page.get "k"` share values with the HTML layer
(CVS-I003): the store is frame.ui's state store (`ui.setState` /
`ui.getState`), published by either runtime as
`window.__cleanRuntime.pageState`. Values are JSON-encoded (numbers and
booleans as written, other text as a JSON string); `page.get` returns the
text, converted for an `integer` / `number` / `boolean` receiver.

## Conventions

- String parameters declared with `expand_strings = true` arrive as `(ptr, len)`.
  String results are length-prefixed (`[u32 length][UTF-8 bytes]`) and allocated
  on the module heap (`malloc` export, else the `__heap_ptr` bump pointer); a
  bridge without the loader's allocator cannot return strings.
- `integer` is i32 except where the registry says i64 (`int64_to_string`, JSON
  integers): i64 values cross as `BigInt`.
- Event handlers are exported as `_on_pointer_down(cv, x, y)`, `_on_pointer_move`,
  `_on_pointer_up`, `_on_key_down(cv)`, `_on_key_up(cv)` (the key comes from
  `_canvas_event_key`), `_on_exit`, `_on_pause`, `_on_resume`.

## Tests

```bash
# Runtime unit tests (no compiler needed)
node plugins/frame.canvas/runtime/tests/runtime-bridges.test.mjs

# Plugin + runtime end to end (compile scenes with $CLEEN_CLN or
# ~/.cleen/bin/cln and the plugin in this directory)
node plugins/frame.canvas/runtime/tests/scene-runtime.test.mjs
node plugins/frame.canvas/runtime/tests/frame-pipeline.test.mjs   # fps, background, layers, camera
node plugins/frame.canvas/runtime/tests/scene-stack.test.mjs      # change / push / pop, transitions, visibility
node plugins/frame.canvas/runtime/tests/page-bridge.test.mjs      # page.set / page.get with frame.ui's runtime

# Compile-time checks: invalid scenes fail with the CVS rule they break
node plugins/frame.canvas/runtime/tests/scene-diagnostics.test.mjs
```

Each prints one `PASS:` / `FAIL:` line and exits non-zero on failure.
