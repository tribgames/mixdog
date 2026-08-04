import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PANE_MAX_RATIO,
  PANE_MIN_RATIO,
  activateTabInPaneLeaf,
  canSplitPaneSize,
  clampPaneRatioForSizes,
  closePaneLeaf,
  closeTabInPaneLeaf,
  createPaneLeaf,
  distributePaneRatios,
  distributePaneRatiosAlong,
  findPaneLeaf,
  mergePaneLeaf,
  movePaneLeaf,
  movePaneLeafToNodeEdge,
  movePaneLeafToRootEdge,
  movePaneTabToNodeEdge,
  movePaneTabToRootEdge,
  neighborPaneLeafId,
  openTabInPaneLeaf,
  paneActiveSelection,
  paneLeafRelativeRect,
  paneLeaves,
  paneNodeMinimumSize,
  parsePaneLayout,
  pinTabInPaneLeaf,
  reorderTabInPaneLeaf,
  setPaneSplitRatio,
  splitPaneLeaf,
} from "./pane-layout.ts";
import { readStoredPaneLayout } from "./pane-workspace-state.ts";
import {
  paneHierarchyDropTarget,
  paneInnerDropZone,
  paneOuterDropZone,
} from "./pane-drop-zone.ts";
import { clampBottomPanelHeight, BOTTOM_PANEL_MIN_HEIGHT } from "./BottomPanel.tsx";

const session = (id) => ({ kind: "session", id });

test("splitPaneLeaf replaces the leaf with a split and keeps reading order", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_b", "column", c, 0.3);
  assert.deepEqual(paneLeaves(root).map((leaf) => leaf.id), ["leaf_a", "leaf_b", "leaf_c"]);
  assert.equal(root.type, "split");
  assert.equal(root.second.type, "split");
  assert.equal(root.second.direction, "column");
  // Drop on a left/top edge inserts the new leaf BEFORE the target.
  const d = createPaneLeaf(session("d"), "leaf_d");
  const before = splitPaneLeaf(root, "leaf_a", "row", d, 0.5, "before");
  assert.deepEqual(paneLeaves(before).map((leaf) => leaf.id),
    ["leaf_d", "leaf_a", "leaf_b", "leaf_c"]);
  assert.equal(root.second.ratio, 0.3);
  // Missing leaf ids leave the tree untouched (same reference).
  assert.equal(splitPaneLeaf(root, "missing", "row", createPaneLeaf(session("x"))), root);
});

test("splitPaneLeaf has no product-level pane ceiling", () => {
  let root = createPaneLeaf(session("s0"), "leaf_0");
  for (let index = 1; index < 18; index += 1) {
    root = splitPaneLeaf(root, "leaf_0", "row", createPaneLeaf(session(`s${index}`), `leaf_${index}`));
  }
  assert.equal(paneLeaves(root).length, 18);
  const restored = parsePaneLayout(JSON.parse(JSON.stringify(root)));
  assert.equal(paneLeaves(restored).length, 18,
    "layouts beyond the former ceiling must survive restart persistence");
});

test("pane splitting requires both visible axes to preserve pane floors", () => {
  assert.equal(canSplitPaneSize("row", 644, 480), true);
  assert.equal(canSplitPaneSize("row", 643, 600), false);
  assert.equal(canSplitPaneSize("row", 644, 479), false);
  assert.equal(canSplitPaneSize("column", 900, 964), true);
  assert.equal(canSplitPaneSize("column", 900, 963), false);
  assert.equal(canSplitPaneSize("column", 319, 964), false);
});

test("nested pane floors compose and sash ratios preserve both children", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  assert.deepEqual(paneNodeMinimumSize(root), { width: 644, height: 480 });
  root = splitPaneLeaf(root, "leaf_b", "column", c);
  assert.deepEqual(paneNodeMinimumSize(root), { width: 644, height: 964 });

  const lower = clampPaneRatioForSizes(0.01, 1_000, 320, 320);
  const upper = clampPaneRatioForSizes(0.99, 1_000, 320, 320);
  assert.ok(Math.abs(lower - 320 / 996) < 1e-9);
  assert.ok(Math.abs(upper - (1 - 320 / 996)) < 1e-9);
  assert.equal(clampPaneRatioForSizes(0.2, 600, 320, 320), 0.5);
});

