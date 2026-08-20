import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueRemoteClientClaim,
  normalizeRemoteClientClaim,
  pruneRemoteClientClaims,
  REMOTE_CLAIM_FALLBACK_LIFETIME_MS,
} from "./remote-claim-queue.ts";

const now = 1_000_000;

function claim(overrides = {}) {
  return {
    claimId: "claim-a",
    clientId: "client-a",
    name: "Phone",
    platform: "Android",
    browser: "Chrome",
    expiresAt: now + 10_000,
    ...overrides,
  };
}

test("normalizes legacy claims with a bounded fallback lifetime", () => {
  const normalized = normalizeRemoteClientClaim({
    claimId: "legacy",
    name: "Phone",
  }, now);
  assert.deepEqual(normalized, {
    claimId: "legacy",
    clientId: "legacy",
    name: "Phone",
    platform: "",
    browser: "",
    expiresAt: now + REMOTE_CLAIM_FALLBACK_LIFETIME_MS,
  });
  assert.equal(normalizeRemoteClientClaim(claim({ expiresAt: now }), now), null);
});

test("a newer request from the same client replaces its existing card", () => {
  const existing = claim();
  const unrelated = claim({ claimId: "claim-b", clientId: "client-b" });
  const replacement = claim({ claimId: "claim-c", expiresAt: now + 20_000 });
  assert.deepEqual(
    enqueueRemoteClientClaim([existing, unrelated], replacement, now),
    [replacement, unrelated],
  );
});

test("enqueue and prune discard expired cards before the queue advances", () => {
  const expired = claim({ claimId: "expired", clientId: "old", expiresAt: now - 1 });
  const live = claim({ claimId: "live", clientId: "live" });
  const incoming = claim({ claimId: "incoming", clientId: "incoming" });
  assert.deepEqual(enqueueRemoteClientClaim([expired, live], incoming, now), [live, incoming]);
  assert.deepEqual(pruneRemoteClientClaims([expired, live], now), [live]);
});
