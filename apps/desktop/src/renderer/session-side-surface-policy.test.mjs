import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionSideDockEntryForSession,
  withSessionDiff,
  withSessionPanelView,
  withSessionSideSurface,
} from "./session-side-surface-policy.ts";

const sessionDiff = (sessionId, rel = "src/a.ts") => ({
  kind: "diff",
  project: "C:/p",
  rel,
  source: "session",
  hash: sessionId,
});

test("a session's diff shows for its own session only; other sessions keep the pane as it was", () => {
  const folded = { open: false, view: "session-diff", surface: "", diff: null };
  let diffs = new Map();
  diffs = withSessionDiff(diffs, "alpha", sessionDiff("alpha"));
  // Own session: the diff column is up, in front of the remembered panel.
  const alpha = sessionSideDockEntryForSession(folded, "alpha", null, diffs.get("alpha"));
  assert.equal(alpha.open, true);
  assert.equal(alpha.surface, "diff");
  assert.equal(alpha.diff.rel, "src/a.ts");
  // Another session in the same pane: closed stays closed (the pane entry
  // never absorbed the diff).
  const beta = sessionSideDockEntryForSession(folded, "beta", null, diffs.get("beta") ?? null);
  assert.strictEqual(beta, folded);
  // Back on the owning session, the same diff returns.
  assert.deepEqual(
    sessionSideDockEntryForSession(folded, "alpha", null, diffs.get("alpha")),
    alpha,
  );
  // Closing drops the session's entry; replacing keeps ONE per session.
  diffs = withSessionDiff(diffs, "alpha", sessionDiff("alpha", "src/b.ts"));
  assert.equal(diffs.get("alpha").rel, "src/b.ts");
  diffs = withSessionDiff(diffs, "alpha", null);
  assert.equal(diffs.size, 0);
});

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

test("the Session Diff list shows for its own session only; other sessions fold", () => {
  const showing = { open: true, view: "session-diff", surface: "", diff: null };
  // The owning session keeps the list up.
  assert.strictEqual(
    sessionSideDockEntryForSession(showing, "alpha", null, null, "session-diff"),
    showing,
  );
  // A session that never opened it folds, even though the pane remembers it.
  const folded = sessionSideDockEntryForSession(showing, "beta", null, null, null);
  assert.equal(folded.open, false);
  assert.equal(folded.surface, "");
  // Outside any session the pane stays exactly as it was.
  assert.strictEqual(
    sessionSideDockEntryForSession(showing, "", null, null, null),
    showing,
  );
});

test("a session's list restores over the pane's remembered view", () => {
  const pulling = { open: true, view: "pull-requests", surface: "", diff: null };
  const restored = sessionSideDockEntryForSession(
    pulling, "alpha", null, null, "session-diff");
  assert.equal(restored.open, true);
  assert.equal(restored.view, "session-diff");
  assert.equal(restored.surface, "");
});

test("a session file diff still wins over the session's list", () => {
  const fileDiff = {
    kind: "diff",
    project: "C:/p",
    rel: "src/a.ts",
    source: "session",
    hash: "alpha",
  };
  const shown = sessionSideDockEntryForSession(
    { open: true, view: "pull-requests", surface: "", diff: null },
    "alpha", null, fileDiff, "session-diff");
  assert.equal(shown.surface, "diff");
  assert.equal(shown.diff.rel, "src/a.ts");
});

test("session list selections stay per session", () => {
  let views = new Map();
  views = withSessionPanelView(views, "alpha", "session-diff");
  assert.equal(views.get("alpha"), "session-diff");
  assert.strictEqual(withSessionPanelView(views, "alpha", "session-diff"), views);
  views = withSessionPanelView(views, "beta", "session-diff");
  assert.equal(views.size, 2);
  views = withSessionPanelView(views, "alpha", null);
  assert.deepEqual([...views], [["beta", "session-diff"]]);
});
