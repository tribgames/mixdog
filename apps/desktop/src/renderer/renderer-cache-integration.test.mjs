import assert from "node:assert/strict";
import test from "node:test";
import { enforceRendererCacheBudget } from "./renderer-cache-budget.ts";
import { createSessionSnapshotCache } from "./app-session-snapshots.ts";
import { primeSessionDiff, peekSessionDiff } from "./session-diff-cache.ts";
import { parseStreamingMarkdownAst, readCachedStreamingMarkdownAst } from "./markdown-worker-client.ts";
import { rememberAgentReviews, leadReviewCache, agentReviewCache, leadReviewFilesCache } from "./turn-review-cache.ts";

test("shared pressure releases snapshots, diffs, markdown and complete review groups", async () => {
  globalThis.window = { mixdogDesktop: {} };
  const cache = createSessionSnapshotCache();
  try {
    cache.remember({ sessionId: "s", transcript: [{ text: "snapshot" }] });
    primeSessionDiff("s", { patch: "diff", files: [] });
    await parseStreamingMarkdownAst("**markdown**");
    rememberAgentReviews("review", [], "lead", [{ path: "a.ts" }], "git", "checkpoint");
    assert.ok(cache.get("s"));
    assert.ok(peekSessionDiff("s"));
    assert.ok(readCachedStreamingMarkdownAst("**markdown**"));
    assert.equal(leadReviewCache.get("review"), "lead");
    assert.equal(enforceRendererCacheBudget(0), 0);
    assert.equal(cache.get("s"), null);
    assert.equal(peekSessionDiff("s"), null);
    assert.equal(readCachedStreamingMarkdownAst("**markdown**"), null);
    assert.equal(leadReviewCache.has("review"), false);
    assert.equal(agentReviewCache.has("review"), false);
    assert.equal(leadReviewFilesCache.has("review"), false);
  } finally { cache.dispose(); delete globalThis.window; }
});
