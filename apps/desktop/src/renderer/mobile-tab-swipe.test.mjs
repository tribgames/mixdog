import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  shouldCommitSwipe,
  swipeIntent,
  swipeProgress,
  swipeTransitionFallbackCommits,
  swipeTargetIndex,
} from "./mobile-tab-swipe.ts";

const dom = new JSDOM(
  '<!doctype html><html><body><div class="pane-cell" data-pane-id="leaf-1">'
  + '<div class="surface"></div><pre class="code"></pre></div></body></html>',
  { url: "https://mixdog.test/" },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;

const { installMobileTabSwipe } = await import("./mobile-tab-swipe-gesture.ts");

const root = dom.window.document.documentElement;
const cell = dom.window.document.querySelector("[data-pane-id]");
const surface = dom.window.document.querySelector(".surface");
const codeBlock = dom.window.document.querySelector(".code");

function touch(target, type, x, y, time) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  const points = [{ clientX: x, clientY: y }];
  Object.defineProperty(event, type === "touchend" ? "changedTouches" : "touches", {
    value: points,
  });
  if (type === "touchend") Object.defineProperty(event, "touches", { value: [] });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
  return event;
}

// jsdom lays nothing out, and the release thresholds are a fraction of the
// pane width, so the gesture needs a realistic phone-sized pane box.
cell.getBoundingClientRect = () => ({
  width: 400,
  height: 800,
  left: 0,
  top: 0,
  right: 400,
  bottom: 800,
  x: 0,
  y: 0,
});

const settled = () => new Promise((resolve) => dom.window.setTimeout(resolve, 0));

