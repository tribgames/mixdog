import assert from "node:assert/strict";
import test from "node:test";

import { dragEdgeScrollDelta } from "./use-persisted-list-order.ts";

test("drag edge scrolling accelerates toward and beyond the top edge", () => {
  assert.equal(dragEdgeScrollDelta(148, 100, 500), 0);
  assert.equal(dragEdgeScrollDelta(124, 100, 500), -9);
  assert.equal(dragEdgeScrollDelta(100, 100, 500), -18);
  assert.equal(dragEdgeScrollDelta(80, 100, 500), -18);
});

test("drag edge scrolling accelerates toward and beyond the bottom edge", () => {
  assert.equal(dragEdgeScrollDelta(452, 100, 500), 0);
  assert.equal(dragEdgeScrollDelta(476, 100, 500), 9);
  assert.equal(dragEdgeScrollDelta(500, 100, 500), 18);
  assert.equal(dragEdgeScrollDelta(520, 100, 500), 18);
});
