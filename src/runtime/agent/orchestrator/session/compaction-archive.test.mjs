// Display-only compaction archive: what a committed compaction drops stays
// readable above the divider, never reaches the model, is capped, and leaves
// with its session.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-archive-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { runPreSendCompactPass } = await import('./pre-send-compact.mjs');
const {
  _setCompactionArchiveFs,
  _setCompactionArchiveParkHook,
  _setCompactionArchiveFsync,
  _resetCompactionArchiveState,
  recoverPendingCompactionArchives,
  _setCompactionArchivePublishHook,
  droppedByCompaction,
  flushCompactionArchiveWrites,
  hideCompactionArchive,
  scheduleCompactionArchive,
  stampCompactionMessageIds,
} = await import('./compaction-archive-capture.mjs');
const { stampMessageIds } = await import('./message-ids.mjs');
const { _savePending } = await import('./store/pending-saves.mjs');
const { publishSessionPersistence } = await import('./store/session-persistence-events.mjs');
const { rememberSensitiveValues } = await import('./sensitive-values.mjs');
const { contextAckMessage, isProtectedContextAckMessage } = await import('./compact/messages.mjs');
const { restoreTranscriptItems } = await import('./transcript-restore/restore.mjs');
const { toAnthropicMessages } = await import('../providers/lib/anthropic-request-utils.mjs');
const { toOpenAIMessages } = await import('../providers/openai-compat-wire.mjs');
const { _buildWirePayload, _hasSessionSaveBaseline } = await import('./store/save-delta.mjs');
const {
  compactionArchivePageFromText,
  compactionSegmentLine,
  compactionArchivePath,
  compactionArchiveRange,
  compactionSegmentHead,
  deleteCompactionArchive,
  readCompactionArchivePage,
} = await import('./compaction-archive.mjs');
const { projectStoredTranscript } = await import('./store-transcript-projection.mjs');
const { compactionArchivedRows } = await import('../../../../tui/session/compaction-view.mjs');
const { deleteSession } = await import('./store.mjs');
const { reapOrphanSidecars } = await import('./store/sweep/sweep-finish.mjs');
const { persistedAssistantTranscriptMetadata, persistedUserTranscriptMetadata } = await import(
  '../../../shared/transcript-metadata.mjs'
);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal',
  '- keep the archived conversation visible',
  '',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '',
  '## Next Steps',
  '- continue',
].join('\n');

