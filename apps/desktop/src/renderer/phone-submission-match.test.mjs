// The phone's pending bubble is released by the stored row's id, which Node sets to the submission id
// (transcript-intake.mjs `pushUserOrSyntheticItem(text, id)`; conversation-prompt-items.ts `pendingPromptTranscriptItems`
// releases `settledIds.has(String(item.id))`). The core's user item names the submission as `clientSubmissionId`; the shared fold
// (`rowOf`) must make it the row's id, so the match holds without the ordinal fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pendingPromptTranscriptItems } from './conversation-prompt-items.ts';
import { rowOf } from '../../../../packages/protocol-client/src/rows.ts';

const recorded = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/phone-chat-core/phone-chat-core.json', import.meta.url), 'utf8'));
const nodeRow = recorded.cases.find((c) => c.kind === 'submit' && c.after.items.length).after.items[0];

test("a stored user row with the core's clientSubmissionId releases the pending bubble by id, as Node's row does", () => {
  const stored = rowOf({
    type: 'userMessage',
    id: '01a1c0ed-6dc2-723f-b70f-0ff4ee62f1ce',
    clientSubmissionId: nodeRow.id,
    content: [{ type: 'text', text: nodeRow.text }],
    meta: { at: nodeRow.at, messageId: nodeRow.messageId },
  });
  assert.equal(stored.id, nodeRow.id);
  // No baseline: only the id can release it (the ordinal fallback needs one).
  const pending = { id: nodeRow.id, kind: 'user', text: nodeRow.text, pending: true, accepted: true, submittedAt: 1 };
  assert.deepEqual(pendingPromptTranscriptItems([pending], [stored]), []);
});

test('a row without the submission id keeps the item id, and its pending bubble stays', () => {
  const stored = rowOf({ type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'hi' }], meta: { at: 1 } });
  assert.equal(stored.id, 'item-1');
  const pending = { id: 'sub1', kind: 'user', text: 'hi', pending: true, accepted: true, submittedAt: 1 };
  assert.equal(pendingPromptTranscriptItems([pending], [stored]).length, 1);
});
