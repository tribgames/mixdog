import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

register(new URL("./settings/test-css-loader.mjs", import.meta.url));
const { App, ApprovalCard, ContextUsageIndicator, LiveWorkStatus, TranscriptRow } = await import("./App.tsx");
const { ContextBody } = await import("./CommandSurface.tsx");
const { DesktopTitlebar } = await import("./navigation.tsx");
const { OpenSelect } = await import("./OpenSelect.tsx");
const { TooltipLayer } = await import("./TooltipLayer.tsx");
const { acquireModalLayer } = await import("./modal-layer.ts");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let dom;
let root;

function installDom() {
  dom = new JSDOM(
    '<!doctype html><html><body><button id="before">Before</button><div class="app-shell"><div id="root"></div></div></body></html>',
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Blob: dom.window.Blob,
    File: dom.window.File,
    FileReader: dom.window.FileReader,
    MutationObserver: dom.window.MutationObserver,
  });
  for (const method of ["scrollTo", "scrollIntoView"]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, method, {
      value() {},
      configurable: true,
    });
  }
  Object.defineProperties(dom.window, {
    requestAnimationFrame: {
      value(callback) { return dom.window.setTimeout(() => callback(dom.window.performance.now()), 0); },
      configurable: true,
    },
    cancelAnimationFrame: {
      value(handle) { dom.window.clearTimeout(handle); },
      configurable: true,
    },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { value() {}, configurable: true },
    detachEvent: { value() {}, configurable: true },
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    value() {
      return {
        font: "",
        measureText(text) {
          return { width: String(text).length * 7 };
        },
      };
    },
    configurable: true,
  });
  const background = document.querySelector(".app-shell");
  Object.defineProperty(background, "inert", { value: false, writable: true, configurable: true });
  root = createRoot(document.getElementById("root"));
  return background;
}

async function openProjectSwitcher() {
  await act(async () => {
    document.querySelector('[aria-label="Open projects"]')?.click();
    await Promise.resolve();
  });
  const dialog = document.querySelector('[role="dialog"][aria-labelledby="project-switcher-title"]');
  assert.equal(dialog != null, true, "project switcher dialog should be present");
  return dialog;
}

async function selectFirstProject() {
  const dialog = await openProjectSwitcher();
  const row = dialog.querySelector(".project-row");
  assert.equal(row != null, true, "first project row should be present");
  await act(async () => {
    row.click();
    await Promise.resolve();
  });
}

async function chooseSessionAction(row, action) {
  await act(async () => {
    row.querySelector(".session-row-more").click();
    await Promise.resolve();
  });
  const menu = document.querySelector(`[data-session-menu-for="${row.dataset.sessionId}"]`);
  assert.ok(menu, "session action menu should be present");
  await act(async () => {
    menu.querySelector(`.session-row-menu-${action}`).click();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  dom?.window.close();
  dom = undefined;
});

test("toast region anchors to the sheet top-right", async () => {
  installDom();
  const first = { items: [], queued: [], sessionId: "first", toasts: [{ id: "toast", text: "Saved" }] };
  window.mixdogDesktop = {
    getSnapshot: async () => first,
    listSessions: async () => [],
    subscribeState: () => () => {},
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const region = document.querySelector(".oc-toast-region");
  assert.ok(region, "toast region renders");
  assert.equal(region.style.top !== "", true, "toast region is top-anchored");
  assert.equal(region.style.bottom, "", "toast region has no bottom anchor");
});

test("live-work strip renders ordered snapshot segments and filters terminal agents", async () => {
  installDom();
  const now = Date.parse("2026-01-02T12:00:00Z");
  await act(async () => root.render(React.createElement(LiveWorkStatus, {
    now,
    snapshot: {
      agentWorkers: [
        { tag: "build", status: "running", startedAt: now - 3_665_000 },
        { tag: "build", status: "running", startedAt: now - 5_000 },
        { tag: "worker:0", status: "running", startedAt: now - 6_000 },
        { status: "running", startedAt: now - 8_000 },
        { tag: "review", stage: "complete", startedAt: now - 90_000 },
      ],
      agentJobs: [
        { type: "review", task_id: "job-2", status: "running", startedAt: now - 5_000 },
        { type: "review", task_id: "job-3", status: "running", startedAt: now - 4_000 },
        { task_id: "job-4", status: "running", startedAt: now - 3_000 },
        { task_id: "job-done", status: "success", startedAt: now - 10_000 },
      ],
      activeTools: {
        explore: { count: 2, startedAt: now - 4_000 },
        search: { count: 1, startedAt: now - 3_000 },
      },
      shellJobs: { count: 2, elapsedLabel: "9s" },
    },
  })));
  const labels = Array.from(document.querySelectorAll(".live-work-segment"))
    .map((element) => element.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(labels, [
    "Running 5 Agents· 1h 1m 5s",
    "Exploring· 4s",
    "Web Searching· 3s",
    "Running 2 Shells· 9s",
  ]);
});

test("live-work strip hides when snapshot work is terminal or empty", async () => {
  installDom();
  await act(async () => root.render(React.createElement(LiveWorkStatus, {
    now: Date.now(),
    snapshot: {
      agentWorkers: [{ tag: "done", status: "timeout" }],
      agentJobs: [{ task_id: "closed", status: "cancelled" }],
      activeTools: { explore: { count: 0 }, search: { count: 0 } },
      shellJobs: { count: 0, elapsedLabel: "" },
    },
  })));
  assert.equal(document.querySelector(".live-work-status") === null, true,
    "selector .live-work-status should be absent");
});

test("context view renders engine stats and omits unavailable optional fields", async () => {
  installDom();
  const status = {
    sessionId: "context-session",
    provider: "anthropic",
    model: "claude-opus",
    contextWindow: 200_000,
    rawContextWindow: 250_000,
    usedTokens: 15_920,
    compaction: {
      lastStage: "completed",
      lastChanged: true,
      compactType: "semantic",
      triggerTokens: 180_000,
      boundaryTokens: 200_000,
    },
    messages: {
      count: 3,
      roles: {
        user: { count: 2, tokens: 2_500 },
        assistant: { count: 1, tokens: 5_000 },
      },
      semantic: {
        chat: { tokens: 2_500 },
        assistant: { tokens: 5_000 },
        memory: { tokens: 300 },
        workspace: { tokens: 200 },
        workflow: { tokens: 100 },
        system: { tokens: 1_200 },
        toolResults: { tokens: 400 },
      },
    },
    request: {
      toolSchemaBreakdown: {
        code: { tokens: 1_600 },
        mcp: { tokens: 700 },
        skills: { tokens: 300 },
        memory: { tokens: 100 },
        agents: { tokens: 250 },
      },
    },
    usage: {
      lastInputTokens: 9_000,
      lastUncachedInputTokens: 4_000,
      lastOutputTokens: 1_000,
      lastCachedReadTokens: 4_000,
      lastCacheWriteTokens: 1_000,
      lastContextTokens: 12_000,
    },
  };
  const snapshot = {
    desktopSessionTitle: "Context fixture",
    autoCompactTokenLimit: 20_000,
    displayContextWindow: 100_000,
    stats: { costUsd: 0.125, reasoningTokens: 250 },
    items: [
      {
        id: "user-1", kind: "user", text: "Question", at: Date.parse("2026-07-16T10:00:00Z"),
        args: { secret: "hidden argument" }, rawResult: "hidden result", metadata: { internal: true },
      },
      { id: "assistant-1", kind: "assistant", text: "Answer", at: Date.parse("2026-07-16T10:01:00Z") },
    ],
  };
  await act(async () => root.render(React.createElement(ContextBody, { status, snapshot })));
  const text = document.querySelector(".context-view")?.textContent || "";
  assert.doesNotMatch(text, /Context fixture|sess_/);
  assert.match(text, /7% used16k \/ 200k · 184k free/);
  assert.match(text, /Sourceeffective 200k · raw 250k/);
  assert.match(text, /Compactioncompleted · Compact complete · type semantic · trigger 180k · boundary 200k/);
  assert.match(text, /API\/cachelast ctx 12k · uncached\/out 4\.0k\/1\.0k · raw in 9\.0k · write 1\.0k · cache 33%/);
  assert.match(text, /Context mixMessages.*Tools.*MCP.*Skills.*Memory.*Session.*Workflow.*System.*Tool I\/O.*Overhead/);
  assert.equal(document.querySelectorAll(".context-mix-row").length, 10);
  const toolsRow = Array.from(document.querySelectorAll(".context-mix-row"))
    .find((row) => row.querySelector("span")?.textContent === "Tools");
  assert.equal(toolsRow?.querySelector("strong")?.textContent, "1.9k",
    "agent and other control schemas belong to the Tools total");
  assert.doesNotMatch(text, /Cost|\$|Question|hidden argument|hidden result|metadata|rawResult|args/);
});

test("context view never projects raw transcript records", async () => {
  installDom();
  await act(async () => root.render(React.createElement(ContextBody, {
    status: { usedTokens: 1, contextWindow: 100, messages: {}, usage: {} },
    snapshot: {
      items: [{ id: "secret", kind: "user", text: "private transcript", args: { token: "secret" } }],
      stats: {},
    },
  })));
  assert.doesNotMatch(document.querySelector(".context-view")?.textContent || "", /private transcript|secret/);
  assert.equal(document.querySelector(".context-raw-messages") === null, true,
    "selector .context-raw-messages should be absent");
});

test("context view keeps the TUI sections for a zero-token session", async () => {
  installDom();
  await act(async () => root.render(React.createElement(ContextBody, {
    status: {
      contextWindow: 200_000,
      usedTokens: 0,
      messages: {
        count: 0,
        roles: {
          user: { count: 0, tokens: 0 },
          assistant: { count: 0, tokens: 0 },
        },
      },
      usage: {},
    },
    snapshot: { items: [], stats: {} },
  })));
  assert.equal(document.querySelector(".context-view") != null, true);
  assert.equal(document.querySelector(".context-main-bar span")?.style.width, "0%");
  assert.equal(document.querySelectorAll(".context-mix-row").length, 9);
  assert.match(document.querySelector(".context-view")?.textContent || "", /0% used/);
});

test("header context usage floors percent and dismisses focus popover without reopening", async () => {
  installDom();
  let opens = 0;
  await act(async () => root.render(React.createElement(ContextUsageIndicator, {
    snapshot: {
      sessionId: "usage",
      stats: { currentContextTokens: 796, costUsd: 12.5 },
      autoCompactTokenLimit: 1_000,
      displayContextWindow: 2_000,
    },
    onOpen: () => { opens += 1; },
  })));
  const indicator = document.querySelector(".session-context-indicator");
  const trigger = indicator.querySelector("button");
  assert.equal(trigger.querySelector("small") === null, true,
    "the compact context trigger should not render secondary text");
  const popoverText = indicator.querySelector('[role="tooltip"]')?.textContent || "";
  assert.match(popoverText, /Usage79%Tokens796 \/ 1,000/);
  assert.doesNotMatch(popoverText, /Cost|\$/);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    trigger.focus();
  });
  assert.equal(indicator.dataset.open, "true");
  await act(async () => document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));
  assert.equal(indicator.dataset.open, "false");
  await act(async () => {
    trigger.blur();
    trigger.focus();
  });
  assert.equal(indicator.dataset.open, "false");
  await act(async () => trigger.click());
  assert.equal(opens, 1);
  assert.equal(indicator.dataset.open, "false");
});

test("header context usage remains available at zero before a session exists", async () => {
  installDom();
  await act(async () => root.render(React.createElement(ContextUsageIndicator, {
    snapshot: { sessionId: null, stats: {} },
    onOpen: () => {},
  })));
  const indicator = document.querySelector(".session-context-indicator");
  assert.ok(indicator);
  assert.match(indicator.querySelector('[role="tooltip"]')?.textContent || "", /Usage0%Tokens0/);
  assert.equal(indicator.querySelector(".context-usage-value")?.getAttribute("stroke-dasharray"), "0 100");
});

test("consecutive user messages mark only the follow-up as attached", async () => {
  installDom();
  await act(async () => root.render(React.createElement("div", { className: "thread" },
    React.createElement(TranscriptRow, { item: { id: "user-1", kind: "user", text: "First" } }),
    React.createElement(TranscriptRow, {
      item: { id: "user-2", kind: "user", text: "Second" },
      attachedUser: true,
    }),
    React.createElement(TranscriptRow, { item: { id: "assistant-1", kind: "assistant", text: "Reply" } }),
  )));
  const messages = document.querySelectorAll(".message");
  assert.equal(messages.length, 3);
  assert.equal(messages[0].classList.contains("attached-user"), false);
  assert.equal(messages[1].classList.contains("attached-user"), true);
  assert.equal(messages[2].classList.contains("attached-user"), false);
});

test("workspace overlays clamp upward menus and tooltip widths to the sheet", async () => {
  installDom();
  Object.defineProperty(window, "innerHeight", { value: 820, configurable: true });
  const sheetRect = { left: 302, top: 42, right: 572, bottom: 220, width: 270, height: 178 };
  await act(async () => root.render(React.createElement("div", { className: "workspace" },
    React.createElement(OpenSelect, {
      ariaLabel: "Sheet bounded select",
      options: Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: `Option ${index}` })),
    }),
    React.createElement("button", { "data-tooltip": "A deliberately long sheet tooltip" }, "Tooltip"),
    React.createElement(TooltipLayer),
  )));
  const workspace = document.querySelector(".workspace");
  const select = document.querySelector('[aria-label="Sheet bounded select"]');
  const tooltipTarget = document.querySelector("[data-tooltip]");
  Object.defineProperty(workspace, "getBoundingClientRect", { value: () => sheetRect });
  Object.defineProperty(select, "getBoundingClientRect", {
    value: () => ({ left: 500, top: 190, right: 560, bottom: 218, width: 60, height: 28 }),
  });
  Object.defineProperty(tooltipTarget, "getBoundingClientRect", {
    value: () => ({ left: 500, top: 100, right: 560, bottom: 128, width: 60, height: 28 }),
  });
  await act(async () => select.click());
  const menu = document.querySelector('[role="listbox"]');
  assert.equal(menu.style.bottom, "634px", "upward menu should include the viewport inset below the sheet");
  assert.equal(menu.style.maxHeight, "136px", "upward menu should fit above its trigger within the sheet");
  await act(async () => {
    tooltipTarget.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 160));
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.style.maxWidth, "254px");
});

test("project context menu aligns to the whole project pill with a two pixel upper gap", async () => {
  installDom();
  Object.defineProperty(window, "innerHeight", { value: 820, configurable: true });
  await act(async () => root.render(React.createElement("div", { className: "workspace" },
    React.createElement("div", { className: "composer-project-context" },
      React.createElement("span", null, "folder"),
      React.createElement(OpenSelect, {
        className: "project-context-select",
        ariaLabel: "Project context",
        options: Array.from({ length: 4 }, (_, index) => ({ value: String(index), label: `Project ${index}` })),
      }),
    ),
  )));
  const workspace = document.querySelector(".workspace");
  const projectPill = document.querySelector(".composer-project-context");
  const trigger = document.querySelector('[aria-label="Project context"]');
  Object.defineProperty(workspace, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 40, right: 800, bottom: 760, width: 800, height: 720 }),
  });
  Object.defineProperty(projectPill, "getBoundingClientRect", {
    value: () => ({ left: 300, top: 650, right: 390, bottom: 674, width: 90, height: 24 }),
  });
  Object.defineProperty(trigger, "getBoundingClientRect", {
    value: () => ({ left: 322, top: 650, right: 390, bottom: 674, width: 68, height: 24 }),
  });
  await act(async () => trigger.click());
  const menu = document.querySelector('[role="listbox"]');
  assert.equal(menu.style.left, "300px");
  assert.equal(menu.style.bottom, "172px");
});

test("approval portal traps and restores focus, isolates background, reports failure, and denies on Escape", async () => {
  const background = installDom();
  const before = document.getElementById("before");
  before.focus();
  const decisions = [];
  let rejectNext = true;
  const resolve = async (approved) => {
    decisions.push(approved);
    if (rejectNext) {
      rejectNext = false;
      throw new Error("IPC unavailable");
    }
    return true;
  };

  await act(async () => {
    root.render(React.createElement(ApprovalCard, {
      approval: { id: "approval-1", name: "shell" },
      resolve,
    }));
  });

  const dialog = document.querySelector('[role="dialog"]');
  const buttons = Array.from(dialog.querySelectorAll("button"));
  assert.equal(dialog.parentElement?.parentElement === document.body, true, "approval portal should be attached to document.body");
  assert.equal(background.inert, true);
  assert.equal(background.getAttribute("aria-hidden"), "true");
  assert.equal(document.activeElement === buttons[0], true, "approval dialog should initially focus the first action");

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(document.activeElement === buttons[1], true, "Tab should focus the second approval action");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  assert.equal(document.activeElement === buttons[0], true, "Shift+Tab should return focus to the first approval action");

  await act(async () => {
    buttons[1].click();
    await Promise.resolve();
  });
  const alert = dialog.querySelector('[role="alert"]');
  assert.match(alert.textContent || "", /IPC unavailable/);
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  assert.equal(buttons.every((button) => !button.disabled), true);

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual(decisions, [true, false]);
  assert.equal(buttons.every((button) => button.disabled), true);

  await act(async () => root.render(null));
  assert.equal(background.inert, false);
  assert.equal(background.hasAttribute("aria-hidden"), false);
  assert.equal(document.activeElement === before, true, "closing the approval should restore prior focus");
});

