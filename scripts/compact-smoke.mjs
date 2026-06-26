#!/usr/bin/env node
import { compactActiveTurn, compactMessages, SUMMARY_PREFIX } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';

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

process.stdout.write('compact smoke passed ✓\n');
