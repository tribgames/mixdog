import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { flushSync } from "react-dom";

import {
  cleanupDom,
  dom,
  installDom,
  root,
} from "./renderer-dom-test-harness.mjs";

const {
  App,
  ApprovalCard,
  ContextUsageIndicator,
  DesktopUpdateDialog,
  lastVisibleTranscriptItemIndex,
  LiveWorkStatus,
  TranscriptRow,
} = await import("./App.tsx");
const { ContextBody } = await import("./CommandSurface.tsx");
const { Conversation } = await import("./Conversation.tsx");
const { ActivityRail } = await import("./ActivityRail.tsx");
const {
  CompletionStatus,
  MarkdownResponse,
  preloadMarkdownBody,
  preloadStreamingMarkdownBody,
} = await import("./TranscriptView.tsx");
const { MarkdownSourceFallback } = await import("./MarkdownSourceFallback.tsx");
const { WorkspaceTabStrip } = await import("./navigation.tsx");
const { PaneWorkspace } = await import("./PaneWorkspace.tsx");
const { publishTabDrag } = await import("./tab-drag-bus.ts");
const { useWorkspaceShortcuts } = await import("./app-workspace-shortcuts.ts");
const { PaneSplitLayout } = await import("./PaneSplitLayout.tsx");
const { OpenSelect } = await import("./OpenSelect.tsx");
const { ProgressSpinner, progressSpinnerStrokeWidth } = await import("./ProgressSpinner.tsx");
const { AgentActivityPane } = await import("./AgentActivityPane.tsx");
const { StudioPane } = await import("./StudioView.tsx");
const { TooltipLayer } = await import("./TooltipLayer.tsx");
const { TurnReviewBar } = await import("./TurnReview.tsx");
const { UtilityDock, readDockState } = await import("./UtilityDock.tsx");
const { acquireModalLayer } = await import("./modal-layer.ts");
const { DesktopErrorBoundary, DesktopLoadingSurface } = await import("./RendererRecovery.tsx");
const { SESSION_CATALOG_STORAGE_KEY } = await import("./session-catalog-cache.ts");
const { SidebarUsage, SIDEBAR_USAGE_CACHE_KEY } = await import("./SidebarUsage.tsx");
const { SessionSidebar } = await import("./session-sidebar.tsx");
const { GitDiffPane } = await import("./GitDiffPane.tsx");
const {
  DesktopBootGate,
  DeferredPersistentSurface,
  PaneSurfaceGate,
  PersistentPanePortal,
  StableContentSwap,
} = await import("./PaneSurfaceGate.tsx");
const { beginBootSurface, reportBootSurfaceReady } = await import("./boot-metrics.ts");
const {
  AgentSessionConversation,
  PaneConversation,
  PaneHeaderStatus,
  requestSessionPeek,
} = await import("./app-snapshot-views.tsx");
const { createDesktopSnapshotStore } = await import("./desktop-snapshot-store.ts");
const { modelDisplayName } = await import("./provider-display.tsx");
const { navigationKey } = await import("./text-format.ts");
const { defaultSessionLaneStore } = await import("./session-lane-store.ts");
const { createTranscriptSnapshotDecorator } = await import("./snapshot-transcript-decoration.ts");
const {
  parseQuickOpenQuery,
  UnsavedChangesDialog,
  WorkbenchQuickAccess,
} = await import("./WorkbenchOverlays.tsx");
const {
  clearActiveEditorDocument,
  setActiveEditorDocument,
  setActiveEditorPosition,
  setEditorOutline,
  setNativeEditorProblems,
} = await import("./editor-language-store.ts");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Registered before the first test so every test in this file — including the
// first two — gets an awaited teardown. A hook registered further down does not
// cover the tests declared above it, which left an orphaned JSDOM window and a
// never-unmounted React root alive for the rest of the run.
afterEach(cleanupDom);

test("progress spinner rotates by default while preserving surface classes", async () => {
  installDom();
  await act(async () => root.render(React.createElement(ProgressSpinner, {
    className: "session-row-spinner",
    size: 14,
    "aria-label": "Working",
  })));
  const spinner = document.querySelector('[aria-label="Working"]');
  assert.equal(spinner?.classList.contains("spin"), true);
  assert.equal(spinner?.classList.contains("progress-spinner"), true);
  assert.equal(spinner?.classList.contains("session-row-spinner"), true);
  assert.equal(Number(spinner?.style.strokeWidth), 1.75,
    "the working tab defines the shared spinner stroke");
  assert.equal(progressSpinnerStrokeWidth(12), 49 / 24,
    "compact spinners compensate so their visible line does not become thinner");
  assert.equal(progressSpinnerStrokeWidth(24), 49 / 48,
    "large loading spinners retain the tab spinner's optical line");
});

test("split pane roots expose their recursively composed pixel floors", async () => {
  installDom();
  const leaf = (id) => ({
    type: "leaf",
    id,
    tabs: [{ kind: "session", id }],
    activeKey: `session:${id}`,
  });
  const layout = {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("left"),
    second: {
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("top-right"),
      second: leaf("bottom-right"),
    },
  };
  await act(async () => root.render(React.createElement(PaneSplitLayout, {
    node: layout,
    onRatioChange() {},
    renderLeaf: ({ id }) => React.createElement("div", null, id),
  })));
  const split = document.querySelector(".pane-split");
  assert.equal(split?.style.minWidth, "644px");
  // Vertical floor = 1.5x horizontal (pane-layout PANE_MIN_HEIGHT 480):
  // stacked column = 480 + 480 + 4px handle.
  assert.equal(split?.style.minHeight, "964px");
});

function elementLabel(element) {
  if (!(element instanceof Element)) return String(element);
  const id = element.id ? `#${element.id}` : "";
  const aria = element.getAttribute("aria-label");
  return `<${element.tagName.toLowerCase()}${id}${aria ? ` aria-label="${aria.slice(0, 80)}"` : ""}>`;
}

// Startup restore is stored-selection-first (user decision): without a stored
// last-viewed session the app boots into the New task draft even when the
// engine holds a live session. Tests that exercise an ACTIVE session seed the
// stored id plus its catalog row so startupRestorePlan activates it.
function seedActiveSession(id, title = id) {
  dom.window.localStorage.setItem("mixdog.desktop-last-session.v1", id);
  dom.window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "leaf",
      id: `pane_${id}`,
      tabs: [{ kind: "session", id }],
      activeKey: `session:${id}`,
    },
    focusedLeafId: `pane_${id}`,
  }));
  const row = {
    id,
    title,
    preview: title,
    updatedAt: 1,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  dom.window.localStorage.setItem(SESSION_CATALOG_STORAGE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 1,
    rows: [row],
  }));
  return row;
}

function assertActiveElement(expected, message) {
  assert.equal(
    document.activeElement === expected,
    true,
    `${message}; expected ${elementLabel(expected)}, received ${elementLabel(document.activeElement)}`,
  );
}

async function waitForDom(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });
  }
  assert.equal(predicate(), true, message);
}

async function settleStableSurfaceSwitch() {
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))));
}

async function openProjectsPane() {
  await act(async () => {
    document.querySelector('[aria-label="Open projects"]')?.click();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  await waitForDom(
    () => document.querySelector(".projects-pane") != null,
    "projects pane should be present",
  );
  return document.querySelector(".projects-pane");
}

async function selectFirstProject() {
  const pane = await openProjectsPane();
  const row = pane.querySelector(".projects-row-open");
  assert.equal(row != null, true, "first project row should be present");
  await act(async () => {
    row.click();
    await Promise.resolve();
  });
}

async function chooseSessionAction(row, action) {
  // Codex-style archive-first flow: Recent rows only ARCHIVE (instant, no
  // confirm); destructive delete lives on rows inside the Archived section.
  const archiveButton = row.querySelector(".session-row-archive");
  if (archiveButton) {
    await act(async () => {
      archiveButton.click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const toggle = document.querySelector(".sidebar-archived-toggle");
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
    }
  }
  const archivedRow = document.querySelector(
    `.archived-session-list [data-session-id="${row.dataset.sessionId}"]`,
  ) || row;
  await act(async () => {
    archivedRow.querySelector(".session-row-delete").click();
    await Promise.resolve();
  });
  void action;
  return;
}

test("desktop loading surfaces keep full-screen transitions visibly occupied", async () => {
  installDom();
  await act(async () => {
    root.render(React.createElement(DesktopLoadingSurface, { label: "Loading editor…" }));
  });
  const status = document.querySelector('[role="status"]');
  assert.ok(status, "loading surface should render");
  assert.equal(status.textContent.trim(), "");
  assert.equal(status.getAttribute("aria-label"), "Loading editor…");
  assert.equal(status.children.length, 1);
  const spinner = status.querySelector(".desktop-loading-spinner");
  assert.ok(spinner);
  assert.equal(spinner?.tagName.toLocaleLowerCase(), "svg");
  assert.equal(spinner?.classList.contains("progress-spinner"), true,
    "loading surfaces must use the same LoaderCircle geometry as working tabs");
  assert.equal(status.classList.contains("desktop-loading-surface"), true);
});

test("sidebar destinations stay mounted while Sessions and rail panels swap", async () => {
  installDom();
  const callbacks = {
    onNewTask() {},
    onOpenStudio() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession() {},
    async onDeleteSession() {},
  };
  const renderSidebar = (panelActive) => React.createElement(SessionSidebar, {
    open: true,
    panelActive,
    panelTitle: panelActive ? "Workflows" : "",
    sessions: [],
    sessionsReady: true,
    selection: { kind: "new" },
    ...callbacks,
  }, React.createElement("input", { className: "persistent-panel-input", defaultValue: "initial" }));

  await act(async () => root.render(renderSidebar(false)));
  const sessionsSurface = document.querySelector(".session-sidebar-scroll.session-sidebar-surface");
  const panelSurface = document.querySelector(".session-sidebar-panels");
  const panelInput = document.querySelector(".persistent-panel-input");
  panelInput.value = "preserved";
  assert.equal(sessionsSurface?.dataset.surfaceActive, "true");
  assert.equal(panelSurface?.dataset.surfaceActive, "false");

  await act(async () => root.render(renderSidebar(true)));
  assert.equal(document.querySelector(".session-sidebar-scroll.session-sidebar-surface"), sessionsSurface);
  assert.equal(document.querySelector(".session-sidebar-panels"), panelSurface);
  assert.equal(document.querySelector(".persistent-panel-input"), panelInput);
  assert.equal(panelInput.value, "preserved");
  assert.equal(sessionsSurface?.dataset.surfaceActive, "false");
  assert.equal(panelSurface?.dataset.surfaceActive, "true");
});

test("historical completion labels stay static unless a new completion opts in", async () => {
  installDom();
  const item = { id: "done-1", kind: "turndone", verb: "Mapped", elapsedMs: 124_000 };
  await act(async () => root.render(React.createElement(CompletionStatus, { item })));
  const historical = document.querySelector(".turn-status");
  assert.equal(historical?.textContent?.includes("Mapped for 2m 4s"), true);
  assert.equal(historical?.hasAttribute("data-animate"), false);

  await act(async () => root.render(React.createElement(CompletionStatus, { item, animate: true })));
  assert.equal(document.querySelector(".turn-status"), historical);
  assert.equal(historical?.dataset.animate, "true");
});

test("desktop cold boot reveals the complete shell only after registered surfaces settle", async () => {
  installDom();
  const PendingSurface = ({ ready }) => {
    beginBootSurface("boot-gate-test", "surface");
    React.useEffect(() => {
      if (ready) reportBootSurfaceReady("boot-gate-test", "surface");
    }, [ready]);
    return React.createElement("div", { className: "boot-gate-test-content" }, "Ready");
  };
  const renderGate = (ready) => React.createElement(
    DesktopBootGate,
    { ready: true },
    React.createElement(PendingSurface, { ready }),
  );
  await act(async () => root.render(renderGate(false)));
  assert.ok(document.querySelector(".desktop-boot-cover"));
  assert.equal(document.querySelector(".desktop-boot-gate-content")?.getAttribute("aria-hidden"), "true");

  await act(async () => root.render(renderGate(true)));
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  });
  assert.equal(document.querySelector(".desktop-boot-cover"), null);
  assert.equal(document.querySelector(".desktop-boot-gate-content")?.hasAttribute("aria-hidden"), false);
});

test("pane surfaces reveal only after stable frames and persistent hosts move without remounting", async () => {
  installDom();
  let pointerCaptures = 0;
  const Stateful = () => React.createElement("input", { defaultValue: "initial" });
  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement("div", { id: "portal-a" }),
      React.createElement("div", { id: "portal-b" }),
      React.createElement(PaneSurfaceGate, { ready: false, label: "Preparing…" },
        React.createElement("div", { className: "prepared-content" }, "Prepared")),
      React.createElement(PersistentPanePortal, {
        targetId: "portal-a",
        onPointerDownCapture: () => { pointerCaptures += 1; },
      },
        React.createElement(Stateful)),
    ));
  });
  const gated = document.querySelector(".pane-surface-gate-content");
  assert.equal(gated?.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(
    '.pane-surface-gate .desktop-loading-surface',
  )?.getAttribute("aria-label"), "Preparing…");
  const input = document.querySelector("#portal-a input");
  input.value = "preserved";
  input.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  assert.equal(pointerCaptures, 1,
    "pointer capture must run on the physical portal host");

  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement("div", { id: "portal-a" }),
      React.createElement("div", { id: "portal-b" }),
      React.createElement(PaneSurfaceGate, { ready: true, label: "Preparing…" },
        React.createElement("div", { className: "prepared-content" }, "Prepared")),
      React.createElement(PersistentPanePortal, {
        targetId: "portal-b",
        onPointerDownCapture: () => { pointerCaptures += 1; },
      },
        React.createElement(Stateful)),
    ));
  });
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  });
  assert.equal(document.querySelector(".pane-surface-gate-content")?.hasAttribute("aria-hidden"), false);
  assert.equal(document.querySelector(".pane-surface-gate [role='status']"), null);
  assert.equal(document.querySelector("#portal-b input"), input,
    "moving a persistent surface must retain the exact DOM subtree");
  assert.equal(input.value, "preserved");
  input.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  assert.equal(pointerCaptures, 2,
    "pointer capture must survive moving the persistent host");
});

test("markdown fallback renders fenced scripts in final mono block grammar", async () => {
  installDom();
  await act(async () => root.render(React.createElement(
    "div",
    { className: "markdown" },
    React.createElement(MarkdownSourceFallback, {
      text: "Before\n\n```ts\nconst value = 1;\n```\n\nAfter",
    }),
  )));
  assert.deepEqual(
    Array.from(document.querySelectorAll(".markdown-plain"), (node) => node.textContent.trim()),
    ["Before", "After"],
  );
  const block = document.querySelector(".markdown-code-fallback");
  assert.equal(block?.querySelector("header")?.textContent, "ts");
  assert.equal(block?.querySelector("code")?.className, "language-ts");
  assert.equal(block?.querySelector("code")?.textContent.trim(), "const value = 1;");
  assert.doesNotMatch(document.querySelector(".markdown")?.textContent || "", /```/,
    "fence markers must not appear and then disappear when the rich AST lands");

  await act(async () => root.render(React.createElement(
    "div",
    { className: "markdown" },
    React.createElement(MarkdownSourceFallback, {
      text: "```powershell\nWrite-Host 'streaming'",
    }),
  )));
  const liveBlock = document.querySelector(".markdown-code-fallback");
  assert.equal(liveBlock?.querySelector("header")?.textContent, "powershell");
  assert.equal(liveBlock?.querySelector("code")?.textContent.trim(), "Write-Host 'streaming'",
    "an open streaming fence must use mono code metrics before it closes");

  await act(async () => root.render(React.createElement(
    "div",
    { className: "markdown" },
    React.createElement(MarkdownSourceFallback, {
      text: "```js\nconst value = 1;\n``",
    }),
  )));
  assert.equal(document.querySelector("code")?.textContent, "const value = 1;",
    "a partial closing fence must never appear as a temporary code row");
  assert.equal(document.querySelector(".markdown-plain")?.tagName, undefined);
});

test("streamed fenced scripts retain one code wrapper through promotion and settlement", async () => {
  installDom();
  await preloadStreamingMarkdownBody();
  const renderResponse = async (text, streaming) => act(async () => {
    root.render(React.createElement(MarkdownResponse, { text, streaming }));
    await Promise.resolve();
  });
  const open = "Before\n\n```js\nconst value = 1;";
  await renderResponse(open, true);
  const codeBlock = document.querySelector(".markdown-code");
  assert.ok(codeBlock);
  assert.equal(document.querySelector(".stream-cursor"), null,
    "streaming status must not allocate an anonymous line box");

  const promoted = `${open}\n\`\`\`\n\nD`;
  await renderResponse(promoted, true);
  assert.equal(document.querySelector(".markdown-code"), codeBlock,
    "unstable-to-stable promotion must preserve the code wrapper");

  await renderResponse(promoted, false);
  assert.equal(document.querySelector(".markdown-code"), codeBlock,
    "settlement must preserve the code wrapper");
});

test("active conversation DOM survives pane reparenting, sibling deletion, and slot moves", async () => {
  installDom();
  const selections = Object.fromEntries(["a", "b", "c"].map((id) => [
    id,
    { kind: "session", id: `persistent-${id}` },
  ]));
  const leaf = (id, selection = selections[id]) => ({
    type: "leaf",
    id: `persistent_leaf_${id}`,
    tabs: [selection],
    activeKey: `session:${selection.id}`,
  });
  const leaves = {
    a: leaf("a"),
    b: leaf("b"),
    c: leaf("c"),
  };
  const mounts = new Map();
  function StatefulConversation({ selection }) {
    React.useEffect(() => {
      mounts.set(selection.id, (mounts.get(selection.id) || 0) + 1);
    }, [selection.id]);
    return React.createElement("div", {
      className: "persistent-conversation-probe",
      "data-session-id": selection.id,
    }, React.createElement("input", { defaultValue: selection.id }));
  }
  const workspaceFor = (layout, focusedLeafId) => ({
    layout,
    leaves: (() => {
      const collect = (node) => node.type === "leaf"
        ? [node]
        : [...collect(node.first), ...collect(node.second)];
      return collect(layout);
    })(),
    focusedLeaf: null,
    focusedLeafId,
    focusLeaf() {},
    setRatio() {},
  });
  const renderWorkspace = (layout, focusedLeafId = leaves.a.id) =>
    React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace: workspaceFor(layout, focusedLeafId),
        renderActive: () => React.createElement("div"),
        renderConversation: (selection) =>
          React.createElement(StatefulConversation, { selection }),
        onFocusSelection() {},
      }));
  const initial = {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaves.a,
    second: {
      type: "split",
      direction: "column",
      ratio: 0.5,
      first: leaves.b,
      second: leaves.c,
    },
  };
  await act(async () => root.render(renderWorkspace(initial)));
  const conversation = document.querySelector(
    '[data-pane-id="persistent_leaf_c"] .persistent-conversation-probe',
  );
  const input = conversation.querySelector("input");
  input.value = "preserved";
  assert.equal(mounts.get(selections.c.id), 1);

  const collapsed = {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: leaves.a,
    second: leaves.c,
  };
  await act(async () => root.render(renderWorkspace(collapsed)));
  assert.equal(document.querySelector(
    '[data-pane-id="persistent_leaf_c"] .persistent-conversation-probe',
  ), conversation, "deleting pane B must move pane C without remounting its conversation");
  assert.equal(conversation.querySelector("input"), input);
  assert.equal(input.value, "preserved");

  const movedLeaf = leaf("moved_c", selections.c);
  const moved = {
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: leaves.a,
    second: movedLeaf,
  };
  await act(async () => root.render(renderWorkspace(moved)));
  assert.equal(document.querySelector(
    '[data-pane-id="persistent_leaf_moved_c"] .persistent-conversation-probe',
  ), conversation, "moving a session into a newly created leaf must retain its conversation DOM");
  assert.equal(mounts.get(selections.c.id), 1);
  assert.equal(document.querySelector(".pane-surface-cover"), null,
    "a warm persistent conversation must not flash an opaque cover");
});

test("switching session tabs in one pane preserves the conversation DOM owner", async () => {
  installDom();
  const first = { kind: "session", id: "foreground-one" };
  const second = { kind: "session", id: "foreground-two" };
  let mounts = 0;
  function ConversationProbe({ selection }) {
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return React.createElement("div", {
      className: "foreground-conversation-probe",
      "data-session-id": selection.id,
    }, React.createElement("input", { defaultValue: selection.id }));
  }
  const renderWorkspace = (active) => {
    const leaf = {
      type: "leaf",
      id: "foreground_leaf",
      tabs: [first, second],
      activeKey: `session:${active.id}`,
    };
    const workspace = {
      layout: leaf,
      leaves: [leaf],
      focusedLeaf: leaf,
      focusedLeafId: leaf.id,
      focusLeaf() {},
      setRatio() {},
    };
    return React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: (selection) =>
          React.createElement(ConversationProbe, { selection }),
        onFocusSelection() {},
      }));
  };

  await act(async () => root.render(renderWorkspace(first)));
  const conversation = document.querySelector(".foreground-conversation-probe");
  const input = conversation.querySelector("input");
  input.value = "preserved";

  await act(async () => root.render(renderWorkspace(second)));
  assert.equal(document.querySelector(".foreground-conversation-probe"), conversation);
  assert.equal(conversation.getAttribute("data-session-id"), second.id);
  assert.equal(conversation.querySelector("input"), input);
  assert.equal(input.value, "preserved");
  assert.equal(mounts, 1, "foreground tab selection must update props without remounting");
});

test("Studio parks one painted conversation layer without changing its DOM or scroll geometry", async () => {
  installDom();
  const session = { kind: "session", id: "parked-conversation" };
  const studio = { kind: "studio", id: "parked-studio" };
  let mounts = 0;
  let unmounts = 0;
  function ConversationProbe() {
    React.useEffect(() => {
      mounts += 1;
      return () => { unmounts += 1; };
    }, []);
    return React.createElement("div", { className: "parked-conversation-probe" },
      React.createElement("div", { className: "parked-scroll-probe" },
        React.createElement("code", { className: "parked-script-probe" }, "const stable = true;")));
  }
  const renderWorkspace = (active) => {
    const leaf = {
      type: "leaf",
      id: "parked_conversation_leaf",
      tabs: [session, studio],
      activeKey: navigationKey(active),
    };
    const workspace = {
      layout: leaf,
      leaves: [leaf],
      focusedLeaf: leaf,
      focusedLeafId: leaf.id,
      focusLeaf() {},
      setRatio() {},
    };
    return React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: () => React.createElement(ConversationProbe),
        renderUtilityTabs: (paneLeaf) => paneLeaf.activeKey === navigationKey(studio)
          ? React.createElement("div", { className: "parked-studio-probe" })
          : null,
        onFocusSelection() {},
      }));
  };
  const settleHandoff = () => act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await Promise.resolve();
  });

  await act(async () => root.render(renderWorkspace(session)));
  const conversation = document.querySelector(".parked-conversation-probe");
  const slot = conversation.closest(".pane-conversation-slot");
  const scroll = conversation.querySelector(".parked-scroll-probe");
  const script = conversation.querySelector(".parked-script-probe");
  scroll.scrollTop = 2588;

  act(() => { flushSync(() => root.render(renderWorkspace(studio))); });
  assert.equal(conversation.closest(".pane-conversation-slot"), slot);
  assert.equal(conversation.querySelector(".parked-script-probe"), script);
  assert.equal(scroll.scrollTop, 2588);
  await settleHandoff();
  assert.equal(conversation.closest(".pane-conversation-slot"), slot);
  assert.equal(slot?.dataset.conversationParked, "true");
  assert.equal(slot?.getAttribute("aria-hidden"), "true");
  assert.equal(slot?.hasAttribute("inert"), true);
  assert.equal(conversation.querySelector(".parked-script-probe"), script);
  assert.equal(scroll.scrollTop, 2588);
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);

  act(() => { flushSync(() => root.render(renderWorkspace(session))); });
  assert.equal(conversation.closest(".pane-conversation-slot"), slot);
  assert.equal(conversation.querySelector(".parked-script-probe"), script);
  assert.equal(scroll.scrollTop, 2588);
  await settleHandoff();
  assert.equal(slot?.hasAttribute("data-conversation-parked"), false);
  assert.equal(slot?.hasAttribute("aria-hidden"), false);
  assert.equal(conversation.querySelector(".parked-script-probe"), script);
  assert.equal(scroll.scrollTop, 2588);
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);
});

test("pane surface changes retain editor, utility and agent DOM for one frame only", async () => {
  installDom();
  const file = { kind: "file", project: "C:\\work", rel: "src/a.ts" };
  const session = { kind: "session", id: "handoff-session" };
  const utility = { kind: "studio", id: "handoff-studio" };
  const agent = { kind: "agent-session", id: "handoff-agent", title: "Handoff agent" };
  let editorUnmounts = 0;
  let utilityUnmounts = 0;
  let agentUnmounts = 0;
  function EditorProbe() {
    React.useEffect(() => () => { editorUnmounts += 1; }, []);
    return React.createElement("div", { className: "one-frame-editor" },
      React.createElement("input", { defaultValue: "editor state" }));
  }
  function UtilityProbe() {
    React.useEffect(() => () => { utilityUnmounts += 1; }, []);
    return React.createElement("div", { className: "one-frame-utility" },
      React.createElement("input", { defaultValue: "utility state" }));
  }
  function AgentProbe() {
    React.useEffect(() => () => { agentUnmounts += 1; }, []);
    return React.createElement("div", { className: "one-frame-agent" },
      React.createElement("input", { defaultValue: "agent state" }));
  }
  const renderWorkspace = (active) => {
    const leaf = {
      type: "leaf",
      id: "handoff_leaf",
      tabs: [file, session, utility, agent],
      activeKey: navigationKey(active),
    };
    const workspace = {
      layout: leaf,
      leaves: [leaf],
      focusedLeaf: leaf,
      focusedLeafId: leaf.id,
      focusLeaf() {},
      setRatio() {},
    };
    return React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: () => React.createElement("div", { className: "one-frame-conversation" }),
        renderFileEditors: (paneLeaf) => paneLeaf.activeKey === navigationKey(file)
          ? React.createElement(EditorProbe)
          : null,
        renderUtilityTabs: (paneLeaf) => paneLeaf.activeKey === navigationKey(utility)
          ? React.createElement(UtilityProbe)
          : null,
        renderAgentSession: () => React.createElement(AgentProbe),
        onFocusSelection() {},
      }));
  };
  const settleHandoff = () => act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await Promise.resolve();
  });

  await act(async () => root.render(renderWorkspace(file)));
  const editor = document.querySelector(".one-frame-editor");
  const input = editor.querySelector("input");
  input.value = "preserved";

  act(() => {
    flushSync(() => root.render(renderWorkspace(session)));
  });
  assert.equal(document.querySelector(".one-frame-editor"), editor,
    "the outgoing editor DOM must survive the transition commit");
  assert.equal(editor.querySelector("input"), input);
  assert.equal(input.value, "preserved");
  assert.ok(editor.closest('[data-pane-surface-handoff="true"]'));
  assert.ok(document.querySelector(".one-frame-conversation"),
    "the incoming surface mounts behind the one-frame handoff");

  await settleHandoff();
  assert.equal(document.querySelector(".one-frame-editor"), null,
    "inactive editor state must not remain resident past one frame");
  assert.equal(editorUnmounts, 1);
  assert.ok(document.querySelector(".one-frame-conversation"));

  act(() => {
    flushSync(() => root.render(renderWorkspace(utility)));
  });
  await settleHandoff();
  const utilityNode = document.querySelector(".one-frame-utility");
  const utilityInput = utilityNode.querySelector("input");
  utilityInput.value = "preserved utility";
  act(() => {
    flushSync(() => root.render(renderWorkspace(session)));
  });
  assert.equal(document.querySelector(".one-frame-utility"), utilityNode,
    "the outgoing utility DOM must stay composed during the transition commit");
  assert.equal(utilityNode.querySelector("input"), utilityInput);
  assert.equal(utilityInput.value, "preserved utility");
  assert.ok(utilityNode.closest('[data-pane-surface-handoff="true"]'));
  await settleHandoff();
  assert.equal(document.querySelector(".one-frame-utility"), null);
  assert.equal(utilityUnmounts, 1,
    "the utility handoff must retire after one frame");

  act(() => {
    flushSync(() => root.render(renderWorkspace(agent)));
  });
  await settleHandoff();
  const agentNode = document.querySelector(".one-frame-agent");
  const agentInput = agentNode.querySelector("input");
  agentInput.value = "preserved agent";
  act(() => {
    flushSync(() => root.render(renderWorkspace(session)));
  });
  assert.equal(document.querySelector(".one-frame-agent"), agentNode,
    "the outgoing agent DOM must stay composed during the transition commit");
  assert.equal(agentNode.querySelector("input"), agentInput);
  assert.equal(agentInput.value, "preserved agent");
  assert.ok(agentNode.closest('[data-pane-surface-handoff="true"]'));
  await settleHandoff();
  assert.equal(document.querySelector(".one-frame-agent"), null);
  assert.equal(agentUnmounts, 1,
    "the agent handoff must retire after one frame");
});

test("transcript rows apply a final display guard to internal control messages", async () => {
  installDom();
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(TranscriptRow, {
      item: {
        id: "system-reminder",
        kind: "user",
        text: "<system-reminder>internal only</system-reminder>",
      },
    }),
    React.createElement(TranscriptRow, {
      item: {
        id: "async-completion",
        kind: "user",
        text: [
          "The async shell task job_hidden has finished (completed, exit 0) - review this result in your next step.",
          "",
          "Result:",
          "> background task",
          "> task_id: job_hidden",
          "> status: completed",
        ].join("\n"),
      },
    }),
    React.createElement(TranscriptRow, {
      item: {
        id: "visible-user",
        kind: "user",
        text: "Visible user message",
      },
    }),
  )));
  assert.equal(document.querySelectorAll(".message.user").length, 1);
  assert.equal(document.querySelector(".message.user")?.textContent?.trim(), "Visible user message");
});

test("heavy surfaces mount only while active", async () => {
  installDom();
  let mounts = 0;
  const Stateful = () => {
    React.useEffect(() => { mounts += 1; }, []);
    return React.createElement("input", { defaultValue: "retained" });
  };
  const surface = (active) => React.createElement(
    DeferredPersistentSurface,
    { active },
    React.createElement(Stateful),
  );
  await act(async () => root.render(surface(false)));
  assert.equal(document.querySelector("input"), null);
  assert.equal(mounts, 0);
  await act(async () => root.render(surface(true)));
  const input = document.querySelector("input");
  assert.ok(input);
  assert.equal(mounts, 1);
  input.value = "preserved";
  await act(async () => root.render(surface(false)));
  assert.equal(document.querySelector("input"), null);
  assert.equal(mounts, 1);
  await act(async () => root.render(surface(true)));
  assert.notEqual(document.querySelector("input"), input);
  assert.equal(mounts, 2);
});

test("restored heavy surfaces wait for the shown window and unmount when inactive", async () => {
  installDom({ windowShown: false });
  let mounts = 0;
  const Stateful = () => {
    React.useEffect(() => { mounts += 1; }, []);
    return React.createElement("input", { defaultValue: "retained" });
  };
  const surface = (active) => React.createElement(
    DeferredPersistentSurface,
    {
      active,
      startupDelayMs: 0,
      fallback: React.createElement("div", { className: "startup-slot" }, "Loading"),
    },
    React.createElement(Stateful),
  );
  await act(async () => root.render(surface(true)));
  assert.equal(document.querySelector("input"), null);
  assert.ok(document.querySelector(".startup-slot"));
  assert.equal(mounts, 0);

  await act(async () => {
    window.dispatchEvent(new Event("mixdog:window-shown"));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  const input = document.querySelector("input");
  assert.ok(input);
  assert.equal(mounts, 1);
  await act(async () => root.render(surface(false)));
  assert.equal(document.querySelector("input"), null);
  assert.equal(mounts, 1);
});

test("ready cached surfaces stay visible across transition keys and remounts", async () => {
  installDom();
  const surface = (transitionKey, key) => React.createElement(
    PaneSurfaceGate,
    { key, ready: true, label: "Preparing cached…", transitionKey },
    React.createElement("div", { className: "cached-surface" }, transitionKey),
  );
  await act(async () => root.render(surface("session-a", "stable")));
  const first = document.querySelector(".cached-surface");
  assert.equal(document.querySelector(".pane-surface-gate")?.dataset.ready, "true");
  assert.equal(document.querySelector(".pane-surface-gate [role='status']"), null);

  await act(async () => root.render(surface("session-b", "stable")));
  assert.equal(document.querySelector(".cached-surface"), first);
  assert.equal(document.querySelector(".pane-surface-gate")?.dataset.ready, "true");
  assert.equal(document.querySelector(".pane-surface-gate [role='status']"), null);

  await act(async () => root.render(surface("session-c", "remounted")));
  assert.equal(document.querySelector(".pane-surface-gate")?.dataset.ready, "true");
  assert.equal(document.querySelector(".pane-surface-gate [role='status']"), null);
});

test("dropdown updates preserve an already revealed frame while a new target can still start cold", async () => {
  installDom();
  function Surface({ transitionKey }) {
    const [ready, setReady] = React.useState(true);
    const [value, setValue] = React.useState("a");
    return React.createElement(PaneSurfaceGate, {
      ready,
      transitionKey,
      label: "Preparing dropdown…",
    }, React.createElement("div", { className: "dropdown-frame" },
      React.createElement(OpenSelect, {
        ariaLabel: "Frame-safe select",
        value,
        options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
        onChange(next) {
          setValue(next);
          setReady(false);
        },
      })));
  }
  await act(async () => root.render(React.createElement(Surface, { transitionKey: "same" })));
  const frame = document.querySelector(".dropdown-frame");
  const trigger = document.querySelector('[aria-label="Frame-safe select"]');
  await act(async () => trigger.click());
  await act(async () => Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("Beta"))?.click());
  assert.equal(document.querySelector(".dropdown-frame"), frame);
  assert.equal(document.querySelector('[aria-label="Frame-safe select"]'), trigger);
  assert.equal(trigger.textContent.includes("Beta"), true);
  assert.equal(document.querySelector(".pane-surface-gate")?.dataset.ready, "true");
  assert.equal(document.querySelector(".pane-surface-gate [role='status']"), null);

  await act(async () => root.render(React.createElement(PaneSurfaceGate, {
    ready: false,
    transitionKey: "new-target",
    label: "Preparing dropdown…",
  }, React.createElement("div", { className: "new-target" }))));
  assert.equal(document.querySelector(".pane-surface-gate")?.dataset.ready, "false");
  assert.ok(document.querySelector(".pane-surface-gate [role='status']"));
});

test("warm stable content swaps replace atomically without an outgoing frame", async () => {
  installDom();
  let releaseFonts;
  const fontsReady = new Promise((resolve) => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: fontsReady },
  });
  const surface = (key) => React.createElement(
    StableContentSwap,
    { transitionKey: key },
    React.createElement("div", { className: `surface-${key}` }, key),
  );
  await act(async () => root.render(surface("a")));
  await act(async () => root.render(surface("b")));
  assert.equal(document.querySelector(".surface-a"), null);
  assert.equal(document.querySelector(".surface-b")?.closest(".stable-content-swap-layer")
    ?.dataset.surfaceActive, "true");

  await act(async () => root.render(surface("c")));
  assert.equal(document.querySelector(".surface-b"), null,
    "the outgoing warm surface must be removed in the replacement commit");
  assert.equal(document.querySelector(".surface-c")?.closest(".stable-content-swap-layer")
    ?.dataset.surfaceActive, "true");
  releaseFonts();
});

test("cold stable content swaps retain the font and composed-frame guard", async () => {
  installDom();
  let releaseFonts;
  const fontsReady = new Promise((resolve) => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: fontsReady },
  });
  const surface = (key, ready) => React.createElement(
    StableContentSwap,
    { transitionKey: key, ready },
    React.createElement("div", { className: `cold-surface-${key}` }, key),
  );
  await act(async () => root.render(surface("a", true)));
  await act(async () => root.render(surface("b", false)));
  await act(async () => root.render(surface("b", true)));
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(resolve)));
  assert.ok(document.querySelector(".stable-content-swap > .pane-surface-cover"),
    "a cold request must cover the outgoing surface instead of exposing it");
  assert.equal(document.querySelector(".cold-surface-a")?.closest(".stable-content-swap-layer")
    ?.dataset.surfaceActive, "true");
  assert.equal(document.querySelector(".cold-surface-b")?.closest(".stable-content-swap-layer")
    ?.dataset.surfaceActive, "false");
  releaseFonts();
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))));
  assert.equal(document.querySelector(".cold-surface-a"), null);
  assert.equal(document.querySelector(".cold-surface-b")?.closest(".stable-content-swap-layer")
    ?.dataset.surfaceActive, "true");
});

test("startup reconciliation peeks through an already populated stale lane", async () => {
  installDom();
  const sessionId = "stale-lane-reconcile";
  defaultSessionLaneStore.clear();
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: {
      sessionId,
      items: [{ id: "stale", kind: "assistant", text: "stale busy frame" }],
      busy: true,
      queued: [],
    },
  });
  let peeks = 0;
  window.mixdogDesktop = {
    peekSession: async (id) => {
      peeks += 1;
      defaultSessionLaneStore.apply({
        sessionId: id,
        snapshot: {
          sessionId: id,
          items: [{ id: "recovered", kind: "assistant", text: "interrupted after restart" }],
          busy: false,
          queued: [],
        },
      });
      return true;
    },
  };
  requestSessionPeek(sessionId, { reconcile: true });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 5));
  });
  assert.equal(peeks, 1, "an existing renderer lane must not suppress startup host reconciliation");
  assert.equal(defaultSessionLaneStore.get(sessionId)?.busy, false);
  assert.match(defaultSessionLaneStore.get(sessionId)?.items?.[0]?.text || "", /interrupted/);
  defaultSessionLaneStore.clear();
});

test("a fully missing agent session stops loading and can retry", async () => {
  installDom();
  const sessionId = "fully-missing-agent-session";
  defaultSessionLaneStore.clear();
  let peeks = 0;
  let recover = false;
  window.mixdogDesktop = {
    peekSession: async (id) => {
      peeks += 1;
      if (!recover) return false;
      defaultSessionLaneStore.apply({
        sessionId: id,
        snapshot: {
          sessionId: id,
          items: [{ id: "recovered", kind: "assistant", text: "Recovered after retry" }],
          busy: false,
          queued: [],
        },
      });
      return true;
    },
  };
  await act(async () => {
    root.render(React.createElement(AgentSessionConversation, { sessionId }));
  });
  await waitForDom(
    () => Boolean(document.querySelector(".agent-session-unavailable")),
    "missing agent session should leave the loading state",
  );
  assert.equal(peeks, 3, "missing agent hydration uses bounded retries");
  assert.match(document.querySelector(".agent-session-unavailable")?.textContent || "",
    /Agent session record unavailable.*Retry/);

  recover = true;
  await act(async () => {
    document.querySelector(".agent-session-unavailable button")?.click();
  });
  await waitForDom(
    () => Boolean(document.querySelector(".message.assistant")),
    "retry should reveal a later recovered transcript",
  );
  assert.match(document.querySelector(".message.assistant")?.textContent || "", /Recovered after retry/);
  assert.equal(document.querySelector(".agent-session-unavailable"), null);
  defaultSessionLaneStore.clear();
});

test("an unfocused pane header reconciles a cached lane and paints its own cold context", async () => {
  installDom();
  const sessionId = "unfocused-header-context";
  defaultSessionLaneStore.clear();
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: {
      sessionId,
      items: [{ id: "cold", kind: "assistant", text: "cold transcript" }],
      stats: { currentEstimatedContextTokens: 100 },
      displayContextWindow: 1_000,
      busy: false,
      queued: [],
    },
  });
  let peeks = 0;
  window.mixdogDesktop = {
    peekSession: async (id) => {
      peeks += 1;
      defaultSessionLaneStore.apply({
        sessionId: id,
        snapshot: {
          sessionId: id,
          items: [{ id: "cold", kind: "assistant", text: "cold transcript" }],
          stats: {
            currentContextTokens: 0,
            currentEstimatedContextTokens: 600,
            currentContextSource: "estimated",
          },
          displayContextWindow: 1_000,
          busy: false,
          queued: [],
        },
      });
      return true;
    },
  };
  await act(async () => {
    root.render(React.createElement(PaneHeaderStatus, {
      focused: false,
      sessionId,
      fallback: null,
      snapshotStore: createDesktopSnapshotStore(),
      frozenSnapshot: null,
      hidden: false,
      onOpen() {},
      onRemoteChange() {},
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
  const usage = document.querySelector('.session-context-indicator [role="tooltip"]')
    ?.textContent?.replace(/\s+/g, "") || "";
  assert.equal(peeks, 1, "header ownership must reconcile without waiting for pane focus");
  assert.match(usage, /Usage60%Tokens\(est\.\)600\/1,000/);
  defaultSessionLaneStore.clear();
});

test("focused and unfocused panes render the identical failed-turn contract", async () => {
  installDom();
  const sessionId = "pane-failure-parity";
  const raw = {
    sessionId,
    cwd: "C:\\work",
    items: [
      { id: "user-failed", kind: "user", text: "retry this" },
      { id: "done-failed", kind: "turndone", status: "failed" },
    ],
    queued: [],
    busy: false,
    commandBusy: false,
  };
  defaultSessionLaneStore.clear();
  defaultSessionLaneStore.apply({ sessionId, snapshot: raw });
  const selected = createTranscriptSnapshotDecorator().decorate(raw);
  const snapshotStore = {
    getSnapshot: () => selected,
    subscribe: () => () => {},
  };
  window.mixdogDesktop = {};
  const props = {
    focused: false,
    sessionId,
    fallback: null,
    snapshotStore,
    frozenSnapshot: null,
    hidden: false,
    invoke: async (action) => { await action(); },
    invokeResult: async (action) => await action(),
    errors: ["Shared renderer error"],
    submit: async () => null,
    applySnapshot() {},
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenSettings() {},
    projects: [],
    showProjectSelector: false,
    activeProjectPath: "C:\\work",
    activeProjectLabel: "work",
    onSelectProject() {},
    onChooseProject() {},
    onOpenCommandSurface() {},
  };
  await act(async () => root.render(React.createElement(PaneConversation, props)));
  const conversation = document.querySelector(".conversation");
  const failureText = () => (document.querySelector(".turn-status.failed")?.textContent || "")
    .replace(/\s+/g, "");
  assert.equal(failureText(), "FailedRetry");
  assert.match(document.querySelector(".inline-error")?.textContent || "", /Shared renderer error/);

  await act(async () => {
    defaultSessionLaneStore.apply({
      sessionId,
      snapshot: {
        ...raw,
        items: [
          { id: "user-failed", kind: "user", text: "updated while unfocused" },
          { id: "done-failed", kind: "turndone", status: "failed" },
        ],
        queued: [{ id: "background-queue", displayText: "queued while unfocused" }],
      },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  assert.match(document.querySelector(".message.user")?.textContent || "", /updated while unfocused/,
    "an unfocused pane must render subsequent transcript lane frames");
  assert.equal(document.querySelector(".queue-item-text")?.textContent, "queued while unfocused",
    "an unfocused pane must render subsequent queue lane frames");

  await act(async () => root.render(React.createElement(PaneConversation, {
    ...props,
    hidden: true,
  })));
  assert.equal(defaultSessionLaneStore.stats().subscribedSessions, 0,
    "hidden conversations must release their live lane subscriptions");
  await act(async () => {
    defaultSessionLaneStore.apply({
      sessionId,
      snapshot: {
        ...raw,
        items: [
          { id: "hidden-update", kind: "user", text: "latest hidden frame" },
          { id: "hidden-done", kind: "turndone", status: "failed" },
        ],
        queued: [],
      },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });

  await act(async () => root.render(React.createElement(PaneConversation, {
    ...props,
    focused: true,
  })));
  assert.equal(document.querySelector(".conversation"), conversation,
    "focus must not replace the pane's Conversation tree");
  assert.equal(failureText(), "FailedRetry");
  assert.equal(document.querySelectorAll('[aria-label="Retry failed turn"]').length, 1);
  assert.match(document.querySelector(".inline-error")?.textContent || "", /Shared renderer error/);
  assert.match(document.querySelector(".message.user")?.textContent || "", /latest hidden frame/,
    "showing a paused conversation must adopt the latest retained lane once");
  await act(async () => root.render(React.createElement(PaneConversation, {
    ...props,
    hidden: true,
  })));
  assert.equal(defaultSessionLaneStore.stats().subscribedSessions, 0,
    "the parity fixture must release its process-global lane before the next test");
  defaultSessionLaneStore.clear();
});

test("cold session panes stay covered until their authoritative transcript is stable", async () => {
  installDom();
  const sessionId = "cold-pane-stable-reveal";
  defaultSessionLaneStore.clear();
  let peeks = 0;
  window.mixdogDesktop = {
    subscribeSessionState: () => () => {},
    peekSession: async () => {
      peeks += 1;
      return true;
    },
  };
  const stopLane = defaultSessionLaneStore.start();
  const coldSelectedSnapshot = { sessionId: "", items: [], queued: [] };
  const snapshotStore = {
    getSnapshot: () => coldSelectedSnapshot,
    subscribe: () => () => {},
  };
  const props = {
    focused: false,
    sessionId,
    fallback: { sessionId, items: [], queued: [] },
    snapshotStore,
    frozenSnapshot: null,
    hidden: false,
    transcriptPending: true,
    invoke: async (action) => { await action(); },
    invokeResult: async (action) => await action(),
    errors: [],
    submit: async () => null,
    applySnapshot() {},
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenSettings() {},
    projects: [],
    showProjectSelector: false,
    activeProjectPath: "C:\\work",
    activeProjectLabel: "work",
    onSelectProject() {},
    onChooseProject() {},
    onOpenCommandSurface() {},
  };
  await act(async () => root.render(React.createElement(PaneConversation, props)));
  assert.ok(document.querySelector(".pane-surface-cover"),
    "a cold session must not expose its empty transcript before hydration");
  assert.equal(peeks, 1, "cold hydration must start without waiting for pane focus");

  await act(async () => {
    defaultSessionLaneStore.apply({
      sessionId,
      snapshot: {
        sessionId,
        items: [{ id: "cold-ready", kind: "assistant", text: "Ready without focus" }],
        queued: [],
        busy: false,
      },
    });
    root.render(React.createElement(PaneConversation, {
      ...props,
      transcriptPending: false,
    }));
  });
  for (let attempt = 0;
    attempt < 10 && document.querySelector(".pane-surface-cover");
    attempt += 1) {
    await settleStableSurfaceSwitch();
  }
  assert.equal(document.querySelector(".pane-surface-cover"), null);
  assert.match(document.querySelector(".message.assistant")?.textContent || "", /Ready without focus/);
  stopLane();
  defaultSessionLaneStore.clear();
});

test("session pane content is identical across focus changes and updates only from its lane", async () => {
  installDom();
  const sessionId = "focused-first-entry";
  defaultSessionLaneStore.clear();
  window.mixdogDesktop = {
    subscribeSessionState: () => () => {},
    peekSession: async () => true,
  };
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: {
      sessionId,
      items: [{ id: "lane-first", kind: "assistant", text: "Stable lane content" }],
      queued: [],
      busy: false,
    },
  });
  const selected = {
    sessionId,
    items: [{ id: "selected-first", kind: "assistant", text: "Focus-only content must never paint" }],
    queued: [],
    busy: false,
  };
  const snapshotStore = {
    getSnapshot: () => selected,
    subscribe: () => () => {},
  };
  const props = {
    focused: false,
    sessionId,
    fallback: null,
    snapshotStore,
    frozenSnapshot: null,
    hidden: false,
    transcriptPending: false,
    invoke: async (action) => { await action(); },
    invokeResult: async (action) => await action(),
    errors: [],
    submit: async () => null,
    applySnapshot() {},
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenSettings() {},
    projects: [],
    showProjectSelector: false,
    activeProjectPath: "C:\\work",
    activeProjectLabel: "work",
    onSelectProject() {},
    onChooseProject() {},
    onOpenCommandSurface() {},
  };
  await act(async () => root.render(React.createElement(PaneConversation, props)));
  const conversation = document.querySelector(".conversation");
  const row = document.querySelector(".message.assistant");
  assert.match(document.querySelector(".message.assistant")?.textContent || "",
    /Stable lane content/);
  await act(async () => root.render(React.createElement(PaneConversation, {
    ...props,
    focused: true,
  })));
  assert.equal(document.querySelector(".conversation"), conversation,
    "focus must not replace the Conversation root");
  assert.equal(document.querySelector(".message.assistant"), row,
    "focus must not replace an already rendered transcript row");
  assert.match(document.querySelector(".message.assistant")?.textContent || "",
    /Stable lane content/);
  assert.doesNotMatch(document.querySelector(".conversation")?.textContent || "",
    /Focus-only content/);
  await act(async () => {
    defaultSessionLaneStore.apply({
      sessionId,
      snapshot: {
        sessionId,
        items: [{ id: "lane-first", kind: "assistant", text: "Lane updated while focused" }],
        queued: [],
        busy: false,
      },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  assert.match(document.querySelector(".message.assistant")?.textContent || "",
    /Lane updated while focused/,
    "the same lane keeps streaming while focused");
  defaultSessionLaneStore.clear();
});

test("git diff cold panels report ready only after their data is committed", async () => {
  installDom();
  let resolveDiff;
  let ready = 0;
  window.mixdogDesktop = {
    gitDiff: () => new Promise((resolve) => { resolveDiff = resolve; }),
  };
  await act(async () => root.render(React.createElement(GitDiffPane, {
    selection: {
      kind: "diff",
      project: "C:\\work",
      rel: "src/example.ts",
      source: "unstaged",
    },
    active: true,
    onReady: () => { ready += 1; },
  })));
  assert.equal(ready, 0);
  assert.match(document.querySelector(".workspace-git-diff-state")?.textContent || "", /Loading diff/);
  await act(async () => {
    resolveDiff("@@ -1 +1 @@\n-old\n+new");
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(() => ready === 1,
    "git diff should report ready after both data and the rich diff module settle");
  assert.equal(ready, 1);
  assert.equal(document.querySelector(".workspace-git-diff-state"), null);
});

test("desktop error boundary replaces a fatal blank frame and reports bounded evidence", async () => {
  installDom();
  const diagnostics = [];
  window.mixdogDesktop = {
    rendererDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const ThrowingView = () => {
    throw new TypeError("private prompt text must not cross diagnostics");
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      root.render(React.createElement(
        DesktopErrorBoundary,
        null,
        React.createElement(ThrowingView),
      ));
    });
  } finally {
    console.error = originalConsoleError;
  }
  const recovery = document.querySelector(".desktop-recovery-screen");
  assert.ok(recovery, "fatal render errors should leave a recovery screen");
  assert.match(recovery.textContent, /Reload interface/);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, "boundary");
  assert.equal(diagnostics[0].errorName, "TypeError");
  assert.match(diagnostics[0].fingerprint, /^[a-f0-9]{8}$/);
  assert.equal(diagnostics[0].components.includes("ThrowingView"), true);
  assert.equal("message" in diagnostics[0], false, "diagnostics must omit thrown messages");
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
  const region = document.querySelector(".mx-toast-region");
  assert.ok(region, "toast region renders");
  assert.equal(region.style.top !== "", true, "toast region is top-anchored");
  assert.equal(region.style.bottom, "", "toast region has no bottom anchor");
});

test("mobile toast region keeps the desktop top-right anchor", async () => {
  installDom();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  const originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains("workspace")) {
      return {
        x: 0, y: 24, top: 24, right: 390, bottom: 760, left: 0,
        width: 390, height: 736, toJSON: () => ({}),
      };
    }
    return originalGetBoundingClientRect.call(this);
  };
  const first = { items: [], queued: [], sessionId: "first", toasts: [{ id: "toast", text: "Failed", tone: "error" }] };
  window.mixdogDesktop = {
    getSnapshot: async () => first,
    listSessions: async () => [],
    subscribeState: () => () => {},
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  const region = document.querySelector(".mx-toast-region");
  assert.ok(region, "mobile toast region renders");
  assert.equal(region.style.top, "40px", "mobile toast stays at the safe workspace top");
  assert.equal(region.style.right, "16px", "mobile toast stays right-aligned");
  assert.equal(region.style.bottom, "", "mobile toast never anchors above the composer");
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
  assert.equal(document.querySelector(".live-work-count")?.textContent, "10",
    "the aggregate chip totals agents + explore + search + shells");
  const rows = Array.from(document.querySelectorAll(".live-work-row"))
    .map((element) => Array.from(element.children)
      .map((child) => child.textContent.trim()).filter(Boolean).join(" "));
  assert.deepEqual(rows, [
    "Agents 5 1h 1m 5s",
    "Explore 4s",
    "Web search 3s",
    "Shell 2 9s",
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
    sessionId: "context-session",
    desktopSessionTitle: "Context fixture",
    autoCompactTokenLimit: 20_000,
    displayContextWindow: 100_000,
    stats: { currentEstimatedContextTokens: 15_920, costUsd: 0.125, reasoningTokens: 250 },
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
  assert.match(text, /79% used16k \/ 20k · 4\.1k free/);
  // Runtime detail lines (Source/Compaction/API-cache) were removed by user
  // decision — the surface is usage + composition only.
  assert.doesNotMatch(text, /Source|Compaction|API\/cache/);
  assert.match(text, /Context mixMessages.*Tools.*MCP.*Skills.*Memory.*Session.*Workflow.*System.*Tool I\/O.*Overhead/);
  assert.equal(document.querySelectorAll(".context-mix-row").length, 10);
  const toolsRow = Array.from(document.querySelectorAll(".context-mix-row"))
    .find((row) => row.querySelector("span")?.textContent === "Tools");
  assert.equal(toolsRow?.querySelector("strong")?.textContent, "1.9k",
    "agent and other control schemas belong to the Tools total");
  assert.doesNotMatch(text, /Cost|\$|Question|hidden argument|hidden result|metadata|rawResult|args/);
});

test("expanded context uses the same provider usage and auto-compact limit as its hover", async () => {
  installDom();
  const snapshot = {
    sessionId: "shared-context",
    stats: { currentContextTokens: 796 },
    autoCompactTokenLimit: 1_000,
    displayContextWindow: 2_000,
  };
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(ContextUsageIndicator, { snapshot, onOpen() {} }),
    React.createElement(ContextBody, {
      status: {
        sessionId: "shared-context",
        usedTokens: 900,
        contextWindow: 2_000,
        compaction: { triggerTokens: 1_000 },
        messages: { semantic: { chat: { tokens: 600 } } },
        request: { toolSchemaBreakdown: {} },
      },
      snapshot,
    }),
  )));
  const popoverText = document.querySelector(".session-context-popover")?.textContent || "";
  const expandedText = document.querySelector(".context-view")?.textContent || "";
  assert.match(popoverText, /Usage79%Tokens796 \/ 1,000/);
  assert.match(expandedText, /79% used796 \/ 1\.0k · 204 free/);
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
  // Session cost surfaces in the same popover.
  assert.match(popoverText, /Cost\$12\.50/);
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

test("composer renders a pending user card before a slow submit resolves", async () => {
  installDom();
  let resolveSubmit;
  let receivedOptions;
  const submitGate = new Promise((resolve) => { resolveSubmit = resolve; });
  Object.defineProperty(window, "mixdogDesktop", {
    configurable: true,
    value: { perfLog() {} },
  });
  const snapshot = {
    sessionId: null,
    items: [],
    queued: [],
    busy: false,
    commandBusy: false,
    provider: "openai",
    model: "gpt-test",
    cwd: "C:\\work",
  };
  const conversationProps = {
    snapshot,
    routeSnapshot: snapshot,
    invoke: async (action) => { await action(); },
    invokeResult: async (action) => await action(),
    errors: [],
    submit: async (_content, options) => {
      receivedOptions = options;
      return await submitGate;
    },
    applySnapshot() {},
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenSettings() {},
    projects: [],
    showProjectSelector: false,
    activeProjectPath: "",
    activeProjectLabel: "",
    onSelectProject() {},
    onChooseProject() {},
    onOpenCommandSurface() {},
  };
  await act(async () => root.render(React.createElement(Conversation, conversationProps)));
  const textarea = document.querySelector(".composer textarea");
  assert.ok(textarea);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter.call(textarea, "queued before setup");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "queued before setup",
    }));
  });
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "Enter",
    }));
    await Promise.resolve();
  });

  const pending = document.querySelector(".message.user.pending");
  assert.ok(pending, "the submitted prompt should be visible while host setup is unresolved");
  assert.match(pending.textContent || "", /queued before setup/i);
  assert.doesNotMatch(pending.textContent || "", /Queued/,
    "an idle draft submit is pending host acknowledgement, not queued behind a turn");
  const optimisticActivity = document.querySelector(".live-activity");
  assert.ok(optimisticActivity,
    "an idle submit should start desktop activity before the host RPC resolves");
  assert.equal(optimisticActivity.getAttribute("data-mode"), "requesting");
  assert.equal(
    optimisticActivity.querySelector("[data-component='text-shimmer']")?.getAttribute("aria-label"),
    "Requesting",
  );
  assert.ok(optimisticActivity.querySelector(".live-activity-spinner"));
  assert.match(String(receivedOptions?.id || ""), /^desktop-submit-/);
  assert.ok(Number(receivedOptions?.submittedAt) > 0);

  await act(async () => root.render(React.createElement(Conversation, {
    ...conversationProps,
    snapshot: {
      ...snapshot,
      busy: true,
      spinner: {
        active: true,
        mode: "thinking",
        verb: "Reasoning",
        startedAt: receivedOptions.submittedAt,
      },
      queued: [{
        id: receivedOptions.id,
        displayText: "queued before setup",
        submittedAt: receivedOptions.submittedAt,
      }],
    },
  })));
  assert.equal(document.querySelectorAll(".message.user.pending").length, 1,
    "queue acknowledgement must preserve one optimistic transcript card");
  assert.equal(document.querySelector(".queue-list"), null,
    "the acknowledged queue row must not duplicate its optimistic card");
  assert.equal(document.querySelector(".live-activity"), optimisticActivity,
    "the authoritative engine activity should take over the optimistic row in place");
  assert.equal(optimisticActivity.getAttribute("data-mode"), "thinking");

  await act(async () => {
    resolveSubmit(true);
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".message.user.pending"), null);
  assert.equal(document.querySelectorAll(".message.user").length, 0,
    "host acknowledgement removes the optimistic row even before a differently-id'd transcript arrives");
  assert.equal(document.querySelector(".queue-item-text")?.textContent, "queued before setup");
  assert.equal(document.querySelector(".live-activity"), optimisticActivity,
    "host acknowledgement must not clear activity already owned by the engine");
  await act(async () => root.render(React.createElement(Conversation, {
    ...conversationProps,
    snapshot: {
      ...snapshot,
      queued: [],
      items: [{ id: "engine-normalized-id", kind: "user", text: "queued before setup" }],
    },
  })));
  assert.equal(document.querySelectorAll(".message.user").length, 1,
    "the authoritative transcript must render the submitted prompt exactly once");
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
    tooltipTarget.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 430));
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

test("studio mode switches preserve the picker and omit retired side-panel controls", async () => {
  installDom();
  const lanes = [{
    id: "gemini",
    label: "Gemini",
    authType: "api",
    authProvider: "gemini",
    authenticated: true,
    kinds: ["image", "video"],
    image: {
      models: [{ id: "image-alpha", label: "Image Alpha" }],
      defaultModel: "image-alpha",
      controls: {},
    },
    video: {
      models: [{ id: "video-beta", label: "Video Beta" }],
      defaultModel: "video-beta",
      controls: {},
    },
  }];
  const api = {
    async invokeCapability({ capability }) {
      if (capability === "listMediaLanes") return { value: lanes };
      if (capability === "listMediaAssets") return { value: { assets: [] } };
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const initialTrigger = document.querySelector('[aria-label="Generation model"]');
  const initialBar = initialTrigger?.closest(".studio-composer-bar");
  assert.equal(initialTrigger?.querySelector("span")?.textContent, "Image Alpha");
  assert.ok(initialBar);
  assert.equal(document.querySelector('[aria-label="Studio side panel"]'), null);
  assert.equal(document.querySelector('[aria-label="Open side panel"]'), null);
  assert.equal(document.querySelector('[aria-label="Close studio"]'), null);
  assert.equal(document.querySelector(".studio-header h1"), null);
  const sidebarToggle = document.querySelector('.studio-header [aria-label="Toggle session list"]');
  assert.ok(sidebarToggle);
  const prompt = document.querySelector('[aria-label="Generation prompt"]');
  assert.equal(prompt?.getAttribute("rows"), "1");
  assert.equal(prompt?.getAttribute("placeholder"), "Describe the image you want…");
  sidebarToggle.focus();
  await act(async () => document.querySelector(".studio-results").click());
  assert.equal(document.activeElement, prompt,
    "clicking the Studio canvas should place the caret in its prompt");
  const videoToggle = Array.from(document.querySelectorAll(".studio-kind button"))
    .find((button) => button.textContent === "video");
  assert.ok(videoToggle);

  let switchedLabel = "";
  let switchedBar = null;
  await act(async () => {
    videoToggle.focus();
    flushSync(() => videoToggle.click());
    const switchedTrigger = document.querySelector('[aria-label="Generation model"]');
    switchedLabel = switchedTrigger?.querySelector("span")?.textContent || "";
    switchedBar = switchedTrigger?.closest(".studio-composer-bar") || null;
  });

  assert.equal(switchedLabel, "Video Beta");
  assert.equal(switchedBar, initialBar, "mode switches should preserve the picker DOM");
  assert.equal(prompt?.getAttribute("placeholder"), "Describe the video…",
    "video mode must keep the same one-line empty composer height as image mode");
  assert.equal(document.activeElement, videoToggle,
    "Studio controls should keep their own focus instead of redirecting to the prompt");
});

test("studio reserves the media toggle before the lane catalog resolves", async () => {
  installDom();
  let resolveLanes;
  const laneCatalog = new Promise((resolve) => {
    resolveLanes = resolve;
  });
  const lanes = [{
    id: "gemini",
    label: "Gemini",
    authenticated: true,
    kinds: ["image", "video"],
    image: {
      models: [{ id: "image-alpha", label: "Image Alpha" }],
      defaultModel: "image-alpha",
      controls: {},
    },
    video: {
      models: [{ id: "video-beta", label: "Video Beta" }],
      defaultModel: "video-beta",
      controls: {},
    },
  }];
  const api = {
    async invokeCapability({ capability }) {
      if (capability === "listMediaLanes") return laneCatalog;
      if (capability === "listMediaAssets") return { value: { assets: [] } };
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    await Promise.resolve();
  });
  const initialToggle = document.querySelector(".studio-kind");
  assert.ok(initialToggle);
  assert.equal(initialToggle.getAttribute("data-empty"), "true");
  assert.equal(initialToggle.querySelectorAll("button").length, 2);

  await act(async () => {
    resolveLanes({ value: lanes });
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".studio-kind"), initialToggle,
    "lane discovery should reveal the reserved toggle instead of mounting a new row");
  assert.equal(initialToggle.getAttribute("data-empty"), null);
});

test("studio pages each media kind and hydrates every thumbnail reached by scrolling", async () => {
  installDom();
  const lanes = [{
    id: "gemini",
    label: "Gemini",
    authType: "api",
    authProvider: "gemini",
    authenticated: true,
    kinds: ["image", "video"],
    image: {
      models: [{ id: "image-alpha", label: "Image Alpha" }],
      defaultModel: "image-alpha",
      controls: {},
    },
    video: {
      models: [{ id: "video-beta", label: "Video Beta" }],
      defaultModel: "video-beta",
      controls: {},
    },
  }];
  const images = Array.from({ length: 65 }, (_, index) => ({
    id: `paged-image-${String(index).padStart(2, "0")}`,
    kind: "image",
    lane: "gemini",
    model: "image-alpha",
    prompt: `Image ${index}`,
    options: {},
    mime: "image/jpeg",
    bytes: 1024,
    createdAt: 10_000 - index,
  }));
  const videos = Array.from({ length: 3 }, (_, index) => ({
    id: `paged-video-${index}`,
    kind: "video",
    lane: "gemini",
    model: "video-beta",
    prompt: `Video ${index}`,
    options: {},
    mime: "video/mp4",
    bytes: 2048,
    createdAt: 5_000 - index,
  }));
  const listCalls = [];
  const thumbReads = [];
  const api = {
    async invokeCapability({ capability, args = [] }) {
      if (capability === "listMediaLanes") return { value: lanes };
      if (capability === "listMediaAssets") {
        const options = args[0] || {};
        const source = options.kind === "video" ? videos : images;
        const offset = Number(options.offset) || 0;
        const limit = Number(options.limit) || 60;
        listCalls.push({ kind: options.kind, offset, limit });
        return { value: {
          total: source.length,
          assets: source.slice(offset, offset + limit),
        } };
      }
      if (capability === "readMediaAsset") {
        thumbReads.push(args[0]);
        return { value: {
          available: true,
          variant: "thumb",
          mime: "image/jpeg",
          base64: Buffer.from(`thumb:${args[0]}`).toString("base64"),
        } };
      }
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    const deadline = Date.now() + 1_000;
    while (document.querySelectorAll('[data-studio-asset-id^="paged-image-"]').length < 60
      && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
  });
  assert.deepEqual(
    listCalls.filter((entry) => entry.offset === 0).map((entry) => entry.kind).sort(),
    ["image", "video"],
    "each mode should own an independent first page",
  );
  assert.equal(document.querySelectorAll('[data-studio-asset-id^="paged-image-"]').length, 60);
  assert.equal(thumbReads.includes("paged-image-59"), true,
    "thumbnail hydration must not stop at the former first-24 cutoff");

  const results = document.querySelector(".studio-results");
  Object.defineProperties(results, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_200 },
    scrollTop: { configurable: true, value: 800 },
  });
  await act(async () => {
    results.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    const deadline = Date.now() + 1_000;
    while (document.querySelectorAll('[data-studio-asset-id^="paged-image-"]').length < 65
      && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
  });
  assert.equal(document.querySelectorAll('[data-studio-asset-id^="paged-image-"]').length, 65,
    "scrolling the gallery should append every remaining asset");
  assert.equal(thumbReads.includes("paged-image-64"), true,
    "assets appended by scrolling should join thumbnail hydration");
  assert.equal(
    listCalls.some((entry) => entry.kind === "image" && entry.offset === 60),
    true,
  );
});

test("studio tiles keep a visible loader until the thumbnail has decoded", async () => {
  installDom();
  const asset = {
    id: "loading-thumbnail",
    kind: "image",
    lane: "gemini",
    model: "image-alpha",
    prompt: "slow thumbnail",
    options: {},
    mime: "image/jpeg",
    bytes: 1024,
    createdAt: Date.now(),
  };
  const capabilityCalls = [];
  let resolveThumbRead;
  const thumbRead = new Promise((resolve) => { resolveThumbRead = resolve; });
  const api = {
    mediaUrl: (id, variant) => `mixdog-media://asset/${id}?variant=${variant}`,
    async invokeCapability({ capability, args = [] }) {
      capabilityCalls.push({ capability, args });
      if (capability === "listMediaLanes") return { value: [{
        id: "gemini",
        label: "Gemini",
        authenticated: true,
        kinds: ["image"],
        image: {
          models: [{ id: "image-alpha", label: "Image Alpha" }],
          defaultModel: "image-alpha",
          controls: {},
        },
      }] };
      if (capability === "listMediaAssets") return { value: { total: 1, assets: [asset] } };
      if (capability === "readMediaAsset") return { value: await thumbRead };
      return { value: undefined };
    },
  };
  await act(async () => {
      root.render(React.createElement(StudioPane, { api }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
    const tile = document.querySelector('[data-studio-asset-id="loading-thumbnail"]');
    assert.equal(tile?.querySelector(".studio-thumbnail-image"), null,
      "an eager local image must not enter the delayed custom-protocol queue");
    assert.ok(tile.querySelector(".studio-thumbnail-loading"));
    assert.deepEqual(
      capabilityCalls.find((call) => call.capability === "readMediaAsset")?.args,
      ["loading-thumbnail", { variant: "thumb", allowOriginal: true, generate: false }],
      "a local stall must bypass the delayed custom-protocol queue",
    );

    await act(async () => {
      resolveThumbRead({
        variant: "thumb",
        mime: "image/jpeg",
        base64: Buffer.from("cached-thumb").toString("base64"),
      });
      await thumbRead;
    });
    const image = tile?.querySelector(".studio-thumbnail-image");
    assert.ok(image);
    assert.equal(image.getAttribute("data-ready"), "false");
    assert.ok(tile.querySelector(".studio-thumbnail-loading"),
      "the loader must remain until the returned thumbnail decodes");
    await act(async () => image.dispatchEvent(new window.Event("load")));
    assert.equal(image.getAttribute("data-ready"), "true");
    assert.equal(tile.querySelector(".studio-thumbnail-loading"), null);
});

test("studio video tiles derive and cache a still before hover", async () => {
  installDom();
  const asset = {
    id: "video-poster-fallback",
    kind: "video",
    lane: "grok",
    model: "video-alpha",
    prompt: "static poster without hover",
    options: {},
    mime: "video/mp4",
    bytes: 2048,
    createdAt: Date.now(),
  };
  const calls = [];
  const captured = [];
  const poster = `data:image/jpeg;base64,${Buffer.from("poster").toString("base64")}`;
  const api = {
    async invokeCapability({ capability, args = [] }) {
      calls.push({ capability, args });
      if (capability === "listMediaLanes") return { value: [{
        id: "grok",
        label: "Grok",
        authenticated: true,
        kinds: ["video"],
        video: {
          models: [{ id: "video-alpha", label: "Video Alpha" }],
          defaultModel: "video-alpha",
          controls: {},
        },
      }] };
      if (capability === "listMediaAssets") {
        return { value: { assets: args[0]?.kind === "video" ? [asset] : [] } };
      }
      if (capability === "readMediaAsset") return { value: {
        available: true,
        variant: "original",
        downgraded: true,
        mime: "video/mp4",
        base64: Buffer.from("video").toString("base64"),
      } };
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, {
      api,
      captureVideoPoster: async (source) => {
        captured.push(source);
        return { url: poster, duration: 5 };
      },
    }));
    const deadline = Date.now() + 1_000;
    while (!document.querySelector('[data-studio-asset-id="video-poster-fallback"] .studio-thumbnail-image')
      && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
  });
  const tile = document.querySelector('[data-studio-asset-id="video-poster-fallback"]');
  assert.ok(tile);
  assert.equal(tile.querySelector("video"), null, "poster hydration must not require hover playback");
  assert.match(captured[0] || "", /^data:video\/mp4;base64,/);
  assert.equal(tile.querySelector(".studio-thumbnail-image")?.getAttribute("src"), poster);
  assert.deepEqual(
    calls.find((call) => call.capability === "readMediaAsset")?.args,
    [asset.id, { variant: "thumb", allowOriginal: true }],
  );
  assert.deepEqual(
    calls.find((call) => call.capability === "cacheMediaThumbnail")?.args,
    [asset.id, {
      mime: "image/jpeg",
      base64: Buffer.from("poster").toString("base64"),
      durationSeconds: 5,
    }],
  );
});

test("mobile studio tiles expose only the thumbnail detail action", async () => {
  installDom();
  document.documentElement.dataset.mixdogMobile = "1";
  const asset = {
    id: "mobile-studio-asset",
    kind: "image",
    lane: "gemini",
    model: "image-alpha",
    prompt: "mobile result",
    options: {},
    mime: "image/png",
    bytes: 1024,
    createdAt: Date.now(),
  };
  const api = {
    async invokeCapability({ capability }) {
      if (capability === "listMediaLanes") {
        return { value: [{
          id: "gemini",
          label: "Gemini",
          authType: "api",
          authProvider: "gemini",
          authenticated: true,
          kinds: ["image"],
          image: {
            models: [{ id: "image-alpha", label: "Image Alpha" }],
            defaultModel: "image-alpha",
            controls: {},
          },
        }] };
      }
      if (capability === "listMediaAssets") return { value: { assets: [asset] } };
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const tile = document.querySelector('[data-studio-asset-id="mobile-studio-asset"]');
  const thumbnail = tile?.querySelector(".studio-tile-open");
  assert.ok(thumbnail);
  assert.equal(tile?.querySelector(".studio-tile-actions"), null);
  await act(async () => thumbnail.click());
  assert.equal(
    document.querySelector('[aria-label="Generated media detail"]')?.getAttribute("data-phone"),
    "true",
  );
});

test("studio detail stacks from its own pane width on a wide desktop", async () => {
  installDom();
  const resizeObservers = new Map();
  const Observer = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); }
    observe(target) {
      this.targets.add(target);
      resizeObservers.set(target, this.callback);
    }
    disconnect() {
      for (const target of this.targets) resizeObservers.delete(target);
    }
  };
  window.ResizeObserver = Observer;
  globalThis.ResizeObserver = Observer;
  const asset = {
    id: "narrow-pane-detail",
    kind: "image",
    lane: "gemini",
    model: "image-alpha",
    prompt: "stack inside a narrow split pane",
    options: {},
    mime: "image/png",
    bytes: 1024,
    createdAt: Date.now(),
  };
  const api = {
    async invokeCapability({ capability, args = [] }) {
      if (capability === "listMediaLanes") return { value: [{
        id: "gemini",
        label: "Gemini",
        authenticated: true,
        kinds: ["image"],
        image: {
          models: [{ id: "image-alpha", label: "Image Alpha" }],
          defaultModel: "image-alpha",
          controls: {},
        },
      }] };
      if (capability === "listMediaAssets") {
        return { value: { assets: args[0]?.kind === "image" ? [asset] : [] } };
      }
      return { value: undefined };
    },
  };
  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    const deadline = Date.now() + 1_000;
    while (!document.querySelector('[data-studio-asset-id="narrow-pane-detail"]')
      && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
  });
  const studio = document.querySelector(".studio-root");
  const resizeStudio = resizeObservers.get(studio);
  assert.equal(typeof resizeStudio, "function");
  await act(async () => resizeStudio([{ target: studio, contentRect: { width: 480 } }]));
  await act(async () => {
    document.querySelector('[data-studio-asset-id="narrow-pane-detail"] .studio-tile-open').click();
  });
  const detail = document.querySelector('[aria-label="Generated media detail"]');
  assert.equal(detail?.getAttribute("data-phone"), "true",
    "a narrow split pane must use the stacked media-and-details composition");
  assert.equal(detail?.getAttribute("data-pane-compact"), "true",
    "a short desktop split must reserve height for both stacked rows");
  await act(async () => resizeStudio([{ target: studio, contentRect: { width: 900 } }]));
  assert.equal(detail?.getAttribute("data-phone"), null,
    "the detail viewer must return to its desktop rail when the pane widens");
  assert.equal(detail?.getAttribute("data-pane-compact"), null);
});

test("studio detail regenerates the saved request and gives the remaining height to a scrolling prompt", async () => {
  installDom();
  const asset = {
    id: "asset-regenerate",
    kind: "image",
    lane: "gemini",
    model: "image-alpha",
    prompt: "same pedal, but on a dark slate surface",
    options: { aspectRatio: "16:9", resolution: "2k", quality: "high" },
    mime: "image/png",
    bytes: 1024,
    createdAt: Date.now(),
  };
  const startedRequests = [];
  const folderRequests = [];
  const api = {
    async invokeCapability({ capability, args = [] }) {
      if (capability === "listMediaLanes") {
        return { value: [{
          id: "gemini",
          label: "Gemini",
          authType: "api",
          authProvider: "gemini",
          authenticated: true,
          kinds: ["image"],
          image: {
            models: [{ id: "image-alpha", label: "Image Alpha" }],
            defaultModel: "image-alpha",
            controls: {},
          },
        }] };
      }
      if (capability === "listMediaAssets") return { value: { assets: [asset] } };
      if (capability === "startMediaJob") {
        startedRequests.push(args[0]);
        return { value: {
          id: "job-regenerate",
          status: "running",
          kind: asset.kind,
          lane: asset.lane,
          model: asset.model,
          options: asset.options,
          progress: 0,
          assetId: null,
          error: null,
        } };
      }
      if (capability === "openMediaFolder") {
        folderRequests.push(args);
        return { value: { opened: true } };
      }
      return { value: undefined };
    },
  };

  await act(async () => {
    root.render(React.createElement(StudioPane, { api }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const tile = document.querySelector('[data-studio-asset-id="asset-regenerate"] .studio-tile-open');
  assert.ok(tile);
  await act(async () => tile.click());
  const openFolder = Array.from(document.querySelectorAll(".studio-detail-actions button"))
    .find((button) => button.textContent === "Open Folder");
  const regenerate = Array.from(document.querySelectorAll(".studio-detail-actions button"))
    .find((button) => button.textContent === "Regenerate");
  assert.ok(openFolder);
  assert.ok(regenerate);
  await act(async () => {
    openFolder.click();
    await Promise.resolve();
  });
  assert.deepEqual(folderRequests, [[asset.id]]);
  await act(async () => {
    regenerate.click();
    await Promise.resolve();
  });

  assert.deepEqual(startedRequests, [{
    lane: asset.lane,
    kind: asset.kind,
    model: asset.model,
    prompt: asset.prompt,
    options: asset.options,
    references: [],
  }]);
  assert.equal(document.querySelector('[aria-label="Generated media detail"]'), null);
});

test("inline approval renders in the transcript flow, reports failure, denies on Escape, and restores focus", async () => {
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
      approval: {
        id: "approval-1",
        name: "shell",
        reason: { message: "Hook requested approval" },
        cwd: { path: "C:\\Project\\mixdog" },
      },
      resolve,
    }));
  });

  const card = document.querySelector(".approval-card");
  const buttons = Array.from(card.querySelectorAll("button"));
  assert.equal(document.querySelector(".approval-layer"), null, "inline approval must not mount an overlay layer");
  assert.equal(document.querySelector('[role="dialog"]'), null, "inline approval must not be a modal dialog");
  assert.notEqual(card.parentElement, document.body, "inline approval renders in place, not in a body portal");
  assert.equal(background.inert, false, "inline approval must not inert the background");
  assert.equal(background.hasAttribute("aria-hidden"), false);
  assert.match(card.textContent, /Hook requested approval/);
  assert.match(card.textContent, /C:\\Project\\mixdog/);
  assert.equal(document.activeElement === buttons[0], true, "inline approval should initially focus the first action");

  await act(async () => {
    buttons[1].click();
    await Promise.resolve();
  });
  const alert = card.querySelector('[role="alert"]');
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
  assert.equal(document.querySelector(".stream-cursor"), null,
    "streaming status must not allocate an empty transcript row");

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
    // Timestamps mark TURN END now: only the assistant row that carries the
    // turn completion shows a clock.
    completion: { id: "response-meta-done", kind: "turndone", at },
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
  const cancelled = document.querySelector(".turn-status.interrupted");
  assert.equal(cancelled?.textContent.trim(), "Cancelled after 4s");
  assert.ok(cancelled?.querySelector(".turn-status-icon.lucide-x"));
});

test("failed tools expose a failed status instead of a successful completion", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "tool-failed", kind: "tool", name: "shell", isError: true, result: "Command failed" },
  })));
  // Final contract: collapsed = header only; expanding reveals JUST the
  // one-line summary (here the failure cause).
  const failedCard = document.querySelector(".tool-card");
  assert.ok(failedCard?.classList.contains("failed"));
  assert.equal(failedCard?.classList.contains("failure-arrived"), false,
    "a restored failure must not replay its live transition animation");
  assert.equal(failedCard?.querySelector(".tool-detail-line"), null,
    "collapsed failed card keeps the header-only shape");
  await act(async () => failedCard?.querySelector(".tool-header")?.click());
  assert.match(failedCard?.querySelector(".tool-detail-line .tool-detail-text")?.textContent || "",
    /^Failed · Command failed/);
  assert.equal(failedCard?.querySelector(".tool-content"), null,
    "no raw body block renders on expansion");
  assert.equal(document.querySelector(".tool-icon svg") != null, true,
    "failed tools should retain their own icon");
  assert.equal(document.querySelector(".lucide-x"), null,
    "failed tools should not replace their own icon with an X");
});

test("tool failure animation is reserved for a live running-to-failed transition", async () => {
  installDom();
  const running = {
    id: "tool-live-failure",
    kind: "tool",
    name: "shell",
    count: 1,
    completedCount: 0,
    startedAt: Date.now(),
  };
  await act(async () => root.render(React.createElement(TranscriptRow, { item: running })));
  assert.equal(document.querySelector(".tool-card")?.classList.contains("failure-arrived"), false);

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: {
      ...running,
      isError: true,
      result: "Command failed",
      completedCount: 1,
      completedAt: Date.now(),
    },
  })));
  assert.equal(document.querySelector(".tool-card")?.classList.contains("failure-arrived"), true,
    "a retained live card should signal the moment it becomes failed");
});

test("turn review bar keeps worker apply_patch review attributed to the worker", async () => {
  installDom();
  const capabilityCalls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      capabilityCalls.push(request.capability);
      return {
        value: {
          supported: true,
          files: [],
          patch: "",
          agents: [{
            sessionId: "agent-session",
            agent: "worker",
            tag: "worker-1",
            patch: [
              "diff --git a/src/app.mjs b/src/app.mjs",
              "--- a/src/app.mjs",
              "+++ b/src/app.mjs",
              "@@ -1,1 +1,3 @@",
              "-old",
              "+new",
              "+more",
              "+lines",
              "",
            ].join("\n"),
          }],
        },
      };
    },
  };
  await act(async () => root.render(React.createElement(TurnReviewBar, {
    items: [
      { id: 1, kind: "user", text: "go" },
      { id: 2, kind: "assistant", text: "background job finished" },
    ],
    cwd: "C:/proj",
    sessionId: "lead-session",
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.ok(capabilityCalls.includes("getTurnReviewDiff"),
    "the bar must read attributed worker reviews");
  assert.match(document.querySelector(".turn-review-summary")?.textContent || "", /1 file changed/);
  assert.match(document.querySelector(".turn-review-attribution")?.textContent || "", /Lead 0 · Agents 1/);
  assert.match(document.querySelector(".turn-review-summary .diff-stats")?.textContent || "", /\+3/);
  // The counters belong to the TITLE, and the row itself is the toggle: no
  // separate expander/menu affordance survives beside it.
  assert.equal(
    document.querySelector(".turn-review-summary strong")?.nextElementSibling?.className,
    "diff-stats",
    "the +adds −dels counters sit directly next to the `N files changed` title");
  assert.equal(document.querySelector(".turn-review-chevron"), null,
    "the change-summary row carries no separate expander control");
  assert.match(document.querySelector(".turn-review-file code")?.textContent || "", /src\/app\.mjs/);
  assert.match(document.querySelector(".turn-review-source")?.textContent || "", /worker-1 · worker/);
  await act(async () => document.querySelector(".turn-review-summary")?.click());
  const bar = document.querySelector(".turn-review-bar");
  const file = document.querySelector(".turn-review-file");
  assert.equal(bar?.dataset.expanded, "true");
  await act(async () => {
    file?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  assert.equal(bar?.dataset.expanded, "true", "interacting inside the review must keep it open");
  await act(async () => {
    document.getElementById("before")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  assert.equal(bar?.dataset.expanded, "false", "an outside pointer must collapse the review");
  assert.equal(document.querySelector(".turn-review-summary")?.getAttribute("aria-expanded"), "false");
});

test("turn review bar clears synchronously when switching to an empty session", async () => {
  installDom();
  let capabilityCalls = 0;
  window.mixdogDesktop = {
    invokeCapability: async () => {
      capabilityCalls += 1;
      return {
        value: {
          supported: true,
          agents: [{
            sessionId: "agent-old",
            agent: "worker",
            tag: "worker-old",
            patch: [
              "diff --git a/old.txt b/old.txt",
              "--- a/old.txt",
              "+++ b/old.txt",
              "@@ -1 +1 @@",
              "-old",
              "+new",
              "",
            ].join("\n"),
          }],
        },
      };
    },
  };
  await act(async () => root.render(React.createElement(TurnReviewBar, {
    items: [{ id: 1, kind: "user", text: "go" }, { id: 2, kind: "assistant", text: "done" }],
    sessionId: "old-session",
  })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.ok(document.querySelector(".turn-review-bar"));
  const callsBeforeSwitch = capabilityCalls;

  await act(async () => root.render(React.createElement(TurnReviewBar, {
    items: [],
    sessionId: "new-session",
  })));
  assert.equal(document.querySelector(".turn-review-bar"), null);
  await act(async () => { await Promise.resolve(); });
  assert.equal(capabilityCalls, callsBeforeSwitch, "an empty session must not query or reuse the prior turn");
});

test("tool counters and hook-denial visibility mirror the TUI", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "partial-read",
    item: { id: "partial", kind: "tool", name: "read", count: 3, completedCount: 3, errorCount: 1 },
  })));
  assert.equal(document.querySelector(".tool-detail-line"), null,
    "collapsed cards keep the header-only shape");
  await act(async () => document.querySelector(".tool-card .tool-header")?.click());
  assert.equal(document.querySelector(".tool-detail-line .tool-detail-text")?.textContent.trim(), "Failed");
  assert.ok(document.querySelector(".tool-card")?.classList.contains("partial-failed"),
    "some-but-not-all failures keep the amber partial state");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "denied-shell",
    item: {
      id: "denied", kind: "tool", name: "shell", isError: true, errorCount: 1,
      result: 'Error: tool "shell" denied by hook: approval required',
    },
  })));
  // Error-only bodies collapse to the bare status word (TUI
  // isBackgroundErrorOnlyBody contract); the row appears on expansion.
  await act(async () => document.querySelector(".tool-card .tool-header")?.click());
  assert.equal(document.querySelector(".tool-detail-line .tool-detail-text")?.textContent.trim(), "Failed");

  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: { id: "noise", kind: "tool", name: "read", isError: true, errorCount: 1, completedCount: 1 },
  })));
  assert.equal(document.querySelector(".tool-card") === null, true, "selector .tool-card should be absent");
});

test("long tool-call labels preserve the full title while the visible shimmer can ellipsize", async () => {
  installDom();
  const longPath = "C:\\work\\a-very-long-directory-name\\another-long-directory\\source-file.ts";
  await act(async () => root.render(React.createElement(TranscriptRow, {
    item: {
      id: "long-tool-title",
      kind: "tool",
      name: "read",
      args: JSON.stringify({ path: longPath }),
      startedAt: Date.now(),
    },
  })));
  const title = document.querySelector(".tool-title");
  assert.match(title?.getAttribute("title") || "", /source-file\.ts/);
  assert.ok(title?.querySelector('b [data-component="text-shimmer"] [data-slot="text-shimmer-char"]'),
    "the animated tool label keeps a dedicated ellipsis boundary");
});

test("tool disclosures remember the user's last state across remounts", async () => {
  installDom();
  const item = {
    id: "remembered-tool-disclosure",
    kind: "tool",
    name: "read",
    count: 3,
    completedCount: 3,
    errorCount: 1,
  };
  const renderTool = async () => act(async () => root.render(React.createElement(TranscriptRow, {
    item,
    disclosureScope: "remembered-session",
  })));
  await renderTool();
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "false");
  await act(async () => document.querySelector(".tool-header")?.click());
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "true");
  await act(async () => root.render(React.createElement("div")));
  await renderTool();
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "true");
  await act(async () => document.querySelector(".tool-header")?.click());
  await act(async () => root.render(React.createElement("div")));
  await renderTool();
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "false");
});

test("fenced markdown exposes a language header and copy control", async () => {
  installDom();
  const external = [];
  window.mixdogDesktop = {
    openExternal: async (url) => { external.push(url); },
  };
  await act(async () => {
    await preloadMarkdownBody();
    root.render(React.createElement(TranscriptRow, {
      item: {
        id: "code",
        kind: "assistant",
        text: "```ts\nconst answer = 42;\n```\n\n[Documentation](https://example.com/docs)",
      },
    }));
  });
  // MarkdownBody is React.lazy; whether its chunk resolved inside the act
  // above depends on which tests ran earlier in the process. Flush until the
  // suspense boundary settles (bounded) so the assertion is order-independent.
  for (let flush = 0; flush < 20 && !document.querySelector(".markdown-code header span"); flush += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
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
  assert.ok(footer?.querySelector(".turn-status.complete .turn-status-icon.lucide-check"));
  assert.equal(footer?.querySelector('[aria-label="Copy response"]') != null, true);
  assert.equal(document.querySelector(".sr-only[role=status]") === null, true, "selector .sr-only[role=status] should be absent");
});

test("conversation attaches only successful turn completion to the final assistant response", async () => {
  installDom();
  let publish;
  const empty = { items: [], queued: [], sessionId: "turn-footer-session" };
  const row = seedActiveSession("turn-footer-session", "Turn footer");
  window.mixdogDesktop = {
    getSnapshot: async () => empty,
    listSessions: async () => [row],
    subscribeState: (listener) => { publish = listener; return () => {}; },
    startTask: async () => empty,
  };
  await act(async () => {
    root.render(React.createElement(App));
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
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(resolve)));
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
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(resolve)));
  assert.equal(document.querySelector(".message.assistant .response-footer .turn-status") === null, true, "selector .message.assistant .response-footer .turn-status should be absent");
  assert.equal(document.querySelectorAll(".turn-status.failed").length, 1);
  const failedRow = document.querySelector(".turn-status.failed");
  assert.equal(failedRow?.textContent?.trim(), "FailedRetry");
  assert.equal(failedRow?.querySelector(".turn-retry")?.getAttribute("aria-label"), "Retry failed turn");
  assert.ok(failedRow?.querySelector(".turn-status-icon.lucide-x"));
});

test("toggling a tool card keeps a pinned view followed and holds the anchor once released", async () => {
  installDom();
  // The tool card body is lazy Markdown: without an explicit preload the
  // `.tool-header` never mounts when this test runs in cold isolation.
  await preloadMarkdownBody();
  const source = {
    id: "tool-toggle-session",
    title: "Tool toggle",
    preview: "Tool toggle",
    updatedAt: 1,
    currentSession: false,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [source],
    resumeSession: async () => ({
      sessionId: source.id,
      items: [
        { id: "u1", kind: "user", text: "Run the listing" },
        // A read card, not shell: an expanded shell card mounts the lazy
        // xterm terminal pane, whose buffer allocation is unsupported (and
        // fatal) under jsdom. Follow/pin behavior is tool-agnostic.
        { id: "t1", kind: "tool", name: "read", args: JSON.stringify({ path: "C:\\work\\a.txt" }), result: "listing output", completedAt: 5 },
      ],
      queued: [],
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${source.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const transcript = document.querySelector(".transcript");
  Object.defineProperties(transcript, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 400, configurable: true },
    scrollTop: { value: 800, writable: true, configurable: true },
  });
  const clickToolWithLayoutScroll = async () => {
    const header = document.querySelector(".tool-header");
    await act(async () => {
      transcript.scrollTop = 800;
      // `.click()` alone omits the real pointer sequence. A plain pointerup
      // used to arm scroll intent, so the disclosure's layout-driven upward
      // scroll was intermittently mistaken for an explicit user gesture.
      header.dispatchEvent(new window.MouseEvent("pointerdown", {
        bubbles: true,
        buttons: 1,
        clientX: 100,
        clientY: 100,
      }));
      header.dispatchEvent(new window.MouseEvent("pointerup", {
        bubbles: true,
        buttons: 0,
        clientX: 100,
        clientY: 100,
      }));
      header.click();
      await Promise.resolve();
      transcript.scrollTop = 790;
      transcript.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
  };
  assert.equal(document.querySelector(".jump-to-latest"), null,
    "follow starts armed after a session open");
  await clickToolWithLayoutScroll();
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "true");
  assert.equal(transcript.getAttribute("data-following"), "true",
    "a real pointer click plus disclosure layout scroll must not release follow");
  await clickToolWithLayoutScroll();
  assert.equal(document.querySelector(".tool-card")?.getAttribute("data-open"), "false");
  assert.equal(transcript.getAttribute("data-following"), "true",
    "closing the disclosure through the same pointer sequence must remain followed");
  // Flush any pending observer/reconciliation work (rAF shim = setTimeout).
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(".jump-to-latest"), null,
    "a disclosure toggled while pinned stays followed under the aggregate pin");

  // Anchor-hold branch: an explicit upward scroll intent releases follow, and
  // the toggle that follows must reconcile back to user control, never re-pin.
  const wheel = new window.Event("wheel", { bubbles: true });
  Object.defineProperty(wheel, "deltaY", { value: -1 });
  await act(async () => { transcript.dispatchEvent(wheel); });
  assert.ok(document.querySelector(".jump-to-latest"),
    "an upward wheel must disarm bottom follow");
  await act(async () => {
    document.querySelector(".tool-header").click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(document.querySelector(".jump-to-latest"),
    "a toggle that settles off-bottom must keep user control so the transcript is not re-pinned mid-read");
});

test("a + draft opened during an in-flight session switch is not stomped by the late resume", async () => {
  installDom();
  const source = {
    id: "inflight-source",
    title: "Inflight source",
    preview: "Inflight source",
    updatedAt: 1,
    currentSession: false,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  let finishResume;
  let startCalls = 0;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [source],
    resumeSession: () => new Promise((resolve) => {
      finishResume = () => resolve({
        sessionId: source.id,
        items: [{ id: "s1", kind: "user", text: "Source transcript" }],
        queued: [],
      });
    }),
    startTask: async () => {
      startCalls += 1;
      return { sessionId: "", items: [], queued: [] };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${source.id}"]`).click();
    await Promise.resolve();
  });
  // + while the switch is still in flight: the draft owns the view now.
  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
  });
  await act(async () => {
    finishResume();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Source transcript/,
    "a late-settling switch must not resurrect the outgoing transcript in the draft");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "New task");
  assert.equal(startCalls, 0, "opening the draft must not initialize another engine");
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Source transcript/);
  assert.ok(document.querySelector('textarea[aria-label="Message Mixdog"]'),
    "the deferred draft shows the blank chat surface");
});

// TUI ⇄ desktop tool-card parity: the desktop card's header label, arg
// summary, and manually-expanded detail row must equal the shared
// deriveToolCardModel output for every tool shape (single, shell, grep,
// aggregate, agent, failure, pending) — including verb casing.
test("tool cards render the shared TUI derivation for every tool shape", async () => {
  installDom();
  const { deriveToolCardModel } = await import("../../../../src/runtime/shared/tool-card-model.mjs");
  const desktopDone = (item) => item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
  const toolModel = (item) => deriveToolCardModel({
    name: item.name,
    args: item.args,
    result: item.result,
    rawResult: item.rawResult,
    isError: item.isError,
    errorCount: item.errorCount,
    callErrorCount: item.callErrorCount,
    exitErrorCount: item.exitErrorCount,
    count: item.count,
    completedCount: desktopDone(item) ? Math.max(1, Math.round(Number(item.count || 1))) : 0,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    aggregate: Boolean(item.aggregate),
    categories: item.categories,
    doneCategories: item.doneCategories,
    headerFinalized: item.headerFinalized,
  });
  const fixtures = [
    {
      label: "read single",
      item: { id: "p-read", kind: "tool", name: "read", args: JSON.stringify({ path: "C:\\repo\\notes.txt" }), result: "line one\nline two\nline three" },
      expectLabel: "Read 1 file",
    },
    {
      label: "grep single",
      item: { id: "p-grep", kind: "tool", name: "grep", args: JSON.stringify({ pattern: "foo" }), result: "a.txt:1\nb.txt:2" },
      expectLabel: "Searched 1 pattern",
    },
    {
      label: "shell single",
      item: { id: "p-shell", kind: "tool", name: "shell", args: JSON.stringify({ command: "npm test" }), result: "All tests passed" },
      expectLabel: "Ran 1 command",
    },
    {
      label: "failed read",
      item: { id: "p-fail", kind: "tool", name: "read", args: JSON.stringify({ path: "C:\\repo\\gone.txt" }), result: "Error: ENOENT", isError: true, errorCount: 1, callErrorCount: 1 },
      expectDetailPrefix: "Failed",
    },
    {
      label: "pending read",
      item: { id: "p-pending", kind: "tool", name: "read", args: JSON.stringify({ path: "C:\\repo\\slow.txt" }), count: 1, completedCount: 0 },
      expectLabel: "Reading 1 file",
      expectDetail: "Running",
    },
    {
      label: "aggregate",
      item: {
        id: "p-agg", kind: "tool", name: "read", aggregate: true, count: 3, completedCount: 3,
        args: JSON.stringify({ categoryOrder: ["Read", "Search"] }),
        categories: {
          Read: { category: "Read", active: "Reading", done: "Read", noun: "file", pluralNoun: "files", count: 2 },
          Search: { category: "Search", active: "Searching", done: "Searched", noun: "pattern", pluralNoun: "patterns", count: 1 },
        },
        result: "512 lines, 6 matches",
      },
      expectLabel: "Read 2 files, Searched 1 pattern",
      expectDetail: "512 lines, 6 matches",
    },
    {
      label: "agent spawn",
      item: { id: "p-agent", kind: "tool", name: "agent", args: JSON.stringify({ type: "spawn", agent: "explore", tag: "scan" }), result: "agent task:\ntask_id: t1\nstatus: running" },
      expectLabel: "Spawn Explore (scan)",
      expectNoDetail: true,
    },
  ];
  for (const fixture of fixtures) {
    await act(async () => root.render(React.createElement(TranscriptRow, {
      key: fixture.item.id,
      item: fixture.item,
    })));
    const card = document.querySelector(".tool-card");
    assert.ok(card, `${fixture.label}: tool card should render`);
    const model = toolModel(fixture.item);
    assert.equal(card.querySelector(".tool-title b")?.textContent, model.labelText,
      `${fixture.label}: header label must equal the shared TUI derivation`);
    if (fixture.expectLabel) {
      assert.equal(model.labelText, fixture.expectLabel, `${fixture.label}: pinned header casing`);
    }
    const small = card.querySelector(".tool-title small")?.textContent ?? "";
    assert.equal(small, "",
      `${fixture.label}: collapsed headers hide the arg summary (user decision — it flapped between sources and leaked raw commands)`);
    assert.match(card.querySelector(".tool-title")?.getAttribute("title") || "",
      model.summaryText ? new RegExp(model.summaryText.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /.*/,
      `${fixture.label}: the full summary stays reachable on the hover title`);
    const detail = card.querySelector(".tool-detail-line .tool-detail-text")?.textContent ?? "";
    if (fixture.expectNoDetail) {
      assert.equal(detail, "", `${fixture.label}: collapsed detail row should be dropped`);
      assert.equal(model.detailLine, "", `${fixture.label}: model drops the detail row too`);
    } else {
      // Final contract: every tool lifecycle state collapses to one header
      // row; expanding reveals only the shared one-line summary.
      assert.equal(detail, "", `${fixture.label}: tools collapse to the header row`);
      await act(async () => card.querySelector(".tool-header")?.click());
      assert.equal(card.querySelector(".tool-detail-line .tool-detail-text")?.textContent ?? "",
        model.detailLine, `${fixture.label}: expansion reveals the shared summary row`);
      assert.equal(card.querySelector(".tool-content"), null,
        `${fixture.label}: expansion renders no raw body block`);
    }
    if (fixture.expectDetail) {
      assert.equal(model.detailLine, fixture.expectDetail, `${fixture.label}: pinned detail text`);
    }
    if (fixture.expectDetailPrefix) {
      assert.match(model.detailLine, new RegExp(`^${fixture.expectDetailPrefix}`),
        `${fixture.label}: pinned detail status casing`);
    }
  }
});

test("primary nav mirrors the active surface as selected — creation actions excluded", async () => {
  installDom();
  const props = {
    activeSurface: null,
    sidebarOpen: true,
    onToggleSessions() {},
    onOpenProjects() {},
    onOpenWorkflows() {},
    onOpenSchedules() {},
    onOpenWebhooks() {},
    onCloseActiveSurface() {},
    onOpenSettings() {},
    updaterState: { status: "disabled" },
    onOpenUpdate() {},
  };
  await act(async () => root.render(React.createElement(ActivityRail, props)));
  const nav = document.querySelector(".sidebar-primary-nav");
  assert.equal(nav?.querySelector(".selected"), null, "no surface open → no selected nav button");
  assert.equal(nav?.querySelector(".session-new-task"), null,
    "creation actions belong to the Sessions header rather than the primary nav");
  await act(async () => root.render(React.createElement(ActivityRail, {
    ...props,
    activeSurface: "workflows",
  })));
  const workflowsNav = document.querySelector('[aria-label="Open workflows"]');
  assert.equal(workflowsNav?.classList.contains("selected"), true,
    "the active Workflows destination must mark its nav button selected");
  assert.equal(workflowsNav?.getAttribute("aria-current"), "page");
});

test("Agents groups live workers without a working heartbeat and shows role, model, tag, and elapsed time", async () => {
  installDom();
  window.localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify({
    open: true,
    tab: "tasks",
    width: 380,
  }));
  defaultSessionLaneStore.clear();
  const startedAt = Date.now() - 65_000;
  const session = {
    id: "agent-parent",
    preview: "Review checkout",
    title: "Review checkout",
    updatedAt: Date.now(),
    activityAt: Date.now(),
    messageCount: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
    working: false,
  };
  const liveAgentSnapshot = {
    sessionId: session.id,
    agentWorkers: [{
      tag: "review-ui",
      sessionId: "agent-child-review-ui",
      agent: "reviewer",
      provider: "openai",
      model: "gpt-5.6-codex",
      status: "running",
      createdAt: String(startedAt),
    }],
    // One spawn can be reported as both worker and job; it must stay one row.
    agentJobs: [{
      tag: "review-ui",
      task_id: "task-review-ui",
      agent: "reviewer",
      provider: "openai",
      model: "gpt-5.6-codex",
      status: "running",
      startedAt,
    }],
  };
  const resumes = [];
  const peeks = [];
  const visibleSets = [];
  const capabilityCalls = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], ...liveAgentSnapshot }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session],
    invokeCapability: async (...args) => {
      capabilityCalls.push(args);
      return { value: null };
    },
    setVisibleSessions: async (sessionIds) => {
      visibleSets.push([...sessionIds]);
      return true;
    },
    peekSession: async (sessionId) => {
      peeks.push(sessionId);
      if (sessionId === "agent-child-review-ui") {
        defaultSessionLaneStore.apply({
          sessionId,
          snapshot: {
            sessionId,
            items: [{ id: "child-status", kind: "assistant", text: "Inspecting checkout UI" }],
            queued: [],
          },
        });
      }
      return true;
    },
    resumeSession: async (sessionId) => {
      resumes.push(sessionId);
      return { sessionId, items: [], queued: [] };
    },
  };
  defaultSessionLaneStore.apply({
    sessionId: session.id,
    snapshot: liveAgentSnapshot,
  });
  try {
    await act(async () => {
      root.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
    });
    await settleStableSurfaceSwitch();
    await waitForDom(
      () => document.querySelector('[data-agent-tag="review-ui"]') != null,
      "Agents should render the live worker",
    );
    const group = document.querySelector(".agent-session-group");
    const rows = group?.querySelectorAll(".agent-activity-row") || [];
    assert.match(group?.querySelector(".agent-session-heading")?.textContent || "", /Review checkout/);
    assert.equal(rows.length, 1, "worker/job projections with one tag must deduplicate");
    const row = rows[0];
    assert.equal(row.querySelector(".agent-activity-primary b")?.textContent, "Reviewer");
    assert.equal(row.querySelector(".agent-activity-primary > span")?.textContent, "· GPT-5.6-Codex",
      "Agents must use the same canonical model label as the chat picker");
    assert.equal(row.querySelector(".agent-activity-copy small")?.textContent, "review-ui");
    assert.match(row.querySelector(".agent-activity-elapsed")?.textContent || "", /^1m \d+s$/);
    assert.equal(row.querySelector(".agent-activity-state svg")?.classList.contains("spin"), true,
      "running agent status should use the rotating progress spinner");
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
    await waitForDom(
      () => document.querySelector('[data-tab-key="agent-session:agent-child-review-ui"]') != null,
      "clicking an agent should open its child session in a workspace tab",
    );
    await waitForDom(
      () => peeks.includes("agent-child-review-ui"),
      "the child transcript should be refreshed without resuming its engine",
    );
    assert.equal(
      document.querySelector('[data-tab-key="agent-session:agent-child-review-ui"] span')?.textContent,
      "review-ui",
    );
    assert.equal(
      document.querySelector('.agent-session-workspace[data-agent-session-id="agent-child-review-ui"] .composer-region'),
      null,
      "child-agent transcript tabs must stay read-only",
    );
    assert.equal(visibleSets.some((ids) => ids.includes("agent-child-review-ui")), true,
      "the child session should join the live viewer pool while its tab is open");
    assert.deepEqual(resumes, [],
      "opening a child-agent transcript must not resume either parent or child");
    assert.deepEqual(
      capabilityCalls.filter(([request]) => request?.capability === "agentControl"),
      [],
      "the child pane must receive host-pushed lane frames without agentControl polling");
  } finally {
    defaultSessionLaneStore.clear();
  }
});

test("Agents observes the global pool without opening parent session lanes", async () => {
  installDom();
  window.localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify({
    open: true,
    tab: "tasks",
    width: 380,
  }));
  defaultSessionLaneStore.clear();
  const session = {
    id: "agent-background-parent",
    preview: "Background agent batch",
    title: "Background agent batch",
    updatedAt: Date.now(),
    activityAt: Date.now(),
    messageCount: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
    working: true,
  };
  const workers = Array.from({ length: 5 }, (_, index) => ({
    tag: `background-${index + 1}`,
    sessionId: `background-child-${index + 1}`,
    ownerSessionId: session.id,
    agent: "worker",
    provider: "openai",
    model: "gpt-5.6-codex",
    status: "running",
    startedAt: Date.now() - ((index + 1) * 1_000),
  }));
  const visibleSets = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session],
    listAgentPool: async () => workers,
    subscribeAgentPool: (listener) => {
      queueMicrotask(() => listener(workers));
      return () => {};
    },
    setVisibleSessions: async (sessionIds) => {
      visibleSets.push([...sessionIds]);
      return true;
    },
  };
  try {
    await act(async () => {
      root.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
    });
    await settleStableSurfaceSwitch();
    await waitForDom(
      () => document.querySelectorAll(".agent-activity-row").length === workers.length,
      "Agents should render every worker from the background session",
    );
    assert.equal(document.querySelectorAll(".agent-activity-row").length, 5);
    assert.equal(visibleSets.some((ids) => ids.includes(session.id)), false,
      "the global pool list must not open a parent transcript lane");
  } finally {
    defaultSessionLaneStore.clear();
  }
});

test("Agents does not resurrect idle workers from stale jobs and preserves a queued tag reuse", async () => {
  installDom();
  defaultSessionLaneStore.clear();
  const session = {
    id: "agent-lifecycle",
    preview: "Agent lifecycle",
    title: "Agent lifecycle",
    updatedAt: Date.now(),
    messageCount: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
    working: true,
  };
  const apply = (snapshot) => defaultSessionLaneStore.apply({
    sessionId: session.id,
    snapshot: { sessionId: session.id, ...snapshot },
  });
  apply({
    agentWorkers: [{
      tag: "reused",
      agent: "heavy-worker",
      provider: "anthropic",
      model: "claude-opus-5",
      status: "running",
      startedAt: Date.now() - 2_000,
    }],
    agentJobs: [{ tag: "reused", task_id: "job-running", status: "running" }],
  });
  try {
    await act(async () => root.render(React.createElement(AgentActivityPane, {
      active: true,
      sessions: [session],
    })));
    assert.equal(document.querySelectorAll('[data-agent-tag="reused"]').length, 1);
    assert.equal(document.querySelector(".agent-activity-primary > span")?.textContent, "· Claude Opus 5");

    await act(async () => apply({
      agentWorkers: [{
        tag: "reused",
        agent: "heavy-worker",
        model: "claude-opus-5",
        stage: "running",
        status: "idle",
      }],
      agentJobs: [{ tag: "reused", task_id: "job-running", status: "running" }],
    }));
    assert.equal(document.querySelector('[data-agent-tag="reused"]'), null,
      "a terminal worker must suppress its lagging running job");
    assert.ok(document.querySelector(".agent-activity-empty"));

    await act(async () => apply({
      agentWorkers: [{ tag: "reused", status: "idle" }],
      agentJobs: [{
        tag: "reused",
        task_id: "job-queued",
        agent: "reviewer",
        model: "gpt-5.6-codex",
        status: "queued",
      }],
    }));
    const queued = document.querySelector('[data-agent-tag="reused"]');
    assert.ok(queued, "a genuinely queued reuse remains visible before its worker starts");
    assert.match(queued?.textContent || "", /Queued/);

    await act(async () => apply({
      agentWorkers: [],
      agentJobs: [{ tag: "unknown", status: "sleeping" }],
    }));
    assert.equal(document.querySelector('[data-agent-tag="unknown"]'), null,
      "unknown or idle-like states must never be assumed active");
  } finally {
    defaultSessionLaneStore.clear();
  }
});

test("Agents keeps one bounded item per agent and collapses sessions independently", async () => {
  installDom();
  defaultSessionLaneStore.clear();
  const session = (id, title) => ({
    id,
    preview: title,
    title,
    updatedAt: Date.now(),
    activityAt: Date.now(),
    messageCount: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
    working: true,
  });
  const sessions = [
    session("agent-session-a", "A session title that must stay inside the utility panel"),
    session("agent-session-b", "Second agent session"),
  ];
  defaultSessionLaneStore.apply({
    sessionId: sessions[0].id,
    snapshot: {
      sessionId: sessions[0].id,
      agentWorkers: [
        {
          tag: "review-a",
          sessionId: "agent-child-review-a",
          agent: "reviewer",
          model: "a-model-name-that-must-ellipsis-inside-the-card",
          status: "running",
          startedAt: Date.now() - 5_000,
        },
        {
          tag: "worker-a",
          sessionId: "agent-child-worker-a",
          agent: "heavy-worker",
          model: "claude-opus",
          status: "running",
          startedAt: Date.now() - 4_000,
        },
      ],
    },
  });
  defaultSessionLaneStore.apply({
    sessionId: sessions[1].id,
    snapshot: {
      sessionId: sessions[1].id,
      agentWorkers: [{
        tag: "review-b",
        sessionId: "agent-child-review-b",
        agent: "reviewer",
        model: "gpt-5.6-codex",
        status: "running",
        startedAt: Date.now() - 3_000,
      }],
    },
  });
  const opened = [];
  try {
    await act(async () => root.render(React.createElement(AgentActivityPane, {
      active: true,
      sessions,
      onOpenSession: (sessionId) => opened.push(sessionId),
    })));
    const groups = Array.from(document.querySelectorAll(".agent-session-group"));
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((group) => group.querySelectorAll(".agent-activity-row").length),
      [2, 1],
      "each live agent must render as its own item",
    );
    const headings = groups.map((group) => group.querySelector(".agent-session-heading"));
    assert.deepEqual(headings.map((heading) => heading?.getAttribute("aria-expanded")), ["true", "true"]);

    await act(async () => headings[0]?.click());
    assert.equal(headings[0]?.getAttribute("aria-expanded"), "false");
    assert.equal(groups[0].querySelector(".agent-activity-rows")?.hidden, true);
    assert.equal(groups[1].querySelector(".agent-activity-rows")?.hidden, false,
      "collapsing one session must not collapse another");

    await act(async () => headings[0]?.click());
    const firstCard = groups[0].querySelector(".agent-activity-row");
    await act(async () => firstCard?.click());
    assert.deepEqual(opened, ["agent-child-review-a"]);

    const css = await readFile(new URL("./desktop.css", import.meta.url), "utf8");
    assert.match(css,
      /\.utility-dock \.agent-activity-page\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/s,
      "the Agents scroller must stay within the panel without horizontal scroll");
    assert.match(css,
      /\.utility-dock \.agent-activity-row\s*\{[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*overflow:\s*hidden;[^}]*border:\s*0;[^}]*background:\s*var\(--mx-rail-item-surface\);[^}]*box-shadow:\s*inset 0 0 0 \.5px var\(--mx-rail-item-outline\);/s,
      "each agent item must share the restrained rail chrome");
  } finally {
    defaultSessionLaneStore.clear();
  }
});

test("rail destinations swap the session panel while the workspace stays mounted", async () => {
  installDom();
  const target = {
    id: "takeover-session",
    preview: "Takeover session",
    title: "Takeover session",
    updatedAt: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  let publishState = () => {};
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: (listener) => {
      publishState = listener;
      return () => { publishState = () => {}; };
    },
    listProjects: async () => [],
    listSessions: async () => [target],
    resumeSession: async () => {
      const next = {
        sessionId: target.id,
        items: [{ id: "takeover-row", kind: "user", text: "Takeover transcript" }],
        queued: [],
      };
      queueMicrotask(() => publishState(next));
      return next;
    },
    startTask: async () => ({ items: [], queued: [] }),
    invokeCapability: async ({ capability }) => ({
      value: capability === "listMediaLanes" || capability === "listMediaAssets" ? [] : null,
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!document.querySelector(`[data-session-id="${target.id}"]`)) {
    await act(async () => {
      document.querySelector('[aria-label="Sessions"]')?.click();
      await Promise.resolve();
    });
  }
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
  });

  const sessionTab = () => Array.from(document.querySelectorAll(".workspace-tab-main"))
    .find((tab) => tab.textContent.includes(target.title));
  const waitForTakeoverTranscript = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((document.querySelector(".transcript")?.textContent || "").includes("Takeover transcript")) return;
      await act(async () => new Promise((resolveWait) => setTimeout(resolveWait, 10)));
    }
  };
  const waitForElement = async (selector) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const element = document.querySelector(selector);
      if (element) return element;
      await act(async () => new Promise((resolveWait) => setTimeout(resolveWait, 10)));
    }
    return null;
  };
  const currentAppShell = () => Array.from(document.querySelectorAll(".app-shell")).at(-1);
  await waitForTakeoverTranscript();
  // The dock survives every rail panel now: open it once up front.
  await act(async () => {
    document.querySelector('[aria-label="Open utility panel"]').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[aria-label="Utility panel"]')?.classList.contains("closing"), false);
  for (const [ariaLabel, title, markerSelector] of [
    ["Open projects", "Projects", ".projects-pane"],
    ["Open workflows", "Workflows", ".workflows-pane"],
    ["Open schedules", "Schedules", '[aria-label="Search schedules"]'],
    ["Open webhooks", "Webhooks", '[aria-label="Search webhooks"]'],
  ]) {
    await act(async () => {
      document.querySelector(`[aria-label="${ariaLabel}"]`).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Panel entry stages the destination hidden while the warm Sessions
    // surface holds the frame (user: 사이드탭 전환 시 빈 프레임이 튐), then
    // swaps atomically after the settle window. The exact commit frame depends
    // on how many task turns act drains, so the invariant is: exactly ONE
    // sidebar surface is ever active, and the destination owns it once settled.
    const sessionsSurfaceActive = () => document.querySelector(
      ".session-sidebar-scroll:not(.session-sidebar-panels)",
    )?.dataset.surfaceActive;
    const panelsSurfaceActive = () =>
      document.querySelector(".session-sidebar-panels")?.dataset.surfaceActive;
    assert.notEqual(sessionsSurfaceActive(), panelsSurfaceActive(),
      `${ariaLabel} must hand off between sidebar surfaces atomically`);
    await settleStableSurfaceSwitch();
    // A cold destination is presented only once its chunk resolved, so the
    // exact commit lands after the module promise rather than after a fixed
    // number of frames.
    await waitForDom(() => panelsSurfaceActive() === "true",
      `${ariaLabel} must present its destination once its content exists`);
    assert.equal(sessionsSurfaceActive(), "false",
      `${ariaLabel} must preserve Sessions behind the active destination`);
    assert.equal(document.querySelector(`[aria-label="${ariaLabel}"]`)?.classList.contains("selected"), true);
    assert.equal(document.querySelector(".session-panel-header")?.textContent, title,
      `${ariaLabel} must retitle the session panel`);
    assert.equal(document.querySelector(".sidebar")?.closest(".app-shell")?.classList.contains("sidebar-collapsed"), false,
      `${ariaLabel} must open the session sidebar`);
    const marker = await waitForElement(markerSelector);
    assert.ok(marker, `${ariaLabel} must mount its list after the lazy view resolves`);
    assert.ok(marker.closest(".session-sidebar-panels"),
      `${ariaLabel} list must live in the sidebar panel area`);
    assert.equal(document.querySelectorAll(".session-sidebar-surface").length, 2,
      `${ariaLabel} must retain Sessions and the visited destination tree`);
    assert.notEqual(document.querySelector('[aria-label="Utility panel"]')?.dataset.state, "closed",
      `${ariaLabel} must not retain a hidden utility dock`);
    assert.equal(sessionTab()?.getAttribute("aria-current"), "page",
      `${ariaLabel} must keep the workspace tab strip intact`);
    assert.match(
      document.querySelector(".transcript")?.textContent || "",
      /Takeover transcript/,
      `${ariaLabel} must keep the session transcript mounted`,
    );
    await act(async () => {
      document.querySelector(`[aria-label="${ariaLabel}"]`).click();
      await Promise.resolve();
    });
    await settleStableSurfaceSwitch();
    assert.equal(document.querySelector(`[aria-label="${ariaLabel}"]`)?.classList.contains("selected"), false,
      `re-selecting ${ariaLabel} must release its selected state`);
    assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), true,
      `re-selecting ${ariaLabel} must collapse the whole session sidebar`);
    // Visited destinations keep their DOM and state across a collapse (the
    // sidebar tree stays mounted, hidden and inert, instead of being
    // destroyed and rebuilt on every expand).
    const collapsedSidebar = document.querySelector(".sidebar.session-sidebar");
    assert.ok(collapsedSidebar, "collapsing must keep the sidebar tree mounted");
    assert.equal(collapsedSidebar.dataset.state, "closed");
    assert.equal(collapsedSidebar.getAttribute("aria-hidden"), "true",
      "a collapsed sidebar stays hidden from assistive technology");
    assert.ok(document.querySelector(markerSelector),
      "a visited rail destination keeps its tree across a collapse");
    assert.equal(document.querySelector(".session-panel-title")?.textContent, "Sessions",
      "the hidden panel area returns to Sessions for the next expand");
    await act(async () => {
      document.querySelector('[aria-label="Sessions"]')?.click();
      await Promise.resolve();
    });
    await settleStableSurfaceSwitch();
    assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), false,
      "reopening the sidebar must expand it");
    assert.equal(document.querySelector(".session-panel-header")?.textContent, "Sessions",
      "reopening after a rail-panel close must start from Sessions");
  }

  assert.equal(document.querySelector(".session-panel-header")?.textContent, "Sessions",
    "creation actions live in the Sessions header, not destination panels");
  const studioTabCount = () => Array.from(document.querySelectorAll(".workspace-tab-main"))
    .filter((tab) => tab.textContent.includes("Studio")).length;
  const studioTabsBefore = studioTabCount();
  await act(async () => {
    document.querySelector('[aria-label="New studio"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  assert.equal(document.querySelector('[aria-label="New studio"]')?.classList.contains("selected"), false,
    "Studio is a creation action and must never read as a selected destination");
  assert.equal(document.querySelector('[aria-label="New studio"]')?.hasAttribute("aria-current"), false);
  assert.equal(document.querySelector('[aria-label="Open workflows"]')?.classList.contains("selected"), false,
    "Studio must not claim a rail destination");
  assert.equal(document.querySelector(".session-panel-header")?.textContent, "Sessions",
    "Studio must return the shared sidebar area to Sessions");
  assert.equal(Boolean(sessionTab()), true,
    "Studio must join the pane tab strip instead of hiding the workspace");
  assert.equal(studioTabCount(), studioTabsBefore + 1);
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[aria-label="New studio"]')?.classList.contains("selected"), false,
    "re-selecting the current sidebar session must leave the Studio tab");

  await act(async () => {
    document.querySelector('[aria-label="New studio"]').click();
    await Promise.resolve();
  });
  assert.equal(studioTabCount(), studioTabsBefore + 2,
    "every Studio header click must create another independent Studio tab");
  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[aria-label="New studio"]')?.classList.contains("selected"), false,
    "New task must leave Studio even when the workspace selection is already current");
  assert.equal(
    Array.from(document.querySelectorAll(".workspace-tab-main"))
      .some((tab) => tab.textContent.includes("Studio")),
    true,
    "leaving Studio must preserve its tab and mounted state",
  );
});

test("keep-open side-panel mode preserves the dock while a rail reselect closes the sidebar", async () => {
  installDom();
  window.localStorage.setItem("mixdog.desktop.side-panel-mode.v1", "keep-open");
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
  const currentAppShell = () => Array.from(document.querySelectorAll(".app-shell")).at(-1);
  assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), false);
  assert.ok(document.querySelector('[aria-label="Close utility panel"]'));
  await act(async () => {
    document.querySelector('[aria-label="Open workflows"]')?.click();
    await Promise.resolve();
  });
  assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), false);
  // Rail panels live in the sidebar (user decision): opening one must leave
  // the chat dock mounted and open.
  assert.ok(document.querySelector('[aria-label="Utility panel"]'),
    "rail panels must not unmount the chat dock");
  await act(async () => {
    document.querySelector('[aria-label="Open workflows"]')?.click();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), true,
    "an active rail destination is a manual sidebar toggle even in keep-open mode");
  assert.ok(document.querySelector('[aria-label="Close utility panel"]'),
    "closing the sidebar from a rail destination must keep the dock available");
  await act(async () => {
    document.querySelector('[aria-label="Sessions"]')?.click();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  assert.equal(currentAppShell()?.classList.contains("sidebar-collapsed"), false);
  assert.equal(document.querySelector(".session-panel-header")?.textContent, "Sessions");
  await act(async () => {
    document.querySelector('[aria-label="Close utility panel"]')?.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('[aria-label="Open utility panel"]'),
    "A manual close must win over keep-open until the next navigation");
});

test("visited rail destinations swap the sidebar surface in the click's own commit", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  // Schedules and Webhooks share the .schedules-pane page shell; they are the
  // only two rail panes without a destination-specific class.
  const plainSchedulePanes = () => Array.from(
    document.querySelectorAll(".session-sidebar-panels .schedules-pane"),
  ).filter((pane) => !pane.classList.contains("workflows-pane")
    && !pane.classList.contains("projects-pane"));
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  const sessionsSurface = () => document.querySelector(
    ".session-sidebar-scroll.session-sidebar-surface:not(.session-sidebar-panels)",
  );
  const visit = async (label, title) => {
    await railClick(label);
    await settleStableSurfaceSwitch();
    // Warm means PRESENTED, not merely requested: wait for the destination to
    // own the panel area before treating it as visited.
    await waitForDom(() => panelTitle() === title, `${label} should present its panel`);
  };
  // First visits are the cold path: they settle hidden until their chunk
  // resolved and committed content.
  await visit("Open projects", "Projects");
  await visit("Open workflows", "Workflows");
  await visit("Open schedules", "Schedules");
  await visit("Open webhooks", "Webhooks");
  assert.equal(plainSchedulePanes().length, 2);
  const [schedulesPane, webhooksPane] = plainSchedulePanes();
  const projectsPane = document.querySelector(".projects-pane");
  const workflowsPane = document.querySelector(".workflows-pane");
  assert.equal(panelTitle(), "Webhooks");

  // No frames, no timers, no font wait: every already-visited destination is
  // mounted, so the visible surface must follow the click's own commit.
  const realRequestFrame = window.requestAnimationFrame;
  const realCancelFrame = window.cancelAnimationFrame;
  const stubFrames = (request, cancel) => {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true, writable: true, value: request,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true, writable: true, value: cancel,
    });
  };
  stubFrames(() => 0, () => {});
  try {
    for (const [label, title, pane] of [
      ["Open projects", "Projects", projectsPane],
      ["Open workflows", "Workflows", workflowsPane],
      ["Open schedules", "Schedules", schedulesPane],
      ["Open webhooks", "Webhooks", webhooksPane],
      ["Open projects", "Projects", projectsPane],
    ]) {
      await railClick(label);
      assert.equal(panelTitle(), title,
        `${label} must present its warm panel without waiting for a frame`);
      assert.equal(pane.dataset.surfaceActive, "true",
        `${label} must reveal its already-mounted pane in the same commit`);
      assert.equal(sessionsSurface()?.dataset.surfaceActive, "false");
      assert.equal(document.querySelector(`[aria-label="${label}"]`)?.classList.contains("selected"),
        true, "the rail keeps its active destination state");
    }
    await railClick("Sessions");
    assert.equal(panelTitle(), "Sessions", "Sessions must return instantly");
    assert.equal(sessionsSurface()?.dataset.surfaceActive, "true");
    for (const pane of [projectsPane, workflowsPane, schedulesPane, webhooksPane]) {
      assert.equal(pane.isConnected, true, "visited rail panels stay mounted");
      assert.equal(pane.dataset.surfaceActive, "false");
    }
  } finally {
    stubFrames(realRequestFrame, realCancelFrame);
  }
});

test("prewarmed rail panels present their first surface and options in the click commit", async () => {
  installDom();
  const projectPath = "C:\\work\\instant-project";
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [{
      path: projectPath,
      name: "Instant project",
      alias: "",
    }],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(() => document.querySelector(".projects-pane") != null
    && document.querySelector(".workflows-pane") != null
    && document.querySelector('[aria-label="Search schedules"]') != null
    && document.querySelector('[aria-label="Search webhooks"]') != null,
  "all rail panels should mount hidden after the post-boot module warmup");
  const pane = document.querySelector(".projects-pane");
  assert.equal(pane.dataset.surfaceActive, "false",
    "prewarming must not steal the visible Sessions panel");

  // A prepared first visit must not need even one animation frame. Stubbing
  // the frame scheduler catches any regression back to the cold settle path.
  const realRequestFrame = window.requestAnimationFrame;
  const realCancelFrame = window.cancelAnimationFrame;
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true, writable: true, value: () => 0,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true, writable: true, value: () => {},
  });
  try {
    await act(async () => {
      document.querySelector('[aria-label="Open projects"]')?.click();
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".session-panel-title")?.textContent, "Projects");
    assert.equal(pane.dataset.surfaceActive, "true",
      "the hidden prepared pane must reveal in the click commit");
    const actions = document.querySelector('[aria-label="Actions for Instant project"]');
    assert.ok(actions, "project row options must already exist on first presentation");
    await act(async () => {
      actions.click();
      await Promise.resolve();
    });
    assert.ok(document.querySelector(
      '[role="menu"][aria-label="Actions for Instant project menu"]',
    ), "the first options click must open its menu immediately");
    for (const [label, title, selector] of [
      ["Open workflows", "Workflows", ".workflows-pane"],
      ["Open schedules", "Schedules", '[aria-label="Search schedules"]'],
      ["Open webhooks", "Webhooks", '[aria-label="Search webhooks"]'],
    ]) {
      await act(async () => {
        document.querySelector(`[aria-label="${label}"]`)?.click();
        await Promise.resolve();
      });
      assert.equal(document.querySelector(".session-panel-title")?.textContent, title,
        `${title} must present on its first click without an animation frame`);
      assert.equal(document.querySelector(selector)
        ?.closest(".stable-takeover-surface")?.dataset.surfaceActive, "true");
    }
  } finally {
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true, writable: true, value: realRequestFrame,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true, writable: true, value: realCancelFrame,
    });
  }
});

test("cold rail requests wait for real content and a sidebar close cancels the pending swap", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  let releaseSchedules = () => {};
  let releaseWebhooks = () => {};
  const schedulesGate = new Promise((resolve) => { releaseSchedules = resolve; });
  const webhooksGate = new Promise((resolve) => { releaseWebhooks = resolve; });
  window.__mixdogSidebarPanelLoader = (panel) => panel === "schedules"
    ? schedulesGate
    : panel === "webhooks"
      ? webhooksGate
      : Promise.resolve();
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  const panelsSurfaceActive = () =>
    document.querySelector(".session-sidebar-panels")?.dataset.surfaceActive;
  const appShell = () => Array.from(document.querySelectorAll(".app-shell")).at(-1);
  // Delayed module resolution: the panel area may not flip to a destination
  // before that destination's own content is committed. Poll the whole cold
  // window instead of a fixed frame count — an empty (fallback=null) frame
  // would be caught by the invariant below.
  const presentOnlyWithContent = async (title, contentSelector) => {
    for (let step = 0; step < 200 && panelTitle() !== title; step += 1) {
      if (panelsSurfaceActive() === "true") {
        assert.ok(document.querySelector(contentSelector),
          `${title} must never be presented as an empty panel`);
      }
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 5));
      });
    }
    assert.equal(panelTitle(), title, `${title} must present once its chunk resolved`);
    assert.ok(document.querySelector(contentSelector),
      `${title} must own committed content when it becomes visible`);
  };
  await railClick("Open schedules");
  assert.equal(panelTitle(), "Sessions",
    "an unresolved destination must not take the panel area in the click commit");
  await act(async () => {
    releaseSchedules();
    await Promise.resolve();
  });
  await presentOnlyWithContent("Schedules", '[aria-label="Search schedules"]');

  // Closing the sidebar during a cold settle cancels the pending commit: a
  // hidden panel must never win the presentation race later.
  await railClick("Open webhooks");
  await railClick("Open webhooks");
  await settleStableSurfaceSwitch();
  await settleStableSurfaceSwitch();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  });
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), true,
    "re-selecting the requested destination collapses the sidebar");
  assert.equal(panelTitle(), "Sessions",
    "a cancelled cold request must not flip the hidden sidebar to its panel");
  assert.equal(panelsSurfaceActive(), "false");

  // Reopening restarts the safe settle for the still-unresolved destination.
  await railClick("Open webhooks");
  await act(async () => {
    releaseWebhooks();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  await presentOnlyWithContent("Webhooks", '[aria-label="Search webhooks"]');
  delete window.__mixdogSidebarPanelLoader;
});

test("visited sidebar destinations keep their DOM and state across a collapse", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  const appShell = () => Array.from(document.querySelectorAll(".app-shell")).at(-1);
  await railClick("Open schedules");
  await settleStableSurfaceSwitch();
  await waitForDom(() => panelTitle() === "Schedules", "Schedules should present");
  const search = document.querySelector('[aria-label="Search schedules"]');
  assert.ok(search);
  // Panel-local React state: the filter is a real interaction, so it proves
  // state (not only DOM identity) survives the collapse.
  const pausedFilter = () => Array.from(
    document.querySelectorAll('[aria-label="Schedule filter"] button'),
  ).find((button) => button.textContent === "Paused");
  await act(async () => {
    pausedFilter().click();
    await Promise.resolve();
  });
  assert.equal(pausedFilter()?.getAttribute("aria-pressed"), "true");

  // Collapse: hidden and inert, never destroyed.
  await railClick("Open schedules");
  await settleStableSurfaceSwitch();
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), true);
  const sidebar = document.querySelector(".sidebar.session-sidebar");
  assert.ok(sidebar, "a collapsed sidebar keeps its tree mounted");
  assert.equal(sidebar.dataset.state, "closed");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector('[aria-label="Search schedules"]'), search,
    "the visited destination keeps its exact DOM node while hidden");
  assert.equal(pausedFilter()?.getAttribute("aria-pressed"), "true",
    "hidden panels keep their own state");

  await railClick("Open schedules");
  await settleStableSurfaceSwitch();
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), false);
  assert.equal(document.querySelector('[aria-label="Search schedules"]'), search,
    "reopening must reuse the preserved destination tree");
  assert.equal(pausedFilter()?.getAttribute("aria-pressed"), "true",
    "reopening must not reset the destination's state");
  assert.equal(panelTitle(), "Schedules",
    "a destination visited before the collapse stays warm after it");
  // Warm switching survives the collapse: no frames, no timers.
  await railClick("Sessions");
  assert.equal(panelTitle(), "Sessions");
  await railClick("Open schedules");
  assert.equal(panelTitle(), "Schedules");
  assert.equal(document.querySelector('[aria-label="Search schedules"]'), search);
});

test("a delayed sidebar chunk keeps the current surface until its content lands", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  // Bounded loader gate: the chunk only starts loading once the test releases
  // it, which is the delayed-module case a cached import cannot reproduce.
  let releaseProjects = () => {};
  const projectsGate = new Promise((resolve) => { releaseProjects = resolve; });
  window.__mixdogSidebarPanelLoader = (panel) =>
    (panel === "projects" ? projectsGate : Promise.resolve());
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  await act(async () => {
    document.querySelector('[aria-label="Open projects"]')?.click();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  await settleStableSurfaceSwitch();
  assert.equal(panelTitle(), "Sessions",
    "a pending chunk must never take the panel area");
  assert.equal(document.querySelector(".projects-pane"), null);
  await act(async () => {
    releaseProjects();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  await waitForDom(() => panelTitle() === "Projects",
    "the destination presents once its chunk resolved");
  assert.ok(document.querySelector(".projects-pane"));
  delete window.__mixdogSidebarPanelLoader;
});

test("a rejected sidebar chunk stays inside its own panel and can be retried", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  window.__mixdogSidebarPanelLoader = (panel) => (panel === "webhooks"
    ? Promise.reject(new Error("chunk offline"))
    : Promise.resolve());
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  await railClick("Open webhooks");
  await settleStableSurfaceSwitch();
  await waitForDom(() => document.querySelector(".sidebar-panel-unavailable") != null,
    "a rejected chunk must degrade to a compact panel-local state");
  await waitForDom(() => panelTitle() === "Webhooks",
    "the failed destination still presents its own panel");
  // The failure never escapes to the root boundary: the shell is intact.
  assert.ok(document.querySelector(".activity-rail"));
  assert.ok(document.querySelector(".session-sidebar"));
  assert.equal(document.querySelector(".desktop-error-surface"), null);
  await railClick("Sessions");
  assert.equal(panelTitle(), "Sessions", "Sessions stays reachable after a panel failure");
  await railClick("Open webhooks");
  assert.equal(panelTitle(), "Sessions",
    "a failed destination is never warm: it re-settles like a cold request");
  await settleStableSurfaceSwitch();
  await waitForDom(() => panelTitle() === "Webhooks", "the failed panel presents again");

  // Recovery: a retry mounts a FRESH lazy component, so a resolvable chunk
  // replaces the unavailable state.
  delete window.__mixdogSidebarPanelLoader;
  await act(async () => {
    document.querySelector(".sidebar-panel-retry")?.click();
    await Promise.resolve();
  });
  await waitForDom(() => document.querySelector('[aria-label="Search webhooks"]') != null,
    "retry must recover the panel once its chunk can load");
  assert.equal(document.querySelector(".sidebar-panel-unavailable"), null);
});

test("collapsing the sidebar closes panel portals and cancels a pending cold swap", async () => {
  installDom();
  let releaseSchedules = () => {};
  const schedulesGate = new Promise((resolve) => { releaseSchedules = resolve; });
  window.__mixdogSidebarPanelLoader = (panel) => panel === "schedules"
    ? schedulesGate
    : Promise.resolve();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  const clickElement = async (selector) => {
    await act(async () => {
      document.querySelector(selector)?.click();
      await Promise.resolve();
    });
    await settleStableSurfaceSwitch();
  };
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  const appShell = () => Array.from(document.querySelectorAll(".app-shell")).at(-1);
  await railClick("Open workflows");
  await settleStableSurfaceSwitch();
  await waitForDom(() => panelTitle() === "Workflows", "Workflows should present");

  // The editor portals to document.body, outside the sidebar's inert subtree.
  await act(async () => {
    document.querySelector('[aria-label="New workflow"]')?.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".schedules-dialog-layer"),
    "the workflow editor opens as a body portal");
  await clickElement(".toolbar-sidebar");
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), true);
  assert.equal(document.querySelector(".schedules-dialog-layer"), null,
    "a titlebar collapse must not leave an editor portal above the workspace");
  assert.ok(document.querySelector(".workflows-pane"),
    "closing the sidebar keeps the panel itself mounted");

  // Reopening keeps the unchanged request and stays warm.
  await clickElement(".toolbar-sidebar");
  assert.equal(panelTitle(), "Workflows");
  await act(async () => {
    document.querySelector('[aria-label="New workflow"]')?.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".schedules-dialog-layer"));
  await clickElement(".sidebar-backdrop");
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), true);
  assert.equal(document.querySelector(".schedules-dialog-layer"), null,
    "the narrow-viewport backdrop close must release the portal too");

  // A cold request that is still pending when the sidebar collapses is
  // cancelled, and re-settles from scratch on reopen.
  await clickElement(".toolbar-sidebar");
  await railClick("Open schedules");
  await act(async () => {
    document.querySelector(".toolbar-sidebar")?.click();
    await Promise.resolve();
  });
  await settleStableSurfaceSwitch();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  });
  assert.equal(appShell()?.classList.contains("sidebar-collapsed"), true);
  assert.notEqual(panelTitle(), "Schedules",
    "a collapse must cancel the pending cold swap");
  await clickElement(".toolbar-sidebar");
  await act(async () => {
    releaseSchedules();
    await Promise.resolve();
  });
  await waitForDom(() => panelTitle() === "Schedules",
    "reopening re-settles the still-requested destination");
  delete window.__mixdogSidebarPanelLoader;
});

test("switching destinations closes the previous panel's body portal in the same commit", async () => {
  installDom();
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    invokeCapability: async () => ({ value: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const railClick = async (label) => {
    await act(async () => {
      document.querySelector(`[aria-label="${label}"]`)?.click();
      await Promise.resolve();
    });
  };
  const panelTitle = () => document.querySelector(".session-panel-title")?.textContent;
  const visit = async (label, title) => {
    await railClick(label);
    await settleStableSurfaceSwitch();
    await waitForDom(() => panelTitle() === title, `${label} should present`);
  };
  await visit("Open projects", "Projects");
  await visit("Open workflows", "Workflows");
  await act(async () => {
    document.querySelector('[aria-label="New workflow"]')?.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".schedules-dialog-layer"));
  // Warm switch: the panel area changes owner in the click's own commit, so
  // the outgoing panel's portal must disappear with it.
  await railClick("Open projects");
  assert.equal(panelTitle(), "Projects");
  assert.equal(document.querySelector(".schedules-dialog-layer"), null,
    "another destination taking the panel area closes the previous portal");
  assert.ok(document.querySelector(".workflows-pane"),
    "only the modal closes: the panel tree stays mounted");
  // Reopening the previous destination starts without a stale editor.
  await railClick("Open workflows");
  assert.equal(panelTitle(), "Workflows");
  assert.equal(document.querySelector(".schedules-dialog-layer"), null);
});

test("the boot surface focuses the composer for immediate typing", async () => {
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.activeElement,
    document.querySelector('textarea[aria-label="Message Mixdog"]'),
    "the boot surface must focus the composer so typing works immediately");
});

test("a fresh install shows only the watermark shortcuts and Ctrl+N opens the first pane", async () => {
  installDom();
  // The suite baseline seeds a restored pane; a FRESH install has none.
  window.localStorage.removeItem("mixdog.desktop.pane-layout.v1");
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(document.querySelector(".workspace-empty"),
    "boot lands on the empty workspace guidance screen");
  assert.equal(document.querySelector('textarea[aria-label="Message Mixdog"]'), null,
    "no composer may exist before the first pane opens");
  assert.equal(document.querySelector(".workspace-tab"), null,
    "the empty workspace renders no tab strip");
  assert.ok(document.querySelector(".welcome-logo path"),
    "the blank editor keeps one quiet brand watermark");
  assert.equal(document.querySelector(".welcome-logo rect"), null,
    "the watermark must not render the old app-icon tile");
  assert.equal(document.querySelector(".welcome-wordmark"), null);
  assert.equal(document.querySelector(".welcome-action"), null,
    "the blank editor must not duplicate shortcuts with action buttons");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".welcome-shortcuts > div"))
      .map((row) => row.textContent.replace(/\s+/g, "")),
    [
      "NewtaskCtrl+N",
      "SwitchtabCtrl+←/→",
      "SwitchpaneAlt+←/→",
      "SidebarCtrl+B",
      "SettingsCtrl+,",
    ],
  );
  const back = new window.KeyboardEvent("keydown", {
    key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true,
  });
  const forward = new window.KeyboardEvent("keydown", {
    key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true,
  });
  await act(async () => {
    window.dispatchEvent(back);
    window.dispatchEvent(forward);
  });
  assert.equal(back.defaultPrevented, true,
    "Ctrl+Left stays owned by tab cycling even before any tab exists");
  assert.equal(forward.defaultPrevented, true,
    "Ctrl+Right stays owned by tab cycling even before any tab exists");
  const createTask = new window.KeyboardEvent("keydown", {
    key: "n", ctrlKey: true, bubbles: true, cancelable: true,
  });
  await act(async () => {
    window.dispatchEvent(createTask);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(createTask.defaultPrevented, true);
  assert.ok(document.querySelector('textarea[aria-label="Message Mixdog"]'),
    "Ctrl+N opens the first pane with the composer");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workspace-tab-main span")).map((tab) => tab.textContent.trim()),
    ["New task"],
  );
  const editorArrow = new window.KeyboardEvent("keydown", {
    key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true,
  });
  const composerField = document.querySelector('textarea[aria-label="Message Mixdog"]');
  composerField.dispatchEvent(editorArrow);
  assert.equal(editorArrow.defaultPrevented, true,
    "Ctrl+Arrow cycles tabs from the composer too (user: 어디서든 라벨 이동)");
  composerField.value = "hello world";
  const typedArrow = new window.KeyboardEvent("keydown", {
    key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true,
  });
  composerField.dispatchEvent(typedArrow);
  assert.equal(typedArrow.defaultPrevented, true,
    "a filled composer still cycles — only Monaco/xterm own Ctrl+Arrow via defaultPrevented");
});

test("unfocused New task panes inherit the engine model before their first picker click", async () => {
  installDom();
  const route = {
    provider: "openai",
    model: "gpt-default",
    effort: "high",
    fast: true,
  };
  const modelOption = {
    ...route,
    display: "GPT Default",
    effortOptions: [{ value: "high", label: "High" }],
    fastCapable: true,
    fastPreferred: true,
  };
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "pane_default_a",
        tabs: [{ kind: "new", draftId: "draft_default_a" }],
        activeKey: "new:draft_default_a",
      },
      second: {
        type: "leaf",
        id: "pane_default_b",
        tabs: [{ kind: "new", draftId: "draft_default_b" }],
        activeKey: "new:draft_default_b",
      },
    },
    focusedLeafId: "pane_default_b",
  }));
  window.localStorage.setItem("mixdog.desktop-model-catalog.v1", JSON.stringify({
    updatedAt: Date.now(),
    models: [modelOption],
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [],
      queued: [],
      ...route,
      fastCapable: true,
    }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    listProviderModels: async () => [modelOption],
    invokeCapability: async ({ capability }) => ({
      value: capability === "listWorkflows"
        ? [{ id: "solo", name: "Solo", active: true }]
        : null,
      snapshot: { items: [], queued: [] },
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const modelLabels = () => Array.from(
    document.querySelectorAll(".pane-cell .model-trigger"),
    (trigger) => trigger.textContent.trim(),
  );
  assert.deepEqual(modelLabels(), ["GPT-Default", "GPT-Default"],
    "focused and unfocused drafts must display the same effective engine model");
  assert.equal(modelLabels().some((label) => label.includes("Select model")), false);

  const unfocusedPane = document.querySelector('[data-pane-id="pane_default_a"]');
  const modelTrigger = unfocusedPane.querySelector(".model-trigger");
  await act(async () => {
    modelTrigger.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
    }));
    modelTrigger.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(".model-picker-dialog"),
    "the first click should open the background draft's model picker");
  assert.deepEqual(modelLabels(), ["GPT-Default", "GPT-Default"],
    "focusing a draft to open its picker must not change the displayed model");
});

test("split chat panes keep one live surface and activate controls on the first click", async () => {
  installDom();
  const route = {
    provider: "openai",
    model: "gpt-pane",
    effort: "high",
    fast: true,
  };
  const workflow = { id: "solo", name: "Solo" };
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "pane_a",
        tabs: [{ kind: "new", draftId: "draft_a" }],
        activeKey: "new:draft_a",
      },
      second: {
        type: "leaf",
        id: "pane_b",
        tabs: [{ kind: "new", draftId: "draft_b" }],
        activeKey: "new:draft_b",
      },
    },
    focusedLeafId: "pane_b",
  }));
  const panePrefs = { projectPath: "", modelSelection: route, workflow };
  window.localStorage.setItem("mixdog.desktop-draft-pane-prefs.v1", JSON.stringify([
    ["draft_a", panePrefs],
    ["draft_b", panePrefs],
  ]));
  window.localStorage.setItem("mixdog.desktop-last-new-task-prefs.v1", JSON.stringify(panePrefs));
  window.localStorage.setItem("mixdog.desktop-model-catalog.v1", JSON.stringify({
    updatedAt: Date.now(),
    models: [{
      provider: "openai",
      model: "gpt-pane",
      display: "GPT Pane",
      effortOptions: [{ value: "high", label: "High" }],
      fastCapable: true,
      fastPreferred: true,
    }],
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    listProviderModels: async () => [{
      provider: "openai",
      model: "gpt-pane",
      display: "GPT Pane",
      effortOptions: [{ value: "high", label: "High" }],
      fastCapable: true,
      fastPreferred: true,
    }],
    invokeCapability: async ({ capability }) => ({
      value: capability === "listWorkflows"
        ? [{ id: "solo", name: "Solo", active: true }]
        : null,
      snapshot: { items: [], queued: [] },
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const modelLabels = () => Array.from(
    document.querySelectorAll(".pane-cell .model-trigger"),
    (trigger) => trigger.textContent.trim(),
  );
  const workflowLabels = () => Array.from(
    document.querySelectorAll('.pane-cell [aria-label="Workflow"]'),
    (trigger) => trigger.textContent.trim(),
  );
  assert.deepEqual(modelLabels(), ["GPT-Pane", "GPT-Pane"],
    "focused and unfocused panes must show the same staged model");
  assert.deepEqual(workflowLabels(), ["Solo", "Solo"],
    "focused and unfocused panes must show the same staged workflow");
  // The context/remote cluster lives in each pane's own TASK strip now
  // (user decision: File-breadcrumb grammar, icons on the right) — the tab
  // row keeps no per-pane action slot.
  assert.equal(document.querySelectorAll(".workspace-tabs-trailing .session-header-status").length, 0,
    "task tab strips must not carry the context/remote cluster anymore");
  assert.equal(
    document.querySelectorAll(".pane-cell .session-header .session-header-status").length,
    2,
    "every chat pane's strip must reserve its action cluster");
  assert.equal(document.querySelector(".workspace-corner-controls"), null,
    "chat controls must not float over the transcript");

  const firstPane = document.querySelector('[data-pane-id="pane_a"]');
  const modelTrigger = firstPane.querySelector(".model-trigger");
  await act(async () => {
    modelTrigger.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
    }));
    modelTrigger.click();
    await Promise.resolve();
  });
  assert.equal(modelTrigger.isConnected, true,
    "focusing a pane must preserve the clicked model trigger");
  assert.ok(document.querySelector(".model-picker-dialog"),
    "the first model-trigger click must both focus the pane and open the picker");
  assert.deepEqual(modelLabels(), ["GPT-Pane", "GPT-Pane"]);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const secondPane = document.querySelector('[data-pane-id="pane_b"]');
  const workflowTrigger = secondPane.querySelector('[aria-label="Workflow"]');
  await act(async () => {
    workflowTrigger.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
    }));
    workflowTrigger.click();
    await Promise.resolve();
  });
  assert.equal(workflowTrigger.isConnected, true,
    "focusing a pane must preserve the clicked workflow trigger");
  assert.ok(document.querySelector('.mx-menu [role="option"]'),
    "the first workflow-trigger click must both focus the pane and open the picker");
  assert.deepEqual(workflowLabels(), ["Solo", "Solo"]);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const firstChatSurface = firstPane.querySelector(".pane-chat-surface");
  await act(async () => {
    firstChatSurface.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(firstPane.querySelector(".pane-cell")?.classList.contains("is-focused"), true,
    "clicking a background chat pane should select that pane");
  assert.equal(document.activeElement,
    firstPane.querySelector('textarea[aria-label="Message Mixdog"]'),
    "clicking a task surface should place the caret in that pane's composer");
});

test("rapid split-pane focus never paints the previous pane transcript into the target", async () => {
  installDom();
  await preloadMarkdownBody();
  const paneA = {
    sessionId: "pane-session-a",
    items: [{ id: "pane-a-row", kind: "user", text: "Pane A transcript" }],
    queued: [],
  };
  const paneB = {
    sessionId: "pane-session-b",
    items: [{ id: "pane-b-row", kind: "user", text: "Pane B transcript" }],
    queued: [],
  };
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "pane_session_a",
        tabs: [{ kind: "session", id: "pane-session-a" }],
        activeKey: "session:pane-session-a",
      },
      second: {
        type: "leaf",
        id: "pane_session_b",
        tabs: [{ kind: "session", id: "pane-session-b" }],
        activeKey: "session:pane-session-b",
      },
    },
    focusedLeafId: "pane_session_b",
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", "pane-session-b");
  let publishLane;
  let finishPaneA;
  const paneAResume = new Promise((resolve) => {
    finishPaneA = () => resolve(paneA);
  });
  const resumes = [];
  window.mixdogDesktop = {
    getSnapshot: async () => paneB,
    subscribeState: () => () => {},
    subscribeSessionState: (listener) => {
      publishLane = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => [
      {
        id: "pane-session-a", title: "Pane A", preview: "Pane A", updatedAt: 1,
        currentSession: false, cwd: "C:\\work", classification: "task", projectPath: null,
      },
      {
        id: "pane-session-b", title: "Pane B", preview: "Pane B", updatedAt: 2,
        currentSession: true, cwd: "C:\\work", classification: "task", projectPath: null,
      },
    ],
    resumeSession: async (id) => {
      resumes.push(id);
      return id === "pane-session-a" ? paneAResume : paneB;
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    publishLane({ sessionId: "pane-session-a", snapshot: paneA });
    publishLane({ sessionId: "pane-session-b", snapshot: paneB });
    await Promise.resolve();
  });
  const paneText = (id) => document.querySelector(`[data-pane-id="${id}"] .transcript`)
    ?.textContent || "";
  assert.match(paneText("pane_session_a"), /Pane A transcript/);
  assert.match(paneText("pane_session_b"), /Pane B transcript/);
  const paneBTranscript = document.querySelector('[data-pane-id="pane_session_b"] .transcript');
  let paneBScrollTop = 700;
  Object.defineProperties(paneBTranscript, {
    scrollHeight: { get: () => 1_000, configurable: true },
    clientHeight: { get: () => 300, configurable: true },
    scrollTop: {
      get: () => paneBScrollTop,
      set: (value) => { paneBScrollTop = Math.min(700, Math.max(0, Number(value) || 0)); },
      configurable: true,
    },
    scrollTo: {
      value: (options) => {
        paneBScrollTop = Math.min(700, Math.max(0, Number(options?.top) || 0));
      },
      configurable: true,
    },
  });

  await act(async () => {
    document.querySelector('[data-pane-id="pane_session_a"] .transcript')
      .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
  assert.match(paneText("pane_session_a"), /Pane A transcript/);

  await act(async () => {
    paneBTranscript
      .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    paneBScrollTop = 550;
    paneBTranscript.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    paneBTranscript.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["pane-session-a"],
    "the second focus waits behind the in-flight host resume");
  assert.match(paneText("pane_session_b"), /Pane B transcript/,
    "the newly focused pane must retain its own lane frame");
  assert.doesNotMatch(paneText("pane_session_b"), /Pane A transcript/,
    "the previous pane transcript must never paint into the target pane");
  assert.equal(paneBScrollTop, 550,
    "an observed scroll must not schedule a second forced correction");
  assert.equal(document.querySelector('[data-pane-id="pane_session_b"] .jump-to-latest'), null,
    "a focus-only click must not disarm bottom follow");

  await act(async () => {
    finishPaneA();
    await paneAResume;
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["pane-session-a", "pane-session-b"]);
  assert.match(paneText("pane_session_b"), /Pane B transcript/);
  assert.doesNotMatch(paneText("pane_session_b"), /Pane A transcript/);
});

test("focusing a session pane under an inactive New task keeps that pane's lane painted", async () => {
  installDom();
  await preloadMarkdownBody();
  defaultSessionLaneStore.clear();
  const sessionId = "hide-guard-session";
  const paneSnapshot = {
    sessionId,
    items: [{ id: "hide-guard-row", kind: "user", text: "Hide guard transcript" }],
    queued: [],
  };
  // The global route snapshot still belongs to the previous route: an inactive
  // New task hides it (hideLiveSnapshot) so the draft pane paints empty.
  const draftLeak = {
    sessionId: "",
    items: [{ id: "draft-leak-row", kind: "user", text: "Draft leak transcript" }],
    queued: [],
  };
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "pane_hide_draft",
        tabs: [{ kind: "new", draftId: "draft_hide" }],
        activeKey: "new:draft_hide",
      },
      second: {
        type: "leaf",
        id: "pane_hide_session",
        tabs: [{ kind: "session", id: sessionId }],
        activeKey: `session:${sessionId}`,
      },
    },
    focusedLeafId: "pane_hide_draft",
  }));
  let publishLane;
  const resumes = [];
  window.mixdogDesktop = {
    getSnapshot: async () => draftLeak,
    subscribeState: () => () => {},
    subscribeSessionState: (listener) => {
      publishLane = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => [{
      id: sessionId, title: "Hide guard", preview: "Hide guard", updatedAt: 1,
      currentSession: false, cwd: "C:\\work", classification: "task", projectPath: null,
    }],
    // The route transition never settles, so pane focus lands while the global
    // selection is STILL the inactive New task — exactly the window in which a
    // draft-scoped hide must not reach a session pane.
    resumeSession: async (id) => {
      resumes.push(id);
      return new Promise(() => {});
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    publishLane({ sessionId, snapshot: paneSnapshot });
    await Promise.resolve();
  });
  const paneText = (id) => document.querySelector(`[data-pane-id="${id}"] .transcript`)
    ?.textContent || "";
  assert.doesNotMatch(paneText("pane_hide_draft"), /Draft leak transcript/,
    "a focused draft pane stays hidden while the New task is inactive");
  assert.match(paneText("pane_hide_session"), /Hide guard transcript/);

  await act(async () => {
    document.querySelector('[data-pane-id="pane_hide_session"] .transcript')
      .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    document.querySelector('[data-pane-id="pane_hide_session"] .transcript')
      .dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(
    document.querySelector('[data-pane-id="pane_hide_session"] .pane-cell')
      ?.classList.contains("is-focused"),
    true,
    "clicking a session pane focuses it");
  assert.match(paneText("pane_hide_session"), /Hide guard transcript/,
    "the newly focused session pane must not adopt the draft-scoped hide");
  assert.doesNotMatch(paneText("pane_hide_draft"), /Draft leak transcript/,
    "the now-unfocused draft pane must still not paint the global route snapshot");
  defaultSessionLaneStore.clear();
});

test("four-pane rapid focus keeps every lane transcript, conversation node, and scroll state", async () => {
  installDom();
  await preloadMarkdownBody();
  defaultSessionLaneStore.clear();
  const letters = ["a", "b", "c", "d"];
  const ids = letters.map((letter) => `quad-session-${letter}`);
  const cells = letters.map((letter) => `quad_cell_${letter}`);
  const now = Date.now();
  const patch = [
    "diff --git a/quad-c.txt b/quad-c.txt",
    "--- a/quad-c.txt",
    "+++ b/quad-c.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  // Every pane owns a DIFFERENT route, context usage, background-work and
  // review state. Any globally-read (focused-pane) value therefore shows up as
  // a changed pane signature instead of silently passing.
  const snapshots = new Map([
    [ids[0], {
      sessionId: ids[0],
      items: [{ id: `${ids[0]}-row`, kind: "user", text: "Quad A transcript" }],
      queued: [],
      provider: "openai", model: "gpt-quad-a", effort: "low",
      workflow: { id: "solo", name: "Solo" },
      stats: { currentContextTokens: 100 },
      displayContextWindow: 1_000,
    }],
    [ids[1], {
      sessionId: ids[1],
      items: [{ id: `${ids[1]}-row`, kind: "user", text: "Quad B transcript" }],
      queued: [],
      provider: "openai", model: "gpt-quad-b", effort: "medium",
      workflow: { id: "pair", name: "Pair" },
      stats: { currentContextTokens: 400 },
      displayContextWindow: 1_000,
      agentWorkers: [
        { tag: "quad-worker-one", status: "running", startedAt: now - 5_000 },
        { tag: "quad-worker-two", status: "running", startedAt: now - 6_000 },
      ],
    }],
    [ids[2], {
      sessionId: ids[2],
      items: [
        { id: `${ids[2]}-row`, kind: "user", text: "Quad C transcript" },
        {
          id: `${ids[2]}-patch`,
          kind: "tool",
          name: "apply_patch",
          args: { patch },
          result: "ok",
          count: 1,
          completedCount: 1,
        },
      ],
      queued: [],
      provider: "openai", model: "gpt-quad-c", effort: "high",
      workflow: { id: "solo", name: "Solo" },
      stats: { currentContextTokens: 700 },
      displayContextWindow: 1_000,
    }],
    [ids[3], {
      sessionId: ids[3],
      items: [{ id: `${ids[3]}-row`, kind: "user", text: "Quad D transcript" }],
      queued: [],
      provider: "openai", model: "gpt-quad-d", effort: "high",
      workflow: { id: "solo", name: "Solo" },
      stats: { currentContextTokens: 900 },
      displayContextWindow: 1_000,
      busy: true,
      spinner: { mode: "thinking", verb: "Reasoning", startedAt: now - 4_000 },
    }],
  ]);
  const catalog = ids.map((id, index) => ({
    provider: "openai",
    model: `gpt-quad-${letters[index]}`,
    display: `GPT Quad ${letters[index].toUpperCase()}`,
    effortOptions: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    fastCapable: false,
  }));
  const leaf = (index) => ({
    type: "leaf",
    id: cells[index],
    tabs: [{ kind: "session", id: ids[index] }],
    activeKey: `session:${ids[index]}`,
  });
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "split", direction: "column", ratio: 0.5, first: leaf(0), second: leaf(2) },
      second: { type: "split", direction: "column", ratio: 0.5, first: leaf(1), second: leaf(3) },
    },
    focusedLeafId: cells[0],
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", ids[0]);
  let publishLane;
  const resumes = [];
  // A deferred is created only INSIDE the host call, so no resume can settle
  // before the router actually invoked it — the queue/coalescing contract is
  // exercised, not simulated.
  const pendingResumes = new Map(ids.map((id) => [id, []]));
  window.mixdogDesktop = {
    getSnapshot: async () => snapshots.get(ids[0]),
    subscribeState: () => () => {},
    subscribeSessionState: (listener) => {
      publishLane = listener;
      return () => {};
    },
    listProjects: async () => [],
    listProviderModels: async () => catalog,
    invokeCapability: async ({ capability }) => ({
      value: capability === "listWorkflows"
        ? [{ id: "solo", name: "Solo", active: true }, { id: "pair", name: "Pair" }]
        : capability === "getTurnReviewDiff" ? { supported: false } : null,
    }),
    listSessions: async () => ids.map((id, index) => ({
      id,
      title: `Quad ${letters[index].toUpperCase()}`,
      preview: `Quad ${letters[index].toUpperCase()}`,
      updatedAt: ids.length - index,
      currentSession: index === 0,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
    })),
    peekSession: async (id) => {
      publishLane?.({ sessionId: id, snapshot: snapshots.get(id) });
      return true;
    },
    setVisibleSessions: async (sessionIds) => {
      for (const id of sessionIds) publishLane?.({ sessionId: id, snapshot: snapshots.get(id) });
      return true;
    },
    resumeSession: async (id) => {
      resumes.push(id);
      let settle;
      const promise = new Promise((resolve) => { settle = () => resolve(snapshots.get(id)); });
      (pendingResumes.get(id) ?? []).push({ promise, settle });
      return promise;
    },
  };
  try {
    await act(async () => {
      root.render(React.createElement(App));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    await act(async () => {
      for (const id of ids) publishLane?.({ sessionId: id, snapshot: snapshots.get(id) });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const paneOf = (cell) => document.querySelector(`[data-pane-id="${cell}"]`);
    const transcriptOf = (cell) => paneOf(cell)?.querySelector(".transcript");
    const paneText = (cell) => transcriptOf(cell)?.textContent || "";
    const paneSignature = (cell) => {
      const pane = paneOf(cell);
      const transcript = pane?.querySelector(".transcript");
      return {
        sessionKey: transcript?.getAttribute("data-session-key") || "",
        // Message ownership is stable; live activity copy contains an elapsed
        // second counter and is asserted separately through `liveActivity`.
        transcript: Array.from(pane?.querySelectorAll(".thread .message") || [],
          (node) => node.textContent || "").join("\n"),
        rows: pane?.querySelectorAll(".thread .message").length ?? -1,
        model: pane?.querySelector(".model-trigger")?.textContent?.trim() || "",
        effort: pane?.querySelector('[aria-label="Reasoning effort"]')?.textContent?.trim() || "",
        workflow: pane?.querySelector('[aria-label="Workflow"]')?.textContent?.trim() || "",
        usage: (pane?.querySelector('.session-context-indicator [role="tooltip"]')?.textContent || "")
          .replace(/\s+/g, ""),
        liveWork: pane?.querySelector(".live-work-count")?.textContent || "",
        // Scroll ownership travels with the signature, so a transient scroll
        // or follow regression fails at the exact focus step that caused it.
        scrollTop: Number(transcript?.scrollTop || 0),
        following: transcript?.getAttribute("data-following") || "",
        jumpChip: Boolean(pane?.querySelector(".jump-to-latest")),
        // Geometry contract: the review slot and the composer must exist
        // exactly once per pane whether or not the pane is focused.
        reviewBar: Boolean(pane?.querySelector(".turn-review-bar")),
        reviewSlots: pane?.querySelectorAll(".turn-review-slot").length ?? -1,
        composers: pane?.querySelectorAll('textarea[aria-label="Message Mixdog"]').length ?? -1,
        liveActivity: pane?.querySelector(".live-activity")?.getAttribute("data-mode") || "",
      };
    };
    await waitForDom(
      () => cells.every((cell) => {
        const label = paneOf(cell)?.querySelector(".model-trigger")?.textContent?.trim() || "";
        return label !== "" && label !== "Select model";
      }),
      "every pane must resolve its own catalog route before the focus storm",
    );

    // Pane C is the reader: scrolled up and off bottom-follow BEFORE any focus
    // churn, so later focus-only clicks may not move it.
    const paneC = transcriptOf(cells[2]);
    let paneCScrollTop = 900;
    Object.defineProperties(paneC, {
      scrollHeight: { get: () => 1_000, configurable: true },
      clientHeight: { get: () => 300, configurable: true },
      scrollTop: {
        get: () => paneCScrollTop,
        set: (value) => { paneCScrollTop = Math.min(700, Math.max(0, Number(value) || 0)); },
        configurable: true,
      },
      scrollTo: {
        value: (options) => {
          paneCScrollTop = Math.min(700, Math.max(0, Number(options?.top) || 0));
        },
        configurable: true,
      },
    });
    await act(async () => {
      paneC.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -2 }));
      paneCScrollTop = 695;
      paneC.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(paneC.getAttribute("data-following"), "false",
      "a small upward wheel inside the old ten-pixel bottom band must retain user ownership");
    assert.equal(paneCScrollTop, 695,
      "the first small wheel movement must not be rolled back to the bottom");
    await act(async () => {
      paneC.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      paneCScrollTop = 700;
      paneC.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(paneC.getAttribute("data-following"), "true",
      "only an explicit downward arrival at the true bottom may resume follow");
    await act(async () => {
      paneC.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      paneCScrollTop = 420;
      paneC.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(paneC.getAttribute("data-following"), "false",
      "an upward wheel gesture must release bottom follow for that pane");
    assert.equal(paneCScrollTop, 420);
    assert.ok(document.querySelector(`[data-pane-id="${cells[2]}"] .jump-to-latest`),
      "the scrolled-up pane must offer its jump chip");

    const conversations = cells.map((cell) => paneOf(cell)?.querySelector(".conversation"));
    assert.equal(conversations.filter(Boolean).length, 4,
      "every session pane must own a mounted conversation");
    const baseline = cells.map((cell) => paneSignature(cell));
    // The baseline itself must be per-pane distinct; otherwise the equality
    // checks below would pass on a globally shared (leaked) presentation.
    assert.deepEqual(baseline.map((entry) => entry.sessionKey), ids);
    assert.deepEqual(baseline.map((entry) => entry.usage.match(/Usage\d+%/)?.[0]),
      ["Usage10%", "Usage40%", "Usage70%", "Usage90%"],
      "each pane must read its OWN context usage");
    assert.deepEqual(baseline.map((entry) => entry.liveWork), ["", "2", "", ""],
      "only the pane whose lane has running workers may show background work");
    assert.deepEqual(baseline.map((entry) => entry.reviewBar), [false, false, true, false],
      "only the pane whose turn changed files may show a review bar");
    assert.deepEqual(baseline.map((entry) => entry.liveActivity), ["", "", "", "thinking"],
      "only the busy pane may show live activity");
    assert.deepEqual(baseline.map((entry) => entry.reviewSlots), [1, 1, 1, 1]);
    assert.deepEqual(baseline.map((entry) => entry.composers), [1, 1, 1, 1]);
    assert.deepEqual(baseline.map((entry) => entry.scrollTop), [0, 0, 420, 0],
      "only the reader pane carries a user scroll offset");
    assert.deepEqual(baseline.map((entry) => entry.following), ["true", "true", "false", "true"],
      "only the reader pane released bottom follow");
    assert.deepEqual(baseline.map((entry) => entry.jumpChip), [false, false, true, false],
      "only the pane that left the bottom offers a jump chip");
    assert.ok(baseline.every((entry) => entry.rows >= 1),
      "every pane must have painted at least its own transcript row");
    assert.equal(new Set(baseline.map((entry) => entry.model)).size, 4,
      "four different lane routes must render four different model labels");
    assert.equal(new Set(baseline.slice(0, 3).map((entry) => entry.effort)).size, 3,
      "low/medium/high panes must render three different effort labels");
    // Session panes never mount the draft workflow chip (App.tsx passes
    // showProjectSelector only for drafts). Recorded so a focus click cannot
    // introduce one pane's draft chrome into another pane.
    assert.deepEqual(baseline.map((entry) => entry.workflow), ["", "", "", ""],
      "a session pane must not render a draft workflow control");

    const assertPaneContract = (phase, focusedCell) => {
      for (const [index, cell] of cells.entries()) {
        const own = letters[index].toUpperCase();
        assert.match(paneText(cell), new RegExp(`Quad ${own} transcript`),
          `${cell} must keep its own lane transcript ${phase}`);
        for (const other of letters.map((letter) => letter.toUpperCase())) {
          if (other === own) continue;
          assert.doesNotMatch(paneText(cell), new RegExp(`Quad ${other} transcript`),
            `${cell} must never paint session ${other} ${phase}`);
        }
        assert.equal(paneOf(cell)?.querySelector(".conversation"), conversations[index],
          `${cell} must keep its Conversation node ${phase}`);
        assert.deepEqual(paneSignature(cell), baseline[index],
          `${cell} presentation must not change ${phase}`);
        assert.equal(
          paneOf(cell)?.querySelector(".pane-cell")?.classList.contains("is-focused"),
          cell === focusedCell,
          `${cell} focus state must match the clicked pane ${phase}`,
        );
      }
    };
    const focusPane = async (cell) => {
      await act(async () => {
        const transcript = transcriptOf(cell);
        transcript.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        transcript.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
      });
      assertPaneContract(`in the commit of the ${cell} focus click`, cell);
      await act(async () => { await Promise.resolve(); });
      assertPaneContract(`in the microtask after focusing ${cell}`, cell);
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      assertPaneContract(`in the frame after focusing ${cell}`, cell);
    };
    const waitForResumeCalls = async (expected, message) => {
      await waitForDom(() => resumes.length >= expected.length, message);
      assert.deepEqual(resumes, expected, message);
    };
    const settleResume = async (id, index, message) => {
      const call = (pendingResumes.get(id) ?? [])[index];
      assert.ok(call, message);
      await act(async () => {
        call.settle();
        await call.promise;
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    };

    // The restored focused pane already owns the host session, so startup
    // hydrates through lane frames without a resume: the storm below therefore
    // starts from an idle router.
    assert.deepEqual(resumes, [],
      "a restored focused pane must not re-resume its own session at startup");
    assertPaneContract("after startup hydration", cells[0]);

    // A -> B -> C -> D -> A. Only the first focus may open a host transition;
    // every later target queues behind it and the LAST one wins.
    await focusPane(cells[1]);
    await waitForResumeCalls([ids[1]],
      "the first focus of the storm starts one host resume");
    await focusPane(cells[2]);
    assert.deepEqual(resumes, [ids[1]],
      "a focus during an in-flight resume must queue instead of calling the host");
    await focusPane(cells[3]);
    assert.deepEqual(resumes, [ids[1]],
      "a third rapid focus must still not open a parallel host transition");
    await focusPane(cells[0]);
    assert.deepEqual(resumes, [ids[1]],
      "the final focus target must also wait behind the in-flight resume");

    // The in-flight B resume completes LATE — after A already became the
    // latest target — so the router must hand off to A and drop C and D.
    await settleResume(ids[1], 0, "pane B's resume must be invoked before it settles");
    await waitForResumeCalls([ids[1], ids[0]],
      "a delayed completion must hand off to the coalesced latest target");
    assert.deepEqual(pendingResumes.get(ids[2]), [],
      "the superseded C target must never reach the host");
    assert.deepEqual(pendingResumes.get(ids[3]), [],
      "the superseded D target must never reach the host");
    assertPaneContract("after the delayed B resume completed", cells[0]);

    await settleResume(ids[0], 0, "the coalesced latest resume must be invoked before it settles");
    assert.deepEqual(resumes, [ids[1], ids[0]],
      "the drained queue must not schedule another host call");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assertPaneContract("after the whole focus storm settled", cells[0]);

    assert.equal(paneCScrollTop, 420,
      "focus-only clicks must not rewrite the reader pane's scroll offset");
    assert.equal(transcriptOf(cells[2])?.getAttribute("data-following"), "false",
      "focus-only clicks must not re-arm bottom follow the user released");
    assert.ok(document.querySelector(`[data-pane-id="${cells[2]}"] .jump-to-latest`),
      "the reader pane must keep its jump chip after the focus storm");
    for (const cell of [cells[0], cells[1], cells[3]]) {
      assert.equal(transcriptOf(cell)?.getAttribute("data-following"), "true",
        `${cell} must stay pinned to the bottom through the focus storm`);
    }
  } finally {
    // The lane store is process-global: start() returns the live stop handle
    // when it is already wired, so this detaches it from THIS test's bridge.
    try { defaultSessionLaneStore.start()(); } catch { /* never wired */ }
    defaultSessionLaneStore.clear();
  }
});

test("a first New task pane opens on its inherited route and never replays another session", async () => {
  installDom();
  await preloadMarkdownBody();
  defaultSessionLaneStore.clear();
  // The previous session and the inherited draft prefs disagree on EVERY route
  // field (provider, model, effort, fast, workflow), so any leak of the
  // previous session's route into the draft is a visible mismatch — including
  // one that only lands on a late host frame.
  const effortOptions = [{ value: "low", label: "Low" }, { value: "high", label: "High" }];
  const draftModelOption = {
    provider: "openai",
    model: "gpt-inherit",
    display: "GPT Inherit",
    effortOptions,
    fastCapable: true,
  };
  const sourceModelOption = {
    provider: "anthropic",
    model: "claude-source",
    display: "Claude Source",
    effortOptions,
    fastCapable: true,
  };
  const route = { provider: "openai", model: "gpt-inherit", effort: "high", fast: true };
  const workflow = { id: "solo", name: "Solo" };
  const sourceWorkflow = { id: "pair", name: "Pair" };
  const draftModelLabel = modelDisplayName(
    draftModelOption.model, draftModelOption.provider, draftModelOption.display,
  );
  const sourceModelLabel = modelDisplayName(
    sourceModelOption.model, sourceModelOption.provider, sourceModelOption.display,
  );
  assert.notEqual(draftModelLabel, sourceModelLabel,
    "the fixture must render two distinguishable model labels");
  const source = {
    id: "inherit-source",
    title: "Inherited source",
    preview: "Inherited source",
    updatedAt: 1,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const sourceSnapshot = {
    sessionId: source.id,
    items: [{ id: "source-row", kind: "user", text: "Source transcript" }],
    queued: [],
    provider: sourceModelOption.provider,
    model: sourceModelOption.model,
    effort: "low",
    fast: false,
    fastCapable: true,
    workflow: sourceWorkflow,
    stats: { currentContextTokens: 500 },
    displayContextWindow: 1_000,
  };
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "leaf",
      id: "inherit_pane",
      tabs: [{ kind: "session", id: source.id }],
      activeKey: `session:${source.id}`,
    },
    focusedLeafId: "inherit_pane",
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", source.id);
  window.localStorage.setItem("mixdog.desktop-last-new-task-prefs.v1", JSON.stringify({
    projectPath: "",
    modelSelection: route,
    workflow,
  }));
  window.localStorage.setItem("mixdog.desktop-model-catalog.v1", JSON.stringify({
    updatedAt: Date.now(),
    models: [draftModelOption, sourceModelOption],
  }));
  let publishLane;
  let publishState;
  window.mixdogDesktop = {
    getSnapshot: async () => sourceSnapshot,
    subscribeState: (listener) => { publishState = listener; return () => {}; },
    subscribeSessionState: (listener) => { publishLane = listener; return () => {}; },
    listProjects: async () => [],
    listProviderModels: async () => [draftModelOption, sourceModelOption],
    listSessions: async () => [source],
    invokeCapability: async ({ capability }) => ({
      // "Pair" is the engine-active workflow: the draft must still show the
      // PERSISTED "Solo" pref, never the engine default or the source route.
      value: capability === "listWorkflows"
        ? [{ id: "solo", name: "Solo" }, { id: "pair", name: "Pair", active: true }]
        : null,
    }),
    peekSession: async (id) => {
      publishLane?.({ sessionId: id, snapshot: sourceSnapshot });
      return true;
    },
    setVisibleSessions: async () => true,
    resumeSession: async () => sourceSnapshot,
  };
  const observerSamples = [];
  const profilerSamples = [];
  // Explicit gate: everything recorded after this flips is post-action and is
  // held to the draft contract, with no "we saw the draft once" grace.
  let newTaskRequested = false;
  let observerDeliveries = 0;
  let profilerCommits = 0;
  let sampleSurfaces = () => {};
  let observer;
  try {
    await act(async () => {
      // The Profiler wraps App from the FIRST render: introducing it later
      // would remount the whole tree and manufacture the very swap this test
      // is looking for.
      root.render(React.createElement(
        React.Profiler,
        {
          id: "new-task-pane",
          onRender: () => {
            if (!newTaskRequested) return;
            profilerCommits += 1;
            profilerSamples.push(sampleSurfaces());
          },
        },
        React.createElement(App),
      ));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    await act(async () => {
      publishLane?.({ sessionId: source.id, snapshot: sourceSnapshot });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitForDom(
      () => /Source transcript/.test(document.querySelector(".transcript")?.textContent || ""),
      "the source session must be painted before the first New task pane is created",
    );
    const sourceConversation = document.querySelector('[data-pane-id="inherit_pane"] .conversation');
    await waitForDom(
      () => sourceConversation?.querySelector(".model-trigger")?.textContent?.trim() === sourceModelLabel,
      "the previous session must actually render its own route before the draft is created",
    );
    assert.equal(
      sourceConversation?.querySelector('[aria-label="Reasoning effort"]')?.textContent?.trim(),
      "Low", "the previous session must render its own effort");
    assert.equal(
      sourceConversation?.querySelector('[aria-label="Fast mode"]')?.textContent?.trim(),
      "Fast Off", "the previous session must render its own fast state");

    const draftTranscript = () => document.querySelector(
      '[data-pane-id="inherit_pane"] .transcript[data-session-key="new-task"]',
    );
    // A surface only counts as shown when no ancestor hides it (the stable
    // surface swap parks the outgoing tab behind aria-hidden/inert layers).
    const isVisible = (element) => !element.closest('[aria-hidden="true"]')
      && !element.closest('[data-surface-active="false"]')
      && !element.closest("[hidden]");
    const visibleConversations = () =>
      Array.from(document.querySelectorAll(".conversation")).filter(isVisible);
    const readRoute = (conversation) => ({
      model: conversation.querySelector(".model-trigger")?.textContent?.trim() || "",
      effort: conversation.querySelector('[aria-label="Reasoning effort"]')?.textContent?.trim() || "",
      fast: conversation.querySelector('[aria-label="Fast mode"]')?.textContent?.trim() || "",
      workflow: conversation.querySelector('[aria-label="Workflow"]')?.textContent?.trim() || "",
    });
    // EVERY sample reads the whole root — frames without a draft transcript
    // included — so a parallel/one-frame foreign conversation cannot slip
    // through by simply not containing the draft.
    sampleSurfaces = () => {
      const visible = visibleConversations();
      return {
        sessionKeys: visible.map((node) =>
          node.querySelector(".transcript")?.getAttribute("data-session-key") ?? ""),
        texts: visible.map((node) => node.querySelector(".transcript")?.textContent || ""),
        rows: visible.map((node) => node.querySelectorAll(".thread .message").length),
        composers: visible.reduce((total, node) =>
          total + node.querySelectorAll('textarea[aria-label="Message Mixdog"]').length, 0),
        routes: visible.map((node) => readRoute(node)),
      };
    };
    // Source baseline BEFORE the observer starts and before the click.
    const baseline = sampleSurfaces();
    assert.deepEqual(baseline.sessionKeys, [source.id],
      "exactly the previous session must be shown before the New task click");
    assert.match(baseline.texts[0] || "", /Source transcript/,
      "the previous session must be painted with its own transcript");
    assert.deepEqual(baseline.routes[0], {
      model: sourceModelLabel,
      effort: "Low",
      fast: "Fast Off",
      // Session panes carry no draft workflow chip (App.tsx passes
      // showProjectSelector for drafts only) — recorded as part of the exact
      // baseline so a leaked draft chip would fail here too.
      workflow: "",
    }, "the previous session must render exactly its own route");

    observer = new window.MutationObserver(() => {
      observerDeliveries += 1;
      observerSamples.push({ requested: newTaskRequested, ...sampleSurfaces() });
    });
    observer.observe(document.getElementById("root"), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    // Drop everything the observer queued for the pre-click DOM so no source
    // frame is delivered late and mistaken for a post-action sample.
    observer.takeRecords();
    newTaskRequested = true;
    await act(async () => {
      document.querySelector(".session-new-task").click();
    });
    const draft = draftTranscript();
    assert.ok(draft, "the first New task click must mount its own draft transcript");
    const conversation = draft.closest(".conversation");
    assert.ok(conversation);
    const draftText = draft.textContent || "";
    // Committed checkpoints are counted separately from observer deliveries:
    // one is what the user could see, the other is intermediate DOM churn.
    const checkpoints = [];
    const assertDraftStable = (label) => {
      checkpoints.push(label);
      const transcript = draftTranscript();
      assert.ok(transcript, `the draft transcript must stay mounted ${label}`);
      assert.equal(transcript.closest(".conversation"), conversation,
        `the draft must keep one Conversation node ${label}`);
      assert.equal(transcript.textContent || "", draftText,
        `the draft content must not alternate ${label}`);
      assert.doesNotMatch(transcript.textContent || "", /Source transcript/,
        `the draft must never replay the previous session ${label}`);
      assert.equal(conversation.querySelectorAll(".thread .message").length, 0,
        `the draft must stay empty ${label}`);
      // Exact inherited route — provider+model, effort, fast and workflow —
      // never the previous session's values.
      assert.deepEqual(readRoute(conversation), {
        model: draftModelLabel,
        effort: "High",
        fast: "Fast On",
        workflow: workflow.name,
      }, `the draft must display exactly the inherited route ${label}`);
      assert.equal(conversation.querySelectorAll('textarea[aria-label="Message Mixdog"]').length, 1,
        `the draft composer contract must not toggle ${label}`);
      assert.deepEqual(visibleConversations().map((node) =>
        node.querySelector(".transcript")?.getAttribute("data-session-key") ?? ""),
        ["new-task"],
        `only the draft conversation may be shown ${label}`);
      assert.notEqual(
        document.querySelector('[data-pane-id="inherit_pane"] .session-context-indicator button')
          ?.getAttribute("aria-describedby"),
        `context-usage-${source.id}`,
        `the draft must not display the previous session's context ${label}`,
      );
    };
    assertDraftStable("in the creation commit");
    await act(async () => { await Promise.resolve(); });
    assertDraftStable("in the microtask after creation");
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    assertDraftStable("in the frame after creation");
    await settleStableSurfaceSwitch();
    assertDraftStable("after the surface swap settled");
    await act(async () => {
      publishState?.(sourceSnapshot);
      publishLane?.({ sessionId: source.id, snapshot: sourceSnapshot });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assertDraftStable("after a late host snapshot for the previous session");

    assert.deepEqual(checkpoints.length, 5,
      "five committed frames were asserted (commit, microtask, frame, swap, late host)");
    // A MutationObserver batch cannot reconstruct the coalesced state between
    // two React commits, so nothing here claims a primitive mutation order:
    // each sample is judged on its own, and the Profiler contributes the
    // per-commit view that catches a source→draft alternation.
    let draftShown = false;
    const assertPostActionSample = (entry, index, origin) => {
      assert.ok(entry.sessionKeys.length <= 1,
        `${origin} sample ${index} showed conversations in parallel: ${entry.sessionKeys.join()}`);
      assert.ok(entry.composers <= 1,
        `${origin} sample ${index} duplicated the composer`);
      for (const key of entry.sessionKeys) {
        // An empty foreign surface is still the previous session on screen.
        assert.equal(key, "new-task",
          `${origin} sample ${index} showed foreign session key "${key}" after the New task click`);
      }
      for (const text of entry.texts) {
        assert.doesNotMatch(text, /Source transcript/,
          `${origin} sample ${index} showed the previous session's transcript`);
      }
      for (const rows of entry.rows) {
        assert.equal(rows, 0, `${origin} sample ${index} showed transcript rows in the draft`);
      }
      for (const shownRoute of entry.routes) {
        // Mid-commit chrome may still be absent (""), but it may never carry
        // the previous session's route or an unresolved placeholder.
        assert.ok(shownRoute.model === "" || shownRoute.model === draftModelLabel,
          `${origin} sample ${index} showed a foreign or placeholder model: ${shownRoute.model}`);
        assert.notEqual(shownRoute.model, sourceModelLabel,
          `${origin} sample ${index} leaked the previous session's model`);
        assert.ok(shownRoute.effort === "" || shownRoute.effort === "High",
          `${origin} sample ${index} leaked a foreign effort: ${shownRoute.effort}`);
        assert.notEqual(shownRoute.effort, "Low",
          `${origin} sample ${index} leaked the previous session's effort`);
        assert.ok(shownRoute.fast === "" || shownRoute.fast === "Fast On",
          `${origin} sample ${index} leaked a foreign fast state: ${shownRoute.fast}`);
        assert.notEqual(shownRoute.fast, "Fast Off",
          `${origin} sample ${index} leaked the previous session's fast state`);
        assert.ok(shownRoute.workflow === "" || shownRoute.workflow === workflow.name,
          `${origin} sample ${index} leaked a foreign workflow: ${shownRoute.workflow}`);
        assert.notEqual(shownRoute.workflow, sourceWorkflow.name,
          `${origin} sample ${index} leaked the previous session's workflow`);
      }
      if (entry.sessionKeys[0] === "new-task") draftShown = true;
    };
    const postActionObserverSamples = observerSamples.filter((entry) => entry.requested);
    for (const [index, entry] of postActionObserverSamples.entries()) {
      assertPostActionSample(entry, index, "observer");
    }
    for (const [index, entry] of profilerSamples.entries()) {
      assertPostActionSample(entry, index, "profiler commit");
    }
    // Counted separately: committed checkpoints, mutation deliveries and React
    // commits are three different observations of the same window.
    assert.ok(observerDeliveries >= 1 && postActionObserverSamples.length >= 1,
      `the observer must have delivered a post-action paint (deliveries=${observerDeliveries})`);
    assert.ok(profilerCommits >= 1 && profilerSamples.length === profilerCommits,
      `React must have committed after the New task click (commits=${profilerCommits})`);
    // Coverage only — never a gate for the assertions above.
    assert.ok(draftShown,
      "neither the observer nor the profiler ever saw the draft surface itself");
  } finally {
    observer?.disconnect();
    try { defaultSessionLaneStore.start()(); } catch { /* never wired */ }
    defaultSessionLaneStore.clear();
  }
});

test("restored split panes subscribe before immediate peek frames and all hydrate without focus", async () => {
  installDom();
  await preloadMarkdownBody();
  const ids = [
    "restart-pane-one",
    "restart-pane-two",
    "restart-pane-three",
    "restart-pane-four",
  ];
  const snapshots = new Map(ids.map((id, index) => [id, {
    sessionId: id,
    items: [{ id: `${id}-row`, kind: "user", text: `Restored pane ${index + 1}` }],
    queued: [],
  }]));
  const leaf = (id, paneId) => ({
    type: "leaf",
    id: paneId,
    tabs: [{ kind: "session", id }],
    activeKey: `session:${id}`,
  });
  window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: leaf(ids[0], "restart_cell_one"),
        second: leaf(ids[2], "restart_cell_three"),
      },
      second: {
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: leaf(ids[1], "restart_cell_two"),
        second: leaf(ids[3], "restart_cell_four"),
      },
    },
    focusedLeafId: "restart_cell_two",
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", ids[1]);
  let publishLane;
  const peeks = [];
  const visibleSets = [];
  window.mixdogDesktop = {
    getSnapshot: async () => snapshots.get(ids[1]),
    subscribeState: () => () => {},
    subscribeSessionState: (listener) => {
      publishLane = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => ids.map((id, index) => ({
      id,
      title: `Restored ${index + 1}`,
      preview: `Restored ${index + 1}`,
      updatedAt: ids.length - index,
      currentSession: id === ids[1],
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
    })),
    peekSession: async (id) => {
      peeks.push(id);
      if (!publishLane) return false;
      publishLane({ sessionId: id, snapshot: snapshots.get(id) });
      return true;
    },
    setVisibleSessions: async (sessionIds) => {
      visibleSets.push([...sessionIds]);
      if (!publishLane) return false;
      for (const id of sessionIds) {
        publishLane({ sessionId: id, snapshot: snapshots.get(id) });
      }
      return true;
    },
    resumeSession: async (id) => snapshots.get(id),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  assert.deepEqual(visibleSets.at(-1)?.slice().sort(), [...ids].sort(),
    "every restored session pane must register for focus-independent live frames");
  assert.deepEqual([...new Set(peeks)].sort(), [...ids].sort(),
    "every restored pane must start a focus-independent reconciliation handshake");
  for (const [index, paneId] of [
    "restart_cell_one",
    "restart_cell_two",
    "restart_cell_three",
    "restart_cell_four",
  ].entries()) {
    const text = document.querySelector(`[data-pane-id="${paneId}"] .transcript`)
      ?.textContent || "";
    assert.match(text, new RegExp(`Restored pane ${index + 1}`),
      `${paneId} must hydrate without being focused`);
  }
  await act(async () => {
    publishLane({
      sessionId: ids[0],
      snapshot: {
        ...snapshots.get(ids[0]),
        items: [
          ...snapshots.get(ids[0]).items,
          { id: "restart-pane-one-latest", kind: "assistant", text: "Latest pane update" },
        ],
      },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  assert.match(
    document.querySelector('[data-pane-id="restart_cell_one"] .transcript')?.textContent || "",
    /Latest pane update/,
    "a restored unfocused pane must continue rendering live lane updates",
  );
});

test("new task opens without engine setup and its first submit owns one cold setup", async () => {
  installDom();
  let finishSetup;
  let publishState;
  let current = { items: [], queued: [] };
  let startCalls = 0;
  let submitCalls = 0;
  const setup = new Promise((resolve) => {
    finishSetup = () => resolve({ items: [], queued: [] });
  });
  const source = {
    id: "source-before-new",
    title: "Source before new",
    preview: "Source before new",
    updatedAt: 1,
    currentSession: false,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: (listener) => { publishState = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => [source],
    resumeSession: async () => ({
      sessionId: source.id,
      items: [{ id: "source-row", kind: "user", text: "Source transcript" }],
      queued: [],
    }),
    startTask: async () => {
      startCalls += 1;
      return setup;
    },
    submit: async () => {
      submitCalls += 1;
      window.setTimeout(() => {
        current = {
          sessionId: "created-session",
          items: [{ id: "created-user", kind: "user", text: "Submit while warming" }],
          queued: [],
        };
        publishState?.(current);
      }, 0);
      return true;
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${source.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".transcript")?.textContent || "", /Source transcript/);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workspace-tab-main span")).map((tab) => tab.textContent.trim()),
    ["New task", source.title],
    "a sidebar session should park the New task tab instead of replacing it",
  );

  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
  });
  assert.equal(startCalls, 0);
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Source transcript/);
  assert.ok(document.querySelector('textarea[aria-label="Message Mixdog"]'),
    "the cold draft composer should render before engine setup resolves");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workspace-tab-main span")).map((tab) => tab.textContent.trim()),
    ["New task", source.title, "New task"],
    "New task opens a fresh draft tab and keeps the parked draft (Chrome parity)",
  );
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "n", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(startCalls, 0, "repeated Ctrl+N on New task must remain renderer-only");
  assert.equal(
    Array.from(document.querySelectorAll(".workspace-tab-main span"))
      .filter((tab) => tab.textContent.trim() === "New task").length,
    3,
    "Ctrl+N opens another independent draft tab instead of reusing a singleton",
  );

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Submit while warming");
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "Submit while warming" }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
  });
  assert.equal(startCalls, 1, "the first submit must start exactly one cold engine");
  assert.equal(submitCalls, 0, "submit should wait for the shared setup promise");
  assert.equal(textarea.value, "", "Enter should commit the draft immediately while lazy setup continues");
  assert.equal(document.querySelector(".composer-starting"), null,
    "the first submit must not flash a redundant Starting session banner");
  assert.match(document.querySelector(".message.user.pending")?.textContent || "", /Submit while warming/,
    "the pending user card should provide the visible first-submit feedback");

  await act(async () => {
    finishSetup();
    await setup;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
  assert.equal(startCalls, 1);
  assert.equal(submitCalls, 1);
  assert.equal(document.querySelector(".composer-starting"), null);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workspace-tab-main span")).map((tab) => tab.textContent.trim()),
    ["New task", source.title, "New task", "Submit while warming"],
    "the first accepted message replaces New task in place with its session",
  );
});

test("atomic draft submit keeps local route and workflow isolated after navigating away", async () => {
  installDom();
  const source = {
    id: "atomic-source",
    title: "Atomic source",
    preview: "Atomic source",
    updatedAt: 1,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const sourceSnapshot = {
    sessionId: source.id,
    items: [{ id: "source-row", kind: "user", text: "Source transcript" }],
    queued: [],
    provider: "openai",
    model: "gpt-source",
    workflow: { id: "default", name: "Default" },
  };
  const background = {
    id: "atomic-background",
    title: "Atomic background",
    preview: "Atomic prompt",
    updatedAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  let finishAtomic;
  let capturedDraft;
  let publishState;
  let catalog = [source];
  const mutations = [];
  window.mixdogDesktop = {
    getSnapshot: async () => sourceSnapshot,
    subscribeState: (listener) => { publishState = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => catalog,
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-source", display: "GPT Source", effortOptions: [] },
      { provider: "anthropic", model: "claude-draft", display: "Claude Draft", effortOptions: [] },
    ],
    invokeCapability: async (request) => {
      if (request.capability === "listWorkflows") {
        return { value: [{ id: "solo", name: "Solo" }, { id: "custom", name: "Custom" }], snapshot: sourceSnapshot };
      }
      if (request.capability === "setWorkflow") mutations.push(request);
      return { value: null, snapshot: sourceSnapshot };
    },
    setModelRoute: async (selection) => {
      mutations.push(selection);
      return sourceSnapshot;
    },
    submitNewTask: async (_prompt, _options, draft) => {
      capturedDraft = draft;
      publishState({
        sessionId: background.id,
        items: [{ id: "atomic-prompt", kind: "user", text: "Atomic prompt" }],
        queued: [],
        busy: true,
      });
      return new Promise((resolve) => {
        finishAtomic = () => {
          catalog = [{ ...source, currentSession: false }, background];
          resolve({
            accepted: true,
            sessionId: background.id,
            snapshot: {
              sessionId: background.id,
              items: [{ id: "atomic-prompt", kind: "user", text: "Atomic prompt" }],
              queued: [],
              busy: false,
            },
          });
        };
      });
    },
    submit: async () => { throw new Error("legacy submit must not run"); },
    resumeSession: async () => sourceSnapshot,
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
  });
  await act(async () => document.querySelector(".model-trigger").click());
  await act(async () => {
    Array.from(document.querySelectorAll(".model-option-row"))
      .find((option) => option.textContent.includes("Claude Draft")).click();
    await Promise.resolve();
  });
  const workflow = document.querySelector('[aria-label="Workflow"]');
  await act(async () => workflow.click());
  await act(async () => {
    Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
      .find((option) => option.textContent.includes("Custom")).click();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Atomic prompt");
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "Atomic prompt" }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${source.id}"]`).click();
    await Promise.resolve();
    finishAtomic();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(mutations, []);
  assert.deepEqual(capturedDraft, {
    route: { provider: "anthropic", model: "claude-draft" },
    workflowId: "custom",
  });
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), source.title);
  assert.match(document.querySelector(".transcript")?.textContent || "", /Source transcript/);
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Atomic prompt/);
});

test("sidebar sessions park the New task tab and reuse open session tabs without duplication", async () => {
  installDom();
  await preloadMarkdownBody();
  const sessions = [
    {
      id: "replace-a",
      title: "Replace A",
      preview: "Replace A",
      updatedAt: 2,
      activityAt: 2,
      currentSession: false,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
    },
    {
      id: "replace-b",
      title: "Replace B",
      preview: "Replace B",
      updatedAt: 1,
      activityAt: 1,
      currentSession: false,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
    },
  ];
  let holdSessionB = false;
  let finishHeldResume;
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => sessions,
    startTask: async () => ({ items: [], queued: [] }),
    resumeSession: async (id) => {
      const snapshot = { sessionId: id, items: [], queued: [] };
      if (id !== "replace-b" || !holdSessionB) return snapshot;
      return new Promise((resolve) => {
        finishHeldResume = () => resolve(snapshot);
      });
    },
  };
  const tabTitles = () => Array.from(
    document.querySelectorAll(".workspace-tab-main span"),
    (tab) => tab.textContent.trim(),
  );
  const clickAndSettle = async (selector) => {
    await act(async () => {
      document.querySelector(selector).click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await clickAndSettle('[data-session-id="replace-a"]');
  assert.deepEqual(tabTitles(), ["New task", "Replace A"],
    "switching to a session parks the New task tab instead of closing it");

  await clickAndSettle(".session-new-task");
  assert.deepEqual(tabTitles(), ["New task", "Replace A", "New task"],
    "New task opens a fresh draft tab and keeps the parked draft (Chrome parity)");
  await clickAndSettle('[data-session-id="replace-b"]');
  assert.deepEqual(tabTitles(), ["New task", "Replace A", "New task", "Replace B"],
    "parked draft tabs survive further session switches");

  await clickAndSettle(".session-new-task");
  assert.deepEqual(tabTitles(), ["New task", "Replace A", "New task", "Replace B", "New task"]);
  await clickAndSettle('[data-session-id="replace-a"]');
  assert.deepEqual(tabTitles(), ["New task", "Replace A", "New task", "Replace B", "New task"],
    "an already-open session keeps its tab and every parked draft without duplication");

  holdSessionB = true;
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "PageDown", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.match(document.querySelector('[aria-current="page"]')?.textContent || "", /New task/,
    "Ctrl+PageDown reaches the parked draft next to the active session");
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "PageDown", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.match(document.querySelector('[aria-current="page"]')?.textContent || "", /Replace B/);
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "PageDown", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.match(document.querySelector('[aria-current="page"]')?.textContent || "", /New task/,
    "Ctrl+PageDown must select the parked draft without waiting for the previous resume");
  await act(async () => {
    finishHeldResume();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('[aria-current="page"]')?.textContent || "", /New task/,
    "the superseded resume must not reclaim selection after New task wins");
});

test("sidebar session clicks replace the visible route before a slow resume settles", async () => {
  installDom();
  await preloadMarkdownBody();
  const active = {
    id: "instant-tab-a",
    title: "Instant A",
    preview: "Instant A",
    updatedAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const target = {
    ...active,
    id: "instant-tab-b",
    title: "Instant B",
    preview: "Instant B",
    updatedAt: 1,
    currentSession: false,
  };
  seedActiveSession(active.id, active.title);
  let finishResume;
  let peekedSessionId = "";
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: active.id,
      items: [{ id: "instant-a-row", kind: "assistant", text: "Instant A transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [active, target],
    peekSession: async (sessionId) => {
      peekedSessionId = sessionId;
      return true;
    },
    resumeSession: () => new Promise((resolve) => {
      finishResume = () => resolve({
        sessionId: target.id,
        items: [{ id: "instant-b-row", kind: "assistant", text: "Instant B transcript" }],
        queued: [],
      });
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const conversation = document.querySelector(".conversation");
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
  });
  const targetTab = document.querySelector(`[data-tab-key="session:${target.id}"]`);
  assert.ok(targetTab, "the clicked session tab must exist before resume resolves");
  assert.equal(targetTab.getAttribute("data-active"), "true");
  assert.equal(document.querySelector(".conversation"), conversation,
    "the stable Conversation owner must survive the route swap");
  assert.equal(document.querySelector('[data-conversation-handoff="true"]'), null,
    "opening a session must never retain the outgoing route");
  assert.equal(document.querySelector(".transcript")?.getAttribute("data-session-key"), target.id,
    "the target route identity must commit with the tab click");
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Instant A transcript/,
    "the outgoing transcript must disappear before resume resolves");
  assert.ok(document.querySelector(".pane-surface-cover"),
    "a cold target should use its own opaque loading cover");
  assert.equal(peekedSessionId, target.id,
    "the target lane handshake must start in the click commit");

  await act(async () => {
    finishResume();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(
    () => /Instant B transcript/.test(document.querySelector(".transcript")?.textContent || ""),
    "the target transcript should commit after resume",
  );
  assert.equal(document.querySelector(".conversation"), conversation);
  assert.equal(document.querySelector('[data-conversation-handoff="true"]'), null);
});

test("failed optimistic session opens remove only the failed tab and restore the prior pane", async () => {
  installDom();
  await preloadMarkdownBody();
  const active = {
    id: "failed-open-a",
    title: "Failed open A",
    preview: "Failed open A",
    updatedAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const target = {
    ...active,
    id: "failed-open-b",
    title: "Failed open B",
    preview: "Failed open B",
    updatedAt: 1,
    currentSession: false,
  };
  seedActiveSession(active.id, active.title);
  let failResume;
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: active.id,
      items: [{ id: "failed-open-row", kind: "assistant", text: "Original transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [active, target],
    resumeSession: () => new Promise((_, reject) => {
      failResume = () => reject(new Error("resume failed"));
    }),
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
  assert.ok(document.querySelector(`[data-tab-key="session:${target.id}"]`));

  await act(async () => {
    failResume();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(
    () => !document.querySelector(`[data-tab-key="session:${target.id}"]`),
    "the failed optimistic tab should be removed",
  );
  assert.equal(
    document.querySelector(`[data-tab-key="session:${active.id}"]`)?.getAttribute("data-active"),
    "true",
  );
  assert.match(document.querySelector(".transcript")?.textContent || "", /Original transcript/);
  assert.equal(document.querySelector('[data-conversation-handoff="true"]'), null);
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(resolve)));
  });
});

test("panel New task can be created and closed repeatedly onto the current session", async () => {
  installDom();
  const session = {
    id: "repeat-draft-close",
    title: "Current session",
    preview: "Current session",
    updatedAt: 2,
    activityAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  seedActiveSession(session.id, session.title);
  window.mixdogDesktop = {
    getSnapshot: async () => ({ sessionId: session.id, items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session],
  };
  const settle = async () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const newTaskTabs = () => Array.from(document.querySelectorAll(".workspace-tab"))
    .filter((tab) => tab.querySelector(".workspace-tab-main span")?.textContent.trim() === "New task");

  await act(async () => root.render(React.createElement(App)));
  await settle();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await act(async () => document.querySelector(".session-new-create").click());
    await act(async () => document.querySelector(".session-new-task").click());
    await settle();
    assert.equal(newTaskTabs().length, 1, `cycle ${cycle + 1} must create one draft tab`);

    const active = document.querySelector('.workspace-tab[data-active="true"]');
    assert.match(active?.textContent || "", /New task/);
    await act(async () => active.querySelector(".workspace-tab-close").click());
    await settle();
    assert.equal(newTaskTabs().length, 0,
      `cycle ${cycle + 1} must remove the draft on the first close click`);
    assert.match(document.querySelector('[aria-current="page"]')?.textContent || "", /Current session/);
  }
});

test("closing an active session removes its tab before a slow fallback resume settles", async () => {
  installDom();
  const first = {
    id: "close-fallback-a",
    title: "Fallback A",
    preview: "Fallback A",
    updatedAt: 1,
    currentSession: false,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const second = {
    ...first,
    id: "close-fallback-b",
    title: "Closing B",
    preview: "Closing B",
    updatedAt: 2,
    currentSession: true,
  };
  dom.window.localStorage.setItem("mixdog.desktop-last-session.v1", second.id);
  dom.window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "leaf",
      id: "pane_close_handoff",
      tabs: [{ kind: "session", id: first.id }, { kind: "session", id: second.id }],
      activeKey: `session:${second.id}`,
    },
    focusedLeafId: "pane_close_handoff",
  }));
  dom.window.localStorage.setItem(SESSION_CATALOG_STORAGE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 2,
    rows: [first, second],
  }));
  const secondSnapshot = {
    sessionId: second.id,
    items: [{ id: "closing-row", kind: "assistant", text: "Closing transcript stays visible" }],
    queued: [],
  };
  const fallbackText = [
    "Fallback transcript ready",
    "",
    "```ts",
    "const stable = 1;",
    "```",
  ].join("\n");
  let finishResume;
  let fallbackPeeks = 0;
  window.mixdogDesktop = {
    getSnapshot: async () => secondSnapshot,
    subscribeState: () => () => {},
    subscribeSessionState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [first, second],
    peekSession: async (sessionId) => {
      if (sessionId === second.id) {
        defaultSessionLaneStore.apply({
          sessionId,
          snapshot: secondSnapshot,
          frameSource: "live",
          contentRevision: 1,
        });
        return true;
      }
      if (sessionId === first.id) {
        fallbackPeeks += 1;
        await new Promise((resolve) => window.setTimeout(resolve, 25));
        defaultSessionLaneStore.apply({
          sessionId,
          snapshot: {
            sessionId,
            items: [{
              id: "fallback-row",
              kind: "assistant",
              text: "Late peek replaced the visible script",
            }],
            queued: [],
          },
          frameSource: "replay",
          contentRevision: 2,
        });
        return true;
      }
      return false;
    },
    resumeSession: () => new Promise((resolve) => {
      finishResume = () => resolve({
        sessionId: first.id,
        items: [{ id: "fallback-row", kind: "assistant", text: fallbackText }],
        queued: [],
      });
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const composer = document.querySelector('textarea[aria-label="Message Mixdog"]');
  await act(async () => {
    composer.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "q", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(`[data-tab-key="session:${second.id}"]`), null,
    "Ctrl+Q must remove the tab without waiting for resume RPC");
  assert.match(document.querySelector(".transcript")?.textContent || "", /Closing transcript stays visible/);
  assert.ok(document.querySelector('[data-conversation-handoff="true"]'),
    "the outgoing conversation remains visible but inert during the wait");

  await act(async () => {
    finishResume();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(
    () => !document.querySelector('[data-conversation-handoff="true"]'),
    "successful resume should finish the close handoff",
    2_000,
  );
  await waitForDom(
    () => /Fallback transcript ready/.test(document.querySelector(".transcript")?.textContent || ""),
    "fallback transcript should replace the handoff after resume",
    2_000,
  );
  const transcript = document.querySelector(".transcript");
  const script = document.querySelector(".markdown-code");
  assert.ok(script, "the resumed fenced script must render before the handoff is released");
  const scriptClass = script.className;
  const scriptText = script.textContent;
  const scrollTop = transcript.scrollTop;
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(resolve)));
  });
  assert.equal(fallbackPeeks, 0,
    "an authoritative resume must suppress the target pane's redundant mount peek");
  assert.equal(document.querySelector(".markdown-code"), script,
    "the resumed script DOM must remain identical after the session switch settles");
  assert.equal(script.className, scriptClass);
  assert.equal(script.textContent, scriptText);
  assert.equal(transcript.scrollTop, scrollTop);
});

test("a failed close fallback releases the inert handoff without restoring the closed tab", async () => {
  installDom();
  const first = {
    id: "failed-fallback-a",
    title: "Failed fallback A",
    preview: "Failed fallback A",
    updatedAt: 1,
    currentSession: false,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const second = {
    ...first,
    id: "failed-fallback-b",
    title: "Failed closing B",
    preview: "Failed closing B",
    updatedAt: 2,
    currentSession: true,
  };
  dom.window.localStorage.setItem("mixdog.desktop-last-session.v1", second.id);
  dom.window.localStorage.setItem("mixdog.desktop.pane-layout.v1", JSON.stringify({
    layout: {
      type: "leaf",
      id: "pane_failed_close_handoff",
      tabs: [{ kind: "session", id: first.id }, { kind: "session", id: second.id }],
      activeKey: `session:${second.id}`,
    },
    focusedLeafId: "pane_failed_close_handoff",
  }));
  dom.window.localStorage.setItem(SESSION_CATALOG_STORAGE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 2,
    rows: [first, second],
  }));
  const current = {
    sessionId: second.id,
    items: [{ id: "failed-closing-row", kind: "assistant", text: "Failed closing transcript" }],
    queued: [],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [first, second],
    resumeSession: async () => { throw new Error("fallback unavailable"); },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('textarea[aria-label="Message Mixdog"]').dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "q", ctrlKey: true, bubbles: true, cancelable: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(
    () => !document.querySelector('[data-conversation-handoff="true"]'),
    "failed resume must release the inert handoff",
  );
  assert.equal(document.querySelector(`[data-tab-key="session:${second.id}"]`), null,
    "failure must not resurrect the closed tab");
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() =>
      window.requestAnimationFrame(resolve)));
    await Promise.resolve();
  });
});

test("rapid sidebar A to B to C clicks create both tabs immediately and commit only C", async () => {
  installDom();
  await preloadMarkdownBody();
  const rows = ["a", "b", "c"].map((suffix, index) => ({
    id: `rapid-open-${suffix}`,
    title: `Rapid ${suffix.toUpperCase()}`,
    preview: `Rapid ${suffix.toUpperCase()}`,
    updatedAt: 3 - index,
    currentSession: suffix === "a",
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  }));
  seedActiveSession(rows[0].id, rows[0].title);
  let finishB;
  let finishC;
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: rows[0].id,
      items: [{ id: "rapid-a-row", kind: "assistant", text: "Rapid A transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => rows,
    resumeSession: (id) => new Promise((resolve) => {
      const finish = () => resolve({
        sessionId: id,
        items: [{ id: `${id}-row`, kind: "assistant", text: `${id} transcript` }],
        queued: [],
      });
      if (id === rows[1].id) finishB = finish;
      else finishC = finish;
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${rows[1].id}"]`).click();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${rows[2].id}"]`).click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector(`[data-tab-key="session:${rows[1].id}"]`));
  assert.equal(
    document.querySelector(`[data-tab-key="session:${rows[2].id}"]`)?.getAttribute("data-active"),
    "true",
  );
  assert.equal(document.querySelector(".transcript")?.getAttribute("data-session-key"), rows[2].id,
    "the latest clicked route must own the pane before either resume settles");
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Rapid A transcript/,
    "the outgoing transcript must not survive rapid target changes");
  assert.ok(document.querySelector(".pane-surface-cover"),
    "the latest cold target should remain covered until its own frame arrives");

  await act(async () => {
    finishB();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await waitForDom(() => typeof finishC === "function", "the queued C resume should start");
  assert.equal(
    document.querySelector(`[data-tab-key="session:${rows[2].id}"]`)?.getAttribute("data-active"),
    "true",
  );
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /rapid-open-b transcript/);
  assert.doesNotMatch(document.querySelector(".transcript")?.textContent || "", /Rapid A transcript/);

  await act(async () => {
    finishC();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(
    () => /rapid-open-c transcript/.test(document.querySelector(".transcript")?.textContent || ""),
    "only C should commit after the queued resume",
  );
  assert.equal(
    document.querySelector(`[data-tab-key="session:${rows[2].id}"]`)?.getAttribute("data-active"),
    "true",
  );
});

test("completed turns rely on catalog push instead of starting a blocking session rescan", async () => {
  installDom();
  const session = {
    id: "settled-push-session",
    title: "Settled push session",
    preview: "Settled push session",
    updatedAt: 10,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  seedActiveSession(session.id, session.title);
  let current = {
    sessionId: session.id,
    busy: false,
    commandBusy: false,
    items: [
      { id: "user-1", kind: "user", text: "Initial request" },
      { id: "assistant-1", kind: "assistant", text: "Initial response" },
      { id: "turn-1", kind: "turndone", status: "done" },
    ],
    queued: [],
  };
  let publish = () => {};
  let listCalls = 0;
  let submitCalls = 0;
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: (listener) => {
      publish = listener;
      return () => {};
    },
    subscribeSessions: () => () => {},
    listProjects: async () => [],
    listSessions: async () => {
      listCalls += 1;
      return [session];
    },
    submit: async () => {
      submitCalls += 1;
      current = {
        ...current,
        busy: true,
        items: [...current.items, {
          id: `user-${submitCalls + 1}`,
          kind: "user",
          text: "Immediate follow-up",
        }],
      };
      publish(current);
      return true;
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(listCalls, 1, "startup should populate the session catalog once");

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Immediate follow-up");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Immediate follow-up",
    }));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(submitCalls, 1);

  await act(async () => {
    current = {
      ...current,
      busy: false,
      items: [
        ...current.items,
        { id: "assistant-2", kind: "assistant", text: "Follow-up response" },
        { id: "turn-2", kind: "turndone", status: "done" },
      ],
    };
    publish(current);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(
    listCalls,
    1,
    "catalog push must own post-turn freshness so the next prompt is not queued behind a full rescan",
  );
});

test("new-task Remote is a local reservation and claims only after the first session exists", async () => {
  installDom();
  const capabilities = [];
  let current = { sessionId: "", items: [], queued: [] };
  let deferRemoteCapability = false;
  const finishRemoteCapabilities = [];
  const remoteCapabilityResult = (apply) => {
    if (!deferRemoteCapability) return apply();
    return new Promise((resolve) => {
      finishRemoteCapabilities.push(() => {
        resolve(apply());
      });
    });
  };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    startTask: async () => current,
    submit: async () => {
      current = { ...current, sessionId: "remote-created" };
      return true;
    },
    invokeCapability: async ({ capability }) => {
      capabilities.push(capability);
      if (capability === "getChannelSetup") {
        return {
          value: {
            backend: "discord",
            discord: { authenticated: true },
            channel: { discordChannelId: "channel-1" },
          },
          snapshot: null,
        };
      }
      if (capability === "getOnboardingStatus") {
        return { value: { completed: true }, snapshot: null };
      }
      if (capability === "claimRemote") {
        return await remoteCapabilityResult(() => {
          current = {
            ...current,
            remoteEnabled: true,
            remoteSessionId: current.sessionId,
          };
          return { value: true, snapshot: current };
        });
      }
      if (capability === "releaseRemote") {
        return await remoteCapabilityResult(() => {
          current = { ...current, remoteEnabled: false, remoteSessionId: null };
          return { value: false, snapshot: current };
        });
      }
      return { value: null, snapshot: null };
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  let remote = document.querySelector('[aria-label="Turn remote on for this new task"]');
  assert.ok(remote, "the blank draft should expose its reserved Remote state");
  assert.equal(remote.getAttribute("aria-pressed"), "false");
  await act(async () => {
    remote.click();
    await Promise.resolve();
  });
  remote = document.querySelector('[aria-label="Turn remote off for this new task"]');
  assert.equal(remote?.getAttribute("aria-pressed"), "true");
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "on");
  assert.equal(capabilities.filter((capability) => capability === "claimRemote").length, 0,
    "a draft toggle must not invoke the live session capability");

  await act(async () => {
    remote.click();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[aria-label="Turn remote on for this new task"]').click();
    await Promise.resolve();
  });
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "on");
  assert.equal(capabilities.filter((capability) => capability === "claimRemote").length, 0);

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Create the reserved remote session");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Create the reserved remote session",
    }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.equal(capabilities.filter((capability) => capability === "claimRemote").length, 1,
    "the first durable session should consume the reservation exactly once");
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "off",
    "the claimed task consumes the reservation so the next NEW TASK starts remote-off");
  let liveRemote = document.querySelector('[aria-label="Turn channel relay off"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "true");
  deferRemoteCapability = true;
  await act(async () => {
    liveRemote.click();
    await Promise.resolve();
  });
  liveRemote = document.querySelector('[aria-label="Turn channel relay on"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "false",
    "Remote OFF should paint before the backend release settles");
  assert.equal(liveRemote?.getAttribute("aria-busy"), "true");
  await act(async () => {
    finishRemoteCapabilities.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(capabilities.filter((capability) => capability === "releaseRemote").length, 1,
    "an existing session should retain the live release behavior");

  deferRemoteCapability = true;
  await act(async () => {
    document.querySelector('[aria-label="Turn channel relay on"]').click();
    await Promise.resolve();
  });
  liveRemote = document.querySelector('[aria-label="Turn channel relay off"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "true",
    "Remote ON should paint before a cold backend claim settles");
  assert.equal(liveRemote?.getAttribute("aria-busy"), "true");
  assert.equal(liveRemote?.hasAttribute("disabled"), false,
    "an in-flight ON must still accept an immediate OFF click");

  await act(async () => {
    liveRemote.click();
    await Promise.resolve();
  });
  liveRemote = document.querySelector('[aria-label="Turn channel relay on"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "false",
    "the latest OFF click should paint while ON is still pending");
  assert.equal(liveRemote?.getAttribute("aria-busy"), "true");
  assert.equal(capabilities.filter((capability) => capability === "releaseRemote").length, 2,
    "OFF must reach the backend even while ON is pending");

  // Settle the stale ON first. It must neither clear busy nor repaint ON over
  // the newer OFF intent.
  await act(async () => {
    finishRemoteCapabilities.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  liveRemote = document.querySelector('[aria-label="Turn channel relay on"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "false");
  assert.equal(liveRemote?.getAttribute("aria-busy"), "true");

  await act(async () => {
    finishRemoteCapabilities.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  liveRemote = document.querySelector('[aria-label="Turn channel relay on"]');
  assert.equal(liveRemote?.getAttribute("aria-pressed"), "false");
  assert.equal(liveRemote?.hasAttribute("aria-busy"), false);
  assert.equal(capabilities.filter((capability) => capability === "claimRemote").length, 2,
    "the live session should issue one explicit re-claim");
});

test("atomic new-task submit claims remote host-side and consumes the one-shot reservation", async () => {
  installDom();
  const capabilities = [];
  let capturedDraft;
  let current = { sessionId: "", items: [], queued: [] };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    submitNewTask: async (_prompt, _options, draft) => {
      capturedDraft = draft;
      current = {
        sessionId: "atomic-remote",
        items: [{ id: "atomic-user", kind: "user", text: "Atomic remote prompt" }],
        queued: [],
        remoteEnabled: true,
        remoteSessionId: "atomic-remote",
      };
      return { accepted: true, sessionId: "atomic-remote", snapshot: current };
    },
    submit: async () => { throw new Error("legacy submit must not run"); },
    invokeCapability: async ({ capability }) => {
      capabilities.push(capability);
      if (capability === "getChannelSetup") {
        return {
          value: {
            backend: "discord",
            discord: { authenticated: true },
            channel: { discordChannelId: "channel-1" },
          },
          snapshot: null,
        };
      }
      if (capability === "getOnboardingStatus") {
        return { value: { completed: true }, snapshot: null };
      }
      return { value: null, snapshot: null };
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const remote = document.querySelector('[aria-label="Turn remote on for this new task"]');
  await act(async () => {
    remote.click();
    await Promise.resolve();
  });
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "on");

  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Atomic remote prompt");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Atomic remote prompt",
    }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.equal(capturedDraft?.remote, true,
    "the draft submit must carry the reservation so the host claims at session creation");
  assert.equal(capabilities.filter((capability) => capability === "claimRemote").length, 0,
    "the renderer must not re-claim after the host already claimed at creation");
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "off",
    "the claimed task consumes the reservation so the next NEW TASK starts remote-off");

  // Entering a NEW TASK always resets the reservation: even a stale persisted
  // "on" (abandoned draft / previous run) can never leak into the next task.
  window.localStorage.setItem("mixdog.desktop.remote-new-task", "on");
  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(window.localStorage.getItem("mixdog.desktop.remote-new-task"), "off",
    "opening a fresh draft must clear any carried-over reservation");
  const nextRemote = document.querySelector('[aria-label="Turn remote on for this new task"]');
  assert.equal(nextRemote?.getAttribute("aria-pressed"), "false",
    "the next NEW TASK draft always starts remote-off");
});

test("a materialized draft session promotes before the submit acknowledgement settles", async () => {
  installDom();
  let publishState;
  let finishSubmit;
  let current = { sessionId: "", items: [], queued: [] };
  const session = {
    id: "materialized-session",
    title: "Materialized task",
    preview: "Materialized prompt",
    updatedAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: (listener) => { publishState = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => [session],
    startTask: async () => {
      current = { sessionId: session.id, items: [], queued: [] };
      publishState(current);
      return current;
    },
    submit: async () => {
      current = {
        sessionId: session.id,
        desktopSessionTitle: session.title,
        items: [
          { id: "materialized-user", kind: "user", text: "Materialized prompt" },
          { id: "materialized-assistant", kind: "assistant", text: "Materialized response" },
        ],
        queued: [],
      };
      publishState(current);
      return new Promise((resolve) => {
        finishSubmit = () => resolve(true);
      });
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Materialized prompt");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Materialized prompt",
    }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.equal(typeof finishSubmit, "function", "the legacy submit should still be awaiting its acknowledgement");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), session.title);
  assert.equal(document.querySelector(".workspace-tab.active")?.textContent.includes(session.title), true);
  assert.equal(document.querySelector(".workspace-tab.active")?.textContent.includes("New task"), false);

  await act(async () => {
    finishSubmit();
    await Promise.resolve();
    await Promise.resolve();
  });
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
  // TUI parity: the shell header uses the terminal grammar ("Ran 1 command")
  // with the command reachable via the hover title (collapsed rows hide the
  // inline arg summary — user decision).
  assert.equal(shell?.querySelector(".tool-title b")?.textContent, "Ran 1 command");
  assert.equal(shell?.querySelector(".tool-title small"), null);
  assert.match(shell?.querySelector(".tool-title")?.getAttribute("title") || "", /npm test/);
  assert.equal(shell?.querySelector(".tool-state") === null, true,
    "selector .tool-state should be absent");
  assert.equal(shell?.querySelector(".tool-title")?.nextElementSibling?.classList.contains("tool-chevron"), true);
  assert.equal(shell?.querySelector(".tool-result-summary") === null, true,
    "selector .tool-result-summary should be absent");
  // Final contract: collapsed = header only; expanding shows JUST the
  // one-line summary (the shared shell summarizer surfaces the exit line).
  assert.equal(shell?.querySelector(".tool-detail-line") === null, true,
    "collapsed cards keep the header-only shape");
  await act(async () => shell?.querySelector(".tool-header")?.click());
  assert.match(shell?.querySelector(".tool-detail-line .tool-detail-text")?.textContent || "", /Exit code: 0/);
  assert.equal(shell?.querySelector(".tool-content") === null, true,
    "no raw body block renders on expansion");

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
  assert.equal(aggregate?.querySelector(".tool-detail-line .tool-detail-text")?.textContent, "512 lines, 6 matches",
    "expansion reveals the aggregate's one-line summary");
  assert.equal(aggregate?.querySelector(".tool-output") === null, true,
    "no output body renders on expansion");
  assert.equal(aggregate?.textContent?.includes("Input"), false);
});

test("expanded tool cards show only the one-line summary — no input/body blocks", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "structured-grep",
    item: {
      id: "structured-grep",
      kind: "tool",
      name: "grep",
      args: { glob: "*.mjs", pattern: "needle", path: "src" },
      result: "3 matches",
      completedAt: 2,
    },
  })));
  const card = document.querySelector(".tool-card");
  assert.equal(card?.querySelector(".tool-detail-line"), null,
    "collapsed card keeps the header-only shape");
  await act(async () => card?.querySelector(".tool-header")?.click());
  // The shared summarizer counts result LINES (one "3 matches" line → 1 match).
  assert.equal(card?.querySelector(".tool-detail-line .tool-detail-text")?.textContent, "1 match");
  assert.equal(card?.querySelector(".tool-content"), null,
    "no input/body block renders on expansion");
  assert.equal(card?.querySelector(".detail-block"), null,
    "selector .detail-block should be absent");
});

test("tool cards stay one row by default and add one summary row only when expanded", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "running-shell",
    item: {
      id: "running-shell",
      kind: "tool",
      name: "shell_command",
      args: { command: "npm test" },
      startedAt: Date.now() - 5_000,
    },
  })));
  const running = document.querySelector(".tool-card");
  assert.equal(running?.classList.contains("settled"), false);
  assert.equal(running?.querySelector(".tool-detail-line"), null,
    "running tools must keep the same one-row collapsed height as settled tools");
  await act(async () => running?.querySelector(".tool-header")?.click());
  assert.match(running?.querySelector(".tool-detail-line .tool-detail-text")?.textContent || "",
    /^Running · \d+s$/, "expanding adds the single Running · Ns summary row");
  assert.equal(running?.querySelector(".tool-detail-line .tool-detail-text")?.hasAttribute("data-placeholder"), true,
    "the expanded running summary keeps the dim placeholder treatment");
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "settled-shell",
    item: {
      id: "settled-shell",
      kind: "tool",
      name: "shell_command",
      args: { command: "npm test" },
      result: "done",
      startedAt: Date.now() - 5_000,
      completedAt: Date.now(),
    },
  })));
  const settled = document.querySelector(".tool-card");
  assert.equal(settled?.querySelector(".tool-detail-line"), null,
    "settled tools also keep the one-row collapsed height");
});

test("running shell liveOutput never auto-expands the one-row tool card", async () => {
  installDom();
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "live-shell",
    item: {
      id: "live-shell",
      kind: "tool",
      name: "shell_command",
      args: { command: "npm run build" },
      startedAt: Date.now() - 5_000,
      liveOutput: "step 1 ok\nstep 2 building\u2026",
    },
  })));
  const live = document.querySelector(".tool-card");
  assert.equal(live?.querySelector(".tool-detail-line"), null);
  assert.equal(live?.querySelector('.tool-content[data-live="true"]'), null,
    "live shell output must not auto-grow the transcript");
  await act(async () => live?.querySelector(".tool-header")?.click());
  assert.equal(live?.querySelectorAll(":scope > .tool-header, :scope > .tool-detail-line").length, 2,
    "expanded running tools render exactly the header and one summary row");
  assert.match(live?.querySelector(".tool-detail-line")?.textContent || "", /^Running · \d+s$/);
  await act(async () => root.render(React.createElement(TranscriptRow, {
    key: "stale-shell",
    item: {
      id: "stale-shell",
      kind: "tool",
      name: "shell_command",
      args: { command: "npm run build" },
      result: "done",
      liveOutput: "stale tail",
      startedAt: Date.now() - 5_000,
      completedAt: Date.now(),
    },
  })));
  const stale = document.querySelector(".tool-card");
  assert.equal(stale?.querySelector(".tool-detail-line"), null);
  assert.equal(stale?.querySelector('.tool-content[data-live="true"]'), null);
});

test("launch selects New task and immediately shows the project-free composer", async () => {
  installDom();
  const calls = [];
  const added = [];
  const registered = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [], recentProjects: ["C:\\Canonical\\Sample"] }),
    listSessions: async () => [],
    subscribeState: () => () => {},
    chooseProject: async () => "C:\\work\\sample",
    listProjects: async () => registered.slice(),
    addProject: async (path) => {
      added.push(["addProject", path]);
      registered.push({ path, alias: null, name: "sample", pinned: false });
    },
    renameProject: async (path, alias) => {
      added.push(["renameProject", path, alias]);
      const row = registered.find((entry) => entry.path === path);
      if (row) row.alias = alias;
    },
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
  assert.equal(document.querySelector(".session-new-task").getAttribute("aria-current"), null);
  assert.equal(document.querySelector(".session-new-task").classList.contains("selected"), false);
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
  // VS Code side-bar grammar: the panel titles itself exactly once; the list
  // itself stays free of any further "Sessions" copy.
  assert.equal(document.querySelectorAll(".session-panel-header").length, 1);
  assert.doesNotMatch(document.querySelector(".session-sidebar-scroll").textContent || "", /Sessions/);
  assert.equal(document.querySelector(".workspace-project-trigger") === null, true, "selector .workspace-project-trigger should be absent");
  assert.equal(document.querySelector(".session-header-divider") === null, true, "selector .session-header-divider should be absent");
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Mixdog|Local account/);
  assert.equal(document.querySelectorAll(".topbar .toolbar-sidebar").length, 1);
  assert.equal(document.querySelectorAll(".session-header .toolbar-sidebar").length, 1);
  // The suite baseline matches the desktop default: the session sidebar is
  // open, and closing it hides the tree (inert, aria-hidden, zero width)
  // instead of destroying the visited panels' DOM and state.
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Collapse session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "open");
  // Outline-only toggle glyph (lucide PanelLeft): no filled open-state layer.
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon-active") === null, true, "selector .toolbar-sidebar .sidebar-toggle-icon-active should be absent");
  assert.doesNotMatch(document.body.textContent || "", /No project selected|\bReady\b/);

  const toggle = document.querySelector(".toolbar-sidebar");
  await act(async () => toggle.click());
  const collapsedSidebar = document.querySelector(".sidebar");
  assert.ok(collapsedSidebar, "a collapsed sidebar keeps its tree so visited panels survive");
  assert.equal(collapsedSidebar.dataset.state, "closed");
  assert.equal(collapsedSidebar.hasAttribute("inert"), true);
  assert.equal(collapsedSidebar.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Expand session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "closed");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon-active") === null, true, "selector .toolbar-sidebar .sidebar-toggle-icon-active should be absent");
  await act(async () => toggle.click());
  const sidebar = document.querySelector(".sidebar");
  assert.equal(sidebar.classList.contains("open"), true);
  assert.equal(sidebar.hasAttribute("inert"), false);
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Collapse session sidebar");
  assert.equal(document.querySelector(".toolbar-sidebar .sidebar-toggle-icon").dataset.state, "open");
  toggle.focus();
  await act(async () => toggle.click());
  assert.equal(document.querySelector(".sidebar")?.dataset.state, "closed");
  assert.equal(document.querySelector(".sidebar")?.getAttribute("aria-hidden"), "true");
  assert.equal(document.activeElement === document.querySelector(".toolbar-sidebar"), true, "sidebar toggle should retain focus after collapsing");
  await act(async () => toggle.click());

  const projectsPane = await openProjectsPane();
  await act(async () => {
    document.querySelector(".session-panel-header .projects-add").click();
    await Promise.resolve();
  });
  // Add project opens an in-place dialog (user decision): Name + folder via
  // the native chooser — no navigation away from the Projects page.
  const addDialog = document.querySelector('[aria-labelledby="projects-add-title"]');
  assert.equal(addDialog != null, true, "add-project dialog should be present");
  await act(async () => {
    Array.from(addDialog.querySelectorAll("button"))
      .find((button) => /Browse/.test(button.textContent || "")).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(addDialog.querySelector(".projects-folder-row code")?.textContent || "", /work\\sample/);
  assert.equal(addDialog.querySelector('input[name="project-name"]').value, "sample",
    "the name field prefills from the chosen folder");
  await act(async () => {
    addDialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(added, [["addProject", "C:\\work\\sample"], ["renameProject", "C:\\work\\sample", "sample"]]);
  assert.deepEqual(calls, [], "adding a project must not navigate into it");
  assert.equal(document.querySelector('[aria-labelledby="projects-add-title"]'), null, "dialog closes after saving");
  assert.match(document.querySelector(".projects-list")?.textContent || "", /sample/i);
  // The Projects panel lives in the sidebar now: adding a project keeps the
  // panel (and therefore the sidebar) open for the next action.
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
});

test("user-triggered sidebar opens share the compositor FLIP entry point", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  // The FLIP owns the commit in BOTH directions: opening has to land inside
  // the rewrap cross-fade, so no toggle may set the panel state on its own.
  assert.match(source,
    /const openSidebar = useCallback\(\(\) => \{[^}]*if \(sidebarOpenIntent\.current\) return;[^}]*beginSidePanelOpen\("sidebar", \(\) => applySidebarOpen\(true\)\);[^}]*\}, \[[^\]]+\]\);/s);
  assert.doesNotMatch(source, /beginSidePanelOpen\("(sidebar|dock)"\);/);
  assert.match(source, /onOpenSessions=\{openSidebar\}/);
  assert.doesNotMatch(source, /onOpenSessions=\{\(\) => setSidebarOpen\(true\)\}/);
});

test("cached sessions paint immediately and authoritative rows do not wait for projects", async () => {
  installDom();
  const cached = {
    id: "cached-startup-session",
    title: "Cached startup session",
    preview: "Cached startup session",
    updatedAt: 10,
    activityAt: 10,
    messageCount: 2,
    cwd: "C:\\cached",
    classification: "task",
    projectPath: null,
    currentSession: true,
    working: true,
  };
  const authoritative = {
    ...cached,
    id: "authoritative-startup-session",
    title: "Authoritative startup session",
    preview: "Authoritative startup session",
    currentSession: false,
    working: false,
  };
  window.localStorage.setItem(SESSION_CATALOG_STORAGE_KEY, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    rows: [cached],
  }));
  let resolveSessions;
  let resolveProjects;
  const sessionsPending = new Promise((resolve) => { resolveSessions = resolve; });
  const projectsPending = new Promise((resolve) => { resolveProjects = resolve; });
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: () => sessionsPending,
    listProjects: () => projectsPending,
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(`[data-session-id="${cached.id}"]`) != null, true);
  assert.equal(document.querySelector(".sidebar-section-loading"), null);

  await act(async () => {
    resolveSessions([authoritative]);
    await sessionsPending;
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(`[data-session-id="${cached.id}"]`), null,
    "the authoritative listing must remove stale cached rows");
  assert.equal(document.querySelector(`[data-session-id="${authoritative.id}"]`) != null, true,
    "session readiness must not wait for the still-pending project listing");

  await act(async () => {
    resolveProjects([]);
    await projectsPending;
    await Promise.resolve();
  });
});

test("launch restores the last active session instead of opening an empty replacement task", async () => {
  installDom();
  // This covers the legacy fallback used when no durable pane tree exists.
  window.localStorage.removeItem("mixdog.desktop.pane-layout.v1");
  const session = {
    id: "restore-last-session",
    title: "Durable restored title",
    preview: "Durable restored title",
    updatedAt: 10,
    currentSession: false,
    cwd: "C:\\work",
    classification: "project",
    projectPath: "C:\\work",
  };
  window.localStorage.setItem("mixdog.desktop-last-session.v1", session.id);
  const resumes = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session],
    resumeSession: async (sessionId) => {
      resumes.push(sessionId);
      return {
        sessionId,
        items: [{ id: "restored-user", kind: "user", text: "Restored transcript" }],
        queued: [],
      };
    },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  assert.deepEqual(resumes, [session.id]);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), session.title);
  await waitForDom(
    () => /Restored transcript/.test(document.querySelector(".transcript")?.textContent || ""),
    "the restored transcript should reveal after its pane surface settles",
  );
  assert.match(document.querySelector(".transcript")?.textContent || "", /Restored transcript/);
});

test("launch discards a missing last-session key and keeps the fresh task fallback", async () => {
  installDom();
  window.localStorage.setItem("mixdog.desktop-last-session.v1", "missing-session");
  const resumes = [];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [],
    resumeSession: async (sessionId) => { resumes.push(sessionId); return null; },
  };

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.deepEqual(resumes, []);
  assert.equal(window.localStorage.getItem("mixdog.desktop-last-session.v1"), null);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "New task");
});

test("new tasks choose a registered project or open a folder from the composer context control", async () => {
  installDom();
  const starts = [];
  let submits = 0;
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
    submit: async () => {
      submits += 1;
      return true;
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
  assert.deepEqual(starts, [], "selecting project context must remain renderer-only");
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
  assert.deepEqual(starts, [], "opening a folder must not initialize an engine before submit");
  assert.match(document.querySelector('button[aria-label="Project context"]').textContent, /Project/i);
  assert.doesNotMatch(document.querySelector('button[aria-label="Project context"]').textContent, /opened/i,
    "an unregistered cwd must not be presented as a project");
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "Start in selected folder");
    textarea.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Start in selected folder",
    }));
  });
  await act(async () => {
    document.querySelector(".send-button").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(starts, [openedPath], "first submit materializes only the final project context");
  assert.equal(submits, 1);
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

test("session switching commits target chrome and route before the resume settles", async () => {
  installDom();
  await preloadMarkdownBody();
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
  assert.equal(document.querySelector(".transcript")?.getAttribute("data-session-key"), target.id);
  assert.ok(document.querySelector(".pane-surface-cover"),
    "a cold target route should be opaque while its transcript loads");
  assert.equal(document.querySelector(".session-switch-overlay"), null);
  assert.ok(document.querySelector(".pane-surface-cover .desktop-loading-surface"),
    "a slow cold load shows the centered cover spinner (CSS delays it so fast settles stay silent)");
  assert.equal(document.querySelector(".titlebar-new"), null,
    "the strip carries no + affordance (sidebar/Ctrl+N own new tasks)");
  assert.equal(document.querySelector(
    `[data-tab-key="session:${target.id}"] .workspace-tab-main`,
  )?.getAttribute("aria-current"), "page",
  "the requested tab must activate with the target conversation route");
  assert.equal(document.querySelector('[data-tab-key^="new:"] .workspace-tab-main')
    ?.hasAttribute("aria-current"), false);

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

test("a failed stable session switch leaves the host-selected view untouched", async () => {
  installDom();
  const target = {
    id: "failed-target",
    preview: "Failed target",
    title: "Failed target",
    updatedAt: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  let rejectResume;
  const resumed = new Promise((_resolve, reject) => {
    rejectResume = () => reject(new Error("resume failed"));
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
  assert.equal(document.querySelector(
    `[data-tab-key="session:${target.id}"] .workspace-tab-main`,
  )?.getAttribute("aria-current"), "page");

  await act(async () => {
    rejectResume();
    await resumed.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "New task");
  assert.equal(document.querySelector('.workspace-tab-main[aria-current="page"]')
    ?.textContent.includes("New task"), true);
  assert.equal(document.querySelector(`[data-tab-key="session:${target.id}"]`), null,
    "a failed optimistic open must remove the staged target tab");
  assert.equal(document.querySelector(`[data-session-id="${target.id}"]`)?.classList.contains("selected"), false);
});

test("a recovered catalog title upgrades an open media-placeholder tab", async () => {
  installDom();
  const recoveredTitle = "세션나갔다들어오니 작업끊기는이슈";
  const target = {
    id: "media-placeholder-session",
    preview: "",
    title: "[Image]",
    updatedAt: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  let pushSessions = () => {};
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    subscribeSessions: (listener) => {
      pushSessions = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => [target],
    resumeSession: async () => ({
      sessionId: target.id,
      desktopSessionTitle: "Stale response title",
      items: [{ id: "target-message", kind: "user", text: "Target content" }],
      queued: [],
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "[Image]",
    "a stale resume response must not overwrite the clicked catalog title");

  await act(async () => {
    pushSessions([{ ...target, title: recoveredTitle, currentSession: true }]);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), recoveredTitle);
  assert.equal(document.querySelector(`[data-session-id="${target.id}"] .session-row-copy`)?.textContent.trim(),
    recoveredTitle);
  assert.equal(document.querySelector('.workspace-tab-main[aria-current="page"]')?.textContent.includes(recoveredTitle),
    true);
});

test("session resume does not reapply an invoke snapshot after its state publication", async () => {
  installDom();
  await preloadMarkdownBody();
  defaultSessionLaneStore.clear();
  let publish = () => {};
  const target = {
    id: "dedup-target",
    preview: "Dedup target",
    title: "Dedup target",
    updatedAt: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ sessionId: "source", items: [], queued: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => [target],
    resumeSession: async () => {
      publish({
        sessionId: target.id,
        items: [{ id: "published-row", kind: "user", text: "Published transcript" }],
        queued: [],
      });
      return {
        sessionId: target.id,
        items: [{ id: "duplicate-row", kind: "user", text: "Duplicate invoke transcript" }],
        queued: [],
      };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector(`[data-session-id="${target.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  assert.match(defaultSessionLaneStore.get(target.id)?.items?.[0]?.text || "",
    /Published transcript/,
    "the compatibility bridge must seed the same session lane before pane commit");
  const transcript = document.querySelector(".transcript")?.textContent || "";
  assert.match(transcript, /Published transcript/);
  assert.doesNotMatch(transcript, /Duplicate invoke transcript/);
  defaultSessionLaneStore.clear();
});

test("session rows prefetch on pointer intent without changing the selection", async () => {
  installDom();
  const prefetched = [];
  const target = {
    id: "prefetch-target",
    preview: "Prefetch target",
    title: "Prefetch target",
    updatedAt: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({ sessionId: "source", items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [target],
    prefetchSession: async (id) => {
      prefetched.push(id);
      return true;
    },
    resumeSession: async () => ({ sessionId: target.id, items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  const row = document.querySelector(`[data-session-id="${target.id}"]`);
  await act(async () => {
    row.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 40));
  });
  assert.deepEqual(prefetched, [], "passing over a row must not start competing main-process work");
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  });
  assert.deepEqual(prefetched, [target.id]);
  assert.equal(row.classList.contains("selected"), false);
});

test("opening an uncached session hides the outgoing transcript behind the target cover", async () => {
  installDom();
  await preloadMarkdownBody();
  let finishTarget;
  const targetResume = new Promise((resolve) => {
    finishTarget = () => resolve({
      sessionId: "target",
      items: [{ id: "target-row", kind: "user", text: "Target transcript" }],
      queued: [],
    });
  });
  const sessions = [
    { id: "source", title: "Source", preview: "Source", updatedAt: 2, currentSession: false,
      cwd: "C:\\work", classification: "task", projectPath: null },
    { id: "target", title: "Target", preview: "Target", updatedAt: 1, currentSession: false,
      cwd: "C:\\work", classification: "task", projectPath: null },
  ];
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
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
  assert.match(document.querySelector(".transcript")?.textContent || "", /Source transcript/);
  const sourceTranscript = document.querySelector(".transcript");
  await act(async () => {
    document.querySelector('[data-session-id="target"]').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript"), sourceTranscript,
    "the stable Conversation owner must survive while its route changes");
  assert.equal(sourceTranscript?.getAttribute("data-session-key"), "target");
  assert.doesNotMatch(sourceTranscript?.textContent || "", /Source transcript/,
    "the outgoing transcript must not remain visible while the target loads");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "Target");
  assert.equal(document.querySelector('[data-session-id="target"]')?.classList.contains("selected"), true,
    "the sidebar and conversation route move together");
  assert.ok(document.querySelector(".pane-surface-cover"));
  assert.ok(document.querySelector(".pane-surface-cover .desktop-loading-surface"),
    "a slow cold load shows the centered cover spinner (CSS delays it so fast settles stay silent)");
  await act(async () => {
    finishTarget();
    await targetResume;
    await Promise.resolve();
  });
  assert.match(document.querySelector(".transcript")?.textContent || "", /Target transcript/);
});

test("re-entering a visited session paints its cached transcript before resume completes", async () => {
  installDom();
  await preloadMarkdownBody();
  let sourceResumes = 0;
  let finishSourceReentry;
  const sourceReentry = new Promise((resolve) => {
    finishSourceReentry = () => resolve({
      sessionId: "source", items: [{ id: "source-row", kind: "user", text: "Source transcript" }], queued: [],
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
    subscribeState: () => () => {},
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      if (id === "target") {
        return { sessionId: "target", items: [{ id: "target-row", kind: "user", text: "Target transcript" }], queued: [] };
      }
      sourceResumes += 1;
      if (sourceResumes === 1) {
        return { sessionId: "source", items: [{ id: "source-row", kind: "user", text: "Source transcript" }], queued: [] };
      }
      return sourceReentry;
    },
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
    await Promise.resolve();
  });
  assert.match(document.querySelector('.transcript')?.textContent || '', /Target transcript/);
  const targetTranscript = document.querySelector(".transcript");
  await act(async () => {
    document.querySelector('[data-session-id="source"]').click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript"), targetTranscript);
  assert.equal(targetTranscript?.getAttribute("data-session-key"), "source");
  assert.match(targetTranscript?.textContent || "", /Source transcript/);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "Source");
  await act(async () => {
    finishSourceReentry();
    await sourceReentry;
    await Promise.resolve();
  });
  assert.match(document.querySelector('.transcript')?.textContent || '', /Source transcript/);
});

test("rapid session switching keeps one conversation DOM and commits only the latest target", async () => {
  installDom();
  await preloadMarkdownBody();
  const calls = [];
  let finishFirstReentry;
  const firstReentry = new Promise((resolve) => {
    finishFirstReentry = () => resolve({
      sessionId: "first",
      items: [{ id: "first-row", kind: "user", text: "First transcript" }],
      queued: [],
    });
  });
  let firstVisits = 0;
  const sessions = ["source", "first", "middle", "latest"].map((id, index) => ({
    id,
    title: id,
    preview: id,
    updatedAt: 4 - index,
    currentSession: id === "source",
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", "source");
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: "source",
      items: [{ id: "source-row", kind: "user", text: "Source transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      calls.push(id);
      if (id === "first" && ++firstVisits === 2) return firstReentry;
      return { sessionId: id, items: [{ id: `${id}-row`, kind: "user", text: `${id} transcript` }], queued: [] };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="first"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".transcript")?.textContent || "", /first transcript/i);
  await act(async () => {
    document.querySelector('[data-session-id="source"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".transcript")?.textContent || "", /source transcript/i);
  const stableSourceTranscript = document.querySelector(".transcript");
  await act(async () => {
    document.querySelector('[data-session-id="first"]').click();
    document.querySelector('[data-session-id="middle"]').click();
    document.querySelector('[data-session-id="latest"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["first", "source", "first"]);
  assert.equal(document.querySelector('[data-session-id="latest"]')?.classList.contains("selected"), true);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "latest");
  assert.equal(document.querySelector(".transcript"), stableSourceTranscript,
    "A→B→C must preserve the stable Conversation owner");
  assert.doesNotMatch(stableSourceTranscript?.textContent || "", /source transcript/i);
  assert.equal(stableSourceTranscript?.getAttribute("data-session-key"), "latest");
  assert.ok(document.querySelector(".pane-surface-cover"));
  assert.ok(document.querySelector(".pane-surface-cover .desktop-loading-surface"),
    "a slow cold load shows the centered cover spinner (CSS delays it so fast settles stay silent)");
  assert.equal(document.querySelector(".turn-status[data-animate]"), null);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 110));
  });
  assert.equal(document.querySelector(".transcript"), stableSourceTranscript,
    "time alone must not replace the latest target route");
  assert.equal(stableSourceTranscript?.getAttribute("data-session-key"), "latest");
  await act(async () => {
    finishFirstReentry();
    await firstReentry;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["first", "source", "first", "latest"]);
  assert.equal(document.querySelector(".transcript"), stableSourceTranscript,
    "the stable Conversation root survives the final atomic content swap");
  assert.equal(document.querySelector(".transcript")?.getAttribute("data-session-key"), "latest");
  assert.match(document.querySelector(".transcript")?.textContent || "", /latest transcript/);
});

test("rapid session switching back to the in-flight target cancels the queued target", async () => {
  installDom();
  await preloadMarkdownBody();
  const calls = [];
  let finishActiveReentry;
  const activeReentry = new Promise((resolve) => {
    finishActiveReentry = () => resolve({
      sessionId: "return-active",
      items: [{ id: "return-active-row", kind: "user", text: "Return active transcript" }],
      queued: [],
    });
  });
  let activeVisits = 0;
  const sessions = ["return-source", "return-active", "return-queued"].map((id, index) => ({
    id,
    title: id,
    preview: id,
    updatedAt: 3 - index,
    currentSession: id === "return-source",
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  }));
  window.localStorage.setItem("mixdog.desktop-last-session.v1", "return-source");
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: "return-source",
      items: [{ id: "return-source-row", kind: "user", text: "Return source transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      calls.push(id);
      if (id === "return-active" && ++activeVisits === 2) return activeReentry;
      return {
        sessionId: id,
        items: [{ id: `${id}-row`, kind: "user", text: `${id} transcript` }],
        queued: [],
      };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="return-active"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="return-source"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="return-active"]').click();
    document.querySelector('[data-session-id="return-queued"]').click();
    document.querySelector('[data-session-id="return-active"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["return-active", "return-source", "return-active"]);
  const returnSourceTranscript = document.querySelector(".transcript");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "return-active");
  assert.match(returnSourceTranscript?.textContent || "", /return-active transcript/i);
  assert.equal(returnSourceTranscript?.getAttribute("data-session-key"), "return-active");
  assert.equal(document.querySelector('[data-session-id="return-active"]')?.classList.contains("selected"), true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 110));
  });
  assert.deepEqual(calls, ["return-active", "return-source", "return-active"],
    "returning to the in-flight target must cancel the queued resume");
  assert.equal(document.querySelector(".transcript"), returnSourceTranscript);
  await act(async () => {
    finishActiveReentry();
    await activeReentry;
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript"), returnSourceTranscript);
  assert.match(document.querySelector(".transcript")?.textContent || "", /return active transcript/i);
});

test("Ctrl+Q keeps the outgoing conversation mounted until its session fallback is ready", async () => {
  installDom();
  await preloadMarkdownBody();
  let targetVisits = 0;
  let finishTargetFallback;
  const targetFallback = new Promise((resolve) => {
    finishTargetFallback = () => resolve({
      sessionId: "close-target",
      items: [{ id: "close-target-row", kind: "user", text: "Close target transcript" }],
      queued: [],
    });
  });
  const sessions = ["close-source", "close-target"].map((id, index) => ({
    id,
    title: id,
    preview: id,
    updatedAt: 2 - index,
    currentSession: id === "close-source",
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  }));
  seedActiveSession("close-source", "close-source");
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: "close-source",
      items: [{ id: "close-source-row", kind: "user", text: "Close source transcript" }],
      queued: [],
    }),
    subscribeState: () => () => {},
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      if (id === "close-target" && ++targetVisits === 2) return targetFallback;
      return {
        sessionId: id,
        items: [{ id: `${id}-row`, kind: "user", text: `${id} transcript` }],
        queued: [],
      };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="close-target"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-session-id="close-source"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const outgoing = document.querySelector(".transcript");
  assert.match(outgoing?.textContent || "", /close-source transcript/i);
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "q",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript"), outgoing,
    "Ctrl+Q must not unmount the old pane before the fallback can commit");
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "close-source");
  assert.equal(document.querySelector('[data-session-id="close-target"]')?.classList.contains("selected"), true);
  await act(async () => {
    finishTargetFallback();
    await targetFallback;
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript"), outgoing,
    "the fallback reuses the stable Conversation root");
  assert.match(document.querySelector(".transcript")?.textContent || "", /Close target transcript/);
  assert.equal(
    Array.from(document.querySelectorAll(".workspace-tab-main span"))
      .some((tab) => tab.textContent.trim() === "close-source"),
    false,
    "the closed tab leaves in the same commit that reveals its fallback",
  );
});

test("virtualized session switching renders immediately and uses one sticky resize path", async () => {
  installDom();
  await preloadMarkdownBody();
  let publish;
  let nextFrameId = 1;
  const pendingFrames = new Map();
  const resizeObservers = [];
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = true;
      this.targets = [];
      resizeObservers.push(this);
    }
    observe(target) { this.targets.push(target); }
    unobserve() {}
    disconnect() { this.active = false; }
  }
  globalThis.ResizeObserver = TestResizeObserver;
  Object.defineProperties(window, {
    requestAnimationFrame: {
      value(callback) {
        const id = nextFrameId++;
        pendingFrames.set(id, callback);
        return id;
      },
      configurable: true,
    },
    cancelAnimationFrame: {
      value(id) { pendingFrames.delete(id); },
      configurable: true,
    },
  });
  const targetItems = Array.from({ length: 64 }, (_, index) => ({
    id: `target-row-${index}`,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: `Target transcript row ${index}`,
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => [{
      id: "measured-target",
      title: "Measured target",
      preview: "Measured target",
      updatedAt: 1,
      currentSession: false,
      cwd: "C:\\work",
      classification: "task",
      projectPath: null,
    }],
    resumeSession: async () => ({
      sessionId: "measured-target",
      items: targetItems,
      queued: [],
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  const transcript = document.querySelector(".transcript");
  let transcriptHeight = 480;
  let transcriptClientWidth = 640;
  let transcriptClientHeight = 320;
  const scrollTargets = [];
  let simulatedScrollTop = 0;
  let rawScrollWrites = 0;
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => transcriptHeight, configurable: true },
    clientWidth: { get: () => transcriptClientWidth, configurable: true },
    clientHeight: { get: () => transcriptClientHeight, configurable: true },
    scrollTop: {
      get: () => simulatedScrollTop,
      set(value) {
        rawScrollWrites += 1;
        simulatedScrollTop = Number(value) || 0;
      },
      configurable: true,
    },
    scrollTo: {
      value(options) {
        simulatedScrollTop = Number(options?.top || 0);
        scrollTargets.push(simulatedScrollTop);
      },
      configurable: true,
    },
  });
  const advanceFrame = async (at) => {
    await act(async () => {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of callbacks) callback(at);
      await Promise.resolve();
    });
  };
  // The fixture installs clientWidth after the observer was constructed.
  // Establish that baseline before session entry so later height-only and
  // width-only deliveries exercise their intended paths.
  await act(async () => {
    for (const observer of resizeObservers) {
      if (observer.active) observer.callback([{ target: transcript }]);
    }
    await Promise.resolve();
  });
  for (const at of [-48, -32, -16, -1]) await advanceFrame(at);
  await act(async () => {
    document.querySelector('[data-session-id="measured-target"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(document.querySelector(".session-switch-overlay"), null);
  assert.equal(document.querySelector(".thread")?.hasAttribute("data-settling"), false);
  assert.equal(document.querySelector(".thread")?.hasAttribute("data-staging"), false);
  assert.ok(document.querySelector(".transcript-virtual-space"));

  for (const at of [0, 16, 32, 48]) await advanceFrame(at);
  assert.ok(scrollTargets.length > 0, "initial session placement should reach the latest row");
  assert.equal(new Set(scrollTargets).size, 1,
    "session entry must have one virtualizer-owned end target");
  assert.equal(scrollTargets.includes(transcriptHeight), false,
    "session entry must not mix in a raw scrollHeight target");
  const initialScrollCount = scrollTargets.length;
  transcriptHeight = 1_040;
  await act(async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const observer of resizeObservers) {
        if (observer.active) observer.callback([]);
      }
    }
    await Promise.resolve();
  });
  // Entry placement belongs to the virtualizer. Ongoing content growth belongs
  // to the aggregate ResizeObserver and writes the current DOM bottom once.
  const pinnedScrollCount = scrollTargets.length;
  assert.equal(pinnedScrollCount, initialScrollCount,
    "content resize pinning must not add a competing virtualizer target");
  assert.equal(rawScrollWrites, 1,
    "the mandatory initial ResizeObserver delivery is ignored and repeated growth settles with one DOM write");
  assert.equal(simulatedScrollTop, transcriptHeight - transcriptClientHeight,
    "content growth must pin to the current DOM bottom");
  await advanceFrame(64);
  assert.equal(scrollTargets.length, pinnedScrollCount,
    "the synchronous pin must not queue an extra animation-frame update");
  assert.equal(rawScrollWrites, 1,
    "the synchronous content pin must not schedule a duplicate write");

  // Composer/review growth shrinks the viewport without changing virtual
  // content. Its ResizeObserver sees the new clientHeight before TanStack's
  // own scrollRect observer, so this one case pins from current DOM geometry.
  transcriptHeight = 1_120;
  transcriptClientHeight = 280;
  const thread = document.querySelector(".thread");
  const viewportObserverFor = () => [...resizeObservers].reverse().find((observer) =>
    observer.active && observer.targets.includes(transcript) && observer.targets.includes(thread));
  let viewportObserver = viewportObserverFor();
  assert.ok(viewportObserver, "conversation resize observer must watch content and viewport");
  await act(async () => {
    viewportObserver.callback([{ target: transcript }]);
    await Promise.resolve();
  });
  assert.equal(rawScrollWrites, 2,
    "viewport resize must apply one immediate DOM pin");
  assert.equal(simulatedScrollTop, transcriptHeight - transcriptClientHeight,
    "viewport resize must use the current scroll and client heights");

  // Window/pane width changes rewrap many virtual rows. Every intermediate
  // measurement used to pin the changing total height, producing a visibly
  // shaking scrollbar in split workspaces. Suppress all burst writes and
  // restore the semantic bottom once after width + total size stabilize.
  // The shift START is the exception (VS Code part-toggle grammar): the
  // first delivery re-wrapped in the same pre-paint frame, so exactly one
  // immediate bottom pin makes the first painted frame correct.
  const widthBurstRawStart = rawScrollWrites;
  const widthBurstVirtualStart = scrollTargets.length;
  for (const [width, height] of [[610, 1_180], [570, 1_300], [525, 1_460]]) {
    transcriptClientWidth = width;
    transcriptHeight = height;
    viewportObserver = viewportObserverFor();
    assert.ok(viewportObserver);
    await act(async () => {
      viewportObserver.callback([{ target: transcript }]);
      viewportObserver.callback([{ target: thread }]);
      await Promise.resolve();
    });
  }
  assert.equal(rawScrollWrites, widthBurstRawStart + 1,
    "a width shift must pin its scroll target once pre-paint at shift start,"
    + " then never chase intermediate heights with raw scrollTop writes");
  assert.equal(scrollTargets.length, widthBurstVirtualStart,
    "width reflow must not ask the virtualizer to restore every intermediate width");
  for (const at of [80, 96, 112, 128, 144, 160, 176, 192, 208, 224]) {
    await advanceFrame(at);
  }
  assert.equal(rawScrollWrites, widthBurstRawStart + 2,
    "one stable-frame DOM bottom restore owns the completed width reflow");
  assert.equal(scrollTargets.length, widthBurstVirtualStart,
    "the completed width reflow must not leave a delayed virtualizer correction");
  assert.equal(transcript.hasAttribute("data-width-reflow"), false,
    "the width authority lock must release before normal content growth resumes");
  assert.ok(viewportObserverFor());

  const settledItems = targetItems.slice(0, -1);
  let script = "```powershell\n";
  for (const [height, chunk] of [
    [1_600, "Get-ChildItem -Recurse\n"],
    [1_780, "npm run typecheck\n"],
    [1_960, "npm run test\n```"],
  ]) {
    transcriptHeight = height;
    script += chunk;
    const phaseScrollStart = scrollTargets.length;
    const phaseRawStart = rawScrollWrites;
    await act(async () => {
      publish({
        sessionId: "measured-target",
        items: settledItems,
        streamingTail: {
          ...targetItems.at(-1),
          text: script,
          streaming: true,
        },
        busy: true,
        spinner: { active: true, mode: "responding", startedAt: Date.now() },
        queued: [],
      });
      await Promise.resolve();
      for (const observer of resizeObservers) {
        if (observer.active) observer.callback([]);
      }
      await Promise.resolve();
    });
    await advanceFrame(height);
    assert.equal(scrollTargets.length, phaseScrollStart,
      "streaming growth must not add a competing virtualizer target");
    assert.equal(rawScrollWrites, phaseRawStart + 1,
      "streaming growth must apply one aggregate content pin");
    assert.equal(simulatedScrollTop, transcriptHeight - transcriptClientHeight,
      "streaming growth must retain the current DOM bottom");
  }

  const wheel = new window.Event("wheel", { bubbles: true });
  Object.defineProperty(wheel, "deltaY", { value: -1 });
  await act(async () => transcript.dispatchEvent(wheel));
  const disarmedScrollCount = scrollTargets.length;
  const disarmedRawWrites = rawScrollWrites;
  await act(async () => {
    for (const observer of resizeObservers) {
      if (observer.active) observer.callback([]);
    }
    await Promise.resolve();
  });
  await advanceFrame(80);
  assert.equal(scrollTargets.length, disarmedScrollCount,
    "explicit upward scrolling should disarm resize following immediately");
  assert.equal(rawScrollWrites, disarmedRawWrites,
    "explicit upward scrolling should disarm DOM resize pins immediately");
});

test("virtual tail selection skips trailing hidden completion metadata", () => {
  assert.equal(lastVisibleTranscriptItemIndex(65, (index) => index === 64), 63);
  assert.equal(lastVisibleTranscriptItemIndex(66, (index) => index >= 64), 63);
  assert.equal(lastVisibleTranscriptItemIndex(1, () => true), -1);
});

test("the window bar places Update left of the sidebar toggle while the rail foot stays clear", async () => {
  installDom();
  let updateOpens = 0;
  let updaterSubscriptions = 0;
  let publishUpdater = () => {};
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    subscribeState: () => () => {},
    listSessions: async () => [],
    getUpdaterState: async () => ({ status: "idle" }),
    subscribeUpdaterState: (listener) => {
      updaterSubscriptions += 1;
      publishUpdater = listener;
      return () => {};
    },
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    publishUpdater({ status: "ready", version: "2.0.0" });
    await Promise.resolve();
  });

  assert.equal(document.querySelector(".session-sidebar .sidebar-usage"), null,
    "the session panel stays a pure list — usage lives behind the rail toggle");
  const usageToggle = document.querySelector(".activity-rail .sidebar-usage-toggle");
  assert.equal(usageToggle?.getAttribute("aria-label"), "Usage");
  assert.equal(document.querySelector(".rail-usage-popup"), null,
    "the usage dashboard must not render while closed");
  await act(async () => usageToggle.click());
  const usagePopup = document.querySelector(".rail-usage-popup");
  assert.equal(usagePopup?.dataset.state, "open");
  assert.deepEqual(
    Array.from(usagePopup.querySelectorAll(".sidebar-usage-line > b"), (node) => node.textContent),
    ["Codex", "Claude", "Grok", "OpenCode Go"],
  );
  await act(async () => usageToggle.click());
  assert.equal(document.querySelector(".rail-usage-popup"), null);
  const trigger = document.querySelector("[aria-label='Open settings']");
  assert.equal(trigger != null, true, "settings trigger should be present at the rail foot");
  assert.equal(trigger.closest(".activity-rail") !== null, true);
  assert.equal(trigger.getAttribute("aria-label"), "Open settings");
  assert.equal(trigger.getAttribute("data-tooltip"), "Settings");
  assert.equal(trigger.getAttribute("title"), null);
  assert.ok(updaterSubscriptions >= 1, "the renderer should subscribe to authoritative updater state");
  const update = document.querySelector(".titlebar-update");
  assert.equal(update?.closest(".titlebar-leading") != null, true,
    "Update lives in the window bar's layout cluster (user: 사이드바 토글 왼쪽)");
  assert.equal(update?.nextElementSibling?.classList.contains("toolbar-sidebar"), true,
    "Update sits immediately left of the sidebar toggle");
  assert.equal(update?.getAttribute("aria-label"), "Install Mixdog 2.0.0");
  assert.equal(document.querySelector(".sidebar-update-button"), null,
    "the rail no longer hosts the updater badge");
  await act(async () => {
    update.click();
    await Promise.resolve();
  });
  assert.equal(updateOpens, 0, "clicking Update must not install before confirmation");
  const confirmation = document.querySelector("[data-desktop-update-dialog]");
  assert.equal(confirmation != null, true, "clicking Update should open the themed confirmation");
  assert.match(confirmation.textContent, /Install Mixdog 2\.0\.0/);
  await act(async () => {
    [...confirmation.querySelectorAll("button")]
      .find((button) => button.textContent === "Install and restart").click();
    await Promise.resolve();
  });
  assert.equal(updateOpens, 1);
});

test("sidebar Usage paints cached subscriptions immediately with every quota window inline", async () => {
  installDom();
  const checkedAt = Date.now();
  const cached = {
    checkedAt,
    rows: [
      { id: "openai-oauth", label: "OpenAI OAuth", group: "oauth", authenticated: true,
        windows: [
          { label: "5H", usedPct: 17, resetAt: checkedAt + 3_600_000 },
          { label: "WEEK", usedPct: 31, resetAt: checkedAt + 6 * 86_400_000 },
        ],
        resetCredits: {
          availableCount: 2,
          availableCredits: [
            { expiresAt: checkedAt + 2 * 86_400_000 },
            { expiresAt: checkedAt + 5 * 86_400_000 },
          ],
          nextExpiresAt: checkedAt + 2 * 86_400_000,
          offerRevision: `v1:${"a".repeat(64)}`,
        } },
      { id: "anthropic-oauth", label: "Anthropic OAuth", group: "oauth", authenticated: true,
        windows: [
          { label: "5H", usedPct: 0 },
          { label: "7D", usedPct: 42, resetAt: checkedAt + 4 * 86_400_000 },
        ] },
      { id: "grok-oauth", label: "Grok OAuth", group: "oauth", authenticated: true,
        windows: [{ label: "WEEK", usedPct: 25, resetAt: checkedAt + 3 * 86_400_000 }] },
      { id: "opencode-go", label: "OpenCode Go API", group: "api", authenticated: true,
        windows: [{ label: "WEEK", usedPct: 8, resetAt: checkedAt + 5 * 86_400_000 }] },
    ],
  };
  const live = {
    ...cached,
    checkedAt: checkedAt + 1,
    rows: cached.rows.map((row) => row.id === "openai-oauth"
      ? { ...row, windows: row.windows.map((window) => window.label === "WEEK"
        ? { ...window, usedPct: 57 }
        : window) }
      : row),
  };
  window.localStorage.setItem(SIDEBAR_USAGE_CACHE_KEY, JSON.stringify(cached));
  let finishLoad;
  const loadGate = new Promise((resolve) => { finishLoad = resolve; });
  const calls = [];
  const api = {
    invokeCapability: async (request) => {
      calls.push(request);
      await loadGate;
      return { value: live };
    },
  };

  await act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(SidebarUsage, { api }),
  )));
  assert.equal(document.querySelector(".sidebar-usage-heading > b")?.textContent, "Usage",
    "the renewed flyout should open with one compact title");
  assert.equal(document.querySelector(".sidebar-usage-updated"), null,
    "freshness text should not compete with the usage title");
  assert.ok(document.querySelector("#sidebar-usage-list"),
    "the subscription list should remain directly visible");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".sidebar-usage-line > b"), (node) => node.textContent),
    ["Codex", "Claude", "Grok", "OpenCode Go"],
    "all four subscription rows should paint before the live request resolves",
  );
  for (const row of document.querySelectorAll(".sidebar-usage-row")) {
    const line = row.querySelector(".sidebar-usage-line");
    assert.equal(line?.firstElementChild?.classList.contains("sidebar-usage-provider-icon"), true,
      "each provider icon should sit directly before its name");
    assert.equal(line?.children[1]?.tagName, "B");
    assert.ok(row.querySelector(".sidebar-usage-meter"),
      "each provider should keep its quota meter visible");
  }
  // Orca-style flat roster: every window renders inline — no drill-in state.
  const codexRoster = document.querySelector('[data-usage-provider="codex"]');
  assert.equal(codexRoster?.querySelectorAll(".sidebar-usage-meter").length, 2,
    "both Codex windows paint inline without expanding anything");
  assert.match(codexRoster?.textContent || "", /5H.*17%.*W.*31%/s);
  assert.equal(codexRoster?.querySelector(".sidebar-usage-line > small")?.textContent,
    "Resets in 1h",
    "the soonest reset rides the provider icon/name line (user: 아이콘과 같은 선상)");
  assert.match(codexRoster?.querySelector(".sidebar-usage-meter")?.textContent || "",
    /5H.*17%/s,
    "each full-width meter keeps its label, track, and percentage");
  assert.doesNotMatch(codexRoster?.querySelector(".sidebar-usage-meter")?.textContent || "",
    /Resets/,
    "reset schedules no longer repeat on every quota row");
  assert.match(document.querySelector('[data-usage-provider="claude"]')?.textContent || "",
    /5H.*0%.*7D.*42%/s);
  assert.equal(document.querySelector('[aria-label="Refresh subscription usage"]'), null);
  assert.deepEqual(calls, [{
    capability: "getUsageDashboard",
    args: [{ refresh: true, refreshSetup: false }],
  }],
    "StrictMode should share one automatic usage request");

  assert.equal(document.querySelector(".sidebar-usage-detail"), null,
    "the flat roster leaves nothing to expand");
  assert.doesNotMatch(document.body.textContent || "", /Manage providers/);
  const resetCreditRows = document.querySelectorAll(".sidebar-usage-reset-row");
  assert.equal(resetCreditRows.length, 2,
    "each Codex reset credit should have its own expiry and action row");
  assert.match(resetCreditRows[0].textContent || "", /Reset credit 1.*Expires in 2d.*Use/s);
  assert.match(resetCreditRows[1].textContent || "", /Reset credit 2.*Expires in 5d.*Use/s);
  assert.equal(document.querySelectorAll('[aria-label^="Use Codex reset credit"]').length, 2);
  await act(async () => {
    finishLoad();
    await loadGate;
    await Promise.resolve();
  });
  assert.match(document.querySelector('[data-usage-provider="codex"]')?.textContent || "", /W.*57%/s,
    "the StrictMode effect replay must adopt the first live response");
});

test("Codex reset credit requires confirmation and adopts the refreshed dashboard", async () => {
  installDom();
  const checkedAt = Date.now();
  const offerRevision = `v1:${"b".repeat(64)}`;
  const initial = {
    checkedAt,
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "5H", usedPct: 100, resetAt: checkedAt + 3_600_000 }],
      resetCredits: {
        availableCount: 2,
        availableCredits: [
          { expiresAt: checkedAt + 86_400_000 },
          { expiresAt: checkedAt + 2 * 86_400_000 },
        ],
        offerRevision,
      },
    }],
  };
  const refreshed = {
    checkedAt: checkedAt + 1,
    rows: [{
      ...initial.rows[0],
      windows: [{ label: "5H", usedPct: 0 }],
      resetCredits: {
        availableCount: 1,
        availableCredits: [{ expiresAt: checkedAt + 2 * 86_400_000 }],
        offerRevision: `v1:${"c".repeat(64)}`,
      },
    }],
  };
  window.localStorage.setItem(SIDEBAR_USAGE_CACHE_KEY, JSON.stringify(initial));
  const requests = [];
  const api = {
    invokeCapability: async (request) => {
      requests.push(request);
      if (request.capability === "consumeCodexRateLimitResetCredit") {
        return { value: { outcome: "reset", dashboard: refreshed } };
      }
      return { value: initial };
    },
  };
  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api }));
    await Promise.resolve();
  });
  await act(async () => document.querySelector('[aria-label="Use Codex reset credit 2"]').click());
  assert.match(document.querySelectorAll(".sidebar-usage-reset-row")[1]?.textContent || "",
    /uses one available credit/i);
  await act(async () => {
    document.querySelector('[aria-label="Confirm using Codex reset credit 2"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const consume = requests.find((request) => request.capability === "consumeCodexRateLimitResetCredit");
  assert.equal(consume.args[0].expectedOfferRevision, offerRevision);
  assert.match(consume.args[0].idempotencyKey,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(document.querySelector('[role="status"]')?.textContent || "", /Rate limits reset/);
  assert.equal(document.querySelectorAll(".sidebar-usage-reset-row").length, 1);
  assert.equal(document.querySelectorAll('[aria-label^="Use Codex reset credit"]').length, 1);
});

test("sidebar Usage keeps cached values through a failure and continues automatic refreshes", async () => {
  installDom();
  const checkedAt = Date.now();
  const cached = {
    checkedAt,
    rows: [{
      id: "openai-oauth",
      label: "OpenAI OAuth",
      group: "oauth",
      authenticated: true,
      windows: [{ label: "WEEK", usedPct: 31, resetAt: checkedAt + 86_400_000 }],
    }],
  };
  window.localStorage.setItem(SIDEBAR_USAGE_CACHE_KEY, JSON.stringify(cached));
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  let retryRefresh = null;
  let periodicRefresh = null;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 15_000) {
      retryRefresh = () => callback(...args);
      return 15_000;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  window.clearTimeout = (handle) => {
    if (handle === 15_000) {
      retryRefresh = null;
      return;
    }
    nativeClearTimeout(handle);
  };
  window.setInterval = (callback, delay, ...args) => {
    if (delay === 5 * 60_000) {
      periodicRefresh = () => callback(...args);
      return 5 * 60_000;
    }
    return nativeSetInterval(callback, delay, ...args);
  };
  window.clearInterval = (handle) => {
    if (handle === 5 * 60_000) return;
    nativeClearInterval(handle);
  };
  const requests = [];
  let attempt = 0;
  const api = {
    invokeCapability: async (request) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) throw new Error("temporary engine startup race");
      return {
        value: {
          ...cached,
          rows: cached.rows.map((row) => ({
            ...row,
            windows: [{ ...row.windows[0], usedPct: attempt === 2 ? 57 : 63 }],
          })),
        },
      };
    },
  };

  await act(async () => {
    root.render(React.createElement(SidebarUsage, { api }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(requests.length, 1);
  assert.equal(document.querySelector(".sidebar-usage-error"), null,
    "a transient refresh failure should not paint a permanent global error");
  // Orca-style flat roster: the cached weekly window must survive the failed
  // refresh (label and separator glyphs are layout, not the contract).
  assert.match(document.querySelector('[data-usage-provider="codex"]')?.textContent || "", /W.*31%/s);
  assert.equal(typeof retryRefresh, "function");
  assert.equal(typeof periodicRefresh, "function");

  await act(async () => {
    const refresh = retryRefresh;
    retryRefresh = null;
    refresh();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('[data-usage-provider="codex"]')?.textContent || "", /W.*57%/s);

  await act(async () => {
    periodicRefresh();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(document.querySelector('[data-usage-provider="codex"]')?.textContent || "", /W.*63%/s);
  assert.equal(requests.every((request) =>
    request.args?.[0]?.refresh === true && request.args?.[0]?.refreshSetup === false), true);
});

test("sidebar session titles reclaim the status column without disturbing usage details", async () => {
  const css = await readFile(new URL("./desktop.css", import.meta.url), "utf8");
  assert.match(css,
    /\.session-row-status\s*\{[^}]*position:\s*absolute;[^}]*right:\s*8px;[^}]*width:\s*12px;/s,
    "the working status should overlay the trailing title fade");
  assert.doesNotMatch(css, /\.session-row-status\s*\{[^}]*flex:/s,
    "an empty status slot must not shorten session titles");
  assert.match(css, /\.session-row\.working \.session-row-copy\s*\{\s*padding-right:\s*18px;/s,
    "working titles should stop before the trailing spinner");
  assert.match(css, /\.session-row-main\s*\{[^}]*gap:\s*8px;/s);
  assert.match(css,
    /\.session-sidebar \.standalone-session-list \.session-row\s*\{\s*padding-left:\s*6px;\s*\}/);
  assert.match(css,
    /\.session-sidebar \.project-group \.session-row\s*\{\s*padding-left:\s*22px;\s*\}/,
    "project sessions should retain one 16px hierarchy step");
  assert.match(css,
    /\.sidebar-usage-provider-icon\s*\{[^}]*width:\s*20px;[^}]*flex:\s*0 0 20px;/s);
  assert.match(css, /\.sidebar-usage-provider-icon svg\s*\{[^}]*width:\s*17px;[^}]*height:\s*17px;/s);
  assert.match(css, /\.sidebar-usage-line\s*\{[^}]*gap:\s*5px;/s);
  assert.match(css,
    /\.sidebar-usage-meters\s*\{[^}]*padding-left:\s*25px;/s,
    "quota rows should start under the provider name, aligned past the icon");
  assert.match(css,
    /\.sidebar-usage-meter\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) 34px;[^}]*gap:\s*8px;/s,
    "each quota window is one row: period label, full-width track, percentage");
  assert.match(css,
    /\.sidebar-usage-line > small\s*\{[^}]*margin-left:\s*auto;/s,
    "the reset schedule pins to the right edge of the provider line");
  assert.match(css,
    /\.rail-usage-popup\s*\{[^}]*position:\s*fixed;[^}]*left:\s*56px;[^}]*bottom:\s*var\(--rail-usage-popup-bottom,\s*48px\);[^}]*width:\s*312px;/s,
    "Usage should float from the rail foot instead of spending sidebar height");
});

test("sidebar keeps Project below New task and orders Recent by conversation activity", async () => {
  installDom();
  const resumes = [];
  const workflowCalls = [];
  let publishSessions = null;
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `recent-${index + 1}`,
    preview: `Recent ${index + 1}`,
    title: `Recent ${index + 1}`,
    // Lifecycle bookkeeping runs in the opposite order; it must not affect
    // the user-visible Recent order.
    updatedAt: 100 - index,
    activityAt: index + 1,
    cwd: "C:\\work",
    classification: index % 2 ? "project" : "task",
    projectPath: index % 2 ? "C:\\work" : null,
    currentSession: false,
  }));
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      items: [],
      queued: [],
    }),
    subscribeState: () => () => {},
    subscribeSessions: (listener) => {
      publishSessions = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => sessions,
    resumeSession: async (id) => {
      resumes.push(id);
      return { items: [], queued: [], sessionId: id };
    },
    invokeCapability: async (request) => {
      if (request.capability === "listWorkflows") {
        return { value: [
          { id: "default", name: "Default" },
          { id: "solo", name: "Solo", active: true },
          { id: "custom", name: "Custom" },
        ] };
      }
      if (request.capability === "setWorkflow") {
        workflowCalls.push(request.args[0]);
        return {
          value: request.args[0],
          snapshot: {
            items: [],
            queued: [],
            workflow: { id: request.args[0], name: "Custom" },
          },
        };
      }
      return { value: null };
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(Array.from(
    document.querySelectorAll(".activity-rail > nav > button, .activity-rail > button"),
    (node) => node.getAttribute("aria-label")),
  ["Sessions", "Open projects", "Open workflows", "Open schedules", "Open webhooks",
    "Usage", "Open settings"]);
  assert.deepEqual(Array.from(
    document.querySelectorAll(".session-panel-header-actions > button"),
    (node) => node.getAttribute("aria-label")),
  ["New tab"],
  "Sessions exposes one pane-style create menu instead of separate creation actions");
  assert.equal(document.querySelector('[aria-label="Open projects"]')?.getAttribute("data-tooltip"), "Projects");
  const contextBar = document.querySelector(".composer-context-bar");
  const projectContext = contextBar?.querySelector(".composer-project-context");
  const workflowContext = contextBar?.querySelector(".composer-route-workflow");
  assert.equal(projectContext?.nextElementSibling, workflowContext,
    "Workflow should sit immediately right of Project");
  const workflow = workflowContext?.querySelector('[aria-label="Workflow"]');
  assert.equal(workflow?.textContent.trim(), "Solo");
  assert.equal(document.querySelector('.session-sidebar [aria-label="Workflow"]'), null,
    "Workflow should render only above the composer");
  await act(async () => {
    workflow.click();
    await Promise.resolve();
  });
  let workflowOptions = Array.from(document.querySelectorAll('.mx-menu[aria-label="Workflow"] [role="option"]'));
  assert.deepEqual(workflowOptions.map((option) => option.textContent.trim()), ["Default", "Solo", "Custom"]);
  assert.equal(workflowOptions[1].getAttribute("aria-selected"), "true");
  await act(async () => {
    workflowOptions[2].click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(workflowCalls, [], "New task workflow changes must remain local until first submit");
  assert.equal(workflow.textContent.trim(), "Custom");
  await act(async () => workflow.click());
  workflowOptions = Array.from(document.querySelectorAll('.mx-menu[aria-label="Workflow"] [role="option"]'));
  assert.equal(workflowOptions[2].getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector(".sidebar-recent-heading")?.textContent.trim(), "Recent");
  assert.equal(document.querySelector(".sidebar-section-toggle"), null);
  const recent = document.querySelector(".recent-session-list");
  const shortcuts = Array.from(recent.querySelectorAll(".session-row"));
  assert.deepEqual(shortcuts.map((row) => row.textContent.trim()),
    ["Recent 6", "Recent 5", "Recent 4", "Recent 3", "Recent 2", "Recent 1"]);
  assert.equal(recent.querySelectorAll(".session-row-main").length, 6);
  assert.equal(shortcuts.every((row) => row.getAttribute('data-tooltip') === null), true);
  assert.equal(recent.querySelectorAll('.session-row-actions .session-row-archive').length, 6);

  assert.equal(document.querySelector('[aria-label="Search sessions"]'), null);
  assert.equal(recent.querySelectorAll(".session-row").length, 6);

  await act(async () => {
    recent.querySelector('[data-session-id="recent-4"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(resumes, ["recent-4"]);

  await act(async () => {
    publishSessions(sessions.map((session) => (
      session.id === "recent-4" ? { ...session, updatedAt: 1_000 } : session
    )));
    await Promise.resolve();
  });
  assert.deepEqual(Array.from(recent.querySelectorAll(".session-row"),
    (row) => row.textContent.trim()),
  ["Recent 6", "Recent 5", "Recent 4", "Recent 3", "Recent 2", "Recent 1"],
  "resume bookkeeping alone must not reshuffle Recent");

  await act(async () => {
    publishSessions(sessions.map((session) => (
      session.id === "recent-4" ? { ...session, updatedAt: 1_000, activityAt: 10 } : session
    )));
    await Promise.resolve();
  });
  assert.equal(recent.querySelector(".session-row")?.getAttribute("data-session-id"), "recent-4",
    "new conversation activity should promote the session");
});

test("sidebar shows the working spinner for live spinner activity even when busy is false", async () => {
  installDom();
  const session = {
    id: "working-session",
    preview: "Working session",
    title: "Working session",
    updatedAt: 1,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: true,
  };
  const idleSession = {
    ...session,
    id: "idle-session",
    preview: "Idle session",
    title: "Idle session",
    currentSession: false,
  };
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: session.id,
      items: [],
      queued: [],
      busy: false,
      spinner: { active: true, mode: "responding" },
    }),
    subscribeState: () => () => {},
    listProjects: async () => [],
    listSessions: async () => [session, idleSession],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!document.querySelector(".session-sidebar")) {
    await act(async () => {
      document.querySelector('[aria-label="Sessions"]')?.click();
      await Promise.resolve();
    });
  }
  const spinner = document.querySelector(`[data-session-id="${session.id}"] .session-row-spinner`);
  assert.ok(spinner);
  assert.equal(spinner.getAttribute("aria-label"), "Working session is working");
  assert.equal(document.querySelectorAll(".session-row-status").length, 2,
    "working and idle rows must reserve the same fixed status slot");
  assert.equal(document.querySelector(`[data-session-id="${idleSession.id}"] .session-row-status`)?.childElementCount, 0);
});

test("sidebar preserves an attached session spinner and turns completion into an unread dot", async () => {
  installDom();
  let publishSessions = null;
  const workingSession = {
    id: "attached-working",
    preview: "Attached working",
    title: "Attached working",
    updatedAt: 2,
    activityAt: 2,
    messageCount: 1,
    working: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: true,
  };
  const otherSession = {
    ...workingSession,
    id: "other-session",
    preview: "Other session",
    title: "Other session",
    updatedAt: 1,
    activityAt: 1,
    working: false,
    currentSession: false,
  };
  const rows = [workingSession, otherSession];
  window.mixdogDesktop = {
    getSnapshot: async () => ({
      sessionId: workingSession.id,
      sessionRemoteAttached: true,
      items: [],
      queued: [],
      busy: false,
    }),
    subscribeState: () => () => {},
    subscribeSessions: (listener) => {
      publishSessions = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => rows,
    resumeSession: async (id) => ({
      sessionId: id,
      sessionRemoteAttached: id === workingSession.id,
      items: [],
      queued: [],
      busy: false,
    }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!document.querySelector(".session-sidebar")) {
    await act(async () => {
      document.querySelector('[aria-label="Sessions"]')?.click();
      await Promise.resolve();
    });
  }

  const workingRow = () => document.querySelector(`[data-session-id="${workingSession.id}"]`);
  assert.ok(workingRow()?.querySelector(".session-row-spinner"),
    "catalog heartbeat should show before selection");

  await act(async () => {
    workingRow().click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(workingRow()?.querySelector(".session-row-spinner"),
    "opening an attached viewer must not clear the external spinner");

  await act(async () => {
    document.querySelector(`[data-session-id="${otherSession.id}"]`).click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(workingRow()?.querySelector(".session-row-spinner"),
    "switching away must preserve the still-working session spinner");

  await act(async () => {
    publishSessions([
      { ...workingSession, working: false },
      otherSession,
    ]);
    await Promise.resolve();
  });
  assert.equal(workingRow()?.querySelector(".session-row-spinner"), null);
  assert.ok(workingRow()?.querySelector(".session-row-unread-dot"),
    "a background working -> completed transition must become unread even before messageCount advances");
  const workingTab = Array.from(document.querySelectorAll(".workspace-tab"))
    .find((tab) => tab.textContent.includes(workingSession.title));
  assert.ok(workingTab?.querySelector(".workspace-tab-unread-dot"),
    "the matching open workspace tab must mirror the sidebar unread marker");
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
  const longScript = `Long script\n\n\`\`\`ts\n${Array.from(
    { length: 320 },
    (_line, line) => `const line${line} = ${line};`,
  ).join("\n")}\n\`\`\``;
  const items = Array.from({ length: 5_000 }, (_, index) => ({
    id: `long-message-${index}`,
    kind: index % 2 === 0 ? "user" : "assistant",
    text: index % 2 === 0 ? `Long session message ${index}` : longScript,
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
  await waitForDom(
    () => Boolean(document.querySelector('.transcript-virtual-space[data-virtualized="true"]')),
    "long transcripts should settle into the virtual timeline",
    1_000,
  );
  const virtualSpace = document.querySelector('.transcript-virtual-space[data-virtualized="true"]');
  const renderedRows = document.querySelectorAll('.transcript-virtual-row');
  const visibleRows = document.querySelectorAll('.transcript-virtual-row:not([hidden])');
  assert.ok(virtualSpace, "long transcripts should use the virtual timeline");
  assert.ok(renderedRows.length > 0 && renderedRows.length < 80,
    `expected a bounded DOM window, rendered ${renderedRows.length} of ${items.length}`);
  assert.ok(visibleRows.length > 0,
    "DOM retention must not hide the virtualizer's active window");
  assert.ok(document.querySelector('.transcript-virtual-row--retained[data-retained="active"]'),
    "a visible settled assistant should use its retained DOM row");
  await waitForDom(
    () => Boolean(document.querySelector(
      '.transcript-virtual-row--retained[data-retained="active"] .markdown-code')),
    "the retained tail should finish rendering its long script",
    1_000,
  );
  const retainedScriptRow = document.querySelector(
    '.transcript-virtual-row--retained[data-retained="active"]:has(.markdown-code)');
  const retainedScript = retainedScriptRow?.querySelector(".markdown-code");
  const conversationNode = document.querySelector(".conversation");
  assert.ok(retainedScriptRow && retainedScript);
  // Length-proportional row estimates shrank the pre-measure spacer scale
  // (short fixture rows estimate ~56px, not a fixed 160px).
  assert.ok(Number.parseFloat(virtualSpace.style.height) > 250_000,
    "the virtual spacer should preserve access to the full transcript");

  const tabByText = (text) => Array.from(document.querySelectorAll(".workspace-tab"))
    .find((tab) => (tab.textContent || "").includes(text));
  await act(async () => {
    tabByText("New task").querySelector(".workspace-tab-main").click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".transcript-virtual-space"), virtualSpace,
    "New Task must park the existing virtual layer instead of replacing it");
  assert.equal(retainedScriptRow.isConnected, true);
  assert.equal(retainedScriptRow.dataset.retained, "hidden");
  assert.equal(retainedScriptRow.hidden, false,
    "parking must retain layout instead of collapsing the script through display:none");

  const queuedFrames = new Map();
  let queuedFrameSequence = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: {
      configurable: true,
      value(callback) {
        const handle = ++queuedFrameSequence;
        queuedFrames.set(handle, callback);
        return handle;
      },
    },
    cancelAnimationFrame: {
      configurable: true,
      value(handle) {
        queuedFrames.delete(handle);
      },
    },
  });
  await act(async () => {
    tabByText("Long session").querySelector(".workspace-tab-main").click();
    await Promise.resolve();
  });
  assert.equal(retainedScriptRow.dataset.retained, "active",
    "the requested route and retained script must become active in the click commit");
  assert.ok(document.querySelector(".thread-welcome-paint-handoff"),
    "the previous New Task pixels must cover the warm raster for one frame");
  const callbacks = [...queuedFrames.values()];
  queuedFrames.clear();
  assert.ok(callbacks.length > 0, "the warm handoff must schedule one animation frame");
  await act(async () => {
    callbacks.forEach((callback) => callback(window.performance.now()));
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".thread-welcome-paint-handoff"), null,
    "the prior watermark must leave after one animation frame");
  await waitForDom(
    () => retainedScriptRow.dataset.retained === "active",
    "the parked long session should become active again",
    1_000,
  );
  assert.equal(document.querySelector(".conversation"), conversationNode,
    "Session → New Task → Session must retain the Conversation owner");
  assert.equal(retainedScriptRow.querySelector(".markdown-code"), retainedScript,
    "Session → New Task → Session must reuse the exact parsed script DOM");
});

test("sidebar session titles rename inline with commit, cancel, validation, and rollback", { skip: "rename UI removed - delete-only session actions" }, async () => {
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
  // Panels start minimized: expand the session sidebar for row interactions.
  await act(async () => document.querySelector(".toolbar-sidebar").click());

  let title = document.querySelector(".recent-session-list .session-row-copy");
  assert.equal(document.querySelector(".session-row-archive")?.getAttribute("aria-label"), "Archive Original title");
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
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), false);
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
  let publishSessions = () => {};
  let finishRename;
  const renamePending = new Promise((resolve) => {
    finishRename = resolve;
  });
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
    subscribeSessions: (listener) => {
      publishSessions = listener;
      return () => {};
    },
    listProjects: async () => [],
    listSessions: async () => [session],
    resumeSession: async () => resumed,
    renameSession: async (id, title) => {
      renames.push([id, title]);
      await renamePending;
      session.title = title;
    },
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
  assert.equal(document.querySelector('[aria-label="Regenerate title"]'), null);
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
  assert.equal(document.querySelector(".workspace-tab.active .workspace-tab-main > span")
    ?.textContent.trim(), "Renamed from header");
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Renamed from header");
  await act(async () => {
    publishSessions([{ ...session }]);
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".session-title-trigger")?.textContent.trim(), "Renamed from header",
    "a stale catalog push must not replace the optimistic header title");
  assert.equal(document.querySelector(".workspace-tab.active .workspace-tab-main > span")
    ?.textContent.trim(), "Renamed from header",
  "a stale catalog push must not replace the optimistic tab title");
  assert.equal(document.querySelector(".session-row-copy")?.textContent.trim(), "Renamed from header",
    "a stale catalog push must not replace the optimistic sidebar title");
  await act(async () => {
    finishRename();
    await renamePending;
    await Promise.resolve();
    await Promise.resolve();
  });
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

test("a pending session rename survives an overlapping stale session refresh", { skip: "rename UI removed - delete-only session actions" }, async () => {
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
    document.querySelector(".session-new-task").click();
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

test("Tooltip placement stays inside the viewport and flips away from a clipped edge", async () => {
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
    if (this.classList?.contains("mx-tooltip")) {
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
  let tooltip = document.querySelector(".mx-tooltip");
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
  tooltip = document.querySelector(".mx-tooltip");
  assert.equal(tooltip.dataset.side, "top");
  assert.equal(tooltip.style.left, "736px");
  assert.equal(tooltip.style.top, "690px");

  window.setTimeout = originalTimeout;
});

test("snapshot notifications render and dismiss through the desktop toast surface", async () => {
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
  const toast = document.querySelector('.mx-toast[data-tone="success"]');
  assert.equal(toast != null, true, "success toast should be present");
  assert.match(toast.textContent, /Completed.*Settings saved/);
  await act(async () => toast.querySelector('[aria-label="Dismiss notification"]').click());
  assert.equal(document.querySelector('.mx-toast') === null, true, "selector .mx-toast should be absent");
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
  assert.match(document.querySelector('.mx-toast[data-tone="error"]')?.textContent || "", /First failure/);

  await act(async () => publish({ items: [], queued: [], toasts: [] }));
  assert.match(document.querySelector('.mx-toast[data-tone="error"]')?.textContent || "", /First failure/);

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
  const errors = Array.from(document.querySelectorAll('.mx-toast[data-tone="error"]'));
  assert.equal(errors.length, 5);
  assert.equal(errors.some((toast) => toast.textContent.includes("First failure")), false);
  assert.equal(errors.filter((toast) => toast.textContent.includes("Failure 2")).length, 1);

  await act(async () => errors.at(-1).querySelector('[aria-label="Dismiss notification"]').click());
  assert.equal(document.querySelectorAll('.mx-toast[data-tone="error"]').length, 4);
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
  // Panels start minimized: expand the session sidebar for nav assertions.
  await act(async () => document.querySelector(".toolbar-sidebar").click());

  let pane = await openProjectsPane();
  let rows = pane.querySelectorAll(".projects-row-open");
  assert.equal(rows[0].getAttribute("aria-current"), "page");
  assert.equal(rows[1].hasAttribute("aria-current"), false);
  assert.equal(document.querySelector(".session-new-task"), null,
    "Projects replaces the Sessions header actions while its panel is visible");
  assert.doesNotMatch(document.body.textContent || "", /Stale transcript/);
  assert.equal(document.querySelector(".composer") != null, true, "selector .composer should be present");
  await act(async () => {
    Array.from(rows).find((row) => /old/i.test(row.textContent || ""))?.click();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".workspace-project-trigger") === null, true, "selector .workspace-project-trigger should be absent");
  assert.match(document.querySelector(".session-header h1")?.textContent || "", /old/i);
  assert.match(document.body.textContent || "", /Stale transcript/);

  pane = await openProjectsPane();
  rows = pane.querySelectorAll(".projects-row-open");
  await act(async () => {
    Array.from(rows).find((row) => /next/i.test(row.textContent || ""))?.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(document.querySelector(".empty-state") === null, true, "selector .empty-state should be absent");
  assert.equal(document.querySelector(".composer") != null, true, "selector .composer should be present");
  assert.doesNotMatch(document.body.textContent || "", /Stale transcript/);
  assert.equal(document.querySelector(".activity-rail .session-new-task"), null,
    "New task must stay out of the Activity Rail during project transitions");
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  const alert = document.querySelector('.inline-error[role="alert"]');
  assert.match(alert.textContent || "", /Project switch failed/);
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  // Rail panels keep the sidebar open on desktop widths.
  assert.equal(document.querySelector(".sidebar").classList.contains("open"), true);
  pane = await openProjectsPane();
  rows = pane.querySelectorAll(".projects-row-open");
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
  // Final contract: tool cards never embed diff bodies — expanding shows only
  // the one-line summary (full diffs live in Review).
  await act(async () => document.querySelector(".tool-card .tool-header")?.click());
  assert.equal(document.querySelector(".code-diff"), null,
    "tool cards must not embed a diff body");
  assert.ok((document.querySelector(".tool-card .tool-detail-line .tool-detail-text")?.textContent || "").length > 0,
    "expansion reveals the one-line summary");
  assert.equal(document.querySelectorAll(".starter-grid button").length, 0);

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
  // Autosize moved to CSS field-sizing: the JS height writer is gone, so the
  // inline style stays empty (jsdom cannot exercise native field-sizing).
  assert.equal(textarea.style.height, "");
  assert.equal(document.activeElement === textarea, true, "composer should retain focus after the initial resize");
  assert.equal(textarea.selectionStart, 8);
  await act(async () => window.dispatchEvent(new window.Event("resize")));
  assert.equal(textarea.style.height, "");
  assert.equal(document.activeElement === textarea, true, "composer should retain focus after height capping");
  assert.equal(textarea.selectionStart, 8);
  const send = document.querySelector('button[aria-label="Send message"]');
  await act(async () => {
    send.click();
    await Promise.resolve();
  });
  assert.deepEqual(submitted, ["Preserve this behavior"]);
  assert.equal(textarea.value, "");
  assert.equal(textarea.style.height, "", "autosize is CSS-native (field-sizing), no inline height");

  await act(async () => publish({ ...initial, busy: true }));
  const stop = document.querySelector('button[aria-label="Stop generation"]');
  assert.equal(stop != null, true, "stop-generation button should be present while busy");
  assert.equal(stop, send, "send and stop states must reuse one composer action node");
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
  assert.equal(steer, send, "steer and send states must reuse one composer action node");
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
  assert.equal(document.querySelector(".session-new-task")?.getAttribute("aria-current"), null);
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
  assert.equal(document.querySelector(".activity-rail .session-new-task"), null,
    "New task must stay out of the Activity Rail after a failed resume");
  assert.doesNotMatch(document.body.textContent || "", /Active transcript/);
  assert.equal(document.querySelector(".context-chip") === null, true, "selector .context-chip should be absent");
  assert.match(document.querySelector('[role="alert"]').textContent || "", /Resume failed/);
});

test("flat recent sessions and the projects page preserve navigation and project actions", async () => {
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
    renameProject: async (path, alias) => {
      projectActions.push(["rename", path, alias]);
      visibleProjects = visibleProjects
        .map((candidate) => candidate.path === path ? { ...candidate, alias } : candidate);
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
  assert.equal(document.querySelectorAll(".session-sidebar-scroll .session-row-main").length, 5);
  assert.equal(document.querySelector(".activity-rail [aria-label='Open projects']")?.getAttribute("data-tooltip"), "Projects");
  assert.equal(document.querySelector(".sidebar .project-group"), null);
  assert.doesNotMatch(document.querySelector(".sidebar").textContent || "", /Legacy/);
  let projectsPane = await openProjectsPane();
  assert.match(projectsPane.querySelector(".projects-list")?.textContent || "", /One alias/);
  assert.equal(projectsPane.querySelectorAll('[aria-label="Pinned project"]').length, 0,
    "pin/unpin is removed from the projects page");
  assert.equal(projectsPane.querySelectorAll('.project-more, .project-card').length, 0,
    "the projects page replaces the legacy popup switcher");
  assert.equal(projectsPane.querySelectorAll('.row-overflow-trigger').length, 2,
    "each project row should expose one right-aligned overflow trigger");
  // VS Code view action: the create control sits in the panel title row, so
  // the list never repeats the panel's own name (user report).
  assert.equal(projectsPane.querySelector(".projects-add"), null);
  assert.equal(document.querySelector(".session-panel-header .projects-add")
    ?.getAttribute("aria-label"), "Add project");
  // The Projects list lives in the sidebar panel area (user decision):
  // rows and the Add action render inside the session panel swap.
  assert.ok(projectsPane.closest(".session-sidebar-panels"),
    "the projects list must live in the sidebar panel area");
  assert.equal(document.querySelector(".session-panel-header")?.textContent, "Projects");
  const firstProject = Array.from(projectsPane.querySelectorAll(".projects-row-open"))
    .find((row) => /One alias/.test(row.textContent || ""));
  assert.equal(firstProject != null, true, "first project row should be present on the page");
  assert.equal(firstProject.getAttribute("aria-current"), "page", "the last used project should be selected by default");
  await act(async () => {
    firstProject.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await settleStableSurfaceSwitch();
  // Choosing a project returns the panel to Sessions; the sidebar itself
  // stays open on desktop widths.
  assert.equal(document.querySelector(".session-panel-header")?.textContent, "Sessions");
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

  projectsPane = await openProjectsPane();
  const rowFor = (label) => Array.from(projectsPane.querySelectorAll(".projects-row"))
    .find((row) => label.test(row.textContent || ""));
  // Rename stays inline, but starts from the row's overflow menu.
  const renameTarget = rowFor(/Two alias/);
  await act(async () => {
    renameTarget.querySelector('[aria-label="Actions for Two alias"]').click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((button) => button.textContent === "Rename")?.click();
    await Promise.resolve();
  });
  const renameInput = renameTarget.querySelector('input[aria-label="Project display name"]');
  assert.equal(renameInput?.value, "Two alias");
  await act(async () => {
    renameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(renameTarget.querySelector('input[aria-label="Project display name"]'), renameInput,
    "Escape must park the inline rename without replacing its DOM");
  assert.equal(renameInput.disabled, true);
  assert.equal(renameInput.closest(".projects-rename")?.getAttribute("aria-hidden"), "true");
  assert.deepEqual(projectActions, []);

  // Removal keeps its two-step confirmation inside the overflow menu.
  const removeTarget = rowFor(/One alias/);
  await act(async () => {
    removeTarget.querySelector('[aria-label="Actions for One alias"]').click();
    await Promise.resolve();
  });
  const removeButton = () => Array.from(document.querySelectorAll('[role="menuitem"]'))
    .find((button) => button.textContent === "Remove" || button.textContent === "Confirm remove");
  await act(async () => {
    removeButton().click();
    await Promise.resolve();
  });
  assert.equal(removeButton().textContent, "Confirm remove");
  assert.deepEqual(projectActions, []);
  await act(async () => {
    removeButton().click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(projectActions.at(-1), ["remove", "C:\\work\\one"]);
  assert.doesNotMatch(projectsPane.querySelector(".projects-list").textContent, /One alias/);
  assert.match(projectsPane.querySelector(".projects-list").textContent, /Two alias/);
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
  const shell = Array.from(document.querySelectorAll(".app-shell")).at(-1);
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  // The narrow drawer stays mounted but closed: translated off-screen, inert
  // and hidden from assistive tech, so navigation cannot leave a reachable
  // overlay behind.
  assert.equal(document.querySelector(".sidebar")?.dataset.state, "closed",
    "mobile navigation must close the drawer");
  assert.equal(document.querySelector(".sidebar")?.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector(".sidebar")?.classList.contains("open"), false);
  await act(async () => document.querySelector(".toolbar-sidebar").click());
  assert.equal(document.querySelector(".sidebar").getAttribute("aria-hidden"), "false");
  await act(async () => {
    document.querySelector('[data-session-id="mobile"]').click();
    await Promise.resolve();
  });
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(document.querySelector(".sidebar")?.dataset.state, "closed");
  assert.equal(document.querySelector(".sidebar")?.getAttribute("aria-hidden"), "true");
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
    listSessions: async () => [
      { id: "desktop-boundary", preview: "Boundary session", title: "Boundary session", updatedAt: 1, cwd: projectPath, classification: "project", projectPath, currentSession: false },
    ],
    startProject: async () => ({ currentProject: projectPath, items: [], queued: [] }),
    resumeSession: async () => ({ sessionId: "desktop-boundary", items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });
  // The desktop default starts expanded; navigation above 760px keeps it open.
  await act(async () => {
    document.querySelector('[data-session-id="desktop-boundary"]').click();
    await Promise.resolve();
  });
  const shell = document.querySelector(".sidebar").closest(".app-shell");
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

  const notification = document.querySelector('.mx-toast-region .mx-toast[data-tone="error"]');
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

test("an empty task renders a pure chat surface without watermark or starters", async () => {
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

  // The empty draft carries ONLY the centered watermark (user: VS Code
  // grammar — shortcuts stay exclusive to the fully empty workspace).
  assert.ok(document.querySelector(".thread-welcome-task .welcome-logo path"),
    "an empty draft shows the brand watermark");
  assert.equal(document.querySelector(".thread-welcome-task .welcome-wordmark"), null,
    "the draft welcome must not repeat the product wordmark");
  assert.equal(document.querySelector(".thread-welcome-task .welcome-shortcuts"), null,
    "draft panes must not repeat the workspace shortcut list");
  assert.equal(document.querySelectorAll(".starter-grid button").length, 0);
  const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
  assert.ok(textarea, "the blank draft is just the chat surface with its composer");
  assert.equal(textarea.style.height, "", "autosize is CSS-native (field-sizing), no inline height");
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

test("Quick Open and Command Palette use one keyboard-first workbench surface", async () => {
  installDom();
  assert.deepEqual(parseQuickOpenQuery("src/App.tsx:42"), { query: "src/App.tsx", line: 42 });
  const opened = [];
  await act(async () => {
    root.render(React.createElement(WorkbenchQuickAccess, {
      key: "files",
      mode: "files",
      projectPath: "C:\\work",
      recentFiles: ["src/App.tsx"],
      commands: [],
      onOpenFile: (path, line) => opened.push({ path, line }),
      onClose() {},
    }));
  });
  const quickInput = document.querySelector('input[aria-label="Quick Open"]');
  assert.ok(quickInput);
  assertActiveElement(quickInput, "Quick Open owns focus");
  await act(async () => {
    quickInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.deepEqual(opened, [{ path: "src/App.tsx", line: undefined }]);

  const ran = [];
  await act(async () => {
    root.render(React.createElement(WorkbenchQuickAccess, {
      key: "commands",
      mode: "commands",
      projectPath: "C:\\work",
      recentFiles: [],
      commands: [{
        id: "view.toggle",
        category: "View",
        label: "Toggle Panel",
        shortcut: "Ctrl+Shift+B",
        run: () => ran.push("view.toggle"),
      }],
      onOpenFile() {},
      onClose() {},
    }));
  });
  const commandInput = document.querySelector('input[aria-label="Command Palette"]');
  assert.ok(commandInput);
  await act(async () => {
    commandInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.deepEqual(ran, ["view.toggle"]);
});

test("dirty editor close offers Save, Don’t Save, and Cancel without discarding implicitly", async () => {
  installDom();
  const actions = [];
  await act(async () => {
    root.render(React.createElement(UnsavedChangesDialog, {
      title: "App.tsx",
      busy: false,
      error: "",
      onSave: () => actions.push("save"),
      onDiscard: () => actions.push("discard"),
      onCancel: () => actions.push("cancel"),
    }));
  });
  assert.ok(document.querySelector('[role="alertdialog"]'));
  const button = (label) => Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  assertActiveElement(button("Save"), "Save is the safe default action");
  await act(async () => {
    button("Save").click();
    button("Don’t Save").click();
    button("Cancel").click();
  });
  assert.deepEqual(actions, ["save", "discard", "cancel"]);
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
  });
  await waitForDom(
    () => document.querySelector(".model-picker-dialog") === null
      && document.querySelector(".mixdog-settings") != null,
    "provider setup should deep-link to Settings > Providers",
  );
  assert.equal(document.querySelector(".model-picker-dialog") === null, true,
    "selector .model-picker-dialog should be absent");
});

test("model selector renders the persisted catalog before background refresh completes", async () => {
  installDom({ windowShown: false });
  let finishQuick;
  const quickGate = new Promise((resolve) => { finishQuick = resolve; });
  const setupRequests = [];
  const catalogOptions = [];
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
      catalogOptions.push(options);
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
  assert.match(document.querySelector('.composer-footer .model-trigger')?.textContent || '', /GPT-Cached/);
  assert.match(document.querySelector('[aria-label="Reasoning effort"]')?.textContent || '', /High/);
  assert.deepEqual(catalogOptions, [],
    "a persisted catalog must keep provider hydration out of the hidden first frame");
  await act(async () => {
    window.dispatchEvent(new Event("mixdog:window-shown"));
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  });
  assert.deepEqual(setupRequests.at(-1)?.args, [], "automatic setup refresh must stay off the model critical path");
  await act(async () => {
    finishQuick();
    await quickGate;
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(catalogOptions, [
    { quick: true },
    // The four hidden rail panes share one quick reference-catalog warmup
    // after the window is shown; it never enters the hidden first frame.
    { quick: true },
    { quick: false },
  ]);
  assert.match(document.querySelector('.composer-footer .model-trigger')?.textContent || '', /GPT-Cached/);
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const trigger = document.querySelector(".model-trigger");
  assert.equal(trigger.textContent.includes("warmup-context-regression"), false);
  assert.match(trigger.textContent, /Select model/);
});

test("model control styles keep the reference compact geometry and bounded list", async () => {
  const [css, themeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./desktop.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.model-picker-layer\s*\{[^}]*place-items:\s*center;/s);
  assert.match(css, /\.model-picker-dialog\s*\{[^}]*width:\s*min\(calc\(100vw - 16px\), 640px\);[^}]*height:\s*min\(calc\(var\(--vvh, 100vh\) - 16px\), 512px\);/s);
  assert.match(css, /\.model-search\s*\{[^}]*height:\s*32px;/s);
  assert.match(css, /\.model-group button\s*\{[^}]*width:\s*100%;[^}]*display:\s*flex;/s);
  assert.match(css, /\.model-list\s*\{[^}]*overflow-y:\s*auto;/s);
  for (const selector of [".model-trigger", ".effort-control select", ".fast-control"]) {
    assert.match(css, new RegExp(`\\${selector}\\s*\\{[^}]*height:\\s*28px;`, "s"));
  }
  assert.match(themeCss, /\.fast-control \.mx-select-trigger\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*40px;/s,
    "the Fast picker must keep its compact click target");
  assert.match(themeCss,
    /\.fast-control \.mx-select-trigger:hover:not\(:disabled\),[\s\S]*?\{[^}]*color:\s*var\(--mx-text\);[^}]*background:\s*var\(--mx-hover\);/s,
    "the Fast picker must expose hover feedback");
  assert.match(themeCss,
    /\.mx-select-root\.route-select \.mx-select-trigger > svg\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s,
    "route pickers must expose the shared compact chevron");
  assert.match(themeCss,
    /\.model-trigger,\s*\.effort-control \.mx-select-trigger\s*\{[^}]*color:\s*var\(--mx-text\);/s,
    "model and effort labels should share the active Fast tone");
  assert.match(themeCss,
    /\.model-trigger\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*min\(220px,\s*100%\);[^}]*flex:\s*0 1 auto;/s,
    "the model trigger should end at its visible label instead of reserving an empty fixed slot");
  assert.match(themeCss,
    /\.effort-control\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 0 auto;/s,
    "the effort picker should use its full intrinsic label width beside the model");
  assert.doesNotMatch(themeCss, /\.effort-control \.mx-select-trigger\s*\{\s*width:\s*100%;/s);
  assert.match(themeCss,
    /\.mx-menu\[aria-label="Project context"\] \.mx-menu-item\s*\{[^}]*line-height:\s*20px;/s,
    "project labels need enough line height for descenders");
  assert.match(themeCss,
    /\.effort-control \.mx-select-trigger\s*\{[^}]*height:\s*28px;[^}]*padding:\s*0 5px 0 8px;[^}]*line-height:\s*20px;/s,
    "the effort trigger needs a full text line box inside its fixed control height");
  assert.match(themeCss, /\.effort-control \.mx-select-value\s*\{[^}]*line-height:\s*20px;/s);
  assert.match(themeCss, /\.model-picker-layer\s*\{[^}]*background:[^}]*backdrop-filter:\s*blur\(2px\);/s);
  assert.match(themeCss, /\.model-provider-add\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*background:\s*transparent;/s);
  assert.match(themeCss, /\.model-picker-header\s*\{[^}]*padding:\s*16px 12px 16px 20px;/s);
  assert.match(themeCss, /\.model-provider-add\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(themeCss, /\.model-picker-dialog\s*\{[^}]*width:\s*min\(calc\(100vw - 16px\), 640px\);[^}]*height:\s*min\(calc\(var\(--vvh, 100vh\) - 16px\), 512px\);/s,
    "the centered dialog should use the reference dialog container geometry");
  assert.match(themeCss, /\.model-picker-dialog\s*\{[^}]*border-radius:\s*10px;/s,
    "the model dialog should use the reference --radius-xl value");
  assert.match(themeCss,
    /\.model-option-row\s*\{[^}]*min-height:\s*48px;[^}]*padding:\s*6px 8px;/s,
    "model rows should leave room for stable secondary metadata");
  assert.match(themeCss, /\.model-row-copy\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s);
  assert.match(themeCss, /\.model-row-copy > small\s*\{[^}]*color:\s*var\(--mx-text-faint\);[^}]*font-size:\s*11px;/s);
  assert.match(themeCss, /\.model-provider-add\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);
  assert.doesNotMatch(themeCss, /\.model-provider-row|\.model-provider-chevron|\.model-list-heading/);
  assert.match(themeCss, /\.model-row-copy strong\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;/s);
  assert.doesNotMatch(themeCss, /\.model-tag\s*\{/);
  assert.match(themeCss, /\.model-provider-setup\s*\{[^}]*height:\s*20px;/s);
  assert.match(themeCss, /\.model-notice\s*\{[^}]*padding:\s*7px 9px;[^}]*line-height:\s*16px;/s);
  assert.match(themeCss, /\.composer-region\s*\{[^}]*padding:\s*0 32px 8px;/s,
    "the composer should sit close to the workspace bottom edge");
  assert.match(themeCss, /\.composer\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*var\(--mx-bg-base\);[^}]*box-shadow:\s*var\(--mx-raised\);/s,
    "the composer should use the solid desktop base and its subtle raised elevation");
});

test("model selection applies the secure route result, hides unrelated effort, and recovers from errors", async () => {
  installDom();
  const calls = [];
  let reject = true;
  const row = seedActiveSession("route-session");
  window.mixdogDesktop = {
    getSnapshot: async () => ({ sessionId: "route-session", items: [], queued: [], provider: "openai", model: "gpt-real", effort: "high" }),
    subscribeState: () => () => {},
    listSessions: async () => [row],
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
      return { sessionId: "route-session", items: [], queued: [], provider: selection.provider, model: selection.model, effort: selection.effort };
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
  await waitForDom(() => /Claude Real/.test(document.querySelector(".model-trigger")?.textContent || ""),
    "model selection should render the applied route snapshot");
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
  const low = { sessionId: "effort-session", items: [], queued: [], provider: "openai", model: "gpt-real", effort: "low" };
  const row = seedActiveSession("effort-session");
  window.mixdogDesktop = {
    getSnapshot: async () => low,
    subscribeState: () => () => {},
    listSessions: async () => [row],
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
  const trigger = document.querySelector(".model-trigger");
  const effort = document.querySelector('[aria-label="Reasoning effort"]');
  await act(async () => effort.click());
  const high = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("High"));
  await act(async () => {
    high.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "selector .model-picker-dialog should be absent");
  assert.deepEqual(calls.filter((request) => request.capability !== "getTheme" &&
    request.capability !== "getOnboardingStatus" && request.capability !== "getProviderSetup" &&
    request.capability !== "listWorkflows" && request.capability !== "isRemoteEnabled" &&
    request.capability !== "getChannelSetup" && request.capability !== "getUsageDashboard"),
    [{ capability: "setEffort", args: ["high"] }]);
  await waitForDom(() => /High/.test(effort.textContent || ""),
    "effort selection should render the applied snapshot");
  assert.equal(document.activeElement === effort, true, "effort selection should restore effort-control focus");
  assert.match(effort.textContent, /High/);
});

test("Fast follows core capability, stays live during a turn, and disables only for session commands", async () => {
  installDom();
  let publish;
  const calls = [];
  const idle = {
    items: [], queued: [], sessionId: "fast-session", provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  const row = seedActiveSession("fast-session");
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [row],
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
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
  const fast = document.querySelector('[aria-label="Fast mode"]');
  assert.equal(fast != null, true, "Fast control should be present for a capable model");
  assert.equal(fast.getAttribute("aria-expanded"), "false");
  assert.equal(fast.textContent.trim(), "Fast Off");
  await act(async () => fast.click());
  const fastOn = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("Fast On"));
  await act(async () => {
    fastOn.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(() => fast.textContent.trim() === "Fast On",
    "Fast control should render the applied snapshot");
  assert.deepEqual(calls, [true]);
  assert.equal(fast.getAttribute("aria-expanded"), "false");
  assert.equal(fast.textContent.trim(), "Fast On");
  await act(async () => publish({ ...idle, busy: true }));
  assert.equal(fast.disabled, false,
    "tuning stays live during a turn: the change lands on the next turn");
  assert.equal(document.querySelector(".model-trigger").disabled, false,
    "model selection remains available as the next-session route while a turn is busy");
  await act(async () => publish({ ...idle, commandBusy: true }));
  assert.equal(fast.disabled, true, "an in-flight session command still locks tuning");
  await act(async () => {
    publish({ ...idle, fast: true });
    await Promise.resolve();
  });
  assert.equal(document.activeElement === fast, true,
    "Fast focus should return after busy controls re-enable");
  await act(async () => {
    publish({ ...idle, commandBusy: true, fast: true });
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
  await act(async () => {
    publish({ ...idle, fastCapable: false });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
  assert.equal(document.querySelector('.fast-control') === null, true, "selector .fast-control should be absent");
});

test("Fast recovers from a rejected toggle and can be retried", async () => {
  installDom();
  const calls = [];
  const idle = {
    sessionId: "fast-retry-session", items: [], queued: [], provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  let reject = true;
  const row = seedActiveSession("fast-retry-session");
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: () => () => {},
    listSessions: async () => [row],
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
  await act(async () => fast.click());
  let fastOn = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("Fast On"));
  await act(async () => {
    fastOn.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(() => fast.textContent.trim() === "Fast Off"
    && document.querySelector(".inline-error") != null,
  "a rejected Fast toggle should restore the previous value and expose its error");
  assert.deepEqual(calls, [true]);
  assert.equal(fast.disabled, false);
  assert.equal(fast.textContent.trim(), "Fast Off");
  assert.match(document.querySelector(".inline-error")?.textContent || "", /Fast preference was not applied/);

  await act(async () => fast.click());
  fastOn = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("Fast On"));
  await act(async () => {
    fastOn.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitForDom(() => fast.textContent.trim() === "Fast On"
    && document.querySelector(".inline-error") == null,
  "a successful Fast retry should render the applied snapshot and clear its error");
  assert.deepEqual(calls, [true, true]);
  assert.equal(fast.disabled, false);
  assert.equal(fast.textContent.trim(), "Fast On");
  assert.equal(document.querySelector(".inline-error") === null, true, "selector .inline-error should be absent");
});

test("Fast reflects the click before route persistence completes", async () => {
  installDom();
  const calls = [];
  let finishFast;
  const idle = {
    sessionId: "fast-pending-session", items: [], queued: [], provider: "openai", model: "gpt-real",
    fastCapable: true, fast: false,
  };
  const row = seedActiveSession("fast-pending-session");
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: () => () => {},
    listSessions: async () => [row],
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
  await act(async () => fast.click());
  const fastOn = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes("Fast On"));
  await act(async () => {
    fastOn.click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [true]);
  assert.equal(fast.textContent.trim(), "Fast On");
  assert.equal(fast.disabled, true);
  await act(async () => {
    finishFast();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await waitForDom(() => fast.textContent.trim() === "Fast On" && !fast.disabled,
    "Fast should retain the applied snapshot after persistence completes");
  assert.equal(fast.disabled, false);
  assert.equal(fast.textContent.trim(), "Fast On");
});

test("live engine activity and completion or compaction rows preserve runtime status", async () => {
  installDom();
  const idle = { items: [], queued: [], sessionId: "" };
  window.mixdogDesktop = {};
  const props = {
    invoke: async (action) => { await action(); },
    invokeResult: async (action) => await action(),
    errors: [],
    submit: async () => null,
    applySnapshot() {},
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenSettings() {},
    projects: [],
    showProjectSelector: false,
    activeProjectPath: "",
    activeProjectLabel: "",
    onSelectProject() {},
    onChooseProject() {},
    onOpenCommandSurface() {},
  };
  const renderSnapshot = async (snapshot) => {
    await act(async () => root.render(React.createElement(Conversation, {
      ...props,
      snapshot,
      routeSnapshot: snapshot,
    })));
  };
  await renderSnapshot(idle);
  await renderSnapshot({
    sessionId: "",
    busy: true,
    thinking: "real provider reasoning",
    spinner: { mode: "thinking", verb: "Reasoning" },
    items: [],
    queued: [],
  });
  assert.equal(document.querySelector(".live-activity-status")?.textContent, "Thinking");
  assert.equal(
    document.querySelector(".live-activity-status [data-component='text-shimmer']")
      ?.getAttribute("aria-label"),
    "Thinking",
  );
  assert.ok(document.querySelector(".live-activity-spinner.lucide-loader-circle"));
  assert.equal(document.querySelector(".live-activity")?.getAttribute("data-mode"), "thinking");
  assert.equal(document.querySelector(".session-progress") === null, true,
    "busy sessions should not add an animated header border");
  assert.equal(document.querySelector(".session-spinner") === null, true,
    "busy sessions should not add a rotating header icon");
  assert.equal(document.querySelector(".thinking-disclosure") === null, true, "selector .thinking-disclosure should be absent");
  await renderSnapshot({
    sessionId: "",
    busy: true,
    thinking: null,
    spinner: { mode: "reconnecting", verb: "Retrying in 2s (attempt 3)" },
    items: [],
    queued: [],
  });
  assert.equal(document.querySelector(".live-activity-status")?.textContent, "Retrying in 2s (attempt 3)");
  await renderSnapshot({
    sessionId: "",
    busy: true,
    thinking: { publicSummary: "Public reasoning summary", reasoning: "private reasoning" },
    spinner: { mode: "thinking", verb: "Reasoning" },
    items: [],
    queued: [],
  });
  const reasoning = document.querySelector(".thinking-disclosure");
  assert.equal(reasoning?.open, false);
  assert.equal(reasoning?.querySelector("summary")?.textContent, "View reasoning");
  assert.equal(reasoning?.querySelector("pre")?.textContent, "Public reasoning summary");
  assert.equal(document.body.textContent?.includes("private reasoning"), false);
  await renderSnapshot({
    sessionId: "",
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
  });
  assert.equal(document.querySelector(".live-activity") === null, true, "selector .live-activity should be absent");
  const compactRows = document.querySelectorAll(".compaction-divider");
  assert.equal(compactRows.length, 2);
  assert.equal(document.querySelectorAll(".compaction-divider .compaction-icon.lucide-layers").length, 2);
  assert.match(compactRows[0].textContent || "", /Compact complete.*12k → 4k/);
  assert.match(compactRows[1].textContent || "", /overflow recovery.*overflow recovered/);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".turn-status.complete")).map((row) => row.textContent?.trim()),
    ["Index complete· must stay hidden", "Thought"],
  );
});

test("desktop session sidebar resizes accessibly, releases its rail when collapsed, and restores it", async () => {
  const [baseCss, themeCss] = await Promise.all([
    readFile(new URL("./styles.css", import.meta.url), "utf8"),
    readFile(new URL("./desktop.css", import.meta.url), "utf8"),
  ]);
  assert.match(baseCss,
    /\.sidebar-collapsed \.sidebar\s*\{[^}]*width:\s*0;[^}]*flex-basis:\s*0;[^}]*padding-inline:\s*0;/s);
  assert.doesNotMatch(baseCss,
    /(?:^|\n)\.sidebar\s*\{[^}]*transition/s,
    'sidebar collapse must commit final layout in one frame (VS Code grammar)');
  assert.doesNotMatch(baseCss,
    /(?:^|\n)\.sidebar-collapsed \.sidebar\s*\{[^}]*transition/s,
    'sidebar expand must commit final layout in one frame (VS Code grammar)');
  assert.doesNotMatch(baseCss,
    /(?:^|\n)\.sidebar\s*\{[^}]*opacity(?:\s*:| var\(--mx-side-panel-motion\))/s);
  assert.doesNotMatch(baseCss,
    /(?:^|\n)\.sidebar-collapsed \.sidebar\s*\{[^}]*opacity(?:\s*:| var\(--mx-side-panel-motion\))/s);
  assert.match(themeCss,
    /--mx-side-panel-duration:\s*180ms;[^}]*--mx-side-panel-easing:\s*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\);[^}]*--mx-sheet-motion:\s*var\(--mx-side-panel-motion\);/s);
  assert.match(themeCss, /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*var\(--session-sidebar-width,\s*260px\);[^}]*min-width:\s*var\(--session-sidebar-min-width,\s*232px\);[^}]*max-width:\s*var\(--session-sidebar-max-width,\s*420px\);[^}]*flex:\s*0 0 var\(--session-sidebar-width,\s*260px\);[^}]*margin:\s*0;[^}]*padding:\s*0 8px 8px;/s);
  assert.match(themeCss,
    /\.sidebar-collapsed \.sidebar\.session-sidebar\s*\{[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*flex:\s*0 0 0px;[^}]*flex-basis:\s*0px;/s);
  assert.match(themeCss,
    /\.sidebar\.session-sidebar > \.session-panel-header,[\s\S]*?\.sidebar\.session-sidebar > \.session-sidebar-scroll\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*calc\(var\(--session-sidebar-min-width,\s*232px\) - 16px\);/s);
  assert.match(themeCss,
    /\.utility-dock > \.utility-dock-header,[\s\S]*?\.utility-dock > \.utility-dock-body\s*\{[^}]*width:\s*var\(--utility-dock-width,\s*380px\);[^}]*min-width:\s*var\(--utility-dock-width,\s*380px\);/s);
  assert.match(themeCss,
    /\.utility-dock--persistent > \.utility-dock-header,[\s\S]*?\.utility-dock--persistent > \.utility-dock-body\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*var\(--utility-dock-min-width,\s*300px\);/s);
  assert.match(themeCss,
    /\.utility-dock-pane\[data-surface-active="false"\]\s*\{[^}]*opacity:\s*0;/s,
    "inactive Dock parents must suppress visible nested stable-content layers");
  assert.match(baseCss,
    /\.main-panel\s*\{[^}]*min-width:\s*var\(--desktop-workspace-min-width,\s*360px\);/s);
  assert.match(themeCss,
    /@media \(min-width:\s*761px\)\s*\{[\s\S]*?\.main-panel\s*\{[^}]*flex:\s*1 0 var\(--desktop-workspace-min-width,\s*360px\);[^}]*min-width:\s*var\(--desktop-workspace-min-width,\s*360px\);[^}]*max-width:\s*none;[^}]*overflow:\s*auto;/s,
    "desktop workspace must preserve its floor instead of shrinking under side panels");
  // Studio inherits the tab's full flex height: shrinking thumbnails changes
  // only the scrollable results while the composer remains at the bottom.
  assert.match(themeCss,
    /\.workspace-utility-tab\s*\{[^}]*min-height:\s*0;[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;/s);
  assert.match(themeCss,
    /\.studio-root\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*display:\s*flex;/s);
  assert.match(themeCss,
    /\.studio-root\s*\{[^}]*container-type:\s*inline-size;/s,
    "Studio responsive gutters must follow the pane width instead of the desktop viewport");
  assert.match(themeCss,
    /\.studio-results\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;[^}]*padding:\s*16px calc\(32px - var\(--mx-scrollbar-size\)\) 8px 32px;[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(themeCss,
    /\.studio-dock\s*\{[^}]*box-sizing:\s*border-box;[^}]*flex:\s*0 0 auto;/s);
  assert.match(themeCss,
    /\.studio-composer\s*\{[^}]*display:\s*block;[^}]*min-height:\s*84px;/s,
    "Studio should use the session composer's block-flow height model");
  assert.match(themeCss,
    /\.studio-composer textarea\s*\{[^}]*min-height:\s*52px;[^}]*padding:\s*16px 16px 8px;/s);
  assert.match(themeCss,
    /\.studio-detail-card\s*\{[^}]*border-radius:\s*0;/s,
    "the detail frame must not round the media window");
  assert.match(themeCss,
    /\.studio-detail-stage img,\s*\.studio-detail-stage video\s*\{[^}]*border-radius:\s*0;/s,
    "detail media must render with square corners");
  assert.match(themeCss,
    /\.studio-detail-prompt\s*\{[^}]*-webkit-line-clamp:\s*4;[^}]*max-height:\s*72px;[^}]*overflow:\s*hidden;/s,
    "desktop detail prompts must reserve at most four stable lines");
  assert.match(themeCss,
    /\.studio-detail\[data-phone='true'\] \.studio-detail-prompt\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*max-height:\s*36px;/s,
    "compact detail prompts must reserve at most two stable lines");
  assert.match(themeCss,
    /\.studio-composer-bar\s*\{[^}]*height:\s*44px;[^}]*padding:\s*0 8px;/s);
  assert.match(themeCss,
    /@container \(max-width:\s*720px\)\s*\{[\s\S]*?\.studio-results,[\s\S]*?\.studio-dock,[\s\S]*?\.studio-topbar\s*\{[^}]*padding-inline:\s*18px;/s);
  assert.match(themeCss,
    /@container \(max-width:\s*520px\)\s*\{[\s\S]*?\.studio-results,[\s\S]*?\.studio-dock,[\s\S]*?\.studio-topbar\s*\{[^}]*padding-inline:\s*8px;/s);
  assert.match(themeCss, /\.studio-topbar\s*\{[^}]*padding:\s*16px 32px 0;/s);
  assert.match(themeCss, /\.studio-header\s*\{[^}]*display:\s*none;/s);
  assert.match(themeCss,
    /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.studio-header\s*\{[^}]*display:\s*flex;/s);
  assert.match(themeCss,
    /\.studio-grid\s*\{[^}]*width:\s*min\(100%,\s*736px\);[^}]*margin:\s*0 auto;/s);
  assert.match(themeCss,
    /\.studio-tile\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*0;/s);
  assert.doesNotMatch(themeCss,
    /data-motion-ready='true'\] \.studio-tile\s*\{[^}]*transition/s,
    'studio tiles must resize in the same frame as the pane (no width/height easing)');
  assert.match(themeCss,
    /\.workspace-tab-new\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.match(themeCss,
    /\.workspace-tab-new\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--mx-text\) 92%,\s*transparent\);/s);
  assert.match(themeCss,
    /\.workspace-tab-new-menu > button\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(themeCss, /\.studio-root > \.utility-dock|\.studio-side(?:[\s.{:#])/);
  assert.match(themeCss,
    /\.composer-context-bar\s*\{[^}]*min-height:\s*28px;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*6px;/s);
  assert.match(themeCss, /\.titlebar-leading\s*\{[^}]*height:\s*28px;[^}]*gap:\s*2px;[^}]*margin-right:\s*0;/s);
  assert.match(themeCss, /\.topbar\s*\{[^}]*align-items:\s*center;[^}]*padding:\s*0 0 0 5px;/s);
  assert.match(themeCss,
    /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.session-header-menu\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*margin:\s*0 2px 0 -6px;/s);
  assert.match(themeCss, /\.workspace-tabs\s*\{[^}]*height:\s*35px;[^}]*gap:\s*0;[^}]*padding:\s*0;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(themeCss,
    /\.utility-dock-tabs\s*\{[^}]*height:\s*36px;[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;[^}]*gap:\s*0;[^}]*padding:\s*0;[^}]*background:\s*transparent;/s);
  // Both side rails share the window band; only the workspace sheet is
  // lighter (user: left/right panels must read as one design).
  assert.match(themeCss,
    /\.utility-dock\s*\{[^}]*background:\s*var\(--mx-window-band\);/s);
  // ONE hairline per seam (user: 테두리 굵기 중구난방/겹침): the sidebar owns
  // the divider; the main panel must NOT add a second left hairline.
  assert.doesNotMatch(themeCss,
    /\.desktop-body > \.main-panel\s*\{\s*border-left:/);
  assert.match(themeCss,
    /\.utility-dock-tabs button::after\s*\{[^}]*bottom:\s*0;[^}]*height:\s*2px;[^}]*background:\s*var\(--mx-text\);/s);
  // One pane box for every dock tab keeps the same flex column and bottom
  // inset, so switching tabs cannot move the first row.
  assert.match(themeCss,
    /\.utility-dock-pane\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*padding:\s*0 0 8px;/s);
  // No dock pane may ever scroll or be widened sideways.
  assert.match(themeCss, /\.utility-dock-pane\s*\{[^}]*overflow-x:\s*clip;/s);
  assert.match(themeCss, /\.utility-dock-pane > \*\s*\{\s*min-width:\s*0;\s*\}/);
  assert.match(themeCss,
    /\.dock-language-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    'Problems and Outline rows must ellipsis inside the pane, not widen it');
  assert.match(themeCss,
    /\.utility-dock-pane\[data-tab="tasks"\],[\s\S]*?\.utility-dock-pane\[data-tab="files"\],[\s\S]*?\.utility-dock-pane\[data-tab="source-control"\],[\s\S]*?\.utility-dock-pane\[data-tab="pull-requests"\]\s*\{[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s,
    'each retained Dock surface must keep its panel header fixed inside one clipped layer');
  assert.match(themeCss,
    /\.utility-dock-empty\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*place-items:\s*center;/s,
    'every empty state centers on both axes inside the shared pane box');
  // Panel-specific title rows keep the cleaner, mixed-case heading below the
  // independent Orca activity strip.
  assert.match(themeCss,
    /\.utility-dock-header\s*\{[^}]*flex:\s*0 0 32px;[^}]*height:\s*32px;[^}]*margin-top:\s*4px;[^}]*padding:\s*0 8px 0 14px;[^}]*color:\s*var\(--mx-text\);/s);
  assert.match(themeCss,
    /\.utility-dock-title\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s);
  assert.match(themeCss,
    /\.utility-dock-title b,[\s\S]*?\.utility-dock-header > b\s*\{[^}]*font-weight:\s*600;/s);
  assert.doesNotMatch(themeCss, /\.utility-dock-header b\s*\{[^}]*text-transform:/s,
    "dock titles remain mixed case");
  assert.match(themeCss,
    /\.session-sidebar \.task-link,\s*\.session-sidebar \.projects-link\s*\{\s*font-size:\s*13px;\s*font-weight:\s*500;/s,
    'the left rail tier the dock title mirrors must stay put');
  assert.doesNotMatch(themeCss,
    /\.utility-dock:has\([^}]*utility-dock-empty[^}]*\)\s*\.utility-dock-title/,
    "empty panels must retain their VS Code-style title");
  // The explorer search block owns the panel's single search field now.
  assert.match(themeCss,
    /\.workbench-explorer-search,\s*\.dock-scm-view-controls\s*\{[^}]*border-bottom:/s);
  assert.doesNotMatch(themeCss, /\.dock-files-search\s*\{/);
  assert.doesNotMatch(themeCss, /\.workbench-search-scope\s*\{/);
  assert.match(themeCss,
    /\.workbench-search-mode,\s*\.dock-scm-tab-bar\s*\{[^}]*height:\s*30px;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    "Names and Contents must remain equal-width buttons below the query field");
  assert.match(themeCss,
    /\.workbench-search-mode button\[aria-selected="true"\],\s*\.dock-scm-tab\[aria-checked="true"\]\s*\{[^}]*color:\s*var\(--mx-text\);[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*font-weight:\s*600;/s,
    "the selected search mode must use full ink and the shared underline state");
  assert.doesNotMatch(themeCss, /\.workbench-search-(?:options|details|filters)\s*\{/,
    "the dock search must not expose wildcard, regex, or include/exclude controls");
  assert.match(themeCss,
    /\.utility-dock-project-row\s*\{[^}]*height:\s*41px;[^}]*flex:\s*0 0 41px;[^}]*border-bottom:/s,
    "Search keeps project selection on a dedicated second row");
  assert.match(themeCss, /\.dock-language-toolbar\s*\{[^}]*flex:\s*0 0 34px;[^}]*height:\s*34px;/s);
  assert.match(themeCss, /\.utility-dock-pane > \.dock-language-search\s*\{[^}]*flex:\s*0 0 26px;[^}]*margin:\s*0 12px 8px;/s);
  // GitHub Desktop's toolbar owns the branch dropdown now, so the picker
  // anchors to its toolbar section instead of an absolute repository strip.
  assert.match(themeCss,
    /\.dock-scm-toolbar\s*\{[^}]*display:\s*flex;[^}]*border-bottom:/s,
    "the toolbar row carries repository, branch, and push/pull sections");
  assert.match(themeCss,
    /\.dock-scm-toolbar-branch\s*\{[^}]*position:\s*relative;/s,
    "the branch picker anchor is the toolbar's branch section");
  assert.doesNotMatch(themeCss, /\.dock-scm-repository\s*\{/,
    "the custom repository strip left with the staged/unstaged grammar");
  // Overlays are portaled and positioned by anchored-panel.ts, so their CSS
  // must not re-introduce a CSS-anchored (clippable) box.
  assert.match(themeCss, /\.dock-scm-branch-picker\s*\{[^}]*position:\s*fixed;/s,
    "the branch panel is positioned against the window, not its section");
  // The commit SPLIT menu is deleted with its chevron, and the push/pull
  // dropdown before it: neither may leave orphan rules behind.
  assert.doesNotMatch(themeCss, /\.dock-scm-commit-(?:menu|more)\b/,
    "the deleted commit split menu and its chevron leave no CSS behind");
  assert.doesNotMatch(themeCss, /\.dock-scm-remote-(?:menu|more)\b/,
    "the deleted push/pull dropdown leaves no CSS behind");
  // The panel-header Fetch is back, but as the title row's ONE action,
  // portaled into `.utility-dock-header-actions`: the slot already owns the
  // 28x28 box, the hover wash and the disabled ink, so the button may only
  // contribute its own placement and icon centring.
  assert.match(themeCss, /\.dock-scm-header-fetch\s*\{[^}]*flex:\s*0 0 auto;/s,
    "the slot-hosted Fetch keeps its own placement rule");
  assert.match(themeCss, /\.dock-scm-header-fetch > svg\s*\{[^}]*display:\s*block;/s,
    "and centres its icon inside the slot's shared box");
  assert.doesNotMatch(themeCss,
    /\.dock-scm-header-fetch\s*\{[^}]*(?:width|height|border|background|box-shadow|color):/s,
    "it never re-declares the header slot's box, wash or ink");
  assert.doesNotMatch(themeCss, /\.dock-scm-header(?![\w-])[^\n{]*\{/,
    "and the deleted panel-header BAND still leaves no CSS behind");
  // Branch panel: a STABLE list box, so the panel cannot resize when the
  // branches replace the loading row (scripts/scm-geometry-probe asserts the
  // measured first-vs-settled heights).
  assert.match(themeCss,
    /\.dock-scm-branch-list\s*\{[^}]*height:\s*240px;[^}]*flex:\s*0 1 240px;[^}]*overflow:\s*auto;/s,
    "the branch list keeps one height and scrolls inside it");
  // Commit form (refs/github-desktop _commit-message.scss:4-13, 83-100,
  // 209-250, 321-334): a bordered region one tone darker than the panel, a real
  // single-line summary field, the description's own focus container, and a
  // full-width button that is toned down while it cannot run.
  assert.match(themeCss,
    /\.dock-scm-commit\s*\{[^}]*border-top:\s*1px solid var\(--mx-border-muted\);[^}]*background:\s*var\(--mx-window-band\);[^}]*box-shadow:\s*none;/s,
    "the commit form separates from the file list by a top border + darker fill");
  assert.match(themeCss,
    /\.dock-scm-commit-summary\s*\{[^}]*border:\s*1px solid var\(--mx-border\);[^}]*border-radius:\s*4px;/s,
    "Summary (required) is a real bordered single-line input");
  assert.match(themeCss,
    /\.dock-scm-commit-description-box\s*\{[^}]*border:\s*1px solid var\(--mx-border\);/s,
    "Description gets its own focus container beneath it");
  assert.match(themeCss,
    /\.dock-scm-commit-description-box:focus-within\s*\{[^}]*border-color:\s*var\(--mx-focus\);/s,
    "which owns the focus affordance, exactly like .description-focus-container");
  assert.match(themeCss,
    /\.dock-scm-commit button:disabled\s*\{[^}]*color:\s*var\(--mx-text-faint\);[^}]*background:\s*var\(--mx-hover\);[^}]*box-shadow:\s*none;/s,
    "the disabled commit button RECEDES: a muted wash with faint ink");
  assert.match(themeCss,
    /\.dock-scm-commit button\s*\{[^}]*color:\s*var\(--mx-grey-50\);[^}]*background:\s*var\(--mx-accent-bg\);/s,
    "and the enabled one carries the accent, never a saturated grey block");
  assert.doesNotMatch(themeCss,
    /\.dock-scm-commit button\s*\{[^}]*background:\s*var\(--mx-bg-contrast\);/s,
    "the heavy contrast fill is gone from both states");
  assert.match(themeCss,
    /\.dock-scm-commit-split > button:first-child\s*\{[^}]*flex:\s*1 1 auto;/s,
    "and it spans the form's full width (_commit-message.scss:321-334)");
  // Search and Source Control use the exact same field component; the SCM
  // surface must not re-style its fill or focus treatment.
  assert.doesNotMatch(themeCss,
    /\.dock-scm-search\.workbench-search-input(?::focus-within)?\s*\{/s,
    "the dock search must not override the shared search-box grammar");
  // ONE component grammar: height, insets, icon box and clear button are
  // declared once on .workbench-search-input, never per panel.
  assert.match(themeCss,
    /\.workbench-search-input \{[^}]*height:\s*28px;[^}]*gap:\s*5px;[^}]*padding:\s*0 3px 0 7px;[^}]*border:\s*1px solid var\(--mx-border\);/s,
    "the Search pane's box IS the shared box: one height, one inset, one hairline");
  assert.match(themeCss,
    /\.workbench-search-input > svg \{[^}]*flex:\s*0 0 14px;/s,
    "with one fixed 14px leading glyph in every panel");
  assert.match(themeCss,
    /\.workbench-search-input button \{[^}]*width:\s*20px;[^}]*height:\s*20px;/s,
    "and one clear-button box");
  assert.match(themeCss,
    /@container \(max-width:\s*420px\)\s*\{\s*\.dock-scm-remote-target\s*\{\s*display:\s*none;/s,
    "the narrow dock drops the remote NAME first");
  assert.match(themeCss,
    /@container \(max-width:\s*340px\)\s*\{[\s\S]*?\.dock-scm-ahead-behind > span > svg\s*\{\s*display:\s*none;/s,
    "then the badge's direction ARROWS — the counts themselves never go");
  assert.match(themeCss,
    /@container \(max-width:\s*260px\)\s*\{\s*\.dock-scm-remote-label\s*\{\s*display:\s*none;/s,
    "and only far below the product floor does the VERB go — icon-only is the"
    + " last resort, not the dock's normal state, and no label is ever stubbed");
  // All three toolbar sections split the width EVENLY (user: 1:1:1), with the
  // same floor, so the push/pull section is never an intrinsic-width stub.
  for (const section of ["project", "branch", "remote"]) {
    assert.match(themeCss,
      new RegExp(`\\.dock-scm-toolbar-${section}\\s*\\{[^}]*flex:\\s*1 1 0;[^}]*min-width:\\s*76px;`, "s"),
      `the ${section} toolbar section is an equal third with the shared floor`);
  }
  assert.match(themeCss, /\.dock-scm-ahead-behind\s*\{[^}]*flex:\s*0 0 auto;/s,
    "icon + ahead/behind badge never shrink");
  assert.doesNotMatch(themeCss,
    /\.dock-scm-(?:branch|sync|push|selection|file-select|stash-row|stash-main|stash-actions|commit-dot|surface-switch|pr|pr-panel|pr-copy)\b(?!-)/,
    "legacy branch/sync/stash/multi-select/create-PR rules are gone; only the menu-launched picker anchor remains");
  assert.doesNotMatch(themeCss, /\.dock-scm-view-switch\s*\{/,
    "Source Control Graph is a title action rather than a card-style segmented switch");
  assert.match(themeCss, /\.utility-dock-header-actions\s*\{[^}]*display:\s*flex;/s);
  assert.doesNotMatch(themeCss, /\.dock-scm-repositories\s*\{/,
    "Git surfaces use one quiet project/branch context row instead of a repository pane");
  assert.match(themeCss,
    /\.dock-scm-group-toggle > span\s*\{[^}]*background:\s*transparent;[^}]*font-weight:\s*400;/s,
    "SCM and PR counts remain plain section metadata rather than custom pills");
  assert.match(themeCss,
    /\.dock-scm-commit\s*\{\s*position:\s*relative;/s,
    "the commit composer stays compact without creating a second panel frame");
  assert.match(themeCss,
    /\.dock-terminal \.xterm-viewport::-webkit-scrollbar-button\s*\{[^}]*display:\s*none;[^}]*width:\s*0;[^}]*height:\s*0;/s);
  assert.match(themeCss,
    /\.workspace-tab\s*\{[^}]*height:\s*35px;[^}]*min-width:\s*var\(--workspace-tab-current-width,\s*50px\);[^}]*max-width:\s*var\(--workspace-tab-current-width,\s*160px\);[^}]*flex:\s*1 0 0;/s);
  assert.match(themeCss,
    /\.workspace-tab:not\(:first-child\) > \.workspace-tab-main\s*\{[^}]*padding-left:\s*4px;/s);
  assert.match(themeCss,
    /\.workspace-tab-main > svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*flex:\s*0 0 14px;[^}]*color:\s*currentColor;[^}]*stroke-width:\s*1\.75px;/s);
  assert.doesNotMatch(themeCss,
    /\.sidebar-nav-icon svg\.lucide,[^}]*\.workspace-tab-main > svg\.lucide,[^}]*stroke-width:\s*1\.25px;/s);
  assert.match(themeCss, /\.transcript\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(themeCss, /\.desktop-body\s*\{[^}]*gap:\s*0;[^}]*padding:\s*0;/s);
  assert.match(themeCss,
    /\.desktop-body\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(themeCss,
    /\.main-panel\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s);
  assert.doesNotMatch(themeCss, /\.sidebar-collapsed \.desktop-body\s*\{[^}]*gap:/s);
  assert.match(themeCss,
    /\.desktop-body > \.utility-dock\[data-side="right"\]\s*\{[^}]*margin-left:\s*0;/s);
  assert.match(themeCss, /\.session-header\s*\{[^}]*border-bottom:\s*0;/s);
  assert.match(themeCss, /\.session-header-content\s*\{[^}]*padding:\s*12px 36px;/s);
  // Conversation title runs one step above tab chrome (user: important info
  // read underweighted at 14px/500).
  assert.match(themeCss, /\.session-header h1\s*\{[^}]*font-size:\s*15px;[^}]*font-weight:\s*600;[^}]*line-height:\s*22px;/s);
  assert.match(themeCss,
    /\.thread\s*\{[^}]*padding:\s*20px calc\(36px - var\(--mx-scrollbar-size\)\) 20px 36px;[^}]*gap:\s*20px;/s);
  assert.doesNotMatch(themeCss, /\.conversation:has\(\.turn-review-bar\) \.thread/);
  assert.match(themeCss, /\.turn-review-slot\s*\{[^}]*position:\s*relative;[^}]*width:\s*100%;/s);
  assert.doesNotMatch(themeCss, /\.turn-review-slot\s*\{[^}]*position:\s*absolute;/s);
  assert.match(themeCss, /\.turn-review-slot:has\(\.turn-review-bar\)\s*\{[^}]*margin-bottom:\s*8px;/s);
  assert.match(themeCss, /\.turn-review-summary\s*\{[^}]*min-height:\s*28px;/s);
  assert.match(themeCss, /\.composer-region\s*\{[^}]*padding:\s*0 32px 8px;/s);
  assert.match(themeCss, /\.toolbar-sidebar\s*\{[^}]*width:\s*36px;/s);
  assert.match(themeCss, /\.activity-rail > button\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
  assert.doesNotMatch(themeCss, /\.workspace-tab-divider\s*\{/);
  // VS Code grammar: inactive tabs hide the close glyph until hover.
  assert.match(baseCss, /\.workspace-tab-close\s*\{[^}]*opacity:\s*0;/s);
  assert.match(themeCss,
    /\.workspace-tab-main span\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;/s);
  assert.match(themeCss,
    /\.workspace-tab-close\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--mx-text\) 92%,\s*transparent\);/s);
  assert.doesNotMatch(themeCss,
    /animation:\s*utility-dock-in\b/,
    'dock mount must commit final width instantly (VS Code grammar)');
  assert.match(themeCss,
    /\.utility-dock--persistent\s*\{[^}]*min-width:\s*0;[^}]*transition:\s*none;/s);
  assert.match(themeCss,
    /\.utility-dock\.closing\s*\{[^}]*margin-left:\s*0;[^}]*transition:\s*none;/s);
  assert.match(themeCss,
    /\.utility-dock-body\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;[^}]*padding:\s*0;[^}]*contain:\s*paint;/s);
  assert.match(themeCss,
    /\.utility-dock-pane\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/s);
  assert.match(themeCss,
    /\.stable-surface-layer\[data-surface-active="true"\]\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
  assert.doesNotMatch(themeCss, /\.utility-dock-pane\[hidden\]/);
  assert.doesNotMatch(themeCss, /\.utility-dock-body\[data-tab="source-control"\]/);
  assert.doesNotMatch(themeCss,
    /@keyframes utility-dock-in\s*\{[\s\S]*?from\s*\{[^}]*opacity:/s);
  assert.doesNotMatch(themeCss,
    /(?:^|\r?\n)\.utility-dock\.closing\s*\{[^}]*opacity(?:\s*:| var\(--mx-side-panel-motion\))/s);
  // Background tabs keep short separators without boxing the selected tab.
  assert.match(themeCss,
    /\.workspace-tab:not\(\.active\)::before\s*\{[^}]*top:\s*8px;[^}]*bottom:\s*8px;[^}]*width:\s*1px;[^}]*background:\s*var\(--mx-border-muted\);/s);
  assert.doesNotMatch(themeCss,
    /\.workspace-tab\s*\{[^}]*border-right:\s*1px solid var\(--mx-border-muted\);/s);
  assert.match(themeCss,
    // The action replaces the unread dot in place while remaining one pixel
    // farther from the scrollbar than the unsafe right:2px position.
    /\.session-row-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*3px;[^}]*background:\s*transparent;/s);
  assert.match(themeCss,
    /\.session-row:hover \.session-row-actions,[\s\S]*?\{[^}]*background:\s*linear-gradient\([\s\S]*?transparent 0,[\s\S]*?var\(--session-row-action-surface\) 10px,[\s\S]*?var\(--session-row-action-surface\) 100%[\s\S]*?\);[^}]*pointer-events:\s*auto;/s);
  // Selected rows must NOT pin the … actions open — they reveal on hover,
  // keyboard focus, or an open menu only (user-flagged persistent ellipsis).
  assert.doesNotMatch(themeCss, /\.session-row\.selected \.session-row-action,/s);
  assert.doesNotMatch(themeCss, /\.session-row\.selected \.session-row-actions,/s);
  assert.match(themeCss,
    /\.session-sidebar \.session-row:hover\s*\{[^}]*--session-row-action-surface:\s*var\(--mx-bg-layer-1\);/s);
  assert.match(themeCss,
    /\.session-sidebar \.session-row\.selected\s*\{[^}]*--session-row-action-surface:\s*var\(--mx-bg-layer-2\);/s);
  assert.doesNotMatch(themeCss, /\.session-row-actions::before/);
  assert.match(themeCss,
    /\.session-row-action\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
  // Grok-web recent rows are plain text — the per-row icon rule is gone.
  assert.doesNotMatch(themeCss, /\.session-row-icon\s*\{/);
  assert.match(themeCss,
    /\.workspace-tabs-shell\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*flex:\s*1 1 0;[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(themeCss,
    /\.workspace-tab\s*\{[^}]*min-width:\s*var\(--workspace-tab-current-width,\s*50px\);[^}]*max-width:\s*var\(--workspace-tab-current-width,\s*160px\);[^}]*flex:\s*1 0 0;/s);
  assert.match(themeCss,
    /\.projects-common-instructions\s*\{[^}]*margin-bottom:\s*16px;/s);
  assert.doesNotMatch(themeCss, /\.dock-file-row\.selected\s*\{/s);
  assert.match(themeCss,
    /\.dock-file-row\.explorer-selected\s*\{[^}]*background-color:\s*color-mix\(in srgb,\s*var\(--mx-focus\)\s*10%,\s*transparent\);/s);
  assert.match(themeCss,
    /\.activity-rail\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(themeCss,
    /\.topbar \.titlebar-update\s*\{[^}]*color:\s*var\(--mx-text-accent\);/s);
  assert.match(themeCss,
    /\.topbar \.titlebar-update::before\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*border-radius:\s*999px;[^}]*transform:\s*translate\(-50%,\s*-50%\);/s);
  assert.doesNotMatch(themeCss, /\.activity-rail \.sidebar-update-button\s*\{/);
  assert.doesNotMatch(themeCss, /\.workspace-tabs-fade/,
    "tab-strip fades must not cover the leading or trailing tab content");

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
  // Stored widths within the clamp range are honored verbatim.
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
  const primaryNav = sidebar.querySelector(".session-sidebar-scroll");
  assert.equal(resize.getAttribute("aria-valuenow"), "286");
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true, button: 0, clientX: 286,
  })));
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointermove", {
    bubbles: true, clientX: 300,
  })));
  assert.equal(sidebar.style.getPropertyValue("--session-sidebar-width"), "300px",
    "pointer movement must resize the sidebar before React commits persistent state");
  assert.equal(window.localStorage.getItem("mixdog:session-sidebar-width"), "286",
    "pointer movement must not write storage on every frame");
  await act(async () => resize.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true })));
  assert.equal(resize.getAttribute("aria-valuenow"), "300");
  assert.equal(sidebar.style.getPropertyValue("--session-sidebar-width"), "300px");
  assert.equal(sidebar.style.getPropertyValue("--session-sidebar-min-width"), "232px");
  assert.equal(sidebar.style.getPropertyValue("--session-sidebar-max-width"), "420px");
  assert.equal(sidebar.style.maxWidth, "420px");
  assert.equal(sidebar.style.flexShrink, "0");
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
  // Collapsed sidebars hide their content (inert, aria-hidden, zero width)
  // rather than destroying the visited destinations' DOM and state.
  assert.equal(document.querySelector(".sidebar")?.dataset.state, "closed",
    "collapsed sidebars must hide their content");
  assert.equal(document.querySelector(".sidebar")?.hasAttribute("inert"), true);
  assert.equal(document.querySelector(".sidebar")?.getAttribute("aria-hidden"), "true");
  assert.equal(toggle?.getAttribute("aria-label"), "Expand session sidebar");
  await act(async () => toggle?.click());
  const reopenedSidebar = document.querySelector(".sidebar");
  assert.equal(shell?.classList.contains("sidebar-collapsed"), false);
  assert.equal(reopenedSidebar?.getAttribute("aria-hidden"), "false");
  // Symmetry with the collapse above: the tree was hidden, never destroyed,
  // so reopening restores the SAME content nodes (with their state) and only
  // lifts the inert/aria-hidden shield off them.
  assert.equal(reopenedSidebar?.dataset.state, "open");
  assert.equal(reopenedSidebar?.hasAttribute("inert"), false,
    "reopening must return the preserved tree to the tab order");
  assert.equal(reopenedSidebar?.querySelector(".session-sidebar-scroll"), primaryNav,
    "reopening the sidebar must reuse its preserved visible content tree");
  assert.equal(toggle?.getAttribute("aria-label"), "Collapse session sidebar");
});

test("Explorer keeps one selection while active editor tabs and folders change", async () => {
  installDom();
  const projectPath = "C:\\work\\sample";
  const opened = [];
  const resized = [];
  const listedProjects = [];
  window.mixdogDesktop = {
    listProjectDir: async (project, rel) => {
      listedProjects.push(project);
      return rel ? [] : [
      { name: "folder", dir: true },
      { name: "one.ts", dir: false },
      { name: "two.ts", dir: false },
      ];
    },
  };
  const props = {
    open: true,
    width: 380,
    tab: "files",
    onTab() {},
    onResize(value) { resized.push(value); },
    snapshot: { currentProject: projectPath, items: [] },
    workspaceFolders: [
      { path: projectPath },
      { path: "C:\\work\\other" },
    ],
    onOpenFile(project, rel) { opened.push([project, rel]); },
  };
  await act(async () => {
    root.render(React.createElement(UtilityDock, {
      ...props,
      activeFileKey: `file:${projectPath}:one.ts`,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const first = document.querySelector('.dock-file-row[title="one.ts"]');
  const second = document.querySelector('.dock-file-row[title="two.ts"]');
  const dockTabs = document.querySelector(".utility-dock-tabs");
  const filesSurface = document.querySelector(".dock-files");
  const tabsHeader = document.querySelector(".utility-dock-tabs-header");
  const panelHeader = document.querySelector('.utility-dock-pane[data-tab="files"] > .utility-dock-header');
  assert.equal(dockTabs?.parentElement, tabsHeader,
    "Orca-style icon tabs must own the top activity row");
  assert.equal(tabsHeader?.nextElementSibling?.classList.contains("utility-dock-body"), true);
  assert.equal(panelHeader?.parentElement?.dataset.tab, "files",
    "the project toolbar and Files content must switch as one atomic layer");
  assert.equal(panelHeader?.querySelector(".utility-dock-title")?.textContent, "Explorer");
  assert.match(document.querySelector(".dock-project-select")?.textContent || "", /sample/i);
  for (const label of ["New file", "New folder", "Refresh files", "Collapse all folders"]) {
    assert.equal(document.querySelector(`[aria-label="${label}"] svg`)?.getAttribute("width"), "16",
      `${label} must stay legible in the Explorer title row`);
  }
  assert.ok(document.querySelector('[aria-label="Collapse all folders"]'));
  assert.ok(document.querySelector('[aria-label="Refresh files"]'));
  assert.equal(document.querySelector('[aria-label="More file actions"]'), null,
    "the header overflow menu is gone — reveal/copy live on the root right-click menu");
  assert.equal(document.querySelector(".utility-dock-close"), null,
    "the global toolbar owns Dock close; the inner tab strip must not duplicate it");
  assert.equal(document.querySelector(".dock-source-control"), null,
    "unvisited Dock surfaces must not allocate hidden trees");
  assert.deepEqual([...new Set(listedProjects)], [projectPath],
    "Files must browse the selected Project only, even if legacy workspace folders are supplied");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workbench-search-mode button"))
      .map((button) => [button.textContent, button.getAttribute("aria-selected")]),
    [["Names", "true"], ["Contents", "false"]],
  );
  assert.equal(document.querySelector(".workbench-search-filters"), null);
  await act(async () => Array.from(document.querySelectorAll(".workbench-search-mode button"))
    .find((button) => button.textContent === "Contents")?.click());
  assert.equal(document.querySelector('.workbench-search-mode button[aria-selected="true"]')?.textContent,
    "Contents");
  assert.equal(document.querySelector('[aria-label="Match Case"]'), null);
  assert.equal(document.querySelector('[aria-label="Toggle search details"]'), null);
  assert.equal(document.querySelector(".workbench-search-filters"), null,
    "Files search stays a plain name/text query without wildcard details");
  assert.equal(first?.classList.contains("explorer-selected"), true);
  assert.equal(first?.getAttribute("aria-selected"), "true");
  assert.equal(first?.getAttribute("aria-current"), null);
  assert.equal(second?.classList.contains("explorer-selected"), false);
  await act(async () => first?.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "F2", bubbles: true, cancelable: true,
  })));
  const renameInput = document.querySelector(".explorer-edit-box input");
  assert.deepEqual([renameInput?.selectionStart, renameInput?.selectionEnd], [0, 3]);
  await act(async () => renameInput?.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "F2", bubbles: true, cancelable: true,
  })));
  assert.deepEqual([renameInput?.selectionStart, renameInput?.selectionEnd], [0, 6]);
  await act(async () => renameInput?.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "F2", bubbles: true, cancelable: true,
  })));
  assert.deepEqual([renameInput?.selectionStart, renameInput?.selectionEnd], [4, 6]);
  await act(async () => renameInput?.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "F2", bubbles: true, cancelable: true,
  })));
  assert.deepEqual([renameInput?.selectionStart, renameInput?.selectionEnd], [0, 3]);
  await act(async () => renameInput?.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  })));
  const tree = document.querySelector(".dock-files-tree");
  await act(async () => tree?.dispatchEvent(new window.MouseEvent("dblclick", {
    bubbles: true, cancelable: true,
  })));
  assert.ok(document.querySelector(".explorer-edit-box input"),
    "double-clicking Explorer whitespace starts a new file inline");
  await act(async () => document.querySelector(".explorer-edit-box input")
    ?.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
  await act(async () => second?.click());
  assert.deepEqual(opened, [[projectPath, "two.ts"]]);
  assert.equal(document.querySelector('.dock-file-row[title="one.ts"]')
    ?.classList.contains("explorer-selected"), false);
  assert.equal(document.querySelector('.dock-file-row[title="two.ts"]')
    ?.classList.contains("explorer-selected"), true);
  assert.equal(document.querySelectorAll(".dock-file-row.explorer-selected").length, 1);

  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  assert.equal(document.querySelector('.dock-file-row[title="one.ts"]')?.classList.contains("explorer-selected"), false);
  assert.equal(document.querySelector('.dock-file-row[title="two.ts"]')?.classList.contains("explorer-selected"), true,
    "switching editor tabs should move the Explorer selection");
  const folder = document.querySelector(".dock-file-row:not(.is-file)");
  await act(async () => folder?.click());
  assert.equal(folder?.classList.contains("explorer-selected"), true);
  assert.equal(document.querySelector('.dock-file-row[title="two.ts"]')
    ?.classList.contains("explorer-selected"), false,
  "selecting a folder must not leave the active file independently highlighted");
  assert.equal(document.querySelectorAll(".dock-file-row.explorer-selected").length, 1);
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    tab: "tasks",
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  // Approved persistence contract: a visited Dock tab is RETAINED (inert,
  // aria-hidden, active=false) so switching back is immediate and its tree,
  // expansion and scroll survive. Only never-opened tabs stay unmounted.
  assert.equal(document.querySelector(".dock-files"), filesSurface,
    "switching Dock tabs must retain the inactive Files tree");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="files"]')
    ?.dataset.surfaceActive, "false");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="files"]')
    ?.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="files"]')
    ?.hasAttribute("inert"), true);
  const transitioningDockTab = document.querySelector(".utility-dock-tabs-header")?.dataset.activeTab;
  const transitioningDockTitle = document.querySelector(
    '.utility-dock-pane[data-surface-active="true"] .utility-dock-title b',
  )?.textContent;
  assert.equal(transitioningDockTab, "tasks");
  assert.equal(transitioningDockTitle, "Agents",
    "warm Dock tabs must replace their header and content in the render commit");
  assert.equal(document.querySelector(".utility-dock-tabs button.active")?.getAttribute("aria-label"),
    "Agents");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="tasks"]')
    ?.dataset.surfaceActive, "true");
  assert.equal(document.querySelector(".utility-dock-tabs-header")?.dataset.activeTab, "tasks");
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-surface-active="true"] .utility-dock-title b',
  )?.textContent, "Agents");
  assert.equal(document.querySelector(".utility-dock-tabs button.active")?.getAttribute("aria-label"), "Agents");
  await act(async () => {
    root.render(React.createElement(UtilityDock, {
      ...props,
      tab: "source-control",
      activeFileKey: `file:${projectPath}:two.ts`,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const sourceControlSurface = document.querySelector(".dock-source-control");
  assert.ok(sourceControlSurface, "the selected Source Control surface mounts immediately");
  assert.equal(sourceControlSurface?.closest(".utility-dock-pane")
    ?.querySelector(".workbench-explorer"), null,
  "Source Control must never share its active layer with the Files toolbar");
  assert.equal(document.querySelector('.utility-dock-pane[data-tab="source-control"]')
    ?.hasAttribute("hidden"), false);
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  const reopenedFilesSurface = document.querySelector(".dock-files");
  assert.ok(reopenedFilesSurface);
  assert.equal(reopenedFilesSurface, filesSurface,
    "a revisited Files surface re-presents the same DOM instead of rebuilding it");
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    tab: "source-control",
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  assert.equal(document.querySelector(".dock-source-control"), sourceControlSurface,
    "a revisited Source Control surface must re-present its retained tree");
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    open: false,
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  assert.equal(document.querySelector(".utility-dock"), null);
  await act(async () => root.render(React.createElement(UtilityDock, {
    ...props,
    activeFileKey: `file:${projectPath}:two.ts`,
  })));
  assert.notEqual(document.querySelector(".utility-dock-tabs"), dockTabs,
    "utility dock toggles must remount only the visible content");
  const utilityDock = document.querySelector(".utility-dock");
  assert.equal(utilityDock?.style.getPropertyValue("--utility-dock-width"), "380px");
  assert.equal(utilityDock?.style.getPropertyValue("--utility-dock-min-width"), "300px");
  assert.equal(utilityDock?.style.getPropertyValue("--utility-dock-max-width"), "560px");
  assert.equal(utilityDock?.style.minWidth, "300px");
  assert.equal(utilityDock?.style.maxWidth, "560px");
  assert.equal(utilityDock?.style.flexShrink, "1",
    "the preferred Dock width must yield to the viewport down to its 300px floor");
  assert.equal(utilityDock?.style.marginLeft, "");
  assert.equal(utilityDock?.hasAttribute("data-overlaying"), false,
    "responsive width must not be simulated by painting over the workspace");
  const dockResize = document.querySelector('[aria-label="Resize utility panel"]');
  await act(async () => dockResize?.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true, button: 0, clientX: 400,
  })));
  await act(async () => window.dispatchEvent(new window.MouseEvent("pointermove", {
    bubbles: true, clientX: 360,
  })));
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(resolve)));
  assert.equal(utilityDock?.style.getPropertyValue("--utility-dock-width"), "420px",
    "pointer movement must resize the dock on the next paint frame");
  assert.deepEqual(resized, [], "dock persistence must not rerender the app on every pointer frame");
  await act(async () => window.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true })));
  assert.deepEqual(resized, [420], "dock width commits once when the gesture ends");
});

test("an empty Agents dock does not schedule an elapsed clock", async () => {
  installDom();
  const intervals = [];
  const nativeSetInterval = window.setInterval.bind(window);
  window.setInterval = (callback, delay, ...args) => {
    intervals.push(delay);
    return nativeSetInterval(callback, delay, ...args);
  };
  await act(async () => root.render(React.createElement(UtilityDock, {
    open: true,
    width: 380,
    tab: "tasks",
    onTab() {},
    onResize() {},
    snapshot: { items: [], queued: [] },
    agentSessions: [],
  })));
  assert.equal(intervals.includes(1_000), false,
    "the selected Agents pane must stay idle when no agent is visible");
  assert.equal(document.querySelectorAll(".utility-dock-pane").length, 1);
  assert.equal(document.querySelector(".dock-files"), null);
  assert.equal(document.querySelector(".dock-source-control"), null);
});

test("Agents replaces the visible Tasks surface while preserving Dock state", async () => {
  installDom();
  window.localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify({
    open: true,
    tab: "agents",
    width: 420,
  }));
  assert.deepEqual(readDockState(), { open: true, tab: "tasks", width: 420 });
  window.localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify({
    open: true,
    tab: "terminal",
    width: 420,
  }));
  assert.deepEqual(readDockState(), { open: true, tab: "tasks", width: 420 },
    "the removed Dock terminal migrates to Tasks");
  window.localStorage.setItem("mixdog.desktop-utility-dock.v1", JSON.stringify({
    open: true,
    tab: "source-control",
    width: 420,
  }));
  assert.deepEqual(readDockState(), { open: true, tab: "source-control", width: 420 },
    "a valid last-selected Dock tab survives an app restart");
  await act(async () => root.render(React.createElement(UtilityDock, {
    open: true,
    width: 380,
    tab: "tasks",
    onTab() {},
    onResize() {},
    snapshot: { activeTools: { explore: { count: 2 } }, items: [] },
    agentSessions: [],
  })));
  assert.equal(document.querySelector(".utility-dock-tabs button.active")?.getAttribute("aria-label"), "Agents");
  // Orca-style icon strip: labels live on aria/tooltip, the active pane's
  // title renders in the header row below the icons.
  assert.deepEqual(
    Array.from(document.querySelectorAll(".utility-dock-tabs button")).map((button) => button.getAttribute("aria-label")),
    // Final cleanup (user): debug/outline/tests left the product and the
    // standalone Search surface folded into the Files Explorer tab.
    ["Agents", "Explorer", "Source Control", "GitHub Pull Requests"],
  );
  assert.equal(document.querySelector(".utility-dock-header")?.textContent, "Agents");
  assert.match(document.querySelector(".agent-activity-empty")?.textContent || "", /No agents are running/);
  assert.equal(document.querySelector(".dock-task-row"), null,
    "generic tool tasks must not remain in the Agents surface");
});

test("Source Control dock matches GitHub Desktop's toolbar, changes list, and commit form", async () => {
  installDom();
  const projectPath = "C:\\work\\sample";
  const calls = [];
  const openedDiffs = [];
  window.mixdogDesktop = {
    listProjects: async () => [
      { path: projectPath, name: "sample", alias: "" },
      { path: "C:\\work\\other", name: "other", alias: "" },
    ],
    gitStatus: async () => ({
      repository: true,
      branch: "main",
      detached: false,
      unborn: false,
      upstream: true,
      upstreamName: "origin/main",
      remote: true,
      ahead: 1,
      behind: 2,
      operation: "",
      files: [
        { path: "src/staged.ts", index: "M", worktree: " ", untracked: false, conflicted: false,
          stagedAdditions: 2, stagedDeletions: 1, unstagedAdditions: 0, unstagedDeletions: 0, additions: 2, deletions: 1 },
        { path: "src/change.ts", index: " ", worktree: "M", untracked: false, conflicted: false,
          stagedAdditions: 0, stagedDeletions: 0, unstagedAdditions: 1, unstagedDeletions: 0, additions: 1, deletions: 0 },
        { path: "generated/cache.txt", index: "?", worktree: "?", untracked: true, conflicted: false,
          stagedAdditions: 0, stagedDeletions: 0, unstagedAdditions: 1, unstagedDeletions: 0, additions: 1, deletions: 0 },
      ],
    }),
    gitBranches: async () => [
      { name: "main", current: true, remote: false, upstream: "origin/main" },
      { name: "feature/local", current: false, remote: false, upstream: "" },
      { name: "origin/review", current: false, remote: true, upstream: "" },
    ],
    gitCheckoutBranch: async (_cwd, branch, remote) => {
      calls.push(["checkout-branch", branch, remote]);
      return "";
    },
    gitCreateBranch: async (_cwd, branch) => {
      calls.push(["create-branch", branch]);
      return "";
    },
    gitRenameBranch: async (_cwd, branch, nextBranch) => {
      calls.push(["rename-branch", branch, nextBranch]);
      return "";
    },
    gitDeleteBranch: async (_cwd, branch) => {
      calls.push(["delete-branch", branch]);
      return "";
    },
    gitLog: async () => [{
      hash: "abcdef123456",
      shortHash: "abcdef1",
      subject: "Ship source control",
      when: "now",
      author: "Mixdog",
      authoredAt: "2026-07-30T00:00:00.000Z",
      pushed: false,
      parents: ["1234567890"],
      refs: ["main"],
    }],
    gitStage: async (_cwd, paths) => { calls.push(["stage", paths]); },
    gitUnstage: async (_cwd, paths) => { calls.push(["unstage", paths]); },
    gitIgnore: async (_cwd, path) => { calls.push(["ignore", path]); },
    gitCommit: async (_cwd, message) => { calls.push(["commit", message]); return ""; },
    gitAmend: async (_cwd, message) => { calls.push(["amend", message]); return ""; },
    gitUndoLastCommit: async () => { calls.push(["undo-commit"]); return ""; },
    gitStash: async (_cwd, message) => { calls.push(["stash", message]); return ""; },
    gitStashPop: async () => { calls.push(["stash-pop"]); return ""; },
    gitPush: async () => { calls.push(["push"]); return ""; },
    gitFetch: async () => { calls.push(["fetch"]); return ""; },
    gitPull: async () => { calls.push(["pull"]); return ""; },
    gitSync: async () => { calls.push(["sync"]); return ""; },
    gitRevert: async (_cwd, path, untracked, mode) => { calls.push(["revert", path, untracked, mode]); },
    revealFile: async (_cwd, path) => { calls.push(["reveal", path]); },
    gitShow: async (_cwd, hash) => {
      calls.push(["show", hash]);
      return {
        hash,
        shortHash: "abcdef1",
        subject: "Ship source control",
        author: "Mixdog",
        email: "mixdog@example.com",
        authoredAt: "2026-07-30T00:00:00.000Z",
        parents: ["1234567890"],
        files: [{ path: "src/change.ts", status: "M", additions: 1, deletions: 0 }],
      };
    },
    gitShowDiff: async (_cwd, hash, path) => {
      calls.push(["show-diff", hash, path]);
      return "Binary files differ";
    },
  };
  window.confirm = () => true;
  window.prompt = (message) => {
    if (message === "New branch name") return "feature/new";
    if (message.startsWith("Stash message")) return "work in progress";
    if (message.startsWith("New commit message")) return "Amended commit";
    return null;
  };
  await act(async () => {
    root.render(React.createElement(UtilityDock, {
      open: true,
      width: 380,
      tab: "source-control",
      onTab() {},
      onResize() {},
      snapshot: { currentProject: projectPath, items: [] },
      onOpenDiff: (project, rel, request) => openedDiffs.push([project, rel, request]),
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector(
    '.utility-dock-pane[data-tab="source-control"] [data-panel-header="source-control"] .utility-dock-title b',
  )?.textContent, "Source Control");
  // The dock's project picker is the toolbar's repository section now
  // (GitHub Desktop: repository | branch | push-pull, above the tab row).
  assert.ok(document.querySelector(
    '.utility-dock-pane[data-tab="source-control"] .dock-scm-toolbar-project [aria-label="Switch project"]',
  ));
  assert.equal(document.querySelector(".dock-scm-repositories"), null);
  assert.equal(document.querySelector('[aria-label="Pull"]'), null,
    "the header's separate Pull button gave way to the morphing toolbar button");
  assert.equal(document.querySelector('[aria-label="Push"]'), null,
    "the header's separate Push button gave way to the morphing toolbar button");
  assert.equal(document.querySelector(".dock-scm-branch-button span")?.textContent, "main",
    "the toolbar carries the current branch dropdown");
  assert.equal(document.querySelector(".dock-scm-remote-button > span")?.textContent, "Pull origin",
    "behind > 0 lands on the ladder's Pull rung (push-pull-button.tsx:491-501)");
  assert.equal(document.querySelector(".dock-scm-ahead-behind")?.textContent, "12",
    "the badge shows 1 ahead and 2 behind");
  const reviewSwitch = document.querySelector('[role="radiogroup"][aria-label="Changes or history"]');
  assert.ok(reviewSwitch,
    "Changes/History stays a segmented selector so the history surface is reachable");
  assert.deepEqual(
    [...reviewSwitch.querySelectorAll('[role="radio"]')].map((radio) => radio.dataset.reviewOption),
    ["changes", "history"],
    "the segmented selector exposes both review surfaces as radio options");
  assert.equal(
    reviewSwitch.querySelector('[data-review-option="changes"] .dock-review-count')?.textContent,
    "3", "the Changes option carries the changed-file count badge");
  assert.equal(document.querySelector(".dock-scm-group"), null,
    "one flat changed-files list replaces the staged/unstaged/merge groups");
  assert.equal(document.querySelectorAll(".dock-scm-file-check").length, 3,
    "every changed file row owns an include-in-commit checkbox");
  assert.equal(document.querySelector(".dock-scm-check-all > span")?.textContent,
    "3 changed files");
  assert.ok(document.querySelector(
    '.dock-scm-search.workbench-search-input'
    + ' input[aria-label="Filter changed files"]'),
    "the changes list keeps its filter box, in the shared search-box grammar");
  assert.ok(document.querySelector(".dock-scm-file-state"),
    "rows expose a quiet status glyph");
  assert.ok(document.querySelector(".dock-scm-file-copy > small"),
    "rows expose their directory as dim leading metadata");
  await act(async () => {
    // Branch checkout/creation live in the toolbar dropdown; the panel
    // header's "…" overflow menu that used to duplicate them is gone.
    document.querySelector(".dock-scm-branch-button")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector('[aria-label="More source control actions"]'), null,
    "the panel header's overflow menu is deleted");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".dock-scm-branch-list h3")).map((element) => element.textContent),
    // branch-list.tsx:378-398 grouping.
    ["Default branch", "Other branches"],
  );
  assert.equal(document.querySelector(".dock-scm-merge-row")?.textContent,
    "Choose a branch to merge into main",
    "the branch panel closes with the reference's merge row");
  await act(async () => {
    document.querySelector(".dock-scm-branch-new")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) => entry[0] === "create-branch" && entry[1] === "feature/new"));
  await act(async () => {
    document.querySelector(".dock-scm-branch-button")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    Array.from(document.querySelectorAll(".dock-scm-branch-main"))
      .find((button) => button.textContent.includes("feature/local"))?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) =>
    entry[0] === "checkout-branch" && entry[1] === "feature/local" && entry[2] === false));
  // The panel header carries exactly ONE Source Control action: the
  // always-available Fetch, portaled into the title row's action slot. The
  // toolbar's third section only OFFERS Fetch on a level branch (it is Pull
  // here), so this is the fetch that is always reachable.
  const headerActions = document.querySelector(
    '.utility-dock-pane[data-tab="source-control"]'
    + ' [data-panel-header="source-control"] .utility-dock-header-actions');
  assert.ok(headerActions, "the title row exposes its action slot");
  const headerFetch = headerActions.querySelector(".dock-scm-header-fetch");
  assert.ok(headerFetch, "which hosts the always-available Fetch");
  assert.equal(headerFetch.tagName, "BUTTON", "as a real, keyboard-reachable button");
  assert.equal(headerFetch.getAttribute("aria-label"), "Fetch from origin",
    "with an accessible name of its own, distinct from the toolbar rung's");
  assert.equal(headerFetch.disabled, false,
    "a repository with a remote can always fetch");
  assert.equal(headerActions.querySelectorAll("button").length, 1,
    "and it is the header's only action — no '…' overflow menu returns with it");
  const headerFetchFrom = calls.length;
  await act(async () => {
    headerFetch.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.slice(headerFetchFrom), [["fetch"]],
    "and it really fetches from the remote, without touching anything else");
  const remoteSection = document.querySelector(".dock-scm-toolbar-remote");
  assert.ok(remoteSection?.classList.contains("dock-scm-toolbar-section"),
    "the remote action is a full toolbar SECTION, not a pinned icon");
  assert.equal(remoteSection.querySelector(".dock-scm-remote-verb")?.textContent, "Pull",
    "and it shows its TEXT label at the dock's normal width");
  await act(async () => {
    remoteSection.querySelector(".dock-scm-remote-button").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) => entry[0] === "pull"), "and it really runs its rung");
  assert.equal(document.querySelector(".dock-scm-header"), null,
    "Source Control controls should share the Utility Dock title row");
  assert.equal(document.querySelector(".dock-scm-view-switch"), null,
    "the Graph view must not render as a segmented card control");
  assert.match(document.querySelector(".dock-scm-commit-button")?.textContent || "",
    /^Commit 3 files to main$/,
    "the commit button names the selection and the branch");
  assert.equal(document.querySelector(
    '.dock-scm-file-main[title="src/staged.ts"] .dock-scm-file-name',
  )?.textContent, "staged.ts");
  assert.equal(document.querySelector(
    '.dock-scm-file-main[title="src/change.ts"] .dock-scm-file-name',
  )?.textContent, "change.ts");
  await act(async () => document.querySelector(
    '.dock-scm-file-main[title="src/change.ts"]',
  )?.click());
  assert.deepEqual(openedDiffs.at(-1), [
    projectPath,
    "src/change.ts",
    { source: "unstaged" },
  ]);
  // A file the index already carries alone still opens its staged diff — the
  // only place the index survives, and never as a user-facing concept.
  await act(async () => document.querySelector(
    '.dock-scm-file-main[title="src/staged.ts"]',
  )?.click());
  assert.deepEqual(openedDiffs.at(-1), [
    projectPath,
    "src/staged.ts",
    { source: "staged" },
  ]);
  await act(async () => {
    // Discard All is a `N changed files` header action now.
    document.querySelector('.dock-scm-check-all [aria-label="Discard All"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) =>
    entry[0] === "revert" && entry[1] === "src/change.ts" && entry[3] === "worktree"));

  await act(async () => {
    document.querySelector('[aria-label="Discard changes src/change.ts"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) =>
    entry[0] === "revert" && entry[1] === "src/change.ts" && entry[3] === "worktree"));

  await act(async () => {
    // The per-row "…" button is gone: the row answers the right button.
    document.querySelector('.dock-scm-file-main[title="generated/cache.txt"]')
      ?.closest(".dock-scm-file")
      ?.dispatchEvent(new window.MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: 100, clientY: 200,
      }));
    await Promise.resolve();
    Array.from(document.querySelectorAll(".dock-scm-context-menu button"))
      .find((button) => button.textContent === "Ignore file (add to .gitignore)")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) => entry[0] === "ignore" && entry[1] === "generated/cache.txt"));
  assert.equal(document.querySelector('[aria-label="More actions for generated/cache.txt"]'), null,
    "no per-row overflow trigger survives");

  // Checkbox selection drives the commit: the unchecked file is unstaged and
  // the checked ones are staged right before `git commit`.
  await act(async () => {
    document.querySelector(
      '.dock-scm-file-check[aria-label="Include generated/cache.txt in the commit"]',
    )?.click();
    await Promise.resolve();
  });
  assert.match(document.querySelector(".dock-scm-commit-button")?.textContent || "",
    /^Commit 2 files to main$/);
  const summaryField = document.querySelector('.dock-scm-commit input[aria-label="Summary"]');
  const summarySetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const descriptionField = document.querySelector('.dock-scm-commit textarea[aria-label="Description"]');
  const descriptionSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    summarySetter?.call(summaryField, "Commit selected work");
    summaryField?.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "Commit selected work",
    }));
    await Promise.resolve();
  });
  await act(async () => {
    descriptionSetter?.call(descriptionField, "Body line");
    descriptionField?.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "Body line",
    }));
    await Promise.resolve();
  });
  const commitCallIndex = calls.length;
  await act(async () => {
    document.querySelector('.dock-scm-commit button[type="submit"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.deepEqual(
    calls.slice(commitCallIndex).map((entry) => entry[0]),
    ["stage", "commit"],
    "the checked paths are staged from a fresh index read, then the commit runs —"
    + " an unchecked path git never staged is left alone instead of being reset",
  );
  assert.deepEqual(calls[commitCallIndex][1].slice().sort(), ["src/change.ts", "src/staged.ts"]);
  assert.ok(calls.some((entry) =>
    entry[0] === "commit" && entry[1] === "Commit selected work\n\nBody line"),
    "the commit message is summary, blank line, description");
  assert.ok(calls.every((entry) =>
    !(entry[0] === "unstage" && entry[1].includes("generated/cache.txt"))),
    "an untracked, unchecked file is never handed to git reset");

  // The commit split menu is DELETED: the commit button is one action, and
  // everything the menu carried moved to the surface that owns it.
  assert.equal(document.querySelector('[aria-label="More commit actions"]'), null,
    "no split chevron beside the commit button");
  assert.equal(document.querySelector(".dock-scm-commit-menu"), null);
  // Stash Changes / Pop Stash: the `N changed files` header actions.
  await act(async () => {
    document.querySelector('.dock-scm-check-all [aria-label="Stash Changes"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) => entry[0] === "stash" && entry[1] === "work in progress"));
  await act(async () => {
    document.querySelector('.dock-scm-check-all [aria-label="Pop Stash"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.ok(calls.some((entry) => entry[0] === "stash-pop"));
  // Amend still consumes the CURRENT draft, from its new home on the most
  // recent history row (commit-list.tsx:754-771).
  await act(async () => {
    const field = document.querySelector('.dock-scm-commit input[aria-label="Summary"]');
    summarySetter?.call(field, "Amended commit");
    field?.dispatchEvent(new window.InputEvent("input", {
      bubbles: true, inputType: "insertText", data: "Amended commit",
    }));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('[data-review-option="history"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  const openCommitMenu = async () => {
    await act(async () => {
      document.querySelector(".dock-scm-history .dock-scm-commit-row")
        ?.dispatchEvent(new window.MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: 120, clientY: 240,
        }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  const runCommitMenuItem = async (label) => {
    await openCommitMenu();
    const item = Array.from(document.querySelectorAll(".dock-scm-context-menu button"))
      .find((button) => button.textContent === label);
    assert.ok(item && !item.disabled, `the history row must offer ${label}`);
    await act(async () => {
      item.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  await runCommitMenuItem("Amend commit…");
  assert.ok(calls.some((entry) => entry[0] === "amend" && entry[1] === "Amended commit"));
  await runCommitMenuItem("Undo commit…");
  assert.ok(calls.some((entry) => entry[0] === "undo-commit"));
  await act(async () => {
    document.querySelector('[data-review-option="changes"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  assert.equal(document.querySelector('[data-group="stashes"]'), null);
  assert.equal(document.querySelector('[data-group="commits"]'), null);
});

test("main Git diff pane requests the exact staged source and offers editor navigation", async () => {
  installDom();
  const calls = [];
  const applied = [];
  window.mixdogDesktop = {
    gitDiff: async (...args) => {
      calls.push(args);
      return "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n"
        + "@@ -1 +1 @@\n-old\n+new\n"
        + "@@ -10 +10 @@\n-before\n+after\n";
    },
    gitApplyPatch: async (...args) => { applied.push(args); },
  };
  const opened = [];
  let ready = 0;
  await act(async () => {
    root.render(React.createElement(GitDiffPane, {
      selection: {
        kind: "diff",
        project: "C:\\work",
        rel: "src/a.ts",
        source: "staged",
      },
      active: true,
      onOpenFile: (...args) => opened.push(args),
      onReady: () => { ready += 1; },
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  await waitForDom(() => ready === 1,
    "main Git diff should settle its rich renderer before interaction");
  assert.deepEqual(calls[0], ["C:\\work", "src/a.ts", true, false, false]);
  const hunkSections = document.querySelectorAll(".workspace-git-diff-hunk");
  assert.equal(hunkSections.length, 2);
  await waitForDom(() => hunkSections[0].querySelectorAll("tr.diff-line").length > 0,
    "the first hunk should render its rich diff rows");
  // The sticky header row carries the `@@` line AND the stage control; the
  // library used to repeat that same header as an in-table hunk row.
  assert.equal(hunkSections[0].querySelector("header code")?.textContent, "@@ -1 +1 @@");
  assert.equal((hunkSections[0].textContent.match(/@@ -1 \+1 @@/g) ?? []).length, 1,
    "a hunk header renders exactly once per hunk");
  assert.equal(hunkSections[0].querySelectorAll("tr.diff-line-hunk").length, 0);
  assert.equal(hunkSections[1].querySelector("header code")?.textContent, "@@ -10 +10 @@");
  assert.equal((hunkSections[1].textContent.match(/@@ -10 \+10 @@/g) ?? []).length, 1,
    "every hunk keeps a single header, whatever its ranges");
  // Dropping the duplicate row must not disturb the diff itself.
  assert.ok(hunkSections[0].querySelector('[data-line-old-num="1"]'),
    "the removed line keeps its old-file line number");
  assert.ok(hunkSections[0].querySelector('[data-line-new-num="1"]'),
    "the added line keeps its new-file line number");
  assert.ok(hunkSections[1].querySelector('[data-line-new-num="10"]'),
    "the second hunk still starts at its declared line");
  await act(async () => {
    document.querySelector('[aria-label="Unstage hunk 1"]')?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.equal(applied[0][0], "C:\\work");
  assert.equal(applied[0][1], "src/a.ts");
  assert.match(applied[0][2], /-old[\s\S]*\+new/);
  assert.doesNotMatch(applied[0][2], /-before[\s\S]*\+after/);
  assert.equal(applied[0][3], true);
  await act(async () => document.querySelector('[aria-label="Open file src/a.ts"]')?.click());
  assert.deepEqual(opened[0], ["C:\\work", "src/a.ts"]);
});

test("workspace mouse closing mode freezes current widths until pointer leave", async () => {
  installDom();
  const closed = [];
  const tabs = Array.from({ length: 4 }, (_, index) => ({
    key: `close-${index}`,
    title: `Close ${index}`,
    selection: { kind: "session", id: `close-${index}` },
  }));
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    tabs,
    activeKey: "close-0",
    onSelectTab() {},
    onCloseTab(tab) { closed.push(tab.key); },
    onReorderTab() {},
    onNewTask() {},
  })));
  const tabNodes = Array.from(document.querySelectorAll(".workspace-tab"));
  const measuredWidths = [120, 110, 100, 90];
  for (const [index, tab] of tabNodes.entries()) {
    tab.getBoundingClientRect = () => ({ width: measuredWidths[index] });
  }

  await act(async () => tabNodes[1].querySelector(".workspace-tab-close").click());
  assert.deepEqual(closed, ["close-1"], "VS Code removes the tab without an animation timer");
  assert.deepEqual(
    tabNodes.map((tab) => tab.style.getPropertyValue("--workspace-tab-current-width")),
    ["120px", "110px", "100px", "90px"],
    "mouse close freezes each current tab width under the pointer",
  );

  await act(async () => document.querySelector(".workspace-tabs").dispatchEvent(
    new window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  ));
  assert.ok(tabNodes.every((tab) =>
    tab.style.getPropertyValue("--workspace-tab-current-width") === ""),
  "leaving the strip releases fixed widths synchronously");
});

test("workspace tabs reveal the active tab and handle scoped tab commands", async () => {
  installDom();
  const selected = [];
  const closed = [];
  const reordered = [];
  let newTasks = 0;
  const created = [];
  const scrolled = [];
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value() { scrolled.push(this); },
    configurable: true,
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    get() { return this.classList?.contains("workspace-tabs-shell") ? 800 : 0; },
    configurable: true,
  });
  const tabs = [
    { key: "one", title: "One", selection: { kind: "new" } },
    { key: "two", title: "Two", selection: { kind: "session", id: "two" } },
  ];
  const props = {
    tabs,
    activeKey: "one",
    focused: true,
    unreadSessionIds: new Set(["two"]),
    onSelectTab(tab) { selected.push(tab.key); },
    onCloseTab(tab) { closed.push(tab.key); },
    onReorderTab(sourceKey, targetKey) { reordered.push([sourceKey, targetKey]); },
    onNewTask() { newTasks += 1; },
    onNewStudio() { created.push("studio"); },
    onOpenFile() { created.push("file"); },
    onNewTerminal() { created.push("terminal"); },
  };
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, props)));
  assert.equal(document.querySelector(".workspace-tabs-fade"), null,
    "workspace tabs render without edge masks that clip tab content");
  assert.equal(document.querySelector(".workspace-tab-unread-dot")?.getAttribute("aria-label"),
    "Two has new activity");
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    ...props,
    activeKey: "two",
    activeBusy: true,
  })));
  assert.equal(document.querySelector(".workspace-tabs")?.classList.contains("animating"), false,
    "VS Code tab selection does not arm layout animation");
  assert.equal(scrolled.length, 0,
    "selecting a tab must not scroll the fixed desktop strip and eject its neighbors");
  assert.equal(document.querySelectorAll('.workspace-tab[data-working="true"]').length, 1);
  assert.equal(document.querySelector('.workspace-tab[data-working="true"]')?.textContent.includes("Two"), true);
  assert.equal(document.querySelector('.workspace-tab-status')?.getAttribute("aria-label"), "Two is working");
  assert.equal(document.querySelector(".workspace-tab-unread-dot"), null,
    "the working spinner must supersede the unread marker");
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
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, { ...props, activeKey: "one" })));
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
  assert.deepEqual(reordered, [["one", 2]],
    "VS Code drop index: the right half of the pointed tab inserts after it, committed on drop");
  const newButton = document.querySelector(".workspace-tab-new");
  assert.equal(newButton?.getAttribute("aria-haspopup"), "menu");
  await act(async () => newButton.click());
  assert.deepEqual(
    Array.from(document.querySelectorAll(".workspace-tab-new-menu [role='menuitem']"))
      .map((item) => item.textContent),
    ["New Task", "New Studio", "New File", "New Terminal", "Open Folder"],
  );
  for (const label of ["New Studio", "New File", "New Terminal"]) {
    if (!document.querySelector(".workspace-tab-new-menu")) {
      await act(async () => document.querySelector(".workspace-tab-new").click());
    }
    await act(async () => Array.from(document.querySelectorAll(
      ".workspace-tab-new-menu [role='menuitem']",
    )).find((item) => item.textContent === label).click());
  }
  assert.equal(document.querySelector(".workspace-tab-layout"), null,
    "layout is controlled by direct group drag, not a preset button");
  assert.deepEqual(created, ["studio", "file", "terminal"]);
  const manyTabs = Array.from({ length: 8 }, (_, index) => ({
    key: `many-${index}`,
    title: `Many tab ${index}`,
    selection: { kind: "session", id: `many-${index}` },
  }));
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    ...props,
    tabs: manyTabs,
    activeKey: "many-7",
  })));
  const compressedTabs = Array.from(document.querySelectorAll(".workspace-tab"));
  assert.equal(compressedTabs.length, 8);
  assert.ok(compressedTabs.every((tab) => tab.style.width === ""),
    "dense tabs delegate width distribution to the VS Code flex sizing contract");
  assert.ok(compressedTabs.every((tab) => tab.querySelector(".workspace-tab-close")),
    "every compressed tab keeps its Chrome-style close affordance");
  assert.ok(compressedTabs.every((tab) =>
    tab.querySelector(".workspace-tab-close svg")?.getAttribute("width") === "14"),
  "Chrome-style close glyphs keep the smaller optical size");
  const paneNewButton = document.querySelector(".workspace-tab-new");
  assert.ok(paneNewButton,
    "each pane strip keeps the new-tab affordance beside its tabs");
  assert.equal(paneNewButton.parentElement, document.querySelector(".workspace-tabs"),
    "the new-tab affordance stays inside the tab run instead of at the pane edge");
  assert.equal(paneNewButton.previousElementSibling, compressedTabs.at(-1),
    "the new-tab affordance sits immediately after the final tab");
  assert.equal(document.querySelector(".titlebar-new"), null);
  assert.equal(document.querySelector(".titlebar-update"), null);
});

test("workspace tabs use VS Code flex sizing and reveal an appended tab without observers", async () => {
  installDom();
  const observers = [];
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", {
    get() { return this.classList?.contains("workspace-tabs") ? 640 : 0; },
    configurable: true,
  });
  const baseTabs = Array.from({ length: 4 }, (_, index) => ({
    key: `tab-${index}`,
    title: `Tab ${index}`,
    selection: { kind: index === 1 ? "file" : "session", id: `session-${index}`,
      ...(index === 1 ? { project: "C:\\work", rel: "src/file.ts" } : {}) },
  }));
  const props = {
    tabs: baseTabs,
    activeKey: "tab-0",
    onSelectTab() {},
    onCloseTab() {},
    onReorderTab() {},
    onNewTask() {},
    trailing: React.createElement("div", null, "Task actions"),
  };
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, props)));
  assert.equal(observers.length, 0, "VS Code flex sizing needs no ResizeObserver loop");
  assert.ok(Array.from(document.querySelectorAll(".workspace-tab"))
    .every((tab) => tab.style.width === ""));

  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    ...props,
    tabs: [...baseTabs, {
      key: "from-source-control",
      title: "from-source-control.ts",
      selection: { kind: "file", project: "C:\\work", rel: "from-source-control.ts" },
    }],
    activeKey: "from-source-control",
    trailing: React.createElement("div", null, "File actions"),
  })));
  assert.equal(document.querySelector(".workspace-tabs").scrollLeft, 640,
    "an appended active tab reveals the end of the VS Code tab strip");
});

test("draft materialization and appended tabs render without width animation classes", async () => {
  installDom();
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    get() { return this.classList?.contains("workspace-tabs-shell") ? 800 : 0; },
    configurable: true,
  });
  const props = {
    activeKey: "new:draft-one",
    tabs: [{
      key: "new:draft-one",
      title: "New task",
      selection: { kind: "new", draftId: "draft-one" },
    }],
    onSelectTab() {},
    onCloseTab() {},
    onReorderTab() {},
    onNewTask() {},
  };
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, props)));
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    ...props,
    activeKey: "session:materialized",
    tabs: [{
      key: "session:materialized",
      title: "Materialized task",
      selection: { kind: "session", id: "materialized" },
    }],
  })));
  assert.equal(document.querySelector('[data-tab-key="session:materialized"]')
    ?.classList.contains("entering"), false,
  "an in-place draft promotion renders synchronously");

  await act(async () => root.render(React.createElement(WorkspaceTabStrip, {
    ...props,
    activeKey: "session:materialized",
    tabs: [
      {
        key: "session:materialized",
        title: "Materialized task",
        selection: { kind: "session", id: "materialized" },
      },
      {
        key: "session:actual-new",
        title: "Actually new",
        selection: { kind: "session", id: "actual-new" },
      },
    ],
  })));
  assert.equal(document.querySelector('[data-tab-key="session:actual-new"]')
    ?.classList.contains("entering"), false,
  "an appended tab renders synchronously without grow-in animation");
});

test("background tabs reach a root edge without changing selection first", async () => {
  installDom();
  const first = { kind: "session", id: "one" };
  const second = { kind: "session", id: "two" };
  const leaf = {
    type: "leaf",
    id: "leaf_a",
    tabs: [first, second],
    activeKey: "session:one",
  };
  const splits = [];
  const rootSplits = [];
  const focusedSelections = [];
  const selectedTabs = [];
  const workspace = {
    layout: leaf,
    leaves: [leaf],
    focusedLeaf: leaf,
    focusedLeafId: leaf.id,
    focusLeaf() {},
    setRatio() {},
    splitLeafAt(...args) { splits.push(args); },
    moveTab() {},
    moveTabToNodeEdge(...args) { rootSplits.push(args); },
  };
  const rect = (left, top, width, height) => ({
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  });

  await act(async () => root.render(
    React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: () => React.createElement("div", { className: "test-conversation" }),
        renderStrip: (owner) => React.createElement(WorkspaceTabStrip, {
          tabs: [
            { key: "session:one", title: "One", selection: first },
            { key: "session:two", title: "Two", selection: second },
          ],
          activeKey: owner.activeKey,
          focused: true,
          paneId: owner.id,
          onSelectTab: (tab) => selectedTabs.push(tab.key),
          onCloseTab() {},
          onReorderTab() {},
          onNewTask() {},
        }),
        onFocusSelection: (selection) => focusedSelections.push(selection),
      }),
    ),
  ));
  const panel = document.querySelector(".main-panel");
  const shell = document.querySelector(".workspace-tabs-shell");
  panel.getBoundingClientRect = () => rect(0, 0, 900, 600);
  shell.getBoundingClientRect = () => rect(0, 0, 900, 32);
  const backgroundTab = document.querySelector('[data-tab-key="session:two"]');

  await act(async () => {
    backgroundTab.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true, button: 0, clientX: 450, clientY: 16,
    }));
    // The pointer stays in its OWN strip but enters the expanded right root
    // rail. It must still route to PaneWorkspace instead of reordering.
    window.dispatchEvent(new window.MouseEvent("pointermove", {
      bubbles: true, button: 0, clientX: 899, clientY: 300,
    }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
  assert.equal(document.querySelector(".pane-drop-overlay") != null, true,
    "a selected-tab drag in its own strip should preview a root split");
  assert.equal(backgroundTab.getAttribute("aria-grabbed"), "true");

  await act(async () => {
    window.dispatchEvent(new window.MouseEvent("pointerup", {
      bubbles: true, button: 0, clientX: 899, clientY: 300,
    }));
    // Browsers may synthesize click after pointerup on a captured tab. The
    // completed drag must consume it instead of activating the source group.
    backgroundTab.querySelector(".workspace-tab-main").click();
  });
  assert.deepEqual(rootSplits, [["leaf_a", "session:two", "", "right"]]);
  assert.deepEqual(splits, []);
  assert.deepEqual(focusedSelections, [second]);
  assert.deepEqual(selectedTabs, [],
    "the background tab must move directly into the split without a transient selection");
  assert.equal(document.querySelector(".pane-drop-overlay"), null);
  assert.equal(document.body.dataset.tabDragging, undefined);
});

test("dragging a tab strip's empty run merges or repositions the whole editor group", async () => {
  installDom();
  const leftSelection = { kind: "session", id: "left" };
  const extraSelection = { kind: "session", id: "extra" };
  const rightSelection = { kind: "session", id: "right" };
  const left = {
    type: "leaf", id: "leaf_left", tabs: [leftSelection, extraSelection],
    activeKey: "session:left",
  };
  const right = {
    type: "leaf", id: "leaf_right", tabs: [rightSelection], activeKey: "session:right",
  };
  const layout = {
    type: "split", direction: "row", ratio: 0.5, first: left, second: right,
  };
  const merged = [];
  const moved = [];
  const movedToRoot = [];
  const movedTabsToRoot = [];
  const focusedSelections = [];
  const workspace = {
    layout,
    leaves: [left, right],
    focusedLeaf: left,
    focusedLeafId: left.id,
    focusLeaf() {},
    setRatio() {},
    splitLeafAt() {},
    moveTab() {},
    mergeGroup(...args) { merged.push(args); },
    moveGroupAt(...args) { moved.push(args); },
    moveGroupToNodeEdge(...args) { movedToRoot.push(args); },
    moveTabToNodeEdge(...args) { movedTabsToRoot.push(args); },
  };
  const rect = (left, top, width, height) => ({
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  });

  await act(async () => root.render(
    React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: () => React.createElement("div", { className: "test-conversation" }),
        renderStrip: (owner) => React.createElement(WorkspaceTabStrip, {
          tabs: owner.tabs.map((selection) => ({
            key: `session:${selection.id}`,
            title: selection.id,
            selection,
          })),
          activeKey: owner.activeKey,
          focused: owner.id === left.id,
          paneId: owner.id,
          onSelectTab() {},
          onCloseTab() {},
          onReorderTab() {},
          onNewTask() {},
        }),
        onFocusSelection: (selection) => focusedSelections.push(selection),
      }),
    ),
  ));

  const panes = Array.from(document.querySelectorAll(".pane-leaf"));
  const shells = Array.from(document.querySelectorAll(".workspace-tabs-shell"));
  const strips = Array.from(document.querySelectorAll(".workspace-tabs"));
  const panel = document.querySelector(".main-panel");
  // 1200px tall: the 1.5x vertical pane floor (480x2 + handle = 964px) must
  // leave room for stacked root splits, or the top/bottom previews are
  // legitimately suppressed by canSplitPaneSize.
  panel.getBoundingClientRect = () => rect(0, 0, 1_400, 1_200);
  panes[0].getBoundingClientRect = () => rect(0, 0, 700, 1_200);
  panes[1].getBoundingClientRect = () => rect(700, 0, 700, 1_200);
  shells[0].getBoundingClientRect = () => rect(0, 0, 700, 35);
  shells[1].getBoundingClientRect = () => rect(700, 0, 700, 35);
  strips[0].getBoundingClientRect = () => rect(0, 0, 666, 35);
  strips[1].getBoundingClientRect = () => rect(700, 0, 666, 35);
  strips[0].setPointerCapture = () => {};
  strips[0].hasPointerCapture = () => true;
  strips[0].releasePointerCapture = () => {};
  let returnRootBoundary = false;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x, y) => returnRootBoundary
      ? panel
      : x >= 700 ? (y <= 35 ? shells[1] : panes[1]) : (y <= 35 ? shells[0] : panes[0]),
  });

  const dragGroup = async (targetX, targetY) => {
    await act(async () => {
      strips[0].dispatchEvent(new window.MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 600, clientY: 16,
      }));
      window.dispatchEvent(new window.MouseEvent("pointermove", {
        bubbles: true, button: 0, clientX: targetX, clientY: targetY,
      }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    assert.equal(strips[0].dataset.groupDragging, "true");
    const overlay = document.querySelector(".pane-drop-overlay");
    assert.equal(overlay != null, true);
    const previewStyle = overlay.getAttribute("style");
    await act(async () => window.dispatchEvent(new window.MouseEvent("pointerup", {
      bubbles: true, button: 0, clientX: targetX, clientY: targetY,
    })));
    return previewStyle;
  };

  await dragGroup(1_000, 600);
  assert.deepEqual(merged, [["leaf_left", "leaf_right"]],
    "dropping a group in another pane's center merges every source tab");
  await dragGroup(705, 600);
  assert.deepEqual(moved, [["leaf_left", "leaf_right", "left"]],
    "dropping a group on a pane edge repositions the whole group");
  const rootPreview = await dragGroup(1_395, 600);
  assert.deepEqual(movedToRoot, [["leaf_left", "", "right"]],
    "dropping at the workspace edge repositions the group beside the whole layout");
  assert.match(rootPreview, /left:\s*700px/);
  assert.match(rootPreview, /height:\s*1200px/);
  const topPreview = await dragGroup(600, 2);
  assert.match(topPreview, /width:\s*1400px/);
  assert.match(topPreview, /height:\s*600px/);
  returnRootBoundary = true;
  const bottomPreview = await dragGroup(700, 1_198);
  returnRootBoundary = false;
  assert.match(bottomPreview, /top:\s*600px/);
  assert.match(bottomPreview, /width:\s*1400px/);
  const leftPreview = await dragGroup(2, 600);
  assert.match(leftPreview, /width:\s*700px/);
  // At a side cap the drop stays local to the touched row instead of taking
  // the whole root edge.
  const cornerPreview = await dragGroup(1_398, 50);
  assert.match(cornerPreview, /left:\s*1050px/);
  assert.match(cornerPreview, /height:\s*1200px/);
  assert.deepEqual(moved, [["leaf_left", "leaf_right", "left"]]);
  assert.deepEqual(movedToRoot, [
    ["leaf_left", "", "right"],
    ["leaf_left", "", "top"],
    ["leaf_left", "", "bottom"],
    ["leaf_left", "", "left"],
    ["leaf_left", "second", "right"],
  ]);

  const extraTab = document.querySelector('[data-tab-key="session:extra"]');
  await act(async () => {
    extraTab.dispatchEvent(new window.MouseEvent("pointerdown", {
      bubbles: true, button: 0, clientX: 180, clientY: 16,
    }));
    window.dispatchEvent(new window.MouseEvent("pointermove", {
      bubbles: true, button: 0, clientX: 1_395, clientY: 600,
    }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
  const tabPreview = document.querySelector(".pane-drop-overlay")?.getAttribute("style") ?? "";
  assert.match(tabPreview, /left:\s*933\.33/);
  assert.match(tabPreview, /width:\s*466\.66/);
  assert.match(tabPreview, /height:\s*1200px/);
  await act(async () => window.dispatchEvent(new window.MouseEvent("pointerup", {
    bubbles: true, button: 0, clientX: 1_395, clientY: 600,
  })));
  assert.deepEqual(movedTabsToRoot, [["leaf_left", "session:extra", "", "right"]]);
  assert.deepEqual(focusedSelections, [...Array(7).fill(leftSelection), extraSelection]);
  assert.equal(document.querySelector(".pane-drop-overlay"), null);
  assert.equal(document.body.dataset.tabDragging, undefined);
});

test("session-list drops open in a pane center and split from pane edges", async () => {
  installDom();
  const existing = { kind: "session", id: "existing" };
  const rightSelection = { kind: "session", id: "right" };
  const closed = { kind: "session", id: "closed" };
  const left = {
    type: "leaf", id: "leaf_left", tabs: [existing], activeKey: "session:existing",
  };
  const right = {
    type: "leaf", id: "leaf_right", tabs: [rightSelection], activeKey: "session:right",
  };
  const layout = {
    type: "split", direction: "row", ratio: 0.5, first: left, second: right,
  };
  const opened = [];
  const splits = [];
  const focusedSelections = [];
  const workspace = {
    layout,
    leaves: [left, right],
    focusedLeaf: left,
    focusedLeafId: left.id,
    focusLeaf() {},
    setRatio() {},
    openInLeaf(...args) { opened.push(args); },
    splitLeafAt(...args) { splits.push(args); },
    moveTab() {},
    moveTabToNodeEdge() {},
  };
  const rect = (leftEdge, top, width, height) => ({
    x: leftEdge, y: top, left: leftEdge, top, width, height,
    right: leftEdge + width, bottom: top + height,
    toJSON: () => ({}),
  });

  await act(async () => root.render(
    React.createElement("div", { className: "main-panel" },
      React.createElement(PaneWorkspace, {
        workspace,
        renderActive: () => React.createElement("div"),
        renderConversation: () => React.createElement("div", { className: "test-conversation" }),
        onFocusSelection: (selection) => focusedSelections.push(selection),
      }),
    ),
  ));
  const panel = document.querySelector(".main-panel");
  const panes = [...document.querySelectorAll(".pane-leaf")];
  panel.getBoundingClientRect = () => rect(0, 0, 1_400, 600);
  panes[0].getBoundingClientRect = () => rect(0, 0, 700, 600);
  panes[1].getBoundingClientRect = () => rect(700, 0, 700, 600);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x) => x < 700 ? panes[0] : panes[1],
  });

  await act(async () => publishTabDrag({
    kind: "session", phase: "move", key: "session:closed",
    title: "Closed", selection: closed, x: 1_050, y: 300,
  }));
  assert.equal(document.querySelector(".pane-drop-overlay") != null, true);
  await act(async () => publishTabDrag({
    kind: "session", phase: "drop", key: "session:closed",
    title: "Closed", selection: closed, x: 1_050, y: 300,
  }));
  assert.deepEqual(opened, [["leaf_right", closed, undefined]]);

  await act(async () => publishTabDrag({
    kind: "session", phase: "move", key: "session:existing",
    title: "Existing", selection: existing, x: 705, y: 300,
  }));
  assert.match(document.querySelector(".pane-drop-overlay")?.getAttribute("style") ?? "",
    /width:\s*350px/);
  await act(async () => publishTabDrag({
    kind: "session", phase: "drop", key: "session:existing",
    title: "Existing", selection: existing, x: 705, y: 300,
  }));
  assert.deepEqual(splits, [["leaf_right", "left", existing, "leaf_left"]]);
  assert.deepEqual(focusedSelections, [closed, existing]);
  assert.equal(document.querySelector(".pane-drop-overlay"), null);
});

test("the global close shortcut closes the active tab immediately", async () => {
  installDom();
  const closed = [];
  const props = {
    tabs: [
      { key: "one", title: "One", selection: { kind: "new" } },
      { key: "two", title: "Two", selection: { kind: "session", id: "two" } },
    ],
    activeKey: "two",
    // Only the FOCUSED group's strip consumes the global close event.
    focused: true,
    onSelectTab() {},
    onCloseTab(tab) { closed.push(tab.key); },
    onReorderTab() {},
    onNewTask() {},
  };
  await act(async () => root.render(React.createElement(WorkspaceTabStrip, props)));
  // App owns Ctrl+Q and routes it through this event. Unlike pointer close and
  // Ctrl+W, the latency-sensitive global shortcut must not wait 200ms.
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent("mixdog:close-active-tab"));
  });
  assert.deepEqual(closed, ["two"]);
});

test("Ctrl+Q capture closes from Composer, xterm and Monaco while modal confirmation owns the key", async () => {
  installDom();
  let closes = 0;
  const onClose = () => { closes += 1; };
  window.addEventListener("mixdog:close-active-tab", onClose);
  const actions = {
    tabs: [],
    activeTabKey: "",
    navigateTab() {},
    startTask() {},
    openSettings() {},
    toggleSidebar() {},
    toggleDock() {},
    togglePanel() {},
    openTerminalPanel() {},
    openQuickAccess() {},
    openCommandPalette() {},
    navigateBack() {},
    navigateForward() {},
  };
  function ShortcutHarness({ modal = false }) {
    useWorkspaceShortcuts(actions);
    const consumeAtTarget = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    return React.createElement(React.Fragment, null,
      React.createElement("textarea", { "data-key-owner": "composer", onKeyDown: consumeAtTarget }),
      React.createElement("textarea", { "data-key-owner": "xterm", onKeyDown: consumeAtTarget }),
      React.createElement("textarea", { "data-key-owner": "monaco", onKeyDown: consumeAtTarget }),
      modal && React.createElement("div", { role: "dialog", "aria-modal": "true" },
        React.createElement("input", { "data-key-owner": "modal" })),
    );
  }
  await act(async () => root.render(React.createElement(ShortcutHarness)));
  for (const owner of ["composer", "xterm", "monaco"]) {
    const event = new window.KeyboardEvent("keydown", {
      key: "q", ctrlKey: true, bubbles: true, cancelable: true,
    });
    document.querySelector(`[data-key-owner="${owner}"]`).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, `${owner} Ctrl+Q must be consumed in capture`);
  }
  assert.equal(closes, 3);

  await act(async () => root.render(React.createElement(ShortcutHarness, { modal: true })));
  const modalEvent = new window.KeyboardEvent("keydown", {
    key: "q", ctrlKey: true, bubbles: true, cancelable: true,
  });
  document.querySelector('[data-key-owner="modal"]').dispatchEvent(modalEvent);
  assert.equal(modalEvent.defaultPrevented, false);
  assert.equal(closes, 3, "an open save/confirmation modal must retain Ctrl+Q ownership");
  window.removeEventListener("mixdog:close-active-tab", onClose);
});

test("desktop update confirmation uses the themed modal and protects install behind confirmation", async () => {
  const shell = installDom();
  let cancelled = 0;
  let confirmed = 0;
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement("button", {
        type: "button",
        id: "update-trigger",
        onClick: () => setOpen(true),
      }, "Update"),
      open && React.createElement(DesktopUpdateDialog, {
        version: "2.0.0",
        onCancel: () => {
          cancelled += 1;
          setOpen(false);
        },
        onConfirm: () => {
          confirmed += 1;
          setOpen(false);
        },
      }),
    );
  }
  await act(async () => root.render(React.createElement(Harness)));
  const trigger = document.getElementById("update-trigger");
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  const dialog = document.querySelector("[data-desktop-update-dialog]");
  const close = dialog.querySelector('[aria-label="Close update confirmation"]');
  const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
  const install = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Install and restart");
  assert.equal(dialog.classList.contains("settings-confirm-dialog"), true);
  assert.equal(dialog.getAttribute("role"), "alertdialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.match(dialog.textContent, /Install Mixdog 2\.0\.0/);
  assert.equal(shell.inert, true);
  assert.equal(shell.getAttribute("aria-hidden"), "true");
  assertActiveElement(cancel, "destructive update action must not receive initial focus");
  await act(async () => {
    install.focus();
    document.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Tab", bubbles: true,
    }));
  });
  assertActiveElement(close, "focus remains trapped inside the update dialog");
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(cancelled, 1);
  assert.equal(confirmed, 0);
  assert.equal(document.querySelector("[data-desktop-update-dialog]"), null);
  assert.equal(shell.inert, false);
  assert.equal(shell.hasAttribute("aria-hidden"), false);
  assertActiveElement(trigger, "closing the update dialog restores trigger focus");

  await act(async () => trigger.click());
  await act(async () => {
    [...document.querySelectorAll("[data-desktop-update-dialog] button")]
      .find((button) => button.textContent === "Install and restart").click();
  });
  assert.equal(confirmed, 1);
  assert.equal(document.querySelector("[data-desktop-update-dialog]"), null);
});

test("model selector remains available for a next-session route during turn busy and closes for commandBusy", async () => {
  installDom();
  let publish;
  const row = seedActiveSession("model-busy-session");
  window.mixdogDesktop = {
    getSnapshot: async () => ({ sessionId: "model-busy-session", items: [], queued: [], provider: "openai", model: "gpt-real" }),
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [row],
    startTask: async () => ({ sessionId: "model-busy-session", items: [], queued: [], provider: "openai", model: "gpt-real" }),
    listProviderModels: async () => [
      { provider: "openai", model: "gpt-real", display: "GPT Real", effortOptions: [] },
    ],
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
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
  await act(async () => publish({ sessionId: "model-busy-session", items: [], queued: [], busy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-picker-dialog") != null, true, "turn busy keeps next-session model routing available");
  assert.equal(trigger.disabled, false);
  await act(async () => publish({ sessionId: "model-busy-session", items: [], queued: [], busy: false, provider: "openai", model: "gpt-real" }));
  assert.equal(trigger.disabled, false);
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => trigger.click());
  assert.equal(document.querySelector(".model-picker-dialog") != null, true, "selector .model-picker-dialog should be present");
  await act(async () => publish({ sessionId: "model-busy-session", items: [], queued: [], commandBusy: true, provider: "openai", model: "gpt-real" }));
  assert.equal(document.querySelector(".model-picker-dialog") === null, true, "command-busy state should close the model selector");
  assert.equal(trigger.disabled, true);
});

test("desktop composer restores queued work, recalls engine history, and executes slash capabilities", async () => {
  installDom();
  const capabilities = [];
  const row = seedActiveSession('session-1', 'Capability session');
  const snapshot = {
    sessionId: 'session-1',
    items: [],
    queued: [{ id: 'queued-1', displayText: 'Queued request' }],
    promptHistoryList: ['Previous engine prompt'],
  };
  window.mixdogDesktop = {
    getSnapshot: async () => snapshot,
    listSessions: async () => [row],
    resumeSession: async () => snapshot,
    subscribeState: () => () => {},
    invokeCapability: async ({ capability, args = [] }) => {
      capabilities.push([capability, args]);
      if (capability === 'getTheme') return { value: 'basic', snapshot };
      if (capability === 'restoreQueued') {
        return {
          value: { text: 'Restored request', pastedImages: null, pastedTexts: null },
          snapshot: { ...snapshot, queued: [] },
        };
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
    ['Attach files', 'Dictate with voice'],
  );
  assert.equal(document.querySelector('.queue-summary'), null);
  assert.equal(document.querySelector('.queue-item-text')?.textContent, 'Queued request');
  assert.equal(document.querySelector('.queue-item small'), null);
  assert.equal(document.querySelectorAll('.queue-list [role="listitem"]').length, 1);
  await act(async () => {
    document.querySelector('.queue-edit').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(textarea.value, 'Restored request');
  assert.ok(capabilities.some(([capability, args]) =>
    capability === 'restoreQueued' && args[0] === '' && args[1] === 'queued-1'));

  const setTextareaValue =
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
  });
  assert.equal(textarea.value, '');
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  });
  assert.equal(textarea.value, 'Previous engine prompt');

  await act(async () => {
    setTextareaValue.call(textarea, '/compact');
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
    sessionId: 'composer-activity-session',
    items: [], queued: [], promptHistoryList: [], provider: 'openai', model: 'gpt-real',
  };
  const row = seedActiveSession('composer-activity-session');
  window.mixdogDesktop = {
    getSnapshot: async () => idle,
    subscribeState: (listener) => { publish = listener; return () => {}; },
    listSessions: async () => [row],
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
  // Desktop keeps a deliberate SUBSET of the TUI palette (slash-commands.ts).
  assert.equal(paletteOptions.length, 8);
  assert.ok(slashScrolls > 0);
  const initiallySelected = document.querySelector('.slash-palette [aria-selected="true"]')?.textContent;
  for (let index = 0; index < paletteOptions.length; index += 1) await press('ArrowDown');
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

  // Theme, output style, and auto-clear moved to Settings rows: the composer no
  // longer answers those status commands (desktop palette subset).

  await act(async () => publish({
    ...idle,
    busy: true,
    queued: [{ id: 'steer-1', displayText: 'Queued steering' }],
  }));
  assert.equal(document.querySelector('.send-button.stop') != null, true, "selector .send-button.stop should be present");
  assert.equal(document.querySelector('.queue-priority') === null, true, "selector .queue-priority should be absent");
  assert.equal(getTextarea().placeholder, '',
    "a pending user card counts as conversation content and suppresses empty-thread hints");
  assert.equal(document.querySelector('.queue-item-text')?.textContent, 'Queued steering');
  assert.equal(document.querySelector('.queue-item small'), null);
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
    const deadline = Date.now() + 1_000;
    while (document.querySelectorAll('.composer-attachments img').length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
  });

  // Chip-only representation: pasting an image must NOT leave a bracket token
  // in the draft text (user: redundant "[Image #N]" box under the thumbnail).
  assert.doesNotMatch(textarea.value, /\[Image #/);
  assert.equal(document.querySelectorAll('.composer-attachments img').length, 1);
  assert.match(document.querySelector('.composer-attachments')?.textContent || '', /clipboard\.png/);
  // Image-only send stays enabled despite the empty draft.
  assert.equal(document.querySelector('.send-button')?.disabled, false);
});

test("desktop task accepts file drops across the full conversation area", async () => {
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

  const dropTarget = document.querySelector('.thread');
  assert.ok(dropTarget);
  assert.equal(dropTarget.closest('.composer'), null, "test drop target must be outside the composer");
  const file = new window.File(['dragged contents'], 'dragged.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'text', { value: async () => 'dragged contents' });
  const dataTransfer = {
    types: ['Files'],
    items: [{ kind: 'file', type: 'text/plain', getAsFile: () => file }],
    files: [file],
    dropEffect: 'none',
  };
  await act(async () => {
    const event = new window.Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    dropTarget.dispatchEvent(event);
  });
  const overlay = document.querySelector('.task-drop-overlay');
  assert.ok(overlay);
  assert.equal(overlay.parentElement, document.querySelector('.conversation'));

  await act(async () => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    dropTarget.dispatchEvent(event);
    const deadline = Date.now() + 1_000;
    while (!document.querySelector('.composer-attachments') && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
  });
  assert.equal(document.querySelector('.task-drop-overlay'), null);
  assert.match(document.querySelector('.composer-attachments')?.textContent || '', /dragged\.txt/);
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
  await sendSlash('/new');
  assert.ok(capabilities.some(([capability]) => capability === 'claimRemote'));
  // New task is a renderer-only draft until its first prompt; model/catalog
  // controls likewise stay outside the session-scoped command surface.
  assert.deepEqual(fastValues, []);
  assert.equal(newTasks, 0);
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
  // Restored image tokens are stripped from the draft; the image comes back as
  // a chip-only attachment.
  assert.equal(textarea.value, 'Inspect\nKeep this steering note');
  assert.match(document.querySelector('.composer-attachments').textContent, /restored\.png/);
  assert.match(document.querySelector('.composer-attachments img').src, /^data:image\/png;base64,aGVsbG8=/);
});

test("fresh install starts with the sidebar minimized and persists the layout choice", async () => {
  installDom();
  window.localStorage.removeItem("mixdog.desktop-sidebar-open.v1");
  window.mixdogDesktop = {
    getSnapshot: async () => ({ items: [], queued: [] }),
    listSessions: async () => [],
    subscribeState: () => () => {},
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });
  // Default layout keeps BOTH edges minimized (user decision); only an
  // explicit stored "true" restores an open sidebar.
  assert.equal(document.querySelector(".toolbar-sidebar").getAttribute("aria-label"), "Expand session sidebar");
  await act(async () => {
    document.querySelector(".toolbar-sidebar").click();
    await new Promise((resolve) => window.setTimeout(resolve, 140));
  });
  assert.equal(window.localStorage.getItem("mixdog.desktop-sidebar-open.v1"), "true",
    "opening the sidebar persists the layout for the next launch");
});

test("a pending draft submit never promotes a newer draft onto its session", async () => {
  installDom();
  await preloadMarkdownBody();
  let publishState;
  let finishFirstSubmit;
  let submitCalls = 0;
  let current = { sessionId: "", items: [], queued: [] };
  const first = {
    id: "draft-a-session",
    title: "Draft A task",
    preview: "Draft A prompt",
    updatedAt: 2,
    currentSession: true,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
  };
  const second = { ...first, id: "draft-b-session", title: "Draft B task", preview: "Draft B prompt" };
  const sessions = [];
  const type = async (value) => {
    const textarea = document.querySelector('textarea[aria-label="Message Mixdog"]');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value").set;
    await act(async () => {
      setValue.call(textarea, value);
      textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: value }));
    });
    await act(async () => {
      document.querySelector(".send-button").click();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  window.mixdogDesktop = {
    getSnapshot: async () => current,
    subscribeState: (listener) => { publishState = listener; return () => {}; },
    listProjects: async () => [],
    listSessions: async () => sessions.slice(),
    startTask: async () => {
      const session = submitCalls === 0 ? first : second;
      current = { sessionId: session.id, items: [], queued: [] };
      publishState?.(current);
      return current;
    },
    submit: async () => {
      submitCalls += 1;
      if (submitCalls > 1) return true;
      return new Promise((resolve) => { finishFirstSubmit = () => resolve(true); });
    },
  };
  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
    await Promise.resolve();
  });

  // Draft A submits and its acknowledgement stays in flight.
  await type("Draft A prompt");
  assert.equal(typeof finishFirstSubmit, "function", "draft A's submit must still be pending");
  const activeTabText = () => document.querySelector(".workspace-tab.active")?.textContent || "";

  // A brand new draft B is opened while A is still materializing.
  await act(async () => {
    document.querySelector(".session-new-task").click();
    await Promise.resolve();
  });
  assert.match(activeTabText(), /New task/, "the newly opened draft owns the active tab");

  // Draft A's session now publishes its authoritative transcript.
  await act(async () => {
    current = {
      sessionId: first.id,
      desktopSessionTitle: first.title,
      items: [
        { id: "a-user", kind: "user", text: "Draft A prompt" },
        { id: "a-assistant", kind: "assistant", text: "Draft A response" },
      ],
      queued: [],
    };
    sessions.push(first);
    publishState?.(current);
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.match(activeTabText(), /New task/,
    "draft B must never be promoted onto the session draft A created");
  assert.doesNotMatch(activeTabText(), /Draft A task/);
  assert.equal(document.querySelector(".session-header h1")?.textContent.trim(), "New task");

  // Draft A's acknowledgement settles afterwards; it may only release its OWN
  // record, so draft B keeps its own materialization ownership.
  await act(async () => {
    finishFirstSubmit();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.match(activeTabText(), /New task/,
    "a completed older submit must not retitle the newer draft either");

  await type("Draft B prompt");
  await act(async () => {
    sessions.push(second);
    current = {
      sessionId: second.id,
      desktopSessionTitle: second.title,
      items: [{ id: "b-user", kind: "user", text: "Draft B prompt" }],
      queued: [],
    };
    publishState?.(current);
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  assert.match(activeTabText(), /Draft B prompt|Draft B task/,
    "draft B still promotes through its OWN submit after the older arm cleared");
});
