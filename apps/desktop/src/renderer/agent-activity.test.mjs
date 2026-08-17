import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AGENT_POOL_RECONCILE_MS, AgentActivityPane } from "./AgentActivityPane.tsx";
import { ActiveAgentsIndicator, ActiveShellsIndicator } from "./ActiveAgentsIndicator.tsx";
import { PaneHeaderStatus } from "./app-snapshot-views.tsx";
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

const TaskIndicators = ({ snapshot, onOpen }) => React.createElement(React.Fragment, null,
  React.createElement(ActiveAgentsIndicator, { snapshot, onOpen: onOpen ?? (() => {}) }),
  React.createElement(ActiveShellsIndicator, { snapshot }));

test("Agent and shell chips follow only their supplied session lane activity", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          agentWorkers: [{ agent: "researcher", status: "running" }],
          shellJobs: { count: 1 },
        },
      }));
    });
    assert.deepEqual(
      [...document.querySelectorAll(".session-agents-count")].map((node) => node.textContent),
      ["1", "1"],
    );
    assert.equal(document.querySelectorAll(".session-shells-indicator").length, 1);
    assert.match(document.body.textContent, /Researcher/);
    assert.match(document.body.textContent, /Shell 1/);

    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: { sessionId: "lead-a", agentWorkers: [], shellJobs: { count: 0 } },
      }));
    });
    assert.equal(Boolean(document.querySelector(".session-agents-indicator")), false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agent chip appears immediately from an active tool call; the shell chip waits for background promotion", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          activeTools: {
            agent: { count: 1, startedAt: Date.now() - 2_000 },
            shell: { count: 12, startedAt: Date.now() - 3_000 },
          },
        },
      }));
    });
    // Foreground shell calls stream in the transcript tool card; the header
    // chip only surfaces jobs that were promoted to the background.
    assert.deepEqual(
      [...document.querySelectorAll(".session-agents-count")].map((node) => node.textContent),
      ["1"],
    );
    assert.match(document.body.textContent, /Agent 1/);
    assert.equal(Boolean(document.querySelector(".session-shells-indicator")), false);
    assert.doesNotMatch(document.body.textContent, /Shell 12/);

    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          activeTools: {
            agent: { count: 1, startedAt: Date.now() - 2_000 },
          },
          shellJobs: { count: 12, jobs: [
            { taskId: "job-1", command: "npm test", startedAt: Date.now() - 3_000 },
          ] },
        },
      }));
    });
    assert.deepEqual(
      [...document.querySelectorAll(".session-agents-count")].map((node) => node.textContent),
      ["1", "9+"],
    );
    assert.match(document.body.textContent, /npm test/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("running background agent jobs drive the header icon until terminal", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          agentJobs: [{
            task_id: "task-agent-1",
            tag: "review",
            status: "running",
            startedAt: Date.now() - 1_000,
          }],
        },
      }));
    });
    assert.equal(document.querySelector(".session-agents-count")?.textContent, "1");

    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          agentJobs: [{ task_id: "task-agent-1", tag: "review", status: "completed" }],
        },
      }));
    });
    assert.equal(Boolean(document.querySelector(".session-agents-indicator")), false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agent pane ignores a stale initial list that resolves after a live push", async () => {
  const dom = installDom();
  let resolveInitial;
  let push = () => {};
  window.mixdogDesktop = {
    listAgentPool: () => new Promise((resolve) => { resolveInitial = resolve; }),
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [
    { id: "lead-a", title: "Lead A", preview: "", updatedAt: 1, messageCount: 1 },
  ];
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, { active: false, sessions }));
    });
    await act(async () => push([{
      tag: "review",
      agent: "reviewer",
      status: "running",
      stage: "running",
      sessionId: "worker-new",
      ownerSessionId: "lead-a",
    }]));
    assert.ok(document.querySelector('[data-agent-session-id="worker-new"]'));

    await act(async () => resolveInitial([]));
    assert.ok(document.querySelector('[data-agent-session-id="worker-new"]'));
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("active Agent pane reconciles missed pool pushes and clears departed rows", async () => {
  const dom = installDom();
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  let reconcile = null;
  let pool = [{
    tag: "review",
    agent: "reviewer",
    status: "running",
    stage: "running",
    sessionId: "worker-live",
    ownerSessionId: "lead-a",
  }];
  window.setInterval = (callback, ms) => {
    if (ms === AGENT_POOL_RECONCILE_MS) {
      reconcile = callback;
      return 987654;
    }
    return originalSetInterval(callback, ms);
  };
  window.clearInterval = (id) => {
    if (id !== 987654) originalClearInterval(id);
  };
  window.mixdogDesktop = {
    async listAgentPool() { return pool; },
    subscribeAgentPool() { return () => {}; },
  };
  const sessions = [
    { id: "lead-a", title: "Lead A", preview: "", updatedAt: 1, messageCount: 1 },
  ];
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, { active: true, sessions }));
    });
    assert.ok(document.querySelector('[data-agent-session-id="worker-live"]'));
    assert.equal(typeof reconcile, "function");

    pool = [];
    await act(async () => {
      reconcile();
      await Promise.resolve();
    });
    assert.equal(Boolean(document.querySelector('[data-agent-session-id="worker-live"]')), false);
  } finally {
    await act(async () => dom.root.unmount());
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    dom.close();
  }
});

