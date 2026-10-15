// An entry queued explicitly as a task notification (channel notices: webhook
// event rules, schedule injects) keeps that mode through normalization and the
// durable spool shape, so every drain stores it as a notification and none of
// its text drives explicit skill selection.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _groupPendingMessageEntries,
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

test('plain entries stay prompts; unknown modes are not trusted', () => {
  assert.equal(pendingEntryMode(pendingMessageQueueEntry('typed $pptx')), 'prompt');
  assert.equal(pendingEntryMode(pendingMessageQueueEntry({ content: 'typed' })), 'prompt');
  const odd = pendingMessageQueueEntry({ content: 'x', mode: 'goal-continuation' });
  assert.equal(odd.mode, undefined);
  assert.equal(normalizePersistedEntry({ message: 'x', mode: 'whatever' }).mode, undefined);
});
