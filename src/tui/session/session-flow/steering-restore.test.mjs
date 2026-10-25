// Restoring the durable queued-input mirror after a restart: delivery is
// decided by submission identity, a restored row keeps what it runs, and a
// row stays durable until the queue settles it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-steering-restore-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { appendTuiSteeringPersist, readTuiSteeringPersist } = await import('../tui-steering-persist.mjs');
const { createQueueOps, createSubmissionMemory } = await import('./queue.mjs');
const { createSteeringOps } = await import('./steering.mjs');
const { persistedUserTranscriptMetadata } = await import('../../../runtime/shared/transcript-metadata.mjs');
const { nextId } = await import('../transcript-spill.mjs');
const { turnOptionsForBatch } = await import('./drain.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

function boot(sessionId, messages = []) {
  const pending = [];
  const state = { busy: false, commandBusy: false, queued: [] };
  let sequence = 0;
  const bag = {
    runtime: { id: sessionId, session: { messages } },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `restore-${++sequence}`,
  };
  const queue = createQueueOps(bag, { kickDrain() {} });
  const steering = createSteeringOps(bag, { queue, submissions: createSubmissionMemory() });
  return { pending, state, steering, queue };
}

const accept = (sessionId, entry) => appendTuiSteeringPersist(sessionId, { submittedAt: Date.now(), ...entry });
const user = (content, meta = {}) => ({ role: 'user', content, meta });

test('a prompt is released only when its own submission is in the transcript', async () => {
  const sid = 'restoreidentity';
  await accept(sid, { id: 'sub-again', text: 'continue' });
  await accept(sid, { id: 'sub-turn', text: 'first prompt' });
  await accept(sid, { id: 'sub-batch-2', text: 'second of a batch' });
  await accept(sid, { id: 'sub-steered', text: 'steered in' });
  const { pending, state, steering } = boot(sid, [
    user('please continue with the tests', { transcript: { checkpointId: 'sub-earlier' } }),
    user('first prompt\nsecond of a batch', {
      transcript: { checkpointId: 'sub-turn', submissionIds: ['sub-turn', 'sub-batch-2'] },
    }),
    user('steered in', { source: 'steering', submissionIds: ['sub-steered'], transcript: {} }),
  ]);
  await steering.restoreLeadSteeringFromDisk();
  // The same words as an earlier message are a new submission, never a delivered one.
  assert.deepEqual(
    pending.map((entry) => [entry.id, entry.text]),
    [['sub-again', 'continue']]
  );
  assert.deepEqual(
    state.queued.map((entry) => entry.id),
    ['sub-again']
  );
  // The delivered rows' lost drops are completed.
  assert.deepEqual(
    (await readTuiSteeringPersist(sid)).map((row) => row.submissionId),
    ['sub-again']
  );
});

test('a row of an older build is still judged by its text', async () => {
  const sid = 'restorelegacy';
  await accept(sid, { id: 'it_5', text: 'already sent' });
  await accept(sid, { id: 'it_6', text: 'never sent' });
  const { pending, steering } = boot(sid, [user('already sent', { transcript: { checkpointId: 'it_6' } })]);
  await steering.restoreLeadSteeringFromDisk();
  // A reused process-local id proves nothing; the text decides.
  assert.deepEqual(
    pending.map((entry) => entry.id),
    ['it_6']
  );
});

test('a restored prompt keeps its executable content and attachment links', async () => {
  const sid = 'restorecontent';
  const content = [
    { type: 'text', text: '[Pasted text #1 +40 lines] review this' },
    { type: 'image', ref: 'att_image_1', mimeType: 'image/png' },
  ];
  const pastedTexts = { 1: { id: 1, ref: 'att_text_1', lines: 40 } };
  const pastedImages = { 2: { id: 2, ref: 'att_image_1' } };
  await accept(sid, {
    id: 'sub-attach',
    text: '[Pasted text #1 +40 lines] review this',
    content,
    pastedTexts,
    pastedImages,
    transcriptMeta: { device: 'Laptop' },
    priority: 'now',
  });
  const { pending, steering } = boot(sid);
  await steering.restoreLeadSteeringFromDisk();
  const [entry] = pending;
  assert.deepEqual(entry.content, content);
  assert.equal(entry.text, '[Pasted text #1 +40 lines] review this');
  assert.deepEqual(entry.pastedTexts, pastedTexts);
  assert.deepEqual(entry.pastedImages, pastedImages);
  assert.deepEqual(entry.transcriptMeta, { device: 'Laptop' });
  assert.equal(entry.priority, 'now');
});

test('a restored retry of a failed turn keeps its retry options', async () => {
  const sid = 'restoreretry';
  await accept(sid, {
    id: 'sub-retry',
    text: 'retry me',
    retryFailedTurn: true,
    retryTurnId: 'turn-failed',
    retryAttemptId: 'attempt-failed',
    suppressDisplay: true,
  });
  // A text retry whose failed turn kept no ids.
  await accept(sid, { id: 'sub-text-retry', text: 'retry by text', retryFailedTurn: true });
  await accept(sid, { id: 'sub-plain', text: 'plain input' });
  const { pending, steering } = boot(sid);
  await steering.restoreLeadSteeringFromDisk();
  const [retry, textRetry, plain] = pending;
  assert.equal(retry.id, 'sub-retry');
  assert.equal(retry.retryFailedTurn, true);
  assert.equal(retry.retryTurnId, 'turn-failed');
  assert.equal(retry.retryAttemptId, 'attempt-failed');
  assert.equal(retry.suppressDisplay, true);
  assert.equal(textRetry.retryFailedTurn, true);
  assert.equal(textRetry.retryTurnId, null);
  assert.equal(textRetry.retryAttemptId, null);
  assert.equal(textRetry.suppressDisplay, false);
  assert.equal(plain.retryFailedTurn, false);
  assert.equal(plain.suppressDisplay, false);
});

for (const order of ['retry-first', 'plain-first']) {
  test(`a restored id-less retry runs as its own batch (${order})`, async () => {
    const sid = `restoreisolate${order}`;
    const rows = {
      retry: { id: 'sub-retry', text: 'retry by text', retryFailedTurn: true },
      plain: { id: 'sub-plain', text: 'plain input' },
    };
    for (const key of order === 'retry-first' ? ['retry', 'plain'] : ['plain', 'retry']) {
      await accept(sid, rows[key]);
    }
    const { pending, steering, queue } = boot(sid);
    await steering.restoreLeadSteeringFromDisk();
    assert.equal(pending.length, 2);
    const steeringStub = { commitSteeringQueueEntries() {}, releaseSteeringQueueEntries() {} };
    const first = queue.dequeueQueueBatch('later');
    const second = queue.dequeueQueueBatch('later');
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    for (const batch of [first, second]) {
      const isRetry = batch[0].id === 'sub-retry';
      const options = turnOptionsForBatch(batch, steeringStub);
      assert.equal(options.retryFailedTurn, isRetry);
      assert.equal(options.retryTurnId, null);
      assert.equal(options.retryAttemptId, null);
    }
  });
}

test('a restored routine entry keeps its skill selection', async () => {
  const sid = 'restoreroutine';
  await accept(sid, { id: 'sub-routine', text: 'nightly', mode: 'routine', skillSelection: 'review-skill' });
  const { pending, steering } = boot(sid);
  await steering.restoreLeadSteeringFromDisk();
  assert.equal(pending[0].mode, 'routine');
  assert.equal(pending[0].skillSelection, 'review-skill');
  assert.equal(turnOptionsForBatch(pending, { commitSteeringQueueEntries() {} }).skillSelection, 'review-skill');
});

test('a restored prompt survives another restart until the queue commits it', async () => {
  const sid = 'restoretwice';
  await accept(sid, { id: 'sub-durable', text: 'run the migration' });
  const first = boot(sid);
  await first.steering.restoreLeadSteeringFromDisk();
  const second = boot(sid);
  await second.steering.restoreLeadSteeringFromDisk();
  assert.deepEqual(
    second.pending.map((entry) => entry.id),
    ['sub-durable']
  );
  // Restoring again in the same process never double-books the row.
  await second.steering.restoreLeadSteeringFromDisk();
  assert.equal(second.pending.length, 1);

  await second.steering.commitSteeringQueueEntries(second.pending);
  const third = boot(sid);
  await third.steering.restoreLeadSteeringFromDisk();
  assert.deepEqual(third.pending, []);
});

test('a merged batch names every submission on its persisted user row', () => {
  const merged = persistedUserTranscriptMetadata({ checkpointId: 'a', submissionIds: ['a', 'b'] });
  assert.deepEqual(merged.submissionIds, ['a', 'b']);
  assert.equal(Object.hasOwn(persistedUserTranscriptMetadata({ checkpointId: 'a' }), 'submissionIds'), false);
});

test('a restarted process never issues an earlier process item id', () => {
  assert.doesNotMatch(nextId(), /^it_\d+$/);
});
