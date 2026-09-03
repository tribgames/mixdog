import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  PaneSideDock,
  normalizePaneSideDocks,
  paneDiffStacks,
  paneDockActiveRoot,
  paneDiffShowing,
  samePaneSideDocks,
  withPaneDockDiffClosed,
  withPaneDockDiffOpened,
} from "./pane-side-dock.tsx";

const RIGHT = [["source-control"], ["browser"], ["terminal"], ["pull-requests"]];
const diffA = { kind: "diff", project: "C:/p", rel: "src/a.ts", source: "unstaged" };
const diffB = { kind: "diff", project: "C:/p", rel: "src/b.ts", source: "staged" };
const keyOf = (diff) =>
  `diff:${diff.project}:${diff.source}:${diff.hash || ""}:${diff.rel}`;
const closed = (view = "source-control") =>
  ({ open: false, view, surface: "", diff: null });

test("the strip toggles and the dock header agree on the showing child", () => {
  // Folded: nothing is pressed, whatever the pane remembers.
  assert.equal(paneDockActiveRoot(closed("source-control")), null);
  // A session surface wins over the remembered panel view while it is up.
  assert.equal(
    paneDockActiveRoot({ open: true, view: "source-control", surface: "browser" }),
    "browser",
  );
  assert.equal(
    paneDockActiveRoot({ open: true, view: "source-control", surface: "terminal" }),
    "terminal",
  );
  // The diff pair keeps its Source Control parent pressed.
  assert.equal(
    paneDockActiveRoot({ open: true, view: "source-control", surface: "diff" }),
    "source-control",
  );
  assert.equal(paneDockActiveRoot({ open: true, view: null, surface: "" }), null);
});

test("a pane seen for the first time follows the mode default", () => {
  assert.deepEqual(
    normalizePaneSideDocks(null, ["pane-1"], RIGHT, false),
    { "pane-1": closed() },
  );
  assert.deepEqual(
    normalizePaneSideDocks(null, ["pane-1"], RIGHT, true),
    { "pane-1": { ...closed(), open: true } },
  );
});

test("stored entries survive for live panes and dead panes drop out", () => {
  const stored = {
    "pane-1": { open: true, view: "pull-requests", surface: "", diff: null },
    "pane-9": { open: true, view: "source-control", surface: "", diff: null },
  };
  assert.deepEqual(
    normalizePaneSideDocks(stored, ["pane-1", "pane-2"], RIGHT, false),
    {
      "pane-1": { open: true, view: "pull-requests", surface: "", diff: null },
      "pane-2": closed(),
    },
  );
});

test("a view that left the right side remaps to the first panel view", () => {
  const stored = { "pane-1": { open: true, view: "agents" } };
  assert.deepEqual(
    normalizePaneSideDocks(stored, ["pane-1"], RIGHT, false),
    { "pane-1": { ...closed(), open: true } },
  );
});

test("session-owned tools are surfaces, never the dock's panel view", () => {
  // A legacy launcher-era store with view:"browser" falls back to the first
  // REAL panel view; the browser child itself lives in `surface`.
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "browser" } },
      ["pane-1"],
      [["browser"], ["source-control"]],
      false,
    ),
    { "pane-1": { ...closed(), open: true } },
  );
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "source-control", surface: "browser" } },
      ["pane-1"],
      RIGHT,
      false,
    ),
    { "pane-1": { open: true, view: "source-control", surface: "browser", diff: null } },
  );
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "terminal" } },
      ["pane-1"],
      RIGHT,
      false,
    ),
    { "pane-1": { ...closed(), open: true } },
  );
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "source-control", surface: "terminal" } },
      ["pane-1"],
      RIGHT,
      false,
    ),
    { "pane-1": { open: true, view: "source-control", surface: "terminal", diff: null } },
  );
  // A right side without the browser drops the stored browser surface.
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "source-control", surface: "browser" } },
      ["pane-1"],
      [["source-control"]],
      false,
    ),
    { "pane-1": { open: true, view: "source-control", surface: "", diff: null } },
  );
});

test("the stored diff survives; legacy diff LISTS keep the pointed-at one", () => {
  const stored = {
    "pane-1": {
      open: true,
      view: "source-control",
      surface: "diff",
      diff: diffB,
    },
    // Legacy multi-diff store: the surface key picks its diff.
    "pane-2": {
      open: true,
      view: "source-control",
      surface: keyOf(diffA),
      diffs: [diffA, { kind: "diff", rel: "no-project" }, diffB],
    },
    // A stale surface key degrades to the panel view but keeps the diff.
    "pane-3": {
      open: true,
      view: "source-control",
      surface: "diff:gone",
      diffs: [diffA],
    },
  };
  assert.deepEqual(
    normalizePaneSideDocks(stored, ["pane-1", "pane-2", "pane-3"], RIGHT, false),
    {
      "pane-1": { open: true, view: "source-control", surface: "diff", diff: diffB },
      "pane-2": { open: true, view: "source-control", surface: "diff", diff: diffA },
      "pane-3": { open: true, view: "source-control", surface: "", diff: diffA },
    },
  );
});

