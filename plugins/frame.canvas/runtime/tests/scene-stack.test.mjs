/**
 * scene-stack.test.mjs — scene management in the browser runtime: three
 * compiled scenes (Menu, Game, Pause) run by the scene manager
 * (loader.js CleanCanvasScenes) over a recording page canvas.
 *
 *   - scene.change starts the named scene's module with its declared state
 *     and ends the old one (onExit) — CVS-S001, CVS-S008
 *   - scene.set values reach the next scene's init: through typed
 *     scene.get, then are dropped — CVS-S003, CVS-S004
 *   - scene.push keeps the covered scene running underneath, without input,
 *     after onPause; scene.pop ends the top scene and resumes the one below
 *     — CVS-S002, CVS-S007, CVS-X009
 *   - scene.changeTo draws its transition; a hidden tab pauses the top
 *     scene — CVS-S009
 *
 *   node plugins/frame.canvas/runtime/tests/scene-stack.test.mjs
 *
 * Exit 0 when every check passes, 1 otherwise.
 */

import { checker, cleanup, compileScene, fills, installPage, loadRuntime, makeCanvas, near, quietRuntimeLogs, requireCompiler } from './lib/harness.mjs';

const SUITE = 'frame.canvas scene stack';
requireCompiler(SUITE);
quietRuntimeLogs();

const screen = makeCanvas('screen', 200, 100);
const page = installPage([screen]);
const { CleanCanvasScenes } = loadRuntime();
const result = checker();
const { check } = result;

// page.set values land in the page store the HTML layer shares.
const pageState = new Map();
globalThis.window.__cleanRuntime = { pageState, _providers: [] };
const pageValue = (key) => (pageState.has(key) ? JSON.parse(pageState.get(key)) : undefined);

const scene = (body) => `plugins:\n\tframe.canvas\n\ncanvasScene: id="screen" width=200 height=100\n\n${body}\n`;

const sources = {
  Menu: scene(`\tstate:
\t\tinteger visits = 0
\t\tinteger menuFrames = 0

\tinit:
\t\tvisits = visits + 1
\t\tpage.set "menuVisits" value=visits

\tdraw:
\t\tcanvas.clear color="#menu"

\tonFrame: param="dt"
\t\tmenuFrames = menuFrames + 1

\tonPointerDown:
\t\tscene.set "level" value=3
\t\tscene.set "speed" value=2.5
\t\tscene.set "hard" value=true
\t\tscene.set "who" value="Ann"
\t\tscene.change "Game"

\tonKeyDown: param="key"
\t\tscene.changeTo "Game" transition=key duration=1.0

\tonExit:
\t\tpage.set "menuExits" value=menuFrames`),
  Game: scene(`\tstate:
\t\tinteger level = 0
\t\tnumber speed = 0.0
\t\tboolean hard = false
\t\tinteger frames = 0
\t\tinteger pauses = 0
\t\tinteger resumes = 0
\t\tinteger clicks = 0

\tinit:
\t\tlevel = scene.get "level"
\t\tspeed = scene.get "speed"
\t\thard = scene.get "hard"
\t\tstring who = scene.get "who"
\t\tinteger again = scene.get "level"
\t\tpage.set "gameLevel" value=level
\t\tpage.set "gameSpeed" value=speed
\t\tpage.set "gameHard" value=hard
\t\tpage.set "gameWho" value=who

\tdraw:
\t\tcanvas.clear color="#game"

\tonFrame: param="dt"
\t\tframes = frames + 1
\t\tpage.set "gameFrames" value=frames

\tonPointerDown:
\t\tclicks = clicks + 1
\t\tpage.set "gameClicks" value=clicks
\t\tscene.push "Pause"

\tonKeyDown: param="key"
\t\tscene.change "Menu"

\tonPause:
\t\tpauses = pauses + 1
\t\tpage.set "gamePauses" value=pauses

\tonResume:
\t\tresumes = resumes + 1
\t\tpage.set "gameResumes" value=resumes`),
  Pause: scene(`\tstate:
\t\tinteger level = 0

\tinit:
\t\tlevel = scene.get "level"
\t\tpage.set "pauseLevel" value=level

\tdraw:
\t\tcanvas.rect x=0 y=0 width=10 height=10 color="#pause"

\tonPointerDown:
\t\tscene.pop

\tonExit:
\t\tpage.set "pauseExits" value=1`),
};

const modules = new Map(Object.entries(sources).map(([name, src]) => [`https://game.test/scenes/${name}.wasm`, compileScene(src, name)]));
const fetched = [];
const scenes = new CleanCanvasScenes({
  fetchBytes: async (url) => {
    fetched.push(url);
    if (!modules.has(url)) throw new Error(`404 ${url}`);
    return modules.get(url);
  },
});

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
let now = 1000;
const frames = (n) => { for (let i = 0; i < n; i++) { now += 1000 / 60; page.frame(now); } };
const topName = () => scenes.top && scenes.top.bridge.sceneName;

// --- the first scene -------------------------------------------------------

const app = await quiet(() => scenes.open('https://game.test/scenes/Menu.wasm'));
scenes._start(app.loader);
frames(3);
check(topName() === 'Menu' && pageValue('menuVisits') === 1, 'the first scene starts with its state (Menu, visits = 1)');
check(fills(screen.ctx).at(-1) === '#menu', 'the stack is composited on the page canvas');

// --- scene.change, scene.set / scene.get ----------------------------------

