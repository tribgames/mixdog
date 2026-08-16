import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampDesktopPanelWidth,
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
  DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  DESKTOP_UTILITY_DOCK_MIN_WIDTH,
} from "../shared/window-layout.ts";

test("fresh side panels start at their minimum widths", () => {
  assert.equal(DESKTOP_SIDEBAR_DEFAULT_WIDTH, DESKTOP_SIDEBAR_MIN_WIDTH);
  assert.equal(DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH, DESKTOP_UTILITY_DOCK_MIN_WIDTH);
  assert.equal(
    clampDesktopPanelWidth(Number.NaN, DESKTOP_SIDEBAR_MIN_WIDTH, 420),
    DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  );
  assert.equal(
    clampDesktopPanelWidth(Number.NaN, DESKTOP_UTILITY_DOCK_MIN_WIDTH, 560),
    DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  );
});

test("cached side-panel widths restore within their supported bounds", () => {
  assert.equal(clampDesktopPanelWidth(344, DESKTOP_SIDEBAR_MIN_WIDTH, 420), 344);
  assert.equal(clampDesktopPanelWidth(488, DESKTOP_UTILITY_DOCK_MIN_WIDTH, 560), 488);
  assert.equal(clampDesktopPanelWidth(100, DESKTOP_SIDEBAR_MIN_WIDTH, 420), 232);
  assert.equal(clampDesktopPanelWidth(900, DESKTOP_UTILITY_DOCK_MIN_WIDTH, 560), 560);
});
