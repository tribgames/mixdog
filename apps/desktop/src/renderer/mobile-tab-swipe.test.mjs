import assert from "node:assert/strict";
import test from "node:test";

import {
  swipeIntent,
  swipeTargetIndex,
} from "./mobile-tab-swipe.ts";

test("a decisive horizontal drag steps to the neighbouring tab", () => {
  assert.equal(swipeIntent(-120, 10), "next");
  assert.equal(swipeIntent(120, -10), "previous");
});

test("a vertical scroll that drifts sideways never switches tabs", () => {
  assert.equal(swipeIntent(-70, 200), null);
  // Ambiguous diagonals belong to the scroller, not the tab strip.
  assert.equal(swipeIntent(-70, 40), null);
  assert.equal(swipeIntent(-100, 40), "next");
});

test("a short drag is not a swipe", () => {
  assert.equal(swipeIntent(-40, 0), null);
});

test("the ends of the strip are hard stops", () => {
  assert.equal(swipeTargetIndex(0, 3, "previous"), 0);
  assert.equal(swipeTargetIndex(2, 3, "next"), 2);
  assert.equal(swipeTargetIndex(1, 3, "next"), 2);
  assert.equal(swipeTargetIndex(1, 3, "previous"), 0);
});

test("a single tab pane ignores swipes", () => {
  assert.equal(swipeTargetIndex(0, 1, "next"), 0);
});
