import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("a whole right-side group combines into a left category", () => {
  const layout = {
    left: [["sessions"], ["projects"]],
    right: [["agents", "search", "source-control"]],
  };
  assert.deepEqual(
    moveWorkbenchSideGroup(layout, "agents", "left", "projects", "inside"),
    {
      left: [["sessions"], ["projects", "agents", "search", "source-control"]],
      right: [],
    },
  );
});

test("a category label extracts one view into an empty opposite side", () => {
  const layout = {
    left: [["projects", "agents", "search", "source-control"]],
    right: [],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "search", "right", null, "after"),
    {
      left: [["projects", "agents", "source-control"]],
      right: [["search"]],
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
    left: [["projects", "search"], ["workflows"]],
    right: [["agents", "source-control"]],
  };
  assert.deepEqual(
    moveWorkbenchSideView(layout, "search", "right", "agents", "inside-after"),
    {
      left: [["projects"], ["workflows"]],
      right: [["agents", "search", "source-control"]],
    },
  );
  assert.deepEqual(
    moveWorkbenchSideGroup(layout, "workflows", "right", "source-control", "inside-before"),
    {
      left: [["projects", "search"]],
      right: [["agents", "workflows", "source-control"]],
    },
  );
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
