#!/usr/bin/env node
// Recording of the display-only compaction archive as Node's compaction-archive.test.mjs exercised it
// (b6f10295a): the real capture module (compaction-archive-capture.mjs), the segment reader (compaction-archive.mjs),
// the real compaction runner and pre-send pass, session delete and the orphan sweep, the stored-transcript projection.
// Every test of the file is one case; the case records the inputs and everything its assertions looked at (archive
// lines as files, sidecar names and bytes, stderr lines, the archive state a session carries, return values).
//
//   node benchmarks/rust-core/recorders/record-compaction-archive-cases.mjs --tree <export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/compaction-archive-cases/{golden.json,archives/<case>.jsonl,MANIFEST.json}.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RecorderError } from './lib/recorder-error.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest, writeText } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { scriptUuids } from './lib/scripted-uuid.mjs';
import { normalisePaths } from './lib/normalise-paths.mjs';
import { realDeadline, virtualTimers } from './lib/virtual-timers.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { replayFor } from './lib/replay-targets.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-compaction-archive-cases.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'compaction-archive-cases');
const stage = stageSet(finalDir);
const NOW = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;
const scriptedUuids = scriptUuids();

const dataDir = mkdtempSync(join(tmpdir(), 'compact-archive-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
const S = 'src/runtime/agent/orchestrator/session/';
const load = (rel) => importFrom(tree, rel);
const { runSessionCompaction } = await load(`${S}manager/compaction-runner.mjs`);
const { runPreSendCompactPass } = await load(`${S}pre-send-compact.mjs`);
const capture = await load(`${S}compaction-archive-capture.mjs`);
const { _setCompactionArchiveFs, _setCompactionArchiveParkHook, _setCompactionArchiveFsync, _resetCompactionArchiveState, recoverPendingCompactionArchives, _setCompactionArchivePublishHook, droppedByCompaction, flushCompactionArchiveWrites, hideCompactionArchive, scheduleCompactionArchive, stampCompactionMessageIds } = capture;
const { stampMessageIds } = await load(`${S}message-ids.mjs`);
const { schedulePendingWrite, takePendingWrite } = await load(`${S}store/pending-writes.mjs`);
const { publishSessionPersistence } = await load(`${S}store/session-persistence-events.mjs`);
const { rememberSensitiveValues } = await load(`${S}sensitive-values.mjs`);
const { contextAckMessage, isProtectedContextAckMessage } = await load(`${S}compact/messages.mjs`);
const { restoreTranscriptItems } = await load(`${S}transcript-restore/restore.mjs`);
const { toAnthropicMessages } = await load('src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs');
const { toOpenAIMessages } = await load('src/runtime/agent/orchestrator/providers/openai-compat-wire.mjs');
const { compactionArchivePageFromText, compactionSegmentLine, compactionArchivePath, compactionArchiveRange, compactionSegmentHead, deleteCompactionArchive, readCompactionArchivePage } = await load(`${S}compaction-archive.mjs`);
const { projectStoredTranscript } = await load(`${S}store-transcript-projection.mjs`);
const { compactionArchivedRows } = await load('src/tui/session/compaction-view.mjs');
const { deleteSession } = await load(`${S}store.mjs`);
const { reapOrphanSidecars } = await load(`${S}store/sweep/sweep-finish.mjs`);
const { persistedAssistantTranscriptMetadata, persistedUserTranscriptMetadata } = await load('src/runtime/shared/transcript-metadata.mjs');
const { syncFsCalls } = await load('src/runtime/shared/sync-fs-calls.fixture.mjs');

const sha = (data) => createHash('sha256').update(data).digest('hex');
const SUMMARY = ['## Goal', '- keep the archived conversation visible', '', '## Progress', '### Done', '- older turns summarized', '', '## Next Steps', '- continue'].join('\n');
const sidecarOf = (id) => join(sessionsDir, `${id}.compaction-archive.pending`);
const recordOf = (id) => join(sessionsDir, `${id}.json`);

let sequence = 0;
const sessionFor = (tag) => `compact-archive-${tag}-${++sequence}`;
function storedMessages() {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 24; turn += 1) {
    const callId = `call-${turn}`;
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'apply_patch', arguments: { patch: `*** Update File: f${turn}.txt` } }] },
      { role: 'tool', toolCallId: callId, content: `patched ${turn}\n${'diff line\n'.repeat(200)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` },
    );
  }
  return messages;
}
function storedSession(tag) {
  const id = sessionFor(tag);
  writeFileSync(recordOf(id), JSON.stringify({ id }));
  return { id, provider: 'anthropic-oauth', model: 'fake-model', owner: 'agent', contextWindow: 100_000, compactBoundaryTokens: 100_000, messages: storedMessages(), tools: [], compaction: { conversationThresholdTokens: 1 } };
}
const sentLog = [];
// The scripted provider answers when the recorder releases it. The Node test's provider yields one event-loop turn before answering
// (compaction-archive.test.mjs:115); here that yield is a gate: the provider reports that its request arrived (`sent`), and answers when
// `release` is called, which the recorder does once it has observed that arrival (with a deadline). Each release is an ordered input,
// listed in golden.summaryGateReleases.
const gateReleases = [];
function summaryProvider(onSend = null) {
  let sentSeen;
  let released;
  const sent = new Promise((resolve) => { sentSeen = resolve; });
  const gate = new Promise((resolve) => { released = resolve; });
  return {
    name: 'anthropic-oauth',
    sent,
    release: () => { gateReleases.push({ release: gateReleases.length + 1, after: 'the provider received the summary request', summaryRequestsSoFar: sentTotal }); released(); },
    async send(messages) {
      sentLog.push(JSON.stringify(messages));
      sentTotal += 1;
      onSend?.();
      sentSeen();
      await gate;
      return { content: SUMMARY };
    },
  };
}
let sentTotal = 0;
// Runs `start()` (a compaction) and releases its provider once the summary request has arrived, or the run ended without sending one.
async function gated(provider, start) {
  const run = start();
  await within('the summary request to reach the provider', Promise.race([provider.sent, run.then(() => {}, () => {})]));
  provider.release();
  return within('the compaction to settle after the summary was released', run);
}
const compact = (session, provider) => gated(provider, () => runSessionCompaction(session, { mode: 'manual', force: true, config: {}, provider, model: 'fake-model' }));
const archiveLines = (id) => {
  const path = compactionArchivePath(sessionsDir, id);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
};
const SUMMARY_MESSAGE = { role: 'user', content: 'A previous model worked on this task and produced the compacted handoff summary below.\n\n## Goal', meta: { source: 'compact-summary' } };
const at = (value) => ({ meta: { transcript: { at: value } } });
const idOf = (message) => message.meta.transcript.messageId;
const stamped = (messages, sessionId = 'stamp-test') => {
  const out = messages.slice();
  stampMessageIds(out, { sessionId });
  out.forEach((message, index) => {
    if (message !== messages[index]) Object.assign(messages[index], message);
  });
  return messages;
};
const idsOf = (list) => list.map(idOf);
const flush = (label) => within(`flushCompactionArchiveWrites (${label})`, flushCompactionArchiveWrites());
const itemsOf = (seq, count, pad = 0) => stamped(Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `s${seq} m${index} ${'x'.repeat(pad)}` })), `items-${seq}`);
const fsError = (code) => Object.assign(new Error(`${code}: simulated`), { code });
const heads = (id) => archiveLines(id).map((line) => compactionSegmentHead(line));
const stray = (id) => readdirSync(sessionsDir).filter((name) => name.includes(id) && (name.endsWith('.tmp') || name.includes('.mixdog-tmp-')));
const named = (id) => readdirSync(sessionsDir).filter((name) => name.includes(id));
const archiveState = (session) => session.compaction?.archive;
const rowIds = (page) => page;

