#!/usr/bin/env node
import { compactActiveTurn, compactMessages, semanticCompactMessages, recallFastTrackCompactMessages, SUMMARY_PREFIX, COMPACT_TYPE_SEMANTIC, COMPACT_TYPE_RECALL_FASTTRACK, normalizeCompactType } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { agentLoop } from '../src/runtime/agent/orchestrator/session/loop.mjs';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { autoCompactWindowForRoute, summarizeGatewayUsage } from '../src/vendor/statusline/src/gateway/route-meta.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textOf(messages) {
  return messages.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))).join('\n---\n');
}

function findSummary(messages) {
  return messages.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX));
}

const longBlock = 'analysis detail '.repeat(260);
const oldHistory = [];
for (let i = 0; i < 14; i += 1) {
  oldHistory.push({ role: 'user', content: `old request ${i}: inspect src/runtime/agent/orchestrator/session/compact.mjs\n${longBlock}` });
  oldHistory.push({
    role: 'assistant',
    content: i % 2 === 0 ? `noted invariant ${i}: preserve exact file paths` : '',
    toolCalls: [{
      id: `call_old_${i}`,
      name: 'grep',
      arguments: {
        path: 'src/runtime/agent/orchestrator/session/compact.mjs',
        pattern: 'compactMessages',
        token: 'sk-live-secret-must-not-survive',
      },
    }],
  });
  oldHistory.push({ role: 'tool', toolCallId: `call_old_${i}`, content: `grep result ${i}: compactMessages at line ${650 + i}\n${'tool output '.repeat(220)}` });
}

const currentTurn = [
  { role: 'user', content: 'current task: continue cleanup and quality check compact logic' },
  {
    role: 'assistant',
    content: 'checking the latest path',
    toolCalls: [{ id: 'call_latest', name: 'read', arguments: { path: 'src/runtime/agent/orchestrator/session/manager.mjs', line: 2438 } }],
  },
  { role: 'tool', toolCallId: 'call_latest', content: 'latest result must remain verbatim' },
];

const messages = [
  { role: 'system', content: 'system rules stay mandatory' },
  ...oldHistory,
  ...currentTurn,
];

const beforeTokens = estimateMessagesTokens(messages);
const compacted = compactMessages(messages, 2_400, { force: true, reserveTokens: 256 });
const afterTokens = estimateMessagesTokens(compacted);
const summary = findSummary(compacted);
const compactedText = textOf(compacted);

assert(summary, 'deterministic compact must insert an anchored summary');
assert(afterTokens < beforeTokens, `compact should shrink token estimate: before=${beforeTokens} after=${afterTokens}`);
assert(afterTokens <= 2_400 - 256, `compact must respect effective budget: after=${afterTokens}`);
assert(compacted.some((m) => m?.content === 'current task: continue cleanup and quality check compact logic'), 'current user turn must be preserved');
assert(compacted.some((m) => m?.toolCallId === 'call_latest' && m.content === 'latest result must remain verbatim'), 'latest tool result must be preserved');
assert(summary.content.includes('src/runtime/agent/orchestrator/session/compact.mjs'), 'summary should preserve relevant file paths');
assert(summary.content.includes('tool_calls=grep('), 'summary should preserve compact tool-call intent');
assert(summary.content.includes('[redacted]'), 'summary should redact sensitive tool-call args');
assert(!compactedText.includes('sk-live-secret-must-not-survive'), 'compacted transcript must not retain sensitive tool-call arg values');

