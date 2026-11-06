#!/usr/bin/env node
// What a manual compaction reports before it summarizes anything (session/manager/compaction-runner.mjs):
// `runSessionCompaction(session, { mode: 'auto' })` over crafted sessions, which returns the result object
// for a pass that leaves the transcript alone (`below threshold`, or `no_token_reduction`) or null; plus
// `compactTargetBudget({ ...resolveSessionCompactionPolicy(session), force: true })` for the forced (manual)
// budget. Each case records the Node-shaped session, the provider request tools from the same Node
// function, and the result. Rust `compaction_plan` must give the same numbers.
//
//   node benchmarks/rust-core/recorders/record-compaction-plan.mjs [--tree <tree>]
// Output: native/core/fixtures/compaction-plan/golden.json
process.env.TZ = 'UTC';
// The product's session manager sweeps stale pending queues of its data directory on load: keep that off the real one.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'compaction-plan-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MIXDOG_AGENT_COMPACT_') || name.startsWith('MIXDOG_COMPACT_') || name.startsWith('MIXDOG_MAIN_COMPACT_') || name.startsWith('MIXDOG_TOKEN_CALIBRATION_')) delete process.env[name];
}
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, FIXTURES_ROOT } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const orch = 'src/runtime/agent/orchestrator';
const { runSessionCompaction, resolveSessionCompactionPolicy } = await importFrom(tree, `${orch}/session/manager/compaction-runner.mjs`);
const { snapshotProviderRequestTools } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { providerNativeToolPrefixCount } = await importFrom(tree, `${orch}/runtime-core/provider-request-tools.mjs`);
const { compactTargetBudget, recordProviderContextBaseline } = await importFrom(tree, `${orch}/session/loop/compact-policy.mjs`);

const text = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'tool_search', description: 'Find deferred tools', inputSchema: { type: 'object' }, deferLoading: true },
];
const messages = (count, words = 40) => Array.from({ length: count }, (_, i) => (i % 2 ? { role: 'assistant', content: text(words, `a${i}_`) } : { role: 'user', content: text(words, `u${i}_`) }));
const session = (extra = {}, count = 6, words = 40) => ({
  id: 'sess_plan1',
  provider: 'openai',
  model: 'gpt-x',
  contextWindow: 200_000,
  rawContextWindow: 200_000,
  effectiveContextWindowPercent: 100,
  tools,
  messages: messages(count, words),
  compaction: { auto: true },
  ...extra,
});
const withBaseline = (extra = {}, usage = { inputTokens: 5000, outputTokens: 100 }) => {
  const s = session(extra);
  recordProviderContextBaseline(s, s.messages, usage);
  return s;
};

const CASES = [
  ['openai window with tools', session()],
  ['no tools', session({ tools: [] })],
  ['anthropic calibration', session({ provider: 'anthropic', model: 'claude-x', contextWindow: 100_000 })],
  ['gemini calibration', session({ provider: 'gemini', model: 'gemini-x', contextWindow: 100_000 })],
  ['explicit boundary below the window', session({ compactBoundaryTokens: 24_000, contextWindow: 64_000 })],
  ['legacy auto limit below the boundary', session({ contextWindow: 64_000, autoCompactTokenLimit: 20_000 })],
  ['legacy auto limit only', session({ contextWindow: undefined, rawContextWindow: undefined, autoCompactTokenLimit: 12_000 })],
  ['configured reserve', session({ compaction: { auto: true, reservedTokens: 500 } })],
  ['configured main buffer tokens', session({ compaction: { auto: true, mainBufferTokens: 4000 } })],
  ['agent owner buffer', session({ owner: 'agent', compaction: { auto: true, bufferTokens: 3000 } })],
  ['configured target tokens', session({ compaction: { auto: true, targetTokens: 30_000 } })],
  ['last context tokens', session({ lastContextTokens: 1234 })],
  ['last context tokens stale after compact', session({ lastContextTokens: 1234, lastContextTokensStaleAfterCompact: true })],
  ['provider baseline', withBaseline()],
  ['provider baseline with a tool change', (() => { const s = withBaseline(); s.tools = [...tools, { name: 'glob', description: 'Find files', inputSchema: { type: 'object' } }]; return s; })()],
  ['provider baseline then more messages', (() => { const s = withBaseline(); s.messages.push({ role: 'user', content: text(60, 'later') }); return s; })()],
  ['auto disabled by the session', session({ compaction: { auto: false } })],
  ['agent mode ignores a disabled auto', session({ owner: 'agent', compaction: { auto: false } })],
  ['two messages', session({}, 2)],
  ['three messages', session({}, 3)],
  ['no window', session({ contextWindow: undefined, rawContextWindow: undefined })],
  ['a tiny window', session({ contextWindow: 2000 }, 8, 120)],
  ['a window the tools fill', session({ contextWindow: 600 }, 4, 20)],
  ['no messages', session({}, 0)],
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const cases = [];
for (const [name, source] of CASES) {
  const stored = clone(source);
  const live = clone(source);
  let result;
  try {
    const run = await runSessionCompaction(live, { mode: 'auto' });
    result = { value: run ?? null };
  } catch (error) {
    result = { error: String(error?.message || error) };
  }
  const forced = clone(source);
  let forcedBudget = null;
  let forcedError = null;
  try {
    const policy = resolveSessionCompactionPolicy(forced);
    forcedBudget = policy ? compactTargetBudget({ ...policy, force: true }) : null;
  } catch (error) {
    forcedError = String(error?.message || error);
  }
  const requestTools = stored.id ? snapshotProviderRequestTools({ provider: stored.provider, tools: stored.tools, nativeTools: [], messages: stored.messages, session: stored }) : [];
  const header = Object.fromEntries(Object.entries(stored).filter(([k]) => k !== 'messages' && k !== 'tools'));
  cases.push({ name, header, messages: stored.messages, tools: stored.tools, requestTools: [...requestTools], nativePrefix: providerNativeToolPrefixCount(requestTools), result, forcedBudget, forcedError });
}
const finalDir = join(FIXTURES_ROOT, 'compaction-plan');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { now: NOW, cases });
writeSetManifest(stage, { set: 'compaction-plan', recorder: 'benchmarks/rust-core/recorders/record-compaction-plan.mjs', command: 'node benchmarks/rust-core/recorders/record-compaction-plan.mjs --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
