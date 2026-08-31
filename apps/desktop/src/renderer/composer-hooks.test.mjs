import assert from "node:assert/strict";
import test from "node:test";

import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.attachEvent ??= () => {};
dom.window.HTMLElement.prototype.detachEvent ??= () => {};
window.mixdogDesktop = {
  rendererDiagnostic() {},
};

const { useComposerAttachments } = await import("./use-composer-attachments.ts");
const { useComposerQueue } = await import("./use-composer-queue.ts");
const { useComposerSubmission } = await import("./use-composer-submission.ts");
const { useComposerKeyboard } = await import("./use-composer-keyboard.ts");
const { useComposerShareIntake } = await import("./use-composer-share-intake.ts");
const { publishSharedIntake, resetSharedIntake } = await import("./share-target-intake.ts");

function mountHarness(Component, props) {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  return {
    render: (nextProps) => act(async () => {
      root.render(React.createElement(Component, nextProps));
    }),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
    initial: props,
  };
}

test("attachment hook keeps state, refs, draft tokens, and reset in sync", async () => {
  let current;
  function Harness() {
    const [draft, setDraft] = useState("[File #1]");
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: "" });
    const transitioningRef = useRef(false);
    const dropTargetRef = useRef(null);
    current = {
      draft,
      ...useComposerAttachments({
        draftRef,
        setDraft,
        textarea,
        historyNavigation,
        transitioningRef,
        projectScope: "C:/Project/demo",
        recoveryScope: "session-a",
        submissionRecoveryVersion: 0,
        dropTargetRef,
      }),
    };
    return React.createElement("div", { ref: dropTargetRef },
      React.createElement("textarea", { ref: textarea, value: draft, readOnly: true }));
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    const attachment = {
      id: 1,
      name: "notes.txt",
      kind: "text",
      mimeType: "text/plain",
      data: "notes",
      token: "[File #1]",
      source: "file",
    };
    await act(async () => current.replaceAttachments([attachment]));
    assert.deepEqual(current.attachments.map((item) => item.id), [1]);
    assert.deepEqual(current.attachmentsRef.current.map((item) => item.id), [1]);

    await act(async () => current.removeAttachment(attachment));
    assert.equal(current.attachments.length, 0);
    assert.equal(current.attachmentsRef.current.length, 0);
    assert.equal(current.draft, "");

    await act(async () => current.setDraggingFiles(true));
    assert.equal(current.draggingFiles, true);
    await act(async () => current.resetAttachments());
    assert.equal(current.draggingFiles, false);
    assert.equal(current.attachmentError, "");
  } finally {
    await mounted.cleanup();
  }
});

test("queue hook restores a queued draft and resets busy state when scope changes", async () => {
  let current;
  const restoredIds = [];
  const invokeCapability = async (capability) => {
    assert.equal(capability, "restoreQueued");
    return { count: 1, text: "queued draft", ids: ["q1"] };
  };
  function Harness({ scope }) {
    const [draft, setDraft] = useState("");
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const composingRef = useRef(false);
    const historyNavigation = useRef({ index: -1, seed: "" });
    current = {
      draft,
      ...useComposerQueue({
        queued: [{ id: "q1", text: "queued draft" }],
        hiddenQueueIds: [],
        pendingSubmissionIds: [],
        draftMode: false,
        turnBusy: false,
        draftRef,
        setDraft,
        textarea,
        composingRef,
        historyNavigation,
        invokeCapability,
        abort: async () => undefined,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        mergeRestoredAttachments: (_attachments, text) => text,
        showNotice() {},
        onQueuedRestored: (ids) => restoredIds.push(...ids),
        scope,
      }),
    };
    return React.createElement("textarea", { ref: textarea, value: draft, readOnly: true });
  }
  const mounted = mountHarness(Harness, { scope: "session-a" });
  try {
    await mounted.render({ scope: "session-a" });
    await act(async () => {
      await current.restoreQueue("q1");
    });
    assert.equal(current.draft, "queued draft");
    assert.deepEqual(restoredIds, ["q1"]);

    await act(async () => current.setRestoring(true));
    assert.equal(current.restoring, true);
    await mounted.render({ scope: "session-b" });
    assert.equal(current.restoring, false);
  } finally {
    await mounted.cleanup();
  }
});