test("a retained streaming row announces completion without rereading the response", async () => {
  installDom();
  const streaming = { id: "response-1", kind: "assistant", text: "Working", streaming: true };
  await act(async () => root.render(React.createElement(TranscriptRow, { item: streaming })));
  assert.equal(document.querySelector('[role="status"]') === null, true, "selector [role=\"status\"] should be absent");
  assert.equal(document.querySelector("article.message.assistant > .message-body > .markdown") != null, true, "selector article.message.assistant > .message-body > .markdown should be present");
  assert.equal(document.querySelector(".avatar") === null, true, "selector .avatar should be absent");
  assert.equal(document.querySelector(".message-label") === null, true, "selector .message-label should be absent");
  assert.equal(document.querySelector(".stream-cursor") != null, true);

  const settled = { ...streaming, text: "Finished response", streaming: false };
  await act(async () => root.render(React.createElement(TranscriptRow, { item: settled })));
  const announcement = document.querySelectorAll('[role="status"]');
  assert.equal(announcement.length, 1);
  assert.equal(announcement[0].textContent.trim(), "Mixdog response complete.");
  assert.equal(document.querySelector("article")?.getAttribute("aria-live"), "off");

  await act(async () => root.render(React.createElement(TranscriptRow, { item: settled })));
  assert.equal(document.querySelectorAll('[role="status"]')
    .length, 1);
});

test("user messages render as compact unlabeled bubbles", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "prompt-1", kind: "user", text: "Compact prompt" },
  })));
  const message = document.querySelector("article.message.user");
  assert.equal(message?.textContent, "Compact prompt");
  assert.equal(message?.querySelector(":scope > .message-body > p") != null, true, "selector :scope > .message-body > p should be present");
  assert.equal(message?.querySelector(".avatar, .message-label") === null, true, "selector .avatar, .message-label should be absent");
});

test("message metadata uses engine per-item fields and localized short timestamps", async () => {
  installDom();
  const at = new Date(2026, 0, 2, 11, 51).getTime();
  const expected = new Date(at).toLocaleTimeString(undefined, { timeStyle: "short" });
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: {
      id: "prompt-meta",
      kind: "user",
      text: "Build it",
      agent: "Build",
      model: "MiMo V2.5 Free",
      provider: "xiaomi",
      at,
    },
  })));
  const footer = document.querySelector(".message.user .message-meta-line");
  assert.equal(footer?.querySelector(".message-meta")?.textContent, `Build\u00A0·\u00A0MiMo V2.5 Free\u00A0·\u00A0${expected}`);
  assert.equal(footer?.querySelector('[aria-label="Copy message"]') != null, true);
  assert.equal(footer?.parentElement === document.querySelector("article.message.user"), true,
    "the message footer should stay inside the user message");
  assert.equal(document.querySelector(".message.user > .message-actions") === null, true,
    "selector .message.user > .message-actions should be absent");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "response-meta", kind: "assistant", text: "Done", at },
  })));
  assert.equal(document.querySelector(".response-footer .message-time")?.textContent, expected);
  assert.equal(document.querySelector(".response-footer [aria-label='Copy response']") != null, true);
});

test("legacy messages omit unavailable metadata without losing actions", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "legacy-user", kind: "user", text: "Old prompt" },
  })));
  const userFooter = document.querySelector(".message.user .message-meta-line");
  assert.equal(userFooter?.querySelector(".message-meta") === null, true,
    "selector .message-meta should be absent from the user footer");
  assert.equal(userFooter?.querySelector('[aria-label="Copy message"]') != null, true);

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "legacy-assistant", kind: "assistant", text: "Old response" },
  })));
  assert.equal(document.querySelector(".response-footer .message-time") === null, true,
    "selector .response-footer .message-time should be absent");
  assert.equal(document.querySelector(".response-footer [aria-label='Copy response']") != null, true);
});

test("unknown transcript kinds stay hidden", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "internal-1", kind: "reasoning", text: "private chain of thought" },
  })));
  assert.equal(document.body.textContent.includes("private chain of thought"), false);
});

test("cancelled aliases use the TUI completion wording", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "cancel-1", kind: "turndone", status: "aborted", elapsedMs: 4_000 },
  })));
  assert.equal(document.querySelector(".turn-status")?.textContent.trim(), "Cancelled after 4s");
});

test("failed tools expose a failed status instead of a successful completion", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "tool-failed", kind: "tool", name: "shell", isError: true, result: "Command failed" },
  })));
  const status = document.querySelector(".tool-state");
  assert.equal(status?.textContent.trim(), "Failed");
  assert.equal(status?.getAttribute("role"), "status");
  assert.ok(status?.classList.contains("failed"));
  assert.equal(status?.querySelector(".lucide-x") != null, true, "selector .lucide-x should be present");
});

test("tool counters and hook-denial visibility mirror the TUI", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "partial", kind: "tool", name: "read", count: 3, completedCount: 3, errorCount: 1 },
  })));
  assert.equal(document.querySelector(".tool-state")?.textContent.trim(), "Failed");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: {
      id: "denied", kind: "tool", name: "shell", isError: true, errorCount: 1,
      result: 'Error: tool "shell" denied by hook: approval required',
    },
  })));
  assert.equal(document.querySelector(".tool-state")?.textContent.trim(), "Denied");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "noise", kind: "tool", name: "read", isError: true, errorCount: 1, completedCount: 1 },
  })));
  assert.equal(document.querySelector(".tool-card") === null, true, "selector .tool-card should be absent");
});

test("fenced markdown exposes a language header and copy control", async () => {
  installDom();
  const external = [];
  window.mixdogDesktop = {
    openExternal: async (url) => { external.push(url); },
  };
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: {
      id: "code",
      kind: "assistant",
      text: "```ts\nconst answer = 42;\n```\n\n[Documentation](https://example.com/docs)",
    },
  })));
  assert.equal(document.querySelector(".markdown-code header span")?.textContent, "ts");
  assert.equal(document.querySelector('[aria-label="Copy code"]') != null, true, "selector [aria-label=\"Copy code\"] should be present");
  const link = document.querySelector(".markdown a");
  assert.equal(link?.getAttribute("target"), null);
  await act(async () => {
    link?.click();
    await Promise.resolve();
  });
  assert.deepEqual(external, ["https://example.com/docs"]);
});

test("assistant completion metadata and copy action share a response footer without duplicate announcements", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "response-footer", kind: "assistant", text: "Finished response", streaming: false },
    completion: { id: "turn-footer", kind: "turndone", status: "done", verb: "Solved", elapsedMs: 4_000 },
  })));

  const article = document.querySelector("article.message.assistant");
  const footer = article?.querySelector(":scope > .response-footer");
  assert.equal(article?.hasAttribute("tabindex"), false);
  assert.equal(footer?.getAttribute("aria-label"), "Response details");
  assert.equal(footer?.querySelector(".turn-status.complete")?.textContent?.trim(), "Solved for 4s");
  assert.equal(footer?.querySelector('[aria-label="Copy response"]') != null, true);
  assert.equal(document.querySelector(".sr-only[role=status]") === null, true, "selector .sr-only[role=status] should be absent");
});

test("conversation attaches only successful turn completion to the final assistant response", async () => {
  installDom();
  let publish;
  const empty = { items: [], queued: [], sessionId: "turn-footer-session" };
  window.mixdogDesktop = {
    getSnapshot: async () => empty,
    listSessions: async () => [],
    subscribeState: (listener) => { publish = listener; return () => {}; },
    startTask: async () => empty,
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(
    document.activeElement === document.querySelector('textarea[aria-label="Message Mixdog"]'),
    true,
  );

  const response = { id: "assistant-linked", kind: "assistant", text: "Linked answer" };
  await act(async () => publish({
    ...empty,
    items: [
      { id: "user-linked", kind: "user", text: "Question" },
      response,
      { id: "turn-linked", kind: "turndone", status: "done", verb: "Solved", elapsedMs: 2_000 },
    ],
  }));
  assert.equal(document.querySelectorAll(".turn-status.complete").length, 1);
  assert.equal(document.querySelector(".message.assistant .response-footer .turn-status")?.textContent?.trim(), "Solved for 2s");
  assert.equal(document.querySelector(".thread > .turn-status.complete") === null, true, "selector .thread > .turn-status.complete should be absent");

  await act(async () => publish({
    ...empty,
    items: [
      { id: "user-linked", kind: "user", text: "Question" },
      response,
      { id: "turn-linked", kind: "turndone", status: "failed", label: "Completed" },
    ],
  }));
  assert.equal(document.querySelector(".message.assistant .response-footer .turn-status") === null, true, "selector .message.assistant .response-footer .turn-status should be absent");
  assert.equal(document.querySelectorAll(".turn-status.failed").length, 1);
  const failedRow = document.querySelector(".turn-status.failed");
  assert.equal(failedRow?.textContent?.trim(), "FailedRetry");
  assert.equal(failedRow?.querySelector(".turn-retry")?.getAttribute("aria-label"), "Retry failed turn");
});

test("tool cards use the shared TUI surface and expose copy for shell and diff output", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "shared-shell",
    item: {
      id: "shared-shell",
      kind: "tool",
      name: "shell_command",
      args: { command: "npm test" },
      result: "Exit code: 0\nAll tests passed",
      completedAt: 2,
    },
  })));

  const shell = document.querySelector(".tool-card");
  assert.equal(shell?.dataset.category, "Shell");
  assert.equal(shell?.querySelector(".tool-title b")?.textContent, "Shell");
  assert.equal(shell?.querySelector(".tool-title small") === null, true,
    "selector .tool-title small should be absent");
  assert.equal(shell?.querySelector(".tool-state") === null, true,
    "selector .tool-state should be absent");
  assert.equal(shell?.querySelector(".tool-title")?.nextElementSibling?.classList.contains("tool-chevron"), true);
  assert.equal(shell?.querySelector(".tool-result-summary") === null, true,
    "selector .tool-result-summary should be absent");
  await act(async () => shell?.querySelector(".tool-header")?.click());
  assert.equal(shell?.querySelector('[aria-label="Copy command output"]') != null, true);
  assert.equal(shell?.querySelector(".shell-output")?.textContent, "$ npm test\n\nExit code: 0\nAll tests passed");
  assert.equal(shell?.querySelector(".detail-block") === null, true,
    "selector .detail-block should be absent");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "shared-aggregate",
    item: {
      id: "shared-aggregate",
      kind: "tool",
      name: "__aggregate__",
      aggregate: true,
      args: { categoryOrder: ["Read", "Search"] },
      count: 3,
      completedCount: 3,
      categories: {
        Read: { category: "Read", active: "Reading", done: "Read", noun: "file", pluralNoun: "files", count: 1 },
        Search: { category: "Search", active: "Searching", done: "Searched", noun: "pattern", pluralNoun: "patterns", count: 2 },
      },
      result: "512 lines, 6 matches",
    },
  })));
  const aggregate = document.querySelector(".tool-card");
  assert.equal(aggregate?.querySelector(".tool-title b")?.textContent, "Read 1 file, Searched 2 patterns");
  assert.equal(aggregate?.querySelector(".tool-state") === null, true,
    "selector .tool-state should be absent from aggregate tools");
  assert.equal(aggregate?.querySelector(".tool-result-summary") === null, true,
    "selector .tool-result-summary should be absent from aggregate tools");
  await act(async () => aggregate?.querySelector(".tool-header")?.click());
  assert.equal(aggregate?.querySelector(".tool-output")?.textContent, "512 lines, 6 matches");
  assert.equal(aggregate?.querySelector(".detail-block-heading") === null, true,
    "selector .detail-block-heading should be absent from aggregate tools");
  assert.equal(aggregate?.textContent?.includes("Input"), false);
});

test("launch selects New task and immediately shows the project-free composer", async () => {
  installDom();
  const calls = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: ["C:\\Canonical\\Sample"] }),
    listSessions: async () => [],
    subscribeState: () => () => {},
    chooseProject: async () => "C:\\work\\sample",
    startProject: async (project) => {
      calls.push(project);
      return {
        currentProject: "C:\\Canonical\\Sample",
        recentProjects: ["C:\\Canonical\\Sample"],
        items: [],
        queued: [],
      };
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  assert.equal(document.querySelector(".sidebar") != null, true, "selector .sidebar should be present");
  assert.equal(document.querySelector(".empty-state") === null, true, "selector .empty-state should be absent");
  assert.equal(document.querySelector(".composer") != null, true, "selector .composer should be present");
  assert.equal(document.querySelector(".task-link").getAttribute("aria-current"), null);
  assert.equal(document.querySelector(".task-link").classList.contains("selected"), false);
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  assert.equal(document.querySelector(".main-panel") != null, true, "selector .main-panel should be present");
  assert.equal(document.querySelector(".topbar") != null, true, "selector .topbar should be present");
  assert.equal(document.querySelector(".topbar-project") === null, true, "selector .topbar-project should be absent");
  assert.equal(document.querySelector(".brand") === null, true, "selector .brand should be absent");
  assert.equal(document.querySelector(".sidebar-close") === null, true, "selector .sidebar-close should be absent");
  assert.equal(document.querySelector(".sidebar-account") === null, true, "selector .sidebar-account should be absent");
  assert.equal(document.querySelector(".account-avatar") === null, true, "selector .account-avatar should be absent");
  assert.equal(document.querySelector(".session-sidebar-heading") === null, true, "selector .session-sidebar-heading should be absent");
  assert.equal(document.querySelector('[aria-label="Search sessions"]'), null,
    "the sidebar should rely on its recent-session scroll instead of search");
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Sessions/);
  assert.equal(document.querySelector(".workspace-project-trigger") === null, true, "selector .workspace-project-trigger should be absent");
  assert.equal(document.querySelector(".session-header-divider") === null, true, "selector .session-header-divider should be absent");
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Mixdog|Local account/);
  assert.equal(document.querySelectorAll(".toolbar-sidebar").length, 1);
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Collapse session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "open");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon-active") != null, true, "selector .toolbar-sidebar .sidebar-toggle-icon-active should be present");
  assert.doesNotMatch(document.body.textContent || "", /No project selected|\bReady\b/);

  await act(async () => document.querySelector(".sidebar-backdrop").click());
  const sidebar = document.querySelector(".sidebar");
  assert.equal(sidebar.classList.contains("open"), false);
  assert.equal(sidebar.hasAttribute("inert"), true);
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Expand session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "closed");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon-active") === null, true, "selector .toolbar-sidebar .sidebar-toggle-icon-active should be absent");
  await act(async () => document.querySelector(".toolbar-sidebar").click());
  assert.equal(sidebar.classList.contains("open"), true);
  assert.equal(sidebar.hasAttribute("inert"), false);
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Collapse session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "open");
  const toggle = document.querySelector(".toolbar-sidebar");
  toggle.focus();
  await act(async () => toggle.click());
  assert.equal(sidebar.classList.contains("open"), false);
  assert.equal(document.activeElement === document.querySelector(".toolbar-sidebar"), true, "sidebar toggle should retain focus after collapsing");
  await act(async () => document.querySelector(".toolbar-sidebar").click());

  const projectDialog = await openProjectSwitcher();
  await act(async () => {
    projectDialog.querySelector(".new-project").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["C:\\work\\sample"]);
  assert.equal(document.querySelector(".workspace-project-trigger") === null, true, "selector .workspace-project-trigger should be absent");
  assert.match(document.querySelector(".session-header h1")?.textContent || "", /Sample/i);
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
});

