// notifyFnForSession must not double-inject a background-task completion. The
// mirror skip is gated on an EXPLICIT model-visible-delivery ack
// (modelVisibleDelivered), set ONLY by the TUI execution-ui path that injects
// the completion body into the active loop — never on a generic truthy
// onNotification return. So: delivered ack → mirror suppressed; headless /
// display-only / API listener (no ack) → mirror kept as the sole delivery.
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldMirrorCompletionToPendingQueue } from '../src/session-runtime/runtime-core.mjs';

// A terminal agent completion with a Result body — accepted by
// shouldPersistModelVisibleToolCompletion.
const completionText = 'Async agent task task_1 completed finished.\n\nResult:\n> ok';
const completionMeta = { type: 'agent_task_result', execution_id: 'task_1', status: 'completed' };

test('delivered-live completion: no pending mirror (explicit model-visible ack)', () => {
  const mirror = shouldMirrorCompletionToPendingQueue({
    callerSessionId: 'sess_live',
    modelVisibleDelivered: true,
    hasEnqueue: true,
    text: completionText,
    meta: completionMeta,
  });
  assert.equal(mirror, false, 'live twin already injected → mirror suppressed');
});

test('headless completion: pending mirror kept (no ack)', () => {
  const mirror = shouldMirrorCompletionToPendingQueue({
    callerSessionId: 'sess_headless',
    modelVisibleDelivered: false,
    hasEnqueue: true,
    text: completionText,
    meta: completionMeta,
  });
  assert.equal(mirror, true, 'no listener delivered → queue copy is the sole delivery');
});

test('display-only listener returning true (no ack): pending mirror kept', () => {
  // A generic display/API listener consumes the event (would return true) but
  // never injects the model-visible body, so it sets NO modelVisibleDelivered
  // ack. The mirror must stay, or the model never sees the completion body.
  const mirror = shouldMirrorCompletionToPendingQueue({
    callerSessionId: 'sess_display_only',
    modelVisibleDelivered: false,
    hasEnqueue: true,
    text: completionText,
    meta: completionMeta,
  });
  assert.equal(mirror, true, 'generic handled===true is NOT an ack → mirror kept');
});

test('unhandled but non-terminal notification is never mirrored', () => {
  const mirror = shouldMirrorCompletionToPendingQueue({
    callerSessionId: 'sess_headless',
    modelVisibleDelivered: false,
    hasEnqueue: true,
    text: 'still running...',
    meta: { status: 'running' },
  });
  assert.equal(mirror, false, 'only persistable terminal completions mirror');
});

test('missing session id or enqueue capability never mirrors', () => {
  assert.equal(shouldMirrorCompletionToPendingQueue({
    callerSessionId: '', modelVisibleDelivered: false, hasEnqueue: true,
    text: completionText, meta: completionMeta,
  }), false, 'no caller session → nothing to mirror into');
  assert.equal(shouldMirrorCompletionToPendingQueue({
    callerSessionId: 'sess_headless', modelVisibleDelivered: false, hasEnqueue: false,
    text: completionText, meta: completionMeta,
  }), false, 'no enqueue capability → cannot mirror');
});
