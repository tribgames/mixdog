import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

import { QueueList } from "./composer-support.tsx";
import {
  hasSendablePromptContent,
  isComposerNewlineChord,
  nextComposerShiftLatch,
  shouldBlockPromptSubmit,
  shouldInterruptPrompt,
  shouldNavigatePromptHistory,
  shouldStopComposerGeneration,
} from "./renderer-logic.mjs";
import { paneActiveSessionIds } from "./pane-layout.ts";
import { usePromptQueueHistory } from "../../../../src/tui/app/use-prompt-queue-history.mjs";
import { classifyPromptEscape } from "../../../../src/tui/components/prompt-input/escape-policy.mjs";
import {
  mergeQueuedRestoreDraft,
  paletteOwnsPromptVerticalArrow,
  queuedRestorePrefix,
  queuedRestoreProjection,
  replaceQueuedRestorePrefix,
} from "../../../../src/tui/components/prompt-input/restore-policy.mjs";
import { isQueuedEntryEditable } from "../../../../src/tui/session/queue-helpers.mjs";

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

test("queued follow-up rows expose independent edit, steer-now, and remove actions", async () => {
  const dom = installDom();
  const actions = [];
  try {
    await act(async () => {
      dom.root.render(React.createElement(QueueList, {
        queued: [
          { id: "steer-1", displayText: "steer this now" },
          { id: "slash-1", displayText: "/compact" },
        ],
        restoring: false,
        onEdit: (id) => actions.push(["edit", id]),
        onSteer: (id) => actions.push(["steer", id]),
        onRemove: (id) => actions.push(["remove", id]),
      }));
    });

    const steer = document.querySelector(
      '[aria-label="Steer queued follow-up now: steer this now"]',
    );
    assert.equal(steer?.textContent, "Steer now");
    assert.equal(steer?.disabled, false);
    assert.equal(document.querySelector(
      '[aria-label="Steer queued follow-up now: /compact"]',
    )?.disabled, true, "slash commands cannot bypass their command dispatcher");

    await act(async () => steer.click());
    await act(async () => document.querySelector(
      '[aria-label="Remove queued follow-up: steer this now"]',
    ).click());
    assert.deepEqual(actions, [
      ["steer", "steer-1"],
      ["remove", "steer-1"],
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("queued follow-up Escape behavior keeps queue priority and handoff", () => {
  assert.equal(classifyPromptEscape({
    interruptActive: true,
    hasSelection: true,
    hasQueuedMessages: true,
    value: "",
  }).action, "interrupt", "an active turn wins even when draft text is selected");
  assert.equal(classifyPromptEscape({
    interruptActive: false,
    hasSelection: true,
    hasQueuedMessages: true,
    value: "selected draft",
  }).action, "collapse-selection", "idle selection keeps its existing first-Escape behavior");
  assert.equal(classifyPromptEscape({
    interruptActive: false,
    hasQueuedMessages: true,
    value: "current draft",
  }).action, "restore-queue");
  assert.deepEqual(mergeQueuedRestoreDraft("queued follow-up", {
    value: "current draft",
    cursor: 7,
    selectionAnchor: null,
  }), {
    value: "queued follow-up\ncurrent draft",
    cursor: 24,
    selectionAnchor: null,
  });

  assert.equal(shouldInterruptPrompt({
    turnBusy: false,
    pendingSubmissionId: "submitted-before-busy-paint",
  }), true, "an accepted prompt interrupts before the busy snapshot paints");
  assert.equal(shouldInterruptPrompt({
    turnBusy: false,
    pendingSubmissionId: "draft-submit",
    draftMode: true,
  }), false, "New task materialization keeps its separate submit ownership");
});

test("queued restore paints before a daemon acknowledgement and reconciles without duplication", async () => {
  const dom = installDom();
  let restoreQueuedToPrompt;
  let resolveRestore;
  let latestDraft = { value: "current draft", cursor: 7, selectionAnchor: null };
  const overrides = [];
  const promptValueRef = { current: latestDraft.value };
  const store = {
    restoreQueued: () => new Promise((resolve) => { resolveRestore = resolve; }),
  };
  function Harness() {
    ({ restoreQueuedToPrompt } = usePromptQueueHistory({
      store,
      state: { queued: [{ id: "queued-1", displayText: "queued follow-up" }] },
      exit: () => {},
      exitRequestedRef: { current: false },
      setExiting: () => {},
      promptValueRef,
      promptDraft: latestDraft.value,
      showPromptHint: () => {},
      clearPromptHint: () => {},
      installPastedImages: () => {},
      installPastedTexts: () => {},
      syncPromptLayoutRows: () => {},
      setPromptDraftOverride: (next) => {
        latestDraft = next;
        promptValueRef.current = next.value;
        overrides.push(next);
      },
      promptHistoryNavRef: { current: {} },
    }));
    return null;
  }
  try {
    await act(async () => { dom.root.render(React.createElement(Harness)); });
    let accepted = false;
    act(() => {
      accepted = restoreQueuedToPrompt({
        showHint: false,
        getCurrentDraft: () => latestDraft,
      });
    });
    assert.equal(accepted, true);
    assert.equal(overrides.at(-1)?.value, "queued follow-up\ncurrent draft");
    await act(async () => {
      resolveRestore({ count: 1, ids: ["queued-1"], text: "queued follow-up" });
      await Promise.resolve();
    });
    assert.equal(overrides.at(-1)?.value, "queued follow-up\ncurrent draft");
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test("existing-session Enter does not wait for the previous host acknowledgement", () => {
  assert.equal(shouldBlockPromptSubmit({
    submitting: true,
    draftMode: false,
    slashCommand: false,
  }), false);
  assert.equal(shouldBlockPromptSubmit({
    submitting: true,
    draftMode: true,
    slashCommand: false,
  }), true);
  assert.equal(shouldBlockPromptSubmit({
    submitting: true,
    draftMode: false,
    slashCommand: true,
  }), true);
});

test("an image-only composer submit remains sendable during an active turn", () => {
  const image = { token: "", kind: "image" };
  assert.equal(hasSendablePromptContent({ text: "", attachments: [image] }), true);
  assert.equal(shouldStopComposerGeneration({
    turnBusy: true,
    text: "",
    attachments: [image],
  }), false, "the send control must not turn into Stop while an image is queued");
  assert.equal(shouldStopComposerGeneration({
    turnBusy: true,
    text: "",
    attachments: [],
  }), true);
});

test("prompt arrows enter history only from an empty draft", () => {
  assert.equal(shouldNavigatePromptHistory({
    key: "ArrowUp",
    value: "current draft",
    selectionStart: 0,
  }), false, "an existing draft keeps native cursor navigation");
  assert.equal(shouldNavigatePromptHistory({
    key: "ArrowUp",
    value: "",
    selectionStart: 0,
  }), true, "an empty draft may enter prompt history");
  assert.equal(shouldNavigatePromptHistory({
    key: "ArrowUp",
    value: "current draft",
    selectionStart: 0,
    allowNonEmpty: true,
  }), true, "queued restore may reclaim above a non-empty first-line draft");
  assert.equal(shouldNavigatePromptHistory({
    key: "ArrowUp",
    value: "history entry",
    selectionStart: 0,
    historyActive: true,
  }), true, "active history navigation may continue backward");
  assert.equal(shouldNavigatePromptHistory({
    key: "ArrowDown",
    value: "history entry",
    selectionStart: 13,
    historyActive: true,
  }), true, "active history navigation may continue toward the seed");
});

test("queue parity helpers preserve order, rollback exact prefixes, and guard meta entries", () => {
  assert.deepEqual(queuedRestoreProjection([
    { id: "one", displayText: "first" },
    { id: "two", text: "second" },
  ]), {
    count: 2,
    ids: ["one", "two"],
    text: "first\nsecond",
  });
  const optimisticPrefix = queuedRestorePrefix("queued", "draft");
  assert.equal(optimisticPrefix, "queued\n");
  assert.deepEqual(replaceQueuedRestorePrefix(
    optimisticPrefix,
    "confirmed\n",
    { value: "queued\ndraft plus", cursor: 17, selectionAnchor: null },
  ), {
    value: "confirmed\ndraft plus",
    cursor: 20,
    selectionAnchor: null,
    replaced: true,
  });
  assert.equal(paletteOwnsPromptVerticalArrow(1), false);
  assert.equal(paletteOwnsPromptVerticalArrow(2), true);
  assert.equal(isQueuedEntryEditable({ mode: "prompt", isMeta: true }), false);
  assert.equal(isQueuedEntryEditable({ mode: "prompt" }), true);
});

test("PANE active sessions follow focused pane order", () => {
  const session = (id) => ({ kind: "session", id });
  const leaves = [
    {
      type: "leaf",
      id: "left",
      tabs: [session("left-inactive"), session("left-active")],
      activeKey: "session:left-active",
    },
    {
      type: "leaf",
      id: "right",
      tabs: [
        session("right-active"),
        { kind: "file", project: "C:/Project/mixdog", rel: "README.md" },
        session("left-inactive"),
      ],
      activeKey: "session:right-active",
    },
  ];

  assert.deepEqual(paneActiveSessionIds(leaves, "right"), [
    "right-active",
    "left-active",
  ]);
});

test("COMPOSER Enter sends when Shift was spent typing a character", () => {
  // Typing '?' (Shift+/) then Enter before Shift is physically released.
  let latch = nextComposerShiftLatch(false, { type: "keydown", key: "Shift", shiftKey: true });
  assert.equal(latch, false);
  latch = nextComposerShiftLatch(latch, { type: "keydown", key: "?", shiftKey: true });
  assert.equal(latch, true);
  assert.equal(isComposerNewlineChord({ key: "Enter", shiftKey: true, shiftLatched: latch }), false);

  // Releasing Shift re-arms the real Shift+Enter newline chord.
  latch = nextComposerShiftLatch(latch, { type: "keyup", key: "Shift", shiftKey: false });
  assert.equal(latch, false);
  assert.equal(isComposerNewlineChord({ key: "Enter", shiftKey: true, shiftLatched: latch }), true);

  // A lost keyup still recovers on the next unshifted keydown.
  latch = nextComposerShiftLatch(true, { type: "keydown", key: "a", shiftKey: false });
  assert.equal(latch, false);

  // Other chords and plain Enter keep their meaning regardless of the latch.
  assert.equal(isComposerNewlineChord({ key: "Enter", ctrlKey: true, shiftLatched: true }), true);
  assert.equal(isComposerNewlineChord({ key: "Enter", altKey: true, shiftLatched: true }), true);
  assert.equal(isComposerNewlineChord({ key: "Enter" }), false);
  assert.equal(isComposerNewlineChord({ key: "a", shiftKey: true }), false);
});