let sequence = 0;
function storedSession(tag) {
  const id = `compact-archive-${process.pid}-${tag}-${++sequence}`;
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 24; turn += 1) {
    const callId = `call-${turn}`;
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: callId, name: 'apply_patch', arguments: { patch: `*** Update File: f${turn}.txt` } }],
      },
      { role: 'tool', toolCallId: callId, content: `patched ${turn}\n${'diff line\n'.repeat(200)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ id }));
  return {
    id,
    provider: 'anthropic-oauth',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    messages,
    tools: [],
    compaction: { conversationThresholdTokens: 1 },
  };
}

function summaryProvider(sent, onSend = null) {
  return {
    name: 'anthropic-oauth',
    async send(messages) {
      sent.push(JSON.stringify(messages));
      onSend?.();
      await new Promise((resolve) => setImmediate(resolve));
      return { content: SUMMARY };
    },
  };
}

const compact = (session, provider) =>
  runSessionCompaction(session, { mode: 'manual', force: true, config: {}, provider, model: 'fake-model' });

function archiveLines(sessionId) {
  const path = compactionArchivePath(sessionsDir, sessionId);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

const SUMMARY_MESSAGE = {
  role: 'user',
  content: 'A previous model worked on this task and produced the compacted handoff summary below.\n\n## Goal',
  meta: { source: 'compact-summary' },
};
const at = (value) => ({ meta: { transcript: { at: value } } });
const idOf = (message) => message.meta.transcript.messageId;
/** Messages as a compaction receives them: stamped. */
const stamped = (messages, sessionId = 'stamp-test') => {
  stampMessageIds(messages, { sessionId });
  return messages;
};

test('dropped messages are exactly the ids the compacted transcript no longer holds', () => {
  const p = { role: 'user', content: 'prompt' };
  const r = { role: 'assistant', content: 'reply' };
  stamped([p, r]);
  // [p, r] → [r]: only p was dropped, whatever the content.
  assert.deepEqual(droppedByCompaction([p, r], [SUMMARY_MESSAGE, r]), [p]);
  // [p, r] → [p]: only r.
  assert.deepEqual(droppedByCompaction([p, r], [{ ...p, content: 'prompt (trimmed)' }]), [r]);
  // A message that cannot carry an id (string-meta context marker) has no
  // display identity and is never reported.
  const skill = { role: 'user', content: '<skill>body</skill>', meta: 'skill' };
  assert.equal(stampMessageIds([skill]), 0);
  assert.deepEqual(droppedByCompaction([skill], []), []);
});

test('a legacy transcript is stamped before compacting; its rewritten copies keep the ids', () => {
  const older = { role: 'assistant', content: 'older reply' };
  const newer = { role: 'assistant', content: 'newer reply' };
  const before = stamped([older, newer]);
  assert.notEqual(idOf(older), idOf(newer));
  // Only the older is retained, rewritten: the newer is the dropped one.
  assert.deepEqual(droppedByCompaction(before, [SUMMARY_MESSAGE, { ...older, content: 'older (trimmed)' }]), [newer]);
  // Stamping is deterministic and idempotent: a reopened legacy transcript
  // gets the same ids, an already stamped one keeps them.
  const again = [
    { role: 'assistant', content: 'older reply' },
    { role: 'assistant', content: 'newer reply' },
  ];
  stamped(again);
  assert.deepEqual(again.map(idOf), before.map(idOf));
  assert.equal(stampMessageIds(before, { sessionId: 'other' }), 0);
});

test('same-timestamp legacy replies with equal length and edges resolve to the retained one', () => {
  const edge = 'x'.repeat(600);
  const first = { role: 'assistant', content: `${edge}AAAA${edge}`, ...at(7) };
  const second = { role: 'assistant', content: `${edge}BBBB${edge}`, ...at(7) };
  const before = stamped([first, second]);
  assert.notEqual(idOf(first), idOf(second));
  assert.deepEqual(droppedByCompaction(before, [SUMMARY_MESSAGE, { ...second, content: 'second (trimmed)' }]), [first]);
  assert.deepEqual(droppedByCompaction(before, [SUMMARY_MESSAGE, first]), [second]);
});

test('prompts and replies get a stable message id at creation; a surface-supplied id is kept', () => {
  const raw = { at: 1, messageId: 'msg_from_surface' };
  assert.equal(persistedUserTranscriptMetadata(raw).messageId, 'msg_from_surface');
  assert.match(persistedUserTranscriptMetadata({ at: 1 }).messageId, /^msg_[0-9a-f]{32}$/);
  const first = persistedAssistantTranscriptMetadata(raw).messageId;
  assert.match(first, /^msg_[0-9a-f]{32}$/);
  // Re-reading the same reply's metadata keeps its id.
  assert.equal(persistedAssistantTranscriptMetadata(raw).messageId, first);
});

test('stamping never serializes inline media and never reaches a provider payload', () => {
  const image = { type: 'image', data: 'A'.repeat(8 * 1024 * 1024), mimeType: 'image/png' };
  const plain = () => [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'see screenshot' }, image] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ];
  const messages = plain();
  Object.defineProperty(image, 'toJSON', {
    configurable: true,
    value() {
      throw new Error('inline media serialized');
    },
  });
  assert.equal(stampMessageIds(messages, { sessionId: 'media' }), 5);
  delete image.toJSON;
  assert.deepEqual(toAnthropicMessages(messages, []), toAnthropicMessages(plain(), []));
  assert.deepEqual(toOpenAIMessages(messages, 'openai'), toOpenAIMessages(plain(), 'openai'));
});

test('stamped ids are persisted: the next save goes out whole', () => {
  const session = { id: `stamp-save-${process.pid}`, messages: [{ role: 'user', content: 'hi' }] };
  _buildWirePayload(session.id, session);
  assert.equal(_hasSessionSaveBaseline(session.id), true);
  assert.equal(stampCompactionMessageIds(session.messages, session.id), 1);
  assert.equal(_hasSessionSaveBaseline(session.id), false);
  const payload = _buildWirePayload(session.id, session);
  assert.equal(payload.delta, undefined);
  assert.equal(idOf(payload.session.messages[0]), idOf(session.messages[0]));
});

for (const path of ['rules', 'summary']) {
  test(`a ${path} compaction carries every kept message's id to its rewrite (provenance)`, async () => {
    const session = storedSession(`provenance-${path}`);
    session.compaction = { conversationThresholdTokens: path === 'rules' ? 100_000_000 : 1 };
    // Shapes the rewrites touch: a pasted reference-files message, a large
    // tool result, a tool-call message with text, a runtime-context prompt.
    session.messages.splice(
      1,
      0,
      { role: 'user', content: 'Reference files:\n\n### docs/a.md\nbody' },
      { role: 'assistant', content: '.' }
    );
    session.messages.push(
      {
        role: 'assistant',
        content: 'checking the file',
        toolCalls: [{ id: 'late-call', name: 'read', arguments: { path: 'b' } }],
      },
      { role: 'tool', toolCallId: 'late-call', content: `big\n${'line\n'.repeat(4_000)}` },
      { role: 'user', content: 'latest request' }
    );
    const before = session.messages.slice();
    const result = await compact(session, summaryProvider([]));
    assert.equal(result.changed, true);
    const ids = new Set(before.map(idOf));
    for (const message of session.messages) {
      const id = message?.meta && typeof message.meta === 'object' ? message.meta.transcript?.messageId : '';
      if (id) assert.ok(ids.has(id), `rewrite with a foreign id: ${JSON.stringify(message).slice(0, 120)}`);
      // A message without an id is a compaction product (handoff summary,
      // re-attached context, the context ack): it renders nothing, so nothing
      // kept can show twice.
      else assert.deepEqual(restoreTranscriptItems([message], { sessionId: session.id }), []);
    }
    await flushCompactionArchiveWrites();
  });
}

test('recompacting a compacted transcript keeps the summary ack and archives nothing', async () => {
  const session = storedSession('ack-repeat');
  session.messages.push({ role: 'user', content: 'latest request' });
  await compact(session, summaryProvider([]));
  await flushCompactionArchiveWrites();
  const ack = session.messages.find(isProtectedContextAckMessage);
  assert.ok(ack);
  assert.equal(archiveLines(session.id).length, 1);
  session.compaction.conversationThresholdTokens = 100_000_000;
  const repeat = await compact(session, summaryProvider([]));
  await flushCompactionArchiveWrites();
  assert.equal(repeat.droppedMessages, 0);
  assert.equal(idOf(session.messages.find(isProtectedContextAckMessage)), idOf(ack));
  assert.equal(session.messages.filter((message) => message.meta?.transcript?.messageId === idOf(ack)).length, 1);
  assert.equal(archiveLines(session.id).length, 1);
});

test('context acks never render; a bare "." reply still does', () => {
  const rows = (messages) =>
    restoreTranscriptItems(messages, { sessionId: 'ack' }).map((item) => `${item.kind}:${item.text}`);
  assert.deepEqual(rows([contextAckMessage()]), []);
  const legacyAck = { role: 'assistant', content: '.' };
  assert.deepEqual(rows([SUMMARY_MESSAGE, legacyAck, { role: 'user', content: 'next' }]), ['user:next']);
  assert.deepEqual(rows([{ role: 'user', content: '<system-reminder>\nctx\n</system-reminder>' }, legacyAck]), []);
  assert.ok(
    !rows([{ role: 'user', content: 'Reference files:\n\n### a.md\nbody' }, legacyAck]).includes('assistant:.')
  );
  assert.deepEqual(rows([{ role: 'user', content: 'reply with a dot' }, legacyAck]), [
    'user:reply with a dot',
    'assistant:.',
  ]);
});

