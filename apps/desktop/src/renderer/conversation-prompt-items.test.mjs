import assert from 'node:assert/strict';
import test from 'node:test';
import { nextComposerSubmissionId } from './composer-draft.ts';
import {
  desktopPromptDisplayText,
  pendingPromptImages,
  pendingPromptTranscriptItems,
  promptWaitsBehindActiveTurn,
  unsettledQueueEntries,
} from './conversation-prompt-items.ts';

test("a group room's user row, posted under the submission id, releases the sent prompt's pending twin", () => {
  // The room posts the row under the submission id (rooms/live.rs `submission_row_id`), its `messageId` the row's id.
  const settled = [
    { kind: 'user', id: 's1', text: 'hi', messageId: 's1', room: { kind: 'user', id: 's1' } },
    { kind: 'notice', id: 'n2', text: 'ok', room: { kind: 'speech', id: 'row_1' } },
  ];
  const pending = { id: 's1', kind: 'user', text: 'hi', pending: true, accepted: true, submittedAt: 1 };
  assert.deepEqual(pendingPromptTranscriptItems([pending], settled), []);
});

test("another surface's user row never releases this pane's prompt, before or after its own row", () => {
  const pending = { kind: 'user', pending: true, accepted: true };
  const optimistic = [
    { ...pending, id: 's1', text: 'hi', submittedAt: 1 },
    { ...pending, id: 's2', text: 'hm', submittedAt: 2 },
  ];
  const user = (id, text) => ({ kind: 'user', id, text });
  const held = (prompts, settled) => pendingPromptTranscriptItems(prompts, settled).map((item) => item.id);
  const old = [user('u0', 'earlier'), { kind: 'assistant', id: 'a0', text: 'ok' }];
  assert.deepEqual(held(optimistic, [...old, user('other-device', 'from the phone')]), ['s1', 's2']);
  assert.deepEqual(held(optimistic, [...old, user('other-device', 'x'), user('s1', 'hi')]), ['s2']);
  assert.deepEqual(held(optimistic, [user('older', 'paged in'), ...old, user('s2', 'hm')]), ['s1']);
});

test('nextComposerSubmissionId mints unique id tokens', () => {
  const id1 = nextComposerSubmissionId();
  const id2 = nextComposerSubmissionId();
  assert.ok(id1.startsWith('desktop-submit-'));
  assert.ok(id2.startsWith('desktop-submit-'));
  assert.notEqual(id1, id2);
});

test('desktopPromptDisplayText extracts display text or fallbacks', () => {
  assert.equal(desktopPromptDisplayText('simple prompt'), 'simple prompt');
  assert.equal(desktopPromptDisplayText('fallback', { displayText: 'override text' }), 'override text');
  assert.equal(
    desktopPromptDisplayText([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', filename: 'screenshot.png' },
      { type: 'file', filename: 'doc.txt' },
    ]),
    // The image draws from the row's `images`; the file as its chip token.
    'Look at this:\n[File #1: doc.txt]'
  );
  assert.equal(
    desktopPromptDisplayText([{ type: 'file', filename: 'report.pdf', mimeType: 'application/pdf' }]),
    '[PDF #1: report.pdf]'
  );
  // Images alone: no words at all, never "[Image]" or a fallback label.
  assert.equal(desktopPromptDisplayText([{ type: 'image' }, { type: 'image' }]), '');
});

test('pendingPromptImages maps pasted images options into transcript image structures', () => {
  const result = pendingPromptImages({
    pastedImages: {
      img1: {
        id: 'img1',
        filename: 'test.png',
        mediaType: 'image/png',
        sizeBytes: 1024,
      },
      img2: {
        id: 'img2',
        mediaType: 'image/jpeg',
        content: 'base64data',
      },
    },
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    id: 'img1',
    name: 'test.png',
    mimeType: 'image/png',
    bytes: 1024,
  });
  assert.deepEqual(result[1], {
    id: 'img2',
    name: 'Image',
    mimeType: 'image/jpeg',
    bytes: 10,
  });
});

test('pendingPromptTranscriptItems holds optimistic items until own durable row settles', () => {
  const optimistic = [
    {
      id: 'submit-1',
      kind: 'user',
      text: 'hello world',
      pending: true,
      accepted: false,
      submittedAt: 100,
    },
  ];

  // 1. Unsettled: holds optimistic item
  const pending = pendingPromptTranscriptItems(optimistic, []);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'submit-1');
  assert.equal(pending[0].pending, true);

  // 2. Settled by exact id
  const settledWithId = [{ id: 'submit-1', kind: 'user', text: 'hello world' }];
  const releasedById = pendingPromptTranscriptItems(optimistic, settledWithId);
  assert.equal(releasedById.length, 0);

  // 3. A user row of another submission is not this one's
  const other = [{ id: 'runtime-uuid-99', kind: 'user', text: 'hello world' }];
  assert.equal(pendingPromptTranscriptItems(optimistic, other).length, 1);
});

test('promptWaitsBehindActiveTurn checks active/queued state unless in draft mode', () => {
  assert.equal(promptWaitsBehindActiveTurn(true, { busy: true, queued: [] }), false);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: true, queued: [] }), true);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: false, queued: [{ id: 'q1' }] }), true);
  assert.equal(promptWaitsBehindActiveTurn(false, { busy: false, queued: [] }), false);
});

test('unsettledQueueEntries filters out entries whose durable row already settled', () => {
  const settled = [{ id: 'msg-1', kind: 'user', text: 'first' }];
  const queue = [
    { id: 'msg-1', text: 'first' },
    { id: 'msg-2', text: 'second' },
  ];
  const filtered = unsettledQueueEntries(queue, settled);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'msg-2');
});