test("an empty or launcher-only right side closes every pane dock", () => {
  assert.deepEqual(
    normalizePaneSideDocks(
      { "pane-1": { open: true, view: "source-control" } },
      ["pane-1"],
      [],
      true,
    ),
    { "pane-1": closed(null) },
  );
  assert.deepEqual(
    normalizePaneSideDocks(null, ["pane-1"], [["browser"], ["terminal"], ["studio"]], true),
    { "pane-1": closed(null) },
  );
});

test("malformed stored values degrade to defaults instead of throwing", () => {
  assert.deepEqual(
    normalizePaneSideDocks("garbage", ["pane-1"], RIGHT, false),
    { "pane-1": closed() },
  );
  assert.deepEqual(
    normalizePaneSideDocks({ "pane-1": 42 }, ["pane-1"], RIGHT, false),
    { "pane-1": closed() },
  );
});

test("dock map equality compares open, view, surface, and the diff", () => {
  const left = { "pane-1": { open: true, view: "source-control", surface: "diff", diff: diffA } };
  assert.ok(samePaneSideDocks(left, {
    "pane-1": { open: true, view: "source-control", surface: "diff", diff: diffA },
  }));
  assert.ok(!samePaneSideDocks(left, {
    "pane-1": { open: true, view: "source-control", surface: "browser", diff: diffA },
  }));
  assert.ok(!samePaneSideDocks(left, {
    "pane-1": { open: true, view: "source-control", surface: "diff", diff: diffB },
  }));
  assert.ok(!samePaneSideDocks(left, {
    ...left,
    "pane-2": closed(null),
  }));
});

test("opening a diff replaces the previous one in place and expands", () => {
  let entry = closed();
  entry = withPaneDockDiffOpened(entry, diffA);
  assert.equal(entry.open, true);
  assert.equal(entry.surface, "diff");
  assert.equal(entry.diff, diffA);
  entry = withPaneDockDiffOpened(entry, diffB);
  assert.equal(entry.diff, diffB);
  // Re-opening the SAME file is a no-op, not a remount.
  const again = withPaneDockDiffOpened(entry, diffB);
  assert.equal(again, entry);
});

test("closing the diff hands the body back to the panel view", () => {
  let entry = { open: true, view: "source-control", surface: "diff", diff: diffA };
  entry = withPaneDockDiffClosed(entry);
  assert.equal(entry.diff, null);
  assert.equal(entry.surface, "");
  assert.equal(entry.open, true);
  // Closing while the browser shows keeps the browser in front.
  const browserFront = withPaneDockDiffClosed({
    open: true,
    view: "source-control",
    surface: "browser",
    diff: diffB,
  });
  assert.equal(browserFront.diff, null);
  assert.equal(browserFront.surface, "browser");
});

test("the diff child shows only when it is the open unit's surface", () => {
  assert.equal(paneDiffShowing(closed()), false);
  assert.equal(paneDiffShowing({
    open: false,
    view: "source-control",
    surface: "diff",
    diff: diffA,
  }), false);
  assert.equal(paneDiffShowing({
    open: true,
    view: "source-control",
    surface: "browser",
    diff: diffA,
  }), false);
  assert.equal(paneDiffShowing({
    open: true,
    view: "source-control",
    surface: "diff",
    diff: diffA,
  }), true);
});

test("mobile always stacks the visible diff so Goal has a visible DIFF anchor", () => {
  assert.equal(paneDiffStacks(true, 1_200, 640, true), true);
  assert.equal(paneDiffStacks(true, 1_200, 640, false), false);
  assert.equal(paneDiffStacks(true, 500, 640, false), true);
  assert.equal(paneDiffStacks(false, 500, 640, true), false);
});

test("a cold pane dock paints its open shell before mounting the heavy body", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><main id=\"root\"></main></body></html>",
    { url: "https://mixdog.test/" },
  );
  const globals = [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const frame = nextFrame++;
    pendingFrames.set(frame, callback);
    return frame;
  };
  dom.window.cancelAnimationFrame = (frame) => pendingFrames.delete(frame);

  const noop = () => {};
  const Icon = () => React.createElement("span");
  const descriptors = new Map([[
    "source-control",
    { id: "source-control", label: "Source Control", icon: Icon },
  ]]);
  const baseProps = {
    leafId: "pane-1",
    groups: [["source-control"]],
    descriptors,
    focused: true,
    onSelect: noop,
    onClose: noop,
    onCloseDiff: noop,
    onMoveGroup: noop,
    onMoveView: noop,
    onFocusPane: noop,
    openFileTab: noop,
    renderView: () => React.createElement(
      "div",
      { "data-testid": "heavy-dock-body" },
      "ready",
    ),
  };
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(PaneSideDock, {
      ...baseProps,
      entry: closed(),
    })));
    await act(async () => root.render(React.createElement(PaneSideDock, {
      ...baseProps,
      entry: { ...closed(), open: true },
    })));

    const dock = document.querySelector(".pane-side-dock");
    const panel = document.querySelector(".workbench-side-panel");
    assert.equal(dock?.dataset.open, "true");
    assert.ok(panel);
    assert.equal(panel.hidden, false);
    assert.equal(document.querySelector("[data-testid=\"heavy-dock-body\"]"), null);
    assert.equal(pendingFrames.size, 1);

    await act(async () => {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      callbacks.forEach((callback) => callback(16));
    });
    assert.ok(document.querySelector("[data-testid=\"heavy-dock-body\"]"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
