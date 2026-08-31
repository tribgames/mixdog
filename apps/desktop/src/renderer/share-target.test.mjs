import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WORKER_ORIGIN, loadWorker, memoryCacheStorage } from "./sw-test-harness.mjs";

const {
  SHARE_CACHE_NAME,
  SHARE_CLAIM_PARAM,
  SHARE_ENTRY_PREFIX,
  SHARE_INDEX_NAME,
  claimSharedIntake,
  publishSharedIntake,
  readSharedIntake,
  resetSharedIntake,
  subscribeSharedIntake,
} = await import("./share-target-intake.ts");
const { dataTransferHasDroppableFiles } = await import("./file-drag.ts");

const DEVICE_ROUTE = "/d/device-a/";

function shareRequest(fields, route = DEVICE_ROUTE) {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  return new Request(`${WORKER_ORIGIN}${route}share-target`, { method: "POST", body: form });
}

test("a shared screenshot reaches the composer intake through the app's own cache", async () => {
  const caches = memoryCacheStorage();
  const { receiveSharedPayload } = loadWorker({ caches });

  const redirect = await receiveSharedPayload(shareRequest([
    ["title", "Screenshot"],
    ["files", new File(["screenshot-bytes"], "screenshot.png", { type: "image/png" })],
  ]));

  assert.equal(redirect.status, 303);
  const reopened = new URL(redirect.headers.get("location"));
  // The share reopens the SAME device route the app was installed from.
  assert.equal(reopened.pathname, DEVICE_ROUTE);
  const token = reopened.searchParams.get(SHARE_CLAIM_PARAM);
  assert.ok(token);

  const intake = await readSharedIntake({
    caches,
    href: reopened.toString(),
    replaceUrl: () => {},
  });
  assert.equal(intake.text, "Screenshot");
  assert.equal(intake.files.length, 1);
  assert.equal(intake.files[0].name, "screenshot.png");
  assert.equal(intake.files[0].type, "image/png");
  assert.equal(await intake.files[0].text(), "screenshot-bytes");
});

test("a claimed payload is spent once and leaves no copy in storage", async () => {
  const caches = memoryCacheStorage();
  const { receiveSharedPayload } = loadWorker({ caches });
  const redirect = await receiveSharedPayload(shareRequest([
    ["files", new File(["bytes"], "shot.png", { type: "image/png" })],
  ]));
  const href = redirect.headers.get("location");

  const addresses = [];
  const first = await readSharedIntake({
    caches,
    href,
    replaceUrl: (next) => addresses.push(next),
  });
  assert.equal(first.files.length, 1);
  // The spent token leaves the address, so a reload cannot re-attach it.
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].includes(SHARE_CLAIM_PARAM), false);

  const again = await readSharedIntake({ caches, href, replaceUrl: () => {} });
  assert.equal(again, null);
  assert.equal(caches.peek(SHARE_CACHE_NAME).size, 0);
});

test("a payload no launch ever claimed expires when the next share arrives", async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  const cache = await caches.open(worker.SHARE_CACHE);
  const stale = `${worker.SHARE_ENTRY_PREFIX}stale/`;
  await cache.put(`${stale}0`, new Response("old"));
  await cache.put(`${stale}${worker.SHARE_INDEX_NAME}`, new Response(JSON.stringify({
    createdAt: Date.now() - worker.SHARE_ENTRY_TTL_MS - 1_000,
    text: "",
    files: [{ url: `${stale}0`, name: "old.png", type: "image/png" }],
  })));

  await worker.receiveSharedPayload(shareRequest([
    ["files", new File(["fresh"], "fresh.png", { type: "image/png" })],
  ]));

  const keys = (await cache.keys()).map((key) => key.url);
  assert.equal(keys.some((url) => url.includes("/stale/")), false);
  assert.equal(keys.length, 2);
});

