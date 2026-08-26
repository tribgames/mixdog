import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  AGENT_POOL_RECONCILE_MS,
  AgentActivityPane,
  liveAgentRows,
  liveTaskCount,
} from "./AgentActivityPane.tsx";
import {
  createDesktopCancellationLedger,
  desktopAgentActivityState,
  desktopCancelOutcome,
} from "../shared/agent-activity.ts";
import { LiveWorkIndicator, SessionStatusIsland } from "./SessionStatusIsland.tsx";
import { PaneStatusIsland } from "./app-snapshot-views.tsx";
import { agentActivitySessionIds } from "./desktop-types.ts";
import { defaultSessionLaneStore, useSessionLane } from "./session-lane-store.ts";
import { desktopHeaderSnapshotsEqual } from "./desktop-snapshot-store.ts";
import { shellJobsStatusEqual } from "../shared/shell-jobs-status.ts";
import {
  inheritanceContextFit,
  shouldOfferSessionInheritance,
} from "./session-inheritance.ts";

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

const TaskIndicators = ({ snapshot, onOpen }) =>
  React.createElement(LiveWorkIndicator, { snapshot, onOpen: onOpen ?? (() => {}) });

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
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.active, "true");
    assert.match(document.body.textContent, /Researcher/);
    assert.match(document.body.textContent, /Shell 1/);
    assert.deepEqual(
      [...document.querySelectorAll(".live-work-group")].map((group) => group.dataset.kind),
      ["agent", "shell"],
    );

    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: { sessionId: "lead-a", agentWorkers: [], shellJobs: { count: 0 } },
      }));
    });
    assert.equal(document.querySelectorAll(".session-work-indicator").length, 1);
    assert.equal(document.querySelectorAll('.session-work-indicator[data-active="false"]').length, 1);
    // The card stays mounted while idle (user: 호버해도 그냥 아예 안 나왔거든):
    // an idle hover answers with one explicit row instead of nothing at all.
    assert.equal(document.querySelectorAll(".live-work-popover").length, 1);
    assert.match(document.body.textContent, /No background work/);
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
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.active, "true");
    assert.match(document.body.textContent, /Agent 1/);
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
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.active, "true");
    assert.match(document.body.textContent, /npm test/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a background shell row reads as its command subject, not raw argv", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          shellJobs: {
            count: 1,
            jobs: [{
              taskId: "job-1",
              command: 'pwsh -NoProfile -Command "npm run update:dev:fast --prefix apps/desktop"',
              startedAt: Date.now() - 4_000,
            }],
          },
        },
      }));
    });
    // The card is a summary: a wrapper shell and its flags left only fragments
    // like `--prefix` behind the ellipsis (user: 문장이 --뭐 이런 걸로 깨져나옴).
    assert.match(document.body.textContent, /npm run update:dev:fast/);
    assert.doesNotMatch(document.body.textContent, /--prefix/);
    assert.doesNotMatch(document.body.textContent, /NoProfile/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("shell status equality includes detail fields that arrive after the task id", () => {
  const before = {
    count: 1,
    elapsedLabel: "1s",
    jobs: [{ taskId: "job-1", command: "", cwd: "", startedAt: null }],
  };
  assert.equal(shellJobsStatusEqual(before, {
    ...before,
    jobs: [{ taskId: "job-1", command: "npm test", cwd: "C:\\Project\\mixdog", startedAt: 123 }],
  }), false);
  assert.equal(shellJobsStatusEqual(before, {
    ...before,
    jobs: [{ ...before.jobs[0] }],
  }), true);
});

test("the status island keeps only one detail card open across hover and click controls", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionStatusIsland, {
        snapshot: {
          sessionId: "lead-a",
          stats: { currentContextTokens: 50 },
          displayContextWindow: 100,
          shellJobs: {
            count: 1,
            jobs: [{ taskId: "job-1", command: "npm test", cwd: "C:\\Project\\mixdog" }],
          },
        },
      }));
    });
    const workButton = document.querySelector(".session-work-indicator > button");
    const contextButton = document.querySelector(".session-context-indicator > button");
    await act(async () => workButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.open, "true");
    assert.equal(document.querySelector(".session-context-indicator")?.dataset.open, "false");

    await act(async () => contextButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.open, "false");
    assert.equal(document.querySelector(".session-context-indicator")?.dataset.open, "true");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("the context card offers inheritance only after the selected model changes", async () => {
  const changed = {
    sessionId: "lead-inherit",
    provider: "cursor",
    model: "gpt-5.6",
    items: [{ kind: "assistant", provider: "cursor", model: "ox-alpha", text: "done" }],
    stats: { currentEstimatedContextTokens: 50 },
    displayContextWindow: 100,
  };
  assert.equal(shouldOfferSessionInheritance(changed), true);
  assert.equal(shouldOfferSessionInheritance({
    ...changed,
    items: [{ kind: "assistant", provider: "cursor", model: "gpt-5.6", text: "done" }],
  }), false);
  assert.deepEqual(inheritanceContextFit({
    usedTokens: 80,
    compaction: { triggerTokens: 100, pressureTokens: 90 },
  }, changed), {
    known: true,
    fits: true,
    used: 90,
    limit: 100,
    percent: 90,
  });

  const dom = installDom();
  let inherited = 0;
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionStatusIsland, {
        snapshot: changed,
        onInherit: () => { inherited += 1; },
      }));
    });
    assert.ok(document.querySelector(".context-inherit"));
    await act(async () => {
      document.querySelector(".context-inherit")
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(inherited, 1);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("the context island retains its authoritative reading across incomplete stats frames", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionStatusIsland, {
        snapshot: {
          sessionId: "context-sticky",
          stats: { currentEstimatedContextTokens: 50 },
          displayContextWindow: 100,
        },
      }));
    });
    assert.match(document.body.textContent, /50%/);

    await act(async () => {
      dom.root.render(React.createElement(SessionStatusIsland, {
        snapshot: {
          sessionId: "context-sticky",
          stats: { costUsd: 1 },
          displayContextWindow: 100,
        },
      }));
    });
    assert.match(document.body.textContent, /50%/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("header snapshot equality ignores unrelated stats but tracks visible context values", () => {
  const base = {
    sessionId: "header-session",
    stats: {
      currentContextTokens: 50,
      currentEstimatedContextTokens: 60,
      costUsd: 0.25,
      inputTokens: 100,
    },
  };
  assert.equal(desktopHeaderSnapshotsEqual(base, {
    ...base,
    stats: { ...base.stats, inputTokens: 200 },
  }), true);
  assert.equal(desktopHeaderSnapshotsEqual(base, {
    ...base,
    stats: { ...base.stats, currentEstimatedContextTokens: 61 },
  }), false);
  assert.equal(desktopHeaderSnapshotsEqual(base, {
    ...base,
    stats: { ...base.stats, costUsd: 0.5 },
  }), false);
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
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.active, "true");

    await act(async () => {
      dom.root.render(React.createElement(TaskIndicators, {
        snapshot: {
          sessionId: "lead-a",
          agentJobs: [{ task_id: "task-agent-1", tag: "review", status: "completed" }],
        },
      }));
    });
    assert.equal(document.querySelector(".session-work-indicator")?.dataset.active, "false");
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
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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
    assert.equal(document.querySelector('[data-lane="session-a"] .session-work-indicator')
      ?.dataset.active, "true");
    assert.equal(document.querySelector('[data-lane="session-b"] .session-work-indicator')
      ?.dataset.active, "true");

    await act(async () => defaultSessionLaneStore.apply({
      sessionId: "session-a",
      frameSource: "live",
      snapshot: { sessionId: "session-a", shellJobs: { count: 0 } },
    }));
    assert.equal(
      document.querySelector('[data-lane="session-a"] .session-work-indicator')?.dataset.active,
      "false",
    );
    assert.equal(document.querySelector('[data-lane="session-b"] .session-work-indicator')
      ?.dataset.active, "true");
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
    onOpenContext() {},
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(PaneStatusIsland, {
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

    // A compact completion can change only the header stats while the
    // transcript frame stays identical. The pane-owned status subscription
    // must repaint from the post-compact estimate without waiting for another
    // transcript item.
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: "session-context",
        frameSource: "live",
        snapshot: {
          sessionId: "session-context",
          stats: { currentEstimatedContextTokens: 18_000 },
          displayContextWindow: 384_000,
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assert.match(document.body.textContent, /4%/);

    // routeState republishes the derived window fields as 0 whenever its route
    // comparison misses. A 0 denominator is "unresolved", not "no window": the
    // gauge keeps dividing by the last known limit instead of repainting the
    // whole reading it held before the compaction.
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: "session-context",
        frameSource: "live",
        snapshot: {
          sessionId: "session-context",
          stats: { currentEstimatedContextTokens: 192_000 },
          contextWindow: 0,
          displayContextWindow: 0,
          autoCompactTokenLimit: 0,
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assert.match(document.body.textContent, /50%/);

    await act(async () => {
      dom.root.render(React.createElement(PaneStatusIsland, {
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

test("cancellation is its own lifecycle state, never queued, running, done or idle", () => {
  // The runtime keeps stage and status apart: a cancel lands on `status` while
  // `stage` still holds the work the agent was doing when it was stopped.
  assert.equal(desktopAgentActivityState({ stage: "queued", status: "cancelled" }), "cancelled");
  assert.equal(desktopAgentActivityState({ stage: "running", status: "cancelled" }), "cancelled");
  assert.equal(desktopAgentActivityState({ status: "cancelling" }), "cancel-unconfirmed");
  assert.equal(
    desktopAgentActivityState({ stage: "running", status: "cancel-unconfirmed" }),
    "cancel-unconfirmed",
  );
  // The four live/settled states keep their meaning.
  assert.equal(desktopAgentActivityState({ status: "queued" }), "queued");
  assert.equal(desktopAgentActivityState({ status: "running" }), "running");
  assert.equal(desktopAgentActivityState({ status: "idle" }, { unread: true }), "done");
  assert.equal(desktopAgentActivityState({ status: "idle" }), "idle");
});

test("a cancelled agent leaves the live surfaces whatever its twin row still claims", () => {
  // Worker and job rows settle at different moments, so the cancelled job
  // routinely arrives beside a worker row that still says running.
  const jobCancelled = {
    sessionId: "lead-a",
    agentWorkers: [{ tag: "review", agent: "reviewer", status: "running", stage: "running" }],
    agentJobs: [{ task_id: "task-1", tag: "review", status: "cancelled" }],
  };
  assert.deepEqual(liveAgentRows(jobCancelled), []);
  assert.equal(liveTaskCount(jobCancelled), 0);

  // Same truth with the order reversed: the worker reports the cancel while
  // the job row is still marked running.
  const workerCancelled = {
    sessionId: "lead-a",
    agentWorkers: [{ tag: "review", agent: "reviewer", status: "cancelled", stage: "running" }],
    agentJobs: [{ task_id: "task-1", tag: "review", status: "running" }],
  };
  assert.deepEqual(liveAgentRows(workerCancelled), []);

  // Cancelled while still waiting in the queue.
  assert.deepEqual(liveAgentRows({
    agentJobs: [{ task_id: "task-2", tag: "plan", stage: "queued", status: "cancelled" }],
  }), []);

  // An unrelated live agent is untouched.
  assert.deepEqual(liveAgentRows({
    agentWorkers: [
      { tag: "review", agent: "reviewer", status: "cancelled" },
      { tag: "build", agent: "builder", status: "running" },
    ],
  }).map((row) => row.tag), ["build"]);
});

test("the cancellation ledger holds a stopped row against a later running snapshot", () => {
  const ledger = createDesktopCancellationLedger();
  const row = (status, turnStartedAt) => ({
    tag: "review",
    sessionId: "worker-a",
    status,
    stage: status,
    turnStartedAt,
  });
  assert.equal(ledger.apply([row("cancelled", 1_000)])[0].status, "cancelled");
  // The pool's heartbeat sidecar re-declares the session running once the
  // durable index drops the cancelled row: a stale lease, not new work.
  const resurrected = ledger.apply([{ ...row("running", 1_000), updatedAt: 9_000_000 }])[0];
  assert.equal(resurrected.status, "cancelled");
  assert.equal(resurrected.stage, "cancelled");
  assert.equal(desktopAgentActivityState(resurrected), "cancelled");
  // A genuinely newer frozen turn stamp IS new work and releases the row.
  assert.equal(ledger.apply([row("running", 2_000)])[0].status, "running");
  assert.equal(ledger.size(), 0);
});

test("an unstamped cancellation survives a heartbeat that invents a start stamp", () => {
  const ledger = createDesktopCancellationLedger();
  // An agent cancelled WHILE QUEUED never ran, so it carries no frozen stamp:
  // its ledger baseline is 0 and any later stamp would outrank it.
  assert.equal(ledger.apply([{
    tag: "plan", sessionId: "worker-queued", stage: "queued", status: "cancelled",
  }])[0].status, "cancelled");
  // The pool promotion publishes `running` with a SYNTHESIZED startedAt
  // (session createdAt / heartbeat mtime) and never a turn start.
  const promoted = ledger.apply([{
    tag: "plan", sessionId: "worker-queued", stage: "running", status: "running",
    startedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
  }])[0];
  assert.equal(promoted.status, "cancelled");
  assert.equal(promoted.stage, "cancelled");
  assert.equal(desktopAgentActivityState(promoted), "cancelled");
  // ISO heartbeat stamps take the same path.
  assert.equal(ledger.apply([{
    tag: "plan", sessionId: "worker-queued", status: "running",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }])[0].status, "cancelled");
  // Only a real turn start proves new work under that identity.
  assert.equal(ledger.apply([{
    tag: "plan", sessionId: "worker-queued", status: "running", turnStartedAt: Date.now(),
  }])[0].status, "running");
  assert.equal(ledger.size(), 0);
});

test("an unconfirmed cancel stays on the live surfaces; only a confirmed one drops", () => {
  const unconfirmed = {
    sessionId: "lead-a",
    agentWorkers: [{
      tag: "build", agent: "builder", stage: "running", status: "cancel-unconfirmed",
    }],
  };
  // Hiding this row is how a Windows git-bash survivor would vanish from the
  // surface while its process may still be alive.
  assert.deepEqual(
    liveAgentRows(unconfirmed).map((row) => [row.tag, row.state, row.queued]),
    [["build", "cancel-unconfirmed", false]],
  );
  assert.equal(liveTaskCount(unconfirmed), 1);
  // A worker still winding down is equally unproven.
  assert.deepEqual(
    liveAgentRows({ agentWorkers: [{ tag: "plan", agent: "planner", status: "cancelling" }] })
      .map((row) => row.state),
    ["cancel-unconfirmed"],
  );
  // Twin rows: the live twin must not hide the unproven truth, in either order.
  assert.deepEqual(liveAgentRows({
    agentWorkers: [{ tag: "build", agent: "builder", status: "running", stage: "running" }],
    agentJobs: [{ task_id: "task-1", tag: "build", status: "cancel-unconfirmed" }],
  }).map((row) => [row.tag, row.state]), [["build", "cancel-unconfirmed"]]);
  assert.deepEqual(liveAgentRows({
    agentWorkers: [{ tag: "build", agent: "builder", stage: "running", status: "cancel-unconfirmed" }],
    agentJobs: [{ task_id: "task-1", tag: "build", status: "running" }],
  }).map((row) => [row.tag, row.state]), [["build", "cancel-unconfirmed"]]);
  // A confirmed cancel still drops, exactly like `completed`.
  assert.deepEqual(
    liveAgentRows({ agentWorkers: [{ tag: "build", agent: "builder", status: "cancelled" }] }),
    [],
  );
});

test("the Agents pane paints a cancelled agent as cancelled, never completed or idle", async () => {
  const dom = installDom();
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() { return []; },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [
    { id: "lead-a", title: "Lead A", preview: "", updatedAt: 1, messageCount: 1 },
  ];
  const stateOf = (sessionId) => document
    .querySelector(`[data-agent-session-id="${sessionId}"] .agent-activity-elapsed`)
    ?.dataset.state;
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: false,
        sessions,
        // Both owners are unseen: the old mapping turned that into
        // "Completed" for a cancelled row.
        unreadSessionIds: new Set(["worker-queued", "worker-running", "worker-unconfirmed"]),
      }));
    });
    await act(async () => push([
      {
        tag: "plan", agent: "planner", stage: "queued", status: "cancelled",
        sessionId: "worker-queued", ownerSessionId: "lead-a",
      },
      {
        tag: "review", agent: "reviewer", stage: "running", status: "cancelled",
        sessionId: "worker-running", ownerSessionId: "lead-a", turnStartedAt: 1_000,
      },
      {
        tag: "build", agent: "builder", stage: "running", status: "cancel-unconfirmed",
        sessionId: "worker-unconfirmed", ownerSessionId: "lead-a", turnStartedAt: 1_000,
      },
    ]));
    assert.equal(stateOf("worker-queued"), "cancelled");
    assert.equal(stateOf("worker-running"), "cancelled");
    assert.equal(stateOf("worker-unconfirmed"), "cancel-unconfirmed");
    assert.match(document.body.textContent, /Cancelled/);
    assert.match(document.body.textContent, /Cancel unconfirmed/);
    assert.doesNotMatch(document.body.textContent, /Completed|Idle|Queued/);

    // A later snapshot promoting the same sessions back to running (the pool's
    // 2-minute heartbeat lease) must not resurrect either of them — including
    // the queued cancellation, which has NO frozen stamp of its own while the
    // promotion invents startedAt from the session record / heartbeat mtime.
    await act(async () => push([
      {
        tag: "plan", agent: "planner", stage: "running", status: "running",
        sessionId: "worker-queued", ownerSessionId: "lead-a",
        startedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
      },
      {
        tag: "review", agent: "reviewer", stage: "running", status: "running",
        sessionId: "worker-running", ownerSessionId: "lead-a", turnStartedAt: 1_000,
        updatedAt: Date.now(),
      },
    ]));
    assert.equal(stateOf("worker-queued"), "cancelled");
    assert.equal(stateOf("worker-running"), "cancelled");

    // Real new work under the same identity carries a newer turn stamp — the
    // one signal the heartbeat promotion never publishes.
    await act(async () => push([
      {
        tag: "plan", agent: "planner", stage: "running", status: "running",
        sessionId: "worker-queued", ownerSessionId: "lead-a", turnStartedAt: Date.now(),
      },
      {
        tag: "review", agent: "reviewer", stage: "running", status: "running",
        sessionId: "worker-running", ownerSessionId: "lead-a", turnStartedAt: Date.now(),
      },
    ]));
    assert.equal(stateOf("worker-queued"), "running");
    assert.equal(stateOf("worker-running"), "running");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("an unconfirmed cancel is reported as unconfirmed, never as a successful cancel", () => {
  // Windows git-bash survivors cannot be killed from JS: task control answers
  // with cancel-unconfirmed plus the survivor warning.
  assert.equal(
    desktopCancelOutcome("status: cancel-unconfirmed\ntask_id: task_shell_1"),
    "unconfirmed",
  );
  assert.equal(
    desktopCancelOutcome({ text: "SURVIVING_DESCENDANTS_UNREACHABLE_WARNING: 2 survivors" }),
    "unconfirmed",
  );
  assert.equal(desktopCancelOutcome({ status: "cancelled" }), "cancelled");
  assert.equal(desktopCancelOutcome({ status: "completed" }), "");
  assert.equal(desktopCancelOutcome(null), "");
});
