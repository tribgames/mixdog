// Records Node's compaction outputs the Rust port is tested against.
//
//   node native/core/fixtures/agent/compact/record.mjs [--tree <node checkout with node_modules>]
//
// Each golden is `golden/<name>.json`: the Node-shaped input messages and the
// value Node computed from them. Messages are plain Node transcript rows
// (`role`, `content`, `toolCalls`, `toolCallId`, `meta`, ...); the Rust test
// support converts them into agent messages.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const sessionDir = join(nodeRoot, 'src/runtime/agent/orchestrator/session');
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-compact-golden-'));
// The `agent` set is shared with the agent-loop recorders: stage a copy, overwrite only this recorder's goldens,
// re-list the shared manifest, then swap the finished copy in.
const agentDir = resolve(here, '..');
const stage = stageSet(agentDir, []);
const outDir = join(stage, 'compact');
mkdirSync(join(outDir, 'golden'), { recursive: true });

const load = (rel) => import(pathToFileURL(join(sessionDir, rel)).href);
const write = (name, value) => writeFileSync(join(outDir, 'golden', `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

const { estimateMessageTokens, estimateMessagesTokens } = await load('context-utils.mjs');

// ---- 1. token meter ---------------------------------------------------------
const opaque = 'A'.repeat(200);
const call = (id, name, args) => ({ id, name, arguments: args });
const meterCases = [
  { role: 'user', content: 'hello world' },
  { role: 'user', content: '' },
  { role: 'user', content: '한국어 문장입니다 😀 mixed text' },
  { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: '' }, { type: 'text', text: 'part two' }] },
  { role: 'assistant', content: 'calling', toolCalls: [call('c1', 'read', { path: 'a/b.txt', n: 3 })] },
  { role: 'assistant', content: '', toolCalls: [call('c1', 'grep', { pattern: 'x', flags: ['i', 'm'] }), call('c2', 'read', {})] },
  { role: 'tool', toolCallId: 'call_abc123', content: 'result body\nline two' },
  { role: 'tool', toolCallId: 'c9', content: JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 'e' } }, null, 2) },
  { role: 'assistant', content: 'thinking out loud', thinkingBlocks: [{ type: 'thinking', thinking: 'hmm', signature: opaque }] },
  { role: 'assistant', content: 'blocks', assistantBlocks: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'read', input: { p: 1 } }] },
  {
    role: 'assistant',
    content: 'replayed',
    toolCalls: [call('c1', 'read', { path: 'x' })],
    providerReplay: { items: [{ type: 'reasoning', id: 'r1', encrypted_content: opaque }, { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"x"}' }] },
  },
  { role: 'assistant', content: 'img', assistantBlocks: [{ type: 'image', source: { type: 'base64', data: 'QUJD', media_type: 'image/png' }, width: 1280, height: 720 }] },
  { role: 'assistant', content: 'img2', assistantBlocks: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
  { role: 'user', content: 'tab\tand "quotes" and \\ backslash \u0001 ctl' },
];
write('meter', {
  cases: meterCases.map((message) => ({ message, tokens: estimateMessageTokens(message) })),
  total: estimateMessagesTokens(meterCases),
});

// ---- 2. rule-only fresh context ----------------------------------------------
const { freshContextCompactMessages } = await load('compact/runner.mjs');
const dataRoot = process.env.MIXDOG_DATA_DIR;
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(dataRoot.replaceAll('\\', '\\\\'), '<DATA>')
      .replaceAll('\\\\', '/')
  );
const asst = (content, ...toolCalls) => (toolCalls.length ? { role: 'assistant', content, toolCalls } : { role: 'assistant', content });
const tool = (toolCallId, content) => ({ role: 'tool', content, toolCallId });
const big = (label, n) => `${label}\n${'lorem ipsum dolor sit amet '.repeat(n)}`;
const SESSION = 'sess_golden';

const freshScenarios = [
  {
    name: 'fresh_conversation',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [{ role: 'user', content: 'hello there' }, asst('hi, how can I help?'), { role: 'user', content: 'refactor the parser' }],
  },
  {
    name: 'fresh_groups_fit',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [
      { role: 'user', content: 'read the config' },
      asst('reading', call('c1', 'read', { path: 'a.txt' })),
      tool('c1', 'file body'),
      asst('now editing', call('c2', 'edit', { path: 'a.txt', old: 'x', new: 'y' })),
      tool('c2', 'ok'),
    ],
  },
  {
    name: 'fresh_groups_archive',
    budget: 30000,
    options: { contextWindow: 20000, maxBudgetTokens: 30000, activeTurn: true },
    messages: [
      { role: 'user', content: 'investigate the build' },
      asst('step one', call('c1', 'bash', { command: 'make' })),
      tool('c1', big('build output one', 120)),
      asst('step two', call('c2', 'bash', { command: 'make test' })),
      tool('c2', big('build output two', 120)),
      asst('step three', call('c3', 'read', { path: 'log.txt' })),
      tool('c3', 'short result'),
    ],
  },
  {
    name: 'fresh_browser_supersede',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [
      { role: 'user', content: 'check the page' },
      asst('open', call('b1', 'browser', { action: 'snapshot' })),
      tool('b1', 'Navigated.\n\nSnapshot: p1-s1\n- button "Go" [ref=e1]\n- link "More" [ref=e2]'),
      asst('again', call('b2', 'browser', { action: 'snapshot' })),
      tool('b2', 'Snapshot: p1-s2\n- button "Go" [ref=e1]'),
      asst('and again', call('b3', 'read', { path: 'x.txt' })),
      tool('b3', 'x'),
    ],
  },
  {
    name: 'fresh_handoff',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true, handoffText: '## Goal\n- fix the parser\n\n## Progress\n- (none)' },
    messages: [
      { role: 'user', content: 'start the work' },
      asst('on it', call('c1', 'read', { path: 'p.rs' })),
      tool('c1', 'fn main() {}'),
      { role: 'user', content: 'continue please' },
    ],
  },
  {
    name: 'fresh_protected_prefix',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: '<system-reminder>\nclock: now\n</system-reminder>' },
      asst('.'),
      { role: 'user', content: 'Reference files:\n### src/a.rs\nfn a(){}\n### src/b.rs\nfn b(){}\n### src/a.rs\nagain' },
      { role: 'user', content: 'hello' },
      asst('hi'),
      { role: 'user', content: 'go on' },
    ],
  },
  {
    name: 'fresh_secrets',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [
      { role: 'user', content: 'call the api' },
      asst('calling', call('c1', 'bash', { command: 'curl -H "authorization: Bearer abc.def" x', apiKey: 'k-123', nested: { password: 'p', note: 'token=abc rest' } })),
      tool('c1', 'done'),
    ],
  },
  {
    name: 'fresh_previous_summary',
    budget: 200000,
    options: { contextWindow: 200000, maxBudgetTokens: 200000, activeTurn: true },
    messages: [
      { role: 'user', content: 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done.\nmessages=3 sha256=abcdabcdabcdabcd roles=user:3\n\n## Goal\n- x', meta: { source: 'compact-summary' } },
      { role: 'assistant', content: '.', meta: { source: 'context-ack' } },
      { role: 'user', content: 'next task' },
      asst('working', call('c1', 'read', { path: 'q' })),
      tool('c1', 'qq'),
    ],
  },
];

write('fresh', {
  sessionId: SESSION,
  scenarios: freshScenarios.map((s) => {
    const result = freshContextCompactMessages(s.messages, s.budget, {
      ...s.options,
      force: true,
      preview: true,
      sessionId: SESSION,
    });
    return normalize({ name: s.name, budget: s.budget, options: s.options, messages: s.messages, result: result.messages, freshContext: result.freshContext });
  }),
});

// ---- 3. summary prompts, schema repair, handoff fitting ------------------------
const summaryMod = await load('compact/summary.mjs');
const VALID_SUMMARY = [
  '## Goal', '- fix the parser', '', '## Constraints & Preferences', '- (none)', '', '## Progress', '### Done', '- read src/parser.rs', '',
  '### In Progress', '- editing', '', '### Blocked', '- (none)', '', '## Key Decisions', '- keep the API', '', '## Next Steps', '- run tests', '',
  '## Critical Context', '- error E0308 at parser.rs:12', '', '## Relevant Files', '- src/parser.rs: the parser',
].join('\n');
const sumHead = [
  { role: 'user', content: 'please fix the parser in src/parser.rs and ./lib/util.mjs' },
  { role: 'assistant', content: 'looking', toolCalls: [call('c1', 'read', { path: 'src/parser.rs', password: 'hunter2', list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], z: 1, a: { b: { c: { d: { e: 1 } } } } })] },
  { role: 'tool', content: 'fn parse() {}\r\nsecond line', toolCallId: 'c1' },
  { role: 'assistant', content: '', toolCalls: [call('c2', 'bash', { command: 'x'.repeat(500) }), call('c3', 'a', {}), call('c4', 'b', {}), call('c5', 'c', {}), call('c6', 'd', {})] },
  { role: 'user', content: 'x'.repeat(40) + ' middle ' + 'y'.repeat(40) },
];
const enforceCases = [
  { name: 'valid', summary: VALID_SUMMARY },
  { name: 'empty', summary: '   ' },
  { name: 'blob', summary: 'just some prose about the work' },
  { name: 'partial', summary: '## Goal\n- do x\n\n## Next Steps\n- y\n\n## Extra Notes\n- keep me' },
  { name: 'fenced', summary: '```\n## Goal\n```\n## Progress\n- a' },
  { name: 'goalkeeper', summary: VALID_SUMMARY.replace('## Goal', '## Goalkeeper') },
];
const fitCases = [
  { name: 'big', summary: VALID_SUMMARY, remaining: 100000 },
  { name: 'mid', summary: VALID_SUMMARY + '\n- ' + 'detail '.repeat(300), remaining: 400 },
  { name: 'tiny', summary: VALID_SUMMARY, remaining: 10 },
  { name: 'empty', summary: '', remaining: 100000 },
];
write('summary', {
  head: sumHead,
  systemPrompt: summaryMod.COMPACTION_SYSTEM_PROMPT,
  forkedPrompt: summaryMod.forkedCompactionPrompt(),
  prompts: [
    { previous: null, target: 1e9, prompt: summaryMod.fitCompleteCompactionPrompt({ head: sumHead, tail: [], previousSummary: null, preservedFacts: null }, 1e9) },
    { previous: VALID_SUMMARY, target: 1e9, prompt: summaryMod.fitCompleteCompactionPrompt({ head: sumHead, tail: [], previousSummary: VALID_SUMMARY, preservedFacts: null }, 1e9) },
    { previous: null, target: 20, prompt: summaryMod.fitCompleteCompactionPrompt({ head: sumHead, tail: [], previousSummary: null, preservedFacts: null }, 20) },
    { previous: null, target: 1e9, head: [], prompt: summaryMod.fitCompleteCompactionPrompt({ head: [], tail: [], previousSummary: null, preservedFacts: null }, 1e9) },
  ],
  enforce: enforceCases.map((c) => ({ ...c, result: summaryMod.enforceCompactSummarySchema(c.summary, { head: sumHead, tail: sumHead.slice(-1) }) })),
  fits: fitCases.map((c) => ({
    ...c,
    result: summaryMod.fitGeneratedHandoffMessage(sumHead, c.summary, c.remaining, { provider: 'anthropic', model: 'opus' }),
  })),
});

// ---- 4. conversation compaction input ----------------------------------------
const { conversationCompactionInput } = await load('compact/runner.mjs');
const convoMessages = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work.\nmessages=2 sha256=abcdabcdabcdabcd roles=user:2\n\n## Goal\n- x', meta: { source: 'compact-summary' } },
  { role: 'assistant', content: '.', meta: { source: 'context-ack' } },
  { role: 'user', content: 'first request about a.rs' },
  { role: 'assistant', content: 'on it', toolCalls: [call('c1', 'bash', { command: 'curl -H "authorization: Bearer abc.def"  x', note: 'a   b\nc' }), call('c2', 'ask_user', { q: 'which?' }), call('c3', 'read', {})] },
  { role: 'tool', content: `ok   result\n${'word '.repeat(100)} password=hunter2 end`, toolCallId: 'c1' },
  { role: 'tool', content: 'blue ' + 'z'.repeat(400), toolCallId: 'c2' },
  { role: 'user', content: '[mixdog-runtime] nudge' },
  { role: 'user', content: '(attachment)' },
  { role: 'user', content: '[Request interrupted by user]' },
  { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Shell task done</summary>\n<result>\nout token=abc123\n</result>\n</task-notification>', meta: { source: 'task-notification' } },
  { role: 'assistant', content: `${'a'.repeat(1599)}😀${'b'.repeat(30)}` },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'latest request' },
  { role: 'user', content: '<task-notification>\n<task-id>t2</task-id>\n<status>completed</status>\n<summary>Shell task later</summary>\n</task-notification>', meta: { source: 'task-notification' } },
];
write('conversation', {
  messages: convoMessages,
  plain: conversationCompactionInput(convoMessages).map(({ role, content }) => ({ role, content })),
  summary: conversationCompactionInput(convoMessages, { summary: true }).map(({ role, content }) => ({ role, content })),
});

