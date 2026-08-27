import assert from "node:assert/strict";
import test from "node:test";

import {
  initialPaneWorkspaceState,
  mobilePaneWorkspaceState,
} from "./pane-workspace-state.ts";
import { paneTabAcrossVisualBoundary } from "./pane-layout.ts";

const mobileStored = {
  layout: {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: {
      type: "leaf",
      id: "left",
      tabs: [
        { kind: "session", id: "session-a" },
        { kind: "terminal", id: "term-1" },
      ],
      activeKey: "session:session-a",
    },
    second: {
      type: "leaf",
      id: "right",
      tabs: [
        { kind: "file", project: "p", rel: "a.ts" },
        { kind: "session", id: "session-b" },
      ],
      activeKey: "session:session-b",
    },
  },
  focusedLeafId: "right",
};

test("a phone restart resets every stored pane and tab", () => {
  assert.equal(mobilePaneWorkspaceState(mobileStored), null);
  assert.equal(mobilePaneWorkspaceState(null), null);
});

test("session validation keeps the persisted pane geometry on first paint", () => {
  const stored = {
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.37,
      first: {
        type: "leaf",
        id: "left",
        tabs: [{ kind: "session", id: "session-a" }],
        activeKey: "session:session-a",
      },
      second: {
        type: "leaf",
        id: "right",
        tabs: [{ kind: "session", id: "session-b" }],
        activeKey: "session:session-b",
      },
    },
    focusedLeafId: "right",
  };
  assert.strictEqual(initialPaneWorkspaceState(stored, null), stored);
});

test("forward pane traversal enters at the first tab instead of the last active tab", () => {
  const target = paneTabAcrossVisualBoundary(mobileStored.layout, "left", 1);
  assert.equal(target?.leafId, "right");
  assert.deepEqual(target?.selection, { kind: "file", project: "p", rel: "a.ts" });
});

test("backward pane traversal enters at the last tab instead of the last active tab", () => {
  const target = paneTabAcrossVisualBoundary({
    ...mobileStored.layout,
    first: {
      ...mobileStored.layout.first,
      activeKey: "session:session-a",
      tabs: [
        { kind: "session", id: "session-a" },
        { kind: "session", id: "session-c" },
      ],
    },
  }, "right", -1);
  assert.equal(target?.leafId, "left");
  assert.deepEqual(target?.selection, { kind: "session", id: "session-c" });
});
