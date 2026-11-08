/**
 * Clean Canvas Bridge for WebAssembly
 * Version: 2.0.0
 *
 * Provides 130+ bridge functions for game development:
 * - Canvas lifecycle and rendering
 * - Shapes, text, images
 * - Transforms
 * - Animation loop
 * - Audio (sound effects and music)
 * - Sprites and animation
 * - Input (mouse, keyboard, touch, gamepad)
 * - Collision detection
 * - Asset management
 * - Camera system
 * - Gradients and paths
 * - Advanced rendering (blend modes, shadows)
 * - Easing functions
 * - Scene management
 */

// =============================================================================
// FRAME RECORDING
// =============================================================================
// A scene with layers: (CVS-D001..D004), and every scene the scene manager
// composites (scene.push overlays, scene.changeTo transitions), draws into
// recorders instead of the page canvas. A recorder stands in for a
// CanvasRenderingContext2D: method calls and property writes are kept as an
// ordered op list (values already read from WASM memory), and the frame is
// replayed onto the real context once it is complete — layer by layer in z
// order, with the camera transform under each layer.

// 2D-context methods that return a value; they run on the real context.
const RECORDER_IMMEDIATE = new Set([
  'createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern',
  'createImageData', 'getImageData', 'isPointInPath', 'isPointInStroke', 'getLineDash',
  'getContextAttributes',
]);
// Text state measureText depends on.
const RECORDER_TEXT_STATE = ['font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing'];

function createRecorder(target) {
  const ops = [];
  // Property values written so far, with the save/restore stack, so a read
  // (`ctx.globalAlpha *= a`) sees what the replayed context will hold.
  let shadow = {};
  const stack = [];
  const recorder = new Proxy({}, {
    get(_, key) {
      if (key === '__ops') return ops;
      if (key === '__isRecorder') return true;
      if (key === 'canvas') return target.canvas;
      if (key === 'measureText') {
        return (text) => {
          target.save();
          for (const k of RECORDER_TEXT_STATE) if (k in shadow) target[k] = shadow[k];
          const metrics = target.measureText(text);
          target.restore();
          return metrics;
        };
      }
      if (RECORDER_IMMEDIATE.has(key)) return (...args) => target[key](...args);
      if (Object.prototype.hasOwnProperty.call(shadow, key)) return shadow[key];
      const value = target[key];
      if (typeof value === 'function') {
        return (...args) => {
          if (key === 'save') stack.push({ ...shadow });
          else if (key === 'restore') shadow = stack.length ? stack.pop() : {};
          ops.push([key, args]);
        };
      }
      return value;
    },
    set(_, key, value) {
      shadow[key] = value;
      ops.push(['=', key, value]);
      return true;
    },
  });
  return recorder;
}

// 2D affine matrices as [a, b, c, d, e, f] (CanvasRenderingContext2D order).
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// Replay recorded ops onto `ctx` under `matrix` (the transform the ops'
// identity maps to) and `alpha` (multiplies every globalAlpha the ops set).
function replayOps(ops, ctx, matrix, alpha) {
  ctx.save();
  ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  ctx.globalAlpha = alpha;
  for (const op of ops) {
    if (op[0] === '=') {
      ctx[op[1]] = op[1] === 'globalAlpha' ? op[2] * alpha : op[2];
    } else if (op[0] === 'setTransform' || op[0] === 'resetTransform') {
      const a = op[0] === 'resetTransform' ? IDENTITY_MATRIX
        : (op[1].length >= 6 ? op[1] : [op[1][0].a, op[1][0].b, op[1][0].c, op[1][0].d, op[1][0].e, op[1][0].f]);
      const m = multiplyMatrix(matrix, a);
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    } else {
      ctx[op[0]](...op[1]);
    }
  }
  ctx.restore();
}

class CanvasBridge {
  constructor() {
    // ========================================================================
    // CANVAS STATE
    // ========================================================================
    this.canvases = new Map();
    this.nextCanvasId = 1;

    // ========================================================================
    // ANIMATION STATE
    // ========================================================================
    this.animationFrames = new Map();
    this.nextFrameId = 1;
    this.lastFrameTime = performance.now();
    this.startTime = performance.now();
    this.deltaTime = 0;
    this.fps = 60;
    this.frameCount = 0;
    this.fpsLastTime = performance.now();

    // ========================================================================
    // AUDIO STATE
    // ========================================================================
    this.audioContext = null;
    // Name-keyed asset registry (matches function-registry.toml canonical API).
    // Each entry: { src, buffer, bufferPromise, element }. The same entry serves
    // both sound and music play APIs; whichever is called first materializes
    // the corresponding underlying resource.
    this.namedSounds = new Map();
    this.namedMusic = new Map();
    this.musicVolumes = new Map();   // per-track volume by name
    this.currentMusicName = null;
    this.soundInstances = new Map(); // numeric instance id -> playing source
    this.nextInstanceId = 1;
    this.masterVolume = 1.0;
    this.musicVolume = 1.0;
    this.isMuted = false;

    // ========================================================================
    // SPRITE STATE
    // ========================================================================
    this.spriteSheets = new Map();
    this.nextSpriteId = 1;

    // ========================================================================
    // INPUT STATE
    // ========================================================================
    // Mouse
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseButtons = [false, false, false];
    this.mouseButtonsJustPressed = [false, false, false];
    this.mouseButtonsJustReleased = [false, false, false];
    this.mouseWheelX = 0;
    this.mouseWheelY = 0;

    // Keyboard
    this.keysDown = new Set();
    this.keysJustPressed = new Set();
    this.keysJustReleased = new Set();
    this.lastKey = '';
    this.eventKey = '';      // key of the keydown/keyup being dispatched
    this.textInput = '';

    // Touch
    this.touches = [];
    this.touchStarted = false;
    this.touchEnded = false;

    // Gamepad
    this.gamepads = new Map();
    this.gamepadButtonsJustPressed = new Map();

    // ========================================================================
    // ASSET STATE
    // ========================================================================
    this.assets = new Map();
    this.assetQueue = [];
    this.assetsLoaded = 0;
    this.assetsTotal = 0;
    this.imageCache = new Map();

    // ========================================================================
    // CAMERA STATE
    // ========================================================================
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZoom = 1.0;
    this.cameraRotation = 0;
    this.cameraShakeIntensity = 0;
    this.cameraShakeDuration = 0;
    this.cameraShakeStart = 0;
    this.cameraShakeEasing = 0;

    // ========================================================================
    // GRADIENT STATE
    // ========================================================================
    this.gradients = new Map();
    this.nextGradientId = 1;

    // ========================================================================
    // NAMED ASSETS (gradients/paths/layers/tweens/timelines/animstates/animsprites/particles)
    // ========================================================================
    // Each Map below is keyed by the user-supplied name from the DSL block.
    this.namedPaths = new Map();      // name -> [{op, args}]
    this.namedLayers = new Map();     // name -> {z, drawCalls:[]}
    this.layerOrder = [];             // sorted layer names by z (ascending)
    this.currentLayer = null;
    this.namedTweens = new Map();     // name -> {state, vars, elapsed}
    this.namedTimelines = new Map();  // name -> {state, json, time}
    this.namedAnimStates = new Map(); // name -> {state, current, json}
    this.namedAnimSprites = new Map();// name -> {sheetName, frameStart, frameEnd, fps, loop, current, elapsed}
    this.namedParticles = new Map();  // name -> {json, emitters:[]}
    this.namedSprites = new Map();    // name -> sheet entry by user-given name
    this.fontsLoaded = new Map();     // name -> { src, loaded }
    this.customEases = new Map();     // name -> {x1, y1, x2, y2}

    // ========================================================================
    // EVENT HANDLER REGISTRATION (canvas-scoped)
    // ========================================================================
    // Each canvasId maps to an export-name string the WASM module declared.
    this.pointerDownHandlers = new Map();
    this.pointerMoveHandlers = new Map();
    this.pointerUpHandlers = new Map();
    this.keyDownHandlers = new Map();
    this.keyUpHandlers = new Map();

    // ========================================================================
    // PAGE/UI BRIDGE + SCENE PARAMETERS
    // ========================================================================
    this.pageStore = new Map();   // key -> JSON-encoded value (string)
    this.sceneParams = new Map(); // key -> value text (no scene manager)

    // ========================================================================
    // CAMERA FOLLOW STATE
    // ========================================================================
    this.cameraFollowX = null;
    this.cameraFollowY = null;
    this.cameraFollowSmoothing = 0;
    this.cameraOffsetX = 0;
    this.cameraOffsetY = 0;
    this.cameraDeadzoneW = 0;
    this.cameraDeadzoneH = 0;
    this.cameraBounds = null; // {x, y, w, h} or null

    // ========================================================================
    // FRAME LOOP, LAYERS AND SCENES
    // ========================================================================
    // targetFps (canvasScene fps=, CVS-L006) limits how often the frame runs;
    // 0 is the display rate. lastTickTime is the timestamp of the last frame
    // that ran (its dt is measured from there).
    this.targetFps = 0;
    this.lastTickTime = null;
    this.nextFrameDue = 0;
    this.displayInterval = 1000 / 60;
    this.lastRafTime = null;
    this.inTick = false;
    this.frameIndex = 0;
    // Set once a layers: block declares a layer: every frame is recorded and
    // composited in z order (CVS-D001).
    this.layersDeclared = false;
    this.layerSeq = 0;
    // The scene manager (loader.js CleanCanvasScenes) when this bridge runs
    // one scene of a scene stack; it composites the recorded frames itself.
    this.manager = null;
    this.composited = false;
    this.sceneName = '';
    // Only the scene on top of the stack receives input events.
    this.inputActive = true;
    this.listeners = [];
    // Lifecycle exports the scene registered (_canvas_on_exit, ...): kind -> canvas id.
    this.lifecycle = new Map();
    this.cameraFollowInit = false;
    this.cameraFrame = -1;
    this.cameraMatrix = null;
    this.shakeMatrix = null;

    // ========================================================================
    // WASM REFERENCES
    // ========================================================================
    this.memory = null;
    this.wasmInstance = null;
    this.allocate = null;

    // Initialize audio context on first user interaction
    this._initAudioOnInteraction();
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  _initAudioOnInteraction() {
    // No DOM (worker, headless test harness): there is no user interaction
    // to unlock audio with, so the context stays lazily uncreated.
    if (typeof document === 'undefined') return;
    const initAudio = () => {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[CanvasBridge] Audio context initialized');
      }
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
      document.removeEventListener('touchstart', initAudio);
    };
    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
    document.addEventListener('touchstart', initAudio);
  }

  // ==========================================================================
  // MEMORY HELPERS
  // ==========================================================================

  readString(ptr, len) {
    if (!this.memory) return '';
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  }

  // Two calling conventions:
  //   writeString(str, ptr) — raw write at given ptr, returns byte length
  //   writeString(str)      — allocate on the module heap (the allocator
  //                           setWasmInstance received) and write a 4-byte
  //                           LE length prefix followed by the UTF-8 bytes.
  //                           Returns the pointer to the length prefix, the
  //                           format Clean reads when a bridge function
  //                           returns a string.
  writeString(str, ptr) {
    if (!this.memory) return 0;
    const bytes = new TextEncoder().encode(str || '');
    if (ptr === undefined) {
      if (!this.allocate) {
        throw new Error('CanvasBridge: a string return needs the module allocator (setWasmInstance(instance, allocate))');
      }
      const result = this.allocate(4 + bytes.length);
      new DataView(this.memory.buffer).setUint32(result, bytes.length, true);
      new Uint8Array(this.memory.buffer, result + 4, bytes.length).set(bytes);
      return result;
    }
    const view = new Uint8Array(this.memory.buffer, ptr, bytes.length);
    view.set(bytes);
    return bytes.length;
  }

  // ==========================================================================
  // CANVAS HELPERS
  // ==========================================================================

  getCanvas(id) {
    const entry = this.canvases.get(id);
    return entry ? entry.ctx : null;
  }

  getCanvasElement(id) {
    const entry = this.canvases.get(id);
    return entry ? entry.element : null;
  }

  // ==========================================================================
  // INPUT SETUP
  // ==========================================================================