test("two session task indicators update independently without focus routing", async () => {
  const dom = installDom();
  const LaneIndicator = ({ sessionId }) => {
    const snapshot = useSessionLane(sessionId);
    return React.createElement("div", { "data-lane": sessionId },
      snapshot
        ? React.createElement(TaskIndicators, { snapshot })
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
    assert.equal(Boolean(
      document.querySelector('[data-lane="session-a"] .session-agents-indicator'),
    ), false);
    assert.equal(document.querySelector('[data-lane="session-b"] .session-agents-count')
      ?.textContent, "1");
  } finally {
    await act(async () => dom.root.unmount());
    defaultSessionLaneStore.clear();
    dom.close();
  }
});

test("new task header ignores the previous session lane cache", async () => {
  const dom = installDom();
  const props = {
    hidden: false,
    onOpen() {},
    onRemoteChange() {},
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(PaneHeaderStatus, {
        ...props,
        sessionId: "session-context",
      }));
    });
    await act(async () => defaultSessionLaneStore.apply({
      sessionId: "session-context",
      frameSource: "live",
      snapshot: {
        sessionId: "session-context",
        stats: { currentContextTokens: 516_956 },
        displayContextWindow: 1_000_000,
      },
    }));
    assert.match(document.body.textContent, /51%/);

    await act(async () => {
      dom.root.render(React.createElement(PaneHeaderStatus, {
        ...props,
        sessionId: "",
      }));
    });
    assert.match(document.body.textContent, /0%/);
    assert.doesNotMatch(document.body.textContent, /51%/);
  } finally {
    await act(async () => dom.root.unmount());
    defaultSessionLaneStore.clear();
    dom.close();
  }
});

