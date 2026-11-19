import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

test('the room transcript restores user files and peer speech as references, just as on the live feed', () => {
  const inputRef = 'a'.repeat(64);
  const outputRef = 'b'.repeat(64);
  const user = {
    type: 'roomRow',
    id: 'wire-user',
    text: 'Review [Image #1]',
    room: {
      kind: 'user',
      to: ['reviewer', 'author'],
      toName: ['Reviewer', 'Author'],
      fromSession: 'other-room',
      fromAgent: 'lead',
      fromName: 'Lead',
      parts: [{ type: 'image', attachmentRef: inputRef, mimeType: 'image/png', sizeBytes: 12 }],
    },
    attachments: [{ id: inputRef, kind: 'image', name: 'plan.png', mimeType: 'image/png', size: 12, bytes: 'not a transcript field' }],
    images: [{ id: 1, name: 'plan.png', mimeType: 'image/png', bytes: 12, attachmentRef: inputRef }],
    meta: { messageId: 'prompt-1', at: 10 },
  };
  const speech = {
    type: 'roomRow',
    id: 'wire-speech',
    text: 'Review complete',
    room: { kind: 'speech', name: 'Reviewer' },
    attachments: [{ id: outputRef, kind: 'file', name: 'review.txt', mimeType: 'text/plain', size: 15 }],
    meta: { messageId: 'reply-1', at: 20 },
  };
  const snapshot = { thread: { id: 'room' }, state: {}, items: [user, speech] };
  let live = sessionReducer.initial({ ...snapshot, items: [] });
  for (const item of snapshot.items) {
    live = sessionReducer.apply(live, { method: 'item/completed', params: { threadId: 'room', turnId: 'turn', item } });
  }
  const expected = [
    {
      kind: 'user',
      id: 'prompt-1',
      text: 'Review [Image #1]',
      room: {
        kind: 'user',
        to: ['reviewer', 'author'],
        toName: ['Reviewer', 'Author'],
        fromSession: 'other-room',
        fromAgent: 'lead',
        fromName: 'Lead',
        parts: [{ type: 'image', attachmentRef: inputRef, mimeType: 'image/png', sizeBytes: 12 }],
        id: 'prompt-1',
        at: 10,
      },
      messageId: 'prompt-1',
      at: 10,
      attachments: [{ id: inputRef, attachmentRef: inputRef, kind: 'image', name: 'plan.png', mimeType: 'image/png', size: 12 }],
      images: [{ id: 1, name: 'plan.png', mimeType: 'image/png', bytes: 12, attachmentRef: inputRef }],
      fromAgent: 'lead',
    },
    {
      kind: 'notice',
      id: 'wire-speech',
      text: 'Review complete',
      tone: 'info',
      room: { kind: 'speech', name: 'Reviewer', id: 'reply-1', at: 20 },
      messageId: 'reply-1',
      at: 20,
      attachments: [{ id: outputRef, attachmentRef: outputRef, kind: 'file', name: 'review.txt', mimeType: 'text/plain', size: 15 }],
    },
  ];
  assert.deepEqual(desktopSessionState(sessionReducer.initial(snapshot), []).items, expected, 'snapshot');
  assert.deepEqual(desktopSessionState(live, []).items, expected, 'live feed');
});
