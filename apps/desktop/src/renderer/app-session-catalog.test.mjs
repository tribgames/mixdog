import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { useSessionCatalog } from "./app-session-catalog.ts";

test("a staged first-prompt row keeps its DOM identity until the durable catalog takes over", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const previous = new Map(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let pushSessions = () => {};
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.mixdogDesktop = {
    subscribeSessions(listener) {
      pushSessions = listener;
      return () => {};
    },
  };

  const root = createRoot(document.getElementById("root"));
  let catalog;
  function Harness() {
    catalog = useSessionCatalog(() => {});
    return React.createElement("ul", null, catalog.sessions.map((session) =>
      React.createElement("li", {
        key: session.id,
        "data-session-id": session.id,
      }, session.title)));
  }

  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => catalog.stageCreatedSession({
      id: "first_prompt",
      preview: "First prompt",
      title: "First prompt",
      updatedAt: 10,
      activityAt: 10,
      messageCount: 1,
      cwd: "",
      classification: "task",
      projectPath: null,
      working: true,
    }));
    const stagedNode = document.querySelector('[data-session-id="first_prompt"]');
    assert.ok(stagedNode);

    await act(async () => pushSessions([{
      id: "older",
      preview: "Older",
      title: "Older",
      updatedAt: 1,
      activityAt: 1,
      messageCount: 1,
      cwd: "",
      classification: "task",
      projectPath: null,
      working: false,
    }]));
    assert.strictEqual(
      document.querySelector('[data-session-id="first_prompt"]'),
      stagedNode,
      "an early watcher scan must not remove and recreate the staged row",
    );
    assert.deepEqual(
      [...document.querySelectorAll("[data-session-id]")].map((node) => node.dataset.sessionId),
      ["first_prompt", "older"],
      "an early watcher scan must keep the staged first-submit row at the top",
    );

    await act(async () => pushSessions([{
      id: "first_prompt",
      preview: "First prompt",
      title: "First prompt",
      updatedAt: 11,
      activityAt: 11,
      messageCount: 2,
      cwd: "C:/runtime",
      classification: "task",
      projectPath: null,
      working: true,
    }, {
      id: "older",
      preview: "Older",
      title: "Older",
      updatedAt: 1,
      activityAt: 1,
      messageCount: 1,
      cwd: "",
      classification: "task",
      projectPath: null,
      working: false,
    }]));
    assert.deepEqual(
      [...document.querySelectorAll("[data-session-id]")].map((node) => node.dataset.sessionId),
      ["first_prompt", "older"],
    );
    assert.strictEqual(
      document.querySelector('[data-session-id="first_prompt"]'),
      stagedNode,
      "durable reconciliation must update the existing keyed row",
    );

    await act(async () => pushSessions([]));
    assert.equal(
      document.querySelector('[data-session-id="first_prompt"]'),
      null,
      "after durable confirmation later authoritative removals still apply",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
