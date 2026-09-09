import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptRouteMetadata } from "../../../../src/runtime/shared/transcript-metadata.mjs";
import { shouldOfferSessionInheritance } from "./session-inheritance.ts";
import { createLifecycleApi } from "../../../../src/session-runtime/lifecycle-api.mjs";
import { restoreTranscriptItems } from "../../../../src/tui/session/session-api-ext.mjs";

const snapshotFor = (route, previous) => ({
  sessionId: "inheritance-route",
  ...route,
  items: [{ kind: "assistant", text: "Done.", ...previous }],
});

test("session inheritance keeps the same model compactable for new and legacy transcripts", () => {
  for (const route of [
    { provider: "anthropic-oauth", model: "claude-fable-5-1" },
    { provider: "openai-oauth", model: "gpt-6-astra" },
    { provider: "gemini", model: "gemini-3-pro" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "openrouter", model: "anthropic/claude-opus-4-8" },
  ]) {
    const metadata = createTranscriptRouteMetadata(route, {}, 1);
    const { modelId, ...legacy } = metadata;
    for (const previous of [metadata, legacy, { ...route }, { model: legacy.model }]) {
      assert.equal(shouldOfferSessionInheritance(snapshotFor(route, previous)), false,
        JSON.stringify({ route, previous }));
    }
  }
});

test("session inheritance detects real model and provider changes for both record formats", () => {
  const previousRoute = { provider: "anthropic-oauth", model: "claude-fable-5-1" };
  const metadata = createTranscriptRouteMetadata(previousRoute, {}, 1);
  const { modelId, ...legacy } = metadata;
  for (const previous of [metadata, legacy]) {
    for (const route of [
      { ...previousRoute, model: "claude-opus-4-8" },
      { ...previousRoute, provider: "anthropic" },
    ]) {
      assert.equal(shouldOfferSessionInheritance(snapshotFor(route, previous)), true);
    }
  }
});

test("session inheritance uses exact IDs when different routes share a display label", () => {
  const previousRoute = { provider: "openrouter", model: "vendor-a/shared-model" };
  const metadata = createTranscriptRouteMetadata(previousRoute, {}, 1);
  assert.equal(shouldOfferSessionInheritance(snapshotFor({
    ...previousRoute, model: "vendor-b/shared-model",
  }, metadata)), true);
  assert.equal(shouldOfferSessionInheritance(snapshotFor(previousRoute, {
    ...metadata, model: "A renamed display label",
  })), false);
  assert.equal(shouldOfferSessionInheritance(snapshotFor(previousRoute, {
    provider: metadata.provider, modelId: metadata.modelId,
  })), false);
});

test("session inheritance compares only the addressed session's latest recorded route", () => {
  const route = { provider: "anthropic-oauth", model: "claude-fable-5-1" };
  const metadata = createTranscriptRouteMetadata(route, {}, 1);
  const same = snapshotFor(route, metadata);
  const changed = { ...same, sessionId: "another-session", model: "claude-opus-4-8" };
  assert.equal(shouldOfferSessionInheritance(same), false);
  assert.equal(shouldOfferSessionInheritance(changed), true);
  assert.equal(shouldOfferSessionInheritance({
    ...changed,
    items: [...changed.items, {
      kind: "assistant", ...createTranscriptRouteMetadata(changed, {}, 2),
    }],
  }), false);
  assert.equal(shouldOfferSessionInheritance(same), false);
  assert.equal(shouldOfferSessionInheritance({ ...same, items: [] }), false);
  assert.equal(shouldOfferSessionInheritance({ ...same, model: "" }), false);
});

test("successful inheritance restores its boundary and offers compact before the first new answer", async () => {
  const source = {
    id: "source", provider: "anthropic-oauth", model: "claude-fable-5-1",
    messages: [
      { role: "user", content: "Continue my work." },
      { role: "assistant", content: "Previous answer.", meta: { transcript: {
        provider: "anthropic-oauth", modelId: "claude-fable-5-1",
      } } },
    ],
  };
  const original = structuredClone(source);
  const target = {
    id: "heir", provider: "openai-oauth", model: "gpt-6-astra",
    messages: [{ role: "system", content: "Target instructions." }],
  };
  let persisted;
  const api = createLifecycleApi({
    getSession: () => target,
    mgr: { getSession: () => source },
    invalidateContextStatusCache() {},
    computeContextStatus: () => ({ usedTokens: 100, contextWindow: 10000 }),
    saveSession: (session) => { persisted = JSON.parse(JSON.stringify(session)); },
  });
  await api.inheritFrom(source.id);
  assert.deepEqual(source, original);
  assert.deepEqual(target.messages.map(({ role, content }) => ({ role, content })), [
    { role: "system", content: "Target instructions." },
    ...source.messages.map(({ role, content }) => ({ role, content })),
  ]);
  for (const messages of [target.messages, persisted.messages]) {
    const items = restoreTranscriptItems(messages, { sessionId: target.id });
    assert.equal(items.at(-1).status, "inherited");
    assert.equal(items.filter((item) => item.status === "inherited").length, 1);
    assert.equal(items.find((item) => item.kind === "assistant").modelId, source.model);
    const snapshot = { ...target, sessionId: target.id, items };
    assert.equal(shouldOfferSessionInheritance(snapshot), false);
    assert.equal(shouldOfferSessionInheritance({ ...snapshot, model: "another-model" }), true);
    assert.equal(shouldOfferSessionInheritance({
      ...snapshot, items: [...items, { kind: "assistant", provider: "gemini", modelId: "gemini-3-pro" }],
    }), true);
    assert.equal(restoreTranscriptItems(messages, { sessionId: target.id, itemLimit: 1 })[0].status, "inherited");
  }
});

test("rejected inheritance does not persist or display a successful boundary", async () => {
  const target = { id: "heir", provider: "openai", model: "small", messages: [] };
  let saved = false;
  const api = createLifecycleApi({
    getSession: () => target,
    mgr: { getSession: () => ({
      id: "source", messages: [{ role: "user", content: "Too large." }],
    }) },
    invalidateContextStatusCache() {},
    computeContextStatus: () => ({ usedTokens: 200, contextWindow: 100 }),
    saveSession: () => { saved = true; },
  });
  await assert.rejects(api.inheritFrom("source"), /full conversation needs/);
  assert.equal(saved, false);
  assert.deepEqual(target.messages, []);
  assert.deepEqual(restoreTranscriptItems(target.messages), []);
});
