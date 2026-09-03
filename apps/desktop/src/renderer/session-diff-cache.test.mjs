import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSessionDiff,
  fetchSessionDiffFilePatch,
  peekSessionDiff,
  primeSessionDiff,
  releaseSessionDiff,
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
  primeSessionDiff("cache-delta", RESULT);
  assert.equal(peekSessionDiff("cache-delta")?.patch, PATCH);
  const calls = [];
  stubBackend(calls);
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