let visibilityState = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});
function setPageHidden(hidden) {
  visibilityState = hidden ? "hidden" : "visible";
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

/** Browser seam: an interactive view transition plus scrubable snapshots.
 *  Installing it makes the gesture take the animated path; omitting it is the
 *  browser that cannot, which must still switch tabs.
 *
 *  `deferUpdate` models the REAL contract the synchronous default hides: the
 *  update callback runs asynchronously, `ready` only settles after it, and
 *  skipping a transition whose callback is still pending runs that callback
 *  (skip drops the animation, not the DOM update). */
function installViewTransitionStub({ deferUpdate = false } = {}) {
  const state = {
    transitions: 0,
    skipped: 0,
    updatesRun: 0,
    animations: [],
    finish: () => {},
    runUpdate: () => {},
  };
  dom.window.document.startViewTransition = (update) => {
    state.transitions += 1;
    let markReady = () => {};
    const ready = new Promise((resolve) => { markReady = resolve; });
    let updateDone = false;
    const runUpdate = () => {
      if (updateDone) return;
      updateDone = true;
      state.updatesRun += 1;
      update();
      markReady();
    };
    state.runUpdate = runUpdate;
    if (!deferUpdate) runUpdate();
    let settleFinished = () => {};
    const finished = new Promise((resolve) => { settleFinished = resolve; });
    state.finish = settleFinished;
    return {
      ready,
      finished,
      // A real skipped transition also FULFILS `finished`, and still runs a
      // not-yet-executed update callback.
      skipTransition: () => {
        state.skipped += 1;
        runUpdate();
        settleFinished();
      },
    };
  };
  dom.window.Element.prototype.animate = function animate() {
    const animation = {
      currentTime: 0,
      playbackRate: 1,
      played: false,
      cancelled: false,
      paused: false,
      finished: Promise.resolve(),
      play() { this.played = true; },
      pause() { this.paused = true; },
      cancel() { this.cancelled = true; },
    };
    state.animations.push(animation);
    return animation;
  };
  return {
    state,
    remove() {
      delete dom.window.document.startViewTransition;
      delete dom.window.Element.prototype.animate;
    },
  };
}

function swipeHarness(activeKey = "session:a") {
  const activations = [];
  const focused = [];
  const workspace = {
    leaves: [{
      id: "leaf-1",
      activeKey,
      tabs: [
        { kind: "session", id: "a" },
        { kind: "session", id: "b" },
        { kind: "session", id: "c" },
      ],
    }],
    activateTab: (leafId, key) => {
      activations.push([leafId, key]);
      workspace.leaves[0].activeKey = key;
    },
  };
  const uninstall = installMobileTabSwipe({
    workspace: () => workspace,
    onFocusSelection: (selection) => focused.push(selection),
  });
  return { activations, focused, uninstall, workspace };
}

test("only a decisive horizontal drag steps to the neighbouring tab", () => {
  for (const [deltaX, deltaY, intent] of [
    [-120, 10, "next"],
    [120, -10, "previous"],
    // A vertical scroll that drifts sideways belongs to the scroller…
    [-70, 200, null],
    // …and so does an ambiguous diagonal, while a decisive one does not.
    [-70, 40, null],
    [-100, 40, "next"],
    // Too short to be a swipe at all.
    [-40, 0, null],
  ]) {
    assert.equal(swipeIntent(deltaX, deltaY), intent, `dx=${deltaX} dy=${deltaY}`);
  }
});

test("the strip wraps across both ends and a single-tab pane never moves", () => {
  for (const [activeIndex, tabCount, intent, landing] of [
    [0, 3, "previous", 2],
    [2, 3, "next", 0],
    [1, 3, "next", 2],
    [1, 3, "previous", 0],
    [0, 1, "next", 0],
  ]) {
    assert.equal(swipeTargetIndex(activeIndex, tabCount, intent), landing,
      `${activeIndex}/${tabCount} ${intent}`);
  }
});

test("interactive progress follows only the locked direction", () => {
  assert.equal(swipeProgress(-90, 300, "next"), 0.3);
  assert.equal(swipeProgress(90, 300, "next"), 0);
  assert.equal(swipeProgress(150, 300, "previous"), 0.5);
  assert.equal(swipeProgress(-600, 300, "next"), 1);
});

test("release commits by distance or directional velocity", () => {
  assert.equal(shouldCommitSwipe(-59, 300, -0.2, "next"), false);
  assert.equal(shouldCommitSwipe(-60, 300, -0.2, "next"), true);
  assert.equal(shouldCommitSwipe(-60, 1_040, -0.2, "next"), true);
  assert.equal(shouldCommitSwipe(-30, 300, -0.5, "next"), true);
  assert.equal(shouldCommitSwipe(-30, 300, 0.8, "next"), false);
});

// The gesture tests below reach the fallback with `null` (page hidden before
// release) and `true` (committed release); a release that decided AGAINST the
// turn and only then hit a browser failure is reachable nowhere else.
test("a failed interactive transition rolls back an explicit no-commit release", () => {
  assert.equal(swipeTransitionFallbackCommits(false), false);
});

test("an early lock starts the interactive transition and scrubs its snapshots", async () => {
  const view = installViewTransitionStub();
  const { activations, focused, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    // 8px of mostly horizontal travel locks the page turn and swaps the tab
    // INSIDE the transition callback, so the browser can snapshot both sides.
    touch(surface, "touchmove", 280, 202, 16);
    assert.equal(view.state.transitions, 1);
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
    assert.deepEqual(focused, [{ kind: "session", id: "b" }]);
    assert.equal(root.dataset.mobileTabSwipe, "next");
    assert.equal(cell.dataset.mobileTabSwipeSurface, "true");
    // The pane itself is never transformed: the snapshots carry the movement.
    assert.equal(cell.style.getPropertyValue("--mobile-tab-swipe-x"), "");
    await settled();
    assert.equal(view.state.animations.length, 2);
    assert.equal(view.state.animations.every((animation) => animation.paused), true);

    touch(surface, "touchmove", 180, 204, 32);
    touch(surface, "touchend", 160, 204, 48);
    await settled();
    // Release completes the page turn and hands the surface back.
    assert.equal(view.state.animations.every((animation) => animation.played), true);
    assert.equal(view.state.skipped, 1);
    assert.equal(root.dataset.mobileTabSwipe, undefined);
    assert.equal(cell.dataset.mobileTabSwipeSurface, undefined);
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
  } finally {
    uninstall();
    view.remove();
  }
});

test("an abandoned interactive swipe restores the original tab", async () => {
  const view = installViewTransitionStub();
  const { activations, focused, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 288, 202, 16);
    await settled();
    // A short, slow release is under both thresholds, so the turn reverses.
    touch(surface, "touchend", 290, 202, 400);
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"], ["leaf-1", "session:a"]]);
    assert.deepEqual(focused.at(-1), { kind: "session", id: "a" });
    assert.equal(root.dataset.mobileTabSwipe, undefined);
  } finally {
    uninstall();
    view.remove();
  }
});

test("a page hidden mid-swipe releases the turn and swipes again after restore", async () => {
  const view = installViewTransitionStub();
  const { activations, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 280, 202, 16);
    await settled();
    assert.equal(root.dataset.mobileTabSwipe, "next");

    // Backgrounded before release: no decision was made, so the turn rolls
    // back and nothing is left holding the gesture.
    setPageHidden(true);
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"], ["leaf-1", "session:a"]]);
    assert.equal(root.dataset.mobileTabSwipe, undefined);
    assert.equal(cell.dataset.mobileTabSwipeSurface, undefined);

    setPageHidden(false);
    touch(surface, "touchstart", 300, 200, 100);
    touch(surface, "touchmove", 280, 202, 116);
    await settled();
    touch(surface, "touchend", 120, 204, 148);
    await settled();
    // A restored page turns the page normally instead of ignoring every touch.
    assert.equal(view.state.transitions, 2);
    assert.deepEqual(activations, [
      ["leaf-1", "session:b"],
      ["leaf-1", "session:a"],
      ["leaf-1", "session:b"],
    ]);
  } finally {
    uninstall();
    view.remove();
    setPageHidden(false);
  }
});

