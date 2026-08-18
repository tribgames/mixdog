import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPaneLeaf,
  normalizePaneLayoutSessions,
  paneLeafIdInVerticalDirection,
  parsePaneLayout,
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

test("vertical pane navigation follows screen position without wrapping", () => {
  const root = twoByTwo();
  assert.equal(paneLeafIdInVerticalDirection(root, "tl", "down"), "bl");
  assert.equal(paneLeafIdInVerticalDirection(root, "bl", "up"), "tl");
  assert.equal(paneLeafIdInVerticalDirection(root, "tr", "down"), "br");
  assert.equal(paneLeafIdInVerticalDirection(root, "br", "up"), "tr");
  assert.equal(paneLeafIdInVerticalDirection(root, "tl", "up"), null);
  assert.equal(paneLeafIdInVerticalDirection(root, "br", "down"), null);
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

test("legacy agent tabs reuse normal sessions and preserve child titles", () => {
  const restored = parsePaneLayout({
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      type: "leaf",
      id: "normal",
      tabs: [{ kind: "session", id: "lead", title: "Lead task" }],
      activeKey: "session:lead",
    },
    second: {
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "duplicate",
        tabs: [{
          kind: "agent-session",
          id: "lead",
          ownerSessionId: "lead",
          title: "lead:sess_internal",
        }],
        activeKey: "agent-session:lead",
      },
      second: {
        type: "leaf",
        id: "child",
        tabs: [{
          kind: "agent-session",
          id: "child",
          ownerSessionId: "lead",
          title: "Review dependency update",
        }],
        activeKey: "agent-session:child",
      },
    },
  });
  assert.ok(restored);
  const normalized = normalizePaneLayoutSessions(restored);
  assert.ok(normalized);
  const leaves = [];
  const visit = (node) => {
    if (node.type === "leaf") leaves.push(node);
    else {
      visit(node.first);
      visit(node.second);
    }
  };
  visit(normalized);
  assert.deepEqual(leaves.flatMap((entry) => entry.tabs), [
    { kind: "session", id: "lead", title: "Lead task" },
    { kind: "session", id: "child", title: "Review dependency update" },
  ]);
});