test("group drag merges a 2x2 side into one tall pane and moves whole groups", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  const d = createPaneLeaf(session("d"), "leaf_d");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_a", "column", c);
  root = splitPaneLeaf(root, "leaf_b", "column", d);
  const tLayout = mergePaneLeaf(root, "leaf_c", "leaf_a");
  assert.equal(tLayout.type, "split");
  assert.equal(tLayout.direction, "row");
  assert.equal(tLayout.first.id, "leaf_a");
  assert.equal(tLayout.second.type, "split");
  assert.equal(tLayout.second.direction, "column");
  assert.deepEqual(paneLeaves(tLayout).map((leaf) => leaf.id), ["leaf_a", "leaf_b", "leaf_d"]);
  assert.deepEqual(findPaneLeaf(tLayout, "leaf_a").tabs.map((tab) => tab.id), ["a", "c"]);
  assert.equal(findPaneLeaf(tLayout, "leaf_a").activeKey, "session:c");

  const moved = movePaneLeaf(tLayout, "leaf_d", "leaf_a", "column", "after");
  assert.deepEqual(paneLeaves(moved).map((leaf) => leaf.id), ["leaf_a", "leaf_d", "leaf_b"]);
  assert.equal(findPaneLeaf(moved, "leaf_d").activeKey, "session:d");

  const fullHeightRight = movePaneLeafToRootEdge(tLayout, "leaf_a", "row", "after");
  assert.equal(fullHeightRight.type, "split");
  assert.equal(fullHeightRight.direction, "row");
  assert.equal(fullHeightRight.first.type, "split",
    "the existing top/bottom stack stays together on the left");
  assert.deepEqual(paneLeaves(fullHeightRight.first).map((leaf) => leaf.id), ["leaf_b", "leaf_d"]);
  assert.equal(fullHeightRight.second.id, "leaf_a",
    "the moved group spans the full height at the workspace edge");
  assert.equal(fullHeightRight.ratio, 0.5,
    "a composite grid and its full-height edge pane split the workspace in half");
  assert.equal(movePaneLeafToRootEdge(fullHeightRight, "leaf_a", "row", "after"), fullHeightRight,
    "an already balanced outer edge preserves its identity");
  const unevenOuterEdge = setPaneSplitRatio(fullHeightRight, "", 0.7);
  assert.equal(
    movePaneLeafToRootEdge(unevenOuterEdge, "leaf_a", "row", "after").ratio,
    0.5,
    "dropping an existing edge group on that edge redistributes the affected axis",
  );

  let rows = splitPaneLeaf(a, "leaf_a", "column", b);
  rows = splitPaneLeaf(rows, "leaf_b", "column", c);
  const equalRows = movePaneLeafToRootEdge(rows, "leaf_a", "column", "after");
  assert.equal(equalRows.ratio, 2 / 3,
    "moving one of three rows to the root edge gives the other two exactly two thirds");
  assert.equal(equalRows.first.ratio, 0.5);
  assert.deepEqual(paneLeaves(equalRows).map((leaf) => leaf.id), ["leaf_b", "leaf_c", "leaf_a"]);

  let tabGroup = createPaneLeaf(session("tab-a"), "leaf_tabs");
  tabGroup = openTabInPaneLeaf(tabGroup, "leaf_tabs", session("tab-b"));
  const detachedTab = movePaneTabToRootEdge(
    tabGroup, "leaf_tabs", "session:tab-b", "row", "after");
  assert.deepEqual(paneLeaves(detachedTab).map((leaf) =>
    leaf.tabs.map((tab) => tab.id)), [["tab-a"], ["tab-b"]],
  "a selected tab detaches into a root-edge group without copying");

  const manualOrthogonal = setPaneSplitRatio(fullHeightRight, "first", 0.7);
  assert.equal(distributePaneRatiosAlong(manualOrthogonal, "row").first.ratio, 0.7,
    "root-axis distribution preserves orthogonal manual sizing");

  const rootWithMovableTab = openTabInPaneLeaf(root, "leaf_a", session("x"));
  const topThreeBottomTwo = movePaneTabToNodeEdge(
    rootWithMovableTab, "leaf_a", "session:x", "second.first", "row", "after");
  assert.equal(topThreeBottomTwo.second.first.type, "split");
  assert.equal(topThreeBottomTwo.second.first.direction, "row",
    "a right-edge upper cap docks beside only the upper target row");
});

