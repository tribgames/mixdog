import assert from "node:assert/strict";
import test from "node:test";

import {
  moveSidebarView,
  moveSidebarViewGroup,
  normalizeSidebarViewGroups,
} from "./sidebar-view-layout.ts";

// The activity rail states the shared view-grouping grammar over its own
// vocabulary; the table form keeps room for another surface.
const surfaces = [
  {
    name: "activity rail sidebar",
    normalize: normalizeSidebarViewGroups,
    moveGroup: moveSidebarViewGroup,
    moveView: moveSidebarView,
    stored: [["workflows", "projects", "workflows"], ["unknown", "schedules"]],
    normalized: [["workflows", "projects"], ["schedules"], ["extensions"], ["webhooks"]],
    groupMove: {
      groups: [["projects", "workflows"], ["schedules"], ["webhooks"]],
      root: "projects",
      target: "webhooks",
      placement: "after",
      expected: [["schedules"], ["webhooks"], ["projects", "workflows"]],
    },
    stack: {
      groups: [["projects"], ["workflows"], ["schedules"], ["webhooks"]],
      view: "projects",
      onto: "workflows",
      combined: [["workflows", "projects"], ["schedules"], ["webhooks"]],
      extractBeside: "webhooks",
      extractPlacement: "before",
      extracted: [["workflows"], ["schedules"], ["projects"], ["webhooks"]],
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
  const groups = [["workflows", "projects"], ["schedules"], ["webhooks"]];
  assert.deepEqual(moveSidebarView(groups, "workflows", "projects", "inside"), groups);
});