// ---- 5. handoff summary generation (batching) -----------------------------------
const { generateFreshHandoffSummary } = await load('compact/runner.mjs');
const longTurns = [];
for (let i = 0; i < 24; i += 1) {
  longTurns.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}: ${'discussing src/mod${i}.rs and details '.repeat(12)}` });
}
async function handoffRun(name, messages, budget, opts, responses) {
  const sent = [];
  let next = 0;
  const provider = {
    name: 'anthropic',
    send: async (msgs, model, _tools, sendOpts) => {
      sent.push({ system: msgs[0].content, prompt: msgs[1].content, model, maxOutputTokens: sendOpts.maxOutputTokens });
      return { content: responses[next++] ?? responses.at(-1), usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 2 } };
    },
  };
  const result = await generateFreshHandoffSummary(provider, messages, 'opus', budget, { providerName: 'anthropic', sessionId: SESSION, ...opts });
  return { name, messages, budget, opts, responses, sent, summary: result.summary, repaired: result.summaryRepaired, usage: result.usage, calls: result.diagnostics.calls, message: result.messages.at(-1) };
}
write('handoff', {
  runs: [
    await handoffRun('single', longTurns.slice(0, 4), 50000, { compactionInputBudgetTokens: 50000, maxOutputTokens: 4096 }, [VALID_SUMMARY]),
    await handoffRun('batched', longTurns, 50000, { compactionInputBudgetTokens: 1700, maxOutputTokens: 600 }, [VALID_SUMMARY, 'plain prose answer', VALID_SUMMARY]),
    await handoffRun(
      'previous',
      [{ role: 'user', content: `A previous model worked on this task and produced the compacted handoff summary below. Build on the work.\nmessages=2 sha256=abcdabcdabcdabcd roles=user:2\n\n${VALID_SUMMARY}`, meta: { source: 'compact-summary' } }, { role: 'assistant', content: '.', meta: { source: 'context-ack' } }, ...longTurns.slice(0, 6)],
      50000,
      { compactionInputBudgetTokens: 50000 },
      [VALID_SUMMARY]
    ),
  ],
});

// ---- 6. dropped identities ----------------------------------------------------
const { prepareCompactionArchive } = await load('compaction-archive-capture.mjs');
const { stampMessageIds } = await load('message-ids.mjs');
mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
const stampAll = (messages, sessionId) => {
  const out = messages.slice();
  stampMessageIds(out, { sessionId });
  return out;
};
const withAt = (value, row) => ({ ...row, meta: { transcript: { at: value } } });
const droppedCase = async (name, build) => {
  const sessionId = `dropped-${name}`;
  const { before, after } = build(sessionId);
  const prepared = prepareCompactionArchive({ session: { id: sessionId }, sessionId, before, after });
  const identities = prepared ? prepared.identities : null;
  if (prepared) {
    await prepared.durable;
    prepared.cancel();
  }
  return { name, before, after, droppedMessages: prepared ? prepared.dropped : 0, identities };
};
const summaryRow = { role: 'user', content: 'A previous model worked on this task and produced the compacted handoff summary below.\n\n## Goal', meta: { source: 'compact-summary' } };
write('dropped', {
  cases: [
    await droppedCase('mixed', (sid) => {
      const call = { role: 'assistant', content: 'reading both', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }, { id: 'c2', name: 'read', arguments: { path: 'b' } }] };
      const before = stampAll([withAt(1, { role: 'user', content: 'old question' }), call, tool('c1', 'a very long tool output'), tool('c2', 'b output'), withAt(2, { role: 'assistant', content: 'old answer' }), withAt(3, { role: 'user', content: 'recent question' }), withAt(4, { role: 'assistant', content: 'recent answer' })], sid);
      const after = [summaryRow, { ...before[1], toolCalls: [before[1].toolCalls[1]] }, { ...before[3], content: '[trimmed]' }, before[5], before[6]];
      return { before, after };
    }),
    await droppedCase('partial', (sid) => {
      const call = withAt(2, { role: 'assistant', content: 'reading a first', toolCalls: [{ id: 'pc1', name: 'read', arguments: { path: 'a' } }] });
      const before = stampAll([withAt(1, { role: 'user', content: 'inspect a' }), call, tool('pc1', 'a body')], sid);
      return { before, after: [before[0], { ...before[1], content: '' }, before[2]] };
    }),
    await droppedCase('hidden_only', (sid) => {
      const before = stampAll([withAt(1, { role: 'user', content: 'question' }), withAt(2, { role: 'user', content: '[Request interrupted by user]' }), withAt(3, { role: 'user', content: '[Request interrupted by user for tool use]' })], sid);
      return { before, after: [summaryRow, before[0]] };
    }),
    // Rows whose text is hidden but whose stored meta makes the transcript draw something.
    await droppedCase('task_notification', (sid) => {
      const notice = withAt(2, { role: 'user', content: 'Async agent task task_1 (completed) finished.', meta: { source: 'task-notification', execution: { surface: 'agent', status: 'completed', id: 'task_1' } } });
      const before = stampAll([withAt(1, { role: 'user', content: 'question' }), notice], sid);
      return { before, after: [summaryRow, before[0]] };
    }),
    await droppedCase('completion', (sid) => {
      const failed = { role: 'assistant', content: '', meta: { transcript: { at: 2, completion: { status: 'failed', elapsedMs: 5 } } } };
      const before = stampAll([withAt(1, { role: 'user', content: 'question' }), failed], sid);
      return { before, after: [summaryRow, before[0]] };
    }),
    await droppedCase('model_switch', (sid) => {
      const switched = { role: 'user', content: '[Request interrupted by user]', meta: { transcript: { at: 2 }, modelSwitches: [{ provider: 'openai', modelId: 'next-model', at: 2 }] } };
      const before = stampAll([withAt(1, { role: 'user', content: 'question' }), switched], sid);
      return { before, after: [summaryRow, before[0]] };
    }),
    await droppedCase('rewrite_only', (sid) => {
      const before = stampAll([withAt(1, { role: 'user', content: 'question' }), withAt(2, { role: 'assistant', content: 'answer' })], sid);
      return { before, after: [before[0], { ...before[1], content: 'answer (rewritten)' }] };
    }),
  ],
});
refreshSetManifest(stage, nodeRoot);
commitStage(stage, agentDir);