test("a detached tab adds one equal outer track and exposes its final preview bounds", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  const d = createPaneLeaf(session("d"), "leaf_d");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_a", "column", c);
  root = splitPaneLeaf(root, "leaf_b", "column", d);
  root = openTabInPaneLeaf(root, "leaf_a", session("detached"));

  const moved = movePaneTabToNodeEdge(
    root,
    "leaf_a",
    "session:detached",
    "",
    "row",
    "after",
    "leaf_preview",
  );
  assert.equal(moved.ratio, 2 / 3,
    "two existing horizontal tracks plus the full-height pane become thirds");
  const preview = paneLeafRelativeRect(moved, "leaf_preview");
  assert.equal(preview.top, 0);
  assert.equal(preview.height, 1);
  assert.ok(Math.abs(preview.left - 2 / 3) < 1e-9);
  assert.ok(Math.abs(preview.width - 1 / 3) < 1e-9);
});

test("outer drop rails select actual leaf, parent, and root geometry", () => {
  const rect = { left: 0, top: 0, right: 1_000, bottom: 600, width: 1_000, height: 600 };
  const candidates = [
    { path: "", rect },
    { path: "second.first", rect: {
      left: 500, top: 0, right: 1_000, bottom: 300, width: 500, height: 300,
    } },
    { path: "second.second", rect: {
      left: 500, top: 300, right: 1_000, bottom: 600, width: 500, height: 300,
    } },
  ];
  assert.equal(paneOuterDropZone(rect, 999, 300), "right");
  assert.equal(paneHierarchyDropTarget(
    rect, "right", 999, 300, candidates)?.path, "");
  assert.equal(paneHierarchyDropTarget(
    rect, "right", 999, 150, candidates)?.path, "second.first");
  assert.equal(paneHierarchyDropTarget(
    rect, "right", 999, 450, candidates)?.path, "second.second");
  const fullHeightCandidates = [
    { path: "", rect },
    { path: "second", rect: {
      left: 500, top: 0, right: 1_000, bottom: 600, width: 500, height: 600,
    } },
  ];
  assert.equal(paneHierarchyDropTarget(
    rect, "right", 999, 300, fullHeightCandidates)?.path, "");
  assert.equal(paneHierarchyDropTarget(
    rect, "right", 999, 50, fullHeightCandidates)?.path, "second");
  assert.equal(paneOuterDropZone(rect, 500, 300), null);
});

test("inner drop zones follow VS Code thirds and edge thresholds", () => {
  const rect = { left: 0, top: 0, right: 1_000, bottom: 600, width: 1_000, height: 600 };
  assert.equal(paneInnerDropZone(rect, 500, 300), "center");
  // Band direction resolves by thirds (editorDropTarget.positionOverlay):
  // the bottom band's left third aims LEFT, not DOWN.
  assert.equal(paneInnerDropZone(rect, 200, 590), "left");
  assert.equal(paneInnerDropZone(rect, 850, 590), "right");
  assert.equal(paneInnerDropZone(rect, 500, 20), "top");
  assert.equal(paneInnerDropZone(rect, 500, 590), "bottom");
  // Tab-drag band widened to 15% (user knob over VS Code's 10%): 14% across
  // splits, 18% is already center.
  assert.equal(paneInnerDropZone(rect, 140, 300), "left");
  assert.equal(paneInnerDropZone(rect, 180, 300), "center");
  // Group drags widen only the HORIZONTAL band to 30%
  // (preferSplitVertically); the vertical band stays 10%.
  assert.equal(paneInnerDropZone(rect, 280, 300, true), "left");
  assert.equal(paneInnerDropZone(rect, 280, 300, false), "center");
  assert.equal(paneInnerDropZone(rect, 500, 450, true), "center");
});

test("strip drops insert at the pointed index (VS Code tabs drop)", () => {
  const leaf = createPaneLeaf(session("a"), "leaf_a");
  let root = openTabInPaneLeaf(leaf, "leaf_a", session("b"));
  root = openTabInPaneLeaf(root, "leaf_a", session("c"), "", { index: 1 });
  assert.deepEqual(paneLeaves(root)[0].tabs.map((tab) => tab.id), ["a", "c", "b"]);
  // An indexed open of an existing tab repositions it (VS Code moveEditor).
  root = openTabInPaneLeaf(root, "leaf_a", session("b"), "", { index: 0 });
  assert.deepEqual(paneLeaves(root)[0].tabs.map((tab) => tab.id), ["b", "a", "c"]);
  // A group merge splices every incoming tab at the index (mergeGroup{index}).
  const split = splitPaneLeaf(root, "leaf_a", "row",
    createPaneLeaf(session("z"), "leaf_z"));
  const merged = mergePaneLeaf(split, "leaf_z", "leaf_a", 1);
  assert.deepEqual(paneLeaves(merged)[0].tabs.map((tab) => tab.id),
    ["b", "z", "a", "c"]);
});

