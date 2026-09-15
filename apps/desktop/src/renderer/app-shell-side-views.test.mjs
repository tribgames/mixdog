import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useSideViewSelection, useSideViewReordering } from "./app-shell-side-views.ts";

test("useSideViewSelection routes right-side views to paneSideDocks.select and left-side views to sidebarOpen", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const prior = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });

  let selectedPaneLeafId = null;
  let selectedDockViewId = null;
  let sidebarOpenApplied = null;
  let activeLeftView = "sessions";

  const focusedLeafIdRef = { current: "leaf-1" };
  const paneLeavesRef = {
    current: [{ id: "leaf-1", tabs: [{ kind: "session", id: "session-1" }], activeKey: "session:session-1" }],
  };

  const actions = {
    sideOf: (id) => (id === "browser" || id === "terminal" ? "right" : "left"),
    selectDock: (leafId, viewId) => {
      selectedPaneLeafId = leafId;
      selectedDockViewId = viewId;
    },
    activeSideViews: { left: "sessions", right: "browser" },
    setActiveSideViews: (updater) => {
      const next = typeof updater === "function" ? updater({ left: activeLeftView, right: "browser" }) : updater;
      activeLeftView = next.left;
    },
    sidebarOpen: false,
    applySidebarOpen: (open) => { sidebarOpenApplied = open; },
    closeSidebarPanels: () => {},
    mountSidebarPanel: () => {},
    trackSidebarPanelModule: () => {},
    refreshProjects: async () => {},
    paneLeavesRef,
    focusedLeafIdRef,
    browserSurfaces: {
      ensure: () => {},
    },
    pendingBrowserAutoReveal: { current: new Set() },
    setSessionSideSurface: () => {},
    setSessionPanelView: () => {},
  };

  let selectFn;
  function TestHarness() {
    selectFn = useSideViewSelection(actions);
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });

    // Right-side selection (browser) targets pane dock
    await act(async () => {
      selectFn("browser", "leaf-1");
    });
    assert.equal(selectedPaneLeafId, "leaf-1");
    assert.equal(selectedDockViewId, "browser");

    // Left-side selection using non-lazy view (agents) sets active left view and opens sidebar
    await act(async () => {
      selectFn("agents");
    });
    assert.equal(activeLeftView, "agents");
    assert.equal(sidebarOpenApplied, true);

    // Test ref-advance: update focusedLeafIdRef, select without explicit leafId -> uses new ref value
    focusedLeafIdRef.current = "leaf-2";
    paneLeavesRef.current = [
      ...paneLeavesRef.current,
      { id: "leaf-2", tabs: [{ kind: "session", id: "session-2" }], activeKey: "session:session-2" },
    ];

    await act(async () => {
      selectFn("terminal");
    });
    assert.equal(selectedPaneLeafId, "leaf-2");
    assert.equal(selectedDockViewId, "terminal");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("useSideViewReordering enforces right-side immovable invariant", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>");
  const prior = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });

  let moveGroupCalled = false;
  let moveViewCalled = false;
  const sideOf = (id) => (id === "browser" ? "right" : "left");
  const moveGroup = () => { moveGroupCalled = true; };
  const moveView = () => { moveViewCalled = true; };
  const setActiveSideViews = () => {};
  const applySidebarOpen = () => {};

  let reordering;
  function TestHarness() {
    reordering = useSideViewReordering(sideOf, moveGroup, moveView, setActiveSideViews, applySidebarOpen);
    return null;
  }

  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });

    // 1. Moving a right-side group/view is prohibited and must NOT call moveGroup/moveView
    await act(async () => {
      reordering.moveWorkbenchSideGroup("browser", "left", "sessions", "after");
    });
    assert.equal(moveGroupCalled, false, "Moving right-side group must be blocked");

    await act(async () => {
      reordering.moveWorkbenchSideView("browser", "left", "sessions", "after");
    });
    assert.equal(moveViewCalled, false, "Moving right-side view must be blocked");

    // 2. Moving to right side is also blocked
    await act(async () => {
      reordering.moveWorkbenchSideGroup("sessions", "right", "browser", "after");
    });
    assert.equal(moveGroupCalled, false, "Moving group to right side must be blocked");

    // 3. Moving left-to-left is allowed
    await act(async () => {
      reordering.moveWorkbenchSideGroup("sessions", "left", "agents", "after");
    });
    assert.equal(moveGroupCalled, true, "Moving left group to left must be permitted");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