test("new tasks choose a registered project or open a folder from the composer context control", async () => {
  installDom();
  const starts = [];
  const projectPath = "C:\\work\\sample";
  const openedPath = "C:\\work\\opened";
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [{ path: projectPath, alias: "Sample", pinned: false }],
    listSessions: async () => [],
    chooseProject: async () => openedPath,
    startProjectTask: async (path) => {
      starts.push(path);
      return { sessionId: `draft-${starts.length}`, currentProject: path, items: [], queued: [] };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  let selector = document.querySelector('button[aria-label="Project context"]');
  assert.match(selector.textContent, /Project/);
  await act(async () => {
    selector.click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.trim() === "Sample").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(starts, [projectPath]);
  selector = document.querySelector('button[aria-label="Project context"]');
  assert.match(selector.textContent, /Sample/);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "New task");
  assert.equal(document.querySelector(".session-project-badge") === null, true,
    "selector .session-project-badge should be absent");

  await act(async () => {
    selector.click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.trim() === "Open folder…").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(starts, [projectPath, openedPath]);
  assert.match(document.querySelector('button[aria-label="Project context"]').textContent, /Project/i);
  assert.doesNotMatch(document.querySelector('button[aria-label="Project context"]').textContent, /opened/i,
    "an unregistered cwd must not be presented as a project");
});

test("project sessions show their project beside the session title", async () => {
  installDom();
  const projectPath = "C:\\work\\sample";
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [{ path: projectPath, alias: "Sample", pinned: false }],
    listSessions: async () => [{
      id: "project-session",
      preview: "Project session",
      title: "Project session",
      updatedAt: 1,
      cwd: projectPath,
      classification: "project",
      projectPath,
      currentSession: false,
    }],
    resumeSession: async () => ({
      sessionId: "project-session",
      currentProject: projectPath,
      items: [],
      queued: [],
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="project-session"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "Project session");
  assert.equal(document.querySelector(".session-project-badge")?.textContent.trim(), "Sample");
  assert.equal(document.querySelector('button[aria-label="Project context"]') === null, true,
    "selector button[aria-label=\"Project context\"] should be absent");
});

test("session switching keeps the target title while its correlated snapshot is pending", async () => {
  installDom();
  const target = {
    id: "target-session",
    preview: "Target session",
    title: "Target session",
    updatedAt: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  let finishResume;
  const resumed = new Promise((resolve) => {
    finishResume = () => resolve({
      sessionId: target.id,
      desktopSessionTitle: "Previous session",
      items: [{ id: "target-message", kind: "user", text: "Target content" }],
      queued: [],
    });
  });
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [target],
    resumeSession: async () => resumed,
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(`[data-session-id="${target.id}"]`)?.classList.contains("selected"), true);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), target.title);
  assert.ok(document.querySelector(".session-switch-overlay"));
  assert.ok(document.querySelector(".titlebar-new"));

  await act(async () => {
    finishResume();
    await resumed;
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-switch-overlay"), null);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), target.title);
  assert.equal(document.querySelector(`[data-session-id="${target.id}"] .session-row-copy`)?.textContent.trim(), target.title);
  assert.equal(document.querySelector('.workspace-tab[aria-grabbed="false"] .workspace-tab-main[aria-current="page"]')
    ?.textContent.includes(target.title), true);
});

test("session switching freezes the previous transcript until the target snapshot is complete", async () => {
  installDom();
  let publish;
  let finishTarget;
  const targetResume = new Promise((resolve) => {
    finishTarget = () => resolve({
      sessionId: "target", items: [{ id: "target-row", kind: "user", text: "Target transcript" }], queued: [],
    });
  });
  const sessions = [
    { id: "source", title: "Source", preview: "Source", updatedAt: 2, currentSession: true,
      cwd: "C:\\work", classification: "task", projectPath: null },
    { id: "target", title: "Target", preview: "Target", updatedAt: 1, currentSession: false,
      cwd: "C:\\work", classification: "task", projectPath: null },
  ];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => sessions,
    resumeSession: async (id) => id === "source"
      ? { sessionId: "source", items: [{ id: "source-row", kind: "user", text: "Source transcript" }], queued: [] }
      : targetResume,
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="source"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('.transcript')?.textContent || '', /Source transcript/);
  await act(async () => {
    document.querySelector('[data-session-id="target"]').click();
    await Promise.resolve();
    publish({ sessionId: "target", items: [], queued: [] });
    await Promise.resolve();
  });
  assert.match(document.querySelector('.transcript')?.textContent || '', /Source transcript/);
  assert.doesNotMatch(document.querySelector('.transcript')?.textContent || '', /Target transcript/);
  await act(async () => {
    finishTarget();
    await targetResume;
    await Promise.resolve();
  });
  assert.match(document.querySelector('.transcript')?.textContent || '', /Target transcript/);
  assert.doesNotMatch(document.querySelector('.transcript')?.textContent || '', /Source transcript/);
});

test("sidebar footer keeps settings while the titlebar exposes the OpenCode-style update control", async () => {
  installDom();
  let updateOpens = 0;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    getUpdaterState: async () => ({ status: "ready", version: "2.0.0" }),
    subscribeUpdaterState: () => () => {},
    showDesktopUpdate: async () => {
      updateOpens += 1;
      return { status: "ready", version: "2.0.0" };
    },
    readSettings: async () => ({ autoClear: true, autoCompact: false }),
    updateSetting: async () => ({ autoClear: true, autoCompact: false }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  const trigger = document.querySelector(".session-sidebar-footer [aria-label='Open settings']");
  assert.equal(trigger != null, true, "settings trigger should be present in the sidebar footer");
  assert.equal(trigger.closest(".session-sidebar") !== null, true);
  assert.equal(trigger.getAttribute("aria-label"), "Open settings");
  assert.equal(trigger.getAttribute("data-tooltip"), "Settings");
  assert.equal(trigger.getAttribute("title"), null);
  const update = document.querySelector(".titlebar-update");
  assert.equal(update?.closest(".topbar") !== null, true,
    "the update control should sit in the titlebar before the caption controls");
  assert.equal(update?.getAttribute("aria-label"), "Install Mixdog 2.0.0");
  assert.equal(update?.querySelector(".titlebar-update-label")?.textContent.trim(), "Update");
  assert.equal(document.querySelector(".sidebar-update-button"), null);
  await act(async () => {
    update.click();
    await Promise.resolve();
  });
  assert.equal(updateOpens, 1);
});

test("sidebar keeps Project below New task and lists every session newest-first", async () => {
  installDom();
  const resumes = [];
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `recent-${index + 1}`,
    preview: `Recent ${index + 1}`,
    title: `Recent ${index + 1}`,
    updatedAt: index + 1,
    cwd: "C:\\work",
    classification: index % 2 ? "project" : "task",
    projectPath: index % 2 ? "C:\\work" : null,
    currentSession: false,
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      resumes.push(id);
      return { items: [], queued: [], sessionId: id };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(Array.from(document.querySelectorAll(".sidebar-primary-nav > button"),
    (node) => node.textContent.trim()), ["New task", "Project"]);
  assert.equal(document.querySelector('[aria-label="Open projects"]')?.textContent.trim(), "Project");
  assert.equal(document.querySelector(".sidebar-recent-heading")?.textContent.trim(), "Recent");
  assert.equal(document.querySelector(".sidebar-section-toggle"), null);
  const recent = document.querySelector(".recent-session-list");
  const shortcuts = Array.from(recent.querySelectorAll(".session-row"));
  assert.deepEqual(shortcuts.map((row) => row.textContent.trim()),
    ["Recent 6", "Recent 5", "Recent 4", "Recent 3", "Recent 2", "Recent 1"]);
  assert.equal(recent.querySelectorAll(".session-row-icon").length, 6);
  assert.equal(shortcuts.every((row) => row.getAttribute('data-tooltip') === null), true);
  assert.equal(recent.querySelectorAll('.session-row-actions .session-row-more').length, 6);

  assert.equal(document.querySelector('[aria-label="Search sessions"]'), null);
  assert.equal(recent.querySelectorAll(".session-row").length, 6);

  await act(async () => {
    recent.querySelector('[data-session-id="recent-4"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["recent-4"]);
});

test("sidebar omits the runtime status trigger", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(document.querySelector('[aria-label="Runtime status"]'), null);
  assert.ok(document.querySelector('[aria-label="Open settings"]'));
});

test("long transcripts virtualize offscreen rows while preserving the full scroll range", async () => {
  installDom();
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    id: `long-message-${index}`,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: `Long session message ${index}`,
  }));
  const snapshot = { sessionId: "long-session", items, queued: [] };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [{
      id: "long-session",
      preview: "Long session",
      title: "Long session",
      updatedAt: 1,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
      currentSession: false,
    }],
    resumeSession: async () => snapshot,
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const transcript = document.querySelector('.transcript');
  Object.defineProperties(transcript, {
    offsetWidth: { value: 800, configurable: true },
    offsetHeight: { value: 800, configurable: true },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    get() { return this.classList?.contains('transcript-virtual-row') ? 96 : 0; },
    configurable: true,
  });
  await act(async () => {
    document.querySelector('[data-session-id="long-session"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const virtualSpace = document.querySelector('.transcript-virtual-space[data-virtualized="true"]');
  const renderedRows = document.querySelectorAll('.transcript-virtual-row');
  assert.ok(virtualSpace, "long transcripts should use the virtual timeline");
  assert.ok(renderedRows.length > 0 && renderedRows.length < 80,
    `expected a bounded DOM window, rendered ${renderedRows.length} of ${items.length}`);
  assert.ok(Number.parseFloat(virtualSpace.style.height) > 500_000,
    "the virtual spacer should preserve access to the full transcript");
});

test("sidebar session titles rename inline with commit, cancel, validation, and rollback", async () => {
  installDom();
  const sessions = [
    {
      id: "rename-task",
      preview: "Original title",
      title: "Original title",
      updatedAt: 2,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
      currentSession: false,
    },
    {
      id: "inactive-task",
      preview: "Inactive title",
      title: "Inactive title",
      updatedAt: 1,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
      currentSession: false,
    },
  ];
  const renames = [];
  const resumes = [];
  let rejectRename = false;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      resumes.push(id);
      return { items: [], queued: [], sessionId: id };
    },
    renameSession: async (id, title) => {
      renames.push([id, title]);
      if (rejectRename) throw new Error("Rename failed");
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  let title = document.querySelector(".recent-session-list .session-row-copy");
  assert.equal(document.querySelector(".session-row-more")?.getAttribute("aria-label"), "More actions for Original title");
  await act(async () => {
    title.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["rename-task"]);

  await act(async () => {
    title = document.querySelector(".recent-session-list .session-row-copy");
    title.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  assert.equal(document.querySelector(".session-title-input") === null, true,
    "selector .session-title-input should be absent");
  // Under full-suite load the freshly reconciled row can swallow a single
  // synthetic dblclick; re-dispatch on the live node until the editor mounts.
  for (let attempt = 0; attempt < 3 && !document.querySelector(".session-title-input"); attempt += 1) {
    await act(async () => {
      document.querySelector(".recent-session-list .session-row-copy")
        .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      await Promise.resolve();
    });
  }
  assert.equal(document.querySelector(".session-title-input")?.getAttribute("aria-label"), "Rename Original title");
  await act(async () => document.querySelector(".session-title-input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));

  const inactiveTitle = document.querySelectorAll(".recent-session-list .session-row-copy")[1];
  await act(async () => {
    inactiveTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  });
  await act(async () => {
    inactiveTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["rename-task", "inactive-task"]);
  assert.equal(document.querySelectorAll(".session-row")[1].getAttribute("aria-current"), "page");
  assert.equal(document.querySelector(".session-title-input") === null, true,
    "selector .session-title-input should be absent");
  for (let attempt = 0; attempt < 3 && !document.querySelector(".session-title-input"); attempt += 1) {
    await act(async () => {
      document.querySelectorAll(".recent-session-list .session-row-copy")[1]
        .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      await Promise.resolve();
    });
  }
  assert.equal(document.querySelector(".session-title-input")?.getAttribute("aria-label"), "Rename Inactive title");
  await act(async () => document.querySelector(".session-title-input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));

  Object.defineProperty(window, "innerWidth", { value: 720, writable: true, configurable: true });
  const resumesBeforeHoverRename = [...resumes];
  await chooseSessionAction(document.querySelectorAll(".session-row")[0], "rename");
  assert.deepEqual(resumes, resumesBeforeHoverRename);
  assert.equal(document.querySelector(".session-title-input")?.getAttribute("aria-label"), "Rename Original title");
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
  await act(async () => document.querySelector(".session-title-input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));
  Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });

  title = document.querySelector(".recent-session-list .session-row-copy");
  await chooseSessionAction(document.querySelectorAll(".session-row")[0], "rename");
  let input = document.querySelector(".session-title-input");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(input, "Renamed task");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual(renames, [["rename-task", "Renamed task"]]);
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Renamed task");

  await chooseSessionAction(document.querySelector(".session-row"), "rename");
  input = document.querySelector(".session-title-input");
  await act(async () => {
    setValue.call(input, "   ");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(renames.length, 1);
  await act(async () => input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Renamed task");

  rejectRename = true;
  await chooseSessionAction(document.querySelector(".session-row"), "rename");
  input = document.querySelector(".session-title-input");
  await act(async () => {
    setValue.call(input, "Rejected title");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    input.blur();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(renames.at(-1), ["rename-task", "Rejected title"]);
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Renamed task");
  assert.match(document.querySelector('.inline-error[role="alert"]')?.textContent || "", /Rename failed/);
});

test("current session title renames from the workspace header", async () => {
  installDom();
  const renames = [];
  let finishResume;
  const resumed = new Promise((resolve) => {
    finishResume = () => resolve({ items: [], queued: [], sessionId: session.id });
  });
  const session = {
    id: "header-rename", preview: "Header title", title: "Header title", updatedAt: 1,
    cwd: "C:\\work", classification: "task", projectPath: null, currentSession: true,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], sessionId: session.id }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session],
    resumeSession: async () => resumed,
    renameSession: async (id, title) => { renames.push([id, title]); },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${session.id}"]`).click();
    await Promise.resolve();
  });
  await act(async () => document.querySelector(".session-title-trigger").click());
  const input = document.querySelector(".session-header-title-input");
  assert.ok(input, document.querySelector(".session-header")?.outerHTML || "session header missing");
  await act(async () => {
    finishResume();
    await resumed;
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-header-title-input") === input, true,
    "session switch completion should preserve the active title editor");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(input, "Renamed from header");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual(renames, [["header-rename", "Renamed from header"]]);
  assert.equal(document.querySelector(".session-title-trigger")?.textContent.trim(), "Renamed from header");
});

test("sidebar session deletion requires confirmation and replaces the active session with New task", async () => {
  installDom();
  let sessions = [{
    id: "delete-task",
    preview: "Delete task",
    title: "Delete task",
    updatedAt: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  }];
  const deletes = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => sessions,
    resumeSession: async (id) => ({
      items: [{ id: "message", kind: "user", text: "Delete task" }],
      queued: [],
      sessionId: id,
    }),
    deleteSession: async (id) => {
      deletes.push(id);
      sessions = sessions.filter((session) => session.id !== id);
      return { items: [], queued: [], sessionId: null };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    document.querySelector('[data-session-id="delete-task"]').click();
    await Promise.resolve();
  });
  await chooseSessionAction(document.querySelector('[data-session-id="delete-task"]'), "delete");
  assert.equal(document.querySelector(".session-row")?.classList.contains("confirming-delete"), true);
  await act(async () => document.querySelector('[aria-label="Cancel deleting Delete task"]').click());
  assert.deepEqual(deletes, []);

  await chooseSessionAction(document.querySelector('[data-session-id="delete-task"]'), "delete");
  await act(async () => {
    document.querySelector('[aria-label="Confirm deleting Delete task"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(deletes, ["delete-task"]);
  assert.equal(document.querySelector('[data-session-id="delete-task"]') === null, true,
    "the deleted task should be absent");
  assert.match(document.querySelector(".session-header h1")?.textContent || "", /New task/);
});

test("a pending session rename survives an overlapping stale session refresh", async () => {
  installDom();
  const original = {
    id: "concurrent-rename",
    preview: "Original concurrent title",
    title: "Original concurrent title",
    updatedAt: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  let storedTitle = original.title;
  let listCalls = 0;
  let resolveStaleRefresh;
  let resolveRename;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => {
      listCalls += 1;
      if (listCalls === 2) {
        return new Promise((resolve) => {
          resolveStaleRefresh = () => resolve([{ ...original }]);
        });
      }
      return [{ ...original, title: storedTitle }];
    },
    startTask: async () => ({ items: [], queued: [] }),
    renameSession: async (_id, title) => {
      await new Promise((resolve) => {
        resolveRename = resolve;
      });
      storedTitle = title;
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
  });
  await chooseSessionAction(document.querySelector(".recent-session-list .session-row"), "rename");
  const input = document.querySelector(".session-title-input");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(input, "Authoritative title");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Authoritative title");
  await act(async () => {
    resolveStaleRefresh();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Authoritative title");
  await act(async () => {
    resolveRename();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Authoritative title");
  assert.equal(storedTitle, "Authoritative title");
});

test("OpenCode tooltip placement stays inside the viewport and flips away from a clipped edge", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  // The sidebar toggle intentionally carries no tooltip; anchor the
  // placement checks on the settings button, which keeps data-tooltip.
  const trigger = document.querySelector(".sidebar-settings-button");
  let triggerBounds = {
    left: 990, right: 1018, top: 20, bottom: 48, width: 28, height: 28,
    x: 990, y: 20, toJSON() {},
  };
  trigger.getBoundingClientRect = () => triggerBounds;
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains("oc-tooltip")) {
      return {
        left: 0, right: 280, top: 0, bottom: 34, width: 280, height: 34,
        x: 0, y: 0, toJSON() {},
      };
    }
    return originalBounds.call(this);
  };
  const originalTimeout = window.setTimeout;
  window.setTimeout = (callback) => {
    callback();
    return 1;
  };

  await act(async () => trigger.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true })));
  let tooltip = document.querySelector(".oc-tooltip");
  assert.equal(tooltip.dataset.side, "bottom");
  assert.equal(tooltip.style.left, "736px");
  assert.equal(tooltip.style.top, "54px");
  assert.equal(tooltip.style.visibility, "");

  await act(async () => trigger.dispatchEvent(new window.MouseEvent("pointerout", { bubbles: true })));
  triggerBounds = {
    left: 990, right: 1018, top: 730, bottom: 758, width: 28, height: 28,
    x: 990, y: 730, toJSON() {},
  };
  await act(async () => trigger.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true })));
  tooltip = document.querySelector(".oc-tooltip");
  assert.equal(tooltip.dataset.side, "top");
  assert.equal(tooltip.style.left, "736px");
  assert.equal(tooltip.style.top, "690px");

  window.setTimeout = originalTimeout;
});

test("snapshot notifications render and dismiss through the OpenCode toast surface", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [], queued: [],
      toasts: [{ id: "saved", tone: "success", text: "Settings saved" }],
    }),
    subscribeState: () => () => {},
    listSessions: async () => [],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const toast = document.querySelector('.oc-toast[data-tone="success"]');
  assert.equal(toast != null, true, "success toast should be present");
  assert.match(toast.textContent, /Completed.*Settings saved/);
  await act(async () => toast.querySelector('[aria-label="Dismiss notification"]').click());
  assert.equal(document.querySelector('.oc-toast') === null, true, "selector .oc-toast should be absent");
});

test("desktop retains, deduplicates, bounds, and explicitly dismisses engine error toasts", async () => {
  installDom();
  let publish;
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [], queued: [],
      toasts: [{ id: "error-1", tone: "error", text: "First failure" }],
    }),
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    listSessions: async () => [],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  assert.match(document.querySelector('.oc-toast[data-tone="error"]')?.textContent || "", /First failure/);

  await act(async () => publish({ items: [], queued: [], toasts: [] }));
  assert.match(document.querySelector('.oc-toast[data-tone="error"]')?.textContent || "", /First failure/);

  await act(async () => publish({
    items: [], queued: [],
    toasts: [
      { id: "duplicate", tone: "error", text: "First failure" },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `error-${index + 2}`,
        tone: "error",
        text: `Failure ${index + 2}`,
      })),
    ],
  }));
  const errors = Array.from(document.querySelectorAll('.oc-toast[data-tone="error"]'));
  assert.equal(errors.length, 5);
  assert.equal(errors.some((toast) => toast.textContent.includes("First failure")), false);
  assert.equal(errors.filter((toast) => toast.textContent.includes("Failure 2")).length, 1);

  await act(async () => errors.at(-1).querySelector('[aria-label="Dismiss notification"]').click());
  assert.equal(document.querySelectorAll('.oc-toast[data-tone="error"]').length, 4);
});

test("a failed project replacement synchronizes to the empty actual host without stale selection", async () => {
  installDom();
  let publish;
  const initial = {
    currentProject: "C:\\work\\old",
    recentProjects: ["C:\\work\\old", "C:\\work\\next"],
    items: [{ id: "stale", kind: "assistant", text: "Stale transcript" }],
    queued: [],
  };
  let actual = initial;
  window.mixdogDesktop = {
    getSnapshot: async () => actual,
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    listProjects: async () => [
      { path: "C:\\work\\old", alias: "Old", pinned: false },
      { path: "C:\\work\\next", alias: "Next", pinned: false },
    ],
    listSessions: async () => [],
    startProject: async (project) => {
      if (project.endsWith("\\old")) return initial;
      actual = null;
      publish(null);
      throw new Error("Project switch failed");
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  let dialog = await openProjectSwitcher();
  let rows = dialog.querySelectorAll(".project-row");
  assert.equal(rows[0].getAttribute("aria-current"), "page");
  assert.equal(rows[1].hasAttribute("aria-current"), false);
  assert.equal(document.querySelector(".task-link").getAttribute("aria-current"), null);
  assert.doesNotMatch(document.body.textContent || "", /Stale transcript/);
  assert.equal(document.querySelector(".composer") != null, true, "selector .composer should be present");
  await act(async () => {
    Array.from(rows).find((row) => /old/i.test(row.textContent || ""))?.click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".workspace-project-trigger") === null, true, "selector .workspace-project-trigger should be absent");
  assert.match(document.querySelector(".session-header h1")?.textContent || "", /old/i);
  assert.match(document.body.textContent || "", /Stale transcript/);

  dialog = await openProjectSwitcher();
  rows = dialog.querySelectorAll(".project-row");
  await act(async () => {
    Array.from(rows).find((row) => /next/i.test(row.textContent || ""))?.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(document.querySelector(".empty-state") === null, true, "selector .empty-state should be absent");
  assert.equal(document.querySelector(".composer") != null, true, "selector .composer should be present");
  assert.doesNotMatch(document.body.textContent || "", /Stale transcript/);
  assert.equal(document.querySelector(".task-link").getAttribute("aria-current"), null);
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  const alert = document.querySelector('.inline-error[role="alert"]');
  assert.match(alert.textContent || "", /Project switch failed/);
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
  dialog = await openProjectSwitcher();
  rows = dialog.querySelectorAll(".project-row");
  assert.equal(rows[0].hasAttribute("aria-current"), false);
  assert.equal(rows[1].hasAttribute("aria-current"), false);
});

test("submit, stop, and tool diff controls remain wired through the app", async () => {
  installDom();
  let publish;
  const submitted = [];
  let aborts = 0;
  const patch = `diff --git a/old.txt b/new.txt
--- a/old.txt
+++ b/new.txt
@@ -1,6 +1,6 @@
-old one
+new one
-old two
+new two
-old three
+new three
-old four
+new four
-old five
+new five
-old six
+new six`;
  const initial = {
    currentProject: "C:\\work\\sample",
    recentProjects: ["C:\\work\\sample"],
    items: [{ id: "tool-1", kind: "tool", name: "edit", expanded: true, result: patch }],
    queued: [],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => initial,
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    startProject: async () => initial,
    listSessions: async () => [],
    submit: async (text) => {
      submitted.push(text);
      return true;
    },
    abort: async () => { aborts += 1; },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  await selectFirstProject();
  assert.equal(document.querySelector(".code-diff") != null, true, "selector .code-diff should be present");
  assert.equal(document.querySelectorAll(".starter-grid button").length, 0);
  assert.match(document.querySelector(".diff-file header").textContent || "", /new\.txt/);
  const diffToggle = document.querySelector(".diff-toggle");
  assert.equal(diffToggle.textContent.trim(), "Show full diff");
  await act(async () => diffToggle.click());
  assert.equal(diffToggle.textContent.trim(), "Collapse diff");

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  let textareaScrollHeight = 104;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => textarea.value ? textareaScrollHeight : 0,
  });
  const setTextareaValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  await act(async () => {
    textarea.focus();
    setTextareaValue.call(textarea, "Preserve this behavior");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  textarea.setSelectionRange(8, 8);
  assert.equal(textarea.style.height, "104px");
  assert.equal(textarea.style.overflowY, "hidden");
  assert.equal(document.activeElement === textarea, true, "composer should retain focus after the initial resize");
  assert.equal(textarea.selectionStart, 8);
  textareaScrollHeight = 240;
  await act(async () => window.dispatchEvent(new window.Event("resize")));
  assert.equal(textarea.style.height, "180px");
  assert.equal(textarea.style.overflowY, "auto");
  assert.equal(document.activeElement === textarea, true, "composer should retain focus after height capping");
  assert.equal(textarea.selectionStart, 8);
  await act(async () => {
    document.querySelector('button[aria-label="Send message"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(submitted, ["Preserve this behavior"]);
  assert.equal(textarea.value, "");
  assert.equal(textarea.style.height, "52px");
  assert.equal(textarea.style.overflowY, "hidden");

  await act(async () => publish({ ...initial, busy: true }));
  const stop = document.querySelector('button[aria-label="Stop generation"]');
  assert.equal(stop != null, true, "stop-generation button should be present while busy");
  await act(async () => {
    stop.click();
    await Promise.resolve();
  });
  assert.equal(aborts, 1);

  await act(async () => {
    setTextareaValue.call(textarea, "Steer this turn");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(document.querySelector('button[aria-label="Stop generation"]') === null, true, "selector button[aria-label=\"Stop generation\"] should be absent");
  const steer = document.querySelector('button[aria-label="Queue or steer active turn"]');
  assert.equal(steer != null, true, "queue-or-steer button should be present for a draft");
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, isComposing: true,
    }));
    await Promise.resolve();
  });
  assert.deepEqual(submitted, ["Preserve this behavior"]);
  await act(async () => {
    steer.click();
    await Promise.resolve();
  });
  assert.deepEqual(submitted, ["Preserve this behavior", "Steer this turn"]);
});

test("a durable new task refreshes and selects exactly once after busy settles", async () => {
  installDom();
  const calls = [];
  let accepted = false;
  let durable = false;
  let refreshes = 0;
  let publish;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => {
      refreshes += 1;
      return durable ? [{
        id: "durable-task",
        preview: "Durable task preview",
        title: "Durable task title",
        updatedAt: 1,
        cwd: "C:\\work",
        classification: "task",
        projectPath: null,
        currentSession: true,
      }] : [];
    },
    startTask: async () => { calls.push("start"); return { items: [], queued: [] }; },
    submit: async (text) => { calls.push(`submit:${text}`); return accepted; },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const textarea = document.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Original prompt");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector('[aria-label="Send message"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["start", "submit:Original prompt"]);
  assert.equal(textarea.value, "Original prompt");
  accepted = true;
  await act(async () => {
    document.querySelector('[aria-label="Send message"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["start", "submit:Original prompt", "submit:Original prompt"]);
  assert.equal(textarea.value, "");
  assert.equal(refreshes, 1);
  await act(async () => publish({
    busy: true,
    items: [{ id: "assistant-1", kind: "assistant", text: "Working", streaming: true }],
    queued: [],
  }));
  await act(async () => publish({
    busy: true,
    items: [{ id: "assistant-1", kind: "assistant", text: "Still working", streaming: true }],
    queued: [],
  }));
  assert.equal(refreshes, 1);
  durable = true;
  await act(async () => {
    publish({
      busy: false,
      items: [{ id: "assistant-1", kind: "assistant", text: "Done" }],
      queued: [],
    });
    await Promise.resolve();
  });
  assert.equal(refreshes, 2);
  assert.equal(document.querySelector(".recent-session-list .session-row")?.getAttribute("aria-current"), "page");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "Durable task title");
  assert.equal(document.querySelector(".inline-error") === null, true, "selector .inline-error should be absent");
});

test("a rejected submit clears settlement tracking before later busy cycles", async () => {
  installDom();
  let publish;
  let refreshes = 0;
  let rejectSubmit;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => { refreshes += 1; return []; },
    startTask: async () => ({ items: [], queued: [] }),
    submit: async () => new Promise((resolve) => { rejectSubmit = () => resolve(false); }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const textarea = document.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Rejected prompt");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector('[aria-label="Send message"]').click();
    await Promise.resolve();
  });
  await act(async () => publish({ busy: true, items: [], queued: [] }));
  await act(async () => {
    rejectSubmit();
    await Promise.resolve();
  });
  assert.equal(textarea.value, "Rejected prompt");
  await act(async () => publish({ busy: false, items: [], queued: [] }));
  await act(async () => publish({ busy: true, items: [], queued: [] }));
  await act(async () => publish({ busy: false, items: [], queued: [] }));
  assert.equal(refreshes, 1);
});

test("a throwing submit clears settlement tracking before an unrelated busy cycle", async () => {
  installDom();
  let publish;
  let refreshes = 0;
  let throwSubmit;
  const durableSession = {
    id: "unrelated-session",
    preview: "Unrelated session",
    title: "Unrelated session",
    updatedAt: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: true,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => {
      refreshes += 1;
      return refreshes > 1 ? [durableSession] : [];
    },
    startTask: async () => ({ items: [], queued: [] }),
    submit: async () => new Promise((_resolve, reject) => {
      throwSubmit = () => reject(new Error("Submit transport failed"));
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const textarea = document.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Throwing prompt");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector('[aria-label="Send message"]').click();
    await Promise.resolve();
  });
  await act(async () => publish({ busy: true, items: [], queued: [] }));
  await act(async () => {
    throwSubmit();
    await Promise.resolve();
  });
  assert.equal(textarea.value, "Throwing prompt");
  assert.match(document.querySelector(".inline-error")?.textContent || "", /Submit transport failed/);

  await act(async () => publish({ busy: false, items: [], queued: [] }));
  await act(async () => publish({ busy: true, items: [], queued: [] }));
  await act(async () => publish({ busy: false, items: [], queued: [] }));
  assert.equal(refreshes, 1);
  assert.equal(document.querySelector(".session-sidebar-scroll .session-row") === null, true,
    "no session row should exist before persistence");
  assert.equal(document.querySelector(".topbar-title") === null, true, "selector .topbar-title should be absent");
  assert.equal(document.querySelector(".task-link")?.getAttribute("aria-current"), null);
});

test("failed resume preserves a surviving known project session, then clears when the actual host is empty", async () => {
  installDom();
  let publish;
  const active = {
    sessionId: "active",
    currentProject: "C:\\work\\one",
    recentProjects: ["C:\\work\\one"],
    items: [{ id: "active-message", kind: "assistant", text: "Active transcript" }],
    queued: [],
  };
  let actual = { items: [], queued: [], recentProjects: ["C:\\work\\one"] };
  window.mixdogDesktop = {
    getSnapshot: async () => actual,
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listProjects: async () => [{ path: "C:\\work\\one", alias: "One", pinned: false }],
    listSessions: async () => [
      { id: "active", preview: "Active project session", title: "Active project session", updatedAt: 3, cwd: "C:\\work\\one", classification: "project", projectPath: "C:\\work\\one", currentSession: true },
      { id: "survives", preview: "Fails before replacement", title: "Fails before replacement", updatedAt: 2, cwd: "C:\\work\\one", classification: "project", projectPath: "C:\\work\\one", currentSession: false },
      { id: "failed", preview: "Failed target", title: "Failed target", updatedAt: 1, cwd: "x", classification: "task", projectPath: null, currentSession: false },
    ],
    resumeSession: async (id) => {
      if (id === "active") {
        actual = active;
        return active;
      }
      if (id === "survives") throw new Error("Resume failed before replacement");
      actual = null;
      publish(null);
      throw new Error("Resume failed");
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const activeRow = document.querySelector('[data-session-id="active"]');
  const survivingRow = document.querySelector('[data-session-id="survives"]');
  const failedRow = document.querySelector('[data-session-id="failed"]');
  await act(async () => {
    activeRow.click();
    await Promise.resolve();
  });
  assert.equal(activeRow.getAttribute("aria-current"), "page");
  assert.match(document.body.textContent || "", /Active transcript/);
  await act(async () => {
    survivingRow.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(activeRow.getAttribute("aria-current"), "page");
  assert.equal(survivingRow.hasAttribute("aria-current"), false);
  assert.match(document.body.textContent || "", /Active transcript/);
  assert.match(document.querySelector('[role="alert"]').textContent || "", /before replacement/);

  await act(async () => {
    failedRow.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(activeRow.hasAttribute("aria-current"), false);
  assert.equal(failedRow.hasAttribute("aria-current"), false);
  assert.equal(document.querySelector(".task-link").getAttribute("aria-current"), null);
  assert.doesNotMatch(document.body.textContent || "", /Active transcript/);
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  assert.match(document.querySelector('[role="alert"]').textContent || "", /Resume failed/);
});

test("flat recent sessions and separate project switcher preserve navigation and project actions", async () => {
  installDom();
  const resumed = [];
  const projectActions = [];
  const project = {
    path: "C:\\work\\one",
    alias: "One alias",
    pinned: false,
  };
  const secondProject = {
    path: "C:\\work\\two",
    alias: "Two alias",
    pinned: false,
  };
  let visibleProjects = [project, secondProject];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: ["C:\\work\\one"] }),
    subscribeState: () => () => {},
    listProjects: async () => visibleProjects,
    listSessions: async () => [
      { id: "task_old", preview: "Older task", title: "Older task", updatedAt: 1, cwd: "x", classification: "task", projectPath: null, currentSession: false },
      { id: "project_one", preview: "Project work", title: "Project work", updatedAt: 2, cwd: "C:\\work\\one", classification: "project", projectPath: "C:\\work\\one", currentSession: false },
      { id: "project_new", preview: "Newest project work", title: "Newest project work", updatedAt: 5, cwd: "C:\\work\\one", classification: "project", projectPath: "C:\\work\\one", currentSession: false },
      { id: "project_unregistered", preview: "Unregistered folder task", title: "Unregistered folder task", updatedAt: 6, cwd: "C:\\work\\ghost", classification: "project", projectPath: "C:\\work\\ghost", currentSession: false },
      { id: "task_new", preview: "", title: "", updatedAt: 3, cwd: "x", classification: "task", projectPath: null, currentSession: false },
      { id: "legacy", preview: "Legacy", title: "Legacy", updatedAt: 4, cwd: "x", classification: null, projectPath: null, currentSession: false },
    ],
    startProject: async (path) => ({ currentProject: path, items: [], queued: [] }),
    resumeSession: async (id) => { resumed.push(id); return { items: [], queued: [] }; },
    removeProject: async (path) => {
      projectActions.push(["remove", path]);
      visibleProjects = visibleProjects.filter((candidate) => candidate.path !== path);
    },
    setProjectPinned: async (path, pinned) => {
      projectActions.push(["pin", path, pinned]);
      visibleProjects = visibleProjects
        .map((candidate) => candidate.path === path ? { ...candidate, pinned } : candidate)
        .sort((left, right) => Number(right.pinned) - Number(left.pinned));
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(Array.from(document.querySelectorAll('.recent-session-list .session-row-copy b'),
    (row) => row.textContent.trim()),
  ["Unregistered folder task", "Newest project work", "Untitled session", "Project work", "Older task"]);
  assert.equal(document.querySelectorAll(".session-sidebar-scroll .session-row-icon").length, 5);
  assert.equal(document.querySelector(".sidebar [aria-label='Open projects']")?.textContent.trim(), "Project");
  assert.equal(document.querySelector(".sidebar .project-group"), null);
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Legacy/);
  let projectDialog = await openProjectSwitcher();
  assert.match(projectDialog.querySelector(".project-list")?.textContent || "", /One alias/);
  assert.equal(projectDialog.querySelectorAll('[data-component="project-avatar-v2"]').length, 0);
  assert.equal(projectDialog.querySelectorAll('[aria-label="Pinned project"]').length, 0);
  assert.equal(projectDialog.querySelectorAll(".project-row-icon").length, 0);
  assert.equal(projectDialog.querySelector(".projects-add")?.textContent.trim(), "Add project");
  assert.equal(document.querySelector(".sidebar .project-row, .sidebar .project-more, .sidebar .new-project") === null, true, "project management controls should remain in the switcher");
  const firstProject = Array.from(projectDialog.querySelectorAll(".project-row"))
    .find((row) => /One alias/.test(row.textContent || ""));
  assert.equal(firstProject != null, true, "first project row should be present in the switcher");
  assert.equal(firstProject.getAttribute("aria-current"), "page", "the last used project should be selected by default");
  await act(async () => {
    firstProject.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".sidebar").closest(".app-shell").classList.contains("sidebar-collapsed"), false);
  assert.match(document.querySelector(".session-header h1")?.textContent || "", /One alias/);
  await act(async () => {
    document.querySelector('[data-session-id="project_new"]').click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(resumed, ["project_new"]);
  assert.equal(document.querySelector('[data-session-id="project_new"]').getAttribute("aria-current"), "page");
  assert.equal(document.querySelector(".sidebar").closest(".app-shell").classList.contains("sidebar-collapsed"), false);

  projectDialog = await openProjectSwitcher();
  const firstProjectCard = Array.from(projectDialog.querySelectorAll(".project-card"))
    .find((card) => /One alias/.test(card.textContent || ""));
  const more = firstProjectCard?.querySelector(".project-more");
  assert.equal(more != null, true, "project overflow button should be present");
  more.focus();
  await act(async () => {
    more.click();
    await Promise.resolve();
  });
  let menu = document.querySelector('[role="menu"]');
  assert.equal(menu.closest(".project-card") === firstProjectCard, true, "project menu should remain inside its project card");
  assert.deepEqual(
    Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent),
    ["New task", "Open in Explorer", "Pin project", "Rename", "Remove project"],
  );
  const menuItems = menu.querySelectorAll('[role="menuitem"]');
  assert.equal(document.activeElement === menuItems[0], true, "opening the project menu should focus its first item");
  await act(async () => menuItems[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement?.textContent, "Open in Explorer");
  await act(async () => {
    menuItems[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[role="menu"]') === null, true, "selector [role=\"menu\"] should be absent");
  assert.equal(document.activeElement === more, true, "closing the project menu should restore overflow-button focus");

  await act(async () => more.click());
  menu = document.querySelector('[role="menu"]');
  const destination = projectDialog.querySelector(".projects-add");
  await act(async () => {
    destination.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    destination.focus();
  });
  assert.equal(document.querySelector('[role="menu"]') === null, true, "selector [role=\"menu\"] should be absent");
  assert.equal(document.activeElement === destination, true, "outside pointer interaction should preserve destination focus");

  await act(async () => more.click());
  menu = document.querySelector('[role="menu"]');
  assert.equal(menu != null, true, "selector [role=\"menu\"] should be present");
  await act(async () => {
    menu.querySelectorAll('[role="menuitem"]')[2].click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(projectActions.at(-1), ["pin", "C:\\work\\one", true]);
  const pinnedCard = Array.from(projectDialog.querySelectorAll(".project-card"))
    .find((card) => /One alias/.test(card.textContent || ""));
  assert.equal(pinnedCard?.classList.contains("pinned"), true);
  assert.equal(pinnedCard?.querySelector('[aria-label="Pinned project"]') != null, true);
  const pinnedMore = pinnedCard.querySelector(".project-more");
  await act(async () => pinnedMore.click());
  assert.match(document.querySelector('[role="menu"]')?.textContent || "", /Unpin project/);
  await act(async () => {
    projectDialog.querySelector('button[aria-label="Close projects"]').click();
    await Promise.resolve();
  });
  projectDialog = await openProjectSwitcher();
  assert.equal(document.querySelector('[role="menu"]') === null, true,
    "closing and reopening Projects must clear its menu");
  const reopenedCard = Array.from(projectDialog.querySelectorAll(".project-card"))
    .find((card) => /One alias/.test(card.textContent || ""));
  const reopenedMore = reopenedCard.querySelector(".project-more");
  await act(async () => reopenedMore.click());
  menu = document.querySelector('[role="menu"]');
  await act(async () => {
    menu.querySelectorAll('[role="menuitem"]')[4].click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(projectActions.at(-1), ["remove", "C:\\work\\one"]);
  assert.doesNotMatch(document.querySelector(".project-list").textContent, /One alias/);
  assert.match(document.querySelector(".project-list").textContent, /Two alias/);
  assert.equal(document.activeElement === document.querySelector(".project-row"), true, "removal should focus the remaining project row");
});

test("mobile sidebar closes at the inclusive 760px breakpoint after navigation", async () => {
  installDom();
  const projectPath = "C:\\work\\mobile";
  Object.defineProperty(window, "innerWidth", {
    value: 760,
    configurable: true,
  });
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: [projectPath] }),
    subscribeState: () => () => {},
    listProjects: async () => [{ path: projectPath, alias: "Mobile project", pinned: false }],
    listSessions: async () => [
      { id: "mobile", preview: "Mobile session", title: "Mobile session", updatedAt: 1, cwd: projectPath, classification: "project", projectPath, currentSession: false },
    ],
    startProject: async () => ({ currentProject: projectPath, items: [], queued: [] }),
    resumeSession: async () => ({ items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await selectFirstProject();
  assert.equal(document.querySelector(".sidebar").closest(".app-shell").classList.contains("sidebar-collapsed"), true);
  assert.equal(document.querySelector(".sidebar").getAttribute("aria-hidden"), "true");
  await act(async () => document.querySelector(".toolbar-sidebar").click());
  assert.equal(document.querySelector(".sidebar").getAttribute("aria-hidden"), "false");
  await act(async () => {
    document.querySelector('[data-session-id="mobile"]').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".sidebar").closest(".app-shell").classList.contains("sidebar-collapsed"), true);
  assert.equal(document.querySelector(".sidebar").getAttribute("aria-hidden"), "true");
});

test("desktop sidebar remains open immediately above the 760px breakpoint", async () => {
  installDom();
  const projectPath = "C:\\work\\desktop-boundary";
  Object.defineProperty(window, "innerWidth", {
    value: 761,
    configurable: true,
  });
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: [projectPath] }),
    subscribeState: () => () => {},
    listProjects: async () => [{ path: projectPath, alias: "Boundary project", pinned: false }],
    listSessions: async () => [],
    startProject: async () => ({ currentProject: projectPath, items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await selectFirstProject();
  const shell = document.querySelector(".app-shell");
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(document.querySelector(".sidebar").getAttribute("aria-hidden"), "false");
});

test("settings and provider error toasts use the notification surface without changing successful turn outcomes", async () => {
  installDom();
  let publish;
  const firstFailure = {
    currentProject: "C:\\work\\sample",
    recentProjects: ["C:\\work\\sample"],
    items: [
      { id: "user-1", kind: "user", text: "First turn" },
      { id: "turn-1", kind: "turndone", status: "done", label: "First completed" },
      { id: "user-2", kind: "user", text: "Second turn" },
      { id: "status-2", kind: "statusdone", label: "Done" },
      { id: "turn-2", kind: "turndone", status: "done", label: "Completed" },
    ],
    queued: [],
    toasts: [{ id: "provider-failure-2", tone: "error", text: "Provider request failed: quota exceeded" }],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => firstFailure,
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    listSessions: async () => [],
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    startProject: async () => firstFailure,
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();

  const notification = document.querySelector('.oc-toast-region .oc-toast[data-tone="error"]');
  assert.match(notification.textContent || "", /Provider request failed: quota exceeded/);
  assert.equal(document.querySelector(".composer-region .inline-error") === null, true,
    "provider notifications should use the redesigned toast surface rather than bridge errors");
  let outcomes = Array.from(document.querySelectorAll(".turn-status"));
  assert.deepEqual(outcomes.map((row) => row.textContent?.trim()), ["First completed", "Done", "Completed"]);

  await act(async () => publish({ ...firstFailure, toasts: [] }));
  assert.equal(document.querySelector(".composer-region .inline-error") === null, true, "selector .composer-region .inline-error should be absent");
  outcomes = Array.from(document.querySelectorAll(".turn-status"));
  assert.deepEqual(outcomes.map((row) => row.textContent?.trim()), ["First completed", "Done", "Completed"]);

  await act(async () => publish({
    ...firstFailure,
    toasts: [],
    items: [
      ...firstFailure.items,
      { id: "user-3", kind: "user", text: "Third turn" },
      { id: "turn-3", kind: "turndone", status: "done", label: "Third completed" },
    ],
  }));
  outcomes = Array.from(document.querySelectorAll(".turn-status"));
  assert.deepEqual(
    outcomes.map((row) => row.textContent?.trim()),
    ["First completed", "Done", "Completed", "Third completed"],
  );
  assert.equal(document.querySelectorAll(".turn-status.failed").length, 0);
});

test("an error toast does not fail a turn until the core publishes a failed completion", async () => {
  installDom();
  let publish;
  const beforeCompletion = {
    currentProject: "C:\\work\\sample",
    recentProjects: ["C:\\work\\sample"],
    items: [
      { id: "user-1", kind: "user", text: "Fail this turn" },
      { id: "assistant-1", kind: "assistant", text: "Partial response" },
    ],
    queued: [],
    toasts: [{ id: "early-error", tone: "error", text: "Provider disconnected" }],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => beforeCompletion,
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    listSessions: async () => [],
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    startProject: async () => beforeCompletion,
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();
  assert.deepEqual(
    Array.from(document.querySelectorAll(".turn-status")).map((row) => row.textContent?.trim()),
    [],
  );

  await act(async () => publish({
    ...beforeCompletion,
    toasts: [],
    items: [...beforeCompletion.items, {
      id: "turn-1",
      kind: "turndone",
      status: "failed",
      label: "Completed",
    }],
  }));
  const outcomes = Array.from(document.querySelectorAll(".turn-status"));
  assert.deepEqual(outcomes.map((row) => row.textContent?.trim()), ["FailedRetry"]);
  assert.equal(outcomes[0].querySelector(".lucide-check") === null, true, "selector .lucide-check should be absent");
  assert.ok(outcomes[0].querySelector(".turn-retry"), "failed turns must expose a retry control");
});

test("a cancelled core completion remains interrupted even when an unrelated error toast is visible", async () => {
  installDom();
  const snapshot = {
    currentProject: "C:\\work\\sample",
    recentProjects: ["C:\\work\\sample"],
    items: [
      { id: "user-1", kind: "user", text: "Cancel this turn" },
      { id: "turn-1", kind: "turndone", status: "cancelled" },
    ],
    queued: [],
    toasts: [{ id: "settings-error", tone: "error", text: "Could not save a setting" }],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    listSessions: async () => [],
    subscribeState: () => () => {},
    startProject: async () => snapshot,
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();

  const outcomes = Array.from(document.querySelectorAll(".turn-status"));
  assert.deepEqual(outcomes.map((row) => row.textContent?.trim()), ["Cancelled"]);
  assert.equal(outcomes[0].classList.contains("interrupted"), true);
  assert.equal(document.querySelectorAll(".turn-status.failed").length, 0);
});

test("successful completion markers leave a quiet persistent transcript row", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      currentProject: "C:\\work\\sample",
      recentProjects: ["C:\\work\\sample"],
      items: [{ id: "turn-done", kind: "turndone", label: "Completed" }],
      queued: [],
      toasts: [],
    }),
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    subscribeState: () => () => {},
    startProject: async () => ({
      currentProject: "C:\\work\\sample",
      recentProjects: ["C:\\work\\sample"],
      items: [{ id: "turn-done", kind: "turndone", label: "Completed" }],
      queued: [],
      toasts: [],
    }),
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();

  const completion = document.querySelector(".turn-status.complete");
  assert.equal(completion?.textContent?.trim(), "Completed");
  assert.equal(completion?.querySelector(".lucide-check") != null, true, "selector .lucide-check should be present");
});

test("an empty task offers four Mixdog starters that populate and focus the composer", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      currentProject: "C:\\work\\sample",
      recentProjects: ["C:\\work\\sample"],
      items: [],
      queued: [],
    }),
    listProjects: async () => [{ path: "C:\\work\\sample", alias: "Sample", pinned: false }],
    subscribeState: () => () => {},
    startProject: async () => ({
      currentProject: "C:\\work\\sample",
      recentProjects: ["C:\\work\\sample"],
      items: [],
      queued: [],
    }),
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();

  const starters = document.querySelectorAll(".starter-grid button");
  assert.equal(starters.length, 4);
  assert.match(document.querySelector(".thread-welcome")?.textContent || "", /Mixdog/);
  assert.equal(
    document.querySelector(".thread-welcome p")?.textContent,
    "Describe what you would like Mixdog to help with.",
  );
  assert.doesNotMatch(document.querySelector(".thread-welcome")?.textContent || "", /project|context|unclassified/i);
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 88 });
  await act(async () => starters[1].click());
  assert.equal(textarea.value, "Explain how this codebase is structured.");
  assert.equal(textarea.style.height, "88px");
  assert.equal(document.activeElement === textarea, true, "starter selection should focus the composer");
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  assert.doesNotMatch(document.querySelector(".composer")?.textContent || "", /Local context|No project/);
});

test("modal layers retain isolation until the final owner releases and have one keyboard owner", () => {
  installDom();
  const shell = document.querySelector(".app-shell");
  const picker = acquireModalLayer([shell]);
  const approval = acquireModalLayer([shell]);
  const pickerSurface = document.createElement("div");
  const approvalSurface = document.createElement("div");
  picker.attachSurface(pickerSurface);
  approval.attachSurface(approvalSurface);
  assert.equal(picker.isTop(), false);
  assert.equal(approval.isTop(), true);
  assert.ok(Number(approvalSurface.style.zIndex) > Number(pickerSurface.style.zIndex),
    "visual stacking must match keyboard ownership");
  picker.release();
  assert.equal(shell.inert, true);
  assert.equal(shell.getAttribute("aria-hidden"), "true");
  approval.release();
  assert.equal(shell.inert, false);
  assert.equal(shell.hasAttribute("aria-hidden"), false);

  shell.setAttribute("aria-hidden", "before");
  const command = acquireModalLayer([shell]);
  shell.setAttribute("aria-hidden", "external-owner");
  command.release();
  assert.equal(shell.getAttribute("aria-hidden"), "external-owner",
    "cleanup must not overwrite isolation changed by another owner");
});

test("model selector shows Recent and provider-grouped models in one stable list", async () => {
  installDom();
  const catalogOptions = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [], queued: [], provider: "openai", model: "gpt-real", effort: "high",
      fastCapable: true, fast: false,
    }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    invokeCapability: async ({ capability }) => ({
      value: capability === "getProviderSetup" ? {
        api: [
          { id: "openai", authenticated: true, enabled: true },
          { id: "anthropic", authenticated: false, enabled: true },
          { id: "deepseek", authenticated: true, enabled: true },
        ],
        oauth: [], local: [{ id: "ollama", detected: true, enabled: false }],
      } : capability === "getTheme" ? "basic" : {},
    }),
    listProviderModels: async (options) => {
      catalogOptions.push(options);
      const catalog = [
      { provider: "anthropic", model: "claude-sonnet-4-5", display: "Claude Sonnet 4.5",
        releaseDate: "2025-09-29", contextWindow: 200_000, fastCapable: true, effortOptions: [] },
      { provider: "anthropic", model: "claude-opus-4-7", display: "Claude Opus 4.7",
        releaseDate: "2026-05-01", contextWindow: 1_000_000, fastCapable: false, effortOptions: [] },
      { provider: "openai", model: "gpt-real", display: "GPT Real", releaseDate: "2026-03-01", latest: true, effortOptions: [
        { value: "low", label: "Low" }, { value: "high", label: "High" },
      ] },
      { provider: "deepseek", model: "deepseek-v4-flash", display: "DeepSeek V4 Flash",
        releaseDate: "2026-04-01", effortOptions: [] },
      { provider: "anthropic", model: "claude-sonnet-4-6", display: "Claude Sonnet 4.6",
        releaseDate: "2026-02-17", contextWindow: 1_000_000, fastCapable: true, effortOptions: [] },
      ];
      return options?.force ? [...catalog, {
        provider: "openai", model: "gpt-next", display: "GPT Next",
        releaseDate: "2026-06-01", contextWindow: 400_000, fastCapable: true, effortOptions: [],
      }] : catalog;
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(catalogOptions.slice(0, 2), [{ quick: true }, { quick: false }]);
  const trigger = document.querySelector(".model-trigger");
  trigger.getBoundingClientRect = () => ({ left: 20, top: 700 });
  assert.match(trigger.textContent, /GPT-Real/);
  assert.equal(trigger.querySelector(".provider-icon") === null, true,
    "composer model trigger should not show a provider mark");
  assert.match(document.querySelector('[aria-label="Reasoning effort"]').textContent, /High/);
  assert.deepEqual(Array.from(document.querySelector(".route-controls").children).map((node) => node.className),
    ["model-trigger", "effort-control", "fast-control"]);
  const realNow = Date.now;
  Date.now = () => realNow() + 300_001;
  try {
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(catalogOptions.slice(2, 4), [{ quick: true }, { force: true, quick: false }]);
  const dialog = document.querySelector(".model-picker-dialog");
  assert.equal(dialog.closest(".model-picker-layer").parentElement === document.body, true,
    "model selector portal should be attached to document.body");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.hasAttribute("data-stage"), false);
  assert.equal(dialog.querySelector(".model-list").getAttribute("aria-label"), "Available models");
  assert.deepEqual(Array.from(dialog.querySelectorAll(".model-group--provider > h3"), (node) => node.textContent),
    ["OpenAI API", "DeepSeek API"]);
  assert.deepEqual(Array.from(dialog.querySelectorAll(".model-option-row strong"), (node) => node.textContent),
    ["GPT-Real", "DeepSeek V4 Flash"]);
  assert.doesNotMatch(dialog.textContent, /Anthropic|Ollama|Needs setup/,
    "disconnected providers must stay out of the model picker");
  assert.ok(dialog.querySelector('button[aria-label="Add provider"]'));
  assert.equal(dialog.querySelectorAll(".model-provider-row, .provider-icon, .model-provider-chevron").length, 0);
  assert.equal(dialog.querySelector(".model-option-row").getAttribute("aria-selected"), "true");
  assert.equal(dialog.querySelector(".model-option-row").getAttribute("data-tooltip"), null);
  assert.equal(dialog.querySelector(".model-option-row").getAttribute("data-tooltip-side"), null);
  assert.equal(dialog.querySelector(".model-tag"), null);
  assert.doesNotMatch(dialog.textContent, /Latest/);
  assert.equal(dialog.querySelectorAll('[data-slot="list-item-selected-icon"]').length, 1,
    "only the current model should carry a check");
  assert.equal(dialog.querySelector('[data-component="list"]') != null, true);
  assert.equal(dialog.querySelector('[data-slot="list-search-wrapper"]') != null, true);
  assert.equal(dialog.querySelectorAll('[role="radio"]').length, 0);
  const modelInput = dialog.querySelector('input[aria-label="Search models"]');
  const modelOptions = dialog.querySelectorAll(".model-option-row");
  assert.equal(document.activeElement === modelInput, true, "opening the model selector should focus model search");
  await act(async () => modelInput.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === modelOptions[0], true, "ArrowDown should focus the current model");
  await act(async () => modelOptions[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === modelOptions[1], true, "ArrowDown should focus the next model");
  await act(async () => modelOptions[1].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  ));
  assert.equal(document.activeElement === modelOptions[0], true, "Home should focus the first model");
  await act(async () => modelOptions[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  ));
  assert.equal(document.activeElement === modelOptions[1], true, "End should focus the last model");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(modelInput, "deepseek");
    modelInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.deepEqual(Array.from(dialog.querySelectorAll(".model-option-row strong")).map((node) => node.textContent),
    ["DeepSeek V4 Flash"]);
  modelInput.focus();
  await act(async () => modelInput.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === dialog.querySelector(".model-option-row"), true,
    "filtered navigation should focus the visible model");

  await act(async () => dialog.querySelector('button[aria-label="Clear picker search"]').click());
  assert.doesNotMatch(dialog.textContent, /GPT-Next/,
    "a full catalog refresh must not reorder or expand the open list");
  assert.equal(dialog.querySelector(".model-option-row .model-row-copy > small").textContent, "-",
    "model rows should expose the same Context/Fast description as the TUI");

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true,
    "Escape closes the model dialog");
  assert.equal(document.activeElement === trigger, true,
    "Escape should restore trigger focus");
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-list").scrollTop, 0,
    "reopening always starts at the model list top");
  assert.match(document.querySelector('[aria-label="Reasoning effort"]').textContent, /High/);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".model-option-row strong")).map((node) => node.textContent),
    ["GPT-Next", "GPT-Real", "DeepSeek V4 Flash"],
    "the refreshed catalog should be adopted on the next open",
  );
  await act(async () => {
    document.querySelector('button[aria-label="Add provider"]').click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true,
    "selector .model-picker-dialog should be absent");
  assert.equal(document.querySelector(".mixdog-settings") != null, true,
    "provider setup should deep-link to Settings > Providers");
});

test("model selector renders the persisted catalog before background refresh completes", async () => {
  installDom();
  let finishQuick;
  const quickGate = new Promise((resolve) => { finishQuick = resolve; });
  const setupRequests = [];
  window.localStorage.setItem('mixdog.desktop-model-catalog.v1', JSON.stringify({
    updatedAt: Date.now() - 60_000,
    models: [{
      provider: 'openai', model: 'gpt-cached', display: 'Cached Model',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: false, fastPreferred: false,
    }],
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [], queued: [], provider: 'openai', model: 'gpt-cached', effort: 'high',
    }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    invokeCapability: async (request) => {
      if (request.capability === 'getProviderSetup') setupRequests.push(request);
      return { value: request.capability === 'getProviderSetup'
        ? { api: [{ id: 'openai', authenticated: true }], oauth: [], local: [] }
        : request.capability === 'getOnboardingStatus' ? { completed: true } : 'basic' };
    },
    listProviderModels: async (options) => {
      if (options?.quick) await quickGate;
      return [{
        provider: 'openai', model: 'gpt-cached', display: 'Refreshed Model', effortOptions: [],
        fastCapable: false, fastPreferred: false,
      }];
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('.model-trigger')?.textContent || '', /GPT-Cached/);
  assert.match(document.querySelector('[aria-label="Reasoning effort"]')?.textContent || '', /High/);
  assert.deepEqual(setupRequests.at(-1)?.args, [], "automatic setup refresh must stay off the model critical path");
  await act(async () => {
    finishQuick();
    await quickGate;
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('.model-trigger')?.textContent || '', /GPT-Cached/);
  assert.match(window.localStorage.getItem('mixdog.desktop-model-catalog.v1') || '', /Refreshed Model/);
});

test("model selector keeps catalog failures visible inline", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], provider: "openai", model: "gpt-real" }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    invokeCapability: async ({ capability }) => ({
      value: capability === "getProviderSetup" ? {
        api: [{ id: "openai", authenticated: false, enabled: true }],
        oauth: [],
        local: [{ id: "ollama", detected: true, enabled: false }],
      } : {},
    }),
    listProviderModels: async () => { throw new Error("Authentication required"); },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => document.querySelector(".model-trigger").click());
  assert.match(document.querySelector(".model-notice--error")?.textContent || "", /Authentication required/);
  assert.equal(document.querySelectorAll(".model-group").length, 0);
  assert.match(document.querySelector(".model-empty")?.textContent || "", /No connected provider models/);
  assert.ok(document.querySelector('button[aria-label="Add provider"]'));
});

test("model selector never presents an unknown persisted route as a selectable model", async () => {
  installDom();
  const invalidRoute = {
    items: [], queued: [], provider: "openai-oauth", model: "warmup-context-regression",
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    startTask: async () => invalidRoute,
    invokeCapability: async ({ capability }) => ({
      value: capability === "getProviderSetup"
        ? { api: [], oauth: [{ id: "openai-oauth", authenticated: true }], local: [] }
        : capability === "getOnboardingStatus" ? { completed: true } : "basic",
    }),
    listProviderModels: async () => [
      { provider: "openai-oauth", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const trigger = document.querySelector(".model-trigger");
  assert.equal(trigger.textContent.includes("warmup-context-regression"), false);
  assert.match(trigger.textContent, /Select model/);
});

test("model control styles keep the reference compact geometry and bounded list", async () => {
  const [css, openCodeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./opencode-v2.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.model-picker-layer\s*\{[^}]*place-items:\s*center;/s);
  assert.match(css, /\.model-picker-dialog\s*\{[^}]*width:\s*min\(calc\(100vw - 16px\), 640px\);[^}]*height:\s*min\(calc\(100vh - 16px\), 512px\);/s);
  assert.match(css, /\.model-search\s*\{[^}]*height:\s*32px;/s);
  assert.match(css, /\.model-group button\s*\{[^}]*width:\s*100%;[^}]*display:\s*flex;/s);
  assert.match(css, /\.model-list\s*\{[^}]*overflow-y:\s*auto;/s);
  for (const selector of [".model-trigger", ".effort-control select", ".fast-control"]) {
    assert.match(css, new RegExp(`\\${selector}\\s*\\{[^}]*height:\\s*28px;`, "s"));
  }
  assert.match(openCodeCss, /\.route-controls > \.fast-control\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*40px;/s,
    "the Fast toggle must keep its compact click target");
  assert.match(openCodeCss,
    /\.route-controls > \.fast-control:hover:not\(:disabled\),[\s\S]*?\{[^}]*color:\s*var\(--oc-text\);[^}]*background:\s*var\(--oc-hover\);/s,
    "the Fast toggle must expose hover feedback");
  assert.match(openCodeCss, /\.route-controls > \.fast-control\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--oc-text\);/s);
  assert.match(openCodeCss,
    /\.model-trigger,\s*\.effort-control \.oc-select-trigger\s*\{[^}]*color:\s*var\(--oc-text\);/s,
    "model and effort labels should share the active Fast tone");
  assert.match(openCodeCss,
    /\.model-trigger\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*min\(220px,\s*100%\);[^}]*flex:\s*0 1 auto;/s,
    "the model trigger should end at its visible label instead of reserving an empty fixed slot");
  assert.match(openCodeCss,
    /\.effort-control\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 0 auto;/s,
    "the effort picker should use its full intrinsic label width beside the model");
  assert.doesNotMatch(openCodeCss, /\.effort-control \.oc-select-trigger\s*\{\s*width:\s*100%;/s);
  assert.match(openCodeCss,
    /\.oc-menu\[aria-label="Project context"\] \.oc-menu-item\s*\{[^}]*line-height:\s*20px;/s,
    "project labels need enough line height for descenders");
  assert.match(openCodeCss,
    /\.effort-control \.oc-select-trigger\s*\{[^}]*height:\s*28px;[^}]*padding:\s*0 5px 0 8px;[^}]*line-height:\s*20px;/s,
    "the effort trigger needs a full text line box inside its fixed control height");
  assert.match(openCodeCss, /\.effort-control \.oc-select-value\s*\{[^}]*line-height:\s*20px;/s);
  assert.match(openCodeCss, /\.model-picker-layer\s*\{[^}]*background:[^}]*backdrop-filter:\s*blur\(2px\);/s);
  assert.match(openCodeCss, /\.model-provider-add\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*background:\s*transparent;/s);
  assert.match(openCodeCss, /\.model-picker-header\s*\{[^}]*padding:\s*16px 12px 16px 20px;/s);
  assert.match(openCodeCss, /\.model-provider-add\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(openCodeCss, /\.model-picker-dialog\s*\{[^}]*width:\s*min\(calc\(100vw - 16px\), 640px\);[^}]*height:\s*min\(calc\(100vh - 16px\), 512px\);/s,
    "the centered dialog should use the reference dialog container geometry");
  assert.match(openCodeCss, /\.model-picker-dialog\s*\{[^}]*border-radius:\s*10px;/s,
    "the model dialog should use the reference --radius-xl value");
  assert.match(openCodeCss,
    /\.model-option-row\s*\{[^}]*min-height:\s*48px;[^}]*padding:\s*6px 8px;/s,
    "model rows should leave room for stable secondary metadata");
  assert.match(openCodeCss, /\.model-row-copy\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s);
  assert.match(openCodeCss, /\.model-row-copy > small\s*\{[^}]*color:\s*var\(--oc-text-faint\);[^}]*font-size:\s*11px;/s);
  assert.match(openCodeCss, /\.model-provider-add\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
  assert.doesNotMatch(openCodeCss, /\.model-provider-row|\.model-provider-chevron|\.model-list-heading/);
  assert.match(openCodeCss, /\.model-row-copy strong\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;/s);
  assert.doesNotMatch(openCodeCss, /\.model-tag\s*\{/);
  assert.match(openCodeCss, /\.model-provider-setup\s*\{[^}]*height:\s*20px;/s);
  assert.match(openCodeCss, /\.model-notice\s*\{[^}]*padding:\s*7px 9px;[^}]*line-height:\s*16px;/s);
  assert.match(openCodeCss, /\.composer-region\s*\{[^}]*padding:\s*0 12px 8px;/s,
    "the composer should sit close to the workspace bottom edge");
  assert.match(openCodeCss, /\.composer\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*var\(--oc-bg-base\);[^}]*box-shadow:\s*var\(--oc-raised\);/s,
    "the composer should use the solid OpenCode v2 base and its subtle raised elevation");
});

test("model selection applies the secure route result, hides unrelated effort, and recovers from errors", async () => {
  installDom();
  const calls = [];
  let reject = true;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], provider: "openai", model: "gpt-real", effort: "high" }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [{ value: "high", label: "High" }] },
      { provider: "anthropic", model: "claude-real", display: "Claude Real", effortOptions: [] },
    ],
    setModelRoute: async (selection) => {
      calls.push(selection);
      if (reject) {
        reject = false;
        throw new Error("Route IPC failed");
      }
      return { items: [], queued: [], provider: selection.provider, model: selection.model, effort: selection.effort };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => document.querySelector(".model-trigger").click());
  await act(async () => {
    Array.from(document.querySelectorAll(".model-option-row"))
      .find((option) => option.textContent.includes("Claude Real")).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [{ provider: "anthropic", model: "claude-real" }]);
  assert.match(document.querySelector(".inline-error").textContent, /Route IPC failed/);
  assert.equal(document.querySelector(".model-trigger").disabled, false);
  await act(async () => document.querySelector(".model-trigger").click());
  assert.equal(document.querySelector(".model-group--recent") === null, true,
    "a failed route must not be persisted as a recent selection");
  assert.equal(document.querySelector('[aria-label="Reasoning effort"]') != null, true, "selector [aria-label=\"Reasoning effort\"] should be present");
  await act(async () => {
    Array.from(document.querySelectorAll(".model-option-row"))
      .find((option) => option.textContent.includes("Claude Real")).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".model-trigger").textContent, /Claude Real/);
  assert.equal(document.querySelector(".model-trigger .provider-icon") === null, true,
    "routed models should remain text-only in the composer");
  assert.equal(document.activeElement === document.querySelector(".model-trigger"), true, "successful model selection should restore trigger focus");
  assert.equal(document.querySelector(".inline-error") === null, true, "selector .inline-error should be absent");
  await act(async () => document.querySelector(".model-trigger").click());
  assert.match(document.querySelector(".model-group--recent")?.textContent || "", /Claude Real/);
  assert.equal(document.querySelector('[aria-label="Reasoning effort"]') === null, true, "selector [aria-label=\"Reasoning effort\"] should be absent");
});

test("successful effort selection uses the dedicated capability and restores focus", async () => {
  installDom();
  const calls = [];
  const low = { items: [], queued: [], provider: "openai", model: "gpt-real", effort: "low" };
  window.mixdogDesktop = {
    getSnapshot: async () => low,
    subscribeState: () => () => {},
    listSessions: async () => [],
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [
        { value: "low", label: "Low" }, { value: "high", label: "High" },
      ] },
    ],
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: request.args[0], snapshot: { ...low, effort: request.args[0] } };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const trigger = document.querySelector(".model-trigger");
  const effort = document.querySelector('[aria-label="Reasoning effort"]');
  await act(async () => effort.click());
  const high = Array.from(document.querySelectorAll('.oc-menu [role="option"]'))
    .find((option) => option.textContent.includes("High"));
  await act(async () => {
    high.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "selector .model-picker-dialog should be absent");
  assert.deepEqual(calls.filter((request) => request.capability !== "getTheme" &&
    request.capability !== "getOnboardingStatus" && request.capability !== "getProviderSetup" &&
    request.capability !== "listWorkflows"),
    [{ capability: "setEffort", args: ["high"] }]);
  assert.equal(document.activeElement === effort, true, "effort selection should restore effort-control focus");
  assert.match(effort.textContent, /High/);
});

test("Fast follows core capability and disables tuning while a turn is busy", async () => {
  installDom();
  let publish;
  const calls = [];
  const idle = {
    items: [], queued: [], provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [],
    startTask: async () => idle,
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
    setFast: async (enabled) => {
      calls.push(enabled);
      return { ...idle, fast: enabled };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const fast = document.querySelector('[aria-label="Fast mode"]');
  assert.equal(fast != null, true, "Fast control should be present for a capable model");
  assert.equal(fast.getAttribute("aria-pressed"), "false");
  assert.equal(fast.textContent.trim(), "Fast Off");
  await act(async () => {
    fast.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true]);
  assert.equal(fast.getAttribute("aria-pressed"), "true");
  assert.equal(fast.textContent.trim(), "Fast On");
  await act(async () => publish({ ...idle, busy: true }));
  assert.equal(fast.disabled, true);
  assert.equal(document.querySelector(".model-trigger").disabled, false,
    "model selection remains available as the next-session route while a turn is busy");
  await act(async () => {
    publish({ ...idle, fast: true });
    await Promise.resolve();
  });
  assert.equal(document.activeElement === fast, true,
    "Fast focus should return after busy controls re-enable");
  await act(async () => {
    fast.click();
    await Promise.resolve();
    publish({ ...idle, busy: true, fast: true });
  });
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  await act(async () => {
    publish({ ...idle, fast: true });
    await Promise.resolve();
  });
  assert.equal(document.activeElement === elsewhere, true,
    "re-enabling Fast must not steal focus the user moved elsewhere while busy");
  elsewhere.remove();
  await act(async () => publish({ ...idle, fastCapable: false }));
  assert.equal(document.querySelector('.fast-control') === null, true, "selector .fast-control should be absent");
});

test("Fast recovers from a rejected toggle and can be retried", async () => {
  installDom();
  const calls = [];
  const idle = {
    items: [], queued: [], provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  let reject = true;
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: () => () => {},
    listSessions: async () => [],
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
    setFast: async (enabled) => {
      calls.push(enabled);
      if (reject) {
        reject = false;
        throw new Error("Fast preference was not applied");
      }
      return { ...idle, fast: enabled };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  const fast = document.querySelector('[aria-label="Fast mode"]');
  await act(async () => {
    fast.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true]);
  assert.equal(fast.disabled, false);
  assert.equal(fast.getAttribute("aria-pressed"), "false");
  assert.match(document.querySelector(".inline-error")?.textContent || "", /Fast preference was not applied/);

  await act(async () => {
    fast.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true, true]);
  assert.equal(fast.disabled, false);
  assert.equal(fast.getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector(".inline-error") === null, true, "selector .inline-error should be absent");
});

test("Fast reflects the click before route persistence completes", async () => {
  installDom();
  const calls = [];
  let finishFast;
  const idle = {
    items: [], queued: [], provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: () => () => {},
    listSessions: async () => [],
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
    setFast: (enabled) => {
      calls.push(enabled);
      return new Promise((resolve) => {
        finishFast = () => resolve({ ...idle, fast: enabled });
      });
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const fast = document.querySelector('[aria-label="Fast mode"]');
  await act(async () => {
    fast.click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true]);
  assert.equal(fast.getAttribute("aria-pressed"), "true");
  assert.equal(fast.textContent.trim(), "Fast On");
  assert.equal(fast.disabled, true);
  await act(async () => {
    finishFast();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(fast.disabled, false);
  assert.equal(fast.getAttribute("aria-pressed"), "true");
});

test("live engine activity and completion or compaction rows preserve runtime status", async () => {
  installDom();
  let publish;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [],
    startTask: async () => ({ items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
  });
  await act(async () => publish({
    busy: true,
    thinking: "real provider reasoning",
    spinner: { mode: "thinking", verb: "Reasoning" },
    items: [],
    queued: [],
  }));
  assert.equal(document.querySelector(".live-activity-status")?.textContent, "Thinking");
  assert.equal(document.querySelector(".session-progress") === null, true,
    "busy sessions should not add an animated header border");
  assert.equal(document.querySelector(".session-spinner") === null, true,
    "busy sessions should not add a rotating header icon");
  assert.equal(document.querySelector(".thinking-disclosure") === null, true, "selector .thinking-disclosure should be absent");
  await act(async () => publish({
    busy: true,
    thinking: null,
    spinner: { mode: "reconnecting", verb: "Retrying in 2s (attempt 3)" },
    items: [],
    queued: [],
  }));
  assert.equal(document.querySelector(".live-activity-status")?.textContent, "Retrying in 2s (attempt 3)");
  await act(async () => publish({
    busy: true,
    thinking: { publicSummary: "Public reasoning summary", reasoning: "private reasoning" },
    spinner: { mode: "thinking", verb: "Reasoning" },
    items: [],
    queued: [],
  }));
  const reasoning = document.querySelector(".thinking-disclosure");
  assert.equal(reasoning?.open, false);
  assert.equal(reasoning?.querySelector("summary")?.textContent, "View reasoning");
  assert.equal(reasoning?.querySelector("pre")?.textContent, "Public reasoning summary");
  assert.equal(document.body.textContent?.includes("private reasoning"), false);
  await act(async () => publish({
    busy: false,
    thinking: null,
    spinner: null,
    items: [
      { id: "compact-manual", kind: "statusdone", label: "Compact complete", detail: "12k → 4k" },
      { id: "compact-reactive", kind: "statusdone", label: "Compact complete (overflow recovery)", detail: "overflow recovered" },
      { id: "other-success", kind: "statusdone", label: "Index complete", detail: "must stay hidden" },
      { id: "done", kind: "turndone", status: "done" },
    ],
    queued: [],
  }));
  assert.equal(document.querySelector(".live-activity") === null, true, "selector .live-activity should be absent");
  const compactRows = document.querySelectorAll(".compaction-divider");
  assert.equal(compactRows.length, 2);
  assert.match(compactRows[0].textContent || "", /Compact complete.*12k → 4k/);
  assert.match(compactRows[1].textContent || "", /overflow recovery.*overflow recovered/);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".turn-status.complete")).map((row) => row.textContent?.trim()),
    ["Index complete· must stay hidden", "Thought"],
  );
});

test("desktop session sidebar resizes accessibly, releases its rail when collapsed, and restores it", async () => {
  const [baseCss, openCodeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./opencode-v2.css", import.meta.url), "utf8"),
  ]);
  assert.match(baseCss,
    /\.sidebar-collapsed \.sidebar\s*\{[^}]*width:\s*0;[^}]*flex-basis:\s*0;[^}]*padding-inline:\s*0;/s);
  assert.match(openCodeCss,
    /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*var\(--session-sidebar-width,\s*260px\);[^}]*flex:\s*0 0 var\(--session-sidebar-width,\s*260px\);[^}]*padding:\s*8px;/s);
  assert.match(openCodeCss,
    /\.sidebar-collapsed \.sidebar\.session-sidebar\s*\{[^}]*width:\s*0;[^}]*flex:\s*0 0 0px;[^}]*flex-basis:\s*0px;/s);
  assert.match(openCodeCss, /\.titlebar-leading\s*\{[^}]*height:\s*28px;[^}]*gap:\s*6px;[^}]*margin-right:\s*0;/s);
  assert.match(openCodeCss, /\.topbar\s*\{[^}]*padding:\s*8px 12px 0 16px;/s);
  assert.match(openCodeCss, /\.workspace-tabs\s*\{[^}]*height:\s*28px;[^}]*gap:\s*13\.5px;[^}]*padding:\s*0;/s);
  assert.match(openCodeCss,
    /\.workspace-tab\s*\{[^}]*width:\s*224px;[^}]*height:\s*28px;[^}]*min-width:\s*96px;[^}]*max-width:\s*224px;[^}]*flex:\s*1 1 224px;/s);
  assert.match(openCodeCss,
    /\.workspace-tab-main > svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*flex:\s*0 0 14px;/s);
  assert.match(openCodeCss, /\.transcript\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(openCodeCss, /\.desktop-body\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*8px;/s);
  assert.match(openCodeCss, /\.sidebar-collapsed \.desktop-body\s*\{[^}]*gap:\s*0;/s);
  assert.match(openCodeCss, /\.session-header\s*\{[^}]*border-bottom:\s*0;/s);
  assert.match(openCodeCss, /\.session-header-content\s*\{[^}]*padding:\s*12px;/s);
  assert.match(openCodeCss, /\.session-header h1\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*21px;/s);
  assert.match(openCodeCss, /\.thread\s*\{[^}]*padding:\s*20px 12px 16px;/s);
  assert.match(openCodeCss, /\.composer-region\s*\{[^}]*padding:\s*0 12px 8px;/s);
  assert.match(openCodeCss, /\.toolbar-sidebar\s*\{[^}]*width:\s*36px;/s);
  assert.match(openCodeCss, /\.session-sidebar-footer button\s*\{[^}]*height:\s*28px;/s);
  assert.doesNotMatch(openCodeCss, /\.workspace-tab-divider\s*\{/);
  assert.match(openCodeCss,
    /\.workspace-tab:not\(:first-child\):not\(\.active\)::before\s*\{[^}]*width:\s*1\.5px;[^}]*height:\s*12px;/s);
  assert.match(openCodeCss,
    /\.session-row-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*2px;[^}]*background:\s*transparent;/s);
  assert.match(openCodeCss,
    /\.session-row:hover \.session-row-actions,[\s\S]*?\{[^}]*background:\s*linear-gradient\([\s\S]*?transparent 0,[\s\S]*?var\(--session-row-action-surface\) 10px,[\s\S]*?var\(--session-row-action-surface\) 100%[\s\S]*?\);[^}]*pointer-events:\s*auto;/s);
  assert.match(openCodeCss,
    /\.session-row\.selected \.session-row-action,/s);
  assert.match(openCodeCss,
    /\.session-row\.selected \.session-row-actions,/s);
  assert.match(openCodeCss,
    /\.session-sidebar \.session-row:hover\s*\{[^}]*--session-row-action-surface:\s*var\(--oc-bg-layer-1\);/s);
  assert.match(openCodeCss,
    /\.session-sidebar \.session-row\.selected\s*\{[^}]*--session-row-action-surface:\s*var\(--oc-bg-layer-2\);/s);
  assert.doesNotMatch(openCodeCss, /\.session-row-actions::before/);
  assert.match(openCodeCss,
    /\.session-row-action\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
  assert.match(openCodeCss,
    /\.session-row-icon\s*\{[^}]*flex:\s*0 0 13px;[^}]*margin:\s*0 2\.5px;/s);
  assert.match(openCodeCss,
    /\.workspace-tabs-shell\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*flex:\s*1 1 0;[^}]*-webkit-app-region:\s*drag;/s);
  assert.match(openCodeCss,
    /\.workspace-tab\s*\{[^}]*min-width:\s*96px;[^}]*max-width:\s*224px;[^}]*flex:\s*1 1 224px;/s);
  assert.match(openCodeCss,
    /\.titlebar-update-shell\s*\{[^}]*width:\s*20px;[^}]*flex:\s*0 0 20px;/s);
  assert.match(openCodeCss,
    /\.titlebar-update:hover, \.titlebar-update:focus-visible\s*\{[^}]*width:\s*68px;/s);
  assert.match(openCodeCss,
    /\.titlebar-update-label\s*\{[^}]*max-width:\s*0;[^}]*opacity:\s*0;/s);
  assert.match(openCodeCss, /\.workspace-tabs-fade-left\s*\{[^}]*animation-timeline:\s*--workspace-tabs-scroll;/s);

  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
  };
  window.localStorage.setItem("mixdog:session-sidebar-width", "286");
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const sidebar = document.querySelector(".sidebar");
  const shell = sidebar?.closest(".app-shell");
  const toggle = document.querySelector(".toolbar-sidebar");
  assert.equal(sidebar != null, true, "selector .sidebar should be present");
  assert.equal(shell != null, true, "the sidebar should belong to the app shell");
  assert.equal(toggle != null, true, "selector .toolbar-sidebar should be present");
  assert.equal(document.querySelector(".session-search"), null,
    "selector .session-search should be absent");
  const resize = document.querySelector('[role="separator"][aria-label="Resize session sidebar"]');
  assert.ok(resize);
  assert.equal(resize.getAttribute("aria-valuenow"), "260");
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true, button: 0, clientX: 260,
  })));
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointermove", {
    bubbles: true, clientX: 300,
  })));
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true })));
  assert.equal(resize.getAttribute("aria-valuenow"), "300");
  assert.equal(sidebar.style.getPropertyValue("--session-sidebar-width"), "300px");
  assert.equal(window.localStorage.getItem("mixdog:session-sidebar-width"), "300");
  await act(async () => resize.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  ));
  assert.equal(resize.getAttribute("aria-valuenow"), "420");
  await act(async () => resize.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
  assert.equal(resize.getAttribute("aria-valuenow"), "260");
  assert.equal(shell?.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle?.getAttribute("aria-label"), "Collapse session sidebar");
  assert.equal(document.querySelector(".titlebar-home") === null, true, "selector .titlebar-home should be absent");
  assert.equal(document.querySelector(".topbar-settings") === null, true, "selector .topbar-settings should be absent");
  await act(async () => toggle?.click());
  assert.equal(shell?.classList.contains("sidebar-collapsed"), true);
  assert.equal(sidebar?.getAttribute("aria-hidden"), "true");
  assert.equal(toggle?.getAttribute("aria-label"), "Expand session sidebar");
  await act(async () => toggle?.click());
  assert.equal(shell?.classList.contains("sidebar-collapsed"), false);
  assert.equal(sidebar?.getAttribute("aria-hidden"), "false");
  assert.equal(toggle?.getAttribute("aria-label"), "Collapse session sidebar");
});

