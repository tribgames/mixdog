// Records Node's context-pressure state (loop/compact-policy.mjs, manager/turn-checkpoint-context.mjs):
// the usage snapshot, the provider baseline, their invalidations and the checkpoint restore.
//
//   node native/core/fixtures/agent/compact/record_pressure.mjs [--tree <node checkout with node_modules>]
//
// `golden/pressure.json`: per case the session header before the call, the transcript, the call's
// arguments, its return value and the header after it (Node mutates the session; a deleted field is
// absent from `after`). `images` holds Node's image descriptors of the messages that carry images.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-pressure-golden-'));
const agentDir = resolve(here, '..');
const stage = stageSet(agentDir, []);
const outDir = join(stage, 'compact');
mkdirSync(join(outDir, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);

const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const policy = await load('src/runtime/agent/orchestrator/session/loop/compact-policy.mjs');
const utils = await load('src/runtime/agent/orchestrator/session/context-utils.mjs');
const registry = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const media = await load('src/runtime/agent/orchestrator/providers/media-normalization.mjs');
const checkpoint = await load('src/runtime/agent/orchestrator/session/manager/turn-checkpoint-context.mjs');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const rows = {
  user: { role: 'user', content: 'hello  world' },
  call: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
  tool: { role: 'tool', toolCallId: 'c1', content: 'file body' },
  replay: {
    role: 'assistant',
    content: 'done',
    providerReplay: { items: [{ type: 'reasoning', id: 'r1', encrypted_content: 'Zm9v'.repeat(30) }] },
  },
  image: {
    role: 'assistant',
    content: 'look',
    assistantBlocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' }, width: 100, height: 50 }],
    meta: { transcript: { messageId: 'img1' } },
  },
  stored: { role: 'user', content: 'see [Image omitted from stored history: a.png]  \n now\u00a0here' },
};
const transcript = (...names) => names.map((name) => clone(rows[name]));
const imagesOf = (messages) =>
  Object.fromEntries(
    messages
      .filter((m) => m.meta?.transcript?.messageId)
      .map((m) => [m.meta.transcript.messageId, media.contentImageDescriptors(m.assistantBlocks)])
  );

const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'search', description: 'Search', inputSchema: { type: 'object' }, deferLoading: true },
];
const wireTools = (list) =>
  list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, deferLoading: t.deferLoading === true }));

const cases = [];
const record = (name, op, header, messages, args, call) => {
  const session = { ...clone(header), messages: clone(messages) };
  const result = call(session);
  const { messages: _messages, ...after } = session;
  cases.push({
    name,
    op,
    header: clone(header),
    messages,
    images: imagesOf(messages),
    args: clone(args),
    result: result === undefined ? null : clone(result),
    after: clone(after),
  });
};

// --- recordContextUsageSnapshot -------------------------------------------------
const allRows = transcript('user', 'call', 'tool', 'replay', 'image', 'stored');
const snapHeader = { provider: 'openai', model: 'gpt-x', usageMetricsTurnId: 't1', usageMetricsEpoch: 3, contextWindow: 200000 };
const snapPolicy = { triggerTokens: 150000, boundaryTokens: 180000, toolSchemaSignature: 'sig', provider: 'openai', contextWindow: 200000 };
const snapshot = (name, header, messages, pol, args) =>
  record(name, 'snapshot', header, messages, { policy: pol, ...args }, (s) => policy.recordContextUsageSnapshot(s, pol, { messages: s.messages, ...args }));
