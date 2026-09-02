import assert from "node:assert/strict";
import test from "node:test";

import {
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
} from "./session-browser-policy.ts";

const owners = [
  { leafId: "pane-a", sessionId: "alpha" },
  { leafId: "pane-b", sessionId: "beta" },
  { leafId: "pane-c", sessionId: "alpha" },
];

test("Browser Use reveals beside a visible owner without reactivating it", () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, "beta", "pane-a"), {
    leafId: "pane-b",
  });
});

test("a hidden Browser Use owner stays parked until the user returns", () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, "missing", "pane-a"), {
    leafId: null,
  });
});

test("duplicate visible session views prefer the focused pane", () => {
  assert.deepEqual(browserSurfaceRevealPlan(owners, "alpha", "pane-c"), {
    leafId: "pane-c",
  });
  assert.deepEqual(browserSurfaceRevealPlan(owners, "alpha", "pane-b"), {
    leafId: "pane-a",
  });
});

test("foreground requests reveal while parked remote requests do not", () => {
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: "alpha" }), true);
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: "alpha", reveal: true }), true);
  assert.equal(browserSurfaceRequestShouldReveal({ sessionId: "alpha", reveal: false }), false);
});