const bootstrapContextMessages = [
  { role: 'system', content: 'base rules stay exact' },
  { role: 'user', content: '<system-reminder>\n<!-- bp3-sentinel -->\nproject/session rules stay exact\n</system-reminder>' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: '<system-reminder>\nvolatile cwd C:\\Project\\mixdog stays exact\n</system-reminder>' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'fresh real task has no prior compactable history' },
];
let bootstrapDeterministicRejected = false;
try {
  compactMessages(bootstrapContextMessages, 1_000, { force: true });
} catch (err) {
  bootstrapDeterministicRejected = /no compactable prior history/.test(String(err?.message || err));
}
assert(bootstrapDeterministicRejected, 'deterministic compact must not summarize bootstrap system-reminder context as conversation history');
let bootstrapSemanticCalls = 0;
try {
  await semanticCompactMessages({ name: 'bootstrap-smoke', async send() { bootstrapSemanticCalls += 1; return { content: 'bad' }; } }, bootstrapContextMessages, 'fake-model', 1_000, { force: true });
} catch (err) {
  assert(/no compactable prior history/.test(String(err?.message || err)), 'semantic compact should reject fresh bootstrap-only history before provider call');
}
assert(bootstrapSemanticCalls === 0, 'semantic compact must not spend a provider call compacting bootstrap reminders');
const bootstrapActive = compactActiveTurn(bootstrapContextMessages, 1_000, { force: true });
assert(JSON.stringify(bootstrapActive) === JSON.stringify(bootstrapContextMessages), 'active-turn fallback should preserve fresh bootstrap context verbatim');
assert(!findSummary(bootstrapActive), 'fresh bootstrap context must not be replaced by a compact summary');
const bootstrapProtectedOnlyMessages = bootstrapContextMessages.slice(0, 5);
const bootstrapProtectedOnlyActive = compactActiveTurn(bootstrapProtectedOnlyMessages, 1_000, { force: true });
assert(JSON.stringify(bootstrapProtectedOnlyActive) === JSON.stringify(bootstrapProtectedOnlyMessages), 'protected-prefix-only compaction should be an unchanged no-op');
assert(!findSummary(bootstrapProtectedOnlyActive), 'protected-prefix-only compaction must not synthesize a summary');

const claudeStyleBudget = 1_400;
const claudeStyleCompacted = compactMessages(messages, claudeStyleBudget, { force: true, reserveTokens: 256 });
const claudeStyleAfterTokens = estimateMessagesTokens(claudeStyleCompacted) + 256;
assert(claudeStyleAfterTokens < beforeTokens * 0.6, `auto compact target should restart with headroom: before=${beforeTokens} after=${claudeStyleAfterTokens}`);
assert(findSummary(claudeStyleCompacted), 'headroom compact must still insert a handoff summary');
assert(claudeStyleCompacted.some((m) => m?.toolCallId === 'call_latest' && m.content === 'latest result must remain verbatim'), 'headroom compact must preserve latest tool result');

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

let deterministicFailed = false;
try {
  compactMessages([
    { role: 'system', content: 'system rules stay mandatory' },
    { role: 'user', content: 'single very large active turn' },
    { role: 'assistant', toolCalls: [{ id: 'call_a', name: 'grep', arguments: { pattern: 'older' } }] },
    { role: 'tool', toolCallId: 'call_a', content: 'older same-turn output '.repeat(1_400) },
    { role: 'assistant', toolCalls: [{ id: 'call_b', name: 'read', arguments: { path: 'src/runtime/agent/orchestrator/session/compact.mjs' } }] },
    { role: 'tool', toolCallId: 'call_b', content: 'latest same-turn output must remain' },
  ], 1_100, { force: true });
} catch {
  deterministicFailed = true;
}
assert(deterministicFailed, 'deterministic compact should fail when there is no prior history before the active turn');