  setupInputHandlers(canvasId, element) {
    const self = this;
    // Listeners are kept so a scene that leaves the stack can detach them;
    // handler exports run only while this scene is on top (inputActive).
    const on = (type, fn) => {
      element.addEventListener(type, fn);
      self.listeners.push([element, type, fn]);
    };

    // Make canvas focusable
    element.setAttribute('tabindex', '0');
    element.style.outline = 'none';

    // ========== MOUSE EVENTS ==========
    on('mousemove', (e) => {
      const rect = element.getBoundingClientRect();
      self.mouseX = e.clientX - rect.left;
      self.mouseY = e.clientY - rect.top;
      const handler = self.pointerMoveHandlers.get(canvasId);
      if (handler && self.inputActive) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    on('mousedown', (e) => {
      const button = e.button;
      if (button < 3) {
        self.mouseButtons[button] = true;
        self.mouseButtonsJustPressed[button] = true;
      }
      element.focus();
      const handler = self.pointerDownHandlers.get(canvasId);
      if (handler && self.inputActive) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    on('mouseup', (e) => {
      const button = e.button;
      if (button < 3) {
        self.mouseButtons[button] = false;
        self.mouseButtonsJustReleased[button] = true;
      }
      const handler = self.pointerUpHandlers.get(canvasId);
      if (handler && self.inputActive) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    on('mouseleave', () => {
      self.mouseButtons = [false, false, false];
    });

    on('wheel', (e) => {
      self.mouseWheelX = e.deltaX;
      self.mouseWheelY = e.deltaY;
    });

    on('contextmenu', (e) => e.preventDefault());

    // ========== KEYBOARD EVENTS ==========
    on('keydown', (e) => {
      const key = e.key;
      if (!self.keysDown.has(key)) {
        self.keysJustPressed.add(key);
      }
      self.keysDown.add(key);
      self.lastKey = key;
      self.eventKey = key;

      // Capture text input for printable characters
      if (key.length === 1) {
        self.textInput += key;
      }

      // Prevent default for game keys
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(key)) {
        e.preventDefault();
      }

      const handler = self.keyDownHandlers.get(canvasId);
      if (handler && self.inputActive) self._callExport(handler, canvasId);
    });

    on('keyup', (e) => {
      const key = e.key;
      self.keysDown.delete(key);
      self.keysJustReleased.add(key);
      self.eventKey = key;

      const handler = self.keyUpHandlers.get(canvasId);
      if (handler && self.inputActive) self._callExport(handler, canvasId);
    });

    // ========== TOUCH EVENTS ==========
    on('touchstart', (e) => {
      e.preventDefault();
      self.touchStarted = true;
      self._updateTouches(e.touches, element);
      // Simulate mouse for primary touch
      if (e.touches.length > 0) {
        const rect = element.getBoundingClientRect();
        self.mouseX = e.touches[0].clientX - rect.left;
        self.mouseY = e.touches[0].clientY - rect.top;
        self.mouseButtons[0] = true;
        self.mouseButtonsJustPressed[0] = true;
      }
    });

    on('touchmove', (e) => {
      e.preventDefault();
      self._updateTouches(e.touches, element);
      if (e.touches.length > 0) {
        const rect = element.getBoundingClientRect();
        self.mouseX = e.touches[0].clientX - rect.left;
        self.mouseY = e.touches[0].clientY - rect.top;
      }
    });

    on('touchend', (e) => {
      e.preventDefault();
      self.touchEnded = true;
      self._updateTouches(e.touches, element);
      if (e.touches.length === 0) {
        self.mouseButtons[0] = false;
        self.mouseButtonsJustReleased[0] = true;
      }
    });

    on('touchcancel', (e) => {
      self.touchEnded = true;
      self._updateTouches(e.touches, element);
      self.mouseButtons[0] = false;
    });

    // ========== GAMEPAD POLLING ==========
    // Gamepads are polled each frame, not event-driven
  }

  // Remove the input listeners this bridge attached (scene leaving the stack).
  detachInput() {
    for (const [element, type, fn] of this.listeners) element.removeEventListener(type, fn);
    this.listeners = [];
  }

  _updateTouches(touchList, element) {
    const rect = element.getBoundingClientRect();
    this.touches = [];
    for (let i = 0; i < touchList.length; i++) {
      const touch = touchList[i];
      this.touches.push({
        id: touch.identifier,
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top
      });
    }
  }

  _pollGamepads() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (gp) {
        const prev = this.gamepads.get(i) || { buttons: [] };
        const justPressed = [];

        for (let b = 0; b < gp.buttons.length; b++) {
          const wasPressed = prev.buttons[b] || false;
          const isPressed = gp.buttons[b].pressed;
          justPressed[b] = isPressed && !wasPressed;
        }

        this.gamepads.set(i, {
          connected: true,
          buttons: gp.buttons.map(b => b.pressed),
          axes: [...gp.axes]
        });
        this.gamepadButtonsJustPressed.set(i, justPressed);
      }
    }
  }

  _clearFrameInputState() {
    // Clear "just pressed/released" states at end of frame
    this.mouseButtonsJustPressed = [false, false, false];
    this.mouseButtonsJustReleased = [false, false, false];
    this.mouseWheelX = 0;
    this.mouseWheelY = 0;
    this.keysJustPressed.clear();
    this.keysJustReleased.clear();
    this.textInput = '';
    this.touchStarted = false;
    this.touchEnded = false;
  }

  // ==========================================================================
  // EASING (numeric ID + named lookup + custom cubic-bezier)
  // ==========================================================================
  // Easing IDs match the order easing functions are documented in plugin.toml
  // and let _tween_animate / _camera_shake / _tween_animate_path use a single
  // integer argument without an extra string round-trip.

  _easeNameToId(name) {
    const t = {
      linear: 0,
      cubic_in: 1, cubic_out: 2, cubic_in_out: 3,
      quad_in: 4, in_quad: 4,
      quad_out: 5, out_quad: 5,
      quad_in_out: 6, in_out_quad: 6,
      sine_in: 7, in_sine: 7,
      sine_out: 8, out_sine: 8,
      sine_in_out: 9, in_out_sine: 9,
      expo_in: 10, in_expo: 10,
      expo_out: 11, out_expo: 11,
      expo_in_out: 12, in_out_expo: 12,
      elastic_in: 13, elastic_out: 14, elastic_in_out: 15, in_out_elastic: 15,
      bounce_in: 16, bounce_out: 17, bounce_in_out: 18, in_out_bounce: 18,
      back_in: 19, back_out: 20, back_in_out: 21,
      // Spec names (frame-canvas.ebnf §28).
      easeInCubic: 1, easeOutCubic: 2, easeInOutCubic: 3,
      easeInQuad: 4, easeOutQuad: 5, easeInOutQuad: 6,
      easeInSine: 7, easeOutSine: 8, easeInOutSine: 9,
      easeInExpo: 10, easeOutExpo: 11, easeInOutExpo: 12,
      easeInElastic: 13, easeOutElastic: 14, easeInOutElastic: 15,
      easeInBounce: 16, easeOutBounce: 17, easeInOutBounce: 18,
      easeInBack: 19, easeOutBack: 20, easeInOutBack: 21,
    };
    return t[name] != null ? t[name] : 0;
  }

  // True when `name` is a built-in easing or a registered customEase.
  _isKnownEase(name) {
    if (!name || name === 'linear' || this.customEases.has(name)) return true;
    return this._easeNameToId(name) !== 0;
  }

  _evalEaseId(id, t) {
    t = Math.max(0, Math.min(1, t));
    switch (id) {
      case 0: return t;
      case 1: return t * t * t;
      case 2: return 1 - Math.pow(1 - t, 3);
      case 3: return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      case 4: return t * t;
      case 5: return 1 - (1 - t) * (1 - t);
      case 6: return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      case 7: return 1 - Math.cos((t * Math.PI) / 2);
      case 8: return Math.sin((t * Math.PI) / 2);
      case 9: return -(Math.cos(Math.PI * t) - 1) / 2;
      case 10: return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
      case 11: return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      case 12: return t === 0 ? 0 : t === 1 ? 1 : t < 0.5
        ? Math.pow(2, 20 * t - 10) / 2
        : (2 - Math.pow(2, -20 * t + 10)) / 2;
      case 13: {
        const c4 = (2 * Math.PI) / 3;
        return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
      }
      case 14: {
        const c4 = (2 * Math.PI) / 3;
        return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
      }
      case 15: {
        const c5 = (2 * Math.PI) / 4.5;
        return t === 0 ? 0 : t === 1 ? 1 : t < 0.5
          ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
      }
      case 16: return 1 - this._evalBounceOut(1 - t);
      case 17: return this._evalBounceOut(t);
      case 18: return t < 0.5
        ? (1 - this._evalBounceOut(1 - 2 * t)) / 2
        : (1 + this._evalBounceOut(2 * t - 1)) / 2;
      case 19: {
        const c1 = 1.70158, c3 = c1 + 1;
        return c3 * t * t * t - c1 * t * t;
      }
      case 20: {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }
      case 21: {
        const c1 = 1.70158, c2 = c1 * 1.525;
        return t < 0.5
          ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
          : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
      }
      default: return t;
    }
  }

  _evalBounceOut(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  }

  _evalEaseByName(name, t) {
    if (!name || name === 'linear') return t;
    if (this.customEases.has(name)) return this._evalCustomEase(name, t);
    return this._evalEaseId(this._easeNameToId(name), t);
  }

  _evalCustomEase(name, t) {
    const cp = this.customEases.get(name);
    if (!cp) return t;
    // Cubic-bezier(0,0, x1,y1, x2,y2, 1,1). Solve x(u)=t for u via bisection,
    // then return y(u). Bisection is fine here — 20 iterations gives ~1e-6.
    const { x1, y1, x2, y2 } = cp;
    const bx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    const by = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < t) lo = mid; else hi = mid;
    }
    return by((lo + hi) / 2);
  }

  // ==========================================================================
  // FRAMES: recording, layers, camera, compositing
  // ==========================================================================

  // True when this bridge records its frames instead of drawing directly.
  _recording() {
    return this.layersDeclared || this.composited;
  }

  // Start recording a fresh frame for `entry`: a base list (canvas.clear),
  // one recorder per layer (the default layer is ''), and an overlay for the
  // particles drawn after draw:.
  _beginFrame(entry) {
    entry.frame = { base: null, layers: new Map(), overlay: null, camera: null };
    entry.ctx = this._layerTarget(entry, this.currentLayer || '');
  }

  _layerTarget(entry, name) {
    let rec = entry.frame.layers.get(name);
    if (!rec) {
      rec = createRecorder(entry.real);
      entry.frame.layers.set(name, rec);
    }
    return rec;
  }

  // Switch every canvas to recording (first layer declared, or composited).
  _ensureRecording() {
    for (const [, entry] of this.canvases) {
      if (!entry.frame) this._beginFrame(entry);
    }
  }

  // Draw order of a layer: [z, declaration order]. The default layer is
  // z=0 ahead of the declared z=0 layers (CVS-D001, CVS-D002); a name no
  // layers: entry declares draws at z=0 after them.
  _layerRank(name) {
    if (name === '') return [0, -1];
    let layer = this.namedLayers.get(name);
    if (!layer) {
      layer = { z: 0, seq: this.layerSeq++, drawCalls: [] };
      this.namedLayers.set(name, layer);
    }
    return [layer.z, layer.seq];
  }

  // Close the frame being recorded: it becomes entry.lastFrame (what the
  // compositor draws) and recording starts over.
  _sealFrame(entry) {
    if (!entry.frame) return;
    entry.lastFrame = entry.frame;
    this._beginFrame(entry);
  }

  // Replay recorded frame `frame` onto `ctx`: the canvas.clear fill, then
  // the layers that received draw calls in ascending z (CVS-D001, CVS-D004),
  // then the particles. `matrix` / `alpha` place the whole frame (scene
  // transitions); the camera transform applies under the layers only.
  _replayFrame(entry, frame, ctx, matrix = IDENTITY_MATRIX, alpha = 1) {
    if (!frame) return;
    if (frame.base) {
      ctx.save();
      ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = frame.base;
      ctx.fillRect(0, 0, entry.width, entry.height);
      ctx.restore();
    }
    const world = frame.camera ? multiplyMatrix(matrix, frame.camera) : matrix;
    const layers = [...frame.layers.entries()]
      .filter(([, rec]) => rec.__ops.length > 0)
      .map(([name, rec]) => [this._layerRank(name), rec])
      .sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]));
    for (const [, rec] of layers) replayOps(rec.__ops, ctx, world, alpha);
    if (frame.overlay && frame.overlay.__ops.length > 0) replayOps(frame.overlay.__ops, ctx, world, alpha);
  }

  // Fill the whole canvas with `color` (canvas.clear). Recording: the fill
  // becomes the frame's base and every layer buffer recorded so far this
  // frame is dropped (CVS-L004). Direct: a fill in screen space, whatever
  // transform (camera, translate) is active.
  _clearCanvas(entry, color) {
    if (this._recording() && entry.frame) {
      entry.frame.layers = new Map();
      entry.frame.overlay = null;
      entry.frame.base = color;
      entry.ctx = this._layerTarget(entry, this.currentLayer || '');
      return;
    }
    const ctx = entry.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, entry.width, entry.height);
    ctx.restore();
  }

  // Camera position update for this frame (once per frame): follow target
  // with deadzone and smoothing, then the bounds clamp. The camera position
  // (cameraX, cameraY) is the world point at the canvas top-left; the view
  // is width / zoom x height / zoom world units.
  _updateCamera(entry) {
    if (this.cameraFrame === this.frameIndex) return;
    this.cameraFrame = this.frameIndex;
    const zoom = this.cameraZoom > 0 ? this.cameraZoom : 1;
    const viewW = entry.width / zoom;
    const viewH = entry.height / zoom;
    if (this.cameraFollowX !== null) {
      const targetX = this.cameraFollowX + this.cameraOffsetX;
      const targetY = this.cameraFollowY + this.cameraOffsetY;
      // Centre the deadzone box on the view centre; the camera moves only
      // by how far the target is outside it.
      const centreX = this.cameraX + viewW / 2;
      const centreY = this.cameraY + viewH / 2;
      const outside = (target, centre, size) => {
        const d = target - centre;
        const half = Math.max(0, size) / 2;
        return Math.abs(d) <= half ? 0 : d - Math.sign(d) * half;
      };
      let wantX, wantY;
      if (!this.cameraFollowInit) {
        // First followed frame: start on the target.
        wantX = targetX - viewW / 2;
        wantY = targetY - viewH / 2;
        this.cameraFollowInit = true;
        this.cameraX = wantX;
        this.cameraY = wantY;
      } else {
        wantX = this.cameraX + outside(targetX, centreX, this.cameraDeadzoneW);
        wantY = this.cameraY + outside(targetY, centreY, this.cameraDeadzoneH);
        // smoothing: 0 snaps, values near 1 follow slowly; the remaining
        // distance keeps `smoothing` of itself per 1/60 s.
        const s = Math.max(0, Math.min(0.999, this.cameraFollowSmoothing));
        const k = s === 0 ? 1 : 1 - Math.pow(s, Math.max(0, this.deltaTime) * 60);
        this.cameraX += (wantX - this.cameraX) * k;
        this.cameraY += (wantY - this.cameraY) * k;
      }
    }
    if (this.cameraBounds) {
      // The whole view stays inside the bounds; a view wider than the
      // bounds is centred on them.
      const b = this.cameraBounds;
      const clamp = (pos, min, size, view) => (size <= view ? min + (size - view) / 2
        : Math.max(min, Math.min(min + size - view, pos)));
      this.cameraX = clamp(this.cameraX, b.x, b.w, viewW);
      this.cameraY = clamp(this.cameraY, b.y, b.h, viewH);
    }
  }

  // The camera transform: world (cameraX, cameraY) at the top-left, scaled
  // by zoom, rotated about the canvas centre, plus the shake offset.
  _cameraTransform(entry) {
    const zoom = this.cameraZoom > 0 ? this.cameraZoom : 1;
    let shakeX = 0, shakeY = 0;
    if (this.cameraShakeDuration > 0) {
      const elapsed = (performance.now() - this.cameraShakeStart) / 1000;
      if (elapsed < this.cameraShakeDuration) {
        const decay = 1 - this._evalEaseId(this.cameraShakeEasing | 0, elapsed / this.cameraShakeDuration);
        shakeX = (Math.random() - 0.5) * 2 * this.cameraShakeIntensity * decay;
        shakeY = (Math.random() - 0.5) * 2 * this.cameraShakeIntensity * decay;
      } else {
        this.cameraShakeDuration = 0;
        this.cameraShakeIntensity = 0;
      }
    }
    let m = [1, 0, 0, 1, shakeX, shakeY];
    if (this.cameraRotation !== 0) {
      const r = this.cameraRotation * Math.PI / 180;
      const cx = entry.width / 2, cy = entry.height / 2;
      m = multiplyMatrix(m, [1, 0, 0, 1, cx, cy]);
      m = multiplyMatrix(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
      m = multiplyMatrix(m, [1, 0, 0, 1, -cx, -cy]);
    }
    m = multiplyMatrix(m, [zoom, 0, 0, zoom, 0, 0]);
    return multiplyMatrix(m, [1, 0, 0, 1, -this.cameraX, -this.cameraY]);
  }

  // True when the frame at `timestamp` should run under fps= (CVS-L006):
  // frames are spaced 1/targetFps apart, give or take half a display frame.
  _frameDue(timestamp) {
    if (this.lastRafTime !== null && timestamp > this.lastRafTime) {
      this.displayInterval = this.displayInterval * 0.9 + (timestamp - this.lastRafTime) * 0.1;
    }
    this.lastRafTime = timestamp;
    if (!(this.targetFps > 0) || this.lastTickTime === null) return true;
    if (timestamp < this.nextFrameDue - this.displayInterval / 2) return false;
    return true;
  }

  // One frame of canvas `canvasId` at `timestamp` (ms): animations, the
  // module's _frame_callback (onFrame:, transitions, camera, draw:), the
  // particles. Returns false when fps= skips this display frame.
  _tick(canvasId, timestamp) {
    if (!this._frameDue(timestamp)) return false;
    const last = this.lastTickTime === null ? this.lastFrameTime : this.lastTickTime;
    this.deltaTime = Math.max(0, Math.min((timestamp - last) / 1000, 0.1));
    this.lastTickTime = timestamp;
    this.lastFrameTime = timestamp;
    if (this.targetFps > 0) {
      const interval = 1000 / this.targetFps;
      this.nextFrameDue = Math.max(this.nextFrameDue + interval, timestamp + interval - this.displayInterval);
    }
    this.frameIndex++;
    this.frameCount++;
    if (timestamp - this.fpsLastTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsLastTime = timestamp;
    }
    if (typeof navigator !== 'undefined') this._pollGamepads();
    this._updateAnimations(this.deltaTime);
    const entry = this.canvases.get(canvasId);
    this.inTick = true;
    try {
      if (this.wasmInstance && this.wasmInstance.exports._frame_callback) {
        this.wasmInstance.exports._frame_callback(canvasId);
      }
      if (entry) {
        if (this._recording() && entry.frame) {
          const saved = entry.ctx;
          entry.frame.overlay = createRecorder(entry.real);
          entry.ctx = entry.frame.overlay;
          this._drawParticles(canvasId);
          entry.ctx = saved;
        } else {
          this._drawParticles(canvasId);
        }
      }
    } catch (err) {
      console.error('[CanvasBridge] Frame callback error:', err);
    } finally {
      this.inTick = false;
    }
    if (entry && this._recording()) {
      this._sealFrame(entry);
      if (!this.composited) this._replayFrame(entry, entry.lastFrame, entry.real);
    }
    this._clearFrameInputState();
    return true;
  }

  // Hand a scene.change / changeTo / push / pop request to the scene
  // manager. Without one (a bridge used on its own) there is no other scene
  // to run: the request is refused.
  _sceneRequest(request) {
    if (!this.manager) {
      console.error(`[CanvasBridge] scene.${request.op}${request.name ? ` "${request.name}"` : ''}: no scene manager — load scenes with CleanCanvas.load()`);
      return -1;
    }
    return this.manager.request(this, request);
  }

  _sceneParams() {
    return this.manager ? this.manager.params : this.sceneParams;
  }

  // Run a lifecycle export the scene registered: 'exit', 'pause', 'resume'.
  _fireLifecycle(kind) {
    if (!this.lifecycle.has(kind)) return;
    this._callExport(`_on_${kind}`, this.lifecycle.get(kind));
  }

  // The page store page.set / page.get share with the HTML layer: frame.ui's
  // state store (ui.getState / ui.setState) once its runtime publishes it as
  // window.__cleanRuntime.pageState; this bridge's own map until then
  // (values written before are carried over).
  _pageStore() {
    const rt = typeof window !== 'undefined' ? window.__cleanRuntime : null;
    if (rt && rt.pageState instanceof Map && rt.pageState !== this.pageStore) {
      for (const [k, v] of this.pageStore) if (!rt.pageState.has(k)) rt.pageState.set(k, v);
      this.pageStore = rt.pageState;
    }
    return this.pageStore;
  }

  // ==========================================================================
  // WASM EXPORT CALLBACK
  // ==========================================================================
  // Bridge functions that register handlers store the export name as a string.
  // When the event fires, this helper resolves and calls the export safely.

  _callExport(exportName, ...args) {
    if (!this.wasmInstance || !exportName) return;
    const fn = this.wasmInstance.exports[exportName];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[CanvasBridge] Export "${exportName}" threw:`, err);
    }
  }

  // ==========================================================================
  // PER-FRAME ANIMATION TICK
  // ==========================================================================
  // Advances tweens, timelines, animsprites, particles each frame. Hooked into
  // the requestAnimationFrame loop just before the WASM _frame_callback so
  // Clean code reading from canvasVars sees the updated values.

  _updateAnimations(dt) {
    if (!this.canvasVars) this.canvasVars = new Map();

    // ---- Tweens ----
    for (const [, tween] of this.namedTweens) {
      if (tween.state !== 'playing') continue;
      tween.elapsed += dt;
      let allDone = true;
      for (const v of tween.vars) {
        if (v.done && !v.repeat) continue;
        // delay phase
        let local = tween.elapsed - v.delay;
        if (local < 0) { allDone = false; continue; }
        let cycle = v.duration > 0 ? local / v.duration : 1;
        let direction = 1;
        if (v.repeat > 0 || v.repeat === -1) {
          const intCycle = Math.floor(cycle);
          const frac = cycle - intCycle;
          if (v.repeat !== -1 && intCycle > v.repeat) {
            // repeat=N plays N+1 times (CVS-A010); the last play is number
            // N, which with yoyo runs backwards when N is odd and so ends
            // at `from`.
            cycle = 1; v.done = true;
            if (v.yoyo && (v.repeat % 2 === 1)) direction = -1;
          } else {
            cycle = frac;
            if (v.yoyo && (intCycle % 2 === 1)) direction = -1;
          }
        } else if (cycle >= 1) {
          cycle = 1; v.done = true;
        }
        const tt = direction === 1 ? cycle : 1 - cycle;
        const eased = this._evalEaseByName(v.ease, tt);
        let value;
        if (v.pathName) {
          // Path tween (CVS-A011): the variable lines are the X and Y
          // variables, in that order; with orient = true the plugin adds the
          // companion angle variable as a third line (CVS-A012), set to the
          // travel direction in degrees, the unit of canvas.rotate (CVS-C002).
          if (!this.namedPaths.has(v.pathName)) {
            if (!v.missingPathReported) {
              console.error(`[CanvasBridge] tween along= names path "${v.pathName}", which is not declared (CVS-X006)`);
              v.missingPathReported = true;
            }
            if (!v.done) allDone = false;
            continue;
          }
          const pt = this._sampleNamedPath(v.pathName, eased);
          value = v.pathAxis === 0 ? pt.x : v.pathAxis === 1 ? pt.y : pt.angle * 180 / Math.PI;
        } else {
          // A NaN `from` means the tween omitted from= (CVS-A009): start
          // from the variable's value at play time, captured in _tween_play.
          const from = Number.isNaN(v.from) ? v.start : v.from;
          value = from + (v.to - from) * eased;
        }
        this.canvasVars.set(v.varName, value);
        if (!v.done) allDone = false;
      }
      if (allDone) tween.state = 'stopped';
    }

    // ---- Timelines ----
    for (const [, tl] of this.namedTimelines) {
      if (tl.state !== 'playing') continue;
      tl.time += dt;
      if (tl.config && Array.isArray(tl.config.steps)) {
        for (const step of tl.config.steps) {
          if (!step._fired && tl.time >= (step.at || 0)) {
            step._fired = true;
            if (step.set !== undefined && step.var != null) this.canvasVars.set(step.var, step.set);
            if (step.animate) this._animateVar(step.animate);
            if (step.play) {
              const target = this.namedTweens.get(step.play);
              if (target) { target.state = 'playing'; target.elapsed = 0; target.vars.forEach(x => { x.done = false; x.start = this.canvasVars.has(x.varName) ? this.canvasVars.get(x.varName) : 0; }); }
            }
          }
        }
      }
      if (tl.config && tl.time >= (tl.config.duration || 0)) {
        tl.state = 'stopped';
      }
    }

    // ---- AnimSprite clips ----
    for (const [, clip] of this.namedAnimSprites) {
      clip.elapsed += dt;
      const period = clip.fps > 0 ? 1 / clip.fps : 0.1;
      while (clip.elapsed >= period) {
        clip.elapsed -= period;
        clip.current++;
        if (clip.current > clip.frameEnd) {
          if (clip.loop) clip.current = clip.frameStart;
          else { clip.current = clip.frameEnd; clip.elapsed = 0; clip.finished = true; break; }
        }
      }
    }

    // ---- AnimState onComplete transitions (CVS-A004) ----
    // config.clips maps a state to the animSprite clip it plays;
    // config.onComplete maps a state to the state entered when that
    // non-looping clip finishes.
    for (const [, fsm] of this.namedAnimStates) {
      if (fsm.state !== 'running' || !fsm.config.onComplete) continue;
      const next = fsm.config.onComplete[fsm.current];
      if (!next) continue;
      const clip = this.namedAnimSprites.get(this._animStateClip(fsm));
      if (clip && clip.finished) {
        fsm.current = next;
        const nextClip = this.namedAnimSprites.get(this._animStateClip(fsm));
        if (nextClip) { nextClip.current = nextClip.frameStart; nextClip.elapsed = 0; nextClip.finished = false; }
      }
    }

    // ---- Particles ----
    for (const [, sys] of this.namedParticles) {
      for (let i = sys.emitters.length - 1; i >= 0; i--) {
        const em = sys.emitters[i];
        // age existing particles
        for (let j = em.particles.length - 1; j >= 0; j--) {
          const p = em.particles[j];
          p.life -= dt;
          if (p.life <= 0) { em.particles.splice(j, 1); continue; }
          const cfg = sys.config;
          p.vx += (cfg.windX || 0) * dt;
          p.vy += ((cfg.gravity || 0) + (cfg.windY || 0)) * dt;
          if (cfg.attractorStrength) {
            // Pull toward (attractorX, attractorY); negative strength repels (CVS-P010).
            const ax = (cfg.attractorX || 0) - p.x;
            const ay = (cfg.attractorY || 0) - p.y;
            const d = Math.hypot(ax, ay) || 1;
            p.vx += (ax / d) * cfg.attractorStrength * dt;
            p.vy += (ay / d) * cfg.attractorStrength * dt;
          }
          if (cfg.turbulenceStrength) {
            // Random jitter; turbulenceScale (default 1) widens or narrows it.
            const k = cfg.turbulenceStrength * (cfg.turbulenceScale || 1) * dt;
            p.vx += (Math.random() - 0.5) * 2 * k;
            p.vy += (Math.random() - 0.5) * 2 * k;
          }
          // drag is a per-frame velocity multiplier (CVS-P009).
          if (sys.config.drag != null) { p.vx *= sys.config.drag; p.vy *= sys.config.drag; }
          // overLifetime speed: a multiplier ramped from speedStart to speedEnd.
          const k = p.maxLife > 0 ? 1 - p.life / p.maxLife : 1;
          const s0 = cfg.speedStart != null ? cfg.speedStart : 1;
          const s1 = cfg.speedEnd != null ? cfg.speedEnd : 1;
          const m = s0 + (s1 - s0) * k;
          p.x += p.vx * m * dt;
          p.y += p.vy * m * dt;
        }
        // continuous emission
        if (em.continuous) {
          em.emitAccum += dt * (sys.config.rate || 30);
          while (em.emitAccum >= 1) {
            em.emitAccum -= 1;
            em.particles.push(this._spawnParticle(em.x, em.y, sys.config));
          }
        }
        // remove finished one-shot emitters
        if (!em.continuous && em.particles.length === 0) sys.emitters.splice(i, 1);
      }
    }
  }

  // Inline animation of one variable (`animate v [from=] to= duration= ...`):
  // an anonymous tween keyed by the variable, so a new animate replaces it.
  // `from` omitted starts at the variable's current value.
  _animateVar({ varName, from, to, duration, ease, delay, repeat, yoyo }) {
    if (!this.canvasVars) this.canvasVars = new Map();
    const start = from != null ? from : (this.canvasVars.has(varName) ? this.canvasVars.get(varName) : 0);
    this.namedTweens.set('__inline__' + varName, {
      state: 'playing', elapsed: 0,
      vars: [{
        varName, from: start, start, to, duration: duration || 0,
        ease: ease || 'linear',
        repeat: repeat | 0, yoyo: !!yoyo, delay: delay || 0,
        pathName: null, pathAxis: -1, done: false,
      }],
    });
  }

  // Clip played by an animState's current state: the state's
  // `play animSprite "clip"` line, else a clip named like the state.
  _animStateClip(fsm) {
    const clips = fsm.config && fsm.config.clips;
    return (clips && clips[fsm.current]) || fsm.current || '';
  }

  // Particle config keys (built by the plugin from a `particles` block):
  // lifeMin/lifeMax, speedMin/speedMax, angleMin/angleMax (degrees,
  // 0 = right, -90 = up), sizeMin/sizeMax (diameter), color, shape, rate,
  // burst, gravity, drag, windX/windY, attractorX/attractorY/attractorStrength,
  // turbulenceStrength/turbulenceScale,
  // emitterShape ("point", "circle", "rect"; the shape string may carry
  // `radius=` / `w=` / `h=`) with emitterRadius / emitterWidth / emitterHeight,
  // alphaStart/alphaEnd, sizeStart/sizeEnd, speedStart/speedEnd
  // (multipliers), colorStart/colorEnd (hex colours) — overLifetime ramps.
  _spawnParticle(x, y, cfg) {
    [x, y] = this._spawnPoint(x, y, cfg);
    const pick = (min, max, dflt) => {
      const lo = cfg[min] != null ? cfg[min] : dflt[0];
      const hi = cfg[max] != null ? cfg[max] : (cfg[min] != null ? lo : dflt[1]);
      return lo + Math.random() * (hi - lo);
    };
    const speed = pick('speedMin', 'speedMax', [50, 150]);
    const angle = pick('angleMin', 'angleMax', [0, 360]) * Math.PI / 180;
    const life = pick('lifeMin', 'lifeMax', [0.5, 1.5]);
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      size: pick('sizeMin', 'sizeMax', [2, 5]),
      color: cfg.color || '#fff',
    };
  }

  // Spawn position inside the emitter area around (x, y).
  _spawnPoint(x, y, cfg) {
    const words = String(cfg.emitterShape || 'point').trim().split(/\s+/);
    const opts = {};
    for (const w of words.slice(1)) {
      const eq = w.indexOf('=');
      if (eq > 0) opts[w.slice(0, eq)] = Number(w.slice(eq + 1));
    }
    if (words[0] === 'circle') {
      const r = opts.radius != null ? opts.radius : (cfg.emitterRadius || 0);
      const a = Math.random() * Math.PI * 2;
      const d = r * Math.sqrt(Math.random());
      return [x + Math.cos(a) * d, y + Math.sin(a) * d];
    }
    if (words[0] === 'rect') {
      const w = opts.w != null ? opts.w : (cfg.emitterWidth || 0);
      const h = opts.h != null ? opts.h : (cfg.emitterHeight || 0);
      return [x + (Math.random() - 0.5) * w, y + (Math.random() - 0.5) * h];
    }
    return [x, y];
  }

  // Colour between two hex colours (#rgb or #rrggbb) at k in 0..1; `a`
  // unchanged when either is not a hex colour.
  _lerpColor(a, b, k) {
    const parse = (c) => {
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
      if (!m) return null;
      const h = m[1].length === 3 ? m[1].split('').map((d) => d + d).join('') : m[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    };
    const ca = parse(a), cb = parse(b);
    if (!ca || !cb) return a;
    const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * k));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  }

  // `canvas.image src=` names an `image` asset (CVS-D009); a src that is
  // not a declared asset is loaded as a path and cached.
  _resolveImage(src) {
    if (this.namedImages && this.namedImages.has(src)) return this.namedImages.get(src);
    if (!this.imageCache) this.imageCache = new Map();
    let img = this.imageCache.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      this.imageCache.set(src, img);
    }
    return img;
  }

  // Width/height omitted by the DSL arrive as 0: draw at the natural size.
  _imageSize(img, width, height) {
    return [width > 0 ? width : img.naturalWidth, height > 0 ? height : img.naturalHeight];
  }

  // Render every live particle onto the canvas after the frame's draw:.
  _drawParticles(canvasId) {
    const entry = this.canvases.get(canvasId);
    if (!entry) return;
    const ctx = entry.ctx;
    // Particles live in world space: drawn directly, they take this frame's
    // camera (a recorded overlay is replayed under it instead).
    const camera = !ctx.__isRecorder && entry.lastCamera && this.cameraFrame === this.frameIndex ? entry.lastCamera : null;
    if (camera) {
      ctx.save();
      ctx.transform(camera[0], camera[1], camera[2], camera[3], camera[4], camera[5]);
    }
    this._drawParticleSystems(ctx);
    if (camera) ctx.restore();
  }

  _drawParticleSystems(ctx) {
    for (const [, sys] of this.namedParticles) {
      const cfg = sys.config;
      const a0 = cfg.alphaStart != null ? cfg.alphaStart : 1;
      const a1 = cfg.alphaEnd != null ? cfg.alphaEnd : 1;
      const s0 = cfg.sizeStart != null ? cfg.sizeStart : 1;
      const s1 = cfg.sizeEnd != null ? cfg.sizeEnd : 1;
      for (const em of sys.emitters) {
        for (const p of em.particles) {
          const k = p.maxLife > 0 ? 1 - p.life / p.maxLife : 1;
          const size = p.size * (s0 + (s1 - s0) * k);
          ctx.save();
          ctx.globalAlpha *= Math.max(0, Math.min(1, a0 + (a1 - a0) * k));
          ctx.fillStyle = cfg.colorStart != null && cfg.colorEnd != null
            ? this._lerpColor(cfg.colorStart, cfg.colorEnd, k) : p.color;
          if (cfg.shape === 'rect') {
            ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
          } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }
  }

  _buildCanvasGradient(ctx, gradName) {
    const grad = this.gradients.get(gradName);
    if (!grad) return null;
    let fill;
    if (grad.type === 'linear') {
      fill = ctx.createLinearGradient(grad.x1, grad.y1, grad.x2, grad.y2);
    } else {
      fill = ctx.createRadialGradient(grad.cx, grad.cy, 0, grad.cx, grad.cy, grad.radius);
    }
    for (const s of grad.stops) fill.addColorStop(s.offset, s.color);
    return fill;
  }

  _replayPathSegments(ctx, segs) {
    for (const s of segs) {
      switch (s.op) {
        case 'move':  ctx.moveTo(s.x, s.y); break;
        case 'line':  ctx.lineTo(s.x, s.y); break;
        case 'curve': ctx.quadraticCurveTo(s.cpx, s.cpy, s.x, s.y); break;
        case 'cubic': ctx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x, s.y); break;
        case 'arc':   ctx.arc(s.x, s.y, s.radius, s.startAngle, s.endAngle); break;
        case 'close': ctx.closePath(); break;
      }
    }
  }

  _easeIdToName(id) {
    const names = [
      'linear', 'cubic_in', 'cubic_out', 'cubic_in_out',
      'quad_in', 'quad_out', 'quad_in_out',
      'sine_in', 'sine_out', 'sine_in_out',
      'expo_in', 'expo_out', 'expo_in_out',
      'elastic_in', 'elastic_out', 'elastic_in_out',
      'bounce_in', 'bounce_out', 'bounce_in_out',
      'back_in', 'back_out', 'back_in_out',
    ];
    return names[id] || 'linear';
  }

  // Polyline of a named path: every curve and arc flattened into short
  // straight pieces, in drawing order. Each point records whether the pen
  // was down on the way to it (a moveTo lifts it), so sampling skips jumps.
  // Segments follow _replayPathSegments: `curve` is quadratic, `cubic` is
  // cubic, `arc` is CanvasRenderingContext2D.arc (x, y = centre, angles in
  // radians, clockwise on screen) — the pen draws a line to the arc start.
  _flattenNamedPath(segs) {
    const pts = [];
    let cx = 0, cy = 0;          // current pen position
    let sx = 0, sy = 0;          // start of the current sub-path
    let started = false;
    const STEPS = 32;
    const lineTo = (x, y) => {
      if (!started) { pts.push({ x, y, pen: false }); sx = x; sy = y; started = true; }
      else pts.push({ x, y, pen: true });
      cx = x; cy = y;
    };
    for (const seg of segs) {
      switch (seg.op) {
        case 'move':
          pts.push({ x: seg.x, y: seg.y, pen: false });
          cx = sx = seg.x; cy = sy = seg.y; started = true;
          break;
        case 'line':
          lineTo(seg.x, seg.y);
          break;
        case 'curve': {
          const x0 = cx, y0 = cy;
          if (!started) lineTo(seg.cpx, seg.cpy);
          for (let i = 1; i <= STEPS; i++) {
            const u = i / STEPS, m = 1 - u;
            lineTo(m * m * x0 + 2 * m * u * seg.cpx + u * u * seg.x,
                   m * m * y0 + 2 * m * u * seg.cpy + u * u * seg.y);
          }
          break;
        }
        case 'cubic': {
          const x0 = cx, y0 = cy;
          if (!started) lineTo(seg.cp1x, seg.cp1y);
          for (let i = 1; i <= STEPS; i++) {
            const u = i / STEPS, m = 1 - u;
            lineTo(m * m * m * x0 + 3 * m * m * u * seg.cp1x + 3 * m * u * u * seg.cp2x + u * u * u * seg.x,
                   m * m * m * y0 + 3 * m * m * u * seg.cp1y + 3 * m * u * u * seg.cp2y + u * u * u * seg.y);
          }
          break;
        }
        case 'arc': {
          const TAU = Math.PI * 2;
          let sweep = seg.endAngle - seg.startAngle;
          sweep = sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU;
          const n = Math.max(1, Math.ceil(sweep / (Math.PI / 32)));
          for (let i = 0; i <= n; i++) {
            const a = seg.startAngle + sweep * (i / n);
            lineTo(seg.x + seg.radius * Math.cos(a), seg.y + seg.radius * Math.sin(a));
          }
          break;
        }
        case 'close':
          if (started) { pts.push({ x: sx, y: sy, pen: true }); cx = sx; cy = sy; }
          break;
      }
    }
    return pts;
  }

  // Point at fraction t (0..1) of the drawn length of a named path, with
  // the travel direction there (radians, atan2 on screen axes).
  _sampleNamedPath(name, t) {
    const path = this.namedPaths.get(name);
    if (!path || !path.length) return { x: 0, y: 0, angle: 0 };
    const pts = this._flattenNamedPath(path);
    if (!pts.length) return { x: 0, y: 0, angle: 0 };
    const lens = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].pen ? Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) : 0;
      lens.push(d); total += d;
    }
    if (total === 0) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    let target = Math.max(0, Math.min(1, t)) * total;
    let last = 1;
    for (let i = 1; i < pts.length; i++) {
      if (lens[i] === 0) continue;
      last = i;
      if (target <= lens[i]) {
        const f = target / lens[i];
        return {
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
          angle: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x),
        };
      }
      target -= lens[i];
    }
    return {
      x: pts[last].x, y: pts[last].y,
      angle: Math.atan2(pts[last].y - pts[last - 1].y, pts[last].x - pts[last - 1].x),
    };
  }

  // ==========================================================================
  // GET IMPORTS - Returns all bridge functions
  // ==========================================================================

  getImports(memory) {
    this.memory = memory;
    const self = this;

    return {
      env: {
        // ====================================================================
        // CANVAS LIFECYCLE
        // ====================================================================

        _canvas_init(width, height, elementIdPtr, elementIdLen) {
          const id = self.nextCanvasId++;
          // CVS-I001: the scene id names the page's <canvas id="..."> element.
          // Bind to it when present; otherwise create the element with that id.
          const elementId = self.readString(elementIdPtr, elementIdLen);
          const existing = elementId ? document.getElementById(elementId) : null;
          const isCanvas = existing && existing.tagName === 'CANVAS';
          const canvas = isCanvas ? existing : document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.id = elementId || `clean-canvas-${id}`;
          if (!isCanvas) canvas.style.display = 'block';

          const ctx = canvas.getContext('2d');

          // `ctx` is where the draw bridges draw: the page context, or the
          // recorder of the current layer while frames are recorded.
          self.canvases.set(id, {
            element: canvas,
            ctx: ctx,
            real: ctx,
            width: width,
            height: height,
            created: !isCanvas,
            frame: null,
            lastFrame: null,
            lastCamera: null,
          });
          if (self._recording()) self._beginFrame(self.canvases.get(id));
          if (self.manager) self.manager.canvasCreated(self, id);

          self.setupInputHandlers(id, canvas);

          if (!isCanvas) {
            const container = document.getElementById('canvas-container') || document.body;
            container.appendChild(canvas);
          }

          console.log(`[CanvasBridge] Canvas ${id} created: ${width}x${height}`);
          return id;
        },

        // canvas.clear: the whole canvas, in the default colour black
        // (CVS-L003). The plugin passes the scene's background= colour to
        // _canvas_clear_color when the scene declares one.
        _canvas_clear(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          self._clearCanvas(entry, 'black');
          return 0;
        },

        _canvas_clear_color(canvasId, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          self._clearCanvas(entry, self.readString(colorPtr, colorLen) || 'black');
          return 0;
        },

        // End of the frame's drawing (the plugin calls it last in
        // _frame_callback). A recorded frame is composited now when nothing
        // else will do it: the frame loop composites after the particles, the
        // scene manager after every scene of the stack has drawn.
        _canvas_present(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          if (!self._recording() || self.inTick || self.composited) return 0;
          self._sealFrame(entry);
          self._replayFrame(entry, entry.lastFrame, entry.real);
          return 0;
        },

        _canvas_resize(canvasId, width, height) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.element.width = width;
          entry.element.height = height;
          entry.width = width;
          entry.height = height;
          return 0;
        },

        _canvas_get_width(canvasId) {
          const entry = self.canvases.get(canvasId);
          return entry ? entry.width : 0;
        },

        _canvas_get_height(canvasId) {
          const entry = self.canvases.get(canvasId);
          return entry ? entry.height : 0;
        },

        // ====================================================================
        // BASIC SHAPES
        // ====================================================================

        _canvas_circle_outline(canvasId, x, y, radius, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.stroke();
          return 0;
        },

        _canvas_circle_filled(canvasId, x, y, radius, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          return 0;
        },

        _canvas_rect_outline(canvasId, x, y, width, height, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.strokeStyle = color;
          entry.ctx.strokeRect(x, y, width, height);
          return 0;
        },

        _canvas_rect_filled(canvasId, x, y, width, height, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.fillStyle = color;
          entry.ctx.fillRect(x, y, width, height);
          return 0;
        },

        _canvas_rect_rounded(canvasId, x, y, width, height, radius, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.roundRect(x, y, width, height, radius);
          ctx.strokeStyle = color;
          ctx.stroke();
          return 0;
        },

        _canvas_line(canvasId, x1, y1, x2, y2, strokeWidth, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
          return 0;
        },

        _canvas_ellipse_outline(canvasId, x, y, radiusX, radiusY, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.stroke();
          return 0;
        },

        _canvas_ellipse_filled(canvasId, x, y, radiusX, radiusY, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          return 0;
        },

        _canvas_triangle_outline(canvasId, x1, y1, x2, y2, x3, y3, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x3, y3);
          ctx.closePath();
          ctx.strokeStyle = color;
          ctx.stroke();
          return 0;
        },

        _canvas_triangle_filled(canvasId, x1, y1, x2, y2, x3, y3, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x3, y3);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          return 0;
        },

        // ====================================================================
        // TEXT RENDERING
        // ====================================================================

        _canvas_text(canvasId, textPtr, textLen, x, y, size, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const text = self.readString(textPtr, textLen);
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.font = `${size}px sans-serif`;
          ctx.fillStyle = color;
          ctx.fillText(text, x, y);
          return 0;
        },

        // Registry params: canvas_id, text, font, x, y, color, align, baseline.
        // `font` is a CSS font shorthand ("24px pixel") — the DSL folds the
        // size= attribute into it; a bare family name draws at 16px.
        _canvas_text_font(canvasId, textPtr, textLen, fontPtr, fontLen, x, y, colorPtr, colorLen, alignPtr, alignLen, baselinePtr, baselineLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const text = self.readString(textPtr, textLen);
          const font = self.readString(fontPtr, fontLen);
          const color = self.readString(colorPtr, colorLen);
          const align = self.readString(alignPtr, alignLen);
          const baseline = self.readString(baselinePtr, baselineLen);
          const ctx = entry.ctx;
          ctx.save();
          ctx.font = /\d(px|pt|em|rem)\b/.test(font) ? font : `16px ${font || 'sans-serif'}`;
          ctx.fillStyle = color || '#000';
          ctx.textAlign = align || 'start';
          ctx.textBaseline = baseline || 'alphabetic';
          ctx.fillText(text, x, y);
          ctx.restore();
          return 0;
        },

        // ====================================================================
        // IMAGES
        // ====================================================================

        _canvas_image(canvasId, srcPtr, srcLen, x, y, width, height) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const img = self._resolveImage(self.readString(srcPtr, srcLen));
          const draw = () => {
            const [w, h] = self._imageSize(img, width, height);
            entry.ctx.drawImage(img, x, y, w, h);
          };
          if (img.complete && img.naturalWidth > 0) {
            draw();
          } else {
            img.addEventListener('load', draw, { once: true });
          }
          return 0;
        },

        _canvas_image_cropped(canvasId, imageId, sx, sy, sw, sh, dx, dy, dw, dh) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const asset = self.assets.get(imageId);
          if (!asset || !asset.image) return -1;
          entry.ctx.drawImage(asset.image, sx, sy, sw, sh, dx, dy, dw, dh);
          return 0;
        },

        _canvas_image_rotated(canvasId, imageId, x, y, width, height, angle) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const asset = self.assets.get(imageId);
          if (!asset || !asset.image) return -1;

          const ctx = entry.ctx;
          ctx.save();
          ctx.translate(x + width / 2, y + height / 2);
          ctx.rotate(angle * Math.PI / 180);
          ctx.drawImage(asset.image, -width / 2, -height / 2, width, height);
          ctx.restore();
          return 0;
        },

        // ====================================================================
        // TRANSFORMS
        // ====================================================================

        _canvas_save(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.save();
          return 0;
        },

        _canvas_restore(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_translate(canvasId, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.translate(x, y);
          return 0;
        },

        _canvas_rotate(canvasId, angleDegrees) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.rotate(angleDegrees * Math.PI / 180);
          return 0;
        },

        _canvas_scale(canvasId, sx, sy) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.scale(sx, sy);
          return 0;
        },

        _canvas_transform(canvasId, a, b, c, d, e, f) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.transform(a, b, c, d, e, f);
          return 0;
        },

        _canvas_reset_transform(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.resetTransform();
          return 0;
        },

        // ====================================================================
        // SCOPED DRAWING STATE (alpha, blend, blur, glow, group, clip)
        // ====================================================================
        // Each `_begin` pushes a Canvas2D save() so the matching `_end` can
        // restore() and leave the surrounding ctx state untouched. Begin/end
        // pairs may nest because Canvas2D's save/restore stack already does.

        _canvas_alpha_begin(canvasId, alpha) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.save();
          entry.ctx.globalAlpha *= alpha;
          return 0;
        },

        _canvas_alpha_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_blend_begin(canvasId, modePtr, modeLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const mode = self.readString(modePtr, modeLen);
          entry.ctx.save();
          entry.ctx.globalCompositeOperation = mode || 'source-over';
          return 0;
        },

        _canvas_blend_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_blur_begin(canvasId, radius) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.save();
          entry.ctx.filter = `blur(${radius}px)`;
          return 0;
        },

        _canvas_blur_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_glow_begin(canvasId, colorPtr, colorLen, radius) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.save();
          entry.ctx.shadowColor = color || 'rgba(255,255,255,0.5)';
          entry.ctx.shadowBlur = radius;
          entry.ctx.shadowOffsetX = 0;
          entry.ctx.shadowOffsetY = 0;
          return 0;
        },

        _canvas_glow_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_group_begin(canvasId, x, y, rotationDegrees, scaleX, scaleY, alpha) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const ctx = entry.ctx;
          ctx.save();
          if (x !== 0 || y !== 0) ctx.translate(x, y);
          if (rotationDegrees !== 0) ctx.rotate(rotationDegrees * Math.PI / 180);
          if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
          if (alpha !== 1) ctx.globalAlpha *= alpha;
          return 0;
        },

        _canvas_group_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _canvas_clip_rect(canvasId, x, y, width, height) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const ctx = entry.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, width, height);
          ctx.clip();
          return 0;
        },

        _canvas_clip_circle(canvasId, x, y, radius) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const ctx = entry.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.clip();
          return 0;
        },

        _canvas_clip_path(canvasId, namePtr, nameLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const name = self.readString(namePtr, nameLen);
          const segs = self.namedPaths.get(name);
          const ctx = entry.ctx;
          // The save pairs with _canvas_clip_end. The clip path always starts
          // empty, so an unknown name masks everything instead of clipping to
          // whatever path was drawn last.
          ctx.save();
          ctx.beginPath();
          if (!segs) {
            console.error(`[CanvasBridge] canvas.clip path="${name}": no such path is declared (CVS-X006)`);
            ctx.clip();
            return -1;
          }
          self._replayPathSegments(ctx, segs);
          ctx.clip();
          return 0;
        },

        _canvas_clip_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        // ====================================================================
        // IMMEDIATE-MODE PATH API
        // ====================================================================
        // Each canvas's current path is the Canvas2D context's own internal
        // path. _canvas_begin_path resets it; the move/line/curve/cubic/arc
        // calls extend it; _canvas_fill_path / _canvas_fill_path_gradient
        // fill it and _canvas_stroke_path strokes it (canvas.fill /
        // canvas.stroke, spec §6.10).

        _canvas_begin_path(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.beginPath();
          return 0;
        },

        _canvas_move_to(canvasId, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.moveTo(x, y);
          return 0;
        },

        _canvas_line_to(canvasId, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.lineTo(x, y);
          return 0;
        },

        _canvas_curve_to(canvasId, cpx, cpy, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.quadraticCurveTo(cpx, cpy, x, y);
          return 0;
        },

        _canvas_cubic_to(canvasId, cp1x, cp1y, cp2x, cp2y, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
          return 0;
        },

        _canvas_arc(canvasId, x, y, radius, startAngle, endAngle) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.arc(x, y, radius, startAngle, endAngle);
          return 0;
        },

        _canvas_arc_to(canvasId, x1, y1, x2, y2, radius) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.arcTo(x1, y1, x2, y2, radius);
          return 0;
        },

        _canvas_close_path(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.closePath();
          return 0;
        },

        _canvas_fill_path(canvasId, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.fillStyle = color || '#000';
          entry.ctx.fill();
          return 0;
        },

        _canvas_stroke_path(canvasId, colorPtr, colorLen, lineWidth) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.strokeStyle = color || '#000';
          entry.ctx.lineWidth = lineWidth;
          entry.ctx.stroke();
          return 0;
        },

        // ====================================================================
        // SHADOW (drop-shadow with offset; distinct from _canvas_glow which
        // is symmetric around the source)
        // ====================================================================

        _canvas_shadow_begin(canvasId, blur, offsetX, offsetY, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.save();
          entry.ctx.shadowColor = color || 'rgba(0,0,0,0.5)';
          entry.ctx.shadowBlur = blur;
          entry.ctx.shadowOffsetX = offsetX;
          entry.ctx.shadowOffsetY = offsetY;
          return 0;
        },

        _canvas_shadow_end(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        // ====================================================================
        // TEXT (aligned + measure)
        // ====================================================================

        _canvas_text_aligned(canvasId, textPtr, textLen, x, y, size, colorPtr, colorLen, alignPtr, alignLen, baselinePtr, baselineLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const text = self.readString(textPtr, textLen);
          const color = self.readString(colorPtr, colorLen);
          const baseline = self.readString(baselinePtr, baselineLen);
          const align = self.readString(alignPtr, alignLen);
          const ctx = entry.ctx;
          ctx.save();
          ctx.font = `${size}px sans-serif`;
          ctx.fillStyle = color || '#000';
          ctx.textBaseline = baseline || 'alphabetic';
          ctx.textAlign = align || 'start';
          ctx.fillText(text, x, y);
          ctx.restore();
          return 0;
        },

        _canvas_text_width(canvasId, textPtr, textLen, size) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return 0;
          const text = self.readString(textPtr, textLen);
          const ctx = entry.ctx;
          const prevFont = ctx.font;
          ctx.font = `${size}px sans-serif`;
          const metrics = ctx.measureText(text);
          ctx.font = prevFont;
          return metrics.width;
        },

        // ====================================================================
        // FRAME RATE TARGET
        // ====================================================================

        // canvasScene fps= (CVS-L006): the frame loop runs at most this many
        // frames per second; dt stays the real time between frames. 0 or
        // less is the display rate.
        _canvas_set_fps(canvasId, fps) {
          self.targetFps = fps > 0 ? fps : 0;
          return 0;
        },

        // ====================================================================
        // GLOBAL VARS (canvas-scoped key-value store)
        // ====================================================================
        // Used by the canvas DSL for app-level mutable state that needs to
        // survive across frames without going through a Clean-side container.

        _canvas_var_set(namePtr, nameLen, value) {
          const name = self.readString(namePtr, nameLen);
          if (!self.canvasVars) self.canvasVars = new Map();
          self.canvasVars.set(name, value);
          return 0;
        },

        _canvas_var_get(namePtr, nameLen, defaultValue) {
          const name = self.readString(namePtr, nameLen);
          if (!self.canvasVars) self.canvasVars = new Map();
          return self.canvasVars.has(name) ? self.canvasVars.get(name) : defaultValue;
        },

        // ====================================================================
        // EVENT ACCESSORS (read state of the most recent input event)
        // ====================================================================
        // Mirror the existing input-state fields so handler bodies can call
        // these without a dedicated event payload.

        _canvas_event_x() {
          return self.mouseX;
        },

        _canvas_event_y() {
          return self.mouseY;
        },

        _canvas_event_key() {
          // Length-prefixed string return: writeString with no destination
          // pointer allocates from the bridge's string buffer and returns the
          // length-prefix pointer the WASM module reads.
          // The key of the event being dispatched (keydown or keyup).
          return self.writeString(self.eventKey || '');
        },

        // ====================================================================
        // ASSET PRELOAD (image cache by name)
        // ====================================================================

        _asset_preload_image(namePtr, nameLen, srcPtr, srcLen) {
          const name = self.readString(namePtr, nameLen);
          const src = self.readString(srcPtr, srcLen);
          if (!self.namedImages) self.namedImages = new Map();
          if (self.namedImages.has(name)) return 0;
          const img = new Image();
          img.src = src;
          self.namedImages.set(name, img);
          return 0;
        },

        // ====================================================================
        // IMAGE WITH OPACITY
        // ====================================================================

        _canvas_image_opacity(canvasId, srcPtr, srcLen, x, y, width, height, alpha) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          // Save/restore wraps the alpha change so following draws aren't
          // affected.
          const img = self._resolveImage(self.readString(srcPtr, srcLen));
          const draw = () => {
            const [w, h] = self._imageSize(img, width, height);
            entry.ctx.save();
            entry.ctx.globalAlpha *= alpha;
            entry.ctx.drawImage(img, x, y, w, h);
            entry.ctx.restore();
          };
          if (img.complete && img.naturalWidth > 0) {
            draw();
          } else {
            img.addEventListener('load', draw, { once: true });
          }
          return 0;
        },

        // ====================================================================
        // ANIMATION
        // ====================================================================

        // Start the scene's frame loop (the plugin calls it once, at the end
        // of start:). Under a scene manager the manager's loop drives every
        // scene of the stack; on its own the bridge runs requestAnimationFrame.
        _canvas_request_frame(canvasId) {
          const frameId = self.nextFrameId++;
          if (self.manager) {
            self.manager.requestFrames(self, canvasId);
            self.animationFrames.set(frameId, 0);
            return frameId;
          }
          const callback = (timestamp) => {
            if (!self.animationFrames.has(frameId)) return;
            self._tick(canvasId, timestamp);
            if (self.animationFrames.has(frameId)) {
              self.animationFrames.set(frameId, requestAnimationFrame(callback));
            }
          };
          self.animationFrames.set(frameId, requestAnimationFrame(callback));
          return frameId;
        },

        _canvas_cancel_frame(frameId) {
          if (!self.animationFrames.has(frameId)) return -1;
          const rafId = self.animationFrames.get(frameId);
          if (rafId) cancelAnimationFrame(rafId);
          self.animationFrames.delete(frameId);
          if (self.manager && self.animationFrames.size === 0) self.manager.cancelFrames(self);
          return 0;
        },

        _canvas_get_delta_time() {
          return self.deltaTime;
        },

        _canvas_get_time() {
          return (performance.now() - self.startTime) / 1000;
        },

        _canvas_get_fps() {
          return self.fps;
        },

        // ====================================================================
        // AUDIO — NAME-KEYED API (matches function-registry.toml canonical)
        // ====================================================================
        // Assets are preloaded once by name via _audio_preload and then played
        // either as sound effects (_audio_play_sound, returns instance id you
        // can _audio_stop/_audio_pause) or as music tracks (_audio_music_*,
        // identified by name throughout the lifecycle).

        _audio_preload(namePtr, nameLen, srcPtr, srcLen) {
          const name = self.readString(namePtr, nameLen);
          const src = self.readString(srcPtr, srcLen);
          if (self.namedSounds.has(name) || self.namedMusic.has(name)) return 0;
          // Single entry serves both sound and music play APIs; whichever is
          // called first materializes the corresponding underlying resource.
          const entry = { src, buffer: null, bufferPromise: null, element: null };
          self.namedSounds.set(name, entry);
          self.namedMusic.set(name, entry);
          return 0;
        },

        _audio_play_sound(namePtr, nameLen, volume, pitch) {
          const name = self.readString(namePtr, nameLen);
          const entry = self.namedSounds.get(name);
          if (!entry || !self.audioContext) return -1;

          // Lazily decode the asset into an AudioBuffer on first play. Subsequent
          // play calls reuse the cached buffer; concurrent first-plays share one
          // in-flight promise so the asset only downloads once.
          if (!entry.buffer && !entry.bufferPromise) {
            entry.bufferPromise = fetch(entry.src)
              .then(r => r.arrayBuffer())
              .then(buf => self.audioContext.decodeAudioData(buf))
              .then(decoded => { entry.buffer = decoded; return decoded; })
              .catch(err => {
                console.error(`[CanvasBridge] _audio_play_sound: decode '${name}' (${entry.src}) failed:`, err);
                return null;
              });
          }

          const instanceId = self.nextInstanceId++;
          const startInstance = (audioBuffer) => {
            if (!audioBuffer || !self.audioContext) {
              const inst = self.soundInstances.get(instanceId);
              if (inst) inst.playing = false;
              return;
            }
            const source = self.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = pitch || 1.0;

            const gainNode = self.audioContext.createGain();
            gainNode.gain.value = volume * self.masterVolume * (self.isMuted ? 0 : 1);

            source.connect(gainNode);
            gainNode.connect(self.audioContext.destination);
            source.onended = () => {
              const inst = self.soundInstances.get(instanceId);
              if (inst) inst.playing = false;
            };
            source.start(0);

            const inst = self.soundInstances.get(instanceId);
            if (inst) {
              inst.source = source;
              inst.gainNode = gainNode;
            }
          };

          self.soundInstances.set(instanceId, { source: null, gainNode: null, playing: true, volume });
          if (entry.buffer) {
            startInstance(entry.buffer);
          } else {
            entry.bufferPromise.then(startInstance);
          }
          return instanceId;
        },

        _audio_stop(instanceId) {
          const instance = self.soundInstances.get(instanceId);
          if (!instance) return -1;
          if (instance.source) {
            try { instance.source.stop(); } catch (e) { /* already stopped */ }
          }
          instance.playing = false;
          return 0;
        },

        _audio_pause(instanceId) {
          // Web Audio BufferSource cannot pause; treat as stop. Music API
          // (_audio_music_pause) supports real pause/resume.
          return self.env._audio_stop(instanceId);
        },

        _audio_resume(instanceId) {
          // Symmetric: cannot resume a stopped BufferSource. Use the music API
          // (_audio_music_resume) for tracks that need pause/resume semantics.
          return -1;
        },

        _audio_is_playing(instanceId) {
          const instance = self.soundInstances.get(instanceId);
          return instance && instance.playing ? 1 : 0;
        },

        // ----- MUSIC (name-keyed) -----

        _audio_music_play(namePtr, nameLen, loop, volume) {
          const name = self.readString(namePtr, nameLen);
          const entry = self.namedMusic.get(name);
          if (!entry) return -1;

          if (!entry.element) {
            entry.element = new Audio();
            entry.element.src = entry.src;
            entry.element.preload = 'auto';
          }
          const element = entry.element;
          element.loop = loop !== 0;
          element.volume = volume * self.musicVolume * self.masterVolume * (self.isMuted ? 0 : 1);
          self.musicVolumes.set(name, volume);

          element.play().catch(err => {
            console.warn(`[CanvasBridge] _audio_music_play '${name}' failed (user gesture required?):`, err);
          });
          self.currentMusicName = name;
          return 0;
        },

        _audio_music_stop(namePtr, nameLen) {
          // An omitted track name targets the current track.
          const name = self.readString(namePtr, nameLen) || self.currentMusicName || '';
          const entry = self.namedMusic.get(name);
          if (!entry || !entry.element) return -1;
          entry.element.pause();
          entry.element.currentTime = 0;
          if (self.currentMusicName === name) self.currentMusicName = null;
          return 0;
        },

        _audio_music_pause(namePtr, nameLen) {
          // An omitted track name targets the current track.
          const name = self.readString(namePtr, nameLen) || self.currentMusicName || '';
          const entry = self.namedMusic.get(name);
          if (!entry || !entry.element) return -1;
          entry.element.pause();
          return 0;
        },

        _audio_music_resume(namePtr, nameLen) {
          // An omitted track name targets the current track.
          const name = self.readString(namePtr, nameLen) || self.currentMusicName || '';
          const entry = self.namedMusic.get(name);
          if (!entry || !entry.element) return -1;
          entry.element.play().catch(() => {});
          return 0;
        },

        _audio_music_set_volume(namePtr, nameLen, volume) {
          // An omitted track name targets the current track.
          const name = self.readString(namePtr, nameLen) || self.currentMusicName || '';
          const entry = self.namedMusic.get(name);
          if (!entry || !entry.element) return -1;
          self.musicVolumes.set(name, volume);
          entry.element.volume = volume * self.musicVolume * self.masterVolume * (self.isMuted ? 0 : 1);
          return 0;
        },

        _audio_music_fade_out(namePtr, nameLen, duration) {
          // An omitted track name targets the current track.
          const name = self.readString(namePtr, nameLen) || self.currentMusicName || '';
          const entry = self.namedMusic.get(name);
          if (!entry || !entry.element) return -1;

          const element = entry.element;
          const startVolume = element.volume;
          const startTime = performance.now();
          const tick = () => {
            const elapsed = (performance.now() - startTime) / 1000;
            const t = Math.min(elapsed / duration, 1);
            element.volume = startVolume * (1 - t) * (self.isMuted ? 0 : 1);
            if (t < 1) {
              requestAnimationFrame(tick);
            } else {
              element.pause();
              if (self.currentMusicName === name) self.currentMusicName = null;
            }
          };
          requestAnimationFrame(tick);
          return 0;
        },

        _audio_music_crossfade(fromPtr, fromLen, toPtr, toLen, duration) {
          const fromName = self.readString(fromPtr, fromLen);
          const toName = self.readString(toPtr, toLen);
          const fromEntry = self.namedMusic.get(fromName);
          const toEntry = self.namedMusic.get(toName);
          if (!toEntry) return -1;

          if (!toEntry.element) {
            toEntry.element = new Audio();
            toEntry.element.src = toEntry.src;
            toEntry.element.preload = 'auto';
          }
          const toElement = toEntry.element;
          const targetVolume = self.musicVolumes.get(toName) ?? 1.0;
          toElement.loop = true;
          toElement.volume = 0;
          toElement.play().catch(() => {});

          const fromElement = fromEntry && fromEntry.element ? fromEntry.element : null;
          const fromStartVolume = fromElement ? fromElement.volume : 0;
          const startTime = performance.now();
          const tick = () => {
            const elapsed = (performance.now() - startTime) / 1000;
            const t = Math.min(elapsed / duration, 1);
            if (fromElement) {
              fromElement.volume = fromStartVolume * (1 - t) * (self.isMuted ? 0 : 1);
            }
            toElement.volume = targetVolume * t * self.musicVolume * self.masterVolume * (self.isMuted ? 0 : 1);
            if (t < 1) {
              requestAnimationFrame(tick);
            } else {
              if (fromElement) {
                fromElement.pause();
                fromElement.currentTime = 0;
              }
              self.currentMusicName = toName;
            }
          };
          requestAnimationFrame(tick);
          return 0;
        },

        // ----- MASTER CONTROL -----

        _audio_set_master_volume(volume) {
          self.masterVolume = volume;
          for (const [, instance] of self.soundInstances) {
            if (instance.playing && instance.gainNode) {
              instance.gainNode.gain.value = instance.volume * volume * (self.isMuted ? 0 : 1);
            }
          }
          for (const [name, entry] of self.namedMusic) {
            if (entry.element && !entry.element.paused) {
              const trackVolume = self.musicVolumes.get(name) ?? 1.0;
              entry.element.volume = trackVolume * self.musicVolume * volume * (self.isMuted ? 0 : 1);
            }
          }
          return 0;
        },

        _audio_mute() {
          self.isMuted = true;
          for (const [, instance] of self.soundInstances) {
            if (instance.gainNode) instance.gainNode.gain.value = 0;
          }
          for (const [, entry] of self.namedMusic) {
            if (entry.element) entry.element.volume = 0;
          }
          return 0;
        },

        _audio_unmute() {
          self.isMuted = false;
          for (const [, instance] of self.soundInstances) {
            if (instance.gainNode && instance.playing) {
              instance.gainNode.gain.value = instance.volume * self.masterVolume;
            }
          }
          for (const [name, entry] of self.namedMusic) {
            if (entry.element && !entry.element.paused) {
              const trackVolume = self.musicVolumes.get(name) ?? 1.0;
              entry.element.volume = trackVolume * self.musicVolume * self.masterVolume;
            }
          }
          return 0;
        },

        _audio_is_muted() {
          return self.isMuted ? 1 : 0;
        },

        // ====================================================================
        // SPRITES
        // ====================================================================

        _sprite_load_sheet(pathPtr, pathLen, frameWidth, frameHeight) {
          const path = self.readString(pathPtr, pathLen);
          const id = self.nextSpriteId++;

          const img = new Image();
          img.src = path;

          self.spriteSheets.set(id, {
            image: img,
            frameWidth: frameWidth,
            frameHeight: frameHeight,
            loaded: false,
            framesPerRow: 0,
            totalFrames: 0
          });

          img.onload = () => {
            const sheet = self.spriteSheets.get(id);
            if (sheet) {
              sheet.loaded = true;
              sheet.framesPerRow = Math.floor(img.width / frameWidth);
              const rows = Math.floor(img.height / frameHeight);
              sheet.totalFrames = sheet.framesPerRow * rows;
              console.log(`[CanvasBridge] Sprite sheet ${id} loaded: ${path} (${sheet.totalFrames} frames)`);
            }
          };

          return id;
        },

        _sprite_draw(canvasId, namePtr, nameLen, frameIndex, x, y, w, h) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const name = self.readString(namePtr, nameLen);
          const sheet = self.namedSprites.get(name);
          if (!sheet && self.namedImages && self.namedImages.has(name)) {
            // Static form: `canvas.sprite "name"` on a plain `image` asset.
            const img = self.namedImages.get(name);
            if (!img.complete || img.naturalWidth === 0) return -1;
            const [iw, ih] = self._imageSize(img, w, h);
            entry.ctx.drawImage(img, x, y, iw, ih);
            return 0;
          }
          if (!sheet || !sheet.loaded) return -1;
          // Width/height omitted by the DSL arrive as 0: use the frame size.
          if (!(w > 0)) w = sheet.frameWidth;
          if (!(h > 0)) h = sheet.frameHeight;

          const col = frameIndex % sheet.framesPerRow;
          const row = Math.floor(frameIndex / sheet.framesPerRow);
          const sx = col * sheet.frameWidth;
          const sy = row * sheet.frameHeight;

          entry.ctx.drawImage(
            sheet.image,
            sx, sy, sheet.frameWidth, sheet.frameHeight,
            x, y, w, h
          );
          return 0;
        },

        _sprite_get_frame_count(sheetId) {
          const sheet = self.spriteSheets.get(sheetId);
          return sheet ? sheet.totalFrames : 0;
        },

        _sprite_get_frame_width(sheetId) {
          const sheet = self.spriteSheets.get(sheetId);
          return sheet ? sheet.frameWidth : 0;
        },

        _sprite_get_frame_height(sheetId) {
          const sheet = self.spriteSheets.get(sheetId);
          return sheet ? sheet.frameHeight : 0;
        },

        // ====================================================================
        // INPUT - MOUSE
        // ====================================================================

        _input_mouse_x() {
          return self.mouseX;
        },

        _input_mouse_y() {
          return self.mouseY;
        },

        _input_mouse_pressed(button) {
          return self.mouseButtons[button] || false;
        },

        _input_mouse_just_pressed(button) {
          return self.mouseButtonsJustPressed[button] || false;
        },

        _input_mouse_just_released(button) {
          return self.mouseButtonsJustReleased[button] || false;
        },

        _input_mouse_wheel_y() {
          return self.mouseWheelY;
        },

        // ====================================================================
        // INPUT - KEYBOARD
        // ====================================================================

        _input_key_down(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.keysDown.has(key) ? 1 : 0;
        },

        _input_key_just_pressed(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.keysJustPressed.has(key) ? 1 : 0;
        },

        _input_key_just_released(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.keysJustReleased.has(key) ? 1 : 0;
        },

        _input_get_last_key() {
          // input.lastKey: the KeyboardEvent.key of the most recent keydown
          // on a scene canvas ("" before any key), as an LP string.
          return self.writeString(self.lastKey || '');
        },

        // ====================================================================
        // INPUT - TOUCH
        // ====================================================================

        _input_touch_count() {
          return self.touches.length;
        },

        _input_touch_x(index) {
          return self.touches[index] ? self.touches[index].x : 0;
        },

        _input_touch_y(index) {
          return self.touches[index] ? self.touches[index].y : 0;
        },

        // ====================================================================
        // INPUT - GAMEPAD
        // ====================================================================

        _input_gamepad_connected(index) {
          const gp = self.gamepads.get(index);
          return gp ? gp.connected : false;
        },

        _input_gamepad_button(gamepadIndex, buttonIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp && gp.buttons[buttonIndex] ? true : false;
        },

        _input_gamepad_axis(gamepadIndex, axisIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp && gp.axes[axisIndex] !== undefined ? gp.axes[axisIndex] : 0;
        },

        _input_gamepad_left_stick_x(gamepadIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp ? (gp.axes[0] || 0) : 0;
        },

        _input_gamepad_left_stick_y(gamepadIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp ? (gp.axes[1] || 0) : 0;
        },

        _input_gamepad_right_stick_x(gamepadIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp ? (gp.axes[2] || 0) : 0;
        },

        _input_gamepad_right_stick_y(gamepadIndex) {
          const gp = self.gamepads.get(gamepadIndex);
          return gp ? (gp.axes[3] || 0) : 0;
        },

        // ====================================================================
        // COLLISION DETECTION
        // ====================================================================

        _collision_point_rect(px, py, rx, ry, rw, rh) {
          return (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) ? 1 : 0;
        },

        _collision_point_circle(px, py, cx, cy, radius) {
          const dx = px - cx;
          const dy = py - cy;
          return (dx * dx + dy * dy <= radius * radius) ? 1 : 0;
        },

        _collision_circles(x1, y1, r1, x2, y2, r2) {
          const dx = x2 - x1;
          const dy = y2 - y1;
          const dist = Math.sqrt(dx * dx + dy * dy);
          return (dist <= r1 + r2) ? 1 : 0;
        },

        _collision_rects(x1, y1, w1, h1, x2, y2, w2, h2) {
          return (x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2) ? 1 : 0;
        },

        _collision_circle_rect(cx, cy, cr, rx, ry, rw, rh) {
          const closestX = Math.max(rx, Math.min(cx, rx + rw));
          const closestY = Math.max(ry, Math.min(cy, ry + rh));
          const dx = cx - closestX;
          const dy = cy - closestY;
          return (dx * dx + dy * dy <= cr * cr) ? 1 : 0;
        },

        _collision_ray_circle(ox, oy, dx, dy, cx, cy, r) {
          const fx = ox - cx;
          const fy = oy - cy;

          const a = dx * dx + dy * dy;
          const b = 2 * (fx * dx + fy * dy);
          const c = fx * fx + fy * fy - r * r;

          let discriminant = b * b - 4 * a * c;
          if (discriminant < 0) return -1;

          discriminant = Math.sqrt(discriminant);
          const t1 = (-b - discriminant) / (2 * a);
          const t2 = (-b + discriminant) / (2 * a);

          if (t1 >= 0) return t1;
          if (t2 >= 0) return t2;
          return -1;
        },

        // ====================================================================
        // ASSET MANAGEMENT
        // ====================================================================

        _asset_load_image(pathPtr, pathLen) {
          const path = self.readString(pathPtr, pathLen);
          const id = self.assets.size + 1;

          const img = new Image();
          img.src = path;

          self.assets.set(id, {
            type: 'image',
            path: path,
            image: img,
            loaded: false
          });

          img.onload = () => {
            const asset = self.assets.get(id);
            if (asset) asset.loaded = true;
          };

          return id;
        },

        _asset_load_sound(pathPtr, pathLen) {
          return self.env._audio_load_sound(pathPtr, pathLen);
        },

        _asset_load_music(pathPtr, pathLen) {
          return self.env._audio_load_music(pathPtr, pathLen);
        },

        _asset_queue(pathPtr, pathLen) {
          const path = self.readString(pathPtr, pathLen);
          self.assetQueue.push(path);
          self.assetsTotal = self.assetQueue.length;
          return self.assetQueue.length - 1;
        },

        _asset_load_all() {
          self.assetsLoaded = 0;

          const promises = self.assetQueue.map((path, index) => {
            return new Promise((resolve) => {
              if (path.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
                const img = new Image();
                img.src = path;
                img.onload = () => {
                  self.assetsLoaded++;
                  self.assets.set(path, { type: 'image', image: img, loaded: true });
                  resolve();
                };
                img.onerror = () => {
                  self.assetsLoaded++;
                  resolve();
                };
              } else if (path.match(/\.(wav|mp3|ogg)$/i)) {
                fetch(path)
                  .then(r => r.arrayBuffer())
                  .then(buffer => {
                    if (self.audioContext) {
                      return self.audioContext.decodeAudioData(buffer);
                    }
                    return null;
                  })
                  .then(audioBuffer => {
                    self.assetsLoaded++;
                    if (audioBuffer) {
                      self.assets.set(path, { type: 'sound', buffer: audioBuffer, loaded: true });
                    }
                    resolve();
                  })
                  .catch(() => {
                    self.assetsLoaded++;
                    resolve();
                  });
              } else {
                self.assetsLoaded++;
                resolve();
              }
            });
          });

          Promise.all(promises).then(() => {
            console.log(`[CanvasBridge] All ${self.assetsTotal} assets loaded`);
          });

          return 0;
        },

        _asset_get_progress() {
          return self.assetsTotal > 0 ? self.assetsLoaded / self.assetsTotal : 1;
        },

        _asset_all_loaded() {
          return self.assetsLoaded >= self.assetsTotal;
        },

        _asset_get(pathPtr, pathLen) {
          const path = self.readString(pathPtr, pathLen);
          for (const [id, asset] of self.assets) {
            if (asset.path === path) return id;
          }
          return -1;
        },

        _asset_unload(assetId) {
          self.assets.delete(assetId);
          return 0;
        },

        // ====================================================================
        // CAMERA & VIEWPORT
        // ====================================================================

        _camera_set_position(x, y) {
          self.cameraX = x;
          self.cameraY = y;
          return 0;
        },

        _camera_get_x() {
          return self.cameraX;
        },

        _camera_get_y() {
          return self.cameraY;
        },

        _camera_set_zoom(zoom) {
          self.cameraZoom = zoom;
          return 0;
        },

        _camera_get_zoom() {
          return self.cameraZoom;
        },

        _camera_set_rotation(degrees) {
          self.cameraRotation = degrees;
          return 0;
        },

        // The camera for this frame's draw: (the plugin wraps draw: in
        // _camera_apply / _camera_reset when the scene has a camera). The
        // follow target, deadzone and bounds move the camera first.
        _camera_apply(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          self._updateCamera(entry);
          const m = self._cameraTransform(entry);
          entry.lastCamera = m;
          if (self._recording() && entry.frame) {
            // Each layer is replayed under the camera; canvas.clear is not.
            entry.frame.camera = m;
            return 0;
          }
          entry.ctx.save();
          entry.ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
          return 0;
        },

        _camera_reset(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          if (self._recording() && entry.frame) return 0;
          entry.ctx.restore();
          return 0;
        },

        _camera_screen_to_world_x(screenX) {
          const entry = self.canvases.values().next().value;
          if (!entry) return screenX;
          return screenX / (self.cameraZoom > 0 ? self.cameraZoom : 1) + self.cameraX;
        },

        _camera_screen_to_world_y(screenY) {
          const entry = self.canvases.values().next().value;
          if (!entry) return screenY;
          return screenY / (self.cameraZoom > 0 ? self.cameraZoom : 1) + self.cameraY;
        },

        // camera.shake intensity= duration= falloff= : intensity decays by
        // the falloff easing over the duration.
        _camera_shake(intensity, duration, easingId) {
          self.cameraShakeIntensity = intensity;
          self.cameraShakeDuration = duration;
          self.cameraShakeEasing = easingId;
          self.cameraShakeStart = performance.now();
          return 0;
        },

        // ====================================================================
        // ADVANCED RENDERING
        // ====================================================================

        _canvas_set_blend_mode(canvasId, modePtr, modeLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const mode = self.readString(modePtr, modeLen);
          entry.ctx.globalCompositeOperation = mode;
          return 0;
        },

        _canvas_set_alpha(canvasId, alpha) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.globalAlpha = alpha;
          return 0;
        },

        _canvas_set_shadow(canvasId, blur, offsetX, offsetY, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.shadowBlur = blur;
          entry.ctx.shadowOffsetX = offsetX;
          entry.ctx.shadowOffsetY = offsetY;
          entry.ctx.shadowColor = color;
          return 0;
        },

        _canvas_clear_shadow(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.shadowBlur = 0;
          entry.ctx.shadowOffsetX = 0;
          entry.ctx.shadowOffsetY = 0;
          entry.ctx.shadowColor = 'transparent';
          return 0;
        },

        _canvas_set_line_cap(canvasId, capPtr, capLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const cap = self.readString(capPtr, capLen);
          entry.ctx.lineCap = cap;
          return 0;
        },

        _canvas_set_line_join(canvasId, joinPtr, joinLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const join = self.readString(joinPtr, joinLen);
          entry.ctx.lineJoin = join;
          return 0;
        },

        _canvas_set_line_dash(canvasId, dashLength, gapLength) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.setLineDash([dashLength, gapLength]);
          return 0;
        },

        _canvas_clear_line_dash(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.setLineDash([]);
          return 0;
        },

        // ====================================================================
        // EASING FUNCTIONS
        // ====================================================================

        _ease_linear(t) {
          return t;
        },

        _ease_in_quad(t) {
          return t * t;
        },

        _ease_out_quad(t) {
          return t * (2 - t);
        },

        _ease_in_out_quad(t) {
          return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        },

        _ease_cubic_in(t) {
          return t * t * t;
        },

        _ease_cubic_out(t) {
          return (--t) * t * t + 1;
        },

        _ease_cubic_in_out(t) {
          return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
        },

        _ease_in_sine(t) {
          return 1 - Math.cos(t * Math.PI / 2);
        },

        _ease_out_sine(t) {
          return Math.sin(t * Math.PI / 2);
        },

        _ease_in_out_sine(t) {
          return -(Math.cos(Math.PI * t) - 1) / 2;
        },

        _ease_in_expo(t) {
          return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
        },

        _ease_out_expo(t) {
          return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        },

        _ease_in_out_expo(t) {
          if (t === 0) return 0;
          if (t === 1) return 1;
          return t < 0.5
            ? Math.pow(2, 20 * t - 10) / 2
            : (2 - Math.pow(2, -20 * t + 10)) / 2;
        },

        _ease_elastic_in(t) {
          const c4 = (2 * Math.PI) / 3;
          return t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
        },

        _ease_elastic_out(t) {
          const c4 = (2 * Math.PI) / 3;
          return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
        },

        _ease_in_out_elastic(t) {
          const c5 = (2 * Math.PI) / 4.5;
          return t === 0 ? 0 : t === 1 ? 1 : t < 0.5
            ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
            : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
        },

        _ease_bounce_in(t) {
          return 1 - self.env._ease_bounce_out(1 - t);
        },

        _ease_bounce_out(t) {
          const n1 = 7.5625;
          const d1 = 2.75;
          if (t < 1 / d1) {
            return n1 * t * t;
          } else if (t < 2 / d1) {
            return n1 * (t -= 1.5 / d1) * t + 0.75;
          } else if (t < 2.5 / d1) {
            return n1 * (t -= 2.25 / d1) * t + 0.9375;
          } else {
            return n1 * (t -= 2.625 / d1) * t + 0.984375;
          }
        },

        _ease_in_out_bounce(t) {
          return t < 0.5
            ? (1 - self.env._ease_bounce_out(1 - 2 * t)) / 2
            : (1 + self.env._ease_bounce_out(2 * t - 1)) / 2;
        },

        _ease_back_in(t) {
          const c1 = 1.70158;
          const c3 = c1 + 1;
          return c3 * t * t * t - c1 * t * t;
        },

        _ease_back_out(t) {
          const c1 = 1.70158;
          const c3 = c1 + 1;
          return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        },

        _ease_back_in_out(t) {
          const c1 = 1.70158;
          const c2 = c1 * 1.525;
          return t < 0.5
            ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
            : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
        },

        // ====================================================================
        // SCENE MANAGEMENT
        // ====================================================================

        // Scenes (CVS-S001..S009). Each scene is its own module; the scene
        // manager (loader.js) loads, starts and stops them. The requests run
        // after the current frame or handler returns.
        _scene_get_current() {
          return self.writeString(self.sceneName || '');
        },

        _scene_change(namePtr, nameLen) {
          return self._sceneRequest({ op: 'change', name: self.readString(namePtr, nameLen), transition: 'instant', duration: 0 });
        },

        _scene_change_animated(namePtr, nameLen, transitionPtr, transitionLen, duration) {
          return self._sceneRequest({
            op: 'change',
            name: self.readString(namePtr, nameLen),
            transition: self.readString(transitionPtr, transitionLen) || 'instant',
            duration,
          });
        },

        _scene_push(namePtr, nameLen) {
          return self._sceneRequest({ op: 'push', name: self.readString(namePtr, nameLen) });
        },

        _scene_pop() {
          return self._sceneRequest({ op: 'pop' });
        },

        // scene.set / scene.get (CVS-S003): values for the next scene's
        // init:, kept by the manager (shared by the scenes) and dropped once
        // that init: has run.
        _scene_set(keyPtr, keyLen, valPtr, valLen) {
          self._sceneParams().set(self.readString(keyPtr, keyLen), self.readString(valPtr, valLen));
          return 0;
        },

        _scene_get(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.writeString(self._sceneParams().get(key) || '');
        },

        // ====================================================================
        // PAGE / UI BRIDGE (CVS-I003)
        // ====================================================================
        // page.set / page.get share values with the HTML layer through
        // frame.ui's state store (ui.getState / ui.setState read and write the
        // same keys). Values are stored JSON-encoded: numbers and booleans as
        // they are, any other text as a JSON string.

        _page_set(keyPtr, keyLen, valPtr, valLen) {
          const key = self.readString(keyPtr, keyLen);
          const val = self.readString(valPtr, valLen);
          const json = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(val) || val === 'true' || val === 'false'
            ? val : JSON.stringify(val);
          self._pageStore().set(key, json);
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('clean-canvas-page-set', { detail: { key, value: json } }));
          }
          return 0;
        },

        // The value as text: a JSON string decoded, a number or boolean as
        // written, anything else (an object) as its JSON.
        _page_get(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          const stored = self._pageStore().get(key);
          let text = '';
          if (stored !== undefined && stored !== null) {
            text = String(stored);
            try {
              const v = JSON.parse(text);
              if (typeof v === 'string') text = v;
            } catch (_) { /* not JSON: the text itself */ }
          }
          return self.writeString(text);
        },

        // ====================================================================
        // GRADIENTS (named, with stops, used as fill via _gradient_ref)
        // ====================================================================

        _gradient_linear(namePtr, nameLen, x1, y1, x2, y2) {
          const name = self.readString(namePtr, nameLen);
          self.gradients.set(name, { type: 'linear', x1, y1, x2, y2, stops: [], _cache: new Map() });
          return 0;
        },

        _gradient_radial(namePtr, nameLen, cx, cy, radius) {
          const name = self.readString(namePtr, nameLen);
          self.gradients.set(name, { type: 'radial', cx, cy, radius, stops: [], _cache: new Map() });
          return 0;
        },

        _gradient_add_stop(namePtr, nameLen, offset, colorPtr, colorLen) {
          const name = self.readString(namePtr, nameLen);
          const color = self.readString(colorPtr, colorLen);
          const grad = self.gradients.get(name);
          if (!grad) return -1;
          grad.stops.push({ offset, color });
          grad._cache.clear();
          return 0;
        },

        _gradient_ref(namePtr, nameLen) {
          // Returns an opaque integer the user can pass to gradient-fill calls.
          // We use 1-based index into gradients map insertion order so 0 means
          // "no gradient".
          const name = self.readString(namePtr, nameLen);
          let i = 1;
          for (const key of self.gradients.keys()) {
            if (key === name) return i;
            i++;
          }
          return 0;
        },

        // ====================================================================
        // GRADIENT-FILLED SHAPES
        // ====================================================================

        _canvas_rect_gradient(canvasId, x, y, w, h, gradPtr, gradLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const gradName = self.readString(gradPtr, gradLen);
          const fill = self._buildCanvasGradient(entry.ctx, gradName);
          if (!fill) return -1;
          entry.ctx.fillStyle = fill;
          entry.ctx.fillRect(x, y, w, h);
          return 0;
        },

        _canvas_circle_gradient(canvasId, x, y, radius, gradPtr, gradLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const gradName = self.readString(gradPtr, gradLen);
          const fill = self._buildCanvasGradient(entry.ctx, gradName);
          if (!fill) return -1;
          entry.ctx.beginPath();
          entry.ctx.arc(x, y, radius, 0, Math.PI * 2);
          entry.ctx.fillStyle = fill;
          entry.ctx.fill();
          return 0;
        },

        _canvas_fill_path_gradient(canvasId, gradPtr, gradLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const gradName = self.readString(gradPtr, gradLen);
          const fill = self._buildCanvasGradient(entry.ctx, gradName);
          if (!fill) return -1;
          entry.ctx.fillStyle = fill;
          entry.ctx.fill();
          return 0;
        },

        // ====================================================================
        // NAMED PATHS (path: block — define once, draw many)
        // ====================================================================

        _path_begin(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          self.namedPaths.set(name, []);
          return 0;
        },

        _path_move_to(namePtr, nameLen, x, y) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'move', x, y });
          return 0;
        },

        _path_line_to(namePtr, nameLen, x, y) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'line', x, y });
          return 0;
        },

        _path_curve_to(namePtr, nameLen, cpx, cpy, x, y) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'curve', cpx, cpy, x, y });
          return 0;
        },

        _path_cubic_to(namePtr, nameLen, cp1x, cp1y, cp2x, cp2y, x, y) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'cubic', cp1x, cp1y, cp2x, cp2y, x, y });
          return 0;
        },

        _path_arc_to(namePtr, nameLen, x, y, radius, startAngle, endAngle) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'arc', x, y, radius, startAngle, endAngle });
          return 0;
        },

        _path_close(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const p = self.namedPaths.get(name); if (!p) return -1;
          p.push({ op: 'close' });
          return 0;
        },

        _canvas_draw_named_path(canvasId, namePtr, nameLen, strokeWidth, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const name = self.readString(namePtr, nameLen);
          const segs = self.namedPaths.get(name);
          if (!segs) return -1;
          const color = self.readString(colorPtr, colorLen);
          const ctx = entry.ctx;
          ctx.beginPath();
          self._replayPathSegments(ctx, segs);
          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
          return 0;
        },

        // ====================================================================
        // LAYERS (named z-ordered draw groups)
        // ====================================================================
        // Layers in the canvas DSL declare draw order. The current minimal
        // implementation tracks the active layer name so future immediate-mode
        // draws can be tagged; the existing draw functions render directly to
        // the canvas in declaration order, so layer routing is a no-op for
        // now but the bookkeeping is correct.

        // layers: (CVS-D001..D004). Declaring a layer switches the canvas to
        // recorded frames: `on layer` routes draw calls to that layer's
        // buffer, everything else goes to the default z=0 layer, and the frame
        // is composited in ascending z (equal z in declaration order) when it
        // ends.
        _layer_declare(namePtr, nameLen, z) {
          const name = self.readString(namePtr, nameLen);
          self.namedLayers.set(name, { z, seq: self.layerSeq++, drawCalls: [] });
          self.layerOrder = [...self.namedLayers.entries()]
            .sort((a, b) => (a[1].z - b[1].z) || (a[1].seq - b[1].seq))
            .map(([k]) => k);
          self.layersDeclared = true;
          self._ensureRecording();
          return 0;
        },

        _layer_begin(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          self.currentLayer = name;
          if (self._recording()) {
            for (const [, entry] of self.canvases) if (entry.frame) entry.ctx = self._layerTarget(entry, name);
          }
          return 0;
        },

        _layer_end() {
          self.currentLayer = null;
          if (self._recording()) {
            for (const [, entry] of self.canvases) if (entry.frame) entry.ctx = self._layerTarget(entry, '');
          }
          return 0;
        },

        // ====================================================================
        // TWEENS — named definitions + playback control
        // ====================================================================

        _tween_define_var(namePtr, nameLen, varPtr, varLen, from, to, duration, easePtr, easeLen, repeat, yoyo, delay, pathPtr, pathLen) {
          const name = self.readString(namePtr, nameLen);
          const varName = self.readString(varPtr, varLen);
          const ease = self.readString(easePtr, easeLen);
          const pathName = self.readString(pathPtr, pathLen);
          if (!self.namedTweens.has(name)) {
            self.namedTweens.set(name, { state: 'stopped', elapsed: 0, vars: [] });
          }
          const tw = self.namedTweens.get(name);
          if (!self._isKnownEase(ease)) {
            console.error(`[CanvasBridge] tween "${name}": unknown easing "${ease}" (frame-canvas.ebnf §28)`);
          }
          // A path tween's lines arrive in order: X, Y, then the orient
          // angle variable (see _updateAnimations).
          const pathAxis = pathName ? tw.vars.filter((x) => x.pathName).length : -1;
          tw.vars.push({
            varName, from, start: 0, to, duration, ease,
            repeat: repeat | 0, yoyo: !!yoyo, delay,
            pathName: pathName || null, pathAxis, done: false,
          });
          return 0;
        },

        _tween_play(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tw = self.namedTweens.get(name);
          if (!tw) return -1;
          tw.state = 'playing';
          tw.elapsed = 0;
          tw.vars.forEach(v => {
            v.done = false;
            v.start = self.canvasVars && self.canvasVars.has(v.varName) ? self.canvasVars.get(v.varName) : 0;
          });
          return 0;
        },

        _tween_stop(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tw = self.namedTweens.get(name);
          if (!tw) return -1;
          tw.state = 'stopped';
          tw.elapsed = 0;
          return 0;
        },

        _tween_pause(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tw = self.namedTweens.get(name);
          if (!tw) return -1;
          if (tw.state === 'playing') tw.state = 'paused';
          return 0;
        },

        _tween_resume(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tw = self.namedTweens.get(name);
          if (!tw) return -1;
          if (tw.state === 'paused') tw.state = 'playing';
          return 0;
        },

        _tween_animate(varPtr, varLen, target, duration, easingId) {
          // Inline animate: drives a single var from its current value to
          // target over duration seconds using easingId. Creates an anonymous
          // tween keyed by var name so re-calling replaces it.
          self._animateVar({
            varName: self.readString(varPtr, varLen),
            to: target, duration, ease: self._easeIdToName(easingId),
          });
          return 0;
        },

        _tween_animate_path(twPtr, twLen, pathPtr, pathLen, duration, easingId, orient) {
          const tweenName = self.readString(twPtr, twLen);
          const pathName = self.readString(pathPtr, pathLen);
          if (!self.namedTweens.has(tweenName)) {
            self.namedTweens.set(tweenName, { state: 'stopped', elapsed: 0, vars: [] });
          }
          // No DSL form reaches this bridge (the plugin registers path
          // tweens with _tween_define_var). It drives `<tweenName>_x`,
          // `<tweenName>_y` and, with orient, `<tweenName>_angle` (degrees).
          const tw = self.namedTweens.get(tweenName);
          const suffixes = orient ? ['_x', '_y', '_angle'] : ['_x', '_y'];
          suffixes.forEach((suffix, pathAxis) => tw.vars.push({
            varName: tweenName + suffix,
            from: 0, to: 0, duration,
            ease: self._easeIdToName(easingId),
            repeat: 0, yoyo: false, delay: 0,
            pathName, pathAxis, done: false,
          }));
          tw.state = 'playing';
          tw.elapsed = 0;
          return 0;
        },

        // ====================================================================
        // TIMELINES — JSON-defined sequences
        // ====================================================================

        _timeline_define_json(namePtr, nameLen, jsonPtr, jsonLen) {
          const name = self.readString(namePtr, nameLen);
          const json = self.readString(jsonPtr, jsonLen);
          let cfg = {};
          try { cfg = JSON.parse(json); } catch (e) {
            console.error(`[CanvasBridge] _timeline_define_json: bad JSON for "${name}"`, e);
          }
          self.namedTimelines.set(name, { state: 'stopped', time: 0, config: cfg });
          return 0;
        },

        _timeline_play(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tl = self.namedTimelines.get(name);
          if (!tl) return -1;
          tl.state = 'playing'; tl.time = 0;
          if (tl.config && Array.isArray(tl.config.steps)) tl.config.steps.forEach(s => s._fired = false);
          return 0;
        },

        _timeline_stop(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tl = self.namedTimelines.get(name);
          if (!tl) return -1;
          tl.state = 'stopped'; tl.time = 0;
          return 0;
        },

        _timeline_pause(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const tl = self.namedTimelines.get(name);
          if (!tl) return -1;
          if (tl.state === 'playing') tl.state = 'paused';
          return 0;
        },

        _timeline_seek(namePtr, nameLen, position) {
          const name = self.readString(namePtr, nameLen);
          const tl = self.namedTimelines.get(name);
          if (!tl) return -1;
          tl.time = Math.max(0, position);
          if (tl.config && Array.isArray(tl.config.steps)) {
            tl.config.steps.forEach(s => { s._fired = (s.at || 0) < tl.time; });
          }
          return 0;
        },

        // ====================================================================
        // ANIMATION STATE MACHINES (FSM for sprite animation states)
        // ====================================================================

        _animstate_define_json(namePtr, nameLen, jsonPtr, jsonLen) {
          const name = self.readString(namePtr, nameLen);
          const json = self.readString(jsonPtr, jsonLen);
          let cfg = {};
          try { cfg = JSON.parse(json); } catch (e) {
            console.error(`[CanvasBridge] _animstate_define_json: bad JSON for "${name}"`, e);
          }
          self.namedAnimStates.set(name, {
            state: 'stopped',
            current: cfg.initial || '',
            config: cfg,
          });
          return 0;
        },

        _anim_state_start(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const fsm = self.namedAnimStates.get(name);
          if (!fsm) return -1;
          fsm.state = 'running';
          fsm.current = fsm.config.initial || fsm.current || '';
          return 0;
        },

        _anim_state_force(namePtr, nameLen, statePtr, stateLen) {
          const name = self.readString(namePtr, nameLen);
          const stateName = self.readString(statePtr, stateLen);
          const fsm = self.namedAnimStates.get(name);
          if (!fsm) return -1;
          if (fsm.current !== stateName) {
            fsm.current = stateName;
            // Entering a state restarts the clip it plays.
            const clip = self.namedAnimSprites.get(self._animStateClip(fsm));
            if (clip) { clip.current = clip.frameStart; clip.elapsed = 0; clip.finished = false; }
          }
          return 0;
        },

        _anim_state_current(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const fsm = self.namedAnimStates.get(name);
          return self.writeString(fsm ? (fsm.current || '') : '');
        },

        // ====================================================================
        // ANIMSPRITE — named sprite-sheet animation clips
        // ====================================================================

        _animsprite_define(clipPtr, clipLen, sheetPtr, sheetLen, frameStart, frameEnd, fps, loop) {
          const clipName = self.readString(clipPtr, clipLen);
          const sheetName = self.readString(sheetPtr, sheetLen);
          self.namedAnimSprites.set(clipName, {
            sheetName,
            frameStart: frameStart | 0,
            frameEnd: frameEnd | 0,
            fps, loop: !!loop,
            current: frameStart | 0,
            elapsed: 0,
          });
          return 0;
        },

        _anim_sprite_reset(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const clip = self.namedAnimSprites.get(name);
          if (!clip) return -1;
          clip.current = clip.frameStart;
          clip.elapsed = 0;
          clip.finished = false;
          return 0;
        },

        _anim_sprite_draw(canvasId, namePtr, nameLen, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const clipName = self.readString(namePtr, nameLen);
          const clip = self.namedAnimSprites.get(clipName);
          if (!clip) return -1;
          const sheet = self.namedSprites.get(clip.sheetName);
          if (!sheet || !sheet.loaded) return -1;
          const col = clip.current % sheet.framesPerRow;
          const row = Math.floor(clip.current / sheet.framesPerRow);
          entry.ctx.drawImage(
            sheet.image,
            col * sheet.frameWidth, row * sheet.frameHeight, sheet.frameWidth, sheet.frameHeight,
            x, y, sheet.frameWidth, sheet.frameHeight,
          );
          return 0;
        },

        _anim_sprite_draw_ex(canvasId, namePtr, nameLen, x, y, w, h, flipX, flipY) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const clipName = self.readString(namePtr, nameLen);
          const clip = self.namedAnimSprites.get(clipName);
          if (!clip) return -1;
          const sheet = self.namedSprites.get(clip.sheetName);
          if (!sheet || !sheet.loaded) return -1;
          const col = clip.current % sheet.framesPerRow;
          const row = Math.floor(clip.current / sheet.framesPerRow);
          const ctx = entry.ctx;
          ctx.save();
          const cx = x + w / 2, cy = y + h / 2;
          ctx.translate(cx, cy);
          ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
          ctx.drawImage(
            sheet.image,
            col * sheet.frameWidth, row * sheet.frameHeight, sheet.frameWidth, sheet.frameHeight,
            -w / 2, -h / 2, w, h,
          );
          ctx.restore();
          return 0;
        },

        // ====================================================================
        // PARTICLES — emitters defined by JSON config
        // ====================================================================

        _particles_define_json(namePtr, nameLen, jsonPtr, jsonLen) {
          const name = self.readString(namePtr, nameLen);
          const json = self.readString(jsonPtr, jsonLen);
          let cfg = {};
          try { cfg = JSON.parse(json); } catch (e) {
            console.error(`[CanvasBridge] _particles_define_json: bad JSON for "${name}"`, e);
          }
          self.namedParticles.set(name, { config: cfg, emitters: [] });
          return 0;
        },

        _particles_emit(namePtr, nameLen, x, y) {
          const name = self.readString(namePtr, nameLen);
          const sys = self.namedParticles.get(name);
          if (!sys) return -1;
          const count = sys.config.burst ? sys.config.burst : 20;
          const em = { x, y, continuous: false, emitAccum: 0, particles: [] };
          for (let i = 0; i < count; i++) em.particles.push(self._spawnParticle(x, y, sys.config));
          sys.emitters.push(em);
          return 0;
        },

        _particles_start(namePtr, nameLen, x, y) {
          const name = self.readString(namePtr, nameLen);
          const sys = self.namedParticles.get(name);
          if (!sys) return -1;
          sys.emitters.push({ x, y, continuous: true, emitAccum: 0, particles: [] });
          return 0;
        },

        _particles_stop(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const sys = self.namedParticles.get(name);
          if (!sys) return -1;
          sys.emitters.forEach(em => em.continuous = false);
          return 0;
        },

        // ====================================================================
        // CAMERA — follow, deadzone, bounds
        // ====================================================================

        _camera_set_follow(targetX, targetY, smoothing) {
          self.cameraFollowX = targetX;
          self.cameraFollowY = targetY;
          self.cameraFollowSmoothing = smoothing;
          return 0;
        },

        _camera_set_offset(offsetX, offsetY) {
          self.cameraOffsetX = offsetX;
          self.cameraOffsetY = offsetY;
          return 0;
        },

        _camera_set_deadzone(w, h) {
          self.cameraDeadzoneW = w;
          self.cameraDeadzoneH = h;
          return 0;
        },

        _camera_set_bounds(x, y, w, h) {
          self.cameraBounds = { x, y, w, h };
          return 0;
        },

        // ====================================================================
        // EVENT HANDLER REGISTRATION
        // ====================================================================
        // The canvas DSL emits handler functions under fixed export names:
        // _on_pointer_down / _on_pointer_move / _on_pointer_up / _on_key_down /
        // _on_key_up / _on_exit / _on_pause / _on_resume. Registration here
        // marks the canvas (or scene) as having a handler so the bridge knows
        // to dispatch events to it.

        _canvas_on_pointer_down(canvasId) {
          self.pointerDownHandlers.set(canvasId, '_on_pointer_down');
          return 0;
        },

        _canvas_on_pointer_move(canvasId) {
          self.pointerMoveHandlers.set(canvasId, '_on_pointer_move');
          return 0;
        },

        _canvas_on_pointer_up(canvasId) {
          self.pointerUpHandlers.set(canvasId, '_on_pointer_up');
          return 0;
        },

        _canvas_on_key_down(canvasId) {
          self.keyDownHandlers.set(canvasId, '_on_key_down');
          return 0;
        },

        _canvas_on_key_up(canvasId) {
          self.keyUpHandlers.set(canvasId, '_on_key_up');
          return 0;
        },

        // Lifecycle hooks (CVS-S007..S009): the scene manager runs them when
        // the scene leaves the stack (exit), is covered or the tab is hidden
        // (pause), and is uncovered or the tab shown again (resume).
        _canvas_on_exit(canvasId) {
          self.lifecycle.set('exit', canvasId);
          return 0;
        },

        _canvas_on_pause(canvasId) {
          self.lifecycle.set('pause', canvasId);
          return 0;
        },

        _canvas_on_resume(canvasId) {
          self.lifecycle.set('resume', canvasId);
          return 0;
        },

        // ====================================================================
        // FONT LOADING
        // ====================================================================

        _font_load(namePtr, nameLen, srcPtr, srcLen) {
          const name = self.readString(namePtr, nameLen);
          const src = self.readString(srcPtr, srcLen);
          if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
            self.fontsLoaded.set(name, { src, loaded: false });
            return 0;
          }
          const face = new FontFace(name, `url(${src})`);
          self.fontsLoaded.set(name, { src, loaded: false, face });
          face.load().then(loaded => {
            document.fonts.add(loaded);
            const entry = self.fontsLoaded.get(name);
            if (entry) entry.loaded = true;
          }).catch(err => console.error(`[CanvasBridge] Font "${name}" failed to load:`, err));
          return 1;
        },

        // ====================================================================
        // CUSTOM EASING (cubic bezier)
        // ====================================================================

        _custom_ease_register(namePtr, nameLen, x1, y1, x2, y2) {
          const name = self.readString(namePtr, nameLen);
          self.customEases.set(name, { x1, y1, x2, y2 });
          return 0;
        },

        _ease_custom(namePtr, nameLen, t) {
          const name = self.readString(namePtr, nameLen);
          return self._evalCustomEase(name, t);
        },

        // ====================================================================
        // NAMED SPRITE REGISTRATION (sheets keyed by user-given name)
        // ====================================================================

        _sprite_register_sheet(namePtr, nameLen, srcPtr, srcLen, frameWidth, frameHeight) {
          const name = self.readString(namePtr, nameLen);
          const src = self.readString(srcPtr, srcLen);
          const img = new Image();
          img.src = src;
          const sheet = {
            image: img,
            frameWidth,
            frameHeight,
            loaded: false,
            framesPerRow: 0,
            totalFrames: 0,
          };
          self.namedSprites.set(name, sheet);
          img.onload = () => {
            sheet.loaded = true;
            sheet.framesPerRow = Math.floor(img.width / frameWidth);
            const rows = Math.floor(img.height / frameHeight);
            sheet.totalFrames = sheet.framesPerRow * rows;
          };
          return 0;
        },

        _sprite_draw_flipped(canvasId, namePtr, nameLen, frameIndex, x, y, w, h, flipX, flipY) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const name = self.readString(namePtr, nameLen);
          const sheet = self.namedSprites.get(name);
          if (!sheet || !sheet.loaded) return -1;
          // Width/height omitted by the DSL arrive as 0: use the frame size.
          if (!(w > 0)) w = sheet.frameWidth;
          if (!(h > 0)) h = sheet.frameHeight;
          const col = frameIndex % sheet.framesPerRow;
          const row = Math.floor(frameIndex / sheet.framesPerRow);
          const ctx = entry.ctx;
          ctx.save();
          const cx = x + w / 2, cy = y + h / 2;
          ctx.translate(cx, cy);
          ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
          ctx.drawImage(
            sheet.image,
            col * sheet.frameWidth, row * sheet.frameHeight, sheet.frameWidth, sheet.frameHeight,
            -w / 2, -h / 2, w, h,
          );
          ctx.restore();
          return 0;
        },

        _sprite_draw_tint(canvasId, namePtr, nameLen, frameIndex, x, y, w, h, tintPtr, tintLen, tintStrength) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const name = self.readString(namePtr, nameLen);
          const sheet = self.namedSprites.get(name);
          if (!sheet || !sheet.loaded) return -1;
          // Width/height omitted by the DSL arrive as 0: use the frame size.
          if (!(w > 0)) w = sheet.frameWidth;
          if (!(h > 0)) h = sheet.frameHeight;
          const tint = self.readString(tintPtr, tintLen);
          const col = frameIndex % sheet.framesPerRow;
          const row = Math.floor(frameIndex / sheet.framesPerRow);
          const ctx = entry.ctx;
          ctx.drawImage(
            sheet.image,
            col * sheet.frameWidth, row * sheet.frameHeight, sheet.frameWidth, sheet.frameHeight,
            x, y, w, h,
          );
          if (tintStrength > 0) {
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, tintStrength));
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = tint;
            ctx.fillRect(x, y, w, h);
            ctx.restore();
          }
          return 0;
        },

        _sprite_draw_state(canvasId, spritePtr, spriteLen, fsmPtr, fsmLen, x, y) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const spriteName = self.readString(spritePtr, spriteLen);
          const fsmName = self.readString(fsmPtr, fsmLen);
          const sheet = self.namedSprites.get(spriteName);
          if (!sheet || !sheet.loaded) return -1;
          const fsm = self.namedAnimStates.get(fsmName);
          // Use the FSM's current state name to look up an animsprite clip
          // with the same name. Renders the clip's current frame from sheet.
          const clip = fsm ? self.namedAnimSprites.get(self._animStateClip(fsm)) : null;
          const frameIndex = clip ? clip.current : 0;
          const col = frameIndex % sheet.framesPerRow;
          const row = Math.floor(frameIndex / sheet.framesPerRow);
          entry.ctx.drawImage(
            sheet.image,
            col * sheet.frameWidth, row * sheet.frameHeight, sheet.frameWidth, sheet.frameHeight,
            x, y, sheet.frameWidth, sheet.frameHeight,
          );
          return 0;
        },
      }
    };
  }

  // ==========================================================================
  // WASM INSTANCE SETUP
  // ==========================================================================

  // `allocate(size)` hands out module-heap memory for string returns; a
  // module that defines its own memory is read through that memory.
  setWasmInstance(instance, allocate) {
    this.wasmInstance = instance;
    if (instance && instance.exports && instance.exports.memory instanceof WebAssembly.Memory) {
      this.memory = instance.exports.memory;
    }
    if (typeof allocate === 'function') this.allocate = allocate;
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  destroy() {
    for (const [, rafId] of this.animationFrames) {
      if (rafId) cancelAnimationFrame(rafId);
    }
    this.animationFrames.clear();
    this.detachInput();

    for (const [, instance] of this.soundInstances) {
      try { instance.source.stop(); } catch (e) { }
    }
    this.soundInstances.clear();

    // Canvases the bridge created itself go; a page <canvas> stays.
    for (const [, entry] of this.canvases) {
      if (entry.created && entry.element.remove) entry.element.remove();
    }
    this.canvases.clear();
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CanvasBridge };
}

if (typeof window !== 'undefined') {
  window.CanvasBridge = CanvasBridge;
}
