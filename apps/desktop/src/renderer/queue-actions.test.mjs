import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

import { QueueList } from "./composer-support.tsx";
import {
  shouldBlockPromptSubmit,
  shouldInterruptPrompt,
  shouldRestoreInterruptedPrompt,
} from "./renderer-logic.mjs";
import { classifyPromptEscape } from "../../../../src/tui/components/prompt-input/escape-policy.mjs";
import { mergeQueuedRestoreDraft } from "../../../../src/tui/components/prompt-input/restore-policy.mjs";

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

test("queued follow-up Escape behavior matches Claude Code priority and handoff", () => {
  assert.equal(classifyPromptEscape({
    interruptActive: true,
    hasQueuedMessages: true,
    value: "",
  }).action, "interrupt");
  assert.equal(shouldRestoreInterruptedPrompt({
    hasDraft: false,
    hasQueuedMessages: true,
  }), false, "interrupt leaves the queued follow-up owning the next turn");

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

  assert.equal(shouldRestoreInterruptedPrompt({
    hasDraft: false,
    hasQueuedMessages: false,
  }), true, "an unsteered interrupt may restore its prompt");

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
