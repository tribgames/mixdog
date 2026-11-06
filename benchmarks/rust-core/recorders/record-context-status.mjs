#!/usr/bin/env node
// Genuine 1.4.5 `/context` gauge: Node's own `contextStatusForSession` (runtime-core/context-status.mjs)
// over crafted sessions, with a fixed clock. Each case records the Node-shaped session, and the facts the
// gauge reads from modules the Rust gauge does not own, taken from the same Node functions: the provider
// request tools (`snapshotProviderRequestTools`), the tool breakdown (`estimateToolSchemaBreakdown`), the
// mode (`isAgentModeSession`), and `hasRouteHistoryMessage`. The Rust `context_status` must return `status`.
//
//   node benchmarks/rust-core/recorders/record-context-status.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/context-status/golden.json
import { join } from 'node:path';
import { commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, FIXTURES_ROOT } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;

const args = parseArgs();
const tree = resolveTree(args);
const orch = 'src/runtime/agent/orchestrator';
const { contextStatusForSession } = await importFrom(tree, `${orch}/runtime-core/context-status.mjs`);
const { snapshotProviderRequestTools, estimateToolSchemaBreakdown } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { providerNativeToolPrefixCount } = await importFrom(tree, `${orch}/runtime-core/provider-request-tools.mjs`);
const { hasRouteHistoryMessage } = await importFrom(tree, `${orch}/runtime-core/session-route-policy.mjs`);
const { isAgentModeSession } = await importFrom(tree, `${orch}/session/agent-mode.mjs`);

const { recordContextUsageSnapshot, recordProviderContextBaseline } = await importFrom(tree, `${orch}/session/loop/compact-policy.mjs`);