test('a rewrite-only compaction archives nothing', async () => {
  const session = storedSession('rewrite');
  const before = stamped(session.messages.slice(), session.id);
  // Rules-style rewrite: every message comes back as a copy, tool output trimmed.
  const after = before.map((message) =>
    message.role === 'tool' ? { ...message, content: 'patched (trimmed)' } : { ...message }
  );
  assert.deepEqual(droppedByCompaction(before, after), []);
  assert.equal(scheduleCompactionArchive({ session, before, after }), null);
  // Dropping only a row the transcript never shows archives nothing either.
  const control = stamped([{ role: 'user', content: '[mixdog-runtime] obsolete notification' }], 'control');
  assert.equal(scheduleCompactionArchive({ session, before: [...before, ...control], after }), null);
  await flushCompactionArchiveWrites();
  assert.deepEqual(archiveLines(session.id), []);
  assert.equal(session.compaction.archive, undefined);
});

test('a mixed drop-and-rewrite compaction archives only what left, and reports its ids', async () => {
  const session = storedSession('mixed');
  const old = { role: 'user', content: 'old question', ...at(1) };
  const call = {
    role: 'assistant',
    content: 'reading both',
    toolCalls: [
      { id: 'c1', name: 'read', arguments: { path: 'a' } },
      { id: 'c2', name: 'read', arguments: { path: 'b' } },
    ],
  };
  const result1 = { role: 'tool', toolCallId: 'c1', content: 'a very long tool output' };
  const result2 = { role: 'tool', toolCallId: 'c2', content: 'b output' };
  const oldReply = { role: 'assistant', content: 'old answer', ...at(2) };
  const recent = { role: 'user', content: 'recent question', ...at(3) };
  const recentReply = { role: 'assistant', content: 'recent answer', ...at(4) };
  const before = stamped([old, call, result1, result2, oldReply, recent, recentReply], session.id);
  const after = [
    SUMMARY_MESSAGE,
    // The call message keeps its text and c2; c1 and its result left.
    { ...call, toolCalls: [call.toolCalls[1]] },
    { ...result2, content: '[trimmed]' },
    { ...recent },
    recentReply,
  ];
  assert.deepEqual(droppedByCompaction(before, after), [old, result1, oldReply]);
  const scheduled = scheduleCompactionArchive({ session, before, after });
  assert.deepEqual(scheduled.identities, { messageIds: [idOf(old), idOf(result1), idOf(oldReply)], callIds: ['c1'] });
  await flushCompactionArchiveWrites();
  const items = JSON.parse(archiveLines(session.id)[0]).items;
  assert.deepEqual(
    items.map((item) => item.text ?? item.name ?? item.label),
    ['old question', 'read', 'old answer', 'Conversation compacted']
  );
  // The lost call's card restores whole, with its result.
  assert.equal(items[1].callId, 'c1');
  assert.equal(items[1].result, 'a very long tool output');
});
test('a partial loss (kept id and call, lost text) archives the text row live and persisted alike', async () => {
  const session = storedSession('partial');
  const prompt = { role: 'user', content: 'inspect a', ...at(1) };
  const call = {
    role: 'assistant',
    content: 'reading a first',
    toolCalls: [{ id: 'pc1', name: 'read', arguments: { path: 'a' } }],
    ...at(2),
  };
  const result = { role: 'tool', toolCallId: 'pc1', content: 'a body' };
  const before = stamped([prompt, call, result], session.id);
  // The call message keeps its id and call; only its text left.
  const after = [prompt, { ...call, content: '' }, result];
  assert.deepEqual(droppedByCompaction(before, after), []);
  const scheduled = scheduleCompactionArchive({ session, before, after });
  assert.equal(scheduled.dropped, 0);
  assert.deepEqual(scheduled.identities, { messageIds: [idOf(call)], callIds: [] });
  await flushCompactionArchiveWrites();
  const persisted = JSON.parse(archiveLines(session.id)[0]).items.filter((item) => item.status !== 'compacted');
  assert.deepEqual(
    persisted.map((item) => [item.kind, item.text]),
    [['assistant', 'reading a first']]
  );
  // The live view of the same transcript decides per row the same way.
  const archived = compactionArchivedRows({
    droppedMessages: scheduled.dropped,
    droppedIdentities: scheduled.identities,
  });
  const rows = restoreTranscriptItems(before, { sessionId: session.id });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text ?? row.callId, archived(row)]),
    [
      ['user', 'inspect a', false],
      ['assistant', 'reading a first', true],
      ['tool', 'pc1', false],
    ]
  );
});

test('after a rules compaction a restart shows no turn both above and below the divider', async () => {
  const session = storedSession('rules-restart');
  session.compaction = { conversationThresholdTokens: 100_000_000 };
  const before = session.messages.slice();
  const result = await compact(session, summaryProvider([]));
  assert.equal(result.changed, true);
  await flushCompactionArchiveWrites();
  const after = session.messages;
  const doc = {
    id: session.id,
    provider: session.provider,
    model: session.model,
    compaction: session.compaction,
    messages: after,
  };
  const restarted = await projectStoredTranscript(session.id, doc, { itemLimit: 10_000, checkpointAbsent: true });
  const userTexts = restarted.items.filter((item) => item.kind === 'user').map((item) => item.text);
  assert.equal(new Set(userTexts).size, userTexts.length, 'no prompt shows twice');
  const archived = restarted.items.filter((item) => item.archived === true);
  const live = restarted.items.filter((item) => item.archived !== true && item.status !== 'compacted');
  const liveTexts = new Set(live.map((item) => item.text).filter(Boolean));
  assert.ok(archived.every((item) => !item.text || !liveTexts.has(item.text)));
  // Whatever was archived really left the compacted transcript.
  for (const message of droppedByCompaction(before, after)) {
    assert.ok(!after.some((kept) => kept === message));
  }
});

