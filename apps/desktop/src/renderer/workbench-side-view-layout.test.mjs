import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  WorkbenchSideIconBar,
  discardLayoutForPaneBoundRight,
  initialActiveWorkbenchSideViews,
  isWorkbenchSideLauncher,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  nextRetainedWorkbenchSideRoots,
  normalizeWorkbenchSideViewLayout,
  normalizeSideSplitSizes,
  resizeSideSplitSizes,
  workbenchSideBarDropPlacement,
  workbenchSidePaneDropIsNoop,
  workbenchSidePaneDropSlot,
} from "./workbench-side-view-layout.tsx";

test("a persisted layout restores its sides and re-seats newly available views", () => {
  // Exactly what the hook does on boot: read the stored JSON, then normalize
  // it against the views this build actually offers.
  const persisted = JSON.stringify({
    left: [["projects"]],
    right: [["sessions", "agents"]],
  });
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(
      JSON.parse(persisted),
      ["sessions", "projects", "agents", "search"],
    ),
    {
      // Search belongs to the left rail now, so it re-seats there in default
      // order instead of trailing whichever side happened to be stored.
      left: [["search"], ["projects"]],
      right: [["sessions", "agents"]],
    },
  );
});

test("restoration drops views this build no longer offers", () => {
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(
      { left: [["sessions", "webhooks"]], right: [["agents"]] },
      ["sessions", "agents"],
    ),
    { left: [["sessions"]], right: [["agents"]] },
  );
});

test("a corrupt or missing persisted layout falls back to the defaults", () => {
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(null, ["sessions", "utilities", "agents"]),
    { left: [["agents"], ["sessions"], ["utilities"]], right: [] },
  );
  // The pane-scoped right side ships exactly the two views a pane drives.
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(null, ["sessions", "source-control", "browser"]),
    { left: [["sessions"]], right: [["source-control"], ["browser"]] },
  );
});

test("the stored arrangement is dropped once so the new defaults apply", () => {
  const layoutKey = "mixdog.desktop.workbench-side-view-layout.v1";
  const store = new Map([[layoutKey, "{}"]]);
  const storage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const stored = { left: [["sessions"], ["utilities"]], right: [["agents"]] };
  assert.equal(discardLayoutForPaneBoundRight(storage, stored), null);
  assert.equal(store.has(layoutKey), false);
  // Once only: a rail arranged after the reset survives every later boot.
  const rearranged = { left: [["utilities"], ["sessions"]], right: [] };
  assert.equal(discardLayoutForPaneBoundRight(storage, rearranged), rearranged);
});

test("views missing from a stored side are restored in default order", () => {
  // A side stored before these views existed rebuilds in DEFAULT order instead
  // of collecting every newcomer behind whatever it happened to keep.
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout(
      { left: [["sessions"]], right: [] },
      ["sessions", "agents", "schedules", "source-control", "browser"],
    ),
    {
      left: [["agents"], ["sessions"], ["schedules"]],
      right: [["source-control"], ["browser"]],
    },
  );
});

test("each side opens on its leading group, never a last-visited view", () => {
  // Sessions sits on the right here, and neither side restores anything: the
  // left starts on its own first group, the right on the group that leads it.
  assert.deepEqual(
    initialActiveWorkbenchSideViews({
      left: [["projects"], ["search"]],
      right: [["sessions", "agents"]],
    }),
    { left: "projects", right: "sessions" },
  );
  // A combined group selects its root.
  assert.deepEqual(
    initialActiveWorkbenchSideViews({ left: [["projects", "sessions"]], right: [] }),
    { left: "projects", right: null },
  );
});

test("an empty side has no active view", () => {
  assert.deepEqual(
    initialActiveWorkbenchSideViews({ left: [], right: [["agents"]] }),
    { left: null, right: "agents" },
  );
});

test("side view layout keeps every available category exactly once", () => {
  assert.deepEqual(
    normalizeWorkbenchSideViewLayout({
      left: [["projects", "search", "projects"]],
      right: [["agents", "source-control"]],
    }, ["projects", "search", "agents", "source-control"]),
    {
      left: [["projects", "search"]],
      right: [["agents", "source-control"]],
    },
  );
});

