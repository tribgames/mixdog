import assert from "node:assert/strict";
import test from "node:test";

import { composerDraftAfterScopeChange } from "./composer-draft.ts";
import {
  isRemoteBrowserRenderer,
  normalizeProjectionView,
  shouldAdoptProjectionSelection,
} from "./remote-ui-projection.ts";

test("a cold open adopts the paired surface's selection", () => {
  assert.equal(shouldAdoptProjectionSelection({
    first: true,
    elapsedMs: 400,
    interacted: false,
  }), true);
});

test("a touched surface is never overridden by the first projection", () => {
  assert.equal(shouldAdoptProjectionSelection({
    first: true,
    elapsedMs: 200,
    interacted: true,
  }), false);
});

test("a late first projection no longer counts as continuity", () => {
  assert.equal(shouldAdoptProjectionSelection({
    first: true,
    elapsedMs: 5_000,
    interacted: false,
  }), false);
});

test("live changes keep following after the cold window", () => {
  assert.equal(shouldAdoptProjectionSelection({
    first: false,
    elapsedMs: 60_000,
    interacted: true,
  }), true);
});

test("an unknown panel or tab never invalidates the published projection", () => {
  const view = normalizeProjectionView({
    selection: { kind: "session", id: "session-a" },
    sidebarOpen: true,
    sidebarPanel: "sessions",
    dockOpen: false,
    dockTab: "not-a-tab",
    bottomPanelOpen: false,
    bottomPanelTab: "problems",
  });
  assert.equal(view.sidebarPanel, null);
  assert.equal(view.dockTab, "agents");
  assert.deepEqual(view.selection, { kind: "session", id: "session-a" });
});

test("focused web composer keeps the native value across a scope snapshot", () => {
  assert.equal(composerDraftAfterScopeChange({
    currentDraft: "입력",
    liveDomDraft: "입력 중",
    preserveDraft: false,
    typingLive: true,
  }), "입력 중");
});

test("inactive composer still clears a draft when its scope changes", () => {
  assert.equal(composerDraftAfterScopeChange({
    currentDraft: "old session",
    liveDomDraft: "old session",
    preserveDraft: false,
    typingLive: false,
  }), "");
});

test("browser and Electron renderers select distinct transcript update paths", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 Mobile Safari" },
    });
    assert.equal(isRemoteBrowserRenderer(), true);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 Electron/40.8.4" },
    });
    assert.equal(isRemoteBrowserRenderer(), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});