const activeCompacted = compactActiveTurn([
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'single very large active turn' },
  { role: 'assistant', content: 'older group', toolCalls: [{ id: 'call_a', name: 'grep', arguments: { pattern: 'older' } }] },
  { role: 'tool', toolCallId: 'call_a', content: 'older same-turn output '.repeat(1_400) },
  { role: 'assistant', content: 'latest group', toolCalls: [{ id: 'call_b', name: 'read', arguments: { path: 'src/runtime/agent/orchestrator/session/compact.mjs' } }] },
  { role: 'tool', toolCallId: 'call_b', content: 'latest same-turn output must remain' },
], 1_100, { minActiveTurnGroups: 1, maxToolOutputChars: 400 });
const activeText = textOf(activeCompacted);
assert(estimateMessagesTokens(activeCompacted) <= 1_100, 'active-turn compact should fit the budget');
assert(activeCompacted.some((m) => m?.toolCallId === 'call_b' && m.content === 'latest same-turn output must remain'), 'active-turn compact must preserve latest tool result');
assert(
  activeText.includes('[mixdog pruned old tool output') || !activeCompacted.some((m) => m?.toolCallId === 'call_a'),
  'active-turn compact should drop or prune older same-turn output',
);
assert(!activeText.includes('older same-turn output '.repeat(50).trim()), 'active-turn compact should remove the full older tool body');

const activeSummaryCompacted = compactActiveTurn([
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'single active turn with older tool work to summarize' },
  { role: 'assistant', content: 'older active-turn group', toolCalls: [{ id: 'call_active_old', name: 'grep', arguments: { pattern: 'older' } }] },
  { role: 'tool', toolCallId: 'call_active_old', content: 'older same-turn output '.repeat(220) },
  { role: 'assistant', content: 'latest group', toolCalls: [{ id: 'call_active_latest', name: 'read', arguments: { path: 'src/runtime/agent/orchestrator/session/compact.mjs' } }] },
  { role: 'tool', toolCallId: 'call_active_latest', content: 'latest same-turn output must remain' },
], 5_000, { minActiveTurnGroups: 1, maxToolOutputChars: 10_000, force: true });
const activeSummary = findSummary(activeSummaryCompacted);
assert(activeSummary, 'active-turn compact should summarize dropped older same-turn groups when the summary fits');
assert(activeSummary.content.includes('tool_calls=grep('), 'active-turn summary should preserve older same-turn tool intent');
assert(activeSummaryCompacted.some((m) => m?.toolCallId === 'call_active_latest' && m.content === 'latest same-turn output must remain'), 'active-turn summary path must preserve latest tool result');

const forcedSingleGroup = compactActiveTurn([
  { role: 'system', content: 'system rules stay mandatory' },
  { role: 'user', content: 'single active turn with one huge latest tool group' },
  { role: 'assistant', content: 'latest group', toolCalls: [{ id: 'call_single_latest', name: 'read', arguments: { path: 'src/runtime/agent/orchestrator/session/compact.mjs' } }] },
  { role: 'tool', toolCallId: 'call_single_latest', content: 'latest same-turn output '.repeat(500) },
], 5_000, { minActiveTurnGroups: 1, maxToolOutputChars: 400, force: true });
assert(textOf(forcedSingleGroup).includes('[mixdog pruned old tool output'), 'forced active-turn compact should prune a single oversized group instead of returning unchanged');

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
let overflowRetryPressure = 0;
const overflowProvider = {
  name: 'overflow-smoke',
  async send(sentMessages) {
    overflowSendCount += 1;
    if (overflowSendCount === 1) throw new Error('input tokens exceeds the context window');
    overflowRetryPressure = estimateMessagesTokens(sentMessages) + 512;
    return { content: '<final-answer>overflow retry recovered</final-answer>', usage: { inputTokens: overflowRetryPressure, outputTokens: 1 } };
  },
};
const overflowSession = {
  id: 'compact-smoke-overflow',
  owner: 'bridge',
  provider: 'overflow-smoke',
  model: 'fake-model',
  contextWindow: 12_000,
  rawContextWindow: 12_000,
  compactBoundaryTokens: 12_000,
  compaction: { auto: true, semantic: false },
};
await agentLoop(overflowProvider, overflowRetryMessages, 'fake-model', [], null, process.cwd(), { session: overflowSession, sessionId: overflowSession.id });
assert(overflowSendCount === 2, `overflow retry should send exactly twice, sent=${overflowSendCount}`);
assert(overflowRetryPressure <= 7_200, `overflow retry must use stricter 60% budget: pressure=${overflowRetryPressure}`);

process.stdout.write('compact smoke passed ✓\n');