test("a shared link arrives as composer text with nothing attached", async () => {
  const caches = memoryCacheStorage();
  const { receiveSharedPayload } = loadWorker({ caches });
  const redirect = await receiveSharedPayload(shareRequest([
    ["title", "Mixdog"],
    ["url", "https://mixdog.example/docs"],
  ]));

  const intake = await readSharedIntake({
    caches,
    href: redirect.headers.get("location"),
    replaceUrl: () => {},
  });
  assert.equal(intake.files.length, 0);
  assert.equal(intake.text, "Mixdog https://mixdog.example/docs");
});

test("an empty share reopens the app without a claim token", async () => {
  const caches = memoryCacheStorage();
  const { receiveSharedPayload } = loadWorker({ caches });
  const redirect = await receiveSharedPayload(shareRequest([["text", "   "]]));

  const reopened = new URL(redirect.headers.get("location"));
  assert.equal(reopened.pathname, DEVICE_ROUTE);
  assert.equal(reopened.searchParams.get(SHARE_CLAIM_PARAM), null);
});

test("the worker answers the share POST and leaves every other POST on the network", async () => {
  const caches = memoryCacheStorage();
  const { listeners } = loadWorker({ caches });
  const onFetch = listeners.get("fetch");
  let answered;
  const event = (request) => ({
    request,
    respondWith(value) { answered = value; },
    waitUntil() {},
  });

  answered = undefined;
  onFetch(event(shareRequest([
    ["files", new File(["bytes"], "shot.png", { type: "image/png" })],
  ])));
  assert.ok(answered);
  assert.equal((await answered).status, 303);

  // Live host traffic must never be intercepted.
  answered = undefined;
  onFetch(event(new Request(`${WORKER_ORIGIN}/client`, { method: "POST", body: "{}" })));
  assert.equal(answered, undefined);
});

test("one shared payload lands in exactly one composer", () => {
  resetSharedIntake();
  const taken = [];
  const consume = () => {
    const intake = claimSharedIntake();
    if (intake) taken.push(intake);
  };
  const stopFirst = subscribeSharedIntake(consume);
  const stopSecond = subscribeSharedIntake(consume);
  try {
    publishSharedIntake({ files: [], text: "shared note" });
    assert.equal(taken.length, 1);
    assert.equal(taken[0].text, "shared note");
    assert.equal(claimSharedIntake(), null);
  } finally {
    stopFirst();
    stopSecond();
    resetSharedIntake();
  }
});

test("the installed app advertises a file share target the worker answers", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("./public/manifest.webmanifest", import.meta.url),
    "utf8",
  ));
  const target = manifest.share_target;
  assert.equal(target.method, "POST");
  assert.equal(target.enctype, "multipart/form-data");
  assert.equal(target.params.files[0].name, "files");
  assert.equal(target.params.files[0].accept.includes("image/*"), true);

  const worker = loadWorker({ caches: memoryCacheStorage() });
  // Bare scope and device route both reach the worker's share handler.
  assert.equal(worker.SHARE_TARGET_PATH.test(target.action), true);
  assert.equal(
    worker.SHARE_TARGET_PATH.test(`${DEVICE_ROUTE}${target.action.replace(/^\/+/, "")}`),
    true,
  );
  // Worker and app are separate scripts; a disagreement here loses the payload
  // between them.
  assert.equal(worker.SHARE_CACHE, SHARE_CACHE_NAME);
  assert.equal(worker.SHARE_ENTRY_PREFIX, SHARE_ENTRY_PREFIX);
  assert.equal(worker.SHARE_INDEX_NAME, SHARE_INDEX_NAME);
});

test("an image dragged from another app is accepted without the desktop Files marker", () => {
  assert.equal(dataTransferHasDroppableFiles({ types: ["Files"], items: [] }), true);
  // A mobile browser announces the MIME type and exposes the payload only as
  // a file item.
  assert.equal(
    dataTransferHasDroppableFiles({ types: ["image/png"], items: [{ kind: "file" }] }),
    true,
  );
  // Dragging selected text stays a text drag.
  assert.equal(
    dataTransferHasDroppableFiles({ types: ["text/plain"], items: [{ kind: "string" }] }),
    false,
  );
});
