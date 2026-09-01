import assert from "node:assert/strict";
import test from "node:test";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useWorkspaceShortcuts } = await import("./app-workspace-shortcuts.ts");

function Harness({ actions }) {
  useWorkspaceShortcuts(actions);
  return null;
}

test("Ctrl+T and Ctrl+` remain unclaimed", async (t) => {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  let actionCalls = 0;
  const noop = () => { actionCalls += 1; };
  await act(async () => {
    root.render(React.createElement(Harness, {
      actions: {
        tabs: [],
        activeTabKey: "",
        navigateTab: noop,
        startTask: noop,
        openSettings: noop,
        toggleSidebar: noop,
        toggleDock: noop,
        togglePanel: noop,
        openQuickAccess: noop,
        openCommandPalette: noop,
        openFindInFiles: noop,
        openTabSwitcher: noop,
        focusSiblingPane: noop,
        focusVerticalPane: noop,
        navigateBack: noop,
        navigateForward: noop,
      },
    }));
  });

  const events = [];
  for (const key of ["t", "`"]) {
    await act(async () => {
      const event = new window.KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      events.push(event);
      window.dispatchEvent(event);
    });
  }
  assert.equal(actionCalls, 0);
  assert.deepEqual(events.map((event) => event.defaultPrevented), [false, false]);
});
