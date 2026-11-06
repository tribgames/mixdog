// Records Node's context-pressure state (loop/compact-policy.mjs, manager/turn-checkpoint-context.mjs):
// the usage snapshot, the provider baseline, their invalidations and the checkpoint restore.
//
//   node native/core/fixtures/agent/compact/record_pressure.mjs [--tree <node checkout with node_modules>]
//
// `golden/pressure.json`: per case the session header before the call, the transcript, the call's
// arguments, its return value and the header after it (Node mutates the session; a deleted field is
// absent from `after`). `images` holds Node's image descriptors of the messages that carry images.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, refreshSetManifest, resolveTree } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-pressure-golden-'));
const agentDir = resolve(here, '..');
// The `agent` set is shared with the agent-loop recorders: write only this recorder's golden, then re-list
// the shared manifest.
const outDir = here;
mkdirSync(join(outDir, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);

const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const policy = await load('src/runtime/agent/orchestrator/session/loop/compact-policy.mjs');
const utils = await load('src/runtime/agent/orchestrator/session/context-utils.mjs');
const registry = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const media = await load('src/runtime/agent/orchestrator/providers/media-normalization.mjs');
const { finalizeProviderRequestTools } = await load('src/runtime/agent/orchestrator/runtime-core/provider-request-tools.mjs');
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
  // Tails that carry the id the snapshot records: `uuid` wins over `id`, which wins over `toolCallId`.
  withId: { role: 'user', content: 'ping', id: 'm-77', meta: { transcript: { messageId: 'id1' } } },
  withUuid: { role: 'assistant', content: 'pong', uuid: 'u-5', id: 'ignored', meta: { transcript: { messageId: 'id2' } } },
  toolWithId: { role: 'tool', toolCallId: 'c9', id: 'row-9', content: 'x', meta: { transcript: { messageId: 'id3' } } },
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
snapshot('snapshot-tail-id', snapHeader, transcript('user', 'withId'), snapPolicy, { usedTokens: 5 });
snapshot('snapshot-tail-uuid-wins', snapHeader, transcript('user', 'withUuid'), snapPolicy, { usedTokens: 5 });
snapshot('snapshot-tail-row-id-beats-tool-call-id', snapHeader, transcript('call', 'toolWithId'), snapPolicy, { usedTokens: 5 });
snapshot('snapshot-ends-on-tool-result', snapHeader, allRows.slice(0, 3), snapPolicy, { usedTokens: 5, updatedAt: '99.5' });
record('snapshot-replaces-an-older-one', 'snapshot', { ...snapHeader, contextUsageSnapshot: { usedTokens: 1 } }, allRows, { policy: snapPolicy, usedTokens: 9 }, (s) =>
  policy.recordContextUsageSnapshot(s, snapPolicy, { messages: s.messages, usedTokens: 9 })
);
record('invalidate-snapshot', 'invalidateSnapshot', { ...snapHeader, contextUsageSnapshot: { usedTokens: 1 } }, [], {}, (s) => policy.invalidateContextUsageSnapshot(s));

// --- recordProviderContextBaseline ---------------------------------------------
// `native` objects are the provider-native prefix of the request's tools, sent as they are.
const baseline = (name, header, messages, usage, extra = {}, sendTools = tools, native = []) =>
  record(name, 'baseline', header, messages, { usage, tools: wireTools(sendTools), native, ...extra, excludesCache: registry.providerInputExcludesCache(header.provider), calibration: utils.providerTokenCalibration(header.provider) }, (s) =>
    policy.recordProviderContextBaseline(s, s.messages, usage, {
      ...extra,
      sendTools: native.length ? finalizeProviderRequestTools([...clone(native), ...sendTools], native.length) : sendTools,
    })
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
const nativeTools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }, { type: 'memory_20250818', name: 'memory', defer_loading: true }];
baseline('baseline-native-tool-prefix', stale, allRows, { inputTokens: 900, outputTokens: 100 }, {}, tools, nativeTools);
baseline('baseline-native-prefix-without-defined-tools', stale, allRows, { inputTokens: 900, outputTokens: 100 }, {}, [], nativeTools.slice(0, 1));
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

