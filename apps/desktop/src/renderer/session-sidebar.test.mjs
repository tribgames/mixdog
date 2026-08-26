import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("native sidebar drag preserves the existing session title in the pane selection", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const globals = ["window", "document", "navigator", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: dom.window.CustomEvent,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const [{ SessionSidebar }, { currentPaneDrag }] = await Promise.all([
    import("./session-sidebar.tsx"),
    import("./pane-drag-session.ts"),
  ]);
  const root = createRoot(document.getElementById("root"));
  const session = {
    id: "named-session",
    title: "Existing display title",
    preview: "Original prompt",
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: "",
    classification: "task",
    projectPath: null,
    working: false,
  };
  const transferData = new Map();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData(type, value) { transferData.set(type, value); },
    getData(type) { return transferData.get(type) ?? ""; },
    setDragImage() {},
  };
  const dragEvent = (type) => {
    const event = new dom.window.Event(type, {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return event;
  };

  try {
    await act(async () => root.render(React.createElement(SessionSidebar, {
      open: true,
      sessions: [session],
      sessionsReady: true,
      selection: { kind: "new" },
      onNewTask() {},
      onResumeSession() {},
      async onRenameSession() {},
      async onArchiveSession() {},
      async onDeleteSession() {},
    })));
    const row = document.querySelector('[data-session-id="named-session"]');
    assert.ok(row);

    await act(async () => {
      row.dispatchEvent(dragEvent("dragstart"));
    });

    assert.deepEqual(
      currentPaneDrag()?.selection,
      {
        kind: "session",
        id: "named-session",
        title: "Existing display title",
      },
    );
    assert.equal(dataTransfer.getData("text/plain"), "Existing display title");

    await act(async () => {
      row.dispatchEvent(dragEvent("dragend"));
    });
    assert.equal(currentPaneDrag(), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("double-clicking a captured session row starts rename without action-button spillover", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const globals = ["window", "document", "navigator", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: dom.window.CustomEvent,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { SessionSidebar } = await import("./session-sidebar.tsx");
  const root = createRoot(document.getElementById("root"));
  const session = {
    id: "rename-session",
    title: "Rename me",
    preview: "Original prompt",
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: "",
    classification: "task",
    projectPath: null,
    working: false,
  };

  try {
    await act(async () => root.render(React.createElement(SessionSidebar, {
      open: true,
      sessions: [session],
      sessionsReady: true,
      selection: { kind: "new" },
      onNewTask() {},
      onResumeSession() {},
      async onRenameSession() {},
      async onArchiveSession() {},
      async onDeleteSession() {},
    })));
    const row = document.querySelector('[data-session-id="rename-session"]');
    const action = row?.querySelector(".session-row-action");
    const input = row?.querySelector(".session-title-input");
    assert.ok(row);
    assert.ok(action);
    assert.ok(input);

    await act(async () => {
      action.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }));
    });
    assert.equal(input.disabled, true);

    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }));
    });
    assert.equal(input.disabled, false);
    assert.equal(document.activeElement, input);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("the Recent actions menu archives recent sessions and confirms archived deletion", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const globals = ["window", "document", "navigator", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: dom.window.CustomEvent,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { SessionSidebar } = await import("./session-sidebar.tsx");
  const root = createRoot(document.getElementById("root"));
  const session = (id, archived = false, extra = {}) => ({
    id,
    title: id,
    preview: "",
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: "",
    classification: "task",
    projectPath: null,
    working: false,
    archived,
    ...extra,
  });
  const archivedCalls = [];
  const deletedCalls = [];

  try {
    await act(async () => root.render(React.createElement(SessionSidebar, {
      open: true,
      sessions: [
        session("automation-one", false, { sourceType: "schedule", sourceName: "Nightly" }),
        session("recent-one"),
        session("recent-two"),
        session("archived-one", true),
      ],
      sessionsReady: true,
      unreadSessionIds: new Set(["automation-one", "recent-one"]),
      selection: { kind: "new" },
      onNewTask() {},
      onResumeSession() {},
      async onRenameSession() {},
      async onArchiveSession(id, archived) { archivedCalls.push([id, archived]); },
      async onDeleteSession(id) { deletedCalls.push(id); },
    })));

    const automationSection = document.querySelector(".sidebar-automations");
    const recentSection = document.querySelector('section[aria-label="Recent sessions"]');
    const archivedSection = document.querySelector(".sidebar-archived");
    const automationTrigger = automationSection?.querySelector(".row-overflow-trigger");
    const recentTrigger = recentSection?.querySelector(".row-overflow-trigger");
    const archivedTrigger = archivedSection?.querySelector(".row-overflow-trigger");
    assert.ok(automationTrigger);
    assert.ok(recentTrigger);
    assert.ok(archivedTrigger);

    await act(async () => automationTrigger.click());
    const archiveAll = document.querySelector('[data-action-id="archive-all"]');
    assert.ok(archiveAll);
    await act(async () => {
      archiveAll.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls, [
      ["automation-one", true],
    ]);

    await act(async () => recentTrigger.click());
    const archiveAllRecent = document.querySelector('[data-action-id="archive-all"]');
    assert.ok(archiveAllRecent);
    await act(async () => {
      archiveAllRecent.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls, [
      ["automation-one", true],
      ["recent-one", true],
      ["recent-two", true],
    ]);

    await act(async () => archivedTrigger.click());
    const restoreAll = document.querySelector('[data-action-id="restore-all"]');
    assert.ok(restoreAll);
    await act(async () => {
      restoreAll.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(archivedCalls.at(-1), ["archived-one", false]);

    await act(async () => archivedTrigger.click());
    const deleteAll = document.querySelector('[data-action-id="delete-all-archived"]');
    assert.ok(deleteAll);
    await act(async () => deleteAll.click());
    assert.deepEqual(deletedCalls, []);
    const confirmDelete = document.querySelector('[data-action-id="confirm-delete-all-archived"]');
    assert.ok(confirmDelete);
    await act(async () => {
      confirmDelete.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(deletedCalls, ["archived-one"]);

    const automationToggle = automationSection.querySelector(".sidebar-heading-toggle");
    const recentToggle = recentSection.querySelector(".sidebar-heading-toggle");
    await act(async () => {
      automationToggle.click();
      recentToggle.click();
    });
    assert.ok(automationSection.querySelector(".sidebar-heading-dot"));
    assert.ok(recentSection.querySelector(".sidebar-heading-dot"));
    assert.equal(automationSection.querySelector(".row-overflow-trigger"), null);
    assert.equal(recentSection.querySelector(".row-overflow-trigger"), null);
    assert.ok(archivedSection.querySelector(".row-overflow-trigger"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
