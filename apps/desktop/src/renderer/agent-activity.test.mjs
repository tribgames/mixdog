import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AgentActivityPane } from "./AgentActivityPane.tsx";
import { ActiveTasksIndicator } from "./ActiveAgentsIndicator.tsx";
import { agentActivitySessionIds } from "./desktop-types.ts";
import { defaultSessionLaneStore, useSessionLane } from "./session-lane-store.ts";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const previous = new Map(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    root: createRoot(document.getElementById("root")),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("Agents owner list is independent from the selected session", () => {
  assert.deepEqual(agentActivitySessionIds([
    { id: "lead", leadWorking: true },
    { id: "children", agentWorking: true },
    { id: "aggregate-only", working: true },
    { id: "idle" },
  ]), ["lead", "children"]);
});

test("Task indicator follows only its supplied session lane activity", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(ActiveTasksIndicator, {
        snapshot: {
          sessionId: "lead-a",
          agentWorkers: [{ agent: "researcher", status: "running" }],
          shellJobs: { count: 1 },
        },
        onOpen() {},
      }));
    });
    assert.equal(document.querySelector(".session-agents-count")?.textContent, "2");
    assert.match(document.body.textContent, /Researcher/);
    assert.match(document.body.textContent, /Shell 1/);

    await act(async () => {
      dom.root.render(React.createElement(ActiveTasksIndicator, {
        snapshot: { sessionId: "lead-a", agentWorkers: [], shellJobs: { count: 0 } },
        onOpen() {},
      }));
    });
    assert.equal(document.querySelector(".session-agents-indicator"), null);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("two session task indicators update independently without focus routing", async () => {
  const dom = installDom();
  const LaneIndicator = ({ sessionId }) => {
    const snapshot = useSessionLane(sessionId);
    return React.createElement("div", { "data-lane": sessionId },
      snapshot
        ? React.createElement(ActiveTasksIndicator, { snapshot, onOpen() {} })
        : null);
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(React.Fragment, null,
        React.createElement(LaneIndicator, { sessionId: "session-a" }),
        React.createElement(LaneIndicator, { sessionId: "session-b" })));
    });
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: "session-a",
        frameSource: "live",
        snapshot: { sessionId: "session-a", shellJobs: { count: 1 } },
      });
      defaultSessionLaneStore.apply({
        sessionId: "session-b",
        frameSource: "live",
        snapshot: {
          sessionId: "session-b",
          agentWorkers: [{ agent: "reviewer", status: "running" }],
        },
      });
    });
    assert.equal(document.querySelector('[data-lane="session-a"] .session-agents-count')
      ?.textContent, "1");
    assert.equal(document.querySelector('[data-lane="session-b"] .session-agents-count')
      ?.textContent, "1");

    await act(async () => defaultSessionLaneStore.apply({
      sessionId: "session-a",
      frameSource: "live",
      snapshot: { sessionId: "session-a", shellJobs: { count: 0 } },
    }));
    assert.equal(document.querySelector('[data-lane="session-a"] .session-agents-indicator'), null);
    assert.equal(document.querySelector('[data-lane="session-b"] .session-agents-count')
      ?.textContent, "1");
  } finally {
    await act(async () => dom.root.unmount());
    defaultSessionLaneStore.clear();
    dom.close();
  }
});

test("Agents groups every active session and renders each session's live agents", async () => {
  const dom = installDom();
  const opened = [];
  defaultSessionLaneStore.apply({
    sessionId: "lead-a",
    frameSource: "live",
    snapshot: {
      sessionId: "lead-a",
      busy: true,
      provider: "openai",
      model: "gpt-5.6",
      agentWorkers: [{
        tag: "research",
        agent: "researcher",
        status: "running",
        sessionId: "child-a",
        ownerSessionId: "lead-a",
      }],
    },
  });
  defaultSessionLaneStore.apply({
    sessionId: "lead-b",
    frameSource: "live",
    snapshot: {
      sessionId: "lead-b",
      busy: true,
      agentWorkers: [{
        tag: "review",
        agent: "reviewer",
        status: "running",
        sessionId: "child-b",
        ownerSessionId: "lead-b",
      }],
    },
  });
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [
          {
            id: "lead-a", title: "First task", preview: "", updatedAt: 2,
            messageCount: 1, cwd: "C:\\a", classification: "task",
            projectPath: null, working: true, leadWorking: true, agentWorking: true,
          },
          {
            id: "lead-b", title: "Second task", preview: "", updatedAt: 1,
            messageCount: 1, cwd: "C:\\b", classification: "task",
            projectPath: null, working: true, leadWorking: true, agentWorking: true,
          },
          {
            id: "idle", title: "Idle task", preview: "", updatedAt: 3,
            messageCount: 1, cwd: "C:\\idle", classification: "task",
            projectPath: null,
          },
        ],
        activeSessionIds: ["lead-a", "lead-b"],
        onOpenLeadSession: (sessionId) => opened.push(["lead", sessionId]),
        onOpenSession: (sessionId, title, ownerSessionId) =>
          opened.push(["agent", sessionId, title, ownerSessionId]),
      }));
    });

    assert.equal(document.querySelectorAll("[data-agent-owner-session-id]").length, 2);
    assert.match(document.body.textContent, /First task/);
    assert.match(document.body.textContent, /Second task/);
    assert.doesNotMatch(document.body.textContent, /Idle task/);
    assert.ok(document.querySelector('[data-agent-session-id="child-a"]'));
    assert.ok(document.querySelector('[data-agent-session-id="child-b"]'));

    await act(async () => document.querySelector('[data-lead-session-id="lead-a"]').click());
    await act(async () => document.querySelector('[data-agent-session-id="child-b"]').click());
    assert.deepEqual(opened, [
      ["lead", "lead-a"],
      ["agent", "child-b", "review", "lead-b"],
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    defaultSessionLaneStore.clear();
    dom.close();
  }
});
