import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("sidebar drag frames preserve the existing session title in the pane selection", async () => {
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

  const [{ SessionSidebar }, { subscribeTabDrag }] = await Promise.all([
    import("./session-sidebar.tsx"),
    import("./tab-drag-bus.ts"),
  ]);
  const root = createRoot(document.getElementById("root"));
  const frames = [];
  const unsubscribe = subscribeTabDrag((frame) => frames.push(frame));
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
  const pointerEvent = (type, x, y) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    Object.defineProperties(event, {
      pointerId: { value: 7 },
      pointerType: { value: "mouse" },
    });
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
      row.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      row.dispatchEvent(pointerEvent("pointermove", 20, 20));
      row.dispatchEvent(pointerEvent("pointerup", 20, 20));
    });

    assert.deepEqual(
      frames.map((frame) => ({ phase: frame.phase, selection: frame.selection })),
      [
        {
          phase: "move",
          selection: {
            kind: "session",
            id: "named-session",
            title: "Existing display title",
          },
        },
        {
          phase: "drop",
          selection: {
            kind: "session",
            id: "named-session",
            title: "Existing display title",
          },
        },
      ],
    );
  } finally {
    unsubscribe();
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