// --- The same signatures and restore over Node-shaped rows (the 1.4.5 migration) -------------
// Rows are signed as they are: media parts are measured from the parts themselves.
const sha = (c) => c.repeat(64);
const rowSets = {
  media: [
    { role: 'user', content: [{ type: 'text', text: 'look at these' }, { type: 'image', data: 'AAAABBBB', mimeType: 'image/jpeg', width: 640, height: 480, detail: 'HIGH' }] },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'IMAGE/PNG', data: 'Zm9v' }, dimensions: { width: 1280, height: 720 } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'low' } }, { type: 'image', source: { type: 'url', url: 'https://x.test/b.png' } }] },
    { role: 'user', content: { type: 'image_url', image_url: 'https://x.test/single.png' } },
    { role: 'user', content: [{ type: 'image', attachmentRef: sha('a'), mimeType: 'image/png', width: 100, height: 50 }, { type: 'input_image', file_id: 'file_1' }] },
    { role: 'user', content: [{ inlineData: { mimeType: 'image/webp', data: 'QUJD' }, width: 10 }, { type: 'image', uri: 'gs://b/o.png', mime_type: 'image/gif' }, { fileData: { fileUri: 'gs://b/p.png' } }] },
    {
      role: 'assistant',
      content: 'described',
      toolCalls: [{ id: 'c1', name: 'screenshot', arguments: { full: true } }],
      assistantBlocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' }, width: 200, height: 100 }, { type: 'text', text: 'blk' }],
      providerReplay: { items: [{ type: 'input_image', image_url: 'https://x.test/r.png' }, { type: 'reasoning', id: 'r1', encrypted_content: 'Zm9v'.repeat(30) }] },
    },
    { role: 'assistant', content: '', providerReplay: { items: [] }, thinkingBlocks: [{ type: 'thinking', thinking: 'ignored', signature: 'Zm9v'.repeat(30) }] },
    { role: 'assistant', content: 'x', thinkingBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'Zm9v'.repeat(30) }], reasoningItems: [{ type: 'reasoning', id: 'r2' }], providerMetadata: { gemini: { thoughtParts: [{ text: 'g', thought: true }] } } },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'REVG', mimeType: 'image/png' }] },
    { role: 'user', content: 'see [Image omitted from stored history: image/png]  and [File omitted from stored history]\n now' },
    { role: 'user', content: [{ type: 'text', text: '' }, null, 7, { type: 'weird', n: 1 }, 'bare'] },
    { role: 'user', content: { type: 'blob', n: 2 } },
    { role: 'user' },
    { role: 'user', content: null },
  ],
};
// Parts that Node reads bytes for: stored text and files by reference, inline files and documents.
const attachmentStore = await load('src/runtime/attachments/store.mjs');
const officeExtract = await load('src/runtime/attachments/office-extract.mjs');
const require = createRequire(join(nodeRoot, 'package.json'));
const JSZip = require('jszip');
const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:body></w:document>');
const docx = await zip.generateAsync({ type: 'nodebuffer' });
const blobs = {};
const store = (buffer) => {
  const { attachmentRef } = attachmentStore.storeAttachmentBuffer(buffer);
  blobs[attachmentRef] = buffer.toString('base64');
  return attachmentRef;
};
const b64 = (text) => Buffer.from(text).toString('base64');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const textRef = store(Buffer.from('pasted body\nsecond line é'));
const fileTextRef = store(Buffer.from('print("hi")\n'));
const pdfRef = store(Buffer.from('%PDF-1.4\n1 0 obj\n'));
const binRef = store(Buffer.from([0, 1, 2, 255, 254, 253]));
const docxRef = store(docx);
const fakeOfficeRef = store(Buffer.from('not a zip container'));
const badUtf8Ref = store(Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]));
rowSets.files = [
  { role: 'user', content: [{ type: 'text', text: '[Pasted text #1]', attachmentRef: textRef }, { type: 'text', text: '[File #2]', attachmentRef: fileTextRef, textKind: 'file', filename: 'we<ird>"n\'ame.py' }] },
  { role: 'user', content: [{ type: 'text', text: '[Pasted text #3]', attachmentRef: badUtf8Ref }, { type: 'text', text: '[Pasted text #4]', attachmentRef: 'b'.repeat(64) }] },
  { role: 'user', content: [{ type: 'file', attachmentRef: pdfRef, mimeType: 'application/pdf', filename: 'a.pdf' }, { type: 'file', attachmentRef: binRef, mimeType: 'application/octet-stream', filename: 'blob.bin' }] },
  { role: 'user', content: [{ type: 'file', attachmentRef: fileTextRef, mimeType: 'text/x-python; charset=utf-8', filename: 'a.py' }, { type: 'file', attachmentRef: 'c'.repeat(64), mimeType: 'text/plain' }] },
  { role: 'user', content: [{ type: 'file', attachmentRef: docxRef, mimeType: DOCX_MIME, filename: 'report.docx' }, { type: 'file', attachmentRef: docxRef, mimeType: 'application/octet-stream', filename: 'Report.DOCX' }, { type: 'file', attachmentRef: fakeOfficeRef, mimeType: DOCX_MIME, filename: 'broken.docx' }] },
  { role: 'user', content: [{ type: 'file', data: b64('a,b\n1,2\n'), mimeType: 'TEXT/CSV ', filename: 'd.csv' }, { type: 'file', data: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), mimeType: 'application/zip' }, { type: 'file', data: b64('%PDF-1.7 mislabelled'), mimeType: 'application/octet-stream' }] },
  { role: 'user', content: [{ type: 'file', data: docx.toString('base64'), mimeType: 'application/zip', filename: 'inline.docx' }, { type: 'file', data: '', mimeType: 'text/plain' }, { type: 'file', mimeType: 'text/plain' }] },
  { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64('%PDF-1.4 doc') }, title: 'Paper' }, { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: b64('doc text') }, filename: 'n.txt' }, { type: 'document', source: { type: 'text', data: 'x' } }] },
  { role: 'user', content: { type: 'file', data: b64('single file'), mimeType: 'text/plain', filename: 's.txt' } },
  { role: 'tool', toolCallId: 't1', content: [{ type: 'file', attachmentRef: textRef, mimeType: 'text/plain' }] },
];
const officeFor = (buffer, filename) =>
  officeExtract.tryExtractOoxmlTextFromBuffer(buffer, filename, { maxOutputBytes: 256 * 1024, maxPartBytes: 8 * 1024 * 1024, maxContainerBytes: 32 * 1024 * 1024 });