async function captureStderr(fn) {
  const original = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stderr.write = original; }
  return out.split('\n').filter(Boolean);
}
async function failedFsyncSession(tag) {
  const session = storedSession(tag);
  _setCompactionArchiveFsync(async () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); });
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  const log = await captureStderr(async () => { await within('failed write', scheduled.written); });
  return { session, scheduled, log };
}
async function coldSidecar(tag) {
  const { session } = await failedFsyncSession(tag);
  _setCompactionArchiveFsync(null);
  _resetCompactionArchiveState();
  return { session, pending: sidecarOf(session.id) };
}
async function parkedSession(tag, guard = (label, promise) => within(label, promise)) {
  const session = storedSession(tag);
  const record = recordOf(session.id);
  _setCompactionArchivePublishHook(async () => {
    _setCompactionArchivePublishHook(null);
    rmSync(record);
    schedulePendingWrite(session.id, session, {}, 0, () => {});
  });
  let parkedSignal;
  const parked = new Promise((resolve) => { parkedSignal = resolve; });
  _setCompactionArchiveParkHook(parkedSignal);
  const log = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { log.push(String(chunk)); return true; };
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await guard('parked write reaching its refusal', Promise.race([parked, scheduled.written.then(() => { throw new RecorderError('publication ended without parking'); })]));
  const release = () => { process.stderr.write = original; _setCompactionArchivePublishHook(null); _setCompactionArchiveParkHook(null); takePendingWrite(session.id); };
  return { session, record, scheduled, log, release, restoreStderr: () => { process.stderr.write = original; } };
}

const cases = [];
const files = new Map();
async function runCase(row, fn) {
  scriptedUuids.reset(); // every case counts its generated ids from 1: the number of ids an earlier case drew cannot move this one
  _setCompactionArchiveFs(null);
  _setCompactionArchiveFsync(null);
  _setCompactionArchivePublishHook(null);
  _setCompactionArchiveParkHook(null);
  _resetCompactionArchiveState();
  cases.push({ case: row, observed: exact(await fn(), { path: row }) });
}
const saveArchive = (name, id) => {
  const path = compactionArchivePath(sessionsDir, id);
  if (existsSync(path)) files.set(`archives/${name}.jsonl`, readFileSync(path));
};

