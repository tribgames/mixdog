import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  AGENT_POOL_RECONCILE_MS,
  AgentActivityPane,
  agentActivityGroups,
  flattenAgentActivityNodes,
  liveAgentRows,
  liveTaskCount,
} from "./AgentActivityPane.tsx";
import {
  createDesktopCancellationLedger,
  desktopAgentActivityState,
  desktopCancelOutcome,
} from "../shared/agent-activity.ts";
import { LiveWorkIndicator, SessionStatusIsland } from "./SessionStatusIsland.tsx";
import {
  formatGoalDuration,
  goalCompletedTimeLabel,
  goalElapsedLabel,
  goalTimeLabel,
  SessionGoalIsland,
} from "./SessionGoalIsland.tsx";
import { CompletionStatus } from "./transcript-status.tsx";
import { PaneContextIndicator } from "./app-snapshot-views.tsx";
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

test("the status island carries the context gauge without the retired work readout", async () => {
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
    // Live shell work no longer mints a chrome slot (user: 에이전트 쉘 표기줄
    // 자체를 숨기고); the gauge is the island's only readout.
    assert.equal(document.querySelector(".session-work-indicator"), null);
    const contextButton = document.querySelector(".session-context-indicator > button");
    await act(async () => contextButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(document.querySelector(".session-context-indicator")?.dataset.open, "true");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("the status island places the pane dock toggle last and reports its state", async () => {
  const dom = installDom();
  let toggles = 0;
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionStatusIsland, {
        snapshot: {
          sessionId: "lead-a",
          stats: { currentContextTokens: 50 },
          displayContextWindow: 100,
        },
        dockOpen: true,
        onToggleDock: () => { toggles += 1; },
      }));
    });
    const island = document.querySelector(".session-status-island");
    const dockToggle = document.querySelector(".session-status-dock-toggle");
    assert.equal(island?.lastElementChild, dockToggle);
    assert.equal(dockToggle?.getAttribute("aria-pressed"), "true");
    await act(async () => {
      dockToggle?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(toggles, 1);
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
  assert.equal(desktopHeaderSnapshotsEqual(base, {
    ...base,
    goal: { id: "goal-1", status: "active", objective: "Finish it" },
  }), false);
});

test("Goal island keeps its summary compact and toggles from the capsule", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionGoalIsland, {
        snapshot: {
          sessionId: "goal-session",
          goal: {
            id: "goal-simple",
            title: "Short Goal Title",
            objective: "A much longer objective that should not consume the progress and elapsed-time regions",
            status: "active",
            tasks: [
              { id: "task_1", text: "Implement the change", status: "completed", kind: "work" },
              { id: "task_2", text: "Check mobile layout", status: "in_progress", kind: "work" },
              { id: "task_3", text: "Verify the objective", status: "pending", kind: "verification" },
            ],
            tasksTotal: 3,
            tasksCompleted: 1,
            timeLimitMs: 60 * 60 * 1000,
            timeUsedMs: 5 * 60 * 1000,
            remainingMs: 60 * 60 * 1000,
            deadlineAt: Date.now() + 60 * 60 * 1000,
          },
        },
      }));
    });
    assert.equal(document.querySelector(".session-goal-objective")?.textContent, "Short Goal Title");
    assert.ok(document.querySelector(".session-goal-glyph .mx-icon.lucide-crosshair"));
    assert.equal(document.querySelector(".session-goal-glyph .lucide-target"), null);
    assert.equal(document.querySelector(".session-goal-glyph .lucide-flag"), null);
    assert.equal(document.querySelector(".session-goal-glyph .lucide-flag-triangle-right"), null);
    assert.equal(document.querySelector(".session-goal-progress")?.textContent, "1/3");
    assert.match(document.querySelector(".session-goal-time")?.textContent || "", /^\d+:\d{2}$/);
    assert.match(document.querySelector(".session-goal-meta")?.textContent || "", /^1\/3·\d+:\d{2}$/);
    const trigger = document.querySelector(".session-goal-trigger");
    assert.equal(document.querySelector(".session-goal-toggle"), null);
    assert.equal(trigger?.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector(".session-goal-drawer")?.getAttribute("aria-hidden"), "true");

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(trigger?.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector(".session-goal-drawer")?.getAttribute("aria-hidden"), "false");
    assert.equal(document.querySelectorAll(".session-goal-task-list > li").length, 3);
    assert.equal(document.querySelectorAll(".session-goal-task-list > li .mx-icon").length, 3);
    assert.equal(
      [...document.querySelectorAll(".session-goal-task-list > li > span")]
        .some((marker) => /[✓◐○]/u.test(marker.textContent || "")),
      false,
    );
    assert.doesNotMatch(document.body.textContent, /Verification/);
    assert.equal(document.querySelector(".session-goal-popover"), null);
    assert.doesNotMatch(document.body.textContent, /Edit goal|Stop goal|Complete/);
    assert.equal(document.querySelector(".session-goal-menu"), null);
    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(trigger?.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector(".session-goal-drawer")?.getAttribute("aria-hidden"), "true");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("blocked Goal island renders the specific blocker", async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionGoalIsland, {
        snapshot: {
          sessionId: "goal-session",
          goal: {
            id: "goal-blocked",
            objective: "Deploy the verified result",
            status: "blocked",
            blocker: "Waiting for deployment credentials",
          },
        },
      }));
    });
    await act(async () => {
      document.querySelector(".session-goal-trigger")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(
      document.querySelector(".session-goal-blocker")?.textContent,
      "Waiting for deployment credentials",
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("completed Goal island keeps the compact elapsed clock and no extra action", async () => {
  const dom = installDom();
  const completedAt = new Date("2026-08-28T14:49:55.000Z").getTime();
  try {
    await act(async () => {
      dom.root.render(React.createElement(SessionGoalIsland, {
        snapshot: {
          sessionId: "goal-session",
          goal: {
            id: "goal-complete",
            objective: "Completed Goal",
            status: "complete",
            timeUsedMs: 60 * 1000,
            completedAt,
          },
        },
      }));
    });
    const time = document.querySelector(".session-goal-time")?.textContent || "";
    assert.equal(time, "1:00");
    assert.doesNotMatch(time, /in progress/);
    await act(async () => {
      document.querySelector(".session-goal-trigger")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(document.querySelector(".session-goal-trigger")?.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector(".session-goal-popover"), null);
    assert.equal(document.querySelector(".session-goal-panel")?.getAttribute("role"), "region");
    assert.doesNotMatch(document.body.textContent, /Edit goal|Resume|Stop goal|Clear|Delete/);
    assert.equal(document.querySelector(".session-goal-menu"), null);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Goal completed time and response completion time stay semantically separate", async () => {
  const completedAt = new Date("2026-08-28T14:49:55.000Z").getTime();
  assert.equal(
    goalCompletedTimeLabel({ status: "complete", completedAt }),
    new Date(completedAt).toLocaleTimeString(undefined, { timeStyle: "short" }),
  );
  assert.equal(goalCompletedTimeLabel({ status: "active", completedAt }), "");

  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(React.createElement(CompletionStatus, {
        item: { kind: "turndone", elapsedMs: 450_000, verb: "Wrapped" },
      }));
    });
    assert.equal(document.querySelector(".turn-status.complete > span")?.textContent, "Wrapped for 7m 30s");
    assert.ok(document.querySelector(".turn-status.complete .mx-icon.lucide-check"));
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Goal clock labels explicit elapsed, total, and remaining time", () => {
  const now = 1_000_000;
  assert.equal(formatGoalDuration(40_619), "0:41");
  assert.equal(formatGoalDuration(3_661_000), "1:01:01");
  assert.equal(goalTimeLabel({
    status: "active",
    timeLimitMs: 300_000,
    timeUsedMs: 40_619,
    remainingMs: 259_381,
    deadlineAt: now + 259_381,
  }, now), "0:41 / 5:00 · 4:19 remaining");
  assert.equal(goalElapsedLabel({
    status: "active",
    timeLimitMs: 300_000,
    timeUsedMs: 40_619,
    remainingMs: 259_381,
    deadlineAt: now + 259_381,
  }, now), "0:41");
  assert.equal(goalTimeLabel({
    status: "active",
    timeLimitMs: 0,
    timeUsedMs: 40_619,
    remainingMs: null,
    snapshotAt: now,
  }, now + 1_000), "0:42 elapsed");
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
      dom.root.render(React.createElement(PaneContextIndicator, {
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
      dom.root.render(React.createElement(PaneContextIndicator, {
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
    assert.equal(done.textContent, "Task complete");
    const idle = document.querySelector('[data-agent-session-id="older-idle"]')
      .querySelector(".agent-activity-elapsed");
    assert.equal(idle.getAttribute("data-state"), "idle");
    assert.equal(idle.textContent, "Idle");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("Agents order by creation, then move on turn start and completion only", async () => {
  const dom = installDom();
  const idleRow = (owner, createdAt, idleSince) => ({
    tag: `lead:${owner}`,
    agent: "lead",
    status: "idle",
    stage: "idle",
    sessionId: owner,
    ownerSessionId: owner,
    createdAt: new Date(createdAt).toISOString(),
    idleSince: new Date(idleSince).toISOString(),
    updatedAt: new Date(idleSince).toISOString(),
    model: "gpt-5.6",
    provider: "openai",
  });
  // A working row has NO idle stamp and a live heartbeat in updatedAt — the
  // exact shape that used to shove a session to the top on every tick.
  const workingRow = (owner, createdAt, turnStartedAt, heartbeatAt) => ({
    ...idleRow(owner, createdAt, createdAt),
    status: "streaming",
    stage: "streaming",
    idleSince: null,
    turnStartedAt: new Date(turnStartedAt).toISOString(),
    updatedAt: new Date(heartbeatAt).toISOString(),
  });
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() {
      return [idleRow("first", 2_000, 5_000), idleRow("second", 1_000, 1_000)];
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
        sessions: [session("first", "First"), session("second", "Second"),
          session("third", "Third")],
      }));
    });
    assert.deepEqual(owners(), ["first", "second"]);

    // An older turn start advances the stamp without overtaking the newer
    // completion already holding the top slot.
    await act(async () => push([
      idleRow("first", 2_000, 50_000), workingRow("second", 1_000, 9_000, 30_000),
    ]));
    assert.deepEqual(owners(), ["first", "second"]);

    // The heartbeat runs far past the leader's stamp and still moves nothing.
    await act(async () => push([
      idleRow("first", 2_000, 50_000), workingRow("second", 1_000, 9_000, 90_000),
    ]));
    assert.deepEqual(owners(), ["first", "second"]);

    // A new turn start promotes the session exactly once.
    await act(async () => push([
      idleRow("first", 2_000, 50_000), workingRow("second", 1_000, 60_000, 95_000),
    ]));
    assert.deepEqual(owners(), ["second", "first"]);
    await act(async () => push([
      idleRow("first", 2_000, 50_000), workingRow("second", 1_000, 60_000, 150_000),
    ]));
    assert.deepEqual(owners(), ["second", "first"]);

    // Completion is the other promotion: the newly idle session retakes the top.
    await act(async () => push([
      idleRow("first", 2_000, 120_000), workingRow("second", 1_000, 60_000, 160_000),
    ]));
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

const hierarchyPool = () => [
  {
    tag: "lead", agent: "lead", status: "running", stage: "running",
    sessionId: "lead-a", ownerSessionId: "lead-a",
    turnStartedAt: new Date(Date.now() - 5_000).toISOString(),
  },
  {
    tag: "research", agent: "researcher", status: "running", stage: "running",
    sessionId: "child-a", ownerSessionId: "lead-a", parentSessionId: "lead-a",
    turnStartedAt: new Date(Date.now() - 4_000).toISOString(),
  },
  {
    // Producer shape: every descendant carries the ROOT owner session, and the
    // immediate edge is a separate parentSessionId.
    tag: "review", agent: "reviewer", status: "running", stage: "running",
    sessionId: "grand-a", ownerSessionId: "lead-a", parentSessionId: "child-a",
    turnStartedAt: new Date(Date.now() - 3_000).toISOString(),
  },
  {
    tag: "plan", agent: "planner", status: "idle", stage: "idle",
    sessionId: "great-a", ownerSessionId: "lead-a", parentSessionId: "grand-a",
    updatedAt: new Date(Date.now() - 65_000).toISOString(),
  },
  {
    // Legacy row: no parentSessionId at all, so ownerSessionId is the link.
    tag: "docs", agent: "writer", status: "running", stage: "running",
    sessionId: "child-legacy", ownerSessionId: "lead-a",
    turnStartedAt: new Date(Date.now() - 2_000).toISOString(),
  },
  {
    // The immediate parent already finished and left the pool: the row must
    // stay visible as a top-level orphan under its valid root.
    tag: "audit", agent: "auditor", status: "running", stage: "running",
    sessionId: "orphan-a", ownerSessionId: "lead-a", parentSessionId: "gone-a",
    turnStartedAt: new Date(Date.now() - 1_000).toISOString(),
  },
];

test("the owner session is the authoritative root and the parent edge only nests", () => {
  const groups = agentActivityGroups(hierarchyPool(), (id) => id === "lead-a");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ownerId, "lead-a");
  assert.equal(groups[0].agents.length, 6);
  const rows = flattenAgentActivityNodes(groups[0].nodes);
  // Lead → direct child → descendant, with the orphan kept at the Lead's own
  // child level rather than dropped or buried.
  assert.deepEqual(rows.map((node) => [node.sessionId, node.depth, node.parentSessionId]), [
    ["lead-a", 0, ""],
    ["child-a", 1, "lead-a"],
    ["grand-a", 2, "child-a"],
    ["great-a", 3, "grand-a"],
    ["child-legacy", 1, "lead-a"],
    ["orphan-a", 1, "lead-a"],
  ]);
  assert.deepEqual(rows.map((node) => `${node.posInSet}/${node.setSize}`), [
    "1/1", "1/3", "1/1", "1/1", "2/3", "3/3",
  ]);
  // A group is real only through its root: no catalog row, no surface.
  assert.deepEqual(agentActivityGroups(hierarchyPool(), () => false), []);
});

test("a descendant without a root stamp still resolves through its parent chain", () => {
  // Older producer shape: ownerSessionId is the IMMEDIATE parent, so the root
  // is reached by climbing, and never by adopting a non-catalog id.
  const groups = agentActivityGroups([
    {
      tag: "research", agent: "researcher", status: "running", stage: "running",
      sessionId: "child-a", ownerSessionId: "lead-a",
    },
    {
      tag: "review", agent: "reviewer", status: "running", stage: "running",
      sessionId: "legacy-grand", ownerSessionId: "child-a", parentSessionId: "child-a",
    },
    {
      // Nothing links this row to a catalog session: an internal reservation.
      tag: "spare", agent: "reviewer", status: "running", stage: "running",
      sessionId: "unrooted", ownerSessionId: "ghost-a", parentSessionId: "ghost-a",
    },
  ], (id) => id === "lead-a");
  assert.equal(groups.length, 1);
  assert.deepEqual(
    flattenAgentActivityNodes(groups[0].nodes)
      .map((node) => [node.sessionId, node.depth]),
    [["child-a", 0], ["legacy-grand", 1]],
  );
});

test("Agent hierarchy survives a cyclic or self-referencing spawn chain", () => {
  const groups = agentActivityGroups([
    {
      tag: "lead", agent: "lead", status: "running", stage: "running",
      sessionId: "lead-a", ownerSessionId: "lead-a",
    },
    {
      // A self-parent still belongs to its owner instead of vanishing.
      tag: "self", agent: "researcher", status: "running", stage: "running",
      sessionId: "child-self", ownerSessionId: "lead-a", parentSessionId: "child-self",
    },
    {
      tag: "x", agent: "reviewer", status: "running", stage: "running",
      sessionId: "cycle-x", ownerSessionId: "lead-a", parentSessionId: "cycle-y",
    },
    {
      tag: "y", agent: "reviewer", status: "running", stage: "running",
      sessionId: "cycle-y", ownerSessionId: "lead-a", parentSessionId: "cycle-x",
    },
  ], (id) => id === "lead-a");
  assert.equal(groups.length, 1);
  // Nothing in a cycle is lost: it re-enters the tree beneath the valid root.
  assert.deepEqual(
    flattenAgentActivityNodes(groups[0].nodes).map((node) => [node.sessionId, node.depth]),
    [["lead-a", 0], ["child-self", 1], ["cycle-x", 1], ["cycle-y", 2]],
  );
});

test("the Agent window renders the Parent-Child tree and folds every generation", async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() { return hierarchyPool(); },
    subscribeAgentPool() { return () => {}; },
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [{
          id: "lead-a", title: "First task", preview: "", updatedAt: 2,
          messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
          working: true, leadWorking: true, agentWorking: true,
        }],
        unreadSessionIds: new Set(["great-a"]),
      }));
    });

    const tree = document.querySelector(".agent-activity-page .schedules-list");
    assert.equal(tree.getAttribute("role"), "tree");
    assert.equal(tree.getAttribute("aria-label"), "First task");
    const rowAt = (sessionId) =>
      document.querySelector(`[data-agent-session-id="${sessionId}"]`);
    assert.deepEqual(
      [...document.querySelectorAll("[data-agent-session-id]")]
        .map((node) => node.getAttribute("data-agent-session-id")),
      ["lead-a", "child-a", "grand-a", "great-a", "child-legacy", "orphan-a"],
    );
    assert.deepEqual(
      [...document.querySelectorAll("[data-agent-session-id]")]
        .map((node) => node.getAttribute("data-agent-depth")),
      ["0", "1", "2", "3", "1", "1"],
    );
    assert.equal(rowAt("grand-a").getAttribute("data-agent-parent-session-id"), "child-a");
    assert.equal(rowAt("great-a").getAttribute("data-agent-parent-session-id"), "grand-a");
    // A lost parent never hides real work: the orphan stays at the Lead's own
    // child level.
    assert.equal(rowAt("orphan-a").getAttribute("data-agent-parent-session-id"), "lead-a");
    // Accessibility: one flat tree, hierarchy announced by level and position.
    assert.equal(rowAt("child-a").getAttribute("role"), "treeitem");
    assert.equal(rowAt("lead-a").getAttribute("aria-level"), "1");
    assert.equal(rowAt("child-a").getAttribute("aria-level"), "2");
    assert.equal(rowAt("grand-a").getAttribute("aria-level"), "3");
    assert.equal(rowAt("lead-a").style.marginInlineStart, "");
    assert.equal(rowAt("child-a").style.marginInlineStart, "");
    assert.equal(rowAt("child-a").style.width, "");
    assert.equal(rowAt("grand-a").style.marginInlineStart, "");
    assert.equal(rowAt("grand-a").style.width, "");
    assert.equal(rowAt("child-a").style.paddingInlineStart, "");
    assert.equal(rowAt("great-a").getAttribute("aria-level"), "4");
    assert.equal(rowAt("child-a").getAttribute("aria-posinset"), "1");
    assert.equal(rowAt("orphan-a").getAttribute("aria-posinset"), "3");
    assert.equal(rowAt("orphan-a").getAttribute("aria-setsize"), "3");
    assert.equal(rowAt("child-a").getAttribute("aria-expanded"), "true");
    assert.equal(rowAt("great-a").getAttribute("aria-expanded"), null);
    // Roving tab focus: exactly one row per tree is tabbable.
    assert.equal(rowAt("lead-a").getAttribute("tabindex"), "0");
    assert.deepEqual(
      [...document.querySelectorAll('[data-agent-session-id]:not([tabindex="-1"])')].length,
      1,
    );
    assert.equal(rowAt("grand-a").getAttribute("aria-label"), "Reviewer · review");
    // Status, model and timing behavior is unchanged at any depth.
    assert.match(rowAt("grand-a").querySelector(".agent-activity-elapsed").textContent, /^\d/);
    const unreadIdle = rowAt("great-a").querySelector(".agent-activity-elapsed");
    assert.equal(unreadIdle.getAttribute("data-state"), "done");
    assert.equal(unreadIdle.textContent, "Task complete");

    const heading = document.querySelector('[data-lead-session-id="lead-a"]');
    await act(async () => heading.click());
    assert.equal(heading.getAttribute("aria-expanded"), "false");
    assert.deepEqual(
      [...document.querySelectorAll("[data-agent-session-id]")]
        .map((node) => node.getAttribute("data-agent-session-id")),
      ["lead-a"],
    );
    // Truthful expansion: the surviving row reports the fold that hides its
    // subtree instead of claiming to be open.
    assert.equal(rowAt("lead-a").getAttribute("aria-expanded"), "false");
    await act(async () => heading.click());
    assert.ok(rowAt("great-a"));
    assert.equal(rowAt("lead-a").getAttribute("aria-expanded"), "true");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("a nested Agent row opens its exact child session without touching session lists", async () => {
  const dom = installDom();
  const touched = [];
  const host = {
    async listAgentPool() { return hierarchyPool(); },
    subscribeAgentPool() { return () => {}; },
  };
  window.mixdogDesktop = new Proxy(host, {
    get(target, key) {
      if (typeof key === "string") touched.push(key);
      return target[key];
    },
  });
  const sessions = [{
    id: "lead-a", title: "First task", preview: "", updatedAt: 2,
    messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
  }];
  const catalogBefore = JSON.stringify(sessions);
  const opened = [];
  const prefetched = [];
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions,
        onPrefetchSession: (sessionId) => prefetched.push(sessionId),
        onOpenLeadSession: (sessionId) => opened.push(["lead", sessionId]),
        onOpenSession: (sessionId, title, ownerSessionId) =>
          opened.push(["agent", sessionId, title, ownerSessionId]),
      }));
    });
    // Hidden children are reachable ONLY here: they are absent from the
    // session catalog this pane was handed.
    assert.equal(sessions.some((session) => session.id === "grand-a"), false);

    const click = (sessionId) => act(async () => {
      const row = document.querySelector(`[data-agent-session-id="${sessionId}"]`);
      row.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
      row.click();
    });
    await click("grand-a");
    await click("great-a");
    await click("lead-a");
    assert.deepEqual(opened, [
      ["agent", "grand-a", "review", "lead-a"],
      ["agent", "great-a", "plan", "lead-a"],
      ["lead", "lead-a"],
    ]);
    // Opening a child pane never writes to Recent/Resume: the catalog handed
    // in is untouched and no session-catalog host call is made at all.
    assert.equal(JSON.stringify(sessions), catalogBefore);
    assert.deepEqual(touched.filter((name) => /session/i.test(name)), []);
    assert.deepEqual([...new Set(touched)].sort(), ["listAgentPool", "subscribeAgentPool"]);
    assert.deepEqual(prefetched, ["grand-a", "great-a", "lead-a"]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("the Agent tree supports arrow, Home/End and expand-collapse keyboard control", async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() { return hierarchyPool(); },
    subscribeAgentPool() { return () => {}; },
  };
  const rowAt = (sessionId) =>
    document.querySelector(`[data-agent-session-id="${sessionId}"]`);
  const focusedId = () => document.activeElement?.getAttribute("data-agent-session-id");
  const press = (key) => act(async () => {
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, {
        active: true,
        sessions: [{
          id: "lead-a", title: "First task", preview: "", updatedAt: 2,
          messageCount: 1, cwd: "C:\\a", classification: "task", projectPath: null,
        }],
      }));
    });
    await act(async () => rowAt("lead-a").focus());

    await press("ArrowDown");
    assert.equal(focusedId(), "child-a");
    // Roving focus follows the keyboard, so Tab returns to the same row.
    assert.equal(rowAt("child-a").getAttribute("tabindex"), "0");
    assert.equal(rowAt("lead-a").getAttribute("tabindex"), "-1");
    await press("ArrowRight");
    assert.equal(focusedId(), "grand-a");
    await press("ArrowUp");
    assert.equal(focusedId(), "child-a");

    await press("End");
    assert.equal(focusedId(), "orphan-a");
    await press("Home");
    assert.equal(focusedId(), "lead-a");

    // Left closes a real subtree, and the row reports the closure.
    await act(async () => rowAt("child-a").focus());
    await press("ArrowLeft");
    assert.equal(rowAt("child-a").getAttribute("aria-expanded"), "false");
    assert.equal(rowAt("grand-a"), null);
    assert.equal(focusedId(), "child-a");
    // Left again climbs to the parent row instead of closing anything.
    await press("ArrowLeft");
    assert.equal(focusedId(), "lead-a");
    // Right reopens exactly what was closed.
    await act(async () => rowAt("child-a").focus());
    await press("ArrowRight");
    assert.equal(rowAt("child-a").getAttribute("aria-expanded"), "true");
    assert.ok(rowAt("great-a"));

    // At the root row, Left folds the whole group and Right reopens it.
    await act(async () => rowAt("lead-a").focus());
    await press("ArrowLeft");
    assert.equal(rowAt("lead-a").getAttribute("aria-expanded"), "false");
    await press("ArrowLeft");
    const heading = document.querySelector('[data-lead-session-id="lead-a"]');
    assert.equal(heading.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelectorAll("[data-agent-session-id]").length, 1);
    await act(async () => rowAt("lead-a").focus());
    await press("ArrowRight");
    assert.equal(heading.getAttribute("aria-expanded"), "true");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
