import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetBootMetricsForTest,
  beginBootSurface,
  createBootSurfaceBarrier,
  desktopBootPrerequisitesReady,
  reportBootSurfaceStage,
} from "./boot-metrics.ts";

test("desktop boot stays covered until pane layout restoration completes", () => {
  const prerequisites = {
    snapshotHydrated: true,
    projectCatalogReady: true,
    onboardingReady: true,
    updaterStateReady: true,
    startupSettled: true,
  };

  assert.equal(desktopBootPrerequisitesReady({
    ...prerequisites,
    restorePending: true,
  }), false);
  assert.equal(desktopBootPrerequisitesReady({
    ...prerequisites,
    restorePending: false,
  }), true);
});

test("cold boot barrier releases on first paint instead of waiting for ready", async () => {
  _resetBootMetricsForTest();
  const barrier = createBootSurfaceBarrier();
  beginBootSurface("conversation", "session-a");
  await Promise.resolve();

  assert.equal(barrier.getSnapshot().pending, 1);
  reportBootSurfaceStage("conversation", "session-a", "dom");
  assert.equal(barrier.getSnapshot().pending, 1);
  reportBootSurfaceStage("conversation", "session-a", "paint");
  assert.equal(barrier.getSnapshot().pending, 0);
  reportBootSurfaceStage("conversation", "session-a", "ready");
  assert.equal(barrier.getSnapshot().pending, 0);
  barrier.dispose();
});

test("already-painted surfaces never register as pending on the next microtask", async () => {
  _resetBootMetricsForTest();
  const barrier = createBootSurfaceBarrier();
  beginBootSurface("conversation", "session-b");
  reportBootSurfaceStage("conversation", "session-b", "dom");
  reportBootSurfaceStage("conversation", "session-b", "paint");
  await Promise.resolve();

  assert.equal(barrier.getSnapshot().pending, 0);
  barrier.dispose();
});
