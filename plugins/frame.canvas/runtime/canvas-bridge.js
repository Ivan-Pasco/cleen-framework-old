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
    // SCENE STATE
    // ========================================================================
    this.currentScene = 'default';
    this.sceneStack = [];

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
    this.onExitHandlers = new Map();
    this.onPauseHandlers = new Map();
    this.onResumeHandlers = new Map();

    // ========================================================================
    // PAGE/UI BRIDGE + SCENE PARAMETERS
    // ========================================================================
    this.pageStore = new Map();   // key -> JSON-encoded value (string)
    this.sceneParams = new Map(); // key -> JSON-encoded value (string)

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
    // RETURN-STRING HEAP (for bridge functions that return strings)
    // ========================================================================
    // Sits past the loader's STRING_BUFFER_OFFSET=1MB region. The 1MB window
    // here is large enough for many frames of short string returns before it
    // wraps. Clean reads each returned string immediately, so wrap-around is
    // safe in practice.
    this._returnHeapBase = 2 * 1024 * 1024;
    this._returnHeapPtr = this._returnHeapBase;
    this._returnHeapMax = 3 * 1024 * 1024;

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
  //   writeString(str)      — allocate from the bridge return-string heap
  //                           and write a 4-byte LE length-prefix followed
  //                           by the UTF-8 bytes. Returns the pointer to the
  //                           length prefix, which is the format Clean reads
  //                           when a bridge function returns a string.
  writeString(str, ptr) {
    if (!this.memory) return 0;
    const bytes = new TextEncoder().encode(str || '');
    if (ptr === undefined && this.allocate) {
      // Length-prefixed string on the module heap.
      const result = this.allocate(4 + bytes.length);
      new DataView(this.memory.buffer).setUint32(result, bytes.length, true);
      new Uint8Array(this.memory.buffer, result + 4, bytes.length).set(bytes);
      return result;
    }
    if (ptr === undefined) {
      // Length-prefixed allocation in the bridge's return-string region
      // (standalone use without a loader-provided allocator).
      if (this._returnHeapPtr + bytes.length + 8 >= this._returnHeapMax) {
        // wrap around — return strings are short-lived; Clean reads them
        // immediately after the call.
        this._returnHeapPtr = this._returnHeapBase;
      }
      const result = this._returnHeapPtr;
      const dv = new DataView(this.memory.buffer);
      dv.setUint32(result, bytes.length, true);
      const view = new Uint8Array(this.memory.buffer, result + 4, bytes.length);
      view.set(bytes);
      const pad = (4 - (bytes.length % 4)) % 4;
      this._returnHeapPtr += 4 + bytes.length + pad;
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

    // Make canvas focusable
    element.setAttribute('tabindex', '0');
    element.style.outline = 'none';

    // ========== MOUSE EVENTS ==========
    element.addEventListener('mousemove', (e) => {
      const rect = element.getBoundingClientRect();
      self.mouseX = e.clientX - rect.left;
      self.mouseY = e.clientY - rect.top;
      const handler = self.pointerMoveHandlers.get(canvasId);
      if (handler) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    element.addEventListener('mousedown', (e) => {
      const button = e.button;
      if (button < 3) {
        self.mouseButtons[button] = true;
        self.mouseButtonsJustPressed[button] = true;
      }
      element.focus();
      const handler = self.pointerDownHandlers.get(canvasId);
      if (handler) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    element.addEventListener('mouseup', (e) => {
      const button = e.button;
      if (button < 3) {
        self.mouseButtons[button] = false;
        self.mouseButtonsJustReleased[button] = true;
      }
      const handler = self.pointerUpHandlers.get(canvasId);
      if (handler) self._callExport(handler, canvasId, self.mouseX, self.mouseY);
    });

    element.addEventListener('mouseleave', () => {
      self.mouseButtons = [false, false, false];
    });

    element.addEventListener('wheel', (e) => {
      self.mouseWheelX = e.deltaX;
      self.mouseWheelY = e.deltaY;
    });

    element.addEventListener('contextmenu', (e) => e.preventDefault());

    // ========== KEYBOARD EVENTS ==========
    element.addEventListener('keydown', (e) => {
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
      if (handler) self._callExport(handler, canvasId);
    });

    element.addEventListener('keyup', (e) => {
      const key = e.key;
      self.keysDown.delete(key);
      self.keysJustReleased.add(key);
      self.eventKey = key;

      const handler = self.keyUpHandlers.get(canvasId);
      if (handler) self._callExport(handler, canvasId);
    });

    // ========== TOUCH EVENTS ==========
    element.addEventListener('touchstart', (e) => {
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

    element.addEventListener('touchmove', (e) => {
      e.preventDefault();
      self._updateTouches(e.touches, element);
      if (e.touches.length > 0) {
        const rect = element.getBoundingClientRect();
        self.mouseX = e.touches[0].clientX - rect.left;
        self.mouseY = e.touches[0].clientY - rect.top;
      }
    });

    element.addEventListener('touchend', (e) => {
      e.preventDefault();
      self.touchEnded = true;
      self._updateTouches(e.touches, element);
      if (e.touches.length === 0) {
        self.mouseButtons[0] = false;
        self.mouseButtonsJustReleased[0] = true;
      }
    });

    element.addEventListener('touchcancel', (e) => {
      self.touchEnded = true;
      self._updateTouches(e.touches, element);
      self.mouseButtons[0] = false;
    });

    // ========== GAMEPAD POLLING ==========
    // Gamepads are polled each frame, not event-driven
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
          p.x += p.vx * dt;
          p.y += p.vy * dt;
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
  // 0 = right, -90 = up), sizeMin/sizeMax, color, shape, rate, burst,
  // gravity, drag, windX/windY, attractorX/attractorY/attractorStrength,
  // turbulenceStrength/turbulenceScale,
  // alphaStart/alphaEnd, sizeStart/sizeEnd (multipliers).
  _spawnParticle(x, y, cfg) {
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
          ctx.fillStyle = p.color;
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

          self.canvases.set(id, {
            element: canvas,
            ctx: ctx,
            width: width,
            height: height
          });

          self.setupInputHandlers(id, canvas);

          if (!isCanvas) {
            const container = document.getElementById('canvas-container') || document.body;
            container.appendChild(canvas);
          }

          console.log(`[CanvasBridge] Canvas ${id} created: ${width}x${height}`);
          return id;
        },

        _canvas_clear(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.clearRect(0, 0, entry.width, entry.height);
          return 0;
        },

        _canvas_clear_color(canvasId, colorPtr, colorLen) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          const color = self.readString(colorPtr, colorLen);
          entry.ctx.fillStyle = color;
          entry.ctx.fillRect(0, 0, entry.width, entry.height);
          return 0;
        },

        _canvas_present(canvasId) {
          return self.canvases.has(canvasId) ? 0 : -1;
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
        // calls extend it; _canvas_fill_path commits it with a fill color.
        // Stroke-the-current-path is intentionally not bridged here — strokes
        // go through the immediate-mode shape functions (_canvas_line,
        // _canvas_*_outline) which manage their own paths.

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

        _canvas_set_fps(canvasId, fps) {
          // The animation loop uses requestAnimationFrame at the browser's
          // native refresh rate; we store the target only so _canvas_get_fps
          // reflects the requested target.
          if (fps > 0) self.targetFps = fps;
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

        _canvas_request_frame(canvasId) {
          const frameId = self.nextFrameId++;
          console.log('[CanvasBridge] _canvas_request_frame called, frameId:', frameId, 'canvasId:', canvasId);

          let debugFrameCount = 0;
          const callback = (timestamp) => {
            // Calculate delta time
            self.deltaTime = Math.min((timestamp - self.lastFrameTime) / 1000, 0.1);
            self.lastFrameTime = timestamp;

            // Debug first few frames
            debugFrameCount++;
            if (debugFrameCount <= 3) {
              console.log('[CanvasBridge] Animation frame', debugFrameCount, 'wasmInstance:', !!self.wasmInstance, 'has _frame_callback:', !!(self.wasmInstance && self.wasmInstance.exports._frame_callback));
            }

            // Calculate FPS
            self.frameCount++;
            if (timestamp - self.fpsLastTime >= 1000) {
              self.fps = self.frameCount;
              self.frameCount = 0;
              self.fpsLastTime = timestamp;
            }

            // Poll gamepads
            self._pollGamepads();

            // Update camera shake
            if (self.cameraShakeDuration > 0) {
              const elapsed = (performance.now() - self.cameraShakeStart) / 1000;
              if (elapsed >= self.cameraShakeDuration) {
                self.cameraShakeDuration = 0;
                self.cameraShakeIntensity = 0;
              }
            }

            // Update camera follow before WASM frame so reads inside onFrame
            // see the new position.
            if (self.cameraFollowX !== null) {
              const targetX = self.cameraFollowX + self.cameraOffsetX;
              const targetY = self.cameraFollowY + self.cameraOffsetY;
              if (self.cameraFollowSmoothing > 0) {
                const lerp = Math.min(1, 1 - Math.pow(1 - 0.1, self.cameraFollowSmoothing * 60 * self.deltaTime));
                self.cameraX += (targetX - self.cameraX) * lerp;
                self.cameraY += (targetY - self.cameraY) * lerp;
              } else {
                self.cameraX = targetX;
                self.cameraY = targetY;
              }
              if (self.cameraBounds) {
                const b = self.cameraBounds;
                self.cameraX = Math.max(b.x, Math.min(b.x + b.w, self.cameraX));
                self.cameraY = Math.max(b.y, Math.min(b.y + b.h, self.cameraY));
              }
            }

            // Tick named tweens, timelines, animsprites, particles. Must run
            // before _frame_callback so user draw code reads up-to-date state.
            self._updateAnimations(self.deltaTime);

            // Call WASM frame handler
            if (self.wasmInstance && self.wasmInstance.exports._frame_callback) {
              try {
                self.wasmInstance.exports._frame_callback(canvasId);
                self._drawParticles(canvasId);
              } catch (err) {
                console.error('[CanvasBridge] Frame callback error:', err);
              }
            } else if (debugFrameCount <= 3) {
              console.log('[CanvasBridge] Skipping frame callback - wasmInstance not set');
            }

            // Clear per-frame input state
            self._clearFrameInputState();

            // Continue animation loop
            if (self.animationFrames.has(frameId)) {
              self.animationFrames.set(frameId, requestAnimationFrame(callback));
            }
          };

          self.animationFrames.set(frameId, requestAnimationFrame(callback));
          return frameId;
        },

        _canvas_cancel_frame(frameId) {
          const rafId = self.animationFrames.get(frameId);
          if (rafId) {
            cancelAnimationFrame(rafId);
            self.animationFrames.delete(frameId);
            return 0;
          }
          return -1;
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

        _camera_apply(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;

          const ctx = entry.ctx;
          ctx.save();

          // Apply shake
          let shakeX = 0, shakeY = 0;
          if (self.cameraShakeDuration > 0) {
            const elapsed = (performance.now() - self.cameraShakeStart) / 1000;
            if (elapsed < self.cameraShakeDuration) {
              const decay = 1 - self._evalEaseId(self.cameraShakeEasing | 0, elapsed / self.cameraShakeDuration);
              shakeX = (Math.random() - 0.5) * 2 * self.cameraShakeIntensity * decay;
              shakeY = (Math.random() - 0.5) * 2 * self.cameraShakeIntensity * decay;
            }
          }

          // Center on canvas
          ctx.translate(entry.width / 2, entry.height / 2);

          // Apply rotation
          if (self.cameraRotation !== 0) {
            ctx.rotate(self.cameraRotation * Math.PI / 180);
          }

          // Apply zoom
          ctx.scale(self.cameraZoom, self.cameraZoom);

          // Apply position (inverted for camera effect)
          ctx.translate(-self.cameraX + shakeX, -self.cameraY + shakeY);

          return 0;
        },

        _camera_reset(canvasId) {
          const entry = self.canvases.get(canvasId);
          if (!entry) return -1;
          entry.ctx.restore();
          return 0;
        },

        _camera_screen_to_world_x(screenX) {
          const entry = self.canvases.values().next().value;
          if (!entry) return screenX;
          return (screenX - entry.width / 2) / self.cameraZoom + self.cameraX;
        },

        _camera_screen_to_world_y(screenY) {
          const entry = self.canvases.values().next().value;
          if (!entry) return screenY;
          return (screenY - entry.height / 2) / self.cameraZoom + self.cameraY;
        },

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

        _scene_get_current() {
          return self.writeString(self.currentScene || '');
        },

        _scene_change(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const prev = self.currentScene;
          if (prev && self.onExitHandlers.has(prev)) {
            self._callExport(self.onExitHandlers.get(prev));
          }
          self.currentScene = name;
          self.sceneStack = [name];
          console.log(`[CanvasBridge] Scene changed to: ${name}`);
          return 0;
        },

        _scene_change_animated(namePtr, nameLen, transitionPtr, transitionLen, duration) {
          const name = self.readString(namePtr, nameLen);
          const transition = self.readString(transitionPtr, transitionLen);
          const prev = self.currentScene;
          if (prev && self.onExitHandlers.has(prev)) {
            self._callExport(self.onExitHandlers.get(prev));
          }
          // Persist the transition + duration in pageStore so the next scene's
          // init can render its enter animation if desired.
          self.pageStore.set('__scene_transition', JSON.stringify({ from: prev, to: name, kind: transition, duration }));
          self.currentScene = name;
          self.sceneStack = [name];
          console.log(`[CanvasBridge] Scene change animated: ${prev}→${name} via ${transition} (${duration}s)`);
          return 0;
        },

        _scene_push(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          const prev = self.currentScene;
          if (prev && self.onPauseHandlers.has(prev)) {
            self._callExport(self.onPauseHandlers.get(prev));
          }
          self.sceneStack.push(name);
          self.currentScene = name;
          console.log(`[CanvasBridge] Scene pushed: ${name}`);
          return 0;
        },

        _scene_pop() {
          if (self.sceneStack.length > 1) {
            const prev = self.sceneStack.pop();
            if (prev && self.onExitHandlers.has(prev)) {
              self._callExport(self.onExitHandlers.get(prev));
            }
            self.currentScene = self.sceneStack[self.sceneStack.length - 1];
            if (self.currentScene && self.onResumeHandlers.has(self.currentScene)) {
              self._callExport(self.onResumeHandlers.get(self.currentScene));
            }
            console.log(`[CanvasBridge] Scene popped, current: ${self.currentScene}`);
            return 0;
          }
          return -1;
        },

        _scene_set(keyPtr, keyLen, valPtr, valLen) {
          const key = self.readString(keyPtr, keyLen);
          const val = self.readString(valPtr, valLen);
          self.sceneParams.set(key, val);
          return 0;
        },

        _scene_get(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.writeString(self.sceneParams.get(key) || '');
        },

        // ====================================================================
        // PAGE / UI BRIDGE
        // ====================================================================

        _page_set(keyPtr, keyLen, valPtr, valLen) {
          const key = self.readString(keyPtr, keyLen);
          const val = self.readString(valPtr, valLen);
          self.pageStore.set(key, val);
          // Forward to the surrounding page via a CustomEvent so the
          // enclosing app (frame.ui or vanilla page) can subscribe.
          if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('clean-canvas-page-set', { detail: { key, value: val } }));
          }
          return 0;
        },

        _page_get(keyPtr, keyLen) {
          const key = self.readString(keyPtr, keyLen);
          return self.writeString(self.pageStore.get(key) || '');
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

        _layer_declare(namePtr, nameLen, z) {
          const name = self.readString(namePtr, nameLen);
          self.namedLayers.set(name, { z, drawCalls: [] });
          self.layerOrder = [...self.namedLayers.entries()]
            .sort((a, b) => a[1].z - b[1].z)
            .map(([k]) => k);
          return 0;
        },

        _layer_begin(namePtr, nameLen) {
          const name = self.readString(namePtr, nameLen);
          self.currentLayer = name;
          return 0;
        },

        _layer_end() {
          self.currentLayer = null;
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

        _canvas_on_exit(canvasId) {
          self.onExitHandlers.set(self.currentScene || 'default', '_on_exit');
          return 0;
        },

        _canvas_on_pause(canvasId) {
          self.onPauseHandlers.set(self.currentScene || 'default', '_on_pause');
          return 0;
        },

        _canvas_on_resume(canvasId) {
          self.onResumeHandlers.set(self.currentScene || 'default', '_on_resume');
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
    // Cancel all animation frames
    for (const [frameId, rafId] of this.animationFrames) {
      cancelAnimationFrame(rafId);
    }
    this.animationFrames.clear();

    // Stop all sounds
    for (const [id, instance] of this.soundInstances) {
      try { instance.source.stop(); } catch (e) { }
    }
    this.soundInstances.clear();

    // Stop music
    if (this.currentMusicElement) {
      this.currentMusicElement.pause();
      this.currentMusicElement = null;
    }

    // Remove all canvas elements
    for (const [id, entry] of this.canvases) {
      entry.element.remove();
    }
    this.canvases.clear();

    console.log('[CanvasBridge] Destroyed');
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
