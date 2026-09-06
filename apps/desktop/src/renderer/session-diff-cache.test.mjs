import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSessionDiff,
  fetchSessionDiffFilePatch,
  peekSessionDiff,
  primeSessionDiff,
  releaseSessionDiff,
  SESSION_DIFF_CACHE_MAX_CHARS,
} from "./session-diff-cache.ts";

const PATCH = [
  "diff --git a/src/owned.ts b/src/owned.ts",
  "--- a/src/owned.ts",
  "+++ b/src/owned.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const RESULT = {
  supported: true,
  files: [{ path: "src/owned.ts", status: "M", additions: 1, deletions: 1 }],
  patch: PATCH,
};

function stubBackend(calls) {
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: async ({ sessionId }) => {
        calls.push(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { value: { ...RESULT } };
      },
    },
  };
}

test("concurrent callers share one backend round-trip", async () => {
  const calls = [];
  stubBackend(calls);
  const [first, second] = await Promise.all([
    fetchSessionDiff("cache-alpha", { force: true }),
    fetchSessionDiff("cache-alpha", { force: true }),
  ]);
  assert.deepEqual(calls, ["cache-alpha"]);
  assert.equal(first.patch, PATCH);
  assert.equal(second.patch, PATCH);
});

test("a settled result answers without a round-trip unless forced", async () => {
  const calls = [];
  stubBackend(calls);
  await fetchSessionDiff("cache-beta", { force: true });
  assert.equal(calls.length, 1);
  assert.equal(peekSessionDiff("cache-beta")?.patch, PATCH);
  await fetchSessionDiff("cache-beta");
  assert.equal(calls.length, 1);
  await fetchSessionDiff("cache-beta", { force: true });
  assert.equal(calls.length, 2);
});

test("a file slice reuses the shared result", async () => {
  const calls = [];
  stubBackend(calls);
  await fetchSessionDiff("cache-gamma", { force: true });
  const slice = await fetchSessionDiffFilePatch("cache-gamma", "src/owned.ts");
  assert.match(slice, /\+new/);
  assert.equal(calls.length, 1);
});

test("prime/peek/release manage the cache without the backend", async () => {
  const calls = [];
  stubBackend(calls);
  primeSessionDiff("cache-delta", RESULT);
  assert.equal(peekSessionDiff("cache-delta")?.patch, PATCH);
  await fetchSessionDiff("cache-delta");
  assert.equal(calls.length, 0);
  releaseSessionDiff("cache-delta");
  assert.equal(peekSessionDiff("cache-delta"), null);
});

test("a blank session never reaches the backend", async () => {
  const calls = [];
  stubBackend(calls);
  const result = await fetchSessionDiff("   ");
  assert.equal(result.supported, false);
  assert.equal(calls.length, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("deleting a session fences its pending diff completion", async () => {
  const gate = deferred();
  globalThis.window = { mixdogDesktop: { invokeCapability: () => gate.promise } };
  const pending = fetchSessionDiff("deleted");
  releaseSessionDiff("deleted");
  gate.resolve({ value: RESULT });
  assert.equal((await pending).patch, PATCH);
  assert.equal(peekSessionDiff("deleted"), null);
});

test("an older completion or failure never replaces or releases a newer request", async () => {
  for (const failOld of [false, true]) {
    const old = deferred(), fresh = deferred();
    let calls = 0;
    globalThis.window = { mixdogDesktop: { invokeCapability: () => (++calls === 1 ? old : fresh).promise } };
    const before = fetchSessionDiff("race");
    const observed = before.catch(() => null);
    releaseSessionDiff("race");
    const after = fetchSessionDiff("race");
    if (failOld) old.reject(new Error("old failure"));
    else old.resolve({ value: { ...RESULT, patch: "old" } });
    await observed;
    assert.equal(fetchSessionDiff("race"), after);
    fresh.resolve({ value: { ...RESULT, patch: "new" } });
    await after;
    assert.equal(peekSessionDiff("race").patch, "new");
  }
});

test("oversized diffs are delivered without being retained", async () => {
  const result = { ...RESULT, patch: "x".repeat(SESSION_DIFF_CACHE_MAX_CHARS + 1) };
  globalThis.window = { mixdogDesktop: { invokeCapability: async () => ({ value: result }) } };
  assert.equal((await fetchSessionDiff("large")).patch, result.patch);
  assert.equal(peekSessionDiff("large"), null);
});
