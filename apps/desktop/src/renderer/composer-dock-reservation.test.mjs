import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewScopePending,
  reviewSlotReserved,
  toolTouchesFiles,
  turnTouchesFiles,
} from "./composer-dock-reservation.ts";

const patch = { kind: "tool", name: "apply_patch", args: {}, result: "Updated demo.txt" };
const shell = { kind: "tool", name: "shell", args: {}, result: "ok" };

test("only file-changing tool rows count as touching files", () => {
  assert.equal(toolTouchesFiles(patch), true);
  assert.equal(toolTouchesFiles({ ...shell, uiDiff: "diff --git a/x b/x" }), true);
  assert.equal(toolTouchesFiles({ ...shell, categories: { Patch: 2 } }), true);
  assert.equal(toolTouchesFiles(shell), false);
  assert.equal(toolTouchesFiles({ kind: "assistant", text: "diff --git" }), false);
  assert.equal(toolTouchesFiles(null), false);
});

test("the current turn is scanned back to its prompt, plus the live tail", () => {
  const user = { kind: "user", text: "Change it" };
  assert.equal(turnTouchesFiles([patch, user, shell], null), false, "an earlier turn's patch does not count");
  assert.equal(turnTouchesFiles([user, shell, patch], null), true);
  assert.equal(turnTouchesFiles([user, shell], patch), true, "a streaming patch counts before it settles");
  assert.equal(turnTouchesFiles([], null), false);
});

test("the review slot is reserved only while a diff can still arrive", () => {
  // Live turn that touched files: reserved so a mid-stream result fills it.
  assert.equal(reviewSlotReserved({ touchesFiles: true, turnLive: true, reviewPending: false }), true);
  // Idle scope whose first authoritative read is in flight: reserved too, so
  // the worker landing after the transcript is shown never resizes it.
  assert.equal(reviewSlotReserved({ touchesFiles: true, turnLive: false, reviewPending: true }), true);
  // Settled and idle: nothing can arrive, nothing is held.
  assert.equal(reviewSlotReserved({ touchesFiles: true, turnLive: false, reviewPending: false }), false);
  // Conversation-only turns never float an empty plate above the input.
  assert.equal(reviewSlotReserved({ touchesFiles: false, turnLive: true, reviewPending: true }), false);
});

test("a scope is pending only while a worker read will actually run", () => {
  const base = {
    active: true, hasTurnActivity: true, sessionId: "s1",
    scopeKey: "s1:turn-3", settledScope: "", cached: false,
  };
  assert.equal(reviewScopePending(base), true);
  assert.equal(reviewScopePending({ ...base, settledScope: "s1:turn-3" }), false, "a settled read is final");
  assert.equal(reviewScopePending({ ...base, settledScope: "s1:turn-2" }), true, "a new scope asks again");
  assert.equal(reviewScopePending({ ...base, cached: true }), false, "a revisit answers from the shared cache");
  assert.equal(reviewScopePending({ ...base, active: false }), false, "an unfocused pane never asks");
  assert.equal(reviewScopePending({ ...base, hasTurnActivity: false }), false, "an empty turn never asks");
  assert.equal(reviewScopePending({ ...base, sessionId: "" }), false, "a draft never asks");
});
