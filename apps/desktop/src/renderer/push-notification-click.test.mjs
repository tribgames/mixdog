import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_STATE_CACHE_NAME,
  NOTIFICATION_CLICK_ENTRY,
  NOTIFICATION_CLICK_TTL_MS,
  UI_LANGUAGE_ENTRY,
  claimNotificationClick,
  clearNotificationClick,
  publishUiLanguage,
} from "./push-notification-bridge";
import { WORKER_ORIGIN, loadWorker, memoryCacheStorage } from "./sw-test-harness.mjs";

/** Drive the worker's real listeners, as a device would. */
function tap(worker, sessionId) {
  let settled;
  worker.listeners.get("notificationclick")({
    notification: { close() {}, data: { sessionId } },
    waitUntil: (promise) => { settled = promise; },
  });
  return settled;
}

function push(worker, payload) {
  let settled;
  worker.listeners.get("push")({
    data: { json: () => payload },
    waitUntil: (promise) => { settled = promise; },
  });
  return settled;
}

async function launchFrom(worker, path) {
  let responded;
  let settled;
  worker.listeners.get("fetch")({
    request: { url: `${WORKER_ORIGIN}${path}`, mode: "navigate", method: "GET" },
    respondWith: (promise) => { responded = promise; },
    waitUntil: (promise) => { settled = promise; },
  });
  await responded;
  await settled;
}

test("the worker and the app name the same shared state", () => {
  const worker = loadWorker({ caches: memoryCacheStorage() });

  assert.equal(worker.APP_STATE_CACHE, APP_STATE_CACHE_NAME);
  assert.equal(worker.UI_LANGUAGE_ENTRY, UI_LANGUAGE_ENTRY);
  assert.equal(worker.NOTIFICATION_CLICK_ENTRY, NOTIFICATION_CLICK_ENTRY);
  assert.equal(worker.NOTIFICATION_CLICK_TTL_MS, NOTIFICATION_CLICK_TTL_MS);
});

test("a tap with nothing running opens the route the app was installed at", async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  // The install lives under a device route; the bare origin is a different
  // container that would only reach the pairing gate.
  await launchFrom(worker, "/d/9f8e7d6c5b4a/");
  await tap(worker, "session-42");

  assert.deepEqual(worker.opened, ["/d/9f8e7d6c5b4a/?session=session-42"]);
});

test("a plain install still opens the origin", async () => {
  const worker = loadWorker({ caches: memoryCacheStorage() });
  await launchFrom(worker, "/");
  await tap(worker, "session-42");

  assert.deepEqual(worker.opened, ["/?session=session-42"]);
});

test("a running app is focused and told directly", async () => {
  const posted = [];
  let focused = 0;
  const worker = loadWorker({
    caches: memoryCacheStorage(),
    windows: [{
      url: `${WORKER_ORIGIN}/d/9f8e7d6c5b4a/`,
      focus: async () => { focused += 1; },
      postMessage: (message) => posted.push(message),
    }],
  });
  await tap(worker, "session-42");

  assert.equal(focused, 1);
  assert.deepEqual(posted.map((message) => message.sessionId), ["session-42"]);
  assert.deepEqual(worker.opened, []);
});

test("a tap survives a phone that rebuilt the app around it", async () => {
  const caches = memoryCacheStorage();
  // The window is focused and posted to, but that document was discarded and
  // is still booting: nothing is listening yet.
  const worker = loadWorker({
    caches,
    windows: [{
      url: `${WORKER_ORIGIN}/d/9f8e7d6c5b4a/`,
      focus: async () => undefined,
      postMessage: () => undefined,
    }],
  });
  await tap(worker, "session-42");

  assert.equal(await claimNotificationClick({ caches }), "session-42");
  // One tap, one navigation.
  assert.equal(await claimNotificationClick({ caches }), "");
});

test("a tap the app already handled is retired", async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  await tap(worker, "session-42");
  await clearNotificationClick({ caches });

  assert.equal(await claimNotificationClick({ caches }), "");
});

test("a stale tap opens nothing", async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  await tap(worker, "session-42");

  assert.equal(
    await claimNotificationClick({ caches, now: Date.now() + NOTIFICATION_CLICK_TTL_MS + 1 }),
    "",
  );
});

test("a turn with no text speaks the language the app published", async () => {
  const caches = memoryCacheStorage();
  await publishUiLanguage("ko", { caches });
  const worker = loadWorker({ caches, systemLanguage: "en-US" });
  await push(worker, { title: "Refactor", body: "", data: { sessionId: "session-42" } });

  assert.equal(worker.shown[0].options.body, "작업을 마쳤습니다.");
});

test("a phone that never launched the app falls back to its own language", async () => {
  const worker = loadWorker({ caches: memoryCacheStorage(), systemLanguage: "ja-JP" });
  await push(worker, { title: "Refactor", body: "", data: { sessionId: "session-42" } });

  assert.equal(worker.shown[0].options.body, "作業が完了しました。");
});

test("what the session actually said is never translated", async () => {
  const caches = memoryCacheStorage();
  await publishUiLanguage("ko", { caches });
  const worker = loadWorker({ caches, systemLanguage: "ko-KR" });
  await push(worker, { title: "Refactor", body: "Applied 3 edits.", data: { sessionId: "s" } });

  assert.equal(worker.shown[0].options.body, "Applied 3 edits.");
});
