import assert from "node:assert/strict";
import test from "node:test";

import { resolveContextDisplayUsage } from "./context-usage.ts";

// The runtime publishes ONE gauge number per session. The pane's job is to
// show that number against the limit auto-compaction actually uses — never to
// recompute it, and never to prefer a different field.

test("the gauge shows the runtime's published number against the compaction trigger", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_parity",
    stats: {
      currentEstimatedContextTokens: 120_500,
      currentContextTokens: 0,
      currentContextSource: "provider",
    },
    autoCompactTokenLimit: 500_000,
    displayContextWindow: 500_000,
    contextWindow: 500_000,
  });

  assert.equal(usage.used, 120_500);
  assert.equal(usage.limit, 500_000);
  assert.equal(usage.percent, 24);
});

test("the trigger, not the raw window, is the denominator the gauge fills", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_parity",
    stats: { currentEstimatedContextTokens: 180_000 },
    autoCompactTokenLimit: 180_000,
    displayContextWindow: 200_000,
    contextWindow: 200_000,
  });

  assert.equal(usage.percent, 100);
});

test("a session that has published no reading shows an empty gauge, not a guess", () => {
  const usage = resolveContextDisplayUsage({
    sessionId: "sess_fresh",
    stats: { currentEstimatedContextTokens: 0, currentContextTokens: 0 },
    autoCompactTokenLimit: 500_000,
  });

  assert.equal(usage.used, 0);
  assert.equal(usage.percent, 0);
});
