#!/usr/bin/env node
// What a manual compaction reports and records once its summary is made
// (session/manager/compaction-runner.mjs `commitSessionCompaction`, `recordFailedCompaction`): the real
// `runSessionCompaction(session, { mode: 'manual', force: true, provider })` over crafted sessions, with a
// fake summary provider passed through `opts.provider` (the summary call is the only part replaced; the
// plan, the fresh-context pipeline, the reconcile with the live transcript and the commit are Node's).
// Each case records the session before, the result object, the session after, and how the summary ran.
//
//   node benchmarks/rust-core/recorders/record-compaction-commit.mjs [--tree <tree>]
// Output: native/core/fixtures/compaction-commit/golden.json
process.env.TZ = 'UTC';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The product's import-time sweeps and archive writes act on its data directory: keep them off the real one.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'compaction-commit-'));
process.env.MIXDOG_HOME = process.env.MIXDOG_DATA_DIR;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MIXDOG_AGENT_COMPACT_') || name.startsWith('MIXDOG_COMPACT_') || name.startsWith('MIXDOG_MAIN_COMPACT_') || name.startsWith('MIXDOG_TOKEN_CALIBRATION_')) delete process.env[name];
}
import { commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, FIXTURES_ROOT } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const orch = 'src/runtime/agent/orchestrator';
const { runSessionCompaction } = await importFrom(tree, `${orch}/session/manager/compaction-runner.mjs`);
const { snapshotProviderRequestTools } = await importFrom(tree, `${orch}/runtime-core/tool-catalog.mjs`);
const { COMPACTION_CONFIG_KEYS } = await importFrom(tree, `${orch}/runtime-core/compaction-config-keys.mjs`);
const { providerNativeToolPrefixCount } = await importFrom(tree, `${orch}/runtime-core/provider-request-tools.mjs`);

const text = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
];
// Every message carries its transcript id, so what the commit drops is named the same on every run.
const stamp = (message, index) => ({ ...message, meta: { ...(message.meta || {}), transcript: { messageId: `msg_${String(index).padStart(3, '0')}` } } });
const conversation = (count, words) => Array.from({ length: count }, (_, i) => stamp(i % 2 ? { role: 'assistant', content: text(words, `a${i}_`) } : { role: 'user', content: text(words, `u${i}_`) }, i));
const session = (extra = {}, count = 40, words = 80) => ({
  id: 'sess_commit1',
  provider: 'openai',
  model: 'gpt-x',
  contextWindow: 8000,
  rawContextWindow: 8000,
  effectiveContextWindowPercent: 100,
  tools: [],
  messages: conversation(count, words),
  compaction: { auto: true },
  ...extra,
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const CASES = [
  { name: 'a summarized conversation', session: session() },
  { name: 'with tools on anthropic', session: session({ provider: 'anthropic', model: 'claude-x', contextWindow: 20_000, tools }, 60, 120) },
  { name: 'with a configured reserve and last reading', session: session({ compaction: { auto: true, reservedTokens: 300 }, lastContextTokens: 6000 }) },
  { name: 'a prior compaction record with legacy fields', session: session({ compaction: { auto: true, compactCount: 3, type: 'x', semantic: true, lastSemantic: 'y', lastError: 'old', mainBufferTokens: 500, enabled: true, model: 'm', lastStage: 'post_turn' } }) },
  { name: 'auto turned off in the record', session: session({ compaction: { auto: false } }) },
  { name: 'a small conversation compacts by rules', session: session({}, 6, 20) },
  { name: 'a late message is kept after the summary', session: session(), appended: 1, during: (live) => live.messages.push(stamp({ role: 'user', content: text(30, 'late') }, 900)) },
  { name: 'the conversation moved while summarizing', session: session(), during: (live) => { live.messages = live.messages.slice(1); } },
  { name: 'the summary fails', session: session(), fail: 'summary provider refused' },
  { name: 'usage with cache counters', session: session(), usage: { inputTokens: 1200, outputTokens: 80, cachedTokens: 300, cacheWriteTokens: 40 } },
];

const cases = [];
for (const entry of CASES) {
  const before = clone(entry.session);
  const live = clone(entry.session);
  const sends = [];
  let during = entry.during;
  const provider = {
    name: live.provider,
    send: async (...args) => {
      sends.push(args.length);
      // The conversation moves once, however many summary requests the pass makes.
      during?.(live);
      during = null;
      if (entry.fail) throw new Error(entry.fail);
      return { content: 'SUMMARY of the conversation so far', usage: entry.usage || { inputTokens: 1000, outputTokens: 50, cachedTokens: 0 } };
    },
  };
  let result;
  try {
    result = { value: (await runSessionCompaction(live, { mode: 'manual', force: true, provider, sessionId: live.id })) ?? null };
  } catch (error) {
    result = { error: String(error?.message || error) };
  }
  const after = clone(live);
  const requestTools = snapshotProviderRequestTools({ provider: after.provider, tools: after.tools, nativeTools: [], messages: after.messages, session: after });
  const beforeRequestTools = snapshotProviderRequestTools({ provider: before.provider, tools: before.tools, nativeTools: [], messages: before.messages, session: before });
  const mode = String(after.compaction?.lastCompactMode ?? '');
  cases.push({
    name: entry.name,
    before,
    beforeRequestTools: [...beforeRequestTools],
    beforeNativePrefix: providerNativeToolPrefixCount(beforeRequestTools),
    afterRequestTools: [...requestTools],
    afterNativePrefix: providerNativeToolPrefixCount(requestTools),
    // The messages a finished turn appended while the summary ran (they follow the compacted ones).
    appendedCount: entry.appended || 0,
    summaryCalls: sends.length,
    // How the pass ran, as the record reports it (`lastCompactMode`): the pipeline mode, then the summary kind and route.
    compactMode: mode,
    result,
    after,
  });
}
const finalDir = join(FIXTURES_ROOT, 'compaction-commit');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { now: NOW, configKeys: [...COMPACTION_CONFIG_KEYS], cases });
writeSetManifest(stage, { set: 'compaction-commit', recorder: 'benchmarks/rust-core/recorders/record-compaction-commit.mjs', command: 'node benchmarks/rust-core/recorders/record-compaction-commit.mjs --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
