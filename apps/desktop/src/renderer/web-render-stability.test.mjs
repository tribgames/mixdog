import assert from "node:assert/strict";
import test from "node:test";

import { composerDraftAfterScopeChange } from "./composer-draft.ts";
import { isRemoteBrowserRenderer } from "./remote-ui-projection.ts";

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