test("a page hidden before the transition update runs cannot commit the tab", async () => {
  const view = installViewTransitionStub({ deferUpdate: true });
  const { activations, focused, uninstall, workspace } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 280, 202, 16);
    assert.equal(view.state.transitions, 1);
    // The browser has not run the update yet, so no tab has moved.
    assert.deepEqual(activations, []);

    // Hidden with NO release decision: the pending update must be invalidated,
    // not merely left behind — skipping the transition still calls it.
    setPageHidden(true);
    await settled();
    assert.equal(view.state.updatesRun, 1);
    // A late callback (or one the browser runs on its own) is inert too.
    view.state.runUpdate();
    await settled();
    assert.deepEqual(activations, []);
    assert.deepEqual(focused, []);
    assert.equal(workspace.leaves[0].activeKey, "session:a");
    assert.equal(root.dataset.mobileTabSwipe, undefined);
    assert.equal(cell.dataset.mobileTabSwipeSurface, undefined);

    // And the gesture is still usable once the page comes back.
    setPageHidden(false);
    touch(surface, "touchstart", 300, 200, 100);
    touch(surface, "touchmove", 280, 202, 116);
    assert.equal(view.state.transitions, 2);
    view.state.runUpdate();
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
    touch(surface, "touchend", 120, 204, 148);
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
  } finally {
    uninstall();
    view.remove();
    setPageHidden(false);
  }
});

test("a page hidden after a commit release still turns the page exactly once", async () => {
  const view = installViewTransitionStub({ deferUpdate: true });
  const { activations, focused, uninstall, workspace } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 280, 202, 16);
    // Decisive release while the update is still pending: the decision was
    // recorded, so the target is applied — once — even though the callback
    // that would have applied it is invalidated.
    touch(surface, "touchend", 120, 204, 48);
    setPageHidden(true);
    await settled();
    view.state.runUpdate();
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
    assert.deepEqual(focused, [{ kind: "session", id: "b" }]);
    assert.equal(workspace.leaves[0].activeKey, "session:b");
    assert.equal(root.dataset.mobileTabSwipe, undefined);
  } finally {
    uninstall();
    view.remove();
    setPageHidden(false);
  }
});

test("a transition the browser finishes by itself does not strand the gesture", async () => {
  const view = installViewTransitionStub();
  const { activations, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 280, 202, 16);
    await settled();
    // The browser skipped the transition and fulfilled `finished` on its own.
    view.state.finish();
    await settled();
    assert.deepEqual(activations, [["leaf-1", "session:b"], ["leaf-1", "session:a"]]);
    assert.equal(root.dataset.mobileTabSwipe, undefined);

    touch(surface, "touchstart", 300, 200, 100);
    touch(surface, "touchmove", 280, 202, 116);
    await settled();
    touch(surface, "touchend", 120, 204, 148);
    await settled();
    assert.equal(view.state.transitions, 2);
    assert.equal(activations.length, 3);
  } finally {
    uninstall();
    view.remove();
  }
});

test("a browser without interactive transitions still steps to the next tab", () => {
  const { activations, focused, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 280, 202, 16);
    // No snapshot exists, so nothing is marked and nothing moves until release.
    assert.equal(root.dataset.mobileTabSwipe, undefined);
    assert.deepEqual(activations, []);
    touch(surface, "touchend", 160, 204, 48);
    assert.deepEqual(activations, [["leaf-1", "session:b"]]);
    assert.deepEqual(focused, [{ kind: "session", id: "b" }]);
  } finally {
    uninstall();
  }
});

test("a discrete swipe wraps backwards past the first tab", () => {
  const { activations, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 100, 200, 0);
    touch(surface, "touchmove", 200, 200, 16);
    touch(surface, "touchend", 260, 200, 32);
    assert.deepEqual(activations, [["leaf-1", "session:c"]]);
  } finally {
    uninstall();
  }
});

test("a mostly vertical drag never switches tabs", () => {
  const view = installViewTransitionStub();
  const { activations, uninstall } = swipeHarness();
  try {
    touch(surface, "touchstart", 300, 200, 0);
    touch(surface, "touchmove", 296, 260, 16);
    touch(surface, "touchend", 292, 400, 32);
    assert.deepEqual(activations, []);
    assert.equal(view.state.transitions, 0);
    assert.equal(root.dataset.mobileTabSwipe, undefined);
  } finally {
    uninstall();
    view.remove();
  }
});

test("a surface that owns horizontal gestures keeps the swipe", () => {
  const { activations, uninstall } = swipeHarness();
  try {
    touch(codeBlock, "touchstart", 300, 200, 0);
    touch(codeBlock, "touchmove", 180, 202, 16);
    touch(codeBlock, "touchend", 160, 202, 32);
    assert.deepEqual(activations, []);
  } finally {
    uninstall();
  }
});

test("an uninstalled gesture no longer answers touches", () => {
  const { activations, uninstall } = swipeHarness();
  uninstall();
  touch(surface, "touchstart", 300, 200, 0);
  touch(surface, "touchmove", 180, 200, 16);
  touch(surface, "touchend", 160, 200, 32);
  assert.deepEqual(activations, []);
  assert.equal(root.dataset.mobileTabSwipe, undefined);
});