test("closePaneLeaf collapses the parent to the sibling and picks a neighbor", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_b", "column", c);
  assert.equal(neighborPaneLeafId(root, "leaf_b"), "leaf_c");
  const closed = closePaneLeaf(root, "leaf_b");
  assert.deepEqual(paneLeaves(closed).map((leaf) => leaf.id), ["leaf_a", "leaf_c"]);
  // The collapsed subtree is the surviving sibling itself, not a wrapper.
  assert.equal(closed.second.type, "leaf");
  // Closing the final leaf yields null for the caller to decide.
  assert.equal(closePaneLeaf(createPaneLeaf(session("only"), "leaf_only"), "leaf_only"), null);
});

test("setPaneSplitRatio addresses splits by path and clamps", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_b", "column", c);
  root = setPaneSplitRatio(root, "", 0.7);
  assert.equal(root.ratio, 0.7);
  root = setPaneSplitRatio(root, "second", 0.01);
  assert.equal(root.second.ratio, PANE_MIN_RATIO);
  root = setPaneSplitRatio(root, "second", 99);
  assert.equal(root.second.ratio, PANE_MAX_RATIO);
  // Unknown paths leave the tree untouched.
  assert.equal(setPaneSplitRatio(root, "first.bogus", 0.5), root);
});

test("openTabInPaneLeaf appends, activates, and promotes in place", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  // Opening a new selection appends a tab and activates it.
  root = openTabInPaneLeaf(root, "leaf_b", { kind: "new", draftId: "d1" });
  root = openTabInPaneLeaf(root, "leaf_b", session("c"));
  let group = findPaneLeaf(root, "leaf_b");
  assert.deepEqual(group.tabs, [session("b"), { kind: "new", draftId: "d1" }, session("c")]);
  assert.equal(group.activeKey, "session:c");
  // Re-opening an existing tab only re-activates it.
  const reopened = openTabInPaneLeaf(root, "leaf_b", session("b"));
  group = findPaneLeaf(reopened, "leaf_b");
  assert.equal(group.tabs.length, 3);
  assert.equal(group.activeKey, "session:b");
  assert.deepEqual(paneActiveSelection(group), session("b"));
  // replaceKey promotes the draft into a session at the same position; an
  // older copy of the destination elsewhere in the group is dropped.
  const promoted = openTabInPaneLeaf(root, "leaf_b", session("c"), "new:d1");
  group = findPaneLeaf(promoted, "leaf_b");
  assert.deepEqual(group.tabs, [session("b"), session("c")]);
  assert.equal(group.activeKey, "session:c");
  // The sibling group never changes.
  assert.deepEqual(findPaneLeaf(promoted, "leaf_a").tabs, [session("a")]);
});

test("reopening a file tab preserves or refreshes its selected-file permission", () => {
  const file = { kind: "file", project: "C:\\outside", rel: "notes.txt", accessToken: "grant-a" };
  let root = createPaneLeaf(file, "leaf_file");
  root = openTabInPaneLeaf(root, "leaf_file", {
    kind: "file",
    project: "C:\\outside",
    rel: "notes.txt",
  });
  assert.equal(paneActiveSelection(root).accessToken, "grant-a",
    "pane focus must not erase the selected-file grant");
  root = openTabInPaneLeaf(root, "leaf_file", {
    ...file,
    accessToken: "grant-b",
  });
  assert.equal(paneActiveSelection(root).accessToken, "grant-b",
    "choosing the same path again must refresh its grant");
});

