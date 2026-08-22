import assert from "node:assert/strict";
import test from "node:test";

import {
  moveSidebarView,
  moveSidebarViewGroup,
  normalizeSidebarViewGroups,
} from "./sidebar-view-layout.ts";
import {
  moveUtilityDockView,
  moveUtilityDockViewGroup,
  normalizeUtilityDockViewGroups,
} from "./utility-dock-view-layout.ts";

// The activity rail and the utility dock offer the same view grouping over
// their own vocabularies, so the shared grammar is stated once and checked
// against both surfaces.
const surfaces = [
  {
    name: "activity rail sidebar",
    normalize: normalizeSidebarViewGroups,
    moveGroup: moveSidebarViewGroup,
    moveView: moveSidebarView,
    stored: [["workflows", "projects", "workflows"], ["unknown", "schedules"]],
    normalized: [["workflows", "projects"], ["schedules"], ["webhooks"], ["utilities"]],
    groupMove: {
      groups: [["projects", "workflows"], ["schedules"], ["webhooks"], ["utilities"]],
      root: "projects",
      target: "webhooks",
      placement: "after",
      expected: [["schedules"], ["webhooks"], ["projects", "workflows"], ["utilities"]],
    },
    stack: {
      groups: [["projects"], ["workflows"], ["schedules"], ["webhooks"], ["utilities"]],
      view: "projects",
      onto: "workflows",
      combined: [["workflows", "projects"], ["schedules"], ["webhooks"], ["utilities"]],
      extractBeside: "webhooks",
      extractPlacement: "before",
      extracted: [["workflows"], ["schedules"], ["projects"], ["webhooks"], ["utilities"]],
    },
  },
  {
    name: "utility dock",
    normalize: normalizeUtilityDockViewGroups,
    moveGroup: moveUtilityDockViewGroup,
    moveView: moveUtilityDockView,
    stored: [["search", "agents", "search"], ["unknown", "source-control"]],
    normalized: [["search", "agents"], ["source-control"], ["pull-requests"]],
    groupMove: {
      groups: [["agents", "search"], ["source-control"], ["pull-requests"]],
      root: "agents",
      target: "pull-requests",
      placement: "after",
      expected: [["source-control"], ["pull-requests"], ["agents", "search"]],
    },
    stack: {
      groups: [["agents"], ["search"], ["source-control"], ["pull-requests"]],
      view: "search",
      onto: "agents",
      combined: [["agents", "search"], ["source-control"], ["pull-requests"]],
      extractBeside: "source-control",
      extractPlacement: "after",
      extracted: [["agents"], ["source-control"], ["search"], ["pull-requests"]],
    },
  },
];

test("a persisted layout normalizes without losing or duplicating views", () => {
  for (const surface of surfaces) {
    assert.deepEqual(surface.normalize(surface.stored), surface.normalized, surface.name);
  }
});

test("dragging a group root moves the complete combined group", () => {
  for (const surface of surfaces) {
    const { groups, root, target, placement, expected } = surface.groupMove;
    assert.deepEqual(surface.moveGroup(groups, root, target, placement), expected, surface.name);
  }
});

test("a view combines under its target and extracts back to a standalone group", () => {
  for (const surface of surfaces) {
    const { groups, view, onto, combined, extractBeside, extractPlacement, extracted } = surface.stack;
    const stacked = surface.moveView(groups, view, onto, "inside");
    assert.deepEqual(stacked, combined, surface.name);
    assert.deepEqual(
      surface.moveView(stacked, view, extractBeside, extractPlacement),
      extracted,
      surface.name,
    );
  }
});

test("a combined container root stays put when dropped on its own child", () => {
  const groups = [["workflows", "projects"], ["schedules"], ["webhooks"], ["utilities"]];
  assert.deepEqual(moveSidebarView(groups, "workflows", "projects", "inside"), groups);
});
