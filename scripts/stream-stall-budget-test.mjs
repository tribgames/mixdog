// Send-scoped stall-retry budget: the wall clock starts at the FIRST stall of
// a send; stall retries inside the window pass, past it they are denied so the
// caller surfaces the error for a fresh-request transport retry. Healthy sends
// never consult the clock. Default budget follows the CC/Codex 300s reference
// (MIXDOG_STREAM_STALL_BUDGET_MS overrides).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStallRetryBudget,
  STREAM_STALL_RETRY_BUDGET_MS,
} from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';

test('default budget is 300s unless overridden', () => {
  assert.equal(STREAM_STALL_RETRY_BUDGET_MS, 300_000);
});

test('stall retries pass inside the window and deny past it', () => {
  let t = 1_000_000;
  const budget = createStallRetryBudget(300_000, () => t);
  assert.equal(budget.allowStallRetry(), true);   // first stall arms the clock
  t += 149_000;
  assert.equal(budget.allowStallRetry(), true);   // 149s in: allowed
  t += 149_000;
  assert.equal(budget.allowStallRetry(), true);   // 298s in: allowed
  t += 10_000;
  assert.equal(budget.allowStallRetry(), false);  // 308s in: exhausted
  t += 60_000;
  assert.equal(budget.allowStallRetry(), false);  // stays exhausted for the send
});

test('clock starts at first stall, not at send start', () => {
  let t = 5_000;
  const budget = createStallRetryBudget(100, () => t);
  t += 10_000_000; // long healthy streaming before the first stall
  assert.equal(budget.allowStallRetry(), true);   // window opens HERE
  t += 99;
  assert.equal(budget.allowStallRetry(), true);
  t += 2;
  assert.equal(budget.allowStallRetry(), false);
});
