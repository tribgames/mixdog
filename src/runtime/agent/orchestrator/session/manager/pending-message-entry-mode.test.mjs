// An entry queued explicitly as a task notification (channel notices: webhook
// event rules, schedule injects) keeps that mode through normalization and the
// durable spool shape, so every drain stores it as a notification and none of
// its text drives explicit skill selection.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _groupPendingMessageEntries,
  markCompletionEntry,
  normalizePersistedEntry,
  pendingEntryMode,
  pendingMessageQueueEntry,
} from './pending-message-entry.mjs';

test('an explicit task-notification mode survives queueing and the persisted spool shape', () => {
  for (const content of ['Review $pptx', [{ type: 'text', text: 'Review $pptx' }]]) {
    const queued = pendingMessageQueueEntry({ content, mode: 'task-notification' });
    assert.equal(queued.mode, 'task-notification');
    const persisted = normalizePersistedEntry(queued);
    assert.equal(persisted.mode, 'task-notification');
    const reloaded = pendingMessageQueueEntry(JSON.parse(JSON.stringify(persisted)));
    assert.equal(pendingEntryMode(reloaded), 'task-notification');
    const [group] = _groupPendingMessageEntries([reloaded]);
    assert.equal(group.mode, 'task-notification');
  }
});

test('the bot-chain hop of a completion survives the durable spool shape and reaches its drained group', () => {
  const text = 'Async shell task job_hop (completed, exit 0) finished.\n\nResult:\n> [task_id: job_hop]';
  const queued = markCompletionEntry(text, { executionId: 'job_hop', meta: { hop: 2 } });
  assert.equal(queued.hop, 2);
  const persisted = normalizePersistedEntry(queued);
  assert.equal(persisted.hop, 2, 'the spool shape keeps it');
  const reloaded = pendingMessageQueueEntry(JSON.parse(JSON.stringify(persisted)));
  assert.equal(reloaded.hop, 2);
  assert.equal(_groupPendingMessageEntries([reloaded])[0].hop, 2, 'the drained group carries it');
  // Work launched outside a bot-descended turn carries none.
  assert.equal(markCompletionEntry(text, { executionId: 'job_hop' }).hop, undefined);
});

test('plain entries stay prompts; unknown modes are not trusted', () => {
  assert.equal(pendingEntryMode(pendingMessageQueueEntry('typed $pptx')), 'prompt');
  assert.equal(pendingEntryMode(pendingMessageQueueEntry({ content: 'typed' })), 'prompt');
  const odd = pendingMessageQueueEntry({ content: 'x', mode: 'goal-continuation' });
  assert.equal(odd.mode, undefined);
  assert.equal(normalizePersistedEntry({ message: 'x', mode: 'whatever' }).mode, undefined);
});