test("workspace tabs reveal the active tab and handle scoped tab commands", async () => {
  installDom();
  const selected = [];
  const closed = [];
  const reordered = [];
  let newTasks = 0;
  const scrolled = [];
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value() { scrolled.push(this); },
    configurable: true,
  });
  const tabs = [
    { key: "one", title: "One", selection: { kind: "new" } },
    { key: "two", title: "Two", selection: { kind: "session", id: "two" } },
  ];
  const props = {
    sidebarOpen: true,
    tabs,
    activeKey: "one",
    onToggleSidebar() {},
    onSelectTab(tab) { selected.push(tab.key); },
    onCloseTab(tab) { closed.push(tab.key); },
    onReorderTab(sourceKey, targetKey) { reordered.push([sourceKey, targetKey]); },
    onNewTask() { newTasks += 1; },
  };
  await act(async () => root.render(React.createElement(DesktopTitlebar, props)));
  await act(async () => root.render(React.createElement(DesktopTitlebar, {
    ...props,
    activeKey: "two",
    activeBusy: true,
  })));
  assert.equal(scrolled.at(-1)?.textContent.includes("Two"), true);
  assert.equal(document.querySelectorAll('.workspace-tab[data-working="true"]').length, 1);
  assert.equal(document.querySelector('.workspace-tab[data-working="true"]')?.textContent.includes("Two"), true);
  assert.equal(document.querySelector('.workspace-tab-status')?.getAttribute("aria-label"), "Two is working");
  assert.equal(document.querySelector('.workspace-tab-divider'), null);
  const strip = document.querySelector(".workspace-tabs");
  await act(async () => strip.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }),
  ));
  await act(async () => strip.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }),
  ));
  await act(async () => strip.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, altKey: true, bubbles: true }),
  ));
  await act(async () => root.render(React.createElement(DesktopTitlebar, { ...props, activeKey: "one" })));
  const updatedStrip = document.querySelector(".workspace-tabs");
  await act(async () => updatedStrip.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, altKey: true, bubbles: true }),
  ));
  await act(async () => updatedStrip.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }),
  ));
  const [firstTab, secondTab] = document.querySelectorAll(".workspace-tab");
  const normalCapture = [];
  secondTab.setPointerCapture = (pointerId) => normalCapture.push(pointerId);
  await act(async () => {
    secondTab.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true, button: 0, clientX: 10,
    }));
    secondTab.dispatchEvent(new window.MouseEvent("pointerup", {
      bubbles: true, button: 0, clientX: 10,
    }));
    secondTab.querySelector(".workspace-tab-main").click();
  });
  assert.deepEqual(normalCapture, [], "an ordinary tab click must not capture the pointer");
  const dragCapture = [];
  firstTab.setPointerCapture = (pointerId) => dragCapture.push(pointerId);
  await act(async () => {
    firstTab.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true, button: 0, clientX: 0,
    }));
    assert.deepEqual(dragCapture, []);
    secondTab.dispatchEvent(new window.MouseEvent("pointermove", {
      bubbles: true, button: 0, clientX: 10,
    }));
    secondTab.dispatchEvent(new window.MouseEvent("pointerup", {
      bubbles: true, button: 0, clientX: 10,
    }));
  });
  assert.deepEqual(dragCapture, [1], "pointer capture should begin only after the drag threshold");
  assert.equal(newTasks, 1);
  assert.deepEqual(closed, ["two"]);
  assert.deepEqual(selected, ["one", "two", "one", "two"]);
  assert.deepEqual(reordered, [["one", "two"]]);
  assert.equal(document.querySelector(".titlebar-new"), null,
    "the active draft tab already represents the new-task action");
  await act(async () => root.render(React.createElement(DesktopTitlebar, {
    ...props,
    activeKey: "two",
    updaterState: { status: "ready", version: "2.0.0" },
  })));
  assert.equal(document.querySelector(".workspace-tabs-shell")?.nextElementSibling?.classList.contains("titlebar-new"), true);
  assert.equal(document.querySelector(".titlebar-update")?.getAttribute("aria-label"), "Install Mixdog 2.0.0");
  assert.equal(document.querySelector(".titlebar-update-shell")?.previousElementSibling?.classList.contains(
    "titlebar-new"), true);
});

