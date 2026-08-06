import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  releaseHiddenSessionStateEntries,
} from "../main/state-delta.ts";
import {
  IMAGE_PREVIEW_CACHE_MAX_CHARS,
  _resetImagePreviewCacheForTest,
  imagePreviewCache,
  registerImagePreview,
} from "./transcript-metrics.ts";
import {
  _bootMetricStatsForTest,
  _resetBootMetricsForTest,
  reportBootSurfaceStage,
} from "./boot-metrics.ts";

test("hidden session transport entries are released across every retention map", () => {
  const encoders = new Map([["visible", { id: 1 }], ["hidden", { id: 2 }]]);
  const snapshots = new Map([["visible", { items: [] }], ["hidden", { items: [{ text: "large" }] }]]);
  const releasedBeforeDelete = [];
  const released = releaseHiddenSessionStateEntries(
    new Set(["visible"]),
    [encoders, snapshots],
    (sessionId) => releasedBeforeDelete.push([sessionId, encoders.has(sessionId)]),
  );
  assert.deepEqual(released, ["hidden"]);
  assert.deepEqual(releasedBeforeDelete, [["hidden", true]]);
  assert.equal(encoders.has("hidden"), false);
  assert.equal(snapshots.has("hidden"), false);
  assert.equal(encoders.has("visible"), true);
});

test("submitted image previews obey the aggregate character budget", () => {
  _resetImagePreviewCacheForTest();
  for (let index = 0; index < 4; index += 1) {
    registerImagePreview(index, 9 * 1024 * 1024, `data:image/png;base64,${index}${"x".repeat(9 * 1024 * 1024)}`);
  }
  const retained = [...imagePreviewCache.values()]
    .reduce((total, value) => total + value.length, 0);
  assert.ok(retained <= IMAGE_PREVIEW_CACHE_MAX_CHARS);
  assert.ok(imagePreviewCache.size < 4);
  _resetImagePreviewCacheForTest();
});

test("boot surface diagnostics retain only a bounded completed history", () => {
  _resetBootMetricsForTest();
  for (let index = 0; index < 300; index += 1) {
    reportBootSurfaceStage("editor", `C:/project/${index}.mjs`, "ready");
  }
  assert.ok(_bootMetricStatsForTest().surfaceCount <= 256);
  _resetBootMetricsForTest();
});

test("desktop large-object caches and transports expose explicit memory guards", async () => {
  const [transcript, review, backend, utility, ipc] = await Promise.all([
    readFile(new URL("./TranscriptView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./TurnReview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../main/desktop-backend.ts", import.meta.url), "utf8"),
    readFile(new URL("../main/utility-engine-host.ts", import.meta.url), "utf8"),
    readFile(new URL("../main/ipc.ts", import.meta.url), "utf8"),
  ]);
  assert.match(transcript, /PATCH_CACHE_MAX_CHARS/);
  assert.match(review, /TURN_REVIEW_PATCH_CACHE_MAX_CHARS/);
  assert.match(review, /AGENT_REVIEW_CACHE_MAX_CHARS/);
  for (const source of [backend, utility, ipc]) {
    assert.match(source, /releaseHiddenSessionStateEntries/);
  }
});
