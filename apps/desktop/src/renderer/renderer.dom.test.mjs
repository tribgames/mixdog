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
    document.querySelector('[aria-label="Manage projects"]')?.click();
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

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  dom?.window.close();
  dom = undefined;
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
  assert.equal(document.querySelector(".live-work-status"), null);
});

test("context view renders engine stats and omits unavailable optional fields", async () => {
  installDom();
  const status = {
    sessionId: "context-session",
    provider: "anthropic",
    model: "claude-opus",
    contextWindow: 200_000,
    usedTokens: 15_920,
    messages: {
      count: 3,
      roles: {
        user: { count: 2, tokens: 2_500 },
        assistant: { count: 1, tokens: 5_000 },
      },
    },
    usage: {
      totalInputTokens: 9_000,
      totalOutputTokens: 1_000,
      totalCachedReadTokens: 4_000,
      totalCacheWriteTokens: 500,
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
  assert.match(text, /Context fixture/);
  assert.match(text, /Context limit200,000/);
  assert.match(text, /Reasoning tokens250/);
  assert.match(text, /Total cost(?:US)?\$0\.13/);
  assert.match(text, /Usage79%/);
  const percentages = Array.from(document.querySelectorAll(".context-breakdown-legend small"))
    .map((element) => Number.parseInt(element.textContent, 10));
  assert.equal(percentages.reduce((sum, value) => sum + value, 0), 100);
  assert.equal(document.querySelectorAll(".context-raw-messages details").length, 2);
  assert.equal(document.querySelector(".context-raw-messages pre"), null);
  await act(async () => {
    document.querySelector(".context-raw-messages details summary").click();
    await Promise.resolve();
  });
  const projection = document.querySelector(".context-raw-messages pre")?.textContent || "";
  assert.match(projection, /"text": "Question"/);
  assert.doesNotMatch(projection, /hidden argument|hidden result|metadata|rawResult|args/);

  await act(async () => root.render(React.createElement(ContextBody, {
    status,
    snapshot: { items: snapshot.items, stats: {} },
  })));
  const withoutOptional = document.querySelector(".context-view")?.textContent || "";
  assert.doesNotMatch(withoutOptional, /Reasoning tokens|Total cost/);
  assert.match(withoutOptional, /Input tokens9,000/);
});

test("context raw-message list pages in bounded batches", async () => {
  installDom();
  const items = Array.from({ length: 205 }, (_, index) => ({
    id: `message-${index}`, kind: "user", text: `Message ${index}`,
  }));
  await act(async () => root.render(React.createElement(ContextBody, {
    status: { usedTokens: 1, contextWindow: 100, messages: { roles: {} } },
    snapshot: { items, stats: {} },
  })));
  assert.equal(document.querySelectorAll(".context-raw-messages details").length, 100);
  assert.match(document.querySelector(".context-raw-messages")?.textContent || "", /latest 100 of 205/);
  await act(async () => document.querySelector(".context-show-more").click());
  assert.equal(document.querySelectorAll(".context-raw-messages details").length, 200);
});

test("context view hides the breakdown for a zero-token session", async () => {
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
  assert.equal(document.querySelector(".context-breakdown"), null);
  assert.match(document.querySelector(".context-view")?.textContent || "", /Usage—/);
});

test("header context usage floors percent and dismisses focus popover without reopening", async () => {
  installDom();
  let opens = 0;
  await act(async () => root.render(React.createElement(ContextUsageIndicator, {
    snapshot: {
      sessionId: "usage",
      stats: { currentContextTokens: 796 },
      autoCompactTokenLimit: 1_000,
      displayContextWindow: 2_000,
    },
    onOpen: () => { opens += 1; },
  })));
  const indicator = document.querySelector(".session-context-indicator");
  const trigger = indicator.querySelector("button");
  assert.equal(trigger.querySelector("small")?.textContent, "79");
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
  assert.equal(document.querySelector(".message.user > .message-actions"), null);

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
  assert.equal(userFooter?.querySelector(".message-meta"), null);
  assert.equal(userFooter?.querySelector('[aria-label="Copy message"]') != null, true);

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "legacy-assistant", kind: "assistant", text: "Old response" },
  })));
  assert.equal(document.querySelector(".response-footer .message-time"), null);
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
  assert.equal(document.querySelector(".turn-status.failed")?.textContent?.trim(), "Failed");
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
  assert.equal(shell?.querySelector(".tool-title b")?.textContent, "Run");
  assert.equal(shell?.querySelector(".tool-title small")?.textContent, "npm test");
  assert.equal(shell?.querySelector(".tool-result-summary")?.textContent, "Exit code: 0");
  await act(async () => shell?.querySelector(".tool-header")?.click());
  assert.equal(shell?.querySelector('[aria-label="Copy command output"]') != null, true);

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
  assert.equal(aggregate?.querySelector(".tool-result-summary")?.textContent, "512 lines, 6 matches");
  await act(async () => aggregate?.querySelector(".tool-header")?.click());
  assert.equal(aggregate?.querySelector('.detail-block-heading span')?.textContent, "Result");
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