test("model selector remains available for a next-session route during turn busy and closes for commandBusy", async () => {
  installDom();
  let publish;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], provider: "openai", model: "gpt-real" }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [],
    startTask: async () => ({ items: [], queued: [], provider: "openai", model: "gpt-real" }),
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".task-link").click();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const trigger = document.querySelector(".model-trigger");
  trigger.focus();
  await act(async () => trigger.click());
  assert.equal(document.activeElement === trigger, false, "opening the model selector should move focus from its trigger");
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "Escape should close the model selector");
  assert.equal(document.activeElement === trigger, true, "Escape should restore model-trigger focus");
  await act(async () => trigger.click());
  const textarea = document.querySelector("textarea");
  await act(async () => {
    textarea.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    textarea.focus();
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "outside pointer interaction should close the model selector");
  assert.equal(document.activeElement === textarea, true, "outside pointer interaction should preserve composer focus");
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-picker-dialog") != null, true, "selector .model-picker-dialog should be present");
  await act(async () => publish({ items: [], queued: [], busy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-picker-dialog") != null, true, "turn busy keeps next-session model routing available");
  assert.equal(trigger.disabled, false);
  await act(async () => publish({ items: [], queued: [], busy: false, provider: "openai", model: "gpt-real" }));
  assert.equal(trigger.disabled, false);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-picker-dialog") != null, true, "selector .model-picker-dialog should be present");
  await act(async () => publish({ items: [], queued: [], commandBusy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "command-busy state should close the model selector");
  assert.equal(trigger.disabled, true);
});

test("desktop composer restores queued work, recalls engine history, and executes slash capabilities", async () => {
  installDom();
  const capabilities = [];
  const snapshot = {
    items: [],
    queued: [{ id: 'queued-1', displayText: 'Queued request' }],
    promptHistoryList: ['Previous engine prompt'],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [{
      id: 'session-1', title: 'Capability session', preview: 'Capability session', updatedAt: Date.now(),
      cwd: 'C:\\workspace', classification: 'task', projectPath: null, currentSession: true,
    }],
    resumeSession: async () => snapshot,
    subscribeState: () => () => {},
    invokeCapability: async ({ capability, args = [] }) => {
      capabilities.push([capability, args]);
      if (capability === 'getTheme') return { value: 'basic', snapshot };
      if (capability === 'restoreQueued') {
        return { value: { text: 'Restored request', pastedImages: null, pastedTexts: null }, snapshot: { ...snapshot, queued: [] } };
      }
      return { value: true, snapshot };
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.session-row').click();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  assert.equal(document.querySelector('[aria-label="Prompt history"]') === null, true, "selector [aria-label=\"Prompt history\"] should be absent");
  assert.deepEqual(
    Array.from(document.querySelectorAll('.composer-footer > .composer-tool')).map((button) => button.getAttribute('aria-label')),
    ['Attach files'],
  );
  const queueSummary = document.querySelector('.queue-summary');
  assert.equal(queueSummary?.textContent?.includes('1 queued follow-up'), true);
  assert.equal(queueSummary?.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.queue-item-text')?.textContent, 'Queued request');
  assert.equal(document.querySelector('.queue-item small')?.textContent, 'Next boundary');
  await act(async () => {
    queueSummary.click();
  });
  assert.equal(queueSummary.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.queue-list [role="listitem"]') === null, true,
    "selector .queue-list [role=\"listitem\"] should be absent");
  await act(async () => {
    queueSummary.click();
  });
  await act(async () => {
    document.querySelector('.queue-edit').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(textarea.value, 'Restored request');
  assert.ok(capabilities.some(([capability, args]) =>
    capability === 'restoreQueued' && args[0] === '' && args[1] === 'queued-1'));

  await act(async () => {
    textarea.value = '';
    textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  });
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  });
  assert.equal(textarea.value, 'Previous engine prompt');

  await act(async () => {
    textarea.value = '/compact';
    textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/compact' }));
  });
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(capabilities.some(([capability]) => capability === 'restoreQueued'));
  assert.ok(capabilities.some(([capability]) => capability === 'compact'));
  assert.equal(textarea.value, '');
});

test("composer separates turn and command activity, mirrors TUI slash acceptance, and ignores IME navigation", async () => {
  installDom();
  let slashScrolls = 0;
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    value() { slashScrolls += 1; },
    configurable: true,
  });
  let publish;
  let aborts = 0;
  let rejectCompact = false;
  const capabilities = [];
  const submissions = [];
  const idle = {
    items: [], queued: [], promptHistoryList: [], provider: 'openai', model: 'gpt-real',
  };
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [],
    startTask: async () => idle,
    submit: async (content, options) => { submissions.push([content, options]); return true; },
    abort: async () => { aborts += 1; return { aborted: true }; },
    invokeCapability: async ({ capability, args = [] }) => {
      capabilities.push([capability, args]);
      if (capability === 'compact' && rejectCompact) throw new Error('compact failed');
      if (capability === 'restoreQueued') {
        return {
          value: { text: 'Restored steering', pastedImages: null, pastedTexts: null },
          snapshot: { ...idle, busy: true, queued: [] },
        };
      }
      if (capability === 'getTheme') return { value: 'basic', snapshot: idle };
      if (capability === 'listThemes') return { value: [{ id: 'basic', label: 'Basic' }], snapshot: idle };
      if (capability === 'getOutputStyle') {
        return { value: { current: { id: 'default', label: 'Default' }, configured: 'default' }, snapshot: idle };
      }
      if (capability === 'getAutoClear') return { value: { enabled: true, idleMs: 3_600_000 }, snapshot: idle };
      return { value: true, snapshot: idle };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.task-link').click();
    await Promise.resolve();
  });
  const getTextarea = () => document.querySelector('textarea[aria-label="Message Mixdog"]');
  const replaceDraft = async (value) => {
    await act(async () => {
      const textarea = getTextarea();
      textarea.focus();
      textarea.value = value;
      textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    });
  };
  const press = async (key, properties = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...properties });
    await act(async () => {
      getTextarea().dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    return event;
  };

  await act(async () => publish({ ...idle, commandBusy: true }));
  await replaceDraft('/compact');
  await press('Enter');
  assert.equal(capabilities.some(([capability]) => capability === 'compact'), false);
  assert.equal(getTextarea().value, '/compact');
  assert.match(document.querySelector('.composer-error')?.textContent || '', /current command.*editor/i);
  assert.equal(document.querySelector('.send-button.stop') === null, true, "selector .send-button.stop should be absent");
  assert.equal(getTextarea().placeholder, 'Queue a message after the current command…');
  assert.doesNotMatch(document.querySelector('.send-button')?.getAttribute('aria-label') || '', /steer/i);

  await replaceDraft('');
  await press('Escape');
  assert.equal(aborts, 0);

  await replaceDraft('queued while command runs');
  await press('Enter');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'queued while command runs');
  assert.equal('priority' in submissions[0][1], false);

  await act(async () => publish({ ...idle, commandBusy: false }));
  await replaceDraft('/');
  const paletteOptions = document.querySelectorAll('.slash-palette [role="option"]');
  assert.equal(paletteOptions.length, 10);
  assert.ok(slashScrolls > 0);
  const initiallySelected = document.querySelector('.slash-palette [aria-selected="true"]')?.textContent;
  for (let index = 0; index < 10; index += 1) await press('ArrowDown');
  assert.equal(document.querySelector('.slash-palette [aria-selected="true"]')?.textContent, initiallySelected);

  await replaceDraft('/co');
  const imeArrow = await press('ArrowDown', { isComposing: true });
  const imeEnter = await press('Enter', { isComposing: true });
  assert.equal(imeArrow.defaultPrevented, false);
  assert.equal(imeEnter.defaultPrevented, false);
  assert.equal(getTextarea().value, '/co');
  assert.equal(capabilities.some(([capability]) => capability === 'compact'), false);

  await press('Escape');
  assert.equal(getTextarea().value, '', 'Escape closes the slash palette and clears its draft like the TUI');

  await replaceDraft('alpha\nbeta');
  getTextarea().setSelectionRange(getTextarea().value.length, getTextarea().value.length);
  await press('u', { ctrlKey: true });
  assert.equal(getTextarea().value, 'alpha\n');
  await press('j', { ctrlKey: true });
  assert.equal(getTextarea().value, 'alpha\n\n');

  await press('Tab');
  assert.equal(getTextarea().value, 'alpha\n\n');
  await replaceDraft('/co');
  await press('Tab');
  assert.equal(getTextarea().value, '/compact ');
  assert.equal(document.querySelector('.slash-palette') === null, true, "selector .slash-palette should be absent");

  await replaceDraft('/co');
  rejectCompact = true;
  await press('Enter');
  assert.equal(getTextarea().value, '/co');
  assert.match(document.querySelector('.inline-error')?.textContent || '', /compact failed/);
  rejectCompact = false;
  await press('Enter');
  assert.equal(getTextarea().value, '');
  assert.equal(capabilities.filter(([capability]) => capability === 'compact').length, 2);

  await replaceDraft('/theme status');
  await press('Enter');
  assert.match(document.querySelector('.composer-notice')?.textContent || '', /Theme: Basic/);
  await replaceDraft('/OutputStyle status');
  await press('Enter');
  assert.match(document.querySelector('.composer-notice')?.textContent || '', /Output style: Default/);
  await replaceDraft('/autoclear status');
  await press('Enter');
  assert.match(document.querySelector('.composer-notice')?.textContent || '', /Auto-clear on · idle 1h/);

  await act(async () => publish({
    ...idle,
    busy: true,
    queued: [{ id: 'steer-1', displayText: 'Queued steering' }],
  }));
  assert.equal(document.querySelector('.send-button.stop') != null, true, "selector .send-button.stop should be present");
  assert.equal(document.querySelector('.queue-priority') === null, true, "selector .queue-priority should be absent");
  assert.equal(getTextarea().placeholder, 'Steer the active turn or queue a follow-up…');
  assert.equal(document.querySelector('.queue-item-text')?.textContent, 'Queued steering');
  assert.equal(document.querySelector('.queue-item small')?.textContent, 'Next boundary');
  await replaceDraft('/compact');
  await press('Enter');
  assert.equal(capabilities.filter(([capability]) => capability === 'compact').length, 2);
  assert.equal(getTextarea().value, '/compact');
  assert.match(document.querySelector('.composer-error')?.textContent || '', /current turn.*\/compact/i);
  await replaceDraft('');
  await press('Escape');
  assert.equal(aborts, 1);
  assert.equal(getTextarea().value, '');
  assert.equal(capabilities.filter(([capability]) => capability === 'restoreQueued').length, 0);
  await act(async () => publish({
    ...idle,
    busy: false,
    queued: [{ id: 'steer-1', displayText: 'Queued steering' }],
  }));
  await press('ArrowUp');
  assert.equal(getTextarea().value, 'Restored steering');
  await press('Escape');
  assert.equal(getTextarea().value, '');
  assert.equal(aborts, 1);
});

test("desktop composer folds large pasted text and submits the expanded attachment contract", async () => {
  installDom();
  const submissions = [];
  const snapshot = { items: [], queued: [], promptHistoryList: [] };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [{
      id: 'session-attachment', title: 'Attachment session', preview: 'Attachment session', updatedAt: Date.now(),
      cwd: 'C:\\workspace', classification: 'task', projectPath: null, currentSession: true,
    }],
    resumeSession: async () => snapshot,
    subscribeState: () => () => {},
    invokeCapability: async ({ capability }) => ({ value: capability === 'getTheme' ? 'basic' : null, snapshot }),
    submit: async (content, options) => { submissions.push([content, options]); return true; },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.session-row').click();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const pasted = 'first line\nsecond line\nthird line\nfourth line';
  await act(async () => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], getData: (type) => type === 'text/plain' ? pasted : '' },
    });
    textarea.dispatchEvent(event);
  });
  assert.match(textarea.value, /\[Pasted text #1 \+4 lines\]/);
  assert.match(document.querySelector('.composer-attachments').textContent, /Pasted text/);
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(submissions.length, 1);
  assert.match(String(submissions[0][0]), /first line[\s\S]*fourth line/);
  assert.doesNotMatch(String(submissions[0][0]), /<file name=/);
  assert.equal('priority' in submissions[0][1], false);
  assert.equal(submissions[0][1].pastedTexts['1'].text, pasted);
});