test("Agents groups every active session and renders each session's live agents", async () => {
  const dom = installDom();
  const opened = [];
  window.mixdogDesktop = {
    async listAgentPool() {
      return [
        {
          tag: "lead:lead-a",
          agent: "lead",
          status: "running",
          stage: "running",
          sessionId: "lead-a",
          ownerSessionId: "lead-a",
          model: "grok-4.6",
          provider: "xai",
        },
        {
          tag: "research",
          agent: "researcher",
          title: "Research current behavior",
          status: "running",
          stage: "running",
          sessionId: "child-a",
          ownerSessionId: "lead-a",
          model: "gpt-5.6",
          provider: "openai",
        },
        {
          tag: "legacy-session",
          agent: "reviewer",
          title: "Review dependency update",
          status: "idle",
          stage: "idle",
          updatedAt: new Date(Date.now() - 65_000).toISOString(),
          sessionId: "child-b",
          ownerSessionId: "lead-b",
          model: "gpt-5.6",
          provider: "openai",
        },
        {
          tag: "memory",
          agent: "maintainer",
          status: "running",
          stage: "running",
          sessionId: "maintainer-a",
          ownerSessionId: "lead-a",
        },
        {
          tag: "native-search",
          agent: "web_search",
          status: "running",
          stage: "running",
          sessionId: "search-a",
          ownerSessionId: "lead-a",
        },
        {
          tag: "lead:internal-control",
          agent: "lead",
          status: "idle",
          stage: "idle",
          sessionId: "internal-control",
          ownerSessionId: "internal-control",
          model: "gpt-5.6",
          provider: "openai",
        },
      ];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
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
        onOpenLeadSession: (sessionId) => opened.push(["lead", sessionId]),
        onOpenSession: (sessionId, title, ownerSessionId) =>
          opened.push(["agent", sessionId, title, ownerSessionId]),
      }));
    });

    assert.equal(document.querySelectorAll("[data-agent-owner-session-id]").length, 2);
    assert.match(document.body.textContent, /First task/);
    assert.match(document.body.textContent, /Second task/);
    assert.doesNotMatch(document.body.textContent, /internal-control/);
    assert.match(document.body.textContent, /Idle/);
    assert.doesNotMatch(document.body.textContent, /Idle task/);
    assert.match(document.body.textContent, /Lead/);
    assert.match(document.body.textContent, /Researcher · research/);
    assert.ok(document.querySelector('[data-agent-session-id="lead-a"]'));
    assert.ok(document.querySelector('[data-agent-session-id="child-a"]'));
    assert.ok(document.querySelector('[data-agent-session-id="child-b"]'));
    assert.equal(document.querySelector('[data-agent-session-id="maintainer-a"]'), null);
    assert.equal(document.querySelector('[data-agent-session-id="search-a"]'), null);
    const firstHeading = document.querySelector('[data-lead-session-id="lead-a"]');
    assert.equal(firstHeading.getAttribute("aria-expanded"), "true");
    await act(async () => firstHeading.click());
    assert.equal(firstHeading.getAttribute("aria-expanded"), "false");
    assert.ok(document.querySelector('[data-agent-session-id="lead-a"]'));
    assert.equal(document.querySelector('[data-agent-session-id="child-a"]'), null);
    assert.ok(document.querySelector('[data-agent-session-id="child-b"]'));
    await act(async () => firstHeading.click());
    assert.equal(firstHeading.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector('[data-agent-session-id="child-a"]'));
    assert.equal(document.querySelectorAll(".workflows-agent-summary-row .projects-row-icon").length, 0);
    const runningRow = document.querySelector('[data-agent-session-id="lead-a"]').closest(".schedules-row");
    assert.equal(runningRow.querySelector(".agent-activity-status [role=status]"), null);
    assert.equal(runningRow.lastElementChild.className, "agent-activity-status");
    assert.doesNotMatch(runningRow.querySelector(".agent-activity-elapsed").textContent, /Working/);
    assert.match(runningRow.querySelector(".agent-activity-elapsed").textContent, /^\d/);
    const idleRow = document.querySelector('[data-agent-session-id="child-b"]').closest(".schedules-row");
    // A resting agent reports rest only: idle duration carries no information
    // (user decision), so the label is the bare state word.
    assert.equal(idleRow.querySelector(".agent-activity-elapsed").textContent, "Idle");
    assert.equal(idleRow.querySelector(".agent-activity-spinner-slot"), null);

    await act(async () => document.querySelector('[data-agent-session-id="lead-a"]').click());
    await act(async () => document.querySelector('[data-agent-session-id="child-b"]').click());
    assert.deepEqual(opened, [
      ["lead", "lead-a"],
      ["agent", "child-b", "Review dependency update · legacy-session", "lead-b"],
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agents keep sibling statuses independent under one owner", async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() {
      return [
        {
          tag: "lead:lead-a", agent: "lead", status: "idle", stage: "idle",
          sessionId: "lead-a", ownerSessionId: "lead-a",
        },
        {
          tag: "running", agent: "researcher", status: "running", stage: "running",
          startedAt: Date.now() - 2_000, sessionId: "child-running", ownerSessionId: "lead-a",
        },
        {
          tag: "completed", agent: "reviewer", status: "idle", stage: "idle",
          sessionId: "child-completed", ownerSessionId: "lead-a",
        },
        {
          tag: "resting", agent: "worker", status: "idle", stage: "idle",
          sessionId: "child-idle", ownerSessionId: "lead-a",
        },
      ];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [{
          id: "lead-a", title: "Mixed states", preview: "", updatedAt: 1,
          messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
        }],
        unreadSessionIds: new Set(["lead-a", "child-completed"]),
      }));
    });

    const state = (sessionId) => document
      .querySelector(`[data-agent-session-id="${sessionId}"] .agent-activity-elapsed`)
      ?.getAttribute("data-state");
    assert.equal(state("lead-a"), "done");
    assert.equal(state("child-running"), "running");
    assert.equal(state("child-completed"), "done");
    assert.equal(state("child-idle"), "idle");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agents order sessions by last idle moment and flag unseen completions", async () => {
  const dom = installDom();
  const poolRow = (owner, idleSince) => ({
    tag: `lead:${owner}`,
    agent: "lead",
    status: "idle",
    stage: "idle",
    sessionId: owner,
    ownerSessionId: owner,
    idleSince: new Date(idleSince).toISOString(),
    model: "gpt-5.6",
    provider: "openai",
  });
  window.mixdogDesktop = {
    async listAgentPool() {
      // Session-catalog order is the INVERSE of idle order here: only the pool's
      // idle stamps may decide placement.
      return [poolRow("older-idle", 1_000), poolRow("newest-idle", 9_000)];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  const session = (id, title, updatedAt) => ({
    id, title, preview: "", updatedAt, activityAt: updatedAt,
    messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
  });
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [session("newest-idle", "Newest idle", 1), session("older-idle", "Older idle", 9)],
        unreadSessionIds: new Set(["newest-idle"]),
      }));
    });

    const owners = [...document.querySelectorAll("[data-agent-owner-session-id]")]
      .map((node) => node.getAttribute("data-agent-owner-session-id"));
    assert.deepEqual(owners, ["newest-idle", "older-idle"]);
    const done = document.querySelector('[data-agent-session-id="newest-idle"]')
      .querySelector(".agent-activity-elapsed");
    assert.equal(done.getAttribute("data-state"), "done");
    assert.equal(done.textContent, "Completed");
    const idle = document.querySelector('[data-agent-session-id="older-idle"]')
      .querySelector(".agent-activity-elapsed");
    assert.equal(idle.getAttribute("data-state"), "idle");
    assert.equal(idle.textContent, "Idle");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agents move on turn start and completion only, never on a heartbeat", async () => {
  const dom = installDom();
  const idleRow = (owner, idleSince) => ({
    tag: `lead:${owner}`,
    agent: "lead",
    status: "idle",
    stage: "idle",
    sessionId: owner,
    ownerSessionId: owner,
    idleSince: new Date(idleSince).toISOString(),
    updatedAt: new Date(idleSince).toISOString(),
    model: "gpt-5.6",
    provider: "openai",
  });
  // A working row has NO idle stamp and a live heartbeat in updatedAt — the
  // exact shape that used to shove a session to the top on every tick.
  const workingRow = (owner, turnStartedAt, heartbeatAt) => ({
    ...idleRow(owner, turnStartedAt),
    status: "streaming",
    stage: "streaming",
    idleSince: null,
    turnStartedAt: new Date(turnStartedAt).toISOString(),
    updatedAt: new Date(heartbeatAt).toISOString(),
  });
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() {
      return [idleRow("first", 5_000), idleRow("second", 1_000)];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const session = (id, title) => ({
    id, title, preview: "", updatedAt: 1, activityAt: 1,
    messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
  });
  const owners = () => [...document.querySelectorAll("[data-agent-owner-session-id]")]
    .map((node) => node.getAttribute("data-agent-owner-session-id"));
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [session("first", "First"), session("second", "Second")],
      }));
    });
    assert.deepEqual(owners(), ["first", "second"]);

    // A turn that STARTED before the leader's last idle moment advances the
    // stamp without overtaking it.
    await act(async () => push([idleRow("first", 50_000), workingRow("second", 9_000, 30_000)]));
    assert.deepEqual(owners(), ["first", "second"]);

    // The heartbeat runs far past the leader's stamp and still moves nothing.
    await act(async () => push([idleRow("first", 50_000), workingRow("second", 9_000, 90_000)]));
    assert.deepEqual(owners(), ["first", "second"]);

    // Move 1 of 2: a NEW turn start promotes the session once.
    await act(async () => push([idleRow("first", 50_000), workingRow("second", 60_000, 95_000)]));
    assert.deepEqual(owners(), ["second", "first"]);
    await act(async () => push([idleRow("first", 50_000), workingRow("second", 60_000, 150_000)]));
    assert.deepEqual(owners(), ["second", "first"]);

    // Move 2 of 2: completion. The other session's fresh idle moment retakes
    // the top exactly once.
    await act(async () => push([idleRow("first", 120_000), workingRow("second", 60_000, 160_000)]));
    assert.deepEqual(owners(), ["first", "second"]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
