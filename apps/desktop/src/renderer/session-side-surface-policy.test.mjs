import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionSideDockEntryForSession,
  withSessionSideSurface,
} from "./session-side-surface-policy.ts";

const panel = {
  open: true,
  view: "source-control",
  surface: "",
  diff: null,
};

test("Terminal selection follows its session without leaking through the pane", () => {
  const alpha = sessionSideDockEntryForSession(panel, "alpha", "terminal");
  assert.equal(alpha.open, true);
  assert.equal(alpha.surface, "terminal");
  const beta = sessionSideDockEntryForSession(alpha, "beta", null);
  assert.equal(beta.open, false);
  assert.equal(beta.surface, "");
  assert.strictEqual(
    sessionSideDockEntryForSession(alpha, "alpha", "terminal"),
    alpha,
  );
});

test("Browser Use and Terminal retain independent session selections", () => {
  let surfaces = new Map();
  surfaces = withSessionSideSurface(surfaces, "alpha", "terminal");
  surfaces = withSessionSideSurface(surfaces, "beta", "browser");
  assert.deepEqual([...surfaces], [
    ["alpha", "terminal"],
    ["beta", "browser"],
  ]);
  assert.strictEqual(
    withSessionSideSurface(surfaces, "alpha", "terminal"),
    surfaces,
  );
  surfaces = withSessionSideSurface(surfaces, "alpha", null);
  assert.deepEqual([...surfaces], [["beta", "browser"]]);
});

test("a pane-local diff stays above a remembered session surface", () => {
  const diff = {
    ...panel,
    surface: "diff",
    diff: { kind: "diff" },
  };
  assert.strictEqual(
    sessionSideDockEntryForSession(diff, "alpha", "terminal"),
    diff,
  );
});
