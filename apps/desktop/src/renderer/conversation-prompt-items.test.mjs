import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopPromptDisplayText,
  nextDesktopSubmissionId,
  pendingPromptImages,
  pendingPromptTranscriptItems,
  promptWaitsBehindActiveTurn,
  settledUserRowCount,
  unsettledQueueEntries,
} from "./conversation-prompt-items.ts";

test("settledUserRowCount counts user rows correctly", () => {
  assert.equal(settledUserRowCount([]), 0);
  assert.equal(
    settledUserRowCount([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello" },
      { kind: "tool", text: "run" },
      { kind: "user", text: "do something" },
    ]),
    2,
  );
});

test("nextDesktopSubmissionId mints unique id tokens", () => {
  const id1 = nextDesktopSubmissionId();
  const id2 = nextDesktopSubmissionId();
  assert.ok(id1.startsWith("desktop-submit-"));
  assert.ok(id2.startsWith("desktop-submit-"));
  assert.notEqual(id1, id2);
});

test("desktopPromptDisplayText extracts display text or fallbacks", () => {
  assert.equal(
    desktopPromptDisplayText("simple prompt"),
    "simple prompt",
  );
  assert.equal(
    desktopPromptDisplayText("fallback", { displayText: "override text" }),
    "override text",
  );
  assert.equal(
    desktopPromptDisplayText([
      { type: "text", text: "Look at this:" },
      { type: "image", filename: "screenshot.png" },
      { type: "file", filename: "doc.txt" },
    ]),
    "Look at this:\n[Image]\n[File: doc.txt]",
  );
});

test("pendingPromptImages maps pasted images options into transcript image structures", () => {
  const result = pendingPromptImages({
    pastedImages: {
      img1: {
        id: "img1",
        filename: "test.png",
        mediaType: "image/png",
        sizeBytes: 1024,
      },
      img2: {
        id: "img2",
        mediaType: "image/jpeg",
        content: "base64data",
      },
    },
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    id: "img1",
    name: "test.png",
    mimeType: "image/png",
    bytes: 1024,
  });
  assert.deepEqual(result[1], {
    id: "img2",
    name: "Image",
    mimeType: "image/jpeg",
    bytes: 10,
  });
});

test("pendingPromptTranscriptItems holds optimistic items until own durable row settles", () => {
  const optimistic = [
    {
      id: "submit-1",
      kind: "user",
      text: "hello world",
      pending: true,
      accepted: false,
      submittedAt: 100,
      settledUserBaseline: 0,
    },
  ];

  // 1. Unsettled: holds optimistic item
  const pending = pendingPromptTranscriptItems(optimistic, []);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "submit-1");
  assert.equal(pending[0].pending, true);

  // 2. Settled by exact id
  const settledWithId = [{ id: "submit-1", kind: "user", text: "hello world" }];
  const releasedById = pendingPromptTranscriptItems(optimistic, settledWithId);
  assert.equal(releasedById.length, 0);

  // 3. Settled by baseline count safety net when id is rewritten
  const settledRenamed = [{ id: "runtime-uuid-99", kind: "user", text: "hello world" }];
  const releasedByBaseline = pendingPromptTranscriptItems(optimistic, settledRenamed);
  assert.equal(releasedByBaseline.length, 0);
});

test("promptWaitsBehindActiveTurn checks active/queued state unless in draft mode", () => {
  assert.equal(promptWaitsBehindActiveTurn(true, { busy: true, queued: [] }), false);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: true, queued: [] }), true);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: false, queued: [{ id: "q1" }] }), true);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: false, queued: [] }), false);
});

test("unsettledQueueEntries filters out entries whose durable row already settled", () => {
  const settled = [
    { id: "msg-1", kind: "user", text: "first" },
  ];
  const queue = [
    { id: "msg-1", text: "first" },
    { id: "msg-2", text: "second" },
  ];
  const filtered = unsettledQueueEntries(queue, settled);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "msg-2");
});
