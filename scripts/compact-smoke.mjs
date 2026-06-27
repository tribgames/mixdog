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
  { role: 'user', content: '<system-reminder>\n<!-- bp3-sentinel -->\nproject/session rules stay exact\n</system-reminder>' },
  { role: 'assistant', content: '.' },
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

const overflowRetryMessages = [{ role: 'system', content: 'system rules stay mandatory' }];
let overflowIndex = 0;
while (estimateMessagesTokens(overflowRetryMessages) + 512 < 8_800) {
  overflowRetryMessages.push({ role: 'user', content: `older overflow retry request ${overflowIndex}: ${'important detail '.repeat(90)}` });
  overflowRetryMessages.push({ role: 'assistant', content: `older overflow retry answer ${overflowIndex}: ${'implementation note '.repeat(90)}` });
  overflowIndex += 1;
}
overflowRetryMessages.push({ role: 'user', content: 'current overflow retry task must stay verbatim' });
const overflowInitialPressure = estimateMessagesTokens(overflowRetryMessages) + 512;
assert(overflowInitialPressure < 10_800, `overflow retry fixture must stay below normal trigger: pressure=${overflowInitialPressure}`);
assert(overflowInitialPressure > 7_200, `overflow retry fixture must exceed strict retry budget before compaction: pressure=${overflowInitialPressure}`);
let overflowSendCount = 0;
let overflowCompactSendCount = 0;
let overflowRetryPressure = 0;
const overflowProvider = {
  name: 'overflow-smoke',
  async send(sentMessages, _model, _tools, opts = {}) {
    if (String(opts?.sessionId || '').endsWith(':compact')) {
      overflowCompactSendCount += 1;
      return {
        content: '## Goal\n- recover from overflow retry\n\n## Progress\n### Done\n- older overflow retry turns summarized\n\n### In Progress\n- current overflow retry task must stay verbatim\n\n### Blocked\n- (none)\n\n## Next Steps\n- retry the provider request\n\n## Critical Context\n- overflow retry smoke fixture\n\n## Relevant Files\n- scripts/compact-smoke.mjs: overflow retry semantic compact coverage',
        usage: { inputTokens: estimateMessagesTokens(sentMessages), outputTokens: 64 },
      };
    }
    overflowSendCount += 1;
    if (overflowSendCount === 1) throw new Error('input tokens exceeds the context window');
    overflowRetryPressure = estimateMessagesTokens(sentMessages) + 512;
    return { content: '<final-answer>overflow retry recovered</final-answer>', usage: { inputTokens: overflowRetryPressure, outputTokens: 1 } };
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
await agentLoop(overflowProvider, overflowRetryMessages, 'fake-model', [], null, process.cwd(), { session: overflowSession, sessionId: overflowSession.id });
assert(overflowSendCount === 2, `overflow retry should send exactly twice, sent=${overflowSendCount}`);
assert(overflowCompactSendCount === 1, `overflow retry should use configured semantic compact once, sent=${overflowCompactSendCount}`);
assert(overflowRetryPressure <= 7_200, `overflow retry must use stricter 60% budget: pressure=${overflowRetryPressure}`);

process.stdout.write('compact smoke passed ✓\n');