test('a committed compaction archives what it dropped as one display-only segment', async () => {
  const session = storedSession('commit');
  const before = session.messages.slice();
  const sent = [];
  const result = await compact(session, summaryProvider(sent));
  assert.equal(result.changed, true);
  // The segment number is allocated with the commit (and saved with it).
  assert.equal(session.compaction.archive.nextSeq, 2);
  await flushCompactionArchiveWrites();

  const lines = archiveLines(session.id);
  assert.equal(lines.length, 1);
  const head = compactionSegmentHead(lines[0]);
  assert.deepEqual({ seq: head.seq, id: head.id, prev: head.prev }, { seq: 1, id: 'seg1', prev: null });
  const segment = JSON.parse(lines[0]);
  assert.equal(segment.count, segment.items.length);
  const divider = segment.items.at(-1);
  assert.deepEqual(
    { kind: divider.kind, status: divider.status, label: divider.label, id: divider.id },
    { kind: 'statusdone', status: 'compacted', label: 'Conversation compacted', id: 'arch1_divider' }
  );
  const rows = segment.items.slice(0, -1);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((item) => item.archived === true && /^arch1_\d+_\d+$/.test(item.id)));
  // Tool cards (with their results) survive the projection.
  assert.ok(
    rows.some((item) => item.kind === 'tool' && String(item.result ?? item.rawResult ?? '').includes('patched'))
  );
  assert.ok(rows.some((item) => item.kind === 'user' && item.text.startsWith('request 0')));
  assert.deepEqual(
    session.compaction.archive.segments.map((entry) => entry.seq),
    [1]
  );

  // Nothing archived reaches the model: the transcript the next request sends
  // holds none of the dropped messages and no archive row.
  const dropped = droppedByCompaction(before, session.messages);
  assert.ok(dropped.length > 0);
  const nextPayload = JSON.stringify(session.messages);
  assert.equal(nextPayload.includes('arch1_'), false);
  assert.equal(nextPayload.includes('"archived"'), false);
  assert.ok(session.messages.every((message) => !dropped.includes(message)));
  assert.ok(sent.every((payload) => !payload.includes('arch1_')));
});

test('an automatic pre-send compaction archives what it dropped once it adopts the result', async () => {
  const id = `compact-archive-presend-${process.pid}`;
  writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ id }));
  const session = {
    id,
    owner: 'agent',
    provider: 'compact-archive-auto',
    model: 'fake-model',
    contextWindow: 20_000,
    compactBoundaryTokens: 20_000,
    messages: [
      { role: 'user', content: `large old request ${'context '.repeat(12_000)}` },
      { role: 'assistant', content: `large old answer ${'detail '.repeat(12_000)}` },
      { role: 'user', content: 'small request' },
    ],
    tools: [],
    compaction: { auto: true },
  };
  const sent = [];
  const result = await runPreSendCompactPass({
    compactionConfig: {},
    provider: { ...summaryProvider(sent), name: 'compact-archive-auto' },
    messages: session.messages,
    model: session.model,
    requestTools: [],
    sessionRef: session,
    sessionId: id,
    opts: {},
    signal: null,
    iterations: 1,
    lastUsage: null,
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: false,
    loopUsageMetricsTurnId: () => 'test-turn',
    loopUsageMetricsEpoch: () => 0,
  });
  assert.equal(result.compactChanged, true);
  assert.equal(session.compaction.archive.nextSeq, 2);
  await flushCompactionArchiveWrites();
  const [line] = archiveLines(id);
  const items = JSON.parse(line).items;
  assert.ok(items.some((item) => item.kind === 'user' && item.text.startsWith('large old request')));
  assert.equal(items.at(-1).id, 'arch1_divider');
  assert.equal(JSON.stringify(session.messages).includes('arch1_'), false);
});

test('a compaction aborted because the conversation moved archives nothing', async () => {
  const session = storedSession('moved');
  const sent = [];
  const result = await compact(
    session,
    summaryProvider(sent, () => {
      session.messages = session.messages.slice(0, -2);
    })
  );
  assert.match(result.error, /changed while compacting/);
  await flushCompactionArchiveWrites();
  assert.deepEqual(archiveLines(session.id), []);
  assert.equal(session.compaction.archive, undefined);
});

function itemsOf(seq, count, pad = 0) {
  return stamped(
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `s${seq} m${index} ${'x'.repeat(pad)}`,
    })),
    `items-${seq}`
  );
}

test('fsync failure fails the publication and leaves no temp file', async (t) => {
  const session = storedSession('fsync');
  _setCompactionArchiveFsync(async () => {
    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
  });
  t.after(() => _setCompactionArchiveFsync(null));
  let log = '';
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  log = await captureStderr(async () => {
    assert.equal(await scheduled.written, null);
  });
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  assert.deepEqual(
    readdirSync(sessionsDir).filter(
      (name) => name.includes(session.id) && (name.endsWith('.tmp') || name.includes('.mixdog-tmp-'))
    ),
    []
  );
  assert.match(log, new RegExp(`compaction archive write failed \\(sess=${session.id}, seq=1\\): .*kept for retry`));
  // The failed segment is kept: the next write publishes it first, in order.
  _setCompactionArchiveFsync(null);
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [1, 2]
  );
});

test('a page never reads or parses the segments it skips', async () => {
  const valid = compactionSegmentLine({
    seq: 1,
    prev: null,
    at: 1,
    items: itemsOf(9, 3).map((_m, i) => ({ id: `a${i}` })),
  });
  // The newest segment's header is intact but its body is not JSON: only a
  // reader that parses skipped segments would notice.
  const broken = `${compactionSegmentLine({ seq: 2, prev: 1, at: 2, items: [{ id: 'b0' }, { id: 'b1' }, { id: 'b2' }] }).slice(0, -20)}`;
  const page = await compactionArchivePageFromText(`${valid}\n${broken}\n`, { skip: 3, limit: 3 });
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['a0', 'a1', 'a2']
  );
  assert.equal(page.hasOlder, false);
  const partial = await compactionArchivePageFromText(`${valid}\n${broken}\n`, { skip: 4, limit: 1 });
  assert.deepEqual(
    partial.items.map((item) => item.id),
    ['a1']
  );
  assert.equal(partial.hasOlder, true);
});