test("the pane-scoped right side neither gives up nor accepts a view", () => {
  const layout = {
    left: [["sessions"], ["projects"]],
    right: [["source-control", "browser"]],
  };
  // Dragging out of the right side does nothing…
  assert.equal(
    moveWorkbenchSideGroup(layout, "source-control", "left", "projects", "inside"),
    layout,
  );
  assert.equal(
    moveWorkbenchSideView(layout, "browser", "left", "projects", "after"),
    layout,
  );
  // …and neither does dropping a left view onto it.
  assert.equal(
    moveWorkbenchSideView(layout, "projects", "right", "source-control", "after"),
    layout,
  );
  assert.equal(
    moveWorkbenchSideGroup(layout, "sessions", "right", null, "after"),
    layout,
  );
});

test("a category label extracts one view into its own icon", () => {
  const layout = {
    left: [["projects", "agents", "search"]],
    right: [["source-control"]],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "search", "left", "projects", "before"),
    {
      left: [["search"], ["projects", "agents"]],
      right: [["source-control"]],
    },
  );
});

test("activity icons reorder groups without combining them", () => {
  const layout = {
    left: [["sessions"], ["projects"], ["workflows"]],
    right: [["agents"]],
  };
  assert.deepEqual(
    moveWorkbenchSideGroup(layout, "workflows", "left", "projects", "before"),
    {
      left: [["sessions"], ["workflows"], ["projects"]],
      right: [["agents"]],
    },
  );
});

test("dropping a category on an activity icon adds an independent icon", () => {
  const layout = {
    left: [["projects", "search"], ["workflows"]],
    right: [["agents"]],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "search", "left", "workflows", "after"),
    {
      left: [["projects"], ["workflows"], ["search"]],
      right: [["agents"]],
    },
  );
});

test("pane top and bottom drops combine views at the requested label position", () => {
  const layout = {
    left: [["projects", "search"], ["workflows"], ["agents"]],
    right: [["source-control"]],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "search", "left", "agents", "inside-after"),
    {
      left: [["projects"], ["workflows"], ["agents", "search"]],
      right: [["source-control"]],
    },
  );
  assert.deepEqual(
    moveWorkbenchSideGroup(layout, "workflows", "left", "projects", "inside-before"),
    {
      left: [["workflows", "projects", "search"], ["agents"]],
      right: [["source-control"]],
    },
  );
});

test("a launcher reorders as its own icon and never joins a group", () => {
  const layout = {
    left: [["sessions"], ["studio"], ["workflows"]],
    right: [["source-control"], ["browser"]],
  };
  const unchanged = {
    left: [["sessions"], ["studio"], ["workflows"]],
    right: [["source-control"], ["browser"]],
  };
  // An "inside" drop involving a launcher degrades to a neighbouring slot, so
  // Studio keeps its own icon instead of disappearing into another panel.
  assert.deepEqual(
    moveWorkbenchSideView(layout, "studio", "left", "sessions", "inside-after"),
    unchanged,
  );
  assert.deepEqual(
    moveWorkbenchSideView(layout, "workflows", "left", "studio", "inside"),
    unchanged,
  );
  assert.equal(isWorkbenchSideLauncher("studio"), true);
  // The browser left the launcher set: it is the pane dock's own child now.
  assert.equal(isWorkbenchSideLauncher("browser"), false);
  assert.equal(isWorkbenchSideLauncher("sessions"), false);
});

test("dragging a combined pane label reorders it within the group", () => {
  const layout = {
    left: [["projects", "search", "workflows"]],
    right: [["agents"]],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "workflows", "left", "projects", "inside-after"),
    {
      left: [["projects", "workflows", "search"]],
      right: [["agents"]],
    },
  );
});

test("pane drop targets expose N plus one slots and hide no-op positions", () => {
  assert.equal(workbenchSidePaneDropSlot([100, 300], 50), 0);
  assert.equal(workbenchSidePaneDropSlot([100, 300], 200), 1);
  assert.equal(workbenchSidePaneDropSlot([100, 300], 350), 2);
  assert.equal(
    workbenchSidePaneDropIsNoop(["projects", "search"], "view", "projects", 1),
    true,
  );
  assert.equal(
    workbenchSidePaneDropIsNoop(["projects", "search"], "view", "projects", 2),
    false,
  );
  assert.equal(
    workbenchSidePaneDropIsNoop(["projects", "search"], "group", "projects", 2),
    true,
  );
});

test("activity bar drop zones use the 40/60 hysteresis", () => {
  assert.equal(workbenchSideBarDropPlacement(.4, "after"), "before");
  assert.equal(workbenchSideBarDropPlacement(.6, "before"), "before");
  assert.equal(workbenchSideBarDropPlacement(.61, "before"), "after");
  assert.equal(workbenchSideBarDropPlacement(.49, null), "before");
  assert.equal(workbenchSideBarDropPlacement(.51, null), "after");
});

