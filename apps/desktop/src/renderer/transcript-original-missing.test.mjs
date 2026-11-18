// A message that lost the full-size original of an image carries the count on the message itself, so its note shows from
// the stored item on every reload, not once when it was sent.
import assert from 'node:assert/strict';
import test from 'node:test';

const stored = (count) => ({
  type: 'userMessage',
  id: 'it_1',
  content: [{ type: 'text', text: 'look' }],
  clientSubmissionId: 'sub-1',
  displayText: 'look',
  details: {},
  meta: { messageId: 'msg_1', ext: count === undefined ? {} : { originalImagesMissing: count } },
});

test('the count the core stored on a message reaches its row and is worded once per message', async () => {
  const { rowOf } = await import('../../../../packages/protocol-client/src/rows.ts');
  const { originalImagesMissingText } = await import('./transcript-row.tsx');
  assert.equal(rowOf(stored(2)).originalImagesMissing, 2);
  assert.equal(rowOf(stored(undefined)).originalImagesMissing, undefined);
  assert.equal(
    originalImagesMissingText(1),
    'The full-size original of an image could not be found, so it was sent at its smaller size.'
  );
  assert.equal(
    originalImagesMissingText(3),
    'The full-size originals of 3 images could not be found, so they were sent at their smaller size.'
  );
  for (const none of [undefined, null, 0, '2', 1.5]) assert.equal(originalImagesMissingText(none), null);
});