test('a sidecar page jumps over the segments it skips by their header offsets', async () => {
  const id = `compact-archive-${process.pid}-index-jump`;
  const segment = (seq, prev, ids) =>
    compactionSegmentLine({ seq, prev, at: seq, items: ids.map((item) => ({ id: item })) });
  // The skipped segment's header is intact (its byte length too) but its body
  // is not JSON; a stray non-segment line sits between segments.
  const broken = segment(2, 1, ['b0', 'b1', 'b2']).replace('"b1"}', '"b1"!');
  const text = [segment(1, null, ['a0', 'a1', 'a2']), 'not a segment line', broken, segment(3, 2, ['c0'])].join('\n');
  writeFileSync(compactionArchivePath(sessionsDir, id), `${text}\n`);
  const read = (range) => readCompactionArchivePage(sessionsDir, id, range);
  const newest = await read({ limit: 1 });
  assert.deepEqual(
    newest.items.map((item) => item.id),
    ['c0']
  );
  assert.equal(newest.hasOlder, true);
  const oldest = await read({ skip: 4, limit: 3 });
  assert.deepEqual(
    oldest.items.map((item) => item.id),
    ['a0', 'a1', 'a2']
  );
  assert.equal(oldest.hasOlder, false);
  // Reached, the broken body shows nothing (display-only).
  assert.deepEqual((await read({ skip: 1, limit: 3 })).items, []);
});

test('the archive is capped by dropping its oldest segments, and links each to the one before', async () => {
  const session = storedSession('cap');
  for (const seq of [1, 2, 3]) {
    scheduleCompactionArchive({ session, before: itemsOf(seq, 4, 2_000), after: [], maxBytes: 20_000 });
  }
  await flushCompactionArchiveWrites();
  const heads = archiveLines(session.id).map(compactionSegmentHead);
  assert.deepEqual(
    heads.map(({ seq, prev }) => ({ seq, prev })),
    [
      { seq: 2, prev: 'seg1' },
      { seq: 3, prev: 'seg2' },
    ]
  );
  assert.deepEqual(
    session.compaction.archive.segments.map((entry) => entry.seq),
    [2, 3]
  );
  // A segment larger than the cap alone keeps its newest rows and divider.
  scheduleCompactionArchive({ session, before: itemsOf(4, 40, 2_000), after: [], maxBytes: 20_000 });
  await flushCompactionArchiveWrites();
  const lines = archiveLines(session.id);
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) <= 20_000);
  const items = JSON.parse(lines[0]).items;
  assert.equal(items.at(-1).id, 'arch4_divider');
  assert.match(items.at(-2).text, /^s4 m39 /);
});

test('a clear hides earlier archive segments and the next write drops them', async () => {
  const session = storedSession('clear');
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.deepEqual(compactionArchiveRange(session), { after: 0, before: 2 });
  hideCompactionArchive(session);
  assert.equal(compactionArchiveRange(session), null);
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [2]
  );
  assert.deepEqual(compactionArchiveRange(session), { after: 1, before: 3 });
});

test('paged stored reads continue into the archive, newest segment first; whole reads never get it', async () => {
  const session = storedSession('paging');
  scheduleCompactionArchive({ session, before: itemsOf(1, 4), after: [] });
  scheduleCompactionArchive({ session, before: itemsOf(2, 4), after: [] });
  await flushCompactionArchiveWrites();
  const doc = {
    id: session.id,
    provider: session.provider,
    model: session.model,
    compaction: session.compaction,
    messages: [
      { role: 'user', content: 'after compaction' },
      { role: 'assistant', content: 'live reply' },
    ],
  };
  const project = (itemLimit) => projectStoredTranscript(session.id, doc, { itemLimit, checkpointAbsent: true });
  const tail = await project(2);
  assert.deepEqual(
    tail.items.map((item) => item.text),
    ['after compaction', 'live reply']
  );
  assert.equal(tail.transcriptHasOlder, true);
  // One page up: the newest segment's divider, then its rows.
  const page = await project(4);
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['arch2_3_1', 'arch2_divider', `hist_${session.id}_0_1`, `hist_${session.id}_1_1`]
  );
  assert.equal(page.transcriptHasOlder, true);
  const all = await project(64);
  assert.deepEqual(
    all.items.filter((item) => item.status === 'compacted').map((item) => item.id),
    ['arch1_divider', 'arch2_divider']
  );
  assert.equal(all.items.length, 12);
  assert.equal(all.transcriptHasOlder, false);
  const whole = await projectStoredTranscript(session.id, doc, { checkpointAbsent: true });
  assert.equal(whole.items.length, 2);
  // The live head loader reads pages below the archived rows it holds.
  const below = await readCompactionArchivePage(sessionsDir, session.id, { after: 0, before: 3, skip: 5, limit: 2 });
  assert.deepEqual(
    below.items.map((item) => item.id),
    ['arch1_3_1', 'arch1_divider']
  );
  assert.equal(below.hasOlder, true);
});

