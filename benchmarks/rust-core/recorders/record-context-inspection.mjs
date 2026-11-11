#!/usr/bin/env node
// What the desktop's Context inspector gets (`ContextInspector.tsx` asks `contextStatus [{ inspect: true }]`, then
// `{ inspect: true, entryId, revision }` for the entry it opens): Node's own live gauge (`createContextStatus`,
// runtime-core/context-status.mjs, with its inspection snapshots from context-status-inspection.mjs) over crafted
// sessions at a fixed clock. Each case keeps its calls in the order made: the plain status, the list, a preview of every
// listed entry against the list's revision, an entry the list never had, and an entry asked for under a revision that is
// not the list's. The facts the gauge reads from modules the Rust gauge does not own come from the same Node functions,
// as record-context-status.mjs takes them (request tools, native prefix, tool breakdown, mode, history flag).
//
//   node benchmarks/rust-core/recorders/record-context-inspection.mjs --tree <exact export of b6f10295a> [--only <case>]
// Output: native/core/fixtures/context-inspection/golden.json
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-context-inspection.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const orch = 'src/runtime/agent/orchestrator';
const { createContextStatus } = await importFrom(tree, `${orch}/runtime-core/context-status.mjs`);
const { snapshotProviderRequestTools, estimateToolSchemaBreakdown } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { providerNativeToolPrefixCount } = await importFrom(tree, `${orch}/runtime-core/provider-request-tools.mjs`);
const { hasRouteHistoryMessage } = await importFrom(tree, `${orch}/runtime-core/session-route-policy.mjs`);
const { isAgentModeSession } = await importFrom(tree, `${orch}/session/agent-mode.mjs`);
const { recordProviderContextBaseline } = await importFrom(tree, `${orch}/session/loop/compact-policy.mjs`);
const { SUMMARY_PREFIX } = await importFrom(tree, `${orch}/session/compact.mjs`);

const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'mcp__docs__lookup', description: 'Look up docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'Skill', description: 'Load a skill', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'recall', description: 'Recall memory', inputSchema: { type: 'object' } },
  { name: 'agent', description: 'Run an agent', inputSchema: { type: 'object' } },
  { name: 'tool_search', description: 'Find deferred tools', inputSchema: { type: 'object' }, deferLoading: true },
];
const call = (id, name, args) => ({ id, name, arguments: args });
const system = [
  '# Core Memory\n- prefers short answers',
  '# Active Workflow\nDo the task.',
  '# Skills\nUse a skill when it fits.',
  '# available-skills\n- pptx: decks',
  '<available-deferred-tools>\n- web_fetch\n</available-deferred-tools>',
  '# Environment\ncwd: C:/w\x1b[31m red \x1b[0m\x07',
].join('\n\n');
const convo = [
  { role: 'system', content: system },
  { role: 'user', content: 'Please read the config file.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [call('c1', 'read', { path: 'config.json' }), call('c2', 'grep', { pattern: 'a' })] },
  { role: 'tool', toolCallId: 'c1', content: '{"a":1,"b":[1,2,3]}' },
  { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'config.json:1: "a"' }] },
  { role: 'assistant', content: 'The config sets a to 1.', toolCalls: [call('c3', 'read', { path: 'other.json' })] },
  { role: 'tool', toolCallId: 'c3', content: 'missing' },
  { role: 'user', content: '<system-reminder>\n# Workspace\nrepo: mixdog\n\n# Core Memory\nnote\n</system-reminder>' },
  { role: 'user', content: '<system-reminder>\n# Workspace\nbranch: main\n</system-reminder>\nAnd the second file?' },
  {
    role: 'user',
    content: '<system-reminder>\n# Environment\ntime: noon\n</system-reminder>\n\nWhat changed?\n\n<system-reminder>\n# Core Memory\nkeep it brief\n</system-reminder>',
    meta: { runtimeUserContext: { prefix: '<system-reminder>\n# Environment\ntime: noon\n</system-reminder>\n\n', suffix: '\n\n<system-reminder>\n# Core Memory\nkeep it brief\n</system-reminder>' } },
  },
  { role: 'user', content: '<skill>\n<name>pptx &amp; decks</name>\nBuild decks with care.\n</skill>' },
  {
    role: 'user',
    content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Shell task t1 finished</summary>\n</task-notification>',
  },
  { role: 'user', content: '<mixdog-runtime kind="runtime-control">\n# Notice\nThe app restarted.\n</mixdog-runtime>' },
  { role: 'user', content: '[mixdog-runtime] Continue from where you left off.' },
  { role: 'assistant', content: 'Done.', name: 'helper\tbot' },
  { role: 'user', content: 'Thanks, now summarise it.' },
];
const summary = [
  { role: 'user', content: `${SUMMARY_PREFIX}\n\nmessages=12 sha256=abc\nThe user asked for a config summary.` },
  { role: 'user', content: 'Continue.' },
  {
    role: 'assistant',
    content: 'Done thinking.',
    thinkingBlocks: [{ type: 'thinking', thinking: 'Let me weigh the options carefully before answering.', signature: 'A'.repeat(120) }],
  },
  { role: 'user', content: 'ok' },
];
const base = { id: 's_inspect', provider: 'openai', model: 'gpt-test', contextWindow: 100000, cwd: 'C:/w', tools };
const withBaseline = (id, messages, input, extra = {}) => {
  const s = { ...base, id, messages, lastContextTokens: 1200, lastContextTokensUpdatedAt: NOW - 5000, ...extra };
  recordProviderContextBaseline(s, messages, { inputTokens: input, outputTokens: 100, cachedTokens: 0 }, { sendTools: tools });
  return s;
};

