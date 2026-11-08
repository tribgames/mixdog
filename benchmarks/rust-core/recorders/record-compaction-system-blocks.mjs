#!/usr/bin/env node
// A manual compaction over a session whose `messages` lead with the four system blocks
// (session/manager/compaction-runner.mjs `runSessionCompaction`, `compactionPlanNumbers`): Node plans and
// reports over `session.messages` including those blocks, so beforeMessages / afterMessages and the token
// numbers count them. The real `runSessionCompaction(session, { mode: 'manual', force: true, provider })`
// with a fake summary provider (the only replaced part), as record-compaction-commit.mjs does.
//
//   node benchmarks/rust-core/recorders/record-compaction-system-blocks.mjs --tree <tree> [--ref <commit>]
// Output: native/core/fixtures/compaction-system-blocks/golden.json
process.env.TZ = 'UTC';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'compaction-system-blocks-'));
process.env.MIXDOG_HOME = process.env.MIXDOG_DATA_DIR;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MIXDOG_AGENT_COMPACT_') || name.startsWith('MIXDOG_COMPACT_') || name.startsWith('MIXDOG_MAIN_COMPACT_') || name.startsWith('MIXDOG_TOKEN_CALIBRATION_')) delete process.env[name];
}
import { commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, FIXTURES_ROOT } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const args = parseArgs();
const tree = resolveTree(args);
const orch = 'src/runtime/agent/orchestrator';
const { runSessionCompaction } = await importFrom(tree, `${orch}/session/manager/compaction-runner.mjs`);
const { snapshotProviderRequestTools } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { providerNativeToolPrefixCount } = await importFrom(tree, `${orch}/runtime-core/provider-request-tools.mjs`);

const text = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const stamp = (message, index) => ({ ...message, meta: { transcript: { messageId: `msg_${String(index).padStart(3, '0')}` } } });
// Node's order and tiers: two untiered blocks, then tier3, then env.
const system = [
  { role: 'system', content: 'rules of the agent' },
  { role: 'system', content: 'stable rules' },
  { role: 'system', content: 'core context', cacheTier: 'tier3' },
  { role: 'system', content: 'environment facts', cacheTier: 'env' },
];
const conversation = (count, words) => Array.from({ length: count }, (_, i) => stamp(i % 2 ? { role: 'assistant', content: text(words, `a${i}_`) } : { role: 'user', content: text(words, `u${i}_`) }, i));
const wire = (session) => snapshotProviderRequestTools({ provider: session.provider, tools: session.tools, nativeTools: [], messages: session.messages, session });
const cases = [];
for (const [name, count, words] of [['four system blocks lead a conversation with nothing to compact', 6, 20], ['four system blocks lead a conversation that is summarized', 40, 80]]) {
  const before = {
    id: 'sess_system1',
    provider: 'openai',
    model: 'gpt-x',
    contextWindow: 8000,
    rawContextWindow: 8000,
    effectiveContextWindowPercent: 100,
    tools: [],
    messages: [...system, ...conversation(count, words)],
    compaction: { auto: true },
  };
  const live = JSON.parse(JSON.stringify(before));
  const provider = {
    name: live.provider,
    send: async () => ({ content: 'SUMMARY of the conversation so far', usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 0 } }),
  };
  const result = (await runSessionCompaction(live, { mode: 'manual', force: true, provider, sessionId: live.id })) ?? null;
  const beforeRequestTools = wire(before);
  const afterRequestTools = wire(live);
  cases.push({
    name,
    before,
    beforeRequestTools: [...beforeRequestTools],
    beforeNativePrefix: providerNativeToolPrefixCount(beforeRequestTools),
    afterRequestTools: [...afterRequestTools],
    afterNativePrefix: providerNativeToolPrefixCount(afterRequestTools),
    appendedCount: 0,
    compactMode: String(live.compaction?.lastCompactMode ?? ''),
    result: { value: result },
    after: JSON.parse(JSON.stringify(live)),
  });
}const finalDir = join(FIXTURES_ROOT, 'compaction-system-blocks');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { now: NOW, cases });
writeSetManifest(stage, {
  set: 'compaction-system-blocks',
  recorder: 'benchmarks/rust-core/recorders/record-compaction-system-blocks.mjs',
  command: 'node benchmarks/rust-core/recorders/record-compaction-system-blocks.mjs --tree <tree> --ref <commit>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