const office = [
  ['report.docx', docx],
  ['Report.DOCX', docx],
  ['broken.docx', Buffer.from('not a zip container')],
  ['inline.docx', docx],
].map(([filename, buffer]) => ({ filename, bytes: buffer.toString('base64'), text: officeFor(buffer, filename) }));
const rowSigns = Object.entries(rowSets).map(([name, rowsList]) => ({
  name,
  rows: rowsList,
  exact: rowsList.map((_, i) => utils.contextMessagesSignature(clone(rowsList), i + 1)),
  shape: rowsList.map((_, i) => utils.contextMessagesShapeSignature(clone(rowsList), i + 1)),
  empty: utils.contextMessagesSignature([]),
}));
const rowRestores = [];
const restoreRows = (name, header, rowsList, journal) => {
  const session = { ...clone(header), messages: clone(rowsList) };
  const result = checkpoint.restoreTurnCheckpointContextState(session, journal);
  const { messages: _messages, ...after } = session;
  rowRestores.push({ name, header: clone(header), rows: rowsList, checkpoint: journal, result, after: clone(after) });
};
// A journal's turn slice is signed in the stored form (inline media written to the attachment store and
// replaced by references / placeholders); its committed prefix, in the form the session held.
const journalModule = await load('src/runtime/agent/orchestrator/session/manager/turn-checkpoint-journal.mjs');
const mediaRows = rowSets.media;
const storedMedia = mediaRows.map((row) => clone(journalModule.checkpointMessage(clone(row))));
const storedProvider = providerJournal(storedMedia);
const liveProvider = providerJournal(mediaRows, mediaRows.length);
rowSigns.push({
  name: 'stored-media',
  rows: storedMedia,
  exact: storedMedia.map((_, i) => utils.contextMessagesSignature(clone(storedMedia), i + 1)),
  shape: storedMedia.map((_, i) => utils.contextMessagesShapeSignature(clone(storedMedia), i + 1)),
  empty: utils.contextMessagesSignature([]),
});
restoreRows('rows-provider-stored-turn', fresh, storedMedia, storedProvider);
restoreRows('rows-provider-live-committed-prefix', fresh, mediaRows, liveProvider);
restoreRows('rows-provider-after-a-stored-prefix', fresh, storedMedia, providerJournal(storedMedia, 7));
restoreRows('rows-post-compact', { ...fresh, usageMetricsTurnId: 'old' }, storedMedia, compactJournal(storedMedia));
restoreRows('rows-files-committed-prefix', fresh, rowSets.files, providerJournal(rowSets.files, rowSets.files.length));
restoreRows('rows-edited-image', { ...route, lastContextTokens: 3 }, [{ ...mediaRows[0], content: [{ type: 'text', text: 'look at these' }, { type: 'image', data: 'CHANGED', mimeType: 'image/jpeg', width: 640, height: 480, detail: 'HIGH' }] }, ...mediaRows.slice(1)], liveProvider);
restoreRows('rows-other-model-unanchored', { provider: 'openai', model: 'other', contextPressureBaselineTokens: 500, contextPressureBaselinePrefixSignature: 'nope', contextPressureBaselineMessageCount: 3 }, mediaRows, liveProvider);
{
  const s = { ...route, messages: clone(mediaRows) };
  policy.recordProviderContextBaseline(s, s.messages, { inputTokens: 5, outputTokens: 1 }, { sendTools: tools });
  const { messages: _m, ...baselineHeader } = s;
  restoreRows('rows-other-model-legacy-baseline-matches', { ...baselineHeader, model: 'other' }, mediaRows, liveProvider);
}

writeFileSync(join(outDir, 'golden', 'pressure.json'), `${JSON.stringify({ now: NOW, tools: wireTools(tools), cases, rowSigns, rowRestores, blobs, office }, null, 2)}\n`);
refreshSetManifest(agentDir, nodeRoot);
