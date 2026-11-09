import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_THINKING_STAGE,
  awaitingModelResponse,
  displayProgressStage,
  lastProgressAt,
  QUIET_PROGRESS_CUE_MS,
  quietProgress,
  quietProgressLabel,
  quietProgressParts,
  quietWaitKind,
} from '../../src/rows/quiet-progress.mjs';

test('the quiet cue is lenient: a turn reads quiet only after the cue window without counted progress', () => {
  const now = 1_000_000_000;
  // Long silent-thinking turns are ordinary; the cue never fires inside them.
  assert.ok(QUIET_PROGRESS_CUE_MS >= 120_000);
  assert.equal(quietProgress({ progressAt: now - QUIET_PROGRESS_CUE_MS + 1, stage: 'streaming', now }), null);
  assert.deepEqual(quietProgress({ progressAt: now - QUIET_PROGRESS_CUE_MS, stage: 'requesting', now }), {
    since: now - QUIET_PROGRESS_CUE_MS,
    wait: 'provider',
  });
  assert.equal(quietProgress({ progressAt: 0, stage: 'requesting', now }), null);
  assert.equal(quietWaitKind('tool_running'), 'tool');
  assert.equal(quietWaitKind('resource_wait'), 'slot');
  assert.equal(quietWaitKind('idle'), '');
});

test('the quiet state is frozen for a silence and escalates only at the watchdog warn point', () => {
  const since = 1_000;
  const quiet = quietProgress({ progressAt: since, stage: 'tool_running', tool: 'shell', now: since + 180_000 });
  assert.deepEqual(quiet, { since, wait: 'tool', tool: 'shell' });
  const warnMs = 300_000;
  const early = quietProgressParts(quiet, since + 180_000, warnMs);
  assert.equal(early.minutes, 3);
  assert.equal(early.escalated, false);
  assert.equal(quietProgressLabel(early), 'quiet for 3m · running shell');
  const late = quietProgressParts(quiet, since + warnMs, warnMs);
  assert.equal(late.escalated, true);
  assert.equal(quietProgressParts(null, since, warnMs), null);
  assert.equal(
    quietProgressLabel(quietProgressParts({ since, wait: 'provider' }, since + 125_000)),
    'quiet for 2m · waiting on provider'
  );
});

test('a sent request waiting for its headers is the model-thinking stage until transport arrives', () => {
  const sent = { stage: 'requesting', requestSentAt: 100, lastTransportAt: 0 };
  assert.equal(awaitingModelResponse(sent), true);
  assert.equal(displayProgressStage(sent), MODEL_THINKING_STAGE);
  // Transport from an earlier attempt does not count; this attempt's does.
  assert.equal(displayProgressStage({ ...sent, lastTransportAt: 50 }), MODEL_THINKING_STAGE);
  assert.equal(displayProgressStage({ ...sent, lastTransportAt: 150 }), 'requesting');
  // Not sent yet, or already past requesting.
  assert.equal(displayProgressStage({ stage: 'requesting', requestSentAt: 0 }), 'requesting');
  assert.equal(displayProgressStage({ ...sent, stage: 'streaming' }), 'streaming');
  assert.equal(quietWaitKind(MODEL_THINKING_STAGE), 'thinking');
  assert.equal(
    quietProgressLabel(quietProgressParts({ since: 1, wait: 'thinking' }, 1 + 125_000)),
    'quiet for 2m · model thinking'
  );
});

test('progress is counted from the same stamps as the stall watchdog', () => {
  assert.equal(lastProgressAt({ lastProgressAt: 5, lastStreamDeltaAt: 9, toolStartedAt: 7, askStartedAt: 1 }), 9);
  assert.equal(lastProgressAt(null), 0);
});
