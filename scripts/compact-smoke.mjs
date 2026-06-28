#!/usr/bin/env node
import { semanticCompactMessages, recallFastTrackCompactMessages, SUMMARY_PREFIX, COMPACT_TYPE_SEMANTIC, COMPACT_TYPE_RECALL_FASTTRACK, normalizeCompactType } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { agentLoop } from '../src/runtime/agent/orchestrator/session/loop.mjs';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { autoCompactWindowForRoute, summarizeGatewayUsage } from '../src/vendor/statusline/src/gateway/route-meta.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findSummary(messages) {
  return messages.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX));
}

const bootstrapContextMessages = [
  { role: 'system', content: 'base rules stay exact' },
  { role: 'system', content: 'role/system rules stay exact' },
  { role: 'system', content: 'project/session memory/meta stay exact', cacheTier: 'tier3' },
  { role: 'user', content: '<system-reminder>\nvolatile cwd C:\\Project\\mixdog stays exact\n</system-reminder>' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'fresh real task has no prior compactable history' },
];
let bootstrapSemanticCalls = 0;
try {
  await semanticCompactMessages({ name: 'bootstrap-smoke', async send() { bootstrapSemanticCalls += 1; return { content: 'bad' }; } }, bootstrapContextMessages, 'fake-model', 1_000, { force: true });
} catch (err) {
  assert(/no compactable prior history/.test(String(err?.message || err)), 'semantic compact should reject fresh bootstrap-only history before provider call');
}
assert(bootstrapSemanticCalls === 0, 'semantic compact must not spend a provider call compacting bootstrap reminders');

const statusRoute = {
  provider: 'openai',
  model: 'gpt-5.5',
  contextWindow: 950_000,
  rawContextWindow: 1_000_000,
  autoCompactTokenLimit: 950_000,
};
assert(autoCompactWindowForRoute(statusRoute) === 950_000, 'auto compact window should match the effective compact capacity');
const usageSummary = summarizeGatewayUsage(statusRoute, { usage: { inputTokens: 900_000, outputTokens: 1 } });
assert(usageSummary.contextUsedPct === 94.74, `statusline usage should use effective compact capacity: ${usageSummary.contextUsedPct}`);

let semanticCalls = 0;
const semanticProvider = {
  name: 'semantic-smoke',
  async send(_messages, _model, _tools, opts) {
    semanticCalls += 1;
    assert(opts?.maxOutputTokens === 4_096, 'semantic compact should request the summary output cap');
    return { content: '## Goal\n- continue compact smoke\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- older turn summarized\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- continue\n\n## Critical Context\n- src/runtime/agent/orchestrator/session/compact.mjs\n\n## Relevant Files\n- src/runtime/agent/orchestrator/session/compact.mjs: compact logic' };
  },
};
const semanticMessages = [
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'older request about src/runtime/agent/orchestrator/session/compact.mjs' },
  { role: 'assistant', content: 'older answer with useful details' },
  { role: 'user', content: 'current request should remain verbatim' },
];
const semanticNoop = await semanticCompactMessages(semanticProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1 });
assert(semanticNoop.semantic === false && semanticCalls === 0, 'semantic compact should still no-op below budget unless forced');
const semanticForced = await semanticCompactMessages(semanticProvider, semanticMessages, 'fake-model', 5_000, { tailTurns: 1, force: true });
assert(semanticForced.semantic === true && semanticCalls === 1, 'forced semantic compact should run even when the local estimate fits');
assert(semanticForced.compactType === COMPACT_TYPE_SEMANTIC, 'semantic compact should report compact type 1');
assert(findSummary(semanticForced.messages), 'forced semantic compact should insert an anchored summary');

assert(normalizeCompactType('type1') === COMPACT_TYPE_SEMANTIC, 'type1 should resolve to semantic compact');
assert(normalizeCompactType('recall-fasttrack') === COMPACT_TYPE_RECALL_FASTTRACK, 'type2 should resolve to recall fast-track compact');
const recallFastTrackForced = recallFastTrackCompactMessages(semanticMessages, 5_000, {
  tailTurns: 1,
  force: true,
  recallText: 'recall hit: src/runtime/agent/orchestrator/session/compact.mjs and next steps preserved',
  query: 'compact smoke recall fast-track',
  querySha: 'smoketest',
});
assert(recallFastTrackForced.recallFastTrack === true, 'recall fast-track compact should mark type2 result');
assert(recallFastTrackForced.compactType === COMPACT_TYPE_RECALL_FASTTRACK, 'recall fast-track compact should report compact type 2');
assert(findSummary(recallFastTrackForced.messages), 'recall fast-track compact should insert an anchored summary');

// Context overflow on send triggers ONE reactive compact-retry: the loop
// marks the session over-threshold and re-enters the pre-send auto-compact
// path, which runs a single semantic compaction (one compact-provider send)
// and re-sends once. If the retry still overflows, the deterministic
// AGENT_CONTEXT_OVERFLOW error is surfaced (main send count 2, compact
// provider send count 1).
const overflowRetryMessages = [{ role: 'system', content: 'system rules stay mandatory' }];
let overflowIndex = 0;
while (estimateMessagesTokens(overflowRetryMessages) + 512 < 8_800) {
  overflowRetryMessages.push({ role: 'user', content: `older overflow request ${overflowIndex}: ${'important detail '.repeat(90)}` });
  overflowRetryMessages.push({ role: 'assistant', content: `older overflow answer ${overflowIndex}: ${'implementation note '.repeat(90)}` });
  overflowIndex += 1;
}
overflowRetryMessages.push({ role: 'user', content: 'current overflow task must stay verbatim' });
let overflowSendCount = 0;
let overflowCompactSendCount = 0;
const overflowProvider = {
  name: 'overflow-smoke',
  async send(_sentMessages, _model, _tools, opts = {}) {
    if (String(opts?.sessionId || '').endsWith(':compact')) {
      overflowCompactSendCount += 1;
      return { content: 'unexpected compact call' };
    }
    overflowSendCount += 1;
    throw new Error('input tokens exceeds the context window');
  },
};
const overflowSession = {
  id: 'compact-smoke-overflow',
  owner: 'agent',
  provider: 'overflow-smoke',
  model: 'fake-model',
  contextWindow: 12_000,
  rawContextWindow: 12_000,
  compactBoundaryTokens: 12_000,
  compaction: { auto: true, semantic: true },
};
let overflowError = null;
try {
  await agentLoop(overflowProvider, overflowRetryMessages, 'fake-model', [], null, process.cwd(), { session: overflowSession, sessionId: overflowSession.id });
} catch (err) {
  overflowError = err;
}
assert(overflowError, 'context overflow on send should surface an error, not be silently recovered');
assert(overflowError?.code === 'AGENT_CONTEXT_OVERFLOW', `overflow should surface AGENT_CONTEXT_OVERFLOW, got ${overflowError?.code || overflowError?.message}`);
assert(overflowSendCount === 2, `overflow should send twice (original + one reactive compact-retry), sent=${overflowSendCount}`);
assert(overflowCompactSendCount === 1, `reactive compact-retry should run exactly one in-loop semantic compaction, compactSends=${overflowCompactSendCount}`);

process.stdout.write('compact smoke passed ✓\n');