test("file preview tabs replace one another and pin on edit or double-open", () => {
  const first = { kind: "file", project: "C:/p", rel: "first.ts" };
  const second = { kind: "file", project: "C:/p", rel: "second.ts" };
  let root = createPaneLeaf(session("a"), "leaf_preview");
  root = openTabInPaneLeaf(root, "leaf_preview", first, "", { preview: true });
  assert.equal(root.previewKey, "file:C:/p:first.ts");
  root = openTabInPaneLeaf(root, "leaf_preview", second, "", { preview: true });
  assert.deepEqual(root.tabs, [session("a"), second]);
  assert.equal(root.previewKey, "file:C:/p:second.ts");
  root = pinTabInPaneLeaf(root, "leaf_preview", root.previewKey);
  assert.equal(root.previewKey, undefined);
  root = openTabInPaneLeaf(root, "leaf_preview", first, "", { preview: true });
  assert.deepEqual(root.tabs, [session("a"), second, first]);
});

test("activate/reorder/close operate inside one group", () => {
  let root = createPaneLeaf(session("a"), "leaf_a");
  root = openTabInPaneLeaf(root, "leaf_a", session("b"));
  root = openTabInPaneLeaf(root, "leaf_a", session("c"));
  root = activateTabInPaneLeaf(root, "leaf_a", "session:a");
  assert.equal(findPaneLeaf(root, "leaf_a").activeKey, "session:a");
  // Unknown keys are ignored (same reference).
  assert.equal(activateTabInPaneLeaf(root, "leaf_a", "session:zzz"), root);
  root = reorderTabInPaneLeaf(root, "leaf_a", "session:c", "session:a");
  assert.deepEqual(findPaneLeaf(root, "leaf_a").tabs.map((tab) => tab.id), ["c", "a", "b"]);
  // VS Code numeric drop index: measured with the source still in place, so
  // an index past the source shifts down after removal (container drop=end).
  root = reorderTabInPaneLeaf(root, "leaf_a", "session:c", 3);
  assert.deepEqual(findPaneLeaf(root, "leaf_a").tabs.map((tab) => tab.id), ["a", "b", "c"]);
  root = reorderTabInPaneLeaf(root, "leaf_a", "session:c", 0);
  assert.deepEqual(findPaneLeaf(root, "leaf_a").tabs.map((tab) => tab.id), ["c", "a", "b"]);
  // Closing the active tab activates its nearest neighbor.
  root = closeTabInPaneLeaf(root, "leaf_a", "session:a");
  const group = findPaneLeaf(root, "leaf_a");
  assert.deepEqual(group.tabs.map((tab) => tab.id), ["c", "b"]);
  assert.equal(group.activeKey, "session:b");
});

test("closing a group's last tab collapses the leaf like closePaneLeaf", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const root = splitPaneLeaf(a, "leaf_a", "row", b);
  const collapsed = closeTabInPaneLeaf(root, "leaf_b", "session:b");
  assert.equal(collapsed.type, "leaf");
  assert.equal(collapsed.id, "leaf_a");
  // The final tab of the final leaf yields null for the caller to decide.
  assert.equal(closeTabInPaneLeaf(a, "leaf_a", "session:a"), null);
});

test("distributePaneRatios evens the grid along each axis", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf(session("b"), "leaf_b");
  const c = createPaneLeaf(session("c"), "leaf_c");
  // Three columns built by successive splits: 0.5/0.5 nesting yields
  // 50/25/25 — distribution must land on thirds.
  let root = splitPaneLeaf(a, "leaf_a", "row", b);
  root = splitPaneLeaf(root, "leaf_b", "row", c);
  const even = distributePaneRatios(root);
  assert.ok(Math.abs(even.ratio - 1 / 3) < 1e-9, "outer split gives one of three columns");
  assert.equal(even.second.ratio, 0.5, "inner split halves the remaining two columns");
  // A cross-direction subtree counts as ONE track on the outer axis.
  const d = createPaneLeaf(session("d"), "leaf_d");
  const stacked = distributePaneRatios(splitPaneLeaf(even, "leaf_c", "column", d));
  assert.ok(Math.abs(stacked.ratio - 1 / 3) < 1e-9,
    "stacking inside one column must not steal width from the others");
});

