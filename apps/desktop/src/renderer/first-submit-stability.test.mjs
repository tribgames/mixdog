import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conversationCoverBasis,
  conversationCoverIdentity,
  conversationDraftPromotion,
  conversationLaneIsEmpty,
  conversationPresentedSessionId,
  conversationSwitchPaintGate,
  nextConversationCoverId,
} from './first-submit-stability.ts';

test('opening an existing cold session from New Task covers until its lane can paint', () => {
  const promotion = conversationDraftPromotion(false, '', 'session-a');
  assert.equal(promotion, false);
  const basis = conversationCoverBasis('draft', 'session-a', promotion);
  const { coverKey, promotingFromDraft } = conversationCoverIdentity(basis, 'session-a', false);
  assert.equal(coverKey, 'session-a');
  assert.equal(promotingFromDraft, false);
  assert.deepEqual(conversationSwitchPaintGate('draft', 'session-a', { contentReady: false }), {
    adoptNow: false,
    reveal: false,
  });
  // The lane landed after the click: one covered frame, then reveal.
  assert.deepEqual(conversationSwitchPaintGate('draft', 'session-a', { contentReady: true }), {
    adoptNow: false,
    reveal: false,
  });
  assert.deepEqual(conversationSwitchPaintGate('session-a', 'session-a', { contentReady: true }), {
    adoptNow: true,
    reveal: true,
  });
  assert.equal(nextConversationCoverId('draft', 'session-a', false, promotion), 'session-a');
});

test('a warm session opened from New Task adopts in the click commit', () => {
  assert.deepEqual(
    conversationSwitchPaintGate('draft', 'session-a', { contentReady: true, preparedBeforeSwitch: true }),
    { adoptNow: true, reveal: true }
  );
});

test('the session after one opened from New Task still takes a normal covered switch', () => {
  const coverId = nextConversationCoverId('draft', 'session-a', true, false);
  assert.equal(coverId, 'session-a');
  const promotion = conversationDraftPromotion(false, 'session-a', 'session-b');
  const { coverKey, promotingFromDraft } = conversationCoverIdentity(
    conversationCoverBasis(coverId, 'session-b', promotion),
    'session-b',
    false
  );
  assert.equal(coverKey, 'session-b');
  assert.equal(promotingFromDraft, false);
  assert.equal(conversationPresentedSessionId('session-a', 'session-b', { incomingReady: false }), 'session-a');
});

test("a draft's own first submit still promotes without a cover", () => {
  const promotion = conversationDraftPromotion(true, '', 'session-new');
  assert.equal(promotion, true);
  const { coverKey, promotingFromDraft } = conversationCoverIdentity(
    conversationCoverBasis('draft', 'session-new', promotion),
    'session-new',
    false
  );
  assert.equal(coverKey, 'draft');
  assert.equal(promotingFromDraft, true);
  assert.deepEqual(conversationSwitchPaintGate('draft', 'session-new', { promotingFromDraft }), {
    adoptNow: true,
    reveal: true,
  });
  // The promoted session keeps the draft cover after settle.
  assert.equal(nextConversationCoverId('draft', 'session-new', true, true), 'draft');
  // Leaving the promoted session is no longer a promotion.
  assert.equal(conversationDraftPromotion(true, 'session-new', 'session-b'), false);
  assert.equal(conversationCoverBasis('draft', 'session-b', false), 'session-b');
});

test('only a loaded lane without rows has no entry to wait for', () => {
  assert.equal(conversationLaneIsEmpty(null), false, 'an unloaded lane is not empty');
  assert.equal(conversationLaneIsEmpty({ items: [] }), true);
  assert.equal(conversationLaneIsEmpty({}), true);
  assert.equal(conversationLaneIsEmpty({ items: [{ id: 'u1' }] }), false);
  assert.equal(conversationLaneIsEmpty({ items: [], streamingTail: { id: 't' } }), false);
});
