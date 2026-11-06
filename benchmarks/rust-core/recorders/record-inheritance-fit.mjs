#!/usr/bin/env node
// What session inheritance measures a conversation against (session-runtime/inheritance-fit.mjs):
// `inheritanceFit(messages, target)` for a route target and `inheritanceCompactionPlan(target)`.
// Rust `run_host::inheritance_fit` must give the same `known`, `used` and `limit` and the same
// "has a compaction plan" for the same target and conversation.
//
//   node benchmarks/rust-core/recorders/record-inheritance-fit.mjs [--tree <dir>]
//
// Output: native/core/fixtures/inheritance-fit/golden.json. The targets are the shape
// `inheritanceRouteTarget` returns (its window fields come from the already recorded
// `session-context-meta` set), so the run does not depend on a provider catalog.
process.env.TZ = 'UTC';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MIXDOG_AGENT_COMPACT_') || name.startsWith('MIXDOG_TOKEN_CALIBRATION_')) delete process.env[name];
}
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'inheritance-fit');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-inheritance-fit.mjs';
const at = (path) => importFrom(tree, path);
const { inheritanceFit, inheritanceCompactionPlan } = await at('src/session-runtime/inheritance-fit.mjs');

const text = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const user = (content) => ({ role: 'user', content });
const assistant = (content, extra = {}) => ({ role: 'assistant', content, ...extra });
const tool = (id, content) => ({ role: 'tool', toolCallId: id, content });
const call = (id, name, args) => ({ id, name, arguments: args });
const schema = (props) => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: props }, (_, i) => [`field${i}`, { type: 'string', description: `the ${i}th field of the call` }])) });
const tools = (count, props, deferred = 0) =>
  Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i} does one thing and reports how it went.`,
    inputSchema: schema(props),
    ...(i < deferred ? { deferLoading: true } : {}),
  }));

const CONVERSATIONS = {
  empty: [],
  system_only: [{ role: 'system', content: text(400, 'rule') }],
  short: [{ role: 'system', content: 'rules' }, user('fix the bug'), assistant('on it')],
  tools: [
    user('read the file'),
    assistant('reading', { toolCalls: [call('c1', 'read', { path: 'a.txt' })] }),
    tool('c1', text(300, 'line')),
    assistant('done'),
  ],
  medium: Array.from({ length: 60 }, (_, i) => (i % 2 ? assistant(text(120, `a${i}_`)) : user(text(80, `u${i}_`)))),
  large: Array.from({ length: 100 }, (_, i) => (i % 2 ? assistant(text(160, `a${i}_`)) : user(text(120, `u${i}_`)))),
  parts: [
    user([{ type: 'text', text: 'look at this' }, { type: 'text', text: text(50, 'p') }]),
    assistant([{ type: 'text', text: text(40, 'q') }]),
  ],
  replay: [
    user('think'),
    assistant('thought', { providerReplay: { provider: 'anthropic', items: [{ type: 'thinking', thinking: text(200, 't'), signature: 'sig'.repeat(100) }] } }),
  ],
};
const route = (provider, model, window, extra = {}) => ({
  provider,
  model,
  contextWindow: window,
  rawContextWindow: window,
  effectiveContextWindowPercent: 100,
  autoCompactTokenLimit: null,
  compactBoundaryTokens: window,
  compaction: { auto: true },
  tools: [],
  ...extra,
});
const TARGETS = {
  anthropic_small: route('anthropic', 'claude-x', 8_000),
  anthropic_mid: route('anthropic', 'claude-x', 32_000, { tools: tools(6, 4) }),
  gemini_mid: route('gemini', 'gemini-x', 32_000, { tools: tools(12, 8) }),
  openai_big: route('openai', 'gpt-x', 200_000, { tools: tools(30, 10) }),
  openai_deferred: route('openai', 'gpt-x', 16_000, { tools: tools(20, 10, 15) }),
  openai_limit: route('openai', 'gpt-x', 64_000, { autoCompactTokenLimit: 20_000 }),
  openai_boundary: route('openai', 'gpt-x', 64_000, { compactBoundaryTokens: 24_000 }),
  openai_tiny_tools: route('openai', 'gpt-x', 4_000, { tools: tools(40, 12) }),
  no_window: route('openai', 'gpt-x', null, { rawContextWindow: null, compactBoundaryTokens: null }),
  legacy_limit_only: route('openai', 'gpt-x', null, { rawContextWindow: null, compactBoundaryTokens: null, autoCompactTokenLimit: 12_000 }),
};

const cases = [];
for (const [targetName, target] of Object.entries(TARGETS)) {
  const plan = inheritanceCompactionPlan(target);
  for (const [name, messages] of Object.entries(CONVERSATIONS)) {
    const fit = inheritanceFit(messages, target);
    cases.push({ target: targetName, conversation: name, fit: { known: fit.known, fits: fit.fits, used: fit.used, limit: fit.limit, percent: fit.percent, messages: fit.messages }, compactable: plan !== null });
  }
}
// The token estimate prices the serialized text (a tool's schema, a replay envelope), so the key
// order the tools and conversations were built in is part of the input; `writeJson` keeps it.
writeJson(join(stage, 'golden.json'), { targets: TARGETS, conversations: CONVERSATIONS, cases });
writeSetManifest(stage, { set: 'inheritance-fit', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