test("desktop composer accepts clipboard images exposed through DataTransfer items", async () => {
  installDom();
  const snapshot = { items: [], queued: [], promptHistoryList: [] };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [],
    subscribeState: () => () => {},
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const image = new window.File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' });
  await act(async () => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        getData: () => '',
      },
    });
    textarea.dispatchEvent(event);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.match(textarea.value, /\[Image #1: clipboard\.png\]/);
  assert.equal(document.querySelectorAll('.composer-attachments img').length, 1);
  assert.match(document.querySelector('.composer-attachments')?.textContent || '', /clipboard\.png/);
});

test("desktop composer searches, cancels stale @ file mentions, selects by keyboard, and submits the path", async () => {
  installDom();
  const project = 'C:\\workspace\\mention';
  const searches = [];
  const pending = new Map();
  const submissions = [];
  const snapshot = {
    currentProject: project, items: [], queued: [], promptHistoryList: [],
    provider: 'openai', model: 'gpt-real',
  };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listProjects: async () => [{ path: project, alias: 'Mention', pinned: false }],
    listSessions: async () => [],
    subscribeState: () => () => {},
    startProject: async () => snapshot,
    listProviderModels: async () => [{
      provider: 'openai', model: 'gpt-real', display: 'GPT Real', effortOptions: [],
    }],
    searchProjectFiles: (scope, query, limit) => {
      searches.push([scope, query, limit]);
      return new Promise((resolve) => pending.set(query, resolve));
    },
    submit: async (content, options) => { submissions.push([content, options]); return true; },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  await selectFirstProject();
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const replaceDraft = async (value) => {
    await act(async () => {
      textarea.focus();
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    });
  };
  const waitForSearch = async () => {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 140)));
  };

  await replaceDraft('Review @src');
  await waitForSearch();
  assert.deepEqual(searches, [[project, 'src', 20]]);
  assert.equal(document.querySelector('.mention-palette')?.getAttribute('aria-label'), 'Project files');
  assert.match(document.querySelector('.mention-palette')?.textContent || '', /Searching project files/);

  await replaceDraft('Review @test');
  await waitForSearch();
  assert.deepEqual(searches, [[project, 'src', 20], [project, 'test', 20]]);
  await act(async () => pending.get('test')(['test/first.mjs', 'test/renderer.dom.test.mjs']));
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mention-palette [role="option"]')).map((option) => option.title),
    ['test/first.mjs', 'test/renderer.dom.test.mjs'],
  );
  await act(async () => pending.get('src')(['src/stale.ts']));
  assert.equal(document.querySelector('.mention-palette')?.textContent.includes('stale.ts'), false);

  const imeEscape = new window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true, isComposing: true,
  });
  const imeTab = new window.KeyboardEvent('keydown', {
    key: 'Tab', bubbles: true, cancelable: true, isComposing: true,
  });
  await act(async () => {
    textarea.dispatchEvent(imeEscape);
    textarea.dispatchEvent(imeTab);
  });
  assert.equal(imeEscape.defaultPrevented, false);
  assert.equal(imeTab.defaultPrevented, false);
  assert.equal(textarea.value, 'Review @test');
  assert.equal(document.querySelector('.mention-palette [aria-selected="true"]')?.title, 'test/first.mjs');

  await act(async () => {
    document.querySelector('.model-trigger').click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector('.model-picker-dialog') != null, true, "model picker should open");
  assert.equal(document.querySelector('.mention-palette') === null, true,
    "model picker should exclusively own the popover layer");
  await act(async () => {
    document.querySelector('.model-trigger').click();
    textarea.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 140));
  });
  await act(async () => pending.get('test')(['test/first.mjs', 'test/renderer.dom.test.mjs']));

  await act(async () => textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  ));
  assert.equal(document.querySelector('.mention-palette [aria-selected="true"]')?.title, 'test/renderer.dom.test.mjs');
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(textarea.value, 'Review @test/renderer.dom.test.mjs ');
  assert.equal(document.querySelector('.mention-palette') === null, true,
    "selector .mention-palette should be absent");
  assert.equal(document.activeElement === textarea, true,
    "closing mentions should restore composer focus");

  await replaceDraft(`${textarea.value}@cancel`);
  await waitForSearch();
  await act(async () => textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  ));
  assert.equal(document.querySelector('.mention-palette') === null, true,
    "selector .mention-palette should be absent");
  assert.match(textarea.value, /@cancel$/);

  await replaceDraft('Review @test/renderer.dom.test.mjs ');
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'Review @test/renderer.dom.test.mjs ');
  assert.equal(submissions[0][1].displayText, 'Review @test/renderer.dom.test.mjs ');
  assert.equal(textarea.value, '');
});