test("parsePaneLayout roundtrips a valid tree and rejects corrupt ones", () => {
  const a = createPaneLeaf(session("a"), "leaf_a");
  const b = createPaneLeaf({ kind: "file", project: "C:/p", rel: "src/x.ts" }, "leaf_b");
  const root = splitPaneLeaf(
    openTabInPaneLeaf(a, "leaf_a", session("a2")), "leaf_a", "column", b, 0.4);
  const restored = parsePaneLayout(JSON.parse(JSON.stringify(root)));
  assert.deepEqual(restored, root);
  const utility = parsePaneLayout({
    type: "leaf",
    id: "utility",
    tabs: [
      { kind: "studio", id: "studio-1" },
      { kind: "terminal", id: "term_tab_1", cwd: "C:/p" },
      { kind: "file", project: "C:/outside", rel: "notes.md", accessToken: "grant-1" },
      { kind: "diff", project: "C:/p", rel: "src/x.ts", source: "staged" },
    ],
    activeKey: "terminal:term_tab_1",
  });
  assert.deepEqual(utility.tabs, [
    { kind: "studio", id: "studio-1" },
    { kind: "terminal", id: "term_tab_1", cwd: "C:/p" },
    { kind: "file", project: "C:/outside", rel: "notes.md", accessToken: "grant-1" },
    { kind: "diff", project: "C:/p", rel: "src/x.ts", source: "staged" },
  ]);
  assert.equal(utility.activeKey, "terminal:term_tab_1");
  // Legacy single-selection leaves migrate to one-tab groups.
  const migrated = parsePaneLayout({ type: "leaf", id: "old", selection: session("s") });
  assert.deepEqual(migrated, {
    type: "leaf", id: "old", tabs: [session("s")], activeKey: "session:s",
  });
  // Corrupt shapes reject the whole layout.
  assert.equal(parsePaneLayout(null), null);
  assert.equal(parsePaneLayout({ type: "split", direction: "row" }), null);
  assert.equal(parsePaneLayout({ type: "leaf", id: "x", selection: { kind: "nope" } }), null);
  // Duplicate keys inside one group are corrupt.
  assert.equal(parsePaneLayout({
    type: "leaf", id: "x", tabs: [session("a"), session("a")], activeKey: "session:a",
  }), null);
  // An unknown stored activeKey falls back to the first tab.
  assert.equal(parsePaneLayout({
    type: "leaf", id: "x", tabs: [session("a")], activeKey: "session:gone",
  }).activeKey, "session:a");
  assert.equal(parsePaneLayout({
    type: "split",
    direction: "diagonal",
    ratio: 0.5,
    first: { type: "leaf", id: "l1", selection: session("a") },
    second: { type: "leaf", id: "l2", selection: session("b") },
  }), null);
  // Duplicate leaf ids would break focus/close addressing.
  assert.equal(parsePaneLayout({
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: { type: "leaf", id: "dup", selection: session("a") },
    second: { type: "leaf", id: "dup", selection: session("b") },
  }), null);
  // A non-finite stored ratio is normalized instead of rejected.
  const normalized = parsePaneLayout({
    type: "split",
    direction: "row",
    ratio: "not-a-number",
    first: { type: "leaf", id: "l1", selection: session("a") },
    second: { type: "leaf", id: "l2", selection: session("b") },
  });
  assert.equal(normalized.ratio, 0.5);
});

test("readStoredPaneLayout restores a coherent workspace or nothing", () => {
  const leaf = createPaneLeaf(session("s1"), "leaf_a");
  const layout = splitPaneLeaf(leaf, "leaf_a", "row", createPaneLeaf({ kind: "new" }, "leaf_b"));
  const storage = (value) => ({ getItem: () => value });
  const stored = readStoredPaneLayout(storage(JSON.stringify({ layout, focusedLeafId: "leaf_b" })));
  assert.equal(stored.focusedLeafId, "leaf_b");
  assert.deepEqual(paneLeaves(stored.layout).map((entry) => entry.id), ["leaf_a", "leaf_b"]);
  // An unknown focus falls back to the first leaf; a corrupt layout rejects.
  assert.equal(
    readStoredPaneLayout(storage(JSON.stringify({ layout, focusedLeafId: "gone" }))).focusedLeafId,
    "leaf_a",
  );
  assert.equal(readStoredPaneLayout(storage(JSON.stringify({ layout: { type: "split" } }))), null);
  assert.equal(readStoredPaneLayout(storage("not json")), null);
  assert.equal(readStoredPaneLayout(null), null);
});

test("clampBottomPanelHeight bounds the drag range", () => {
  assert.equal(clampBottomPanelHeight(10, 1000), BOTTOM_PANEL_MIN_HEIGHT);
  assert.equal(clampBottomPanelHeight(400, 1000), 400);
  assert.equal(clampBottomPanelHeight(900, 1000), 700);
  assert.equal(clampBottomPanelHeight(Number.NaN, 1000), 240);
});
