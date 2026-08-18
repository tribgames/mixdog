import assert from "node:assert/strict";
import test from "node:test";
import {
  moveSidebarView,
  moveSidebarViewGroup,
  normalizeSidebarViewGroups,
} from "./sidebar-view-layout.ts";

test("sidebar view layout normalizes persisted groups without losing views", () => {
  assert.deepEqual(
    normalizeSidebarViewGroups([
      ["workflows", "projects", "workflows"],
      ["unknown", "schedules"],
    ]),
    [
      ["workflows", "projects"],
      ["schedules"],
      ["webhooks"],
      ["utilities"],
    ],
  );
});

test("activity rail drag reorders a complete combined group", () => {
  assert.deepEqual(
    moveSidebarViewGroup(
      [["projects", "workflows"], ["schedules"], ["webhooks"], ["utilities"]],
      "projects",
      "webhooks",
      "after",
    ),
    [["schedules"], ["webhooks"], ["projects", "workflows"], ["utilities"]],
  );
});

test("view drag combines under the target and can extract as a standalone group", () => {
  const combined = moveSidebarView(
    [["projects"], ["workflows"], ["schedules"], ["webhooks"], ["utilities"]],
    "projects",
    "workflows",
    "inside",
  );
  assert.deepEqual(
    combined,
    [["workflows", "projects"], ["schedules"], ["webhooks"], ["utilities"]],
  );
  assert.deepEqual(
    moveSidebarView(combined, "projects", "webhooks", "before"),
    [["workflows"], ["schedules"], ["projects"], ["webhooks"], ["utilities"]],
  );
});

test("a combined container root remains stable when dropped on its own child", () => {
  const groups = [["workflows", "projects"], ["schedules"], ["webhooks"], ["utilities"]];
  assert.deepEqual(
    moveSidebarView(groups, "workflows", "projects", "inside"),
    groups,
  );
});