// ── cases, in the order of the test file ──
await runCase('dropped messages are exactly the ids the compacted transcript no longer holds', async () => {
  const p = { role: 'user', content: 'prompt' };
  const r = { role: 'assistant', content: 'reply' };
  stamped([p, r]);
  const skill = { role: 'user', content: '<skill>body</skill>', meta: 'skill' };
  const stampedSkill = stampMessageIds([skill]);
  return {
    ids: { p: idOf(p), r: idOf(r) },
    droppedWhenPDropped: idsOf(droppedByCompaction([p, r], [SUMMARY_MESSAGE, r])),
    droppedWhenRDropped: idsOf(droppedByCompaction([p, r], [{ ...p, content: 'prompt (trimmed)' }])),
    stringMetaStamped: stampedSkill,
    stringMetaDropped: droppedByCompaction([skill], []).length,
  };
});
await runCase('a legacy transcript is stamped before compacting; its rewritten copies keep the ids', async () => {
  const older = { role: 'assistant', content: 'older reply' };
  const newer = { role: 'assistant', content: 'newer reply' };
  const before = stamped([older, newer]);
  const again = [{ role: 'assistant', content: 'older reply' }, { role: 'assistant', content: 'newer reply' }];
  stamped(again);
  return {
    ids: idsOf(before),
    droppedWhenOlderKeptRewritten: idsOf(droppedByCompaction(before, [SUMMARY_MESSAGE, { ...older, content: 'older (trimmed)' }])),
    idsOfReopenedLegacy: idsOf(again),
    restampOfStampedCount: stampMessageIds(before, { sessionId: 'other' }),
  };
});
await runCase('same-timestamp legacy replies with equal length and edges resolve to the retained one', async () => {
  const edge = 'x'.repeat(600);
  const first = { role: 'assistant', content: `${edge}AAAA${edge}`, ...at(7) };
  const second = { role: 'assistant', content: `${edge}BBBB${edge}`, ...at(7) };
  const before = stamped([first, second]);
  return {
    ids: idsOf(before),
    droppedWhenSecondKeptRewritten: idsOf(droppedByCompaction(before, [SUMMARY_MESSAGE, { ...second, content: 'second (trimmed)' }])),
    droppedWhenFirstKept: idsOf(droppedByCompaction(before, [SUMMARY_MESSAGE, first])),
  };
});
await runCase('prompts and replies get a stable message id at creation; a surface-supplied id is kept', async () => {
  const raw = { at: 1, messageId: 'msg_from_surface' };
  const shape = /^msg_[0-9a-f]{32}$/;
  const first = persistedAssistantTranscriptMetadata(raw).messageId;
  return {
    surfaceIdKept: persistedUserTranscriptMetadata(raw).messageId,
    generatedUserIdShapeOk: shape.test(persistedUserTranscriptMetadata({ at: 1 }).messageId),
    assistantKeepsSurfaceId: first,
    assistantSecondRead: persistedAssistantTranscriptMetadata(raw).messageId,
    normalized: 'a generated id is random: only its shape (msg_ + 32 hex) is compared',
  };
});
await runCase('stamping never serializes inline media and never reaches a provider payload', async () => {
  // The size of the inline image is scaled down from the Node test's 8 MiB (the toJSON trap, not the size, is what proves nothing serializes it): 64 KiB keeps the fixture small.
  const image = { type: 'image', data: 'A'.repeat(64 * 1024), mimeType: 'image/png' };
  const plain = () => [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'see screenshot' }, image] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ];
  const messages = plain();
  Object.defineProperty(image, 'toJSON', { configurable: true, value() { throw new Error('inline media serialized'); } });
  let stampedCount;
  let error = null;
  try { stampedCount = stampMessageIds(messages, { sessionId: 'media' }); } catch (e) { error = e.message; }
  delete image.toJSON;
  const anth = toAnthropicMessages(messages, []);
  const oai = toOpenAIMessages(messages, 'openai');
  return {
    stampedCount, error,
    anthropic: anth, anthropicOfUnstamped: toAnthropicMessages(plain(), []),
    openai: oai, openaiOfUnstamped: toOpenAIMessages(plain(), 'openai'),
    imageBytes: image.data.length,
  };
});
await runCase('stamped ids are persisted: a stamped message is a new object the next save records', async () => {
  const original = { role: 'user', content: 'hi' };
  const session = { id: 'stamp-save', messages: [original] };
  const count = stampCompactionMessageIds(session.messages, session.id);
  return { count, replacedNotEdited: session.messages[0] !== original, originalMeta: original.meta, id: idOf(session.messages[0]) };
});
for (const path of ['rules', 'summary']) {
  await runCase(`a ${path} compaction carries every kept message's id to its rewrite (provenance)`, async () => {
    const session = storedSession(`provenance-${path}`);
    session.compaction = { conversationThresholdTokens: path === 'rules' ? 100_000_000 : 1 };
    session.messages.splice(1, 0, { role: 'user', content: 'Reference files:\n\n### docs/a.md\nbody' }, { role: 'assistant', content: '.' });
    session.messages.push(
      { role: 'assistant', content: 'checking the file', toolCalls: [{ id: 'late-call', name: 'read', arguments: { path: 'b' } }] },
      { role: 'tool', toolCallId: 'late-call', content: `big\n${'line\n'.repeat(4_000)}` },
      { role: 'user', content: 'latest request' },
    );
    stampCompactionMessageIds(session.messages, session.id);
    const before = session.messages.slice();
    const result = await compact(session, summaryProvider());
    const after = session.messages.map((message) => {
      const id = message?.meta && typeof message.meta === 'object' ? message.meta.transcript?.messageId : '';
      return {
        role: message.role, id,
        message: structuredClone(message),
        restoredWhenNoId: id ? undefined : restoreTranscriptItems([message], { sessionId: session.id }),
      };
    });
    await flush(path);
    saveArchive(`provenance-${path}`, session.id);
    return { changed: result.changed, droppedMessages: result.droppedMessages, beforeIds: idsOf(before), after, archive: archiveState(session), segmentHeads: heads(session.id) };
  });
}
await runCase('recompacting a compacted transcript keeps the summary ack and archives nothing', async () => {
  const session = storedSession('ack-repeat');
  session.messages.push({ role: 'user', content: 'latest request' });
  await compact(session, summaryProvider());
  await flush('first');
  stampCompactionMessageIds(session.messages, session.id);
  const ack = session.messages.find(isProtectedContextAckMessage);
  const linesAfterFirst = archiveLines(session.id).length;
  session.compaction.conversationThresholdTokens = 100_000_000;
  const repeat = await compact(session, summaryProvider());
  await flush('repeat');
  const ackAfter = session.messages.find(isProtectedContextAckMessage);
  return {
    ack, ackAfter, linesAfterFirst, repeat,
    messagesCarryingAckId: session.messages.filter((m) => m.meta?.transcript?.messageId === idOf(ack)),
    linesAfterRepeat: archiveLines(session.id).length,
  };
});
await runCase('context acks never render; a bare "." reply still does', async () => {
  const rows = (messages) => restoreTranscriptItems(messages, { sessionId: 'ack' });
  const legacyAck = { role: 'assistant', content: '.' };
  return {
    contextAck: rows([contextAckMessage()]),
    summaryThenAck: rows([SUMMARY_MESSAGE, legacyAck, { role: 'user', content: 'next' }]),
    runtimeContextThenAck: rows([{ role: 'user', content: '<system-reminder>\nctx\n</system-reminder>' }, legacyAck]),
    referenceFilesThenAck: rows([{ role: 'user', content: 'Reference files:\n\n### a.md\nbody' }, legacyAck]),
    promptThenDot: rows([{ role: 'user', content: 'reply with a dot' }, legacyAck]),
  };
});
await runCase('a rewrite-only compaction archives nothing', async () => {
  const session = storedSession('rewrite');
  const before = stamped(session.messages.slice(), session.id);
  const after = before.map((message) => (message.role === 'tool' ? { ...message, content: 'patched (trimmed)' } : { ...message }));
  const dropped = droppedByCompaction(before, after);
  const scheduled = scheduleCompactionArchive({ session, before, after });
  const control = stamped([{ role: 'user', content: '[mixdog-runtime] obsolete notification' }], 'control');
  const scheduledControl = scheduleCompactionArchive({ session, before: [...before, ...control], after });
  await flush('rewrite');
  return { dropped, scheduled, scheduledControl, lines: archiveLines(session.id), archive: archiveState(session) };
});
await runCase('a mixed drop-and-rewrite compaction archives only what left, and reports its ids', async () => {
  const session = storedSession('mixed');
  const old = { role: 'user', content: 'old question', ...at(1) };
  const call = { role: 'assistant', content: 'reading both', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }, { id: 'c2', name: 'read', arguments: { path: 'b' } }] };
  const result1 = { role: 'tool', toolCallId: 'c1', content: 'a very long tool output' };
  const result2 = { role: 'tool', toolCallId: 'c2', content: 'b output' };
  const oldReply = { role: 'assistant', content: 'old answer', ...at(2) };
  const recent = { role: 'user', content: 'recent question', ...at(3) };
  const recentReply = { role: 'assistant', content: 'recent answer', ...at(4) };
  const before = stamped([old, call, result1, result2, oldReply, recent, recentReply], session.id);
  const after = [SUMMARY_MESSAGE, { ...call, toolCalls: [call.toolCalls[1]] }, { ...result2, content: '[trimmed]' }, { ...recent }, recentReply];
  const dropped = idsOf(droppedByCompaction(before, after));
  const scheduled = scheduleCompactionArchive({ session, before, after });
  await flush('mixed');
  const items = JSON.parse(archiveLines(session.id)[0]).items;
  saveArchive('mixed', session.id);
  return { beforeIds: idsOf(before), dropped, identities: scheduled.identities, items };
});
await runCase('a partial loss (kept id and call, lost text) archives the text row live and persisted alike', async () => {
  const session = storedSession('partial');
  const prompt = { role: 'user', content: 'inspect a', ...at(1) };
  const call = { role: 'assistant', content: 'reading a first', toolCalls: [{ id: 'pc1', name: 'read', arguments: { path: 'a' } }], ...at(2) };
  const result = { role: 'tool', toolCallId: 'pc1', content: 'a body' };
  const before = stamped([prompt, call, result], session.id);
  const after = [prompt, { ...call, content: '' }, result];
  const dropped = droppedByCompaction(before, after);
  const scheduled = scheduleCompactionArchive({ session, before, after });
  await flush('partial');
  const persisted = JSON.parse(archiveLines(session.id)[0]).items.filter((item) => item.status !== 'compacted');
  const archived = compactionArchivedRows({ droppedMessages: scheduled.dropped, droppedIdentities: scheduled.identities });
  const rows = restoreTranscriptItems(before, { sessionId: session.id });
  return {
    dropped, scheduledDropped: scheduled.dropped, identities: scheduled.identities,
    persisted,
    live: rows.map((row) => ({ row, archived: archived(row) })),
  };
});
await runCase('after a rules compaction a restart shows no turn both above and below the divider', async () => {
  const session = storedSession('rules-restart');
  session.compaction = { conversationThresholdTokens: 100_000_000 };
  stampCompactionMessageIds(session.messages, session.id);
  const before = session.messages.slice();
  const result = await compact(session, summaryProvider());
  await flush('rules-restart');
  const after = session.messages;
  const doc = { id: session.id, provider: session.provider, model: session.model, compaction: session.compaction, messages: after };
  const restarted = await projectStoredTranscript(session.id, doc, { itemLimit: 10_000, checkpointAbsent: true });
  saveArchive('rules-restart', session.id);
  return { changed: result.changed, restarted, dropped: droppedByCompaction(before, after), kept: after };
});
await runCase('a committed compaction archives what it dropped as one display-only segment', async () => {
  const session = storedSession('commit');
  stampCompactionMessageIds(session.messages, session.id);
  const before = session.messages.slice();
  sentLog.length = 0;
  const result = await compact(session, summaryProvider());
  const nextSeqAtCommit = session.compaction.archive.nextSeq;
  await flush('commit');
  const lines = archiveLines(session.id);
  const segment = JSON.parse(lines[0]);
  const dropped = droppedByCompaction(before, session.messages);
  saveArchive('commit', session.id);
  return {
    changed: result.changed, nextSeqAtCommit, lineCount: lines.length, head: heads(session.id), segment,
    archiveState: archiveState(session), dropped, keptMessages: session.messages,
    summaryRequests: [...sentLog],
  };
});
await runCase('an automatic pre-send compaction archives what it dropped once it adopts the result', async () => {
  const id = 'compact-archive-presend';
  writeFileSync(recordOf(id), JSON.stringify({ id }));
  const session = {
    id, owner: 'agent', provider: 'compact-archive-auto', model: 'fake-model', contextWindow: 20_000, compactBoundaryTokens: 20_000,
    messages: [
      { role: 'user', content: `large old request ${'context '.repeat(12_000)}` },
      { role: 'assistant', content: `large old answer ${'detail '.repeat(12_000)}` },
      { role: 'user', content: 'small request' },
    ],
    tools: [], compaction: { auto: true },
  };
  const autoProvider = summaryProvider();
  const result = await gated(autoProvider, () => runPreSendCompactPass({
    compactionConfig: {}, provider: { ...autoProvider, name: 'compact-archive-auto' }, messages: session.messages, model: session.model, requestTools: [], sessionRef: session,
    sessionId: id, opts: {}, signal: null, iterations: 1, lastUsage: null, firstTurnUsage: null, providerState: null, reactiveOverflowRetryPending: false,
    loopUsageMetricsTurnId: () => 'test-turn', loopUsageMetricsEpoch: () => 0,
  }));
  const nextSeq = session.compaction.archive.nextSeq;
  await flush('presend');
  const [line] = archiveLines(id);
  const items = JSON.parse(line).items;
  saveArchive('presend', id);
  return { compactChanged: result.compactChanged, nextSeq, items, messages: session.messages };
});
await runCase('a compaction aborted because the conversation moved archives nothing', async () => {
  const session = storedSession('moved');
  const result = await compact(session, summaryProvider(() => { session.messages = session.messages.slice(0, -2); }));
  await flush('moved');
  return { error: result.error, changed: result.changed, lines: archiveLines(session.id), archive: archiveState(session) };
});
await runCase('fsync failure fails the publication and leaves no temp file', async () => {
  const { session, scheduled, log } = await failedFsyncSession('fsync');
  const written = await scheduled.written;
  const archiveExists = existsSync(compactionArchivePath(sessionsDir, session.id));
  const temps = stray(session.id);
  _setCompactionArchiveFsync(null);
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flush('fsync');
  return { written, archiveExists, temps, log, headsAfterRetry: heads(session.id) };
});
await runCase('an append that the handle writes only in part is completed before it is acknowledged', async () => {
  const session = storedSession('short-write');
  scheduleCompactionArchive({ session, before: itemsOf(1, 3), after: [] });
  await flush('short-write first');
  const path = compactionArchivePath(sessionsDir, session.id);
  const probe = await fsPromises.open(path, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const realWrite = proto.write;
  let shortWrites = 0;
  proto.write = function shortWrite(data, ...rest) {
    shortWrites += 1;
    if (typeof data === 'string') {
      const bytes = Buffer.from(data, rest[1] || 'utf8');
      return realWrite.call(this, bytes.subarray(0, Math.ceil(bytes.length / 2)), 0, Math.ceil(bytes.length / 2), rest[0]);
    }
    const [offset, length, position] = rest;
    return realWrite.call(this, data, offset, Math.max(1, Math.ceil(length / 2)), position);
  };
  let acknowledged;
  try {
    const scheduled = scheduleCompactionArchive({ session, before: itemsOf(2, 3), after: [] });
    acknowledged = await within('short write acknowledged', scheduled.written);
    await flush('short-write second');
  } finally { proto.write = realWrite; }
  saveArchive('short-write', session.id);
  return { acknowledged, shortWrites, heads: heads(session.id), archiveText: readFileSync(path, 'utf8'), sidecarExists: existsSync(sidecarOf(session.id)) };
});
await runCase('a page never reads or parses the segments it skips', async () => {
  const valid = compactionSegmentLine({ seq: 1, prev: null, at: 1, items: itemsOf(9, 3).map((_m, i) => ({ id: `a${i}` })) });
  const broken = `${compactionSegmentLine({ seq: 2, prev: 1, at: 2, items: [{ id: 'b0' }, { id: 'b1' }, { id: 'b2' }] }).slice(0, -20)}`;
  const text = `${valid}\n${broken}\n`;
  const page = await compactionArchivePageFromText(text, { skip: 3, limit: 3 });
  const partial = await compactionArchivePageFromText(text, { skip: 4, limit: 1 });
  return { text, skip3Limit3: rowIds(page), skip4Limit1: rowIds(partial) };
});
await runCase('a sidecar page jumps over the segments it skips by their header offsets', async () => {
  const id = 'compact-archive-index-jump';
  const segment = (seq, prev, ids) => compactionSegmentLine({ seq, prev, at: seq, items: ids.map((item) => ({ id: item })) });
  const broken = segment(2, 1, ['b0', 'b1', 'b2']).replace('"b1"}', '"b1"!');
  const text = [segment(1, null, ['a0', 'a1', 'a2']), 'not a segment line', broken, segment(3, 2, ['c0'])].join('\n');
  writeFileSync(compactionArchivePath(sessionsDir, id), `${text}\n`);
  const read = (range) => readCompactionArchivePage(sessionsDir, id, range);
  return { text: `${text}\n`, newest: rowIds(await read({ limit: 1 })), oldest: rowIds(await read({ skip: 4, limit: 3 })), skippedBroken: (await read({ skip: 1, limit: 3 })).items };
});
await runCase('the archive is capped by dropping its oldest segments, and links each to the one before', async () => {
  const session = storedSession('cap');
  for (const seq of [1, 2, 3, 4]) scheduleCompactionArchive({ session, before: itemsOf(seq, 4, 2_000), after: [], maxBytes: 20_000 });
  await flush('cap 1-4');
  const afterFour = { heads: heads(session.id), segments: archiveState(session).segments };
  scheduleCompactionArchive({ session, before: itemsOf(5, 4, 2_000), after: [], maxBytes: 20_000 });
  await flush('cap 5');
  const afterFive = heads(session.id);
  scheduleCompactionArchive({ session, before: itemsOf(6, 40, 2_000), after: [], maxBytes: 20_000 });
  await flush('cap 6');
  const newest = archiveLines(session.id).at(-1);
  saveArchive('cap', session.id);
  return { afterFour, afterFive, newestHead: compactionSegmentHead(newest), newestBytesWithNewline: Buffer.byteLength(newest) + 1, newest };
});
await runCase('a clear hides earlier archive segments and the next write drops them', async () => {
  const session = storedSession('clear');
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('clear 1');
  const rangeBefore = compactionArchiveRange(session);
  hideCompactionArchive(session);
  const rangeHidden = compactionArchiveRange(session);
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flush('clear 2');
  return { rangeBefore, rangeHidden, seqsAfter: heads(session.id), rangeAfter: compactionArchiveRange(session) };
});
await runCase('paged stored reads continue into the archive, newest segment first; whole reads never get it', async () => {
  const session = storedSession('paging');
  scheduleCompactionArchive({ session, before: itemsOf(1, 4), after: [] });
  scheduleCompactionArchive({ session, before: itemsOf(2, 4), after: [] });
  await flush('paging');
  const doc = { id: session.id, provider: session.provider, model: session.model, compaction: session.compaction, messages: [{ role: 'user', content: 'after compaction' }, { role: 'assistant', content: 'live reply' }] };
  const project = (itemLimit) => projectStoredTranscript(session.id, doc, { itemLimit, checkpointAbsent: true });
  const tail = await project(2);
  const page = await project(4);
  const all = await project(64);
  const whole = await projectStoredTranscript(session.id, doc, { checkpointAbsent: true });
  const below = await readCompactionArchivePage(sessionsDir, session.id, { after: 0, before: 3, skip: 5, limit: 2 });
  saveArchive('paging', session.id);
  return { tail, page, all, whole, below };
});
await runCase('deleting a session removes its archive; the sweep reaps an orphaned one', async () => {
  const deleted = storedSession('delete');
  scheduleCompactionArchive({ session: deleted, before: itemsOf(1, 2), after: [] });
  await flush('delete');
  const deletedPath = compactionArchivePath(sessionsDir, deleted.id);
  const existedBefore = existsSync(deletedPath);
  rmSync(recordOf(deleted.id));
  const deleteResult = await deleteSession(deleted.id);
  const orphan = storedSession('orphan');
  scheduleCompactionArchive({ session: orphan, before: itemsOf(1, 2), after: [] });
  await flush('orphan');
  const orphanPath = compactionArchivePath(sessionsDir, orphan.id);
  rmSync(recordOf(orphan.id));
  const old = new Date(NOW - 60_000);
  utimesSync(orphanPath, old, old);
  const tally = { cleaned: 0 };
  for (const _ of reapOrphanSidecars({ plan: { maxAge: 1_000 }, dir: sessionsDir, now: Date.now(), tally }));
  return { existedBefore, deleteResult, existsAfterDelete: existsSync(deletedPath), orphanMtimeAgeMs: 60_000, maxAgeMs: 1_000, orphanExistsAfterSweep: existsSync(orphanPath), cleaned: tally.cleaned };
});
await runCase('a delete that lands while a segment is being published wins, and leaves no temp file', async () => {
  const session = storedSession('delete-race');
  const path = compactionArchivePath(sessionsDir, session.id);
  const reached = [];
  _setCompactionArchivePublishHook(async ({ tmp }) => {
    reached.push({ tempFileExists: existsSync(tmp) });
    rmSync(recordOf(session.id));
    reached.push({ deleteResult: await deleteSession(session.id) });
  });
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('delete-race');
  return { hookSteps: reached, archiveExists: existsSync(path), leftovers: readdirSync(sessionsDir).filter((n) => n.includes(session.id)) };
});
await runCase('the fence also holds when the record survives but a delete bumped the epoch', async () => {
  const session = storedSession('delete-epoch');
  _setCompactionArchivePublishHook(async () => { deleteCompactionArchive(sessionsDir, session.id); });
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('delete-epoch');
  return { archiveExists: existsSync(compactionArchivePath(sessionsDir, session.id)), temps: stray(session.id) };
});
await runCase('the cap holds: at most one segment over it, back within it at each occasional rewrite', async () => {
  const session = storedSession('cap-holds');
  const maxBytes = 30_000;
  const rewrites = [];
  _setCompactionArchivePublishHook(async ({ tmp }) => { if (tmp) rewrites.push(tmp); });
  const path = compactionArchivePath(sessionsDir, session.id);
  const steps = [];
  for (let seq = 1; seq <= 24; seq += 1) {
    const before = rewrites.length;
    scheduleCompactionArchive({ session, before: itemsOf(seq, 3, 1_000 + (seq % 5) * 400), after: [], maxBytes });
    await flush(`cap-holds ${seq}`);
    const lines = archiveLines(session.id);
    const newest = Buffer.byteLength(lines.at(-1)) + 1;
    const size = readFileSync(path).length;
    const rewrote = rewrites.length > before;
    saveArchive('cap-holds-' + seq, session.id);
    steps.push({ seq, newestHead: compactionSegmentHead(lines.at(-1)), size, newestBytes: newest, rewrote, lineCount: lines.length });
  }
  return { maxBytes, steps, rewriteCount: rewrites.length };
});
await runCase('a compaction capture writes nothing on the event loop: no sync fs write, lock or Atomics.wait', async () => {
  const session = storedSession('off-main');
  scheduleCompactionArchive({ session, before: itemsOf(1, 3, 1_500), after: [], maxBytes: 12_000 });
  await flush('off-main first');
  const waits = [];
  const wait = Atomics.wait;
  Atomics.wait = (...a) => { waits.push(a[3]); return wait(...a); };
  const publications = [];
  _setCompactionArchivePublishHook(async ({ tmp }) => publications.push(tmp ? 'rewrite' : 'append'));
  let calls;
  try {
    calls = await syncFsCalls(async () => {
      for (const seq of [2, 3, 4]) {
        const scheduled = scheduleCompactionArchive({ session, before: itemsOf(seq, 3, 1_500), after: [], maxBytes: 12_000 });
        await within('off-main written', scheduled.written);
      }
      await flush('off-main');
    });
  } finally { Atomics.wait = wait; }
  const reads = /^(readFileSync|existsSync|statSync|lstatSync|fstatSync|readdirSync|accessSync|realpathSync) /;
  return { scope: 'only the sync calls on paths under the sessions dir: a background trace writer can mkdir <data>/history inside the window, which is not the capture', nonReadSyncCalls: calls.filter((c) => c.includes(sessionsDir) && !reads.test(c)), atomicsWaits: waits, publications, newestSeq: compactionSegmentHead(archiveLines(session.id).at(-1)).seq, sidecarExists: existsSync(sidecarOf(session.id)) };
});
await runCase('the cap counts each line with its newline', async () => {
  const session = storedSession('cap-newline');
  for (const seq of [1, 2, 3, 4]) scheduleCompactionArchive({ session, before: itemsOf(seq, 3, 1_500), after: [], maxBytes: 12_000 });
  await flush('cap-newline');
  return { maxBytes: 12_000, size: readFileSync(compactionArchivePath(sessionsDir, session.id)).length, seqs: heads(session.id) };
});
await runCase('archive pages follow the sidecar after it changes', async () => {
  const session = storedSession('index');
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('index 1');
  const first = await readCompactionArchivePage(sessionsDir, session.id, { limit: 10 });
  const again = await readCompactionArchivePage(sessionsDir, session.id, { limit: 10 });
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flush('index 2');
  const second = await readCompactionArchivePage(sessionsDir, session.id, { limit: 3 });
  return { first, again, second };
});
await runCase('a deleted session does not regrow its archive from a pending write', async () => {
  const session = storedSession('late');
  rmSync(recordOf(session.id));
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('late');
  return { archiveExists: existsSync(compactionArchivePath(sessionsDir, session.id)) };
});
await runCase('dropped messages that restore to no row claim no segment number', async () => {
  const session = storedSession('invisible');
  const hidden = stamped([{ role: 'user', content: 'Reference files:\n\n### docs/a.md\nbody' }, { role: 'assistant', content: '.' }], session.id);
  const restored = restoreTranscriptItems(hidden, { sessionId: session.id });
  const scheduledHidden = scheduleCompactionArchive({ session, before: hidden, after: [] });
  const archiveAfterHidden = archiveState(session);
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flush('invisible');
  return { restored, scheduledHidden, archiveAfterHidden, seqs: heads(session.id), nextSeq: archiveState(session).nextSeq };
});
await runCase('a publication refused while the session is live waits for its save to land, without polling', async () => {
  const virtual = virtualTimers();
  let parked;
  try {
    parked = await parkedSession('refused-live', realDeadline);
    const { session, record, scheduled, log, release } = parked;
    const second = scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
    const armedUntilPark = virtual.armed.slice();
    // The Node test waited 60 ms of real time and asserted that no setImmediate ran: here the virtual clock is driven over those 60 ms.
    virtual.advance(60);
    const window = { advancedMs: 60, armedInWindow: virtual.armed.slice(armedUntilPark.length), fired: virtual.fired.slice(), stillPendingTimers: virtual.pending() };
    const archiveWhileParked = existsSync(compactionArchivePath(sessionsDir, session.id));
    virtual.restore();
    writeFileSync(record, JSON.stringify({ id: session.id }));
    takePendingWrite(session.id);
    publishSessionPersistence(session.id, 'landed');
    const w1 = await within('first parked segment', scheduled.written);
    const w2 = await within('second parked segment', second.written);
    release();
    return { armedUntilPark, window, archiveWhileParked, written: [w1, w2], seqs: heads(session.id), nextSeq: archiveState(session).nextSeq, log: log.join('').split('\n').filter(Boolean) };
  } finally { virtual.restore(); }
});
await runCase('a delete wakes the parked write: final skip, no segment, number given back', async () => {
  const { session, scheduled, log, release } = await parkedSession('parked-delete');
  const deleteResult = await deleteSession(session.id);
  const written = await within('parked write after delete', scheduled.written);
  release();
  return { deleteResult, written, archiveExists: existsSync(compactionArchivePath(sessionsDir, session.id)), nextSeq: archiveState(session).nextSeq, log: log.join('').split('\n').filter(Boolean) };
});
await runCase('a close before the record exists keeps the segment; the next process publishes it', async () => {
  const { session, record, scheduled, release } = await parkedSession('parked-close');
  publishSessionPersistence(session.id, 'closed');
  const written = await within('parked write after close', scheduled.written);
  const archiveAfterClose = existsSync(compactionArchivePath(sessionsDir, session.id));
  const sidecarAfterClose = existsSync(sidecarOf(session.id));
  _resetCompactionArchiveState();
  takePendingWrite(session.id);
  writeFileSync(record, JSON.stringify({ id: session.id }));
  publishSessionPersistence(session.id, 'landed');
  await flush('parked-close');
  release();
  return { written, archiveAfterClose, sidecarAfterClose, seqs: heads(session.id), sidecarAfterRecovery: existsSync(sidecarOf(session.id)) };
});
await runCase('a failed write survives a restart through the pending sidecar', async () => {
  const { session, log } = await failedFsyncSession('restart');
  const pending = sidecarOf(session.id);
  const sidecarExists = existsSync(pending);
  const sidecarText = sidecarExists ? readFileSync(pending, 'utf8') : null;
  _resetCompactionArchiveState();
  _setCompactionArchiveFsync(null);
  publishSessionPersistence(session.id, 'landed');
  await flush('restart');
  const items = JSON.parse(archiveLines(session.id)[0]).items;
  saveArchive('restart', session.id);
  return { log, sidecarExists, sidecarText, firstItemText: items[0].text, sidecarAfter: existsSync(pending) };
});
await runCase('write-ahead: the pending sidecar exists before the shortened transcript is adopted, and is removed after publication', async () => {
  const session = storedSession('write-ahead');
  const pending = sidecarOf(session.id);
  let messages = session.messages;
  let sidecarAtAdoption = null;
  Object.defineProperty(session, 'messages', { configurable: true, enumerable: true, get: () => messages, set(next) { sidecarAtAdoption = existsSync(pending); messages = next; } });
  const result = await compact(session, summaryProvider());
  await flush('write-ahead');
  return { changed: result.changed, sidecarAtAdoption, lineCount: archiveLines(session.id).length, sidecarAfter: existsSync(pending) };
});
await runCase('a pending sidecar that cannot be written aborts the compaction and keeps the old transcript', async () => {
  const session = storedSession('write-ahead-fail');
  const pending = sidecarOf(session.id);
  mkdirSync(pending);
  _setCompactionArchiveFs({ readFileSync: () => { throw fsError('ENOENT'); } });
  const before = session.messages;
  let result;
  const log = await captureStderr(async () => { result = await compact(session, summaryProvider()); });
  rmSync(pending, { recursive: true });
  return { changed: result.changed, error: result.error, transcriptUntouched: session.messages === before, nextSeq: archiveState(session).nextSeq, log, lines: archiveLines(session.id) };
});
await runCase('a delete removes a cold pending sidecar, so a recreated id imports no deleted history', async () => {
  const { session, pending } = await coldSidecar('cold-delete');
  const before = existsSync(pending);
  rmSync(recordOf(session.id));
  const deleteResult = await deleteSession(session.id);
  const sidecarAfterDelete = existsSync(pending);
  writeFileSync(recordOf(session.id), JSON.stringify({ id: session.id }));
  publishSessionPersistence(session.id, 'landed');
  const recovered = await recoverPendingCompactionArchives();
  await flush('cold-delete');
  return { sidecarBefore: before, deleteResult, sidecarAfterDelete, recovered, lines: archiveLines(session.id) };
});
await runCase('the startup scan publishes the pending segments of a session nothing else touches', async () => {
  const { session, pending } = await coldSidecar('cold-scan');
  const orphanId = `${session.id}-orphan`;
  const orphan = sidecarOf(orphanId);
  writeFileSync(orphan, readFileSync(pending));
  const recovered = await recoverPendingCompactionArchives();
  await flush('cold-scan');
  const out = { recovered, seqs: heads(session.id), sidecarAfter: existsSync(pending), orphanArchiveExists: existsSync(compactionArchivePath(sessionsDir, orphanId)) };
  rmSync(orphan, { force: true });
  return out;
});
await runCase('archive rows pass through the disk projection at publication, not at commit', async () => {
  const session = storedSession('redact');
  const secret = 'ZX-4821-secret';
  const before = stamped([{ role: 'user', content: `my code is ${secret}` }, { role: 'assistant', content: 'noted' }], session.id);
  scheduleCompactionArchive({ session, before, after: [] });
  rememberSensitiveValues(session.id, [{ name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: secret } } }]);
  await flush('redact');
  const [line] = archiveLines(session.id);
  saveArchive('redact', session.id);
  return { secret, line };
});
await runCase('a session deleted before its segment is written leaves no segment and no gap, and logs the skip', async () => {
  const session = storedSession('deleted-gap');
  const steps = [];
  _setCompactionArchivePublishHook(async () => { rmSync(recordOf(session.id)); steps.push(await deleteSession(session.id)); });
  const log = await captureStderr(async () => { scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] }); await flush('deleted-gap'); });
  return { deleteResults: steps, archiveExists: existsSync(compactionArchivePath(sessionsDir, session.id)), nextSeq: archiveState(session).nextSeq, log };
});
await runCase('a record that is gone with no save pending is a skip that gives its number back, and is logged', async () => {
  const session = storedSession('record-gone');
  rmSync(recordOf(session.id));
  const log = await captureStderr(async () => { scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] }); await flush('record-gone'); });
  return { archiveExists: existsSync(compactionArchivePath(sessionsDir, session.id)), nextSeq: archiveState(session).nextSeq, log };
});
for (const code of ['EACCES', 'EIO']) {
  await runCase(`a pending sidecar that cannot be read (${code}) survives later compactions, and is recovered once it reads`, async () => {
    const { session, pending } = await coldSidecar(`unreadable-${code}`);
    const original = readFileSync(pending, 'utf8');
    _setCompactionArchiveFs({ readFileSync: (target, encoding) => { if (target === pending) throw fsError(code); return readFileSync(target, encoding); } });
    const before = session.messages;
    let first;
    const log = await captureStderr(async () => {
      first = await compact(session, summaryProvider());
      publishSessionPersistence(session.id, 'landed');
    });
    const keptWhileUnreadable = { changed: first.changed, error: first.error, transcriptUntouched: session.messages === before, originalSidecar: original, sidecarNow: readFileSync(pending, 'utf8'), lines: archiveLines(session.id) };
    _setCompactionArchiveFs(null);
    const second = await compact(session, summaryProvider());
    await flush(`unreadable-${code}`);
    saveArchive(`unreadable-${code}`, session.id);
    return { code, log, keptWhileUnreadable, afterReadable: { changed: second.changed, seqs: heads(session.id), firstLine: archiveLines(session.id)[0], sidecarAfter: existsSync(pending) } };
  });
}
const DAMAGED = {
  'truncated text': '{"v":1,"jobs":[{"seq":1,"messages":[',
  'NUL bytes after a crash': '\0'.repeat(64),
  'valid JSON that is not a job list': '{"v":1,"jobs":"none"}',
  'a job without messages': '{"v":1,"jobs":[{"seq":1}]}',
};
for (const [shape, damaged] of Object.entries(DAMAGED)) {
  await runCase(`a damaged pending sidecar (${shape}) is kept aside, never overwritten by a compaction`, async () => {
    const session = storedSession('damaged');
    const pending = sidecarOf(session.id);
    writeFileSync(pending, damaged);
    _resetCompactionArchiveState();
    let result;
    const log = await captureStderr(async () => { result = await compact(session, summaryProvider()); await flush('damaged'); });
    const kept = readdirSync(sessionsDir).filter((n) => n.startsWith(`${session.id}.compaction-archive.pending.corrupt-`));
    const out = { shape, damaged, changed: result.changed, keptCount: kept.length, keptNames: kept, keptBytes: kept.map((name) => readFileSync(join(sessionsDir, name), 'utf8')), log, seqs: heads(session.id), sidecarAfter: existsSync(pending) };
    for (const name of kept) rmSync(join(sessionsDir, name), { force: true });
    return out;
  });
}
await runCase('the startup scan treats a missing store as empty and reports any other listing failure', async () => {
  _setCompactionArchiveFs({ readdir: async () => { throw fsError('ENOENT'); } });
  const missing = await recoverPendingCompactionArchives();
  _setCompactionArchiveFs({ readdir: async () => { throw fsError('EACCES'); } });
  let rejected;
  try { await recoverPendingCompactionArchives(); } catch (e) { rejected = e; }
  return { missingStoreRecovered: missing, otherFailureRejected: rejected };
});
await runCase('the startup scan reports a sidecar it cannot read, leaves it intact and still recovers the others', async () => {
  const readable = await coldSidecar('scan-readable');
  const unreadable = await coldSidecar('scan-unreadable');
  const original = readFileSync(unreadable.pending, 'utf8');
  _setCompactionArchiveFs({ readFileSync: (target, encoding) => { if (target === unreadable.pending) throw fsError('EIO'); return readFileSync(target, encoding); } });
  let count;
  const log = await captureStderr(async () => { count = await recoverPendingCompactionArchives(); await flush('scan-unreadable'); });
  const out = { count, log, originalUnreadableSidecar: original, unreadableSidecarNow: readFileSync(unreadable.pending, 'utf8'), readableSidecarAfter: existsSync(readable.pending), unreadableArchiveLines: archiveLines(unreadable.session.id) };
  rmSync(unreadable.pending, { force: true });
  return out;
});

