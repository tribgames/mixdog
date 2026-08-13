import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationCoverIdentity,
  sessionListInsertedAtTop,
  nextConversationCoverId,
  sessionListKeepsExistingTopInsert,
  conversationSwitchPaintGate,
  conversationPresentedSessionId,
  nextConversationOriginSessionId,
  conversationMarkdownPending,
} from "./first-submit-stability.ts";
import { mergeSessionCatalogRows } from "../shared/session-catalog.ts";

test("draft promotion keeps the conversation cover key and stays ready", () => {
  const first = conversationCoverIdentity("draft", "");
  assert.deepEqual(first, { coverKey: "draft", promotingFromDraft: false });
  const promoted = conversationCoverIdentity(first.coverKey, "sess_1");
  assert.deepEqual(promoted, { coverKey: "draft", promotingFromDraft: true });
  const settled = conversationCoverIdentity("sess_1", "sess_1");
  assert.deepEqual(settled, { coverKey: "sess_1", promotingFromDraft: false });
});

test("a late lane keeps the draft cover across the promotion rAF", () => {
  const late = conversationCoverIdentity("draft", "sess_1", false);
  assert.deepEqual(late, { coverKey: "draft", promotingFromDraft: true });
  assert.equal(nextConversationCoverId("draft", "sess_1", false), "draft");
  const ready = conversationCoverIdentity("draft", "sess_1", true);
  assert.deepEqual(ready, { coverKey: "draft", promotingFromDraft: false });
  assert.equal(nextConversationCoverId("draft", "sess_1", true), "draft");
  assert.equal(nextConversationCoverId("draft", "sess_1", true, "sess_1"), "draft");
  assert.equal(nextConversationCoverId("draft", "sess_2", true, "sess_1"), "sess_2");
});

test("switching to another session uses a new cover key", () => {
  const next = conversationCoverIdentity("sess_1", "sess_2");
  assert.deepEqual(next, { coverKey: "sess_2", promotingFromDraft: false });
});

test("a pane session swap stays covered until the incoming lane can paint", () => {
  assert.deepEqual(conversationSwitchPaintGate("sess_1", "sess_2", { contentReady: false }), {
    adoptNow: false, reveal: false,
  });
  assert.deepEqual(conversationSwitchPaintGate("sess_1", "sess_2", { contentReady: true }), {
    adoptNow: false, reveal: false,
  });
  assert.deepEqual(conversationSwitchPaintGate("sess_2", "sess_2", { contentReady: true }), {
    adoptNow: true, reveal: true,
  });
});

test("draft promotion and New Task skip the session-switch cover hold", () => {
  assert.deepEqual(conversationSwitchPaintGate("draft", "sess_1", {
    promotingFromDraft: true, contentReady: false,
  }), { adoptNow: true, reveal: true });
  assert.deepEqual(conversationSwitchPaintGate("sess_1", "draft", { contentReady: false }), {
    adoptNow: true, reveal: true,
  });
});

test("a settled first-submit keeps the draft cover and stays revealed", () => {
  assert.deepEqual(conversationSwitchPaintGate("draft", "sess_1", {
    promotingFromDraft: false, contentReady: false,
  }), { adoptNow: true, reveal: true });
  assert.deepEqual(conversationSwitchPaintGate("draft", "sess_1", {
    promotingFromDraft: false, contentReady: true,
  }), { adoptNow: true, reveal: true });
});

test("a draft origin stays until the pane leaves that first session", () => {
  assert.equal(nextConversationOriginSessionId("", ""), "");
  assert.equal(nextConversationOriginSessionId("", "sess_1"), "sess_1");
  assert.equal(nextConversationOriginSessionId("sess_1", "sess_1"), "sess_1");
  assert.equal(nextConversationOriginSessionId("sess_1", "sess_2"), "sess_1");
  assert.equal(nextConversationOriginSessionId("sess_1", ""), "");
});

test("first-submit markdown pending does not unmount a draft-painted timeline", () => {
  assert.equal(conversationMarkdownPending({
    transcriptPending: true, coverId: "draft", hasMeasurements: false,
  }), false);
  assert.equal(conversationMarkdownPending({
    transcriptPending: true, coverId: "sess_2", hasMeasurements: false,
  }), true);
  assert.equal(conversationMarkdownPending({
    transcriptPending: true, coverId: "sess_2", hasMeasurements: true,
  }), false);
});

test("an incoming session keeps the outgoing transcript until its lane is ready", () => {
  assert.equal(conversationPresentedSessionId("sess_1", "sess_2", { incomingReady: false }), "sess_1");
  assert.equal(conversationPresentedSessionId("sess_1", "sess_2", { incomingReady: true }), "sess_2");
  assert.equal(conversationPresentedSessionId("sess_1", "sess_2", {
    promotingFromDraft: true, incomingReady: false,
  }), "sess_2");
});

test("a first-submit catalog row is a top insert", () => {
  assert.equal(sessionListInsertedAtTop(["b", "c"], ["a", "b", "c"]), true);
  assert.equal(sessionListInsertedAtTop([], ["a"]), true);
  assert.equal(sessionListInsertedAtTop(["b", "c"], ["a", "c", "b"]), false);
  assert.equal(sessionListInsertedAtTop(["a", "b"], ["a", "b", "c"]), false);
});

test("a first-submit catalog row already at the top is not a reorder", () => {
  assert.equal(sessionListKeepsExistingTopInsert(["a", "b", "c"], ["b", "c", "a"]), true);
  assert.equal(sessionListKeepsExistingTopInsert(["a", "b", "c"], ["a", "b", "c"]), false);
  assert.equal(sessionListKeepsExistingTopInsert(["a", "b", "c"], ["a", "c", "b"]), false);
  assert.equal(sessionListKeepsExistingTopInsert(["a"], ["a"]), false);
});

test("merge keeps a staged top insert when the host list moves it", () => {
  const staged = {
    id: "a",
    title: "A",
    preview: "A",
    updatedAt: 2,
    activityAt: 2,
    messageCount: 1,
    cwd: "",
    classification: "task",
    projectPath: null,
    working: true,
  };
  const older = {
    id: "b",
    title: "B",
    preview: "B",
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: "",
    classification: "task",
    projectPath: null,
    working: false,
  };
  const merged = mergeSessionCatalogRows([staged, older], [{ ...older }, { ...staged, messageCount: 2 }]);
  assert.deepEqual(merged.map((row) => row.id), ["a", "b"]);
  assert.equal(merged[0].messageCount, 2);
});
