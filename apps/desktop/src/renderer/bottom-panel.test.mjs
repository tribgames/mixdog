import assert from "node:assert/strict";
import test from "node:test";

import {
  bottomPanelOpenForPane,
  restoreBottomPanelOpenPaneIds,
  setBottomPanelPaneOpen,
} from "./bottom-panel-pane-state.ts";

test("the Problems panel follows the PANE that opened it", () => {
  let openPaneIds = new Set();
  openPaneIds = setBottomPanelPaneOpen(openPaneIds, "pane-a", true);

  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-a"), true);
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-b"), false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-a"), true);

  openPaneIds = setBottomPanelPaneOpen(openPaneIds, "pane-b", true);
  openPaneIds = setBottomPanelPaneOpen(openPaneIds, "pane-a", false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-a"), false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-b"), true);
});

test("legacy global panel state migrates to the active PANE", () => {
  const openPaneIds = restoreBottomPanelOpenPaneIds({ open: true }, "pane-a");
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-a"), true);
  assert.equal(bottomPanelOpenForPane(openPaneIds, "pane-b"), false);
});