test("sidebar footer exposes the settings entry point used by the reviewed settings dialog", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    readSettings: async () => ({ autoClear: true, autoCompact: false }),
    updateSetting: async () => ({ autoClear: true, autoCompact: false }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  const trigger = document.querySelector(".session-sidebar-footer [aria-label='Open settings']");
  assert.equal(trigger != null, true, "settings trigger should be present in the sidebar footer");
  assert.equal(trigger.closest(".session-sidebar") !== null, true);
  assert.equal(trigger.getAttribute("aria-label"), "Open settings");
  assert.equal(trigger.getAttribute("data-tooltip"), "Settings");
  assert.equal(trigger.getAttribute("title"), null);
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

  let title = document.querySelector(".standalone-group .session-row-copy");
  assert.equal(document.querySelector(".session-row-rename")?.getAttribute("aria-label"), "Rename Original title");
  await act(async () => {
    title.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["rename-task"]);

  await act(async () => {
    title.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    title.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
    title.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  });
  assert.equal(document.querySelector(".session-title-input")?.getAttribute("aria-label"), "Rename Original title");
  await act(async () => document.querySelector(".session-title-input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));

  const inactiveTitle = document.querySelectorAll(".standalone-group .session-row-copy")[1];
  await act(async () => {
    inactiveTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  });
  await act(async () => {
    inactiveTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
    inactiveTitle.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["rename-task", "inactive-task"]);
  assert.equal(document.querySelector(".session-title-input"), null);
  assert.equal(document.querySelectorAll(".session-row")[1].getAttribute("aria-current"), "page");

  Object.defineProperty(window, "innerWidth", { value: 720, writable: true, configurable: true });
  const resumesBeforeHoverRename = [...resumes];
  await act(async () => document.querySelectorAll(".session-row-rename")[0].click());
  assert.deepEqual(resumes, resumesBeforeHoverRename);
  assert.equal(document.querySelector(".session-title-input")?.getAttribute("aria-label"), "Rename Original title");
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
  await act(async () => document.querySelector(".session-title-input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  ));
  Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });

  title = document.querySelector(".standalone-group .session-row-copy");
  await act(async () => document.querySelectorAll(".session-row-rename")[0].click());
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

  await act(async () => document.querySelector(".session-row-rename").click());
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
  await act(async () => document.querySelector(".session-row-rename").click());
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
  await act(async () => document.querySelector(".standalone-group .session-row-rename").click());
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

  const trigger = document.querySelector(".toolbar-sidebar");
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
  assert.equal(rows[0].hasAttribute("aria-current"), false);
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
  assert.equal(document.querySelector(".standalone-group .session-row")?.getAttribute("aria-current"), "page");
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
  assert.equal(document.querySelector(".standalone-group .session-row") === null, true, "selector .standalone-group .session-row should be absent");
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
  const projectRows = document.querySelectorAll(".project-group .session-row");
  const taskRows = document.querySelectorAll(".standalone-group .session-row");
  await act(async () => {
    projectRows[0].click();
    await Promise.resolve();
  });
  assert.equal(projectRows[0].getAttribute("aria-current"), "page");
  assert.match(document.body.textContent || "", /Active transcript/);
  await act(async () => {
    projectRows[1].click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(projectRows[0].getAttribute("aria-current"), "page");
  assert.equal(projectRows[1].hasAttribute("aria-current"), false);
  assert.match(document.body.textContent || "", /Active transcript/);
  assert.match(document.querySelector('[role="alert"]').textContent || "", /before replacement/);

  await act(async () => {
    taskRows[0].click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(projectRows[0].hasAttribute("aria-current"), false);
  assert.equal(taskRows[0].hasAttribute("aria-current"), false);
  assert.equal(document.querySelector(".task-link").getAttribute("aria-current"), null);
  assert.doesNotMatch(document.body.textContent || "", /Active transcript/);
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  assert.match(document.querySelector('[role="alert"]').textContent || "", /Resume failed/);
});

test("session sidebar and separate project switcher preserve navigation and project actions", async () => {
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
    setProjectPinned: async (path, pinned) => { projectActions.push(["pin", path, pinned]); },
    removeProject: async (path) => {
      projectActions.push(["remove", path]);
      visibleProjects = visibleProjects.filter((candidate) => candidate.path !== path);
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(
    Array.from(document.querySelectorAll('.standalone-group .session-row .session-row-copy b'))
      .map((row) => row.textContent.trim()),
    ["Unregistered folder task", "Untitled session", "Older task"],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll(".project-group .session-row .session-row-copy b"))
      .map((row) => row.textContent.trim()),
    ["Newest project work", "Project work"],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll(".project-group-toggle span"))
      .filter((row) => row.parentElement?.classList.contains("project-group-toggle")
        && !row.classList.contains("project-avatar-v2")
        && !row.classList.contains("project-group-chevron"))
      .map((row) => row.textContent.trim()),
    ["One alias", "Two alias"],
  );
  assert.equal(document.querySelector(".sidebar .project-group-toggle .lucide-folder"), null);
  assert.equal(document.querySelectorAll('.sidebar [data-component="project-avatar-v2"]').length, 2);
  assert.match(
    document.querySelector('.sidebar [data-slot="project-avatar-surface"]')?.dataset.variant || "",
    /^(orange|yellow|cyan|green|red|pink|blue|purple|gray)$/,
  );
  const tasksToggle = document.querySelector('.standalone-group .sidebar-section-toggle');
  await act(async () => tasksToggle.click());
  assert.equal(tasksToggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".standalone-session-list"), null);
  await act(async () => tasksToggle.click());
  assert.equal(tasksToggle.getAttribute("aria-expanded"), "true");
  assert.doesNotMatch(document.querySelector(".sidebar-projects")?.textContent || "", /Unregistered folder task/);
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Legacy/);
  let projectDialog = await openProjectSwitcher();
  assert.match(projectDialog.querySelector(".project-list")?.textContent || "", /One alias/);
  assert.equal(document.querySelector(".sidebar .project-row, .sidebar .project-more, .sidebar .new-project") === null, true, "selector .sidebar .project-row, .sidebar .project-more, .sidebar .new-project should be absent");
  const firstProject = Array.from(projectDialog.querySelectorAll(".project-row"))
    .find((row) => /One alias/.test(row.textContent || ""));
  assert.equal(firstProject != null, true, "first project row should be present in the switcher");
  await act(async () => {
    firstProject.click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".sidebar").closest(".app-shell").classList.contains("sidebar-collapsed"), false);
  assert.equal(document.querySelector(".project-group-toggle")?.getAttribute("aria-current"), "page");
  assert.equal(document.querySelector(".project-group-toggle")?.classList.contains("selected"), true);
  await act(async () => {
    document.querySelector(".project-group .session-row").click();
    await Promise.resolve();
  });
  assert.deepEqual(resumed, ["project_new"]);
  assert.equal(document.querySelector(".project-group .session-row").getAttribute("aria-current"), "page");
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
    ["New task here", "Open in Explorer", "Rename", "Pin", "Remove from list"],
  );
  const menuItems = menu.querySelectorAll('[role="menuitem"]');
  assert.equal(document.activeElement === menuItems[0], true, "opening the project menu should focus its first item");
  menuItems[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
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

  more.focus();
  await act(async () => more.click());
  menu = document.querySelector('[role="menu"]');
  await act(async () => {
    menu.querySelectorAll('[role="menuitem"]')[3].click();
    await Promise.resolve();
  });
  assert.deepEqual(projectActions, [["pin", "C:\\work\\one", true]]);
  assert.equal(document.activeElement === more, true, "pinning should restore overflow-button focus");

  await act(async () => more.click());
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
    document.querySelector(".project-group .session-row").click();
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
  assert.deepEqual(outcomes.map((row) => row.textContent?.trim()), ["Failed"]);
  assert.equal(outcomes[0].querySelector(".lucide-check") === null, true, "selector .lucide-check should be absent");
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

test("model selector uses a ranked provider step and a provider-scoped recency model step", async () => {
  installDom();
  const catalogOptions = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [], queued: [], provider: "openai", model: "gpt-real", effort: "high",
      fastCapable: true, fast: false,
    }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    listProviderModels: async (options) => {
      catalogOptions.push(options);
      return [
      { provider: "anthropic", model: "claude-sonnet-4-5", display: "Claude Sonnet 4.5",
        releaseDate: "2025-09-29", contextWindow: 200_000, fastCapable: true, effortOptions: [] },
      { provider: "anthropic", model: "claude-opus-4-7", display: "Claude Opus 4.7",
        releaseDate: "2026-05-01", contextWindow: 1_000_000, fastCapable: false, effortOptions: [] },
      { provider: "openai", model: "gpt-real", display: "GPT Real", releaseDate: "2026-03-01", effortOptions: [
        { value: "low", label: "Low" }, { value: "high", label: "High" },
      ] },
      { provider: "anthropic", model: "claude-sonnet-4-6", display: "Claude Sonnet 4.6",
        releaseDate: "2026-02-17", contextWindow: 1_000_000, fastCapable: true, effortOptions: [] },
      ];
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
  assert.equal(trigger.querySelector('.provider-icon[data-provider-icon="openai"]') != null, true, "selector .provider-icon[data-provider-icon=\"openai\"] should be present");
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
  const dialog = document.querySelector('[role="dialog"][aria-label="Model selector"]');
  assert.equal(dialog.parentElement === document.body, true, "model selector portal should be attached to document.body");
  assert.equal(dialog.style.left, "20px");
  assert.equal(dialog.style.bottom, `${window.innerHeight - 700 + 4}px`);
  assert.equal(dialog.querySelector(".model-list").getAttribute("aria-label"), "Available providers");
  const providers = dialog.querySelectorAll(".model-provider-row");
  assert.deepEqual(Array.from(providers).map((node) => node.querySelector("strong").textContent),
    ["OpenAI API", "Anthropic API"]);
  assert.match(providers[0].querySelector("small").textContent, /^Current · GPT-Real$/);
  assert.equal(providers[0].querySelector(".model-count").textContent, "1");
  assert.equal(providers[1].querySelector(".model-count").textContent, "2",
    "the TUI family limit keeps the newest Anthropic Sonnet alongside the latest Opus family");
  assert.equal(dialog.querySelector(".model-option-row") === null, true,
    "models from unrelated providers must not be mixed into the provider step");
  assert.equal(dialog.querySelectorAll('[role="radio"]').length, 0);
  const input = dialog.querySelector('input[aria-label="Search providers"]');
  assert.equal(document.activeElement === input, true, "opening the model selector should focus provider search");
  await act(async () => input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === providers[0], true, "ArrowDown should focus the first provider");
  await act(async () => providers[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === providers[1], true, "ArrowDown should focus the next provider");
  await act(async () => providers[1].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  ));
  assert.equal(document.activeElement === providers[0], true, "Home should focus the first provider");
  await act(async () => providers[0].dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  ));
  assert.equal(document.activeElement === providers[1], true, "End should focus the last provider");

  await act(async () => {
    providers[1].click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(dialog.querySelector(".model-list").getAttribute("aria-label"), "Models from Anthropic API");
  assert.equal(dialog.querySelector('[aria-label="Back to providers"]') !== null, true);
  const providerModels = dialog.querySelectorAll(".model-option-row");
  assert.deepEqual(Array.from(providerModels).map((node) => node.querySelector("strong").textContent),
    ["Claude Opus 4.7", "Claude Sonnet 4.6"]);
  assert.equal(providerModels[0].querySelector("small").textContent, "1M Context");
  assert.equal(providerModels[1].querySelector("small").textContent, "1M Context · Fast Available");
  assert.doesNotMatch(dialog.textContent, /GPT-Real/);
  const modelSearch = dialog.querySelector('input[aria-label="Search models"]');
  assert.equal(document.activeElement === modelSearch, true, "provider selection should focus model search");
  await act(async () => modelSearch.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === providerModels[0], true, "ArrowDown should focus the first provider model");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(modelSearch, "sonnet");
    modelSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.deepEqual(Array.from(dialog.querySelectorAll(".model-option-row strong")).map((node) => node.textContent),
    ["Claude Sonnet 4.6"]);
  modelSearch.focus();
  await act(async () => modelSearch.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  ));
  assert.equal(document.activeElement === dialog.querySelector(".model-option-row"), true, "filtered model navigation should focus the visible model");

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".model-popover") != null, true, "Escape returns from models to providers first");
  assert.equal(dialog.querySelector(".model-list").getAttribute("aria-label"), "Available providers");
  await act(async () => dialog.querySelectorAll(".model-provider-row")[1].click());
  await act(async () => dialog.querySelector('[aria-label="Back to providers"]').click());
  assert.equal(dialog.querySelector(".model-list").getAttribute("aria-label"), "Available providers");

  dialog.querySelector(".model-list").scrollTop = 180;
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-popover") === null, true, "selector .model-popover should be absent");
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-list").scrollTop, 0,
    "reopening always starts at the top-level provider list top");
  assert.match(document.querySelector('[aria-label="Reasoning effort"]').textContent, /High/);
});

test("model control styles keep the reference compact geometry and bounded list", async () => {
  const [css, openCodeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./opencode-v2.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.model-popover\s*\{[^}]*width:\s*min\(296px,[^}]*max-height:\s*min\(360px,/s);
  assert.match(css, /\.model-search\s*\{[^}]*height:\s*32px;/s);
  assert.match(css, /\.model-group button\s*\{[^}]*height:\s*30px;/s);
  assert.match(css, /\.model-list\s*\{[^}]*overflow-y:\s*auto;/s);
  for (const selector of [".model-trigger", ".effort-control select", ".fast-control"]) {
    assert.match(css, new RegExp(`\\${selector}\\s*\\{[^}]*height:\\s*28px;`, "s"));
  }
  assert.match(openCodeCss, /\.fast-control\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*40px;/s,
    "the full visible Fast label must remain inside its click target");
  assert.match(openCodeCss, /\.model-popover\s*\{[^}]*width:\s*min\(340px,[^}]*max-height:\s*min\(420px,/s,
    "the two-step selector needs enough room for provider and model metadata");
  assert.match(openCodeCss, /\.model-provider-row,[\s\S]*?\.model-option-row\s*\{[^}]*min-height:\s*48px;/s);
  assert.match(openCodeCss, /\.model-row-copy small\s*\{[^}]*color:\s*var\(--oc-text-faint\);[^}]*font-size:\s*11px;/s);
  assert.match(openCodeCss, /\.composer-region\s*\{[^}]*padding:\s*0 12px 8px;/s,
    "the composer should sit close to the workspace bottom edge");
  assert.match(openCodeCss, /\.composer\s*\{[^}]*background:\s*var\(--oc-bg-layer-1\);[^}]*0 0 0 \.5px var\(--oc-border-strong\);/s,
    "the composer needs a distinct raised input surface");
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
  await act(async () => document.querySelectorAll(".model-provider-row")[1].click());
  await act(async () => {
    document.querySelector(".model-option-row").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [{ provider: "anthropic", model: "claude-real" }]);
  assert.match(document.querySelector(".inline-error").textContent, /Route IPC failed/);
  assert.equal(document.querySelector(".model-trigger").disabled, false);
  await act(async () => document.querySelector(".model-trigger").click());
  assert.equal(document.querySelector('[aria-label="Reasoning effort"]') != null, true, "selector [aria-label=\"Reasoning effort\"] should be present");
  await act(async () => document.querySelectorAll(".model-provider-row")[1].click());
  await act(async () => {
    document.querySelector(".model-option-row").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".model-trigger").textContent, /Claude Real/);
  assert.equal(document.querySelector('.model-trigger .provider-icon[data-provider-icon="anthropic"]') != null, true, "selector .model-trigger .provider-icon[data-provider-icon=\"anthropic\"] should be present");
  assert.equal(document.activeElement === document.querySelector(".model-trigger"), true, "successful model selection should restore trigger focus");
  assert.equal(document.querySelector(".inline-error") === null, true, "selector .inline-error should be absent");
  await act(async () => document.querySelector(".model-trigger").click());
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
  assert.equal(document.querySelector(".model-popover") === null, true, "selector .model-popover should be absent");
  assert.deepEqual(calls.filter((request) => request.capability !== "getTheme" && request.capability !== "getOnboardingStatus"),
    [{ capability: "setEffort", args: ["high"] }]);
  assert.equal(document.activeElement === effort, true, "effort selection should restore effort-control focus");
  assert.match(effort.textContent, /High/);
});

test("Fast follows core capability, uses setFast, and disables with route controls while busy", async () => {
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
    document.querySelector(".titlebar-new").click();
    await Promise.resolve();
  });
  const fast = document.querySelector('.fast-control');
  assert.equal(fast != null, true, "Fast control should be present for a capable model");
  assert.equal(fast.getAttribute("aria-label"), "Enable Fast mode");
  assert.equal(fast.getAttribute("aria-pressed"), "false");
  await act(async () => {
    fast.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true]);
  assert.equal(fast.getAttribute("aria-pressed"), "true");
  assert.equal(fast.getAttribute("aria-label"), "Disable Fast mode");
  await act(async () => publish({ ...idle, busy: true }));
  assert.equal(fast.disabled, true);
  assert.equal(document.querySelector(".model-trigger").disabled, true);
  await act(async () => publish({ ...idle, fastCapable: false }));
  assert.equal(document.querySelector('.fast-control') === null, true, "selector .fast-control should be absent");
});

test("Fast recovers from a rejected backend toggle and can be retried", async () => {
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

  const fast = document.querySelector('.fast-control');
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

test("desktop session sidebar releases its 286px rail when collapsed and restores it on expand", async () => {
  installDom();
  const style = document.createElement("style");
  const [baseCss, openCodeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./opencode-v2.css", import.meta.url), "utf8"),
  ]);
  style.textContent = `${baseCss}\n${openCodeCss}`;
  document.head.append(style);
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const sidebarStyle = window.getComputedStyle(document.querySelector(".sidebar"));
  assert.equal(sidebarStyle.boxSizing, "border-box");
  assert.equal(sidebarStyle.width, "286px");
  assert.equal(sidebarStyle.flexBasis, "286px");
  assert.equal(sidebarStyle.padding, "8px");
  const leadingStyle = window.getComputedStyle(document.querySelector(".titlebar-leading"));
  const topbarStyle = window.getComputedStyle(document.querySelector(".topbar"));
  const tabsStyle = window.getComputedStyle(document.querySelector(".workspace-tabs"));
  const tabStyle = window.getComputedStyle(document.querySelector(".workspace-tab"));
  const desktopBodyStyle = window.getComputedStyle(document.querySelector(".desktop-body"));
  const composerRegionStyle = window.getComputedStyle(document.querySelector(".composer-region"));
  const sessionSearchInputStyle = window.getComputedStyle(document.querySelector(".session-search input"));
  const sessionHeaderStyle = window.getComputedStyle(document.querySelector(".session-header"));
  const sessionHeaderContentStyle = window.getComputedStyle(document.querySelector(".session-header-content"));
  const sessionTitleStyle = window.getComputedStyle(document.querySelector(".session-header h1"));
  const sidebarToggleStyle = window.getComputedStyle(document.querySelector(".toolbar-sidebar"));
  const settingsToggleStyle = window.getComputedStyle(document.querySelector(".session-sidebar-footer button"));
  assert.equal(leadingStyle.height, "28px");
  assert.equal(leadingStyle.gap, "6px");
  assert.equal(topbarStyle.paddingLeft, "16px");
  assert.equal(topbarStyle.paddingRight, "12px");
  assert.equal(tabsStyle.height, "28px");
  assert.equal(tabsStyle.paddingTop, "0px");
  assert.equal(tabStyle.minWidth, "96px");
  assert.equal(desktopBodyStyle.gap, "8px");
  assert.equal(composerRegionStyle.paddingLeft, "12px");
  assert.equal(composerRegionStyle.paddingRight, "12px");
  assert.equal(sessionSearchInputStyle.outlineStyle, "");
  assert.equal(sessionHeaderStyle.borderBottomWidth, "0px");
  assert.equal(sessionHeaderContentStyle.paddingTop, "12px");
  assert.equal(sessionHeaderContentStyle.paddingBottom, "12px");
  assert.equal(sessionTitleStyle.fontSize, "14px");
  assert.equal(sessionTitleStyle.lineHeight, "20px");
  assert.equal(sidebarToggleStyle.top, "auto");
  assert.equal(sidebarToggleStyle.left, "auto");
  assert.equal(sidebarToggleStyle.width, "36px");
  assert.equal(document.querySelector(".titlebar-home") === null, true, "selector .titlebar-home should be absent");
  assert.equal(document.querySelector(".topbar-settings") === null, true, "selector .topbar-settings should be absent");
  assert.equal(settingsToggleStyle.height, "28px");
  assert.match(openCodeCss, /\.desktop-body\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*0 8px 8px;/s);
  assert.match(openCodeCss, /\.workspace-tab-divider\s*\{[^}]*width:\s*1\.5px;[^}]*height:\s*12px;/s);
  assert.match(openCodeCss, /\.workspace-tabs-fade-left\s*\{[^}]*animation-timeline:\s*--workspace-tabs-scroll;/s);
  await act(async () => document.querySelector(".toolbar-sidebar").click());
  const collapsedStyle = window.getComputedStyle(document.querySelector(".sidebar"));
  const collapsedBodyStyle = window.getComputedStyle(document.querySelector(".desktop-body"));
  assert.equal(collapsedStyle.width, "0px");
  assert.equal(collapsedStyle.flexBasis, "0px");
  assert.equal(collapsedBodyStyle.gap, "0");
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Expand session sidebar");
  await act(async () => document.querySelector(".toolbar-sidebar").click());
  const restoredStyle = window.getComputedStyle(document.querySelector(".sidebar"));
  assert.equal(restoredStyle.width, "286px");
  assert.equal(restoredStyle.flexBasis, "286px");
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
  await act(async () => root.render(React.createElement(DesktopTitlebar, { ...props, activeKey: "two" })));
  assert.equal(scrolled.at(-1)?.textContent.includes("Two"), true);
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
  const transfer = {
    effectAllowed: "",
    dropEffect: "",
    value: "",
    setData(_type, value) { this.value = value; },
    getData() { return this.value; },
  };
  const dragStart = new window.Event("dragstart", { bubbles: true });
  Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: transfer });
  await act(async () => {
    firstTab.dispatchEvent(dragStart);
    secondTab.dispatchEvent(drop);
  });
  assert.equal(newTasks, 1);
  assert.deepEqual(closed, ["two"]);
  assert.deepEqual(selected, ["one", "two", "one"]);
  assert.deepEqual(reordered, [["one", "two"]]);
  assert.equal(document.querySelector(".workspace-tabs-shell")?.nextElementSibling?.classList.contains("titlebar-new"), true);
});

test("model selector closes separately for busy and commandBusy while preserving dismissal focus behavior", async () => {
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
    document.querySelector(".titlebar-new").click();
    await Promise.resolve();
  });
  const trigger = document.querySelector(".model-trigger");
  trigger.focus();
  await act(async () => trigger.click());
  assert.equal(document.activeElement === trigger, false, "opening the model selector should move focus from its trigger");
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".model-popover") === null, true, "Escape should close the model selector");
  assert.equal(document.activeElement === trigger, true, "Escape should restore model-trigger focus");
  await act(async () => trigger.click());
  const textarea = document.querySelector("textarea");
  await act(async () => {
    textarea.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    textarea.focus();
  });
  assert.equal(document.querySelector(".model-popover") === null, true, "outside pointer interaction should close the model selector");
  assert.equal(document.activeElement === textarea, true, "outside pointer interaction should preserve composer focus");
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-popover") != null, true, "selector .model-popover should be present");
  await act(async () => publish({ items: [], queued: [], busy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-popover") === null, true, "busy state should close the model selector");
  assert.equal(trigger.disabled, true);
  await act(async () => publish({ items: [], queued: [], busy: false, provider: "openai", model: "gpt-real" }));
  assert.equal(trigger.disabled, false);
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-popover") != null, true, "selector .model-popover should be present");
  await act(async () => publish({ items: [], queued: [], commandBusy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-popover") === null, true, "command-busy state should close the model selector");
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
  assert.equal(document.querySelector('.queue-restore') != null, true, "selector .queue-restore should be present");
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(textarea.value, 'Restored request');

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
      return { value: capability === 'getTheme' ? 'basic' : true, snapshot: idle };
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

  await act(async () => publish({ ...idle, busy: true }));
  assert.equal(document.querySelector('.send-button.stop') != null, true, "selector .send-button.stop should be present");
  assert.equal(document.querySelector('.queue-priority') === null, true, "selector .queue-priority should be absent");
  assert.equal(getTextarea().placeholder, 'Steer the active turn or queue a follow-up…');
  await press('Escape');
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
  assert.equal(document.querySelector('.model-popover') != null, true, "model picker should open");
  assert.equal(document.querySelector('.mention-palette'), null, "model picker should exclusively own the popover layer");
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
  assert.equal(document.querySelector('.mention-palette'), null);
  assert.equal(document.activeElement, textarea);

  await replaceDraft(`${textarea.value}@cancel`);
  await waitForSearch();
  await act(async () => textarea.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  ));
  assert.equal(document.querySelector('.mention-palette'), null);
  assert.match(textarea.value, /@cancel$/);

  await replaceDraft('Review @test/renderer.dom.test.mjs ');
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], 'Review @test/renderer.dom.test.mjs ');
  assert.equal(submissions[0][1].displayText, 'Review @test/renderer.dom.test.mjs ');
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