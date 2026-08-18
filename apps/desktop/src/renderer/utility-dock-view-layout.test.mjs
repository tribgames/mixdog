import assert from "node:assert/strict";
import test from "node:test";
import {
  moveUtilityDockView,
  moveUtilityDockViewGroup,
  normalizeUtilityDockViewGroups,
} from "./utility-dock-view-layout.ts";

test("utility dock layout normalizes groups without duplicate views", () => {
  assert.deepEqual(
    normalizeUtilityDockViewGroups([
      ["search", "agents", "search"],
      ["unknown", "source-control"],
    ]),
    [["search", "agents"], ["source-control"], ["pull-requests"]],
  );
});

test("utility dock icons move a complete combined group", () => {
  assert.deepEqual(
    moveUtilityDockViewGroup(
      [["agents", "search"], ["source-control"], ["pull-requests"]],
      "agents",
      "pull-requests",
      "after",
    ),
    [["source-control"], ["pull-requests"], ["agents", "search"]],
  );
});

test("utility dock labels combine and extract one category", () => {
  const combined = moveUtilityDockView(
    [["agents"], ["search"], ["source-control"], ["pull-requests"]],
    "search",
    "agents",
    "inside",
  );
  assert.deepEqual(
    combined,
    [["agents", "search"], ["source-control"], ["pull-requests"]],
  );
  assert.deepEqual(
    moveUtilityDockView(combined, "search", "source-control", "after"),
    [["agents"], ["source-control"], ["search"], ["pull-requests"]],
  );
});