screen.fire('mousedown');
await scenes.settled();
frames(1);
check(topName() === 'Game' && scenes.stack.length === 1, `scene.change "Game" runs Game alone (top ${topName()}, ${scenes.stack.length} scene(s))`);
check(fetched.at(-1) === 'https://game.test/scenes/Game.wasm', `scene "Game" is the module Game.wasm next to the first one (${fetched.at(-1)})`);
check(pageValue('menuExits') === 3, `onExit ran when Menu was replaced, after its last frame (menuExits ${pageValue('menuExits')})`);
check(pageValue('gameLevel') === 3 && pageValue('gameSpeed') === 2.5 && pageValue('gameHard') === true && pageValue('gameWho') === 'Ann',
  `scene.get reads the scene.set values by the receiver's type (level ${pageValue('gameLevel')}, speed ${pageValue('gameSpeed')}, hard ${pageValue('gameHard')}, who ${pageValue('gameWho')})`);
check(scenes.params.size === 0, 'scene.set values are dropped once the next init: has read them');
check(fills(screen.ctx).at(-1) === '#game', 'Game draws on the page canvas');
const menuListeners = screen.listenerCount();

// --- scene.push / scene.pop ------------------------------------------------

const framesBefore = pageValue('gameFrames');
screen.fire('mousedown');
await scenes.settled();
check(topName() === 'Pause' && scenes.stack.length === 2, 'scene.push "Pause" puts Pause on top of Game');
check(pageValue('gamePauses') === 1, 'the covered scene gets onPause (CVS-S007)');
check(pageValue('pauseLevel') === 0, 'scene.get with no scene.set reads 0: the values went to the scene they were set for');
screen.ctx.log.length = 0;
frames(2);
check(pageValue('gameFrames') === framesBefore + 2, 'the covered scene keeps running underneath (CVS-S007)');
check(JSON.stringify(fills(screen.ctx).slice(-2)) === '["#game","#pause"]', `the stack is drawn bottom to top (fills ${JSON.stringify(fills(screen.ctx).slice(-2))})`);
screen.fire('mousedown');
await scenes.settled();
check(pageValue('gameClicks') === 1, 'only the top scene receives input');
check(topName() === 'Game' && scenes.stack.length === 1, 'scene.pop ends Pause and returns to Game');
check(pageValue('pauseExits') === 1 && pageValue('gameResumes') === 1, 'the popped scene gets onExit, the uncovered one onResume (CVS-S008)');
check(screen.listenerCount() === menuListeners, 'a scene that leaves the stack releases its input listeners');
const errors = [];
const logError = console.error;
console.error = (...a) => errors.push(a.join(' '));
const popped = scenes.top.bridge.getImports(scenes.top.memory).env._scene_pop();
console.error = logError;
check(popped === -1 && scenes.stack.length === 1 && errors.some((e) => /CVS-X009/.test(e)), 'scene.pop on the last scene is refused (CVS-X009)');

// --- CVS-S001: a changed-to scene starts with its declared state ------------

screen.fire('keydown', { key: 'x' });
await scenes.settled();
frames(1);
check(topName() === 'Menu' && pageValue('menuVisits') === 1, `scene.change back to Menu starts it over (visits ${pageValue('menuVisits')}, not 2)`);

// --- scene.changeTo transitions --------------------------------------------

screen.fire('keydown', { key: 'crossfade' });
await scenes.settled();
screen.ctx.log.length = 0;
frames(1); // first frame of the transition (t = 0)
now += 500;
screen.ctx.log.length = 0;
page.frame(now); // half way
const log = screen.ctx.log;
const alphaAtGame = (() => {
  let alpha = 1;
  let seenMenu = false;
  for (const e of log) {
    if (e[0] === 'set' && e[1] === 'globalAlpha') alpha = e[2];
    if (e[0] === 'set' && e[1] === 'fillStyle' && e[2] === '#menu') seenMenu = true;
    if (e[0] === 'set' && e[1] === 'fillStyle' && e[2] === '#game' && seenMenu) return alpha;
  }
  return null;
})();
check(alphaAtGame !== null && near(alphaAtGame, 0.5, 0.05), `crossfade: Menu then Game at half opacity half way (alpha ${alphaAtGame})`);
now += 600;
screen.ctx.log.length = 0;
page.frame(now);
check(scenes.transition === null && JSON.stringify(fills(screen.ctx)) === '["#game"]', 'after its duration the transition ends');

screen.fire('keydown', { key: 'x' });
await scenes.settled();
frames(2);
screen.fire('keydown', { key: 'slideLeft' });
await scenes.settled();
frames(1);
now += 250;
screen.ctx.log.length = 0;
page.frame(now);
const shifts = screen.ctx.log.filter((e) => e[1] === 'setTransform').map((e) => e[2][4]);
check(shifts.some((x) => near(x, -50, 3)) && shifts.some((x) => near(x, 150, 3)),
  `slideLeft a quarter of the way: Menu at -w/4, Game coming in at 3w/4 (x offsets ${JSON.stringify(shifts)})`);
now += 1000;
page.frame(now);

// --- CVS-S009: tab visibility ----------------------------------------------

pageState.delete('gamePauses');
pageState.delete('gameResumes');
const framesAtHide = pageValue('gameFrames');
page.setHidden(true);
check(pageValue('gamePauses') === 1, 'a hidden tab runs onPause on the top scene (CVS-S009)');
frames(3);
check(pageValue('gameFrames') === framesAtHide, 'no frames run while the tab is hidden');
page.setHidden(false);
check(pageValue('gameResumes') === 1 && scenes.rafId !== 0, 'showing the tab runs onResume and restarts the frame loop');
frames(1);
check(pageValue('gameFrames') === framesAtHide + 1, 'frames run again once the tab is visible');

cleanup();
if (result.failures > 0) {
  console.log(`FAIL: ${SUITE}`);
  process.exit(1);
}
console.log(`PASS: ${SUITE}`);
