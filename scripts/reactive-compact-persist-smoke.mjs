#!/usr/bin/env node
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { SUMMARY_PREFIX } from '../src/runtime/agent/orchestrator/session/compact.mjs';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-reactive-compact-persist-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { initProviders, getProvider } = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
const { saveSessionAsync, loadSession } = await import('../src/runtime/agent/orchestrator/session/store.mjs');

await initProviders({ 'openai-oauth': { enabled: true } });
const provider = getProvider('openai-oauth');
if (!provider || typeof provider.send !== 'function') {
  process.stdout.write('reactive-compact-persist smoke skipped (openai-oauth unavailable)\n');
  process.exit(0);
}

let mainSendCount = 0;
let compactSendCount = 0;
provider.send = async (_sentMessages, _model, _tools, opts = {}) => {
  if (String(opts?.sessionId || '').endsWith(':compact')) {
    compactSendCount += 1;
    return {
      content: [
        '## Goal',
        '- continue reactive persist smoke',
        '',
        '## Constraints & Preferences',
        '- (none)',
        '',
        '## Progress',
        '### Done',
        '- older turn summarized',
        '',
        '### In Progress',
        '- (none)',
        '',
        '### Blocked',
        '- (none)',
        '',
        '## Key Decisions',
        '- (none)',
        '',
        '## Next Steps',
        '- continue',
        '',
        '## Critical Context',
        '- manager.mjs',
        '',
        '## Relevant Files',
        '- src/runtime/agent/orchestrator/session/manager.mjs: askSession overflow persist',
      ].join('\n'),
    };
  }
  mainSendCount += 1;
  throw new Error('input tokens exceeds the context window');
};

const messages = [{ role: 'system', content: 'system rules stay mandatory' }];
let overflowIndex = 0;
while (estimateMessagesTokens(messages) + 512 < 8_800) {
  messages.push({ role: 'user', content: `older overflow request ${overflowIndex}: ${'important detail '.repeat(90)}` });
  messages.push({ role: 'assistant', content: `older overflow answer ${overflowIndex}: ${'implementation note '.repeat(90)}` });
  overflowIndex += 1;
}

const sessionId = `sess_reactive_compact_persist_${process.pid}_${Date.now()}`;
const session = {
  id: sessionId,
  provider: 'openai-oauth',
  model: 'reactive-compact-persist-smoke',
  messages,
  tools: [],
  generation: 0,
  closed: false,
  contextWindow: 12_000,
  rawContextWindow: 12_000,
  compactBoundaryTokens: 12_000,
  // Keep this fixture on the reactive-overflow path; main/user now compacts at
  // 75% by default, while this explicit sub-boundary limit remains authoritative.
  autoCompactTokenLimit: 11_500,
  compaction: { auto: true, semantic: true, type: 1, compactType: 1, lastStage: 'compacting' },
  cwd: process.cwd(),
  sessionStartMetaInjected: true,
  providerState: { xaiResponses: { previousResponseId: 'stale-after-compact' } },
};
await saveSessionAsync(session, { expectedGeneration: 0 });
const beforeCount = messages.length;

const { askSession } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');

let threw = false;
let thrownCode = null;
try {
  await askSession(sessionId, 'current overflow task must stay verbatim', null, null, process.cwd());
} catch (err) {
  threw = true;
  thrownCode = err?.code || null;
}

// Non-agent sessions hard-lock to recall-fasttrack (7/3 commit). This smoke has
// no memory subsystem registered, so ingest_session + search both fail — the
// exact "memory pipeline broken" condition the fail-safe must cover. Assert the
// fail-safe: recall-fasttrack aborts rather than dropping head behind a false
// "Full history is in memory" notice, so no context is silently lost and the
// compaction failure is surfaced instead of being masked by an empty summary shell.
assert(threw, 'askSession should surface compaction failure');
assert(thrownCode === 'AGENT_COMPACT_FAILED', `expected AGENT_COMPACT_FAILED, got ${thrownCode}`);
// Recall-fasttrack aborted (memory failed), so the reactive retry never produced
// a smaller transcript to re-send: exactly one failing main send, no LLM compact.
assert(mainSendCount === 1, `expected 1 main send (reactive retry aborted by fail-safe), got ${mainSendCount}`);
assert(compactSendCount === 0, `expected 0 compact sends on recall-fasttrack path, got ${compactSendCount}`);