test('deleting a session removes its archive; the sweep reaps an orphaned one', async () => {
  const deleted = storedSession('delete');
  scheduleCompactionArchive({ session: deleted, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  const deletedPath = compactionArchivePath(sessionsDir, deleted.id);
  assert.equal(existsSync(deletedPath), true);
  rmSync(join(sessionsDir, `${deleted.id}.json`));
  assert.equal(deleteSession(deleted.id), true);
  assert.equal(existsSync(deletedPath), false);

  const orphan = storedSession('orphan');
  scheduleCompactionArchive({ session: orphan, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  const orphanPath = compactionArchivePath(sessionsDir, orphan.id);
  rmSync(join(sessionsDir, `${orphan.id}.json`));
  const old = new Date(Date.now() - 60_000);
  utimesSync(orphanPath, old, old);
  const tally = { cleaned: 0 };
  for (const _ of reapOrphanSidecars({ plan: { maxAge: 1_000 }, dir: sessionsDir, now: Date.now(), tally }));
  assert.equal(existsSync(orphanPath), false);
  assert.ok(tally.cleaned >= 1);
});

test('a delete that lands while a segment is being published wins, and leaves no temp file', async (t) => {
  const session = storedSession('delete-race');
  const path = compactionArchivePath(sessionsDir, session.id);
  let reached = 0;
  _setCompactionArchivePublishHook(async ({ tmp }) => {
    reached += 1;
    // The temp file is complete; the session is deleted before it publishes.
    assert.equal(existsSync(tmp), true);
    rmSync(join(sessionsDir, `${session.id}.json`));
    assert.equal(deleteSession(session.id), true);
  });
  t.after(() => _setCompactionArchivePublishHook(null));
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.equal(reached, 1);
  assert.equal(existsSync(path), false);
  assert.deepEqual(
    readdirSync(sessionsDir).filter((name) => name.includes(session.id)),
    []
  );
});

test('the fence also holds when the record survives but a delete bumped the epoch', async (t) => {
  const session = storedSession('delete-epoch');
  const path = compactionArchivePath(sessionsDir, session.id);
  _setCompactionArchivePublishHook(async () => {
    deleteCompactionArchive(sessionsDir, session.id);
  });
  t.after(() => _setCompactionArchivePublishHook(null));
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.equal(existsSync(path), false);
  assert.deepEqual(
    readdirSync(sessionsDir).filter(
      (name) => name.includes(session.id) && (name.endsWith('.tmp') || name.includes('.mixdog-tmp-'))
    ),
    []
  );
});

test('the cap counts each line with its newline', async () => {
  const session = storedSession('cap-newline');
  for (const seq of [1, 2, 3, 4]) {
    scheduleCompactionArchive({ session, before: itemsOf(seq, 3, 1_500), after: [], maxBytes: 12_000 });
  }
  await flushCompactionArchiveWrites();
  const size = readFileSync(compactionArchivePath(sessionsDir, session.id)).length;
  assert.ok(size <= 12_000, `archive ${size} bytes`);
});

test('archive pages follow the sidecar after it changes', async () => {
  const session = storedSession('index');
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  const first = await readCompactionArchivePage(sessionsDir, session.id, { limit: 10 });
  assert.deepEqual(
    first.items.map((item) => item.id),
    ['arch1_0_1', 'arch1_1_1', 'arch1_divider']
  );
  // Cached index for an unchanged file: same answer.
  assert.deepEqual(await readCompactionArchivePage(sessionsDir, session.id, { limit: 10 }), first);
  scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  await flushCompactionArchiveWrites();
  const second = await readCompactionArchivePage(sessionsDir, session.id, { limit: 3 });
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['arch2_0_1', 'arch2_1_1', 'arch2_divider']
  );
  assert.equal(second.hasOlder, true);
});

test('a deleted session does not regrow its archive from a pending write', async () => {
  const session = storedSession('late');
  rmSync(join(sessionsDir, `${session.id}.json`));
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
});

/** Runs `fn`, returns what it wrote to stderr. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

test('dropped messages that restore to no row claim no segment number', async () => {
  const session = storedSession('invisible');
  // Each is visible alone, but together (a pasted reference message and its
  // "." ack) the transcript shows nothing.
  const hidden = stamped(
    [
      { role: 'user', content: 'Reference files:\n\n### docs/a.md\nbody' },
      { role: 'assistant', content: '.' },
    ],
    session.id
  );
  assert.deepEqual(restoreTranscriptItems(hidden, { sessionId: session.id }), []);
  assert.equal(scheduleCompactionArchive({ session, before: hidden, after: [] }), null);
  assert.equal(session.compaction.archive, undefined);
  // The next real segment is number 1: no gap.
  scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await flushCompactionArchiveWrites();
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [1]
  );
  assert.equal(session.compaction.archive.nextSeq, 2);
});

/** A session whose record is missing while its save is pending: the first
 *  publication is refused and parks on the session's persistence signal. */
async function parkedSession(t, tag) {
  const session = storedSession(tag);
  const recordPath = join(sessionsDir, `${session.id}.json`);
  _setCompactionArchivePublishHook(async () => {
    _setCompactionArchivePublishHook(null);
    rmSync(recordPath);
    _savePending.set(session.id, {});
  });
  let parkedSignal;
  const parked = new Promise((resolve) => {
    parkedSignal = resolve;
  });
  _setCompactionArchiveParkHook(parkedSignal);
  t.after(() => {
    _setCompactionArchivePublishHook(null);
    _setCompactionArchiveParkHook(null);
    _savePending.delete(session.id);
    _resetCompactionArchiveState();
  });
  const log = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    log.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  // The write reaches its refusal and parks; a write that ends instead fails
  // the test rather than waiting for a park that never comes.
  await Promise.race([
    parked,
    scheduled.written.then(() => {
      throw new Error('publication ended without parking');
    }),
  ]);
  return { session, recordPath, scheduled, log };
}

test('a publication refused while the session is live waits for its save to land, without polling', async (t) => {
  const { session, recordPath, scheduled, log } = await parkedSession(t, 'refused-live');
  const second = scheduleCompactionArchive({ session, before: itemsOf(2, 2), after: [] });
  const original = globalThis.setImmediate;
  let immediates = 0;
  globalThis.setImmediate = (...args) => {
    immediates += 1;
    return original(...args);
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    globalThis.setImmediate = original;
  }
  // Parked on the persistence signal: nothing re-checks on its own.
  assert.equal(immediates, 0);
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  // The save lands: both segments are written, in order, none lost.
  writeFileSync(recordPath, JSON.stringify({ id: session.id }));
  _savePending.delete(session.id);
  publishSessionPersistence(session.id, 'landed');
  assert.ok(await scheduled.written);
  assert.ok(await second.written);
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [1, 2]
  );
  assert.equal(session.compaction.archive.nextSeq, 3);
  assert.match(
    log.join(''),
    new RegExp(`compaction archive write deferred \\(sess=${session.id}, seq=1\\): .*waiting`)
  );
});

test('a delete wakes the parked write: final skip, no segment, number given back', async (t) => {
  const { session, scheduled, log } = await parkedSession(t, 'parked-delete');
  assert.equal(deleteSession(session.id), true);
  assert.equal(await scheduled.written, null);
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  assert.equal(session.compaction.archive.nextSeq, 1);
  assert.match(log.join(''), new RegExp(`write skipped \\(sess=${session.id}, seq=1\\): session deleted`));
});

test('a close before the record exists keeps the segment; the next process publishes it', async (t) => {
  const { session, recordPath, scheduled } = await parkedSession(t, 'parked-close');
  publishSessionPersistence(session.id, 'closed');
  assert.equal(await scheduled.written, null);
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
  assert.equal(existsSync(pending), true);
  // Restart: nothing in memory; the session is saved again.
  _resetCompactionArchiveState();
  _savePending.delete(session.id);
  writeFileSync(recordPath, JSON.stringify({ id: session.id }));
  publishSessionPersistence(session.id, 'landed');
  await flushCompactionArchiveWrites();
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [1]
  );
  assert.equal(existsSync(pending), false);
});

test('a failed write survives a restart through the pending sidecar', async (t) => {
  const session = storedSession('restart');
  _setCompactionArchiveFsync(async () => {
    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
  });
  t.after(() => {
    _setCompactionArchiveFsync(null);
    _resetCompactionArchiveState();
  });
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await captureStderr(async () => {
    assert.equal(await scheduled.written, null);
  });
  // The sidecar is there as soon as the write failed (a kill now loses nothing).
  const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
  assert.equal(existsSync(pending), true);
  _resetCompactionArchiveState();
  _setCompactionArchiveFsync(null);
  // The new process: the session's next save retries the kept segment.
  publishSessionPersistence(session.id, 'landed');
  await flushCompactionArchiveWrites();
  const items = JSON.parse(archiveLines(session.id)[0]).items;
  assert.match(items[0].text, /^s1 m0/);
  assert.equal(existsSync(pending), false);
});

test('write-ahead: the pending sidecar exists before the shortened transcript is adopted, and is removed after publication', async () => {
  const session = storedSession('write-ahead');
  const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
  let messages = session.messages;
  let sidecarAtAdoption = null;
  Object.defineProperty(session, 'messages', {
    configurable: true,
    enumerable: true,
    get: () => messages,
    set(next) {
      sidecarAtAdoption = existsSync(pending);
      messages = next;
    },
  });
  const result = await compact(session, summaryProvider([]));
  assert.equal(result.changed, true);
  assert.equal(sidecarAtAdoption, true);
  await flushCompactionArchiveWrites();
  assert.equal(archiveLines(session.id).length, 1);
  assert.equal(existsSync(pending), false);
});

/** An fs failure as the OS reports it: `code` is what callers branch on. */
const fsError = (code) => Object.assign(new Error(`${code}: simulated`), { code });

test('a pending sidecar that cannot be written aborts the compaction and keeps the old transcript', async (t) => {
  const session = storedSession('write-ahead-fail');
  const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
  // A directory in the way: the sidecar's rename cannot land. Its read is
  // reported absent, so the failure is the write's.
  mkdirSync(pending);
  _setCompactionArchiveFs({
    readFileSync: () => {
      throw fsError('ENOENT');
    },
  });
  t.after(() => _setCompactionArchiveFs(null));
  const before = session.messages;
  const log = await captureStderr(async () => {
    const result = await compact(session, summaryProvider([]));
    assert.equal(result.changed, false);
    assert.match(result.error, /pending sidecar/);
  });
  rmSync(pending, { recursive: true });
  assert.equal(session.messages, before);
  // The claimed number was given back.
  assert.equal(session.compaction.archive.nextSeq, 1);
  assert.match(log, /compaction not applied/);
  assert.deepEqual(archiveLines(session.id), []);
});

/** Leaves a pending sidecar behind as a crashed process would: a failed write,
 *  then every in-memory trace forgotten. */
async function coldSidecar(t, tag) {
  const session = storedSession(tag);
  _setCompactionArchiveFsync(async () => {
    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
  });
  const scheduled = scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
  await captureStderr(async () => {
    await scheduled.written;
  });
  _setCompactionArchiveFsync(null);
  _resetCompactionArchiveState();
  t.after(() => _resetCompactionArchiveState());
  const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
  assert.equal(existsSync(pending), true);
  return { session, pending };
}

test('a delete removes a cold pending sidecar, so a recreated id imports no deleted history', async (t) => {
  const { session, pending } = await coldSidecar(t, 'cold-delete');
  rmSync(join(sessionsDir, `${session.id}.json`));
  assert.equal(deleteSession(session.id), true);
  assert.equal(existsSync(pending), false);
  writeFileSync(join(sessionsDir, `${session.id}.json`), JSON.stringify({ id: session.id }));
  publishSessionPersistence(session.id, 'landed');
  assert.equal(await recoverPendingCompactionArchives(), 0);
  await flushCompactionArchiveWrites();
  assert.deepEqual(archiveLines(session.id), []);
});

test('the startup scan publishes the pending segments of a session nothing else touches', async (t) => {
  const { session, pending } = await coldSidecar(t, 'cold-scan');
  // A sidecar whose session record is gone is left alone.
  const orphanId = `${session.id}-orphan`;
  const orphan = join(sessionsDir, `${orphanId}.compaction-archive.pending`);
  writeFileSync(orphan, readFileSync(pending));
  t.after(() => rmSync(orphan, { force: true }));
  assert.equal(await recoverPendingCompactionArchives(), 1);
  await flushCompactionArchiveWrites();
  assert.deepEqual(
    archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
    [1]
  );
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(compactionArchivePath(sessionsDir, orphanId)), false);
});