Date.now = realNow;
const storedMessagesJson = storedMessages();
const sorted = [...files.keys()].sort();
writeJson(join(stage, 'golden.json'), {
  note: "Node's display-only compaction archive: per case what the test asserted on. The session store is a fresh data dir; ids carry a counter per case.",
  clock: { dateNow: NOW, note: 'Date.now is held at this value for the whole run (segment "at", sweep age)' },
  storedSessionMessages: { turns: 24, messages: storedMessagesJson },
  summary: SUMMARY,
  summaryGateReleases: { note: 'every release of the scripted summary provider, in order: the recorder releases it after the request arrived', releases: gateReleases },
  cases,
});
for (const name of sorted) writeText(join(stage, name), files.get(name).toString('utf8'));
rmSync(dataDir, { recursive: true, force: true });
const identity = exactProductIdentity(tree, COMMIT);
const normalised = normalisePaths(JSON.parse(readFileSync(join(stage, 'golden.json'), 'utf8')), { replaceInText: [[dataDir, '<data>']], replaceRegex: [[/^\d+(:[0-9a-z]+:\d+)$/, '<epoch>$1'], [/corrupt-\d+/g, 'corrupt-<n>'], [/mixdog-tmp-[0-9a-f]{8,16}/g, 'mixdog-tmp-<random>'], [/(tool-results[\\\\/]+[^\\\\/]+[\\\\/]+)[0-9a-f]{64}(\.txt)/g, '$1<sha256 of the text>$2'], [/sha256:[0-9a-f]{64}/g, 'sha256:<sha256 of the text>']] });
writeJson(join(stage, 'golden.json'), normalised.doc);
writeSetManifest(stage, {
  set: 'compaction-archive-cases', recorder: RECORDER, command: `node ${RECORDER} --tree <export of ${COMMIT} with node_modules>`, identity,
  extra: {
    ...recorderProvenance(import.meta.url), cases: cases.length,
    entry: {
      runs: "compaction-archive-capture.mjs (scheduleCompactionArchive, droppedByCompaction, stampCompactionMessageIds, recover/flush/hide), compaction-archive.mjs (segment lines, pages, range), the real runSessionCompaction and runPreSendCompactPass with a scripted summary provider, deleteSession, reapOrphanSidecars, projectStoredTranscript, restoreTranscriptItems, compactionArchivedRows (TUI helper)",
      notRun: 'the scripted provider answers one fixed summary; no real model',
      scripted: { source: scriptedUuids.source, perCase: 'the counter restarts at 1 for every case' },
    },
    replay: replayFor('compaction-archive-cases', {
      entry: 'Rust compaction archive (see rustTargets, existsButNotPublicOnO1 and missingOnO1 for what exists on o1): replay each case with the recorded inputs (stored session messages and the per-case calls) and compare the archive lines (archives/<case>.jsonl where saved, golden otherwise), sidecar names and bytes, stderr lines, the archive state, return values',
      faults: "Node injected fsync failure, short writes, publish/park hooks, read errors through its test hooks; the recording holds what those produced. A replay must inject the same faults in the real writer",
      normalised: { reasons: { corruptName: 'the kept-aside sidecar name carries a time (.corrupt-<n>)', tmpName: 'the writer\'s temp file names end in mixdog-tmp-<random hex>', toolResultsName: 'the execution-recovery message names a tool-results file by the sha256 of a text that holds the per-run data dir: the sha256 digits are written <sha256 of the text> (name and sha256: form)', dataDir: 'the temp data dir is <data>' }, paths: normalised.paths }, values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)', timers: 'the parked-publication case runs on a virtual clock for setTimeout/setInterval (every arming and firing is recorded) and counts setImmediate armings'
    }),
  },
});
commitStage(stage, finalDir);
console.log(`compaction-archive-cases: ${cases.length} cases`);
process.exit(0);
