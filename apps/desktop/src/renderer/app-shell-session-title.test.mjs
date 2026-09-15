import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useAppSessionTitle } from "./app-shell-session-title.ts";

test("useAppSessionTitle handles edit modal, draft changes, commit, and whitespace rejection", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const prior = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });

  let renamed = null;
  const sessions = [
    { id: "s1", title: "Original Title", prompt: "Hello" },
  ];
  const tabs = [
    { key: "session:s1", title: "Original Title", selection: { kind: "session", id: "s1" } },
  ];

  let hookResult;
  function TestHarness() {
    hookResult = useAppSessionTitle({
      navigationSelection: { kind: "session", id: "s1" },
      sessions,
      tabs,
      renameSession: (id, title) => { renamed = { id, title }; },
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });

    assert.equal(hookResult.visibleSessionTitle, "Original Title");
    assert.equal(hookResult.headerTitleEditingSessionId, "");

    // 1. Open editor
    await act(async () => {
      hookResult.openHeaderTitleEditor();
    });
    assert.equal(hookResult.headerTitleEditingSessionId, "s1");
    assert.equal(hookResult.headerTitleDraft, "Original Title");

    // 2. Set draft to new valid name and commit
    await act(async () => {
      hookResult.setHeaderTitleDraft("New Title");
    });
    await act(async () => {
      hookResult.commitHeaderTitleEditor(false);
    });
    assert.equal(hookResult.headerTitleEditingSessionId, "");
    assert.deepEqual(renamed, { id: "s1", title: "New Title" });

    // 3. Test empty draft on blur: invalidates and cancels without rename
    renamed = null;
    await act(async () => {
      hookResult.openHeaderTitleEditor();
      hookResult.setHeaderTitleDraft("   ");
    });
    await act(async () => {
      hookResult.commitHeaderTitleEditor(true);
    });
    assert.equal(renamed, null);
    assert.equal(hookResult.headerTitleEditingSessionId, "");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});


