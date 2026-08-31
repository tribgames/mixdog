// Retraction bookkeeping for replayed sends. A stalled stream is retried as a
// fresh request, so the text the previous attempt exposed is a DRAFT of the
// same answer, not an earlier part of it. These tests pin the two halves of
// that contract: a replacement supersedes the retracted draft, and a failure
// that never produced a replacement still preserves what the user saw.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnInterruptionTracker } from './turn-interruption.mjs';

const OPENING = 'Let me check that for you.';

test('repeated retry attempts commit one copy of the opening, not one per retry', () => {
    const tracker = createTurnInterruptionTracker();

    // Attempt 1: an opening reaches the user, the stream stalls, the loop
    // retracts exactly what it exposed.
    tracker.recordTextDelta(OPENING);
    tracker.tombstoneText(OPENING.length);
    // Attempt 2: same answer, same opening, stalls again.
    tracker.recordTextDelta(OPENING);
    tracker.tombstoneText(OPENING.length);
    // Attempt 3 finally answers.
    tracker.recordTextDelta('Here is the answer.');

    assert.equal(tracker.snapshot().partialAssistantContent, 'Here is the answer.');
});

test('a crash between retries snapshots a single copy of the visible text', () => {
    const tracker = createTurnInterruptionTracker();

    tracker.recordTextDelta(OPENING);
    tracker.tombstoneText(OPENING.length);
    tracker.recordTextDelta(OPENING);

    assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
});

test('text retracted with no replacement is restored for the failure path', () => {
    const tracker = createTurnInterruptionTracker();

    tracker.recordTextDelta(OPENING);
    tracker.tombstoneText(OPENING.length);

    // Nothing replaced it, so the bytes the user already saw must survive the
    // interruption/error finalize.
    assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
    assert.equal(tracker.restoreTombstonedText(), true);
    assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
});

test('a committed assistant message clears both the partial and the retracted draft', () => {
    const tracker = createTurnInterruptionTracker();

    tracker.recordTextDelta(OPENING);
    tracker.tombstoneText(OPENING.length);
    tracker.markAssistantMessageCommitted();

    assert.equal(tracker.snapshot().partialAssistantContent, '');
    assert.equal(tracker.restoreTombstonedText(), false);
});
