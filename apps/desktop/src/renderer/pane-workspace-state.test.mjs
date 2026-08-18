import assert from "node:assert/strict";
import test from "node:test";

import { initialPaneWorkspaceState } from "./pane-workspace-state.ts";

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