test("desktop slash aliases preserve core command semantics and forced catalog refresh", async () => {
  installDom();
  const capabilities = [];
  const catalogOptions = [];
  const fastValues = [];
  let newTasks = 0;
  const snapshot = { items: [], queued: [], promptHistoryList: [], fast: true, fastCapable: true };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [{
      id: 'session-slash', title: 'Slash session', preview: 'Slash session', updatedAt: Date.now(),
      cwd: 'C:\\workspace', classification: 'task', projectPath: null, currentSession: true,
    }],
    resumeSession: async () => snapshot,
    startTask: async () => { newTasks += 1; return snapshot; },
    subscribeState: () => () => {},
    listProviderModels: async (options) => { catalogOptions.push(options); return []; },
    setFast: async (enabled) => { fastValues.push(enabled); return { ...snapshot, fast: enabled }; },
    invokeCapability: async ({ capability, args = [] }) => {
      capabilities.push([capability, args]);
      return { value: capability === 'getTheme' ? 'basic' : true, snapshot };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.session-row').click();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const sendSlash = async (value) => {
    await act(async () => {
      textarea.value = value;
      textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    });
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await sendSlash('/remote');
  await sendSlash('/fast off');
  await sendSlash('/style concise');
  await sendSlash('/new');
  await sendSlash('/model refresh');
  assert.ok(capabilities.some(([capability]) => capability === 'claimRemote'));
  assert.ok(capabilities.some(([capability, args]) => capability === 'setOutputStyle' && args[0] === 'concise'));
  assert.deepEqual(fastValues, [false]);
  assert.equal(newTasks, 1);
  assert.ok(catalogOptions.some((options) => options?.force === true));
});

test("stopping a turn restores engine-owned image attachments and keeps the current draft", async () => {
  installDom();
  const snapshot = { items: [], queued: [], promptHistoryList: [], busy: true };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [{
      id: 'session-abort-image', title: 'Abort image', preview: 'Abort image', updatedAt: Date.now(),
      cwd: 'C:\\workspace', classification: 'task', projectPath: null, currentSession: true,
    }],
    resumeSession: async () => snapshot,
    subscribeState: () => () => {},
    invokeCapability: async ({ capability }) => ({ value: capability === 'getTheme' ? 'basic' : null, snapshot }),
    abort: async () => ({
      aborted: true,
      restoreText: 'Inspect [Image #7: restored.png]',
      pastedImages: {
        7: { id: 7, type: 'image', content: 'aGVsbG8=', mediaType: 'image/png', filename: 'restored.png' },
      },
      pastedTexts: null,
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.session-row').click();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  await act(async () => {
    textarea.value = 'Keep this steering note';
    textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    document.querySelector('button[aria-label="Stop generation"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(textarea.value, 'Inspect [Image #7: restored.png]\nKeep this steering note');
  assert.match(document.querySelector('.composer-attachments').textContent, /restored\.png/);
  assert.match(document.querySelector('.composer-attachments img').src, /^data:image\/png;base64,aGVsbG8=/);
});