const sessions = [
  ['empty conversation', { ...base, id: 's_empty', messages: [] }],
  ['conversation', { ...base, messages: convo }],
  ['summary and reasoning', { ...base, id: 's_summary', messages: summary }],
  ['provider baseline over the whole transcript', withBaseline('s_base', convo, 1500)],
  ['provider baseline plus growth', withBaseline('s_growth', convo, 1500, {})],
  ['provider reading out of band', withBaseline('s_band', convo, 20)],
  [
    'anthropic deferred catalog',
    {
      ...base,
      id: 's_defer',
      provider: 'anthropic',
      model: 'claude-test',
      deferredNativeTools: true,
      deferredMcpToolNames: ['mcp__ok__found'],
      deferredDiscoveredTools: ['web_search', 'mcp__ok__found'],
      deferredToolCatalog: [
        { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'mcp__ok__found', description: 'Listed MCP tool', inputSchema: { type: 'object' } },
      ],
      deferredLateToolCatalog: [{ name: 'read', description: 'Late', inputSchema: { type: 'object' } }],
      messages: convo.slice(0, 7),
    },
  ],
];
// The growth case: the provider measured the transcript, then one more message arrived.
sessions[4][1].messages = [...convo, { role: 'user', content: 'and one more question please' }];

const cases = [];
for (const [name, session] of sessions) {
  if (only && only !== name) continue;
  const route = { provider: session.provider || '', model: session.model || '', contextWindow: session.contextWindow || null };
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => route,
    getCurrentCwd: () => session.cwd || '',
    getMode: () => 'default',
  });
  const messages = session.messages;
  const requestTools = snapshotProviderRequestTools({ provider: session.provider, tools: session.tools, nativeTools: [], messages, session });
  const calls = [];
  const ask = (options) => {
    const status = contextStatus(options);
    calls.push({ options: options ?? null, status });
    return status;
  };
  ask(undefined);
  const listed = ask({ inspect: true });
  const { revision, entries } = listed.inspection;
  for (const entry of entries) ask({ inspect: true, entryId: entry.id, revision });
  ask({ inspect: true, entryId: 'message:999', revision });
  ask({ inspect: true, entryId: entries[0]?.id ?? 'message:0', revision: 'not-a-revision' });
  // The list again: the reading the previews were answered from is the one retained.
  ask({ inspect: true });
  const header = Object.fromEntries(Object.entries(session).filter(([k]) => k !== 'messages' && k !== 'tools'));
  cases.push({
    name,
    header,
    messages,
    tools: session.tools,
    route,
    cwd: session.cwd || '',
    mode: 'default',
    active: hasRouteHistoryMessage(messages),
    agentMode: isAgentModeSession(session),
    requestTools: [...requestTools],
    nativePrefix: providerNativeToolPrefixCount(requestTools),
    breakdown: estimateToolSchemaBreakdown(requestTools),
    calls,
  });
}

const finalOut = join(FIXTURES_ROOT, 'context-inspection');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'createContextStatus(...).contextStatus(options) over crafted sessions at a fixed clock, every call of a case in the order made',
  now: NOW,
  cases,
});
writeSetManifest(out, {
  set: 'context-inspection',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: cases.length,
    syntheticInputs: [
      'the sessions: plain objects as the session store loads them; provider baselines written by recordProviderContextBaseline',
      'the request tools: snapshotProviderRequestTools for the session, as the gauge itself takes them',
    ],
    keptWhole: 'per call: the options and the whole status returned (inspection included)',
  },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);
process.exit(0);
