import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useAppMobileBack } from "./app-shell-mobile-back.ts";

function afterPopState(dom, trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dom.window.removeEventListener("popstate", once);
      reject(new Error("popstate never arrived"));
    }, 2_000);
    function once() {
      clearTimeout(timer);
      dom.window.removeEventListener("popstate", once);
      setTimeout(resolve, 0);
    }
    dom.window.addEventListener("popstate", once);
    trigger();
  });
}

test("useAppMobileBack opens each layer, re-renders with fresh callbacks without extra pop/push, and preserves quickAccessMode transitions", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    url: "https://mixdog.test/",
  });
  dom.window.document.documentElement.setAttribute("data-mixdog-mobile-tabs", "");

  const prior = new Map(["window", "document", "history", "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });

  let pushStateCount = 0;
  let backCount = 0;
  const originalPush = dom.window.history.pushState.bind(dom.window.history);
  const originalBack = dom.window.history.back.bind(dom.window.history);

  dom.window.history.pushState = (...args) => {
    pushStateCount++;
    return originalPush(...args);
  };
  dom.window.history.back = (...args) => {
    backCount++;
    return originalBack(...args);
  };

  const defaultProps = {
    sidebarOpen: false,
    applySidebarOpen: () => {},
    bottomPanelOpen: false,
    setBottomPanelOpen: () => {},
    focusedPaneDockOpen: false,
    closeFocusedPaneDock: () => {},
    settingsOpen: false,
    setSettingsOpen: () => {},
    commandSurface: null,
    closeCommandSurface: () => {},
    onboardingOpen: false,
    setOnboardingOpen: () => {},
    quickAccessMode: null,
    closeQuickAccess: () => {},
    pendingUnsavedClose: false,
    cancelPendingTabClose: () => {},
    updateDialogOpen: false,
    updaterState: { status: "idle" },
    closeDesktopUpdate: () => {},
  };

  function TestHarness(props) {
    useAppMobileBack({ ...defaultProps, ...props });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    // 1. Initial mount with everything closed: no pushes
    await act(async () => {
      root.render(React.createElement(TestHarness, defaultProps));
    });
    assert.equal(pushStateCount, 0);
    assert.equal(backCount, 0);

    // 2. Open each layer consecutively: each layer registers a sentinel
    const layers = [
      { sidebarOpen: true },
      { bottomPanelOpen: true },
      { focusedPaneDockOpen: true },
      { settingsOpen: true },
      { commandSurface: "context" },
      { onboardingOpen: true },
      { quickAccessMode: "commands" },
      { pendingUnsavedClose: true },
      { updateDialogOpen: true, updaterState: { status: "ready" } },
    ];

    let currentOpenProps = { ...defaultProps };
    let expectedPushes = 0;

    for (const layer of layers) {
      currentOpenProps = { ...currentOpenProps, ...layer };
      await act(async () => {
        root.render(React.createElement(TestHarness, currentOpenProps));
      });
      expectedPushes++;
      assert.equal(pushStateCount, expectedPushes, `Expected pushState count ${expectedPushes} when opening layer`);
    }

    // 3. Rerender with fresh closures for all handlers while all layers stay open
    // MUST NOT trigger any additional pushState or history.back
    const pushesBeforeRerender = pushStateCount;
    const backBeforeRerender = backCount;

    await act(async () => {
      root.render(React.createElement(TestHarness, {
        ...currentOpenProps,
        applySidebarOpen: () => {},
        setBottomPanelOpen: () => {},
        closeFocusedPaneDock: () => {},
        setSettingsOpen: () => {},
        closeCommandSurface: () => {},
        setOnboardingOpen: () => {},
        closeQuickAccess: () => {},
        cancelPendingTabClose: () => {},
        closeDesktopUpdate: () => {},
      }));
    });

    assert.equal(pushStateCount, pushesBeforeRerender, "Re-render with fresh closures must not re-push history");
    assert.equal(backCount, backBeforeRerender, "Re-render with fresh closures must not trigger history.back");

    // 4. Test quickAccessMode transition (e.g. from "commands" to "files")
    // Changing quickAccessMode unregisters the previous mode (invoking history.back())
    // and queues armPendingEntries until after the popstate traversal completes.
    // Register listener before the transition to avoid racing the popstate event.
    await afterPopState(dom, () => {
      act(() => {
        root.render(React.createElement(TestHarness, {
          ...currentOpenProps,
          quickAccessMode: "files",
        }));
      });
    });

    assert.ok(backCount > backBeforeRerender, "quickAccessMode transition should pop previous mode sentinel");
    assert.ok(pushStateCount > pushesBeforeRerender, "quickAccessMode transition should push new mode sentinel after popstate echo");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});