test("submission hook commits accepted text and restores interrupted text", async () => {
  let current;
  let submitted;
  function Harness() {
    const [draft, setDraft] = useState("hello");
    const [submitting, setSubmitting] = useState(false);
    const [, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const attachmentsRef = useRef([]);
    const transitioningRef = useRef(false);
    const composingRef = useRef(false);
    const submittingRef = useRef(false);
    const submissionRetryRef = useRef(null);
    const mountedRef = useRef(true);
    const historyNavigation = useRef({ index: -1, seed: "" });
    current = {
      draft,
      submitting,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        draftMode: false,
        queued: [],
        recoveryScope: "session-submit",
        textarea,
        draftRef,
        attachmentsRef,
        transitioningRef,
        composingRef,
        submittingRef,
        submissionRetryRef,
        mountedRef,
        historyNavigation,
        setDraft,
        setSubmitting,
        setSubmissionRecoveryVersion,
        clearNotice() {},
        setAttachmentError() {},
        removeAttachments() {},
        mergeRestoredAttachments: (_attachments, text) => text,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: async (content, options) => {
          submitted = { content, options };
          return true;
        },
        abort: async () => ({ restoreText: "interrupted" }),
      }),
    };
    return React.createElement("textarea", { ref: textarea, value: draft, readOnly: true });
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    await act(async () => {
      await current.send();
    });
    assert.equal(submitted.content, "hello");
    assert.ok(submitted.options.id);
    assert.equal(current.draft, "");
    assert.equal(current.submitting, false);

    await act(async () => {
      await current.stop();
    });
    assert.equal(current.draft, "interrupted");
  } finally {
    await mounted.cleanup();
  }
});

test("keyboard hook restores prompt history and inserts project mentions", async () => {
  let current;
  function Harness() {
    const [draft, setDraft] = useState("");
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: "" });
    const historySeedAttachments = useRef([]);
    const attachmentsRef = useRef([]);
    const escapeClearAt = useRef(0);
    const composing = useRef(false);
    const suppressLineBreak = useRef(false);
    const shiftLatch = useRef(false);
    current = {
      draft,
      setDraft,
      textarea,
      ...useComposerKeyboard({
        draft: {
          value: draft,
          set: setDraft,
          ref: draftRef,
          textarea,
          setCaretOffset() {},
        },
        mention: {
          match: { start: 0, end: 0, query: "" },
          open: false,
          signature: "",
          results: [],
          index: 0,
          setIndex() {},
          setDismissed() {},
          setResults() {},
        },
        slash: {
          open: false,
          commands: [],
          index: 0,
          setIndex() {},
          setDismissedDraft() {},
          commandToken: (command) => command?.name || "",
        },
        selector: {
          open: false,
          setOpen() {},
          index: 0,
          setIndex() {},
          messages: [],
          openSelector() {},
          rewindToMessage: async () => {},
        },
        history: {
          entries: [{ text: "previous prompt" }],
          navigation: historyNavigation,
          seedAttachments: historySeedAttachments,
          attachmentsRef,
          replaceAttachments() {},
        },
        queue: {
          pendingSubmissionId: "",
          hasRestorableMessages: () => false,
          restore() {},
        },
        runtime: {
          turnBusy: false,
          draftMode: false,
          attachments: [],
          escapeClearAt,
          showNotice() {},
        },
        ime: { composing, suppressLineBreak, shiftLatch },
        actions: {
          send: async () => {},
          stop: async () => {},
          clearAttachments() {},
        },
      }),
    };
    return React.createElement("textarea", {
      ref: textarea,
      value: draft,
      readOnly: true,
    });
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    const textarea = current.textarea.current;
    textarea.setSelectionRange(0, 0);
    let prevented = false;
    await act(async () => {
      current.onKeyDown({
        key: "ArrowUp",
        currentTarget: textarea,
        nativeEvent: { isComposing: false, keyCode: 38 },
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault: () => { prevented = true; },
        stopPropagation() {},
      });
    });
    assert.equal(prevented, true);
    assert.equal(current.draft, "previous prompt");

    await act(async () => current.setDraft(""));
    await act(async () => current.selectMention("src/App.tsx"));
    assert.equal(current.draft, "@src/App.tsx ");
  } finally {
    await mounted.cleanup();
  }
});

test("a shared payload lands only in the composer the user can see", async () => {
  resetSharedIntake();
  const attached = [];
  const appended = [];
  function Harness({ active }) {
    useComposerShareIntake({
      active,
      attachFiles: (files) => { attached.push(...files); },
      appendText: (text) => { appended.push(text); },
    });
    return React.createElement("div", null);
  }
  const mounted = mountHarness(Harness, { active: false });
  try {
    await mounted.render({ active: false });
    const shared = new File(["bytes"], "screenshot.png", { type: "image/png" });
    await act(async () => publishSharedIntake({ files: [shared], text: "note" }));
    // A pane that is not the visible one must never swallow the share.
    assert.equal(attached.length, 0);
    assert.equal(appended.length, 0);

    // Becoming the visible pane takes the payload that was waiting.
    await mounted.render({ active: true });
    assert.deepEqual(attached.map((file) => file.name), ["screenshot.png"]);
    assert.deepEqual(appended, ["note"]);

    // One payload, one arrival: returning to this composer cannot re-attach it.
    await mounted.render({ active: false });
    await mounted.render({ active: true });
    assert.equal(attached.length, 1);
    assert.equal(appended.length, 1);
  } finally {
    await mounted.cleanup();
    resetSharedIntake();
  }
});
