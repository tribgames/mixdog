import assert from "node:assert/strict";
import test from "node:test";

import { resolveContextDisplayUsage } from "./context-usage.ts";

test("the gauge ignores pressure and output and shows measured input", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_parity",
    stats: {
      currentEstimatedContextTokens: 120_500,
      currentContextTokens: 120_000,
      currentContextSource: "last_api_request",
    },
    autoCompactTokenLimit: 500_000,
    displayContextWindow: 500_000,
    contextWindow: 500_000,
  });

  assert.equal(usage.used, 120_000);
  assert.equal(usage.limit, 500_000);
  assert.equal(usage.percent, 24);
});

test("the display uses the context window independently of the compaction trigger", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_parity",
    stats: { currentContextTokens: 180_000, currentContextSource: "last_api_request" },
    autoCompactTokenLimit: 180_000,
    displayContextWindow: 200_000,
    contextWindow: 200_000,
  });

  assert.equal(usage.percent, 90);
});

test("no reading and missing usage are distinct and never replaced with estimates", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_fresh",
    stats: { currentEstimatedContextTokens: 24_000, currentContextTokens: null, currentContextSource: "pending" },
    autoCompactTokenLimit: 500_000,
  });

  assert.equal(usage.used, null);
  assert.equal(usage.percent, null);
  assert.equal(usage.source, "pending");
  const unavailable = resolveContextDisplayUsage({
    sessionId: "sess_no_usage", contextWindow: 128_000,
    stats: { currentContextTokens: null, currentContextSource: "unavailable", currentEstimatedContextTokens: 24000 },
  });
  assert.equal(unavailable.source, "unavailable");
  assert.equal(unavailable.used, null);
  const unmeasuredZero = resolveContextDisplayUsage({
    sessionId: "legacy-empty", contextWindow: 128_000,
    stats: { currentContextTokens: 0, currentEstimatedContextTokens: 24000 },
  });
  assert.equal(unmeasuredZero.source, "pending");
  assert.equal(unmeasuredZero.used, null);
});