test("combined views start evenly split for two and three panes", () => {
  assert.deepEqual(normalizeSideSplitSizes(null, 2), [50, 50]);
  assert.deepEqual(
    normalizeSideSplitSizes(null, 3).map((value) => Math.round(value * 1000) / 1000),
    [33.333, 33.333, 33.333],
  );
});

test("a sash resizes only its adjacent panes and preserves the total", () => {
  const resized = resizeSideSplitSizes([50, 50], 0, 80, 400);
  assert.deepEqual(resized, [70, 30]);
  assert.equal(resized.reduce((sum, value) => sum + value, 0), 100);
  assert.deepEqual(resizeSideSplitSizes([50, 50], 0, 500, 400), [76, 24]);
});

test("visited side groups stay retained while removed groups are pruned", () => {
  const groups = [["agents"], ["search"], ["source-control"]];
  assert.deepEqual(
    nextRetainedWorkbenchSideRoots(groups, ["agents"], "source-control"),
    ["agents", "source-control"],
  );
  assert.deepEqual(
    nextRetainedWorkbenchSideRoots(groups.slice(1), ["agents", "source-control"], "search"),
    ["search", "source-control"],
  );
});

test("the whole activity bar accepts a drag and drops after the last icon", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const globals = [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(document.getElementById("root"));
  const moves = [];
  const Icon = () => React.createElement("span");
  const descriptors = new Map([
    ["projects", { id: "projects", label: "Projects", icon: Icon }],
    ["workflows", { id: "workflows", label: "Workflows", icon: Icon }],
  ]);
  const transferData = new Map();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    get types() { return [...transferData.keys()]; },
    setData(type, value) { transferData.set(type, value); },
    getData(type) { return transferData.get(type) ?? ""; },
    setDragImage() {},
  };
  const dragEvent = (type, clientY) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: 24 });
    Object.defineProperty(event, "clientY", { value: clientY });
    return event;
  };

  try {
    await act(async () => root.render(React.createElement(WorkbenchSideIconBar, {
      side: "left",
      groups: [["projects"], ["workflows"]],
      activeRoot: "projects",
      descriptors,
      orientation: "vertical",
      onSelect() {},
      onMoveGroup(...args) { moves.push(args); },
      onMoveView() {},
    })));
    const bar = document.querySelector(".workbench-side-icon-bar");
    const buttons = [...bar.querySelectorAll("button")];
    assert.equal(buttons.length, 2);
    buttons[0].getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, right: 48, bottom: 48, left: 0,
      width: 48, height: 48, toJSON() {},
    });
    buttons[1].getBoundingClientRect = () => ({
      x: 0, y: 48, top: 48, right: 48, bottom: 96, left: 0,
      width: 48, height: 48, toJSON() {},
    });

    await act(async () => {
      buttons[0].dispatchEvent(dragEvent("dragstart", 24));
    });
    const over = dragEvent("dragover", 130);
    await act(async () => {
      bar.dispatchEvent(over);
    });
    assert.equal(over.defaultPrevented, true);
    assert.equal(dataTransfer.dropEffect, "move");
    assert.equal(buttons[1].dataset.dropPosition, "after");

    await act(async () => {
      bar.dispatchEvent(dragEvent("drop", 130));
    });
    assert.deepEqual(moves, [["projects", "left", "workflows", "after"]]);

    // The same bar on the right belongs to the pane: its icons cannot be
    // picked up and a drop landing there changes nothing.
    moves.length = 0;
    await act(async () => root.render(React.createElement(WorkbenchSideIconBar, {
      side: "right",
      groups: [["projects"], ["workflows"]],
      activeRoot: "projects",
      descriptors,
      orientation: "vertical",
      onSelect() {},
      onMoveGroup(...args) { moves.push(args); },
      onMoveView(...args) { moves.push(args); },
    })));
    const rightBar = document.querySelector(".workbench-side-icon-bar");
    const rightButtons = [...rightBar.querySelectorAll("button")];
    assert.equal(rightButtons.some((button) => button.draggable), false);
    const rightOver = dragEvent("dragover", 130);
    await act(async () => {
      rightBar.dispatchEvent(rightOver);
      rightBar.dispatchEvent(dragEvent("drop", 130));
    });
    assert.equal(rightOver.defaultPrevented, false);
    assert.deepEqual(moves, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