snapshot('snapshot-full', snapHeader, allRows, snapPolicy, { usedTokens: 1234.6, messageTokensEst: 1000.4, source: 'post_clear', updatedAt: 5000 });
snapshot('snapshot-estimates-when-not-a-number', {}, allRows, { boundaryTokens: '180000', provider: 'anthropic' }, { usedTokens: 10, messageTokensEst: 'x' });
snapshot('snapshot-absent-estimate-is-zero', snapHeader, allRows.slice(0, 3), snapPolicy, { usedTokens: 77 });
snapshot('snapshot-null-estimate-and-zero-updated-at', snapHeader, allRows.slice(0, 3), snapPolicy, { usedTokens: 77, messageTokensEst: null, updatedAt: 0, source: '' });
snapshot('snapshot-negative-used', snapHeader, allRows, snapPolicy, { usedTokens: -1 });
snapshot('snapshot-used-not-a-number', snapHeader, allRows, snapPolicy, { usedTokens: 'abc' });
snapshot('snapshot-used-missing', snapHeader, allRows, snapPolicy, {});
snapshot('snapshot-empty-transcript', { usageMetricsEpoch: '2x', usageMetricsTurnId: 7 }, [], { triggerTokens: 0, boundaryTokens: 4096 }, { usedTokens: 0 });
snapshot('snapshot-ends-on-tool-result', snapHeader, allRows.slice(0, 3), snapPolicy, { usedTokens: 5, updatedAt: '99.5' });
record('snapshot-replaces-an-older-one', 'snapshot', { ...snapHeader, contextUsageSnapshot: { usedTokens: 1 } }, allRows, { policy: snapPolicy, usedTokens: 9 }, (s) =>
  policy.recordContextUsageSnapshot(s, snapPolicy, { messages: s.messages, usedTokens: 9 })
);
record('invalidate-snapshot', 'invalidateSnapshot', { ...snapHeader, contextUsageSnapshot: { usedTokens: 1 } }, [], {}, (s) => policy.invalidateContextUsageSnapshot(s));

// --- recordProviderContextBaseline ---------------------------------------------
const baseline = (name, header, messages, usage, extra = {}, sendTools = tools) =>
  record(name, 'baseline', header, messages, { usage, tools: wireTools(sendTools), ...extra, excludesCache: registry.providerInputExcludesCache(header.provider), calibration: utils.providerTokenCalibration(header.provider) }, (s) =>
    policy.recordProviderContextBaseline(s, s.messages, usage, { ...extra, sendTools })
  );
const stale = {
  provider: 'openai',
  model: 'gpt-x',
  contextUsageSnapshot: { usedTokens: 1 },
  contextPressureUnanchoredAfterRestart: true,
  contextPressureUnanchoredReason: 'checkpoint_context_mismatch',
  compaction: { lastCompactAt: 4 },
};
baseline('baseline-openai-inclusive', stale, allRows, { inputTokens: 900, outputTokens: 100.4, cachedTokens: 50 });
baseline('baseline-anthropic-cache-exclusive', { ...stale, provider: 'anthropic' }, allRows, { inputTokens: 10, cachedTokens: 5000, cacheWriteTokens: 200, outputTokens: 30 }, { boundary: 'request' });
baseline('baseline-context-input-replaces-billed-prompt', stale, allRows, { contextInputTokens: 700, promptTokens: 500, inputTokens: 9000, outputTokens: 3 });
baseline('baseline-prompt-tokens', stale, allRows, { promptTokens: 640, inputTokens: 100, outputTokens: 1 });
baseline('baseline-occupancy-reading', stale, allRows, { contextTokens: 4321.6 });
baseline('baseline-occupancy-ignored-with-a-prompt', stale, allRows, { inputTokens: 5, contextTokens: 4321 });
baseline('baseline-no-tools', stale, allRows.slice(0, 2), { inputTokens: 8, outputTokens: 2 }, {}, []);
baseline('baseline-unknown-boundary', { provider: 'gemini' }, allRows, { inputTokens: 8 }, { boundary: 'later' });
baseline('baseline-empty-usage', stale, allRows, { inputTokens: 0, outputTokens: 0 });
baseline('baseline-usage-missing', stale, allRows, null);
baseline('baseline-usage-is-a-number', stale, allRows, 12);
record('invalidate-baseline', 'invalidateBaseline', { ...stale, contextPressureBaselineTokens: 5, contextPressureBaselineShapeSignature: 'x' }, [], {}, (s) =>
  policy.invalidateProviderContextBaseline(s)
);

