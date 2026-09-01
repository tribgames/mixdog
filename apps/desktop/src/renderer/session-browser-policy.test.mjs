import assert from "node:assert/strict";
import test from "node:test";

import {
  browserDockEntryForSession,
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
  withBrowserSessionRevealed,
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

test("Browser selection follows the session instead of leaking through the pane", () => {
  const panel = {
    open: true,
    view: "sourceControl",
    surface: "",
    diff: null,
  };
  const alpha = browserDockEntryForSession(panel, "alpha", true);
  assert.equal(alpha.surface, "browser");
  assert.equal(browserDockEntryForSession(alpha, "beta", false).surface, "");
  assert.strictEqual(browserDockEntryForSession(alpha, "alpha", true), alpha);

  const diff = { ...panel, surface: "diff", diff: { kind: "diff" } };
  assert.strictEqual(browserDockEntryForSession(diff, "alpha", true), diff);
});

test("repeated reveal state updates are no-ops", () => {
  const empty = new Set();
  const revealed = withBrowserSessionRevealed(empty, "alpha", true);
  assert.deepEqual([...revealed], ["alpha"]);
  assert.strictEqual(withBrowserSessionRevealed(revealed, "alpha", true), revealed);
  assert.deepEqual([...withBrowserSessionRevealed(revealed, "alpha", false)], []);
});