test('archive rows pass through the disk projection at publication, not at commit', async () => {
  const session = storedSession('redact');
  const secret = 'ZX-4821-secret';
  const before = stamped(
    [
      { role: 'user', content: `my code is ${secret}` },
      { role: 'assistant', content: 'noted' },
    ],
    session.id
  );
  scheduleCompactionArchive({ session, before, after: [] });
  // Marked after the commit, before the write.
  rememberSensitiveValues(session.id, [
    { name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: secret } } },
  ]);
  await flushCompactionArchiveWrites();
  const [line] = archiveLines(session.id);
  assert.equal(line.includes(secret), false);
  assert.ok(line.includes('[redacted]'));
});

test('a session deleted before its segment is written leaves no segment and no gap, and logs the skip', async (t) => {
  const session = storedSession('deleted-gap');
  _setCompactionArchivePublishHook(async () => {
    rmSync(join(sessionsDir, `${session.id}.json`));
    assert.equal(deleteSession(session.id), true);
  });
  t.after(() => _setCompactionArchivePublishHook(null));
  const log = await captureStderr(async () => {
    scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
    await flushCompactionArchiveWrites();
  });
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  assert.equal(session.compaction.archive.nextSeq, 1);
  assert.match(log, new RegExp(`compaction archive write skipped \\(sess=${session.id}, seq=1\\): session deleted`));
});

