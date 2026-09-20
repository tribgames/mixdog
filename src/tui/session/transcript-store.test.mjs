import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-store-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { createSessionDraftStore } = await import('./draft-store.mjs');
const { createTranscriptStore } = await import('./transcript-store.mjs');
const { createTranscriptSpillBuffer } = await import('./transcript-spill.mjs');

function createHarness() {
  const draft = {
    state: {
      items: [],
      transcriptViewItems: null,
      transcriptViewRevision: 0,
      transcriptHistoryBefore: false,
      transcriptHistoryAfter: false,
      structureRevision: 0,
      streamingTail: null,
      promptHistoryList: [],
      activeToolSummary: 'x',
      activeTools: {},
      stats: {},
      cwd: join(dataDir, 'project'),
    },
  };
  const store = createSessionDraftStore({ draft, listeners: new Set(), isDisposed: () => false, onBusyReleased() {} });
  const flags = { pushingFromDeferredEntry: false, flushDeferredBeforeImmediatePush: null };
  const itemIndexById = new Map();
  const transcriptSpill = createTranscriptSpillBuffer();
  let bulkReplaces = 0;
  const transcript = createTranscriptStore({
    draft,
    store,
    flags,
    transcriptSpill,
    itemIndexById,
    onBulkReplace: () => bulkReplaces++,
  });
  return { draft, store, flags, itemIndexById, transcript, bulkReplaces: () => bulkReplaces, transcriptSpill };
}

test('pushItem indexes the item, and a user item republishes prompt history immediately', async () => {
  const { draft, store, itemIndexById, transcript, flags } = createHarness();
  let deferredFlushes = 0;
  flags.flushDeferredBeforeImmediatePush = () => deferredFlushes++;
  transcript.pushItem({ kind: 'assistant', id: 'a1', text: 'hi' });
  assert.equal(itemIndexById.get('a1'), 0);
  assert.equal(deferredFlushes, 1);
  assert.equal(store.getPublishedState().items.length, 0);
  transcript.pushItem({ kind: 'user', id: 'u1', text: 'question' });
  assert.deepEqual(draft.state.promptHistoryList, ['question']);
  await Promise.resolve();
  assert.equal(store.getPublishedState().items.length, 2);
  assert.equal(store.getPublishedState().structureRevision, 1);
});

test('appendItems merges extra patch keys and reindexes', () => {
  const { draft, itemIndexById, transcript } = createHarness();
  assert.equal(transcript.appendItems([], { busy: true }), true);
  assert.equal(draft.state.busy, true);
  transcript.appendItems([{ id: 'x' }, { id: 'y' }]);
  assert.equal(itemIndexById.get('y'), 1);
  assert.equal(draft.state.items.length, 2);
});

test('replaceItems drops tracked tool calls and rebuilds the derived lists', () => {
  const { draft, transcript, bulkReplaces, itemIndexById } = createHarness();
  const live = transcript.replaceItems([
    { kind: 'user', id: 'u1', text: 'first' },
    { kind: 'assistant', id: 'a1', text: 'reply' },
  ]);
  assert.equal(live.length, 2);
  assert.equal(bulkReplaces(), 1);
  assert.equal(itemIndexById.get('a1'), 1);
  assert.deepEqual(draft.state.promptHistoryList, ['first']);
  assert.equal(draft.state.activeToolSummary, null);
  assert.equal(draft.state.transcriptViewRevision, 1);
  // The structure revision is committed at the frame boundary, not inline.
  assert.equal(draft.state.structureRevision, 0);
  const kept = transcript.replaceItems([{ kind: 'user', id: 'u2', text: 'second' }], { preserveSpill: true });
  assert.equal(kept.length, 1);
  assert.deepEqual(draft.state.promptHistoryList, ['first']);
});

test('streaming tail keeps its text epoch until the text is reset', () => {
  const { draft, transcript } = createHarness();
  const epochKey = Symbol.for('mixdog.streaming-tail-text-epoch');
  assert.equal(transcript.updateStreamingTail(null), false);
  assert.equal(transcript.updateStreamingTail('t1', { text: 'a' }), true);
  const first = draft.state.streamingTail;
  assert.equal(first.streaming, true);
  assert.equal(Object.keys(first).includes('text'), true);
  assert.equal(Object.getOwnPropertyDescriptor(first, epochKey).enumerable, false);
  transcript.updateStreamingTail('t1', { text: 'ab' });
  assert.equal(draft.state.streamingTail[epochKey], first[epochKey]);
  transcript.updateStreamingTail('t1', { text: 'z' }, {}, { resetText: true });
  assert.notEqual(draft.state.streamingTail[epochKey], first[epochKey]);
  assert.equal(transcript.updateStreamingTail('t1', { text: 'z' }), false);
  assert.equal(transcript.clearStreamingTail('other', { busy: true }), true);
  assert.ok(draft.state.streamingTail);
  assert.equal(transcript.clearStreamingTail('t1'), true);
  assert.equal(draft.state.streamingTail, null);
});

test('patchItem goes through the shared mutators', () => {
  const { draft, transcript } = createHarness();
  transcript.pushItem({ kind: 'tool', id: 'c1', name: 'shell', result: '' });
  transcript.patchItem('c1', { result: 'done' });
  assert.equal(draft.state.items[0].result, 'done');
});
