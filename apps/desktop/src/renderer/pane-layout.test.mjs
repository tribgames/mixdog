import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPaneLeaf,
  paneNodeAtPath,
  setPaneSplitRatio,
  splitPaneLeaf,
} from "./pane-layout.ts";

function leaf(id) {
  return createPaneLeaf({ kind: "new", draftId: id }, id);
}

function twoByTwo() {
  let root = leaf("tl");
  root = splitPaneLeaf(root, "tl", "row", leaf("tr"));
  root = splitPaneLeaf(root, "tl", "column", leaf("bl"));
  root = splitPaneLeaf(root, "tr", "column", leaf("br"));
  return root;
}

test("a 2x2 vertical sash drag moves both columns", () => {
  const next = setPaneSplitRatio(twoByTwo(), "first", 0.3);
  const left = paneNodeAtPath(next, "first");
  const right = paneNodeAtPath(next, "second");
  assert.equal(left?.type, "split");
  assert.equal(right?.type, "split");
  assert.equal(left.direction, "column");
  assert.equal(right.direction, "column");
  assert.equal(left.ratio, 0.3);
  assert.equal(right.ratio, 0.3);
});

test("a 2x2 grid line stays linked after the ratios have drifted", () => {
  const drifted = setPaneSplitRatio(twoByTwo(), "second", 0.7);
  const next = setPaneSplitRatio(drifted, "first", 0.35);
  assert.equal(paneNodeAtPath(next, "first")?.ratio, 0.35);
  assert.equal(paneNodeAtPath(next, "second")?.ratio, 0.35);
});

test("a 2x2 plus tall pane keeps the shared 2x2 line and leaves the tall pane full height", () => {
  const root = {
    type: "split",
    direction: "row",
    ratio: 0.7,
    first: twoByTwo(),
    second: leaf("tall"),
  };
  const next = setPaneSplitRatio(root, "first.first", 0.3);
  const left = paneNodeAtPath(next, "first.first");
  const mid = paneNodeAtPath(next, "first.second");
  const tall = paneNodeAtPath(next, "second");
  assert.equal(left?.type, "split");
  assert.equal(mid?.type, "split");
  assert.equal(left.ratio, 0.3);
  assert.equal(mid.ratio, 0.3);
  assert.equal(tall?.type, "leaf");
  assert.equal(tall.id, "tall");
});