test('a record that is gone with no save pending is a skip that gives its number back, and is logged', async () => {
  const session = storedSession('record-gone');
  rmSync(join(sessionsDir, `${session.id}.json`));
  const log = await captureStderr(async () => {
    scheduleCompactionArchive({ session, before: itemsOf(1, 2), after: [] });
    await flushCompactionArchiveWrites();
  });
  assert.equal(existsSync(compactionArchivePath(sessionsDir, session.id)), false);
  assert.equal(session.compaction.archive.nextSeq, 1);
  assert.match(
    log,
    new RegExp(`compaction archive write skipped \\(sess=${session.id}, seq=1\\): session record missing`)
  );
});

/** Makes the sidecar read of `path` fail with `code`; every other read is real. */
function failSidecarRead(t, path, code) {
  _setCompactionArchiveFs({
    readFileSync: (target, encoding) => {
      if (target === path) throw fsError(code);
      return readFileSync(target, encoding);
    },
  });
  t.after(() => _setCompactionArchiveFs(null));
}

for (const code of ['EACCES', 'EIO']) {
  test(`a pending sidecar that cannot be read (${code}) survives later compactions, and is recovered once it reads`, async (t) => {
    const { session, pending } = await coldSidecar(t, `unreadable-${code}`);
    const original = readFileSync(pending, 'utf8');
    failSidecarRead(t, pending, code);
    const before = session.messages;
    const log = await captureStderr(async () => {
      const result = await compact(session, summaryProvider([]));
      assert.equal(result.changed, false);
      assert.match(result.error, new RegExp(code));
      // The session's own saves neither recover nor replace it either.
      publishSessionPersistence(session.id, 'landed');
    });
    assert.equal(session.messages, before);
    assert.equal(readFileSync(pending, 'utf8'), original);
    assert.match(log, new RegExp(`pending sidecar unreadable \\(sess=${session.id}\\): ${code}`));
    assert.deepEqual(archiveLines(session.id), []);
    // The read works again: the old job is recovered, the new one follows it.
    _setCompactionArchiveFs(null);
    const result = await compact(session, summaryProvider([]));
    assert.equal(result.changed, true);
    await flushCompactionArchiveWrites();
    assert.deepEqual(
      archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
      [1, 2]
    );
    assert.match(JSON.parse(archiveLines(session.id)[0]).items[0].text, /^s1 m0/);
    assert.equal(existsSync(pending), false);
  });
}

const DAMAGED_SIDECARS = {
  'truncated text': '{"v":1,"jobs":[{"seq":1,"messages":[',
  'NUL bytes after a crash': '\0'.repeat(64),
  'valid JSON that is not a job list': '{"v":1,"jobs":"none"}',
  'a job without messages': '{"v":1,"jobs":[{"seq":1}]}',
};

for (const [shape, damaged] of Object.entries(DAMAGED_SIDECARS)) {
  test(`a damaged pending sidecar (${shape}) is kept aside, never overwritten by a compaction`, async (t) => {
    const session = storedSession('damaged');
    const pending = join(sessionsDir, `${session.id}.compaction-archive.pending`);
    writeFileSync(pending, damaged);
    _resetCompactionArchiveState();
    t.after(() => _resetCompactionArchiveState());
    const log = await captureStderr(async () => {
      const result = await compact(session, summaryProvider([]));
      assert.equal(result.changed, true);
      await flushCompactionArchiveWrites();
    });
    const kept = readdirSync(sessionsDir).filter((name) =>
      name.startsWith(`${session.id}.compaction-archive.pending.corrupt-`)
    );
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(sessionsDir, kept[0]), 'utf8'), damaged);
    assert.match(log, new RegExp(`pending sidecar damaged \\(sess=${session.id}\\); kept as .*\\.corrupt-`));
    // The compaction itself went through, as if there were no sidecar.
    assert.deepEqual(
      archiveLines(session.id).map((line) => compactionSegmentHead(line).seq),
      [1]
    );
    assert.equal(existsSync(pending), false);
    t.after(() => rmSync(join(sessionsDir, kept[0]), { force: true }));
  });
}

test('the startup scan treats a missing store as empty and reports any other listing failure', async (t) => {
  t.after(() => _setCompactionArchiveFs(null));
  _setCompactionArchiveFs({
    readdir: async () => {
      throw fsError('ENOENT');
    },
  });
  assert.equal(await recoverPendingCompactionArchives(), 0);
  _setCompactionArchiveFs({
    readdir: async () => {
      throw fsError('EACCES');
    },
  });
  await assert.rejects(recoverPendingCompactionArchives(), { code: 'EACCES' });
});

test('the startup scan reports a sidecar it cannot read, leaves it intact and still recovers the others', async (t) => {
  const readable = await coldSidecar(t, 'scan-readable');
  const unreadable = await coldSidecar(t, 'scan-unreadable');
  t.after(() => rmSync(unreadable.pending, { force: true }));
  const original = readFileSync(unreadable.pending, 'utf8');
  failSidecarRead(t, unreadable.pending, 'EIO');
  let count;
  const log = await captureStderr(async () => {
    count = await recoverPendingCompactionArchives();
    await flushCompactionArchiveWrites();
  });
  assert.equal(count, 1);
  assert.match(log, new RegExp(`pending sidecar unreadable \\(sess=${unreadable.session.id}\\): EIO`));
  assert.equal(readFileSync(unreadable.pending, 'utf8'), original);
  assert.equal(existsSync(readable.pending), false);
  assert.deepEqual(archiveLines(unreadable.session.id), []);
});