// --- restoreTurnCheckpointContextState --------------------------------------------
const journalOf = (header, messages, boundary, build) => {
  const session = { ...clone(header), messages: clone(messages) };
  build(session);
  return JSON.parse(JSON.stringify({ contextState: checkpoint.captureTurnCheckpointContextState(session, session.messages, boundary) }));
};
const route = { provider: 'openai', model: 'gpt-x' };
const providerJournal = (messages, boundary = 0, usage = { inputTokens: 900, outputTokens: 100 }, boundaryKind = 'complete') =>
  journalOf(route, messages, boundary, (s) => {
    s.lastContextTokens = 800;
    s.compaction = { boundaryTokens: 180000, triggerTokens: 150000, lastCompactAt: 77, ignored: 'x' };
    policy.recordProviderContextBaseline(s, s.messages, usage, { boundary: boundaryKind, sendTools: tools });
  });
const compactJournal = (messages) =>
  journalOf(route, messages, 0, (s) => {
    s.usageMetricsTurnId = 'turn-9';
    s.usageMetricsEpoch = 4;
    s.compaction = { lastChangedAt: 12 };
    policy.recordContextUsageSnapshot(s, snapPolicy, { messages: s.messages, usedTokens: 321, source: 'post_compact' });
  });
const restore = (name, header, messages, journal) =>
  record(name, 'restore', header, messages, { checkpoint: journal }, (s) => checkpoint.restoreTurnCheckpointContextState(s, journal));

const fresh = { ...route, compaction: { lastCompactAt: 1, lastChangedAt: 2 }, contextPressureUnanchoredAfterRestart: true, contextPressureUnanchoredReason: 'x' };
restore('restore-provider', fresh, allRows, providerJournal(allRows));
restore('restore-provider-request-boundary', fresh, allRows, providerJournal(allRows, 0, { inputTokens: 900, outputTokens: 100, contextInputTokens: 880 }, 'request'));
restore('restore-provider-after-a-committed-prefix', fresh, allRows, providerJournal(allRows, 2));
restore('restore-post-compact', { ...fresh, usageMetricsTurnId: 'old' }, allRows, compactJournal(allRows));
restore('restore-keeps-stale-shape-signature', { ...fresh, contextPressureBaselineShapeSignature: 'kept' }, allRows, providerJournal(allRows));
const provider = providerJournal(allRows);
restore('restore-other-model-legacy-baseline-matches', { ...rowsBaseline(), model: 'other' }, allRows, provider);
function rowsBaseline() {
  const s = { ...route, messages: clone(allRows) };
  policy.recordProviderContextBaseline(s, s.messages, { inputTokens: 5, outputTokens: 1 }, { sendTools: tools });
  const { messages: _m, ...header } = s;
  return header;
}
restore('restore-other-model-unanchored', { provider: 'openai', model: 'other', contextPressureBaselineTokens: 500, contextPressureBaselinePrefixSignature: 'nope', contextPressureBaselineMessageCount: 3 }, allRows, provider);
restore('restore-unanchored-by-snapshot-tokens', { provider: 'openai', model: 'other', contextUsageSnapshot: { usedTokens: 40 } }, allRows, provider);
restore('restore-unanchored-by-last-context-tokens', { provider: 'openai', model: 'other', lastContextTokens: 9 }, allRows, provider);
restore('restore-nothing-retained', { provider: 'openai', model: 'other' }, allRows, provider);
restore('restore-no-journal-state', { ...route, contextPressureBaselineTokens: 3 }, allRows, {});
restore('restore-version-two', { ...route, contextPressureBaselineTokens: 3 }, allRows, { contextState: { ...provider.contextState, version: 2 } });
restore('restore-negative-used', { ...route, lastContextTokens: 3 }, allRows, { contextState: { ...provider.contextState, usedTokens: -4 } });
restore('restore-transcript-changed', { ...route, lastContextTokens: 3 }, [...allRows.slice(0, 2), { role: 'user', content: 'edited' }, ...allRows.slice(3)], provider);
restore('restore-transcript-shorter', { ...route, lastContextTokens: 3 }, allRows.slice(0, 2), provider);
restore('restore-slice-counts-missing', { ...route, lastContextTokens: 3 }, allRows, { contextState: { ...provider.contextState, turnMessageCount: undefined } });

writeFileSync(join(outDir, 'golden', 'pressure.json'), `${JSON.stringify({ now: NOW, tools: wireTools(tools), cases }, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, agentDir);
