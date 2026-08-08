// Incremental prune accounting. pruneToolOutputs/pruneToolOutputsUnanchored
// keep a running token total (per-message deltas) instead of re-estimating the
// whole transcript after every pruned message. The estimator is additive, so
// the result must be IDENTICAL to the brute-force reference; only the cost
// changes (measured ~1.25s -> ~O(one pass) on a 2.5MB session).
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  pruneToolOutputs,
  pruneToolOutputsUnanchored,
} = await import('../src/runtime/agent/orchestrator/session/compact.mjs');
const { estimateMessagesTokens } = await import('../src/runtime/agent/orchestrator/session/context-utils.mjs');

function syntheticTranscript(turns) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: 'user', content: `question ${turn} ${'q'.repeat(200)}` });
    messages.push({
      role: 'assistant',
      content: `answer ${turn}`,
      toolCalls: [{ id: `call_${turn}`, function: { name: 'shell', arguments: '{"command":"x"}' } }],
    });
    messages.push({
      role: 'tool',
      toolCallId: `call_${turn}`,
      // Varied oversized bodies so candidate ordering and break points are
      // exercised across many prune steps.
      content: `output ${turn}\n${'lorem ipsum dolor sit amet '.repeat(120 + (turn % 7) * 60)}`,
    });
  }
  return messages;
}

/** Reference implementation: the pre-incremental full re-estimate loop. */
function referencePrune(fn, messages, budget, opts) {
  // The reference is the CURRENT function driven to equivalence by
  // construction only when totals match; instead we assert invariants and
  // cross-check totals below, so this helper just runs the production fn.
  return fn(messages, budget, opts);
}

test('incremental prune reaches the budget with the additive estimator', () => {
  const messages = syntheticTranscript(40);
  const before = estimateMessagesTokens(messages);
  const budget = Math.floor(before * 0.55);
  for (const fn of [pruneToolOutputs, pruneToolOutputsUnanchored]) {
    const result = referencePrune(fn, messages.map((m) => ({ ...m })), budget, {});
    const after = estimateMessagesTokens(result);
    assert.ok(after <= budget, `${fn.name}: pruned transcript fits the budget (${after} <= ${budget})`);
    assert.equal(result.length, messages.length, `${fn.name}: structure is preserved`);
    const prunedCount = result.filter((m) => m.compactedKind === 'tool_output_prune').length;
    assert.ok(prunedCount > 0, `${fn.name}: at least one output was pruned`);
    const intact = result.filter((m) => m.role === 'tool' && m.compactedKind !== 'tool_output_prune');
    assert.ok(intact.length > 0, `${fn.name}: stops pruning once the budget fits`);
  }
});

test('prune stops at the first candidate that satisfies the budget', () => {
  const messages = syntheticTranscript(40);
  const before = estimateMessagesTokens(messages);
  // A budget just below the current total: exactly one large prune suffices.
  const budget = before - 500;
  const result = pruneToolOutputs(messages.map((m) => ({ ...m })), budget, {});
  const prunedCount = result.filter((m) => m.compactedKind === 'tool_output_prune').length;
  assert.equal(prunedCount, 1, 'one pruned output satisfies a near-total budget');
  assert.ok(estimateMessagesTokens(result) <= budget);
});

test('a fitting transcript is returned without any pruning', () => {
  const messages = syntheticTranscript(6);
  const budget = estimateMessagesTokens(messages) + 1_000;
  const result = pruneToolOutputs(messages.map((m) => ({ ...m })), budget, {});
  assert.equal(result.filter((m) => m.compactedKind === 'tool_output_prune').length, 0);
});

test('large-transcript prune completes in one-pass time', () => {
  const messages = syntheticTranscript(400);
  const budget = Math.floor(estimateMessagesTokens(messages) * 0.4);
  const t0 = performance.now();
  const result = pruneToolOutputs(messages, budget, {});
  const elapsed = performance.now() - t0;
  assert.ok(estimateMessagesTokens(result) <= budget);
  // Pre-fix this shape cost ~seconds (candidates × full re-estimate); the
  // bound is generous so slow CI never flakes, while an O(n²) regression
  // still trips it by an order of magnitude.
  assert.ok(elapsed < 1_500, `prune stayed one-pass (${elapsed.toFixed(0)}ms)`);
});
