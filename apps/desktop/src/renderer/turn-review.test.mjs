import assert from "node:assert/strict";
import test from "node:test";

import { turnReviewScope } from "./renderer-logic.mjs";

test("turn review scope survives steering rows until the outer turn completes", () => {
  const initial = [
    { kind: "user", id: "prompt-1" },
    { kind: "tool", id: "patch-1" },
  ];
  const steered = [
    ...initial,
    { kind: "user", id: "steer-1" },
  ];
  const continued = [
    ...steered,
    { kind: "tool", id: "patch-2" },
  ];

  assert.deepEqual(turnReviewScope(initial), {
    startIndex: 0,
    key: "prompt-1",
    hasActivity: true,
  });
  assert.deepEqual(turnReviewScope(steered), turnReviewScope(initial));
  assert.deepEqual(turnReviewScope(continued), turnReviewScope(initial));
});

test("turn review scope advances only after turndone and the next prompt", () => {
  const completed = [
    { kind: "user", id: "prompt-1" },
    { kind: "tool", id: "patch-1" },
    { kind: "turndone", id: "done-1" },
  ];
  const nextTurn = [
    ...completed,
    { kind: "user", id: "prompt-2" },
  ];

  assert.equal(turnReviewScope(completed).key, "prompt-1");
  assert.deepEqual(turnReviewScope(nextTurn), {
    startIndex: 3,
    key: "prompt-2",
    hasActivity: false,
  });
});
