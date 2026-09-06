import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createSessionLaneStore } from "./session-lane-store.ts";

const decorator = { decorate: (snapshot) => snapshot, clear() {} };
function update(store, sessionId, text = "") {
  const snapshot = { sessionId, items: text ? [{ id: "answer", text }] : [] };
  store.apply({ sessionId, snapshot, frameSource: "live" });
  return snapshot;
}

test("a grown lane stays mounted until its last pane closes, then releases an oversized frame", () => {
  const store = createSessionLaneStore({ maxBytes: 4_096, decorator });
  const first = store.subscribe("large", () => {});
  const second = store.subscribe("large", () => {});
  update(store, "large");
  const large = update(store, "large", "x".repeat(32_000));
  first();
  assert.equal(store.get("large"), large);
  second();
  assert.equal(store.get("large"), null);
  assert.deepEqual(store.stats(), { entries: 0, estimatedBytes: 0, subscribedSessions: 0, notificationKeys: 0 });
});

test("an oversized release does not evict another useful small cached lane", () => {
  const store = createSessionLaneStore({ maxBytes: 4_096, decorator });
  const small = update(store, "small", "keep");
  const close = store.subscribe("large", () => {});
  update(store, "large");
  update(store, "large", "x".repeat(32_000));
  close();
  assert.equal(store.get("small"), small);
  assert.equal(store.get("large"), null);
  store.clear();
});

test("a released callback cannot unsubscribe a replacement pane", () => {
  const store = createSessionLaneStore({ decorator });
  const old = store.subscribe("same", () => {});
  old();
  let calls = 0;
  const current = store.subscribe("same", () => { calls += 1; });
  old();
  update(store, "same");
  assert.equal(calls, 1);
  assert.deepEqual(store.subscribedSessionIds(), ["same"]);
  current();
  store.clear();
});

test("repeated pane open/grow/close cycles release snapshots, subscriptions and frame work", {
  skip: typeof globalThis.gc !== "function",
}, async () => {
  const store = createSessionLaneStore({ maxEntries: 64, maxBytes: 4_096, decorator });
  const refs = [];
  for (let index = 0; index < 2_000; index += 1) {
    const id = `cycle-${index}`;
    const close = store.subscribe(id, () => {});
    update(store, id);
    refs.push(new WeakRef(update(store, id, `message-${index} ${"x".repeat(8_000)}`)));
    close();
  }
  assert.deepEqual(store.stats(), { entries: 0, estimatedBytes: 0, subscribedSessions: 0, notificationKeys: 0 });
  for (let index = 0; index < 3; index += 1) {
    await setImmediate();
    globalThis.gc();
  }
  assert.ok(refs.every((ref) => !ref.deref()), "a live store must not pin closed oversized snapshots");
  store.clear();
});