const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'tool_search', description: 'Find deferred tools', inputSchema: { type: 'object' }, deferLoading: true },
];
const call = (id, name, args) => ({ id, name, arguments: args });
const convo = [
  { role: 'system', content: '# Core Memory\n- prefers short answers\n\n# Active Workflow\nDo the task.\n\n# Environment\ncwd: C:/w' },
  { role: 'user', content: 'Please read the config file.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [call('c1', 'read', { path: 'config.json' })] },
  { role: 'tool', toolCallId: 'c1', content: '{"a":1,"b":[1,2,3]}' },
  { role: 'assistant', content: 'The config sets a to 1.' },
  { role: 'user', content: '<system-reminder>\n# Workspace\nrepo: mixdog\n\n# Core Memory\nnote\n</system-reminder>' },
  { role: 'user', content: 'Thanks, now summarise it.' },
];
const reasoning = [
  { role: 'user', content: 'Think about it.' },
  {
    role: 'assistant',
    content: 'Done thinking.',
    thinkingBlocks: [{ type: 'thinking', thinking: 'Let me weigh the options carefully before answering.', signature: 'A'.repeat(120) }],
  },
  { role: 'user', content: 'ok' },
];
const base = { id: 's_ctx', provider: 'openai', model: 'gpt-test', contextWindow: 100000, cwd: 'C:/w', tools };
const usage = { lastInputTokens: 900, lastUncachedInputTokens: 400, lastOutputTokens: 60, lastCachedReadTokens: 500, lastCacheWriteTokens: 10, totalInputTokens: 5000, totalUncachedInputTokens: 2000, totalOutputTokens: 300, totalCachedReadTokens: 3000, totalCacheWriteTokens: 40 };

// Sessions whose pressure state Node's own recorders wrote: a provider baseline (and growth after it), and a post-compact snapshot.
const withBaseline = (messages, extra = {}) => {
  const s = { ...base, id: 's_base', messages, ...usage, lastContextTokens: 1200, lastContextTokensUpdatedAt: NOW - 5000, ...extra };
  recordProviderContextBaseline(s, messages, { inputTokens: 1100, outputTokens: 100, cachedTokens: 0 }, { sendTools: tools });
  return s;
};
const snapshotted = { ...base, id: 's_snap', messages: convo, ...usage, lastContextTokens: 0, compaction: { boundaryTokens: 60000, lastCompactAt: NOW - 90000 } };
// The snapshot is only honoured under the policy the gauge itself resolves (contextCompactPolicy, not exported: the worker policy when the boundary is known).
const { resolveWorkerCompactPolicy } = await importFrom(tree, `${orch}/session/loop/compact-policy.mjs`);
recordContextUsageSnapshot(
  snapshotted,
  resolveWorkerCompactPolicy(snapshotted, snapshotProviderRequestTools({ provider: 'openai', tools, nativeTools: [], messages: convo, session: snapshotted })),
  { messages: convo, usedTokens: 777, source: 'post_compact', updatedAt: NOW - 1000 }
);

const cases = [
  ['no session', null],
  ['empty conversation', { ...base, messages: [] }],
  ['prepared system context', { ...base, messages: convo.slice(0, 1), ...usage }],
  ['estimated, no provider usage', { ...base, messages: convo }],
  ['provider usage', { ...base, messages: convo, lastContextTokens: 1200, lastContextTokensUpdatedAt: NOW - 5000, ...usage }],
  ['provider usage with a compaction boundary', { ...base, messages: convo, lastContextTokens: 1200, lastContextTokensUpdatedAt: NOW - 5000, compactBoundaryTokens: 60000, compaction: { boundaryTokens: 60000, lastCompactAt: NOW - 90000 }, ...usage }],
  ['usage stale after compact', { ...base, messages: convo, lastContextTokens: 1200, lastContextTokensUpdatedAt: NOW - 100000, lastContextTokensStaleAfterCompact: true, compaction: { boundaryTokens: 60000, lastCompactAt: NOW - 90000 }, ...usage }],
  ['provider baseline over the whole transcript', withBaseline(convo)],
  ['provider baseline plus growth', withBaseline(convo, { messages: [...convo, { role: 'user', content: 'and one more question please' }] })],
  ['post-compact snapshot', snapshotted],
  ['reasoning blocks', { ...base, messages: reasoning, reasoningUsage: { reasoningTokens: 17, reasoningTokensComplete: true } }],
  ['empty conversation with tools', { ...base, id: 's_empty_tools', messages: [] }],
  ['window from the route only', { id: 's_route', messages: convo, tools: [] }],
  ['tool without a schema', { ...base, id: 's_bare', messages: convo, tools: [tools[0], { name: 'bare', description: 'No schema' }, tools[0]] }],
  [
    'anthropic deferred expansion',
    {
      ...base,
      id: 's_defer',
      provider: 'anthropic',
      model: 'claude-test',
      deferredNativeTools: true,
      deferredMcpToolNames: ['mcp__ok__found'],
      deferredDiscoveredTools: ['web_search', 'mcp__ok__found', 'mcp__no__hidden'],
      deferredToolCatalog: [
        { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'recall', description: 'Recall memory', inputSchema: { type: 'object' } },
        { name: 'mcp__ok__found', description: 'Listed MCP tool', inputSchema: { type: 'object' } },
        { name: 'mcp__no__hidden', description: 'Unlisted MCP tool', inputSchema: { type: 'object' } },
      ],
      deferredLateToolCatalog: [{ name: 'late_tool', description: 'Late', inputSchema: { type: 'object' } }],
      messages: [
        ...convo,
        { role: 'tool', toolCallId: 'c9', content: 'found', nativeToolSearch: { provider: 'anthropic-oauth', toolReferences: ['recall', 'late_tool'] } },
        { role: 'tool', toolCallId: 'c10', content: 'found', nativeToolSearch: { provider: 'openai', toolReferences: ['read'] } },
      ],
    },
  ],
].map(([name, session]) => {
  const route = {
    provider: session?.provider || '',
    model: session?.model || '',
    contextWindow: session?.contextWindow || null,
  };
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const requestTools = session?.id
    ? snapshotProviderRequestTools({ provider: session.provider || route.provider, tools: session.tools, nativeTools: [], messages, session })
    : [];
  const header = session ? Object.fromEntries(Object.entries(session).filter(([k]) => k !== 'messages' && k !== 'tools')) : null;
  return {
    name,
    header,
    messages,
    tools: session?.tools ?? [],
    route,
    cwd: session?.cwd || '',
    mode: 'default',
    active: hasRouteHistoryMessage(messages),
    agentMode: session ? isAgentModeSession(session) : false,
    requestTools: [...requestTools],
    nativePrefix: providerNativeToolPrefixCount(requestTools),
    breakdown: estimateToolSchemaBreakdown(requestTools),
    status: contextStatusForSession(session, { getMode: () => 'default' }),
  };
});

const finalOut = join(FIXTURES_ROOT, 'context-status');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'contextStatusForSession over crafted sessions at a fixed clock; request tools, breakdown, mode and history flag from the same Node functions',
  now: NOW,
  cases,
});
writeSetManifest(out, {
  set: 'context-status',
  recorder: 'benchmarks/rust-core/recorders/record-context-status.mjs',
  command: 'node benchmarks/rust-core/recorders/record-context-status.mjs --tree <tree>',
  extra: { cases: cases.length },
  identityTree: tree,
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);