const reloaded = loadSession(sessionId);
assert(reloaded, 'session should reload from store after overflow');
// Fail-safe keeps full history for the cycle: current turn appended, nothing dropped.
assert(
  (reloaded.messages || []).length === beforeCount + 1,
  `full history should be preserved on fail-safe abort (expected ${beforeCount + 1}, got ${(reloaded.messages || []).length})`,
);
const summary = (reloaded.messages || []).find(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX),
);
assert(!summary, 'no empty summary shell should be injected when the memory pipeline fails');
assert(
  !(reloaded.messages || []).some((m) => typeof m?.content === 'string' && m.content.includes('Full history is in memory')),
  'no false "Full history is in memory" recall notice should be injected on fail-safe abort',
);
assert(
  (reloaded.messages || []).some((m) => m?.role === 'user' && String(m.content).includes('current overflow task must stay verbatim')),
  'current user turn should remain in persisted transcript',
);
assert(reloaded.compaction?.lastStage === 'overflow_failed', `compaction lastStage should be overflow_failed, got ${reloaded.compaction?.lastStage}`);
assert(reloaded.providerState?.xaiResponses?.previousResponseId === 'stale-after-compact',
  'providerState should remain when a failed reactive compact leaves the transcript unchanged');

// Successful pre-send compaction must persist an explicit providerState clear.
// The following ask then proves the stale continuation is absent from the
// provider options, not merely absent from the first loop's local variable.
let successfulCompactSends = 0;
const nextAskStates = [];
provider.send = async (_sentMessages, _model, _tools, opts = {}) => {
  if (String(opts?.sessionId || '').endsWith(':compact')) {
    successfulCompactSends += 1;
    return {
      content: [
        '## Goal',
        '- verify provider state clear',
        '',
        '## Progress',
        '### Done',
        '- old history compacted',
        '',
        '## Next Steps',
        '- continue',
      ].join('\n'),
    };
  }
  nextAskStates.push(opts.providerState);
  return { content: 'successful answer', stopReason: 'end_turn' };
};
const clearSessionId = `sess_provider_state_clear_${process.pid}_${Date.now()}`;
const clearMessages = [{ role: 'system', content: 'rules' }];
for (let i = 0; i < 10; i += 1) {
  clearMessages.push({ role: 'user', content: `old ${i} ${'x '.repeat(500)}` });
  clearMessages.push({ role: 'assistant', content: `answer ${i} ${'y '.repeat(500)}` });
}
await saveSessionAsync({
  id: clearSessionId,
  provider: 'openai-oauth',
  model: 'provider-state-clear-smoke',
  owner: 'agent',
  agent: 'heavy-worker',
  messages: clearMessages,
  tools: [],
  generation: 0,
  closed: false,
  contextWindow: 12_000,
  rawContextWindow: 12_000,
  compactBoundaryTokens: 12_000,
  autoCompactTokenLimit: 4_000,
  compaction: { auto: true, semantic: true, recallFastTrack: false, type: 1, compactType: 1 },
  cwd: process.cwd(),
  sessionStartMetaInjected: true,
  providerState: { xaiResponses: { previousResponseId: 'must-clear' } },
}, { expectedGeneration: 0 });
await askSession(clearSessionId, 'first ask', null, null, process.cwd());
const afterClear = loadSession(clearSessionId);
assert(!Object.hasOwn(afterClear, 'providerState'), 'successful compact must remove providerState from persisted session');
await askSession(clearSessionId, 'second ask', null, null, process.cwd());
assert(successfulCompactSends >= 1, 'fixture must perform successful semantic compaction');
assert(nextAskStates.length >= 2, 'both asks must reach provider');
assert(nextAskStates[0] === undefined, 'post-compact send must receive cleared providerState');
assert(nextAskStates[1] === undefined, 'next ask must not resurrect stale providerState');

process.stdout.write('reactive-compact-persist smoke passed ✓\n');
