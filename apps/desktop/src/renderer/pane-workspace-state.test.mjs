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

test("a phone cold open restores session tabs into one pane", () => {
  const restored = mobilePaneWorkspaceState(mobileStored);
  assert.equal(restored.layout.type, "leaf");
  assert.deepEqual(
    restored.layout.tabs.map((tab) => `${tab.kind}:${tab.id ?? tab.rel}`),
    ["session:session-a", "session:session-b"],
  );
  assert.equal(restored.focusedLeafId, restored.layout.id);
});

test("a phone cold open keeps the tab the phone last viewed active", () => {
  assert.equal(
    mobilePaneWorkspaceState(mobileStored).layout.activeKey,
    "session:session-b",
  );
});

test("terminal and file tabs never resurrect on a phone", () => {
  const restored = mobilePaneWorkspaceState(mobileStored);
  assert.equal(
    restored.layout.tabs.some((tab) => tab.kind === "terminal" || tab.kind === "file"),
    false,
  );
});

test("a phone with only unsupported tabs restores nothing", () => {
  assert.equal(mobilePaneWorkspaceState({
    layout: {
      type: "leaf",
      id: "only",
      tabs: [{ kind: "terminal", id: "term-1" }],
      activeKey: "terminal:term-1",
    },
    focusedLeafId: "only",
  }), null);
});

test("the phone tab cap keeps the last viewed tab", () => {
  const tabs = Array.from({ length: 6 }, (_, index) => ({
    kind: "session",
    id: `session-${index}`,
  }));
  const restored = mobilePaneWorkspaceState({
    layout: {
      type: "leaf",
      id: "only",
      tabs,
      activeKey: "session:session-5",
    },
    focusedLeafId: "only",
  }, 3);
  assert.equal(restored.layout.tabs.length, 3);
  assert.equal(restored.layout.activeKey, "session:session-5");
});

test("an empty phone store falls through to the normal startup path", () => {
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
