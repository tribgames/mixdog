import assert from 'node:assert/strict';
import test from 'node:test';
import { createSequenceRunner, sequenceHoldReleaseError } from './sequence-runner.ts';

test('sequence reply exposes executed phases and one separate final observation duration', async () => {
  let captures = 0;
  let executions = 0;
  const runner = createSequenceRunner({
    sessionIdFor: () => 'timing-test',
    freshObservedWindowScope: () => ({
      primaryWindowId: 'hwnd:0x1',
      relatedWindowIds: ['hwnd:0x1'],
    }),
    runCommand: async (command) => {
      executions++;
      return {
        text: JSON.stringify({
          ok: true,
          action: command.action,
          timings_ms: { delivery_ms: executions, settle_ms: 150, after_windows_ms: 2 },
        }),
      };
    },
    captureAfterAction: async () => {
      captures++;
      return {
        metadata: { ok: true, timings_ms: { screenshot_ms: 12, ocr_ms: 5 } },
        image: { mimeType: 'image/jpeg', data: 'fixture' },
      };
    },
  });
  const reply = await runner.runBoundedSequence({
    action: 'sequence',
    window_id: 'hwnd:0x1',
    steps: [
      { action: 'key', keys: 'a' },
      { action: 'type', text: 'value' },
    ],
  });
  const payload = JSON.parse(reply.text);
  assert.equal(executions, 2);
  assert.equal(captures, 1);
  assert.equal(payload.completed, true);
  assert.deepEqual(
    payload.steps.map((row) => row.timings_ms.delivery_ms),
    [1, 2]
  );
  assert.equal(payload.capture_after.timings_ms.screenshot_ms, 12);
  assert.equal(payload.capture_after.timings_ms.ocr_ms, 5);
  assert.ok(payload.timings_ms.steps_ms >= 0);
  assert.ok(payload.timings_ms.post_capture_ms >= 0);
  assert.ok(payload.timings_ms.total_ms + 0.02 >= payload.timings_ms.steps_ms + payload.timings_ms.post_capture_ms);
  assert.equal(reply.image.data, 'fixture');
});

function holdRunner({ stepReply, release, delivery }) {
  const events = [];
  const runner = createSequenceRunner({
    sessionIdFor: () => 's',
    freshObservedWindowScope: () => ({ primaryWindowId: 'hwnd:0x1', relatedWindowIds: ['hwnd:0x1'] }),
    runCommand: async (command) => {
      events.push(`step:${command.action}:${command.input_continues === true}`);
      return { text: JSON.stringify(stepReply(command)) };
    },
    captureAfterAction: async () => {
      events.push('capture');
      return { metadata: { ok: true } };
    },
    releaseSequenceHolds: async (sessionId) => {
      events.push(`release:${sessionId}`);
      await release?.();
    },
  });
  const run = () =>
    runner.runBoundedSequence({
      action: 'sequence',
      window_id: 'hwnd:0x1',
      ...(delivery ? { delivery } : {}),
      steps: [
        { action: 'key', keys: 'a' },
        { action: 'key', keys: 'b' },
        { action: 'key', keys: 'c' },
      ],
    });
  return { events, run };
}

test('a background sequence ends its worker holds before the capture, however it stops', async () => {
  const done = holdRunner({
    stepReply: (command) => ({
      ok: true,
      action: command.action,
      ...(command.keys === 'b' ? { activation_protection: 'unavailable' } : {}),
    }),
  });
  const completed = JSON.parse((await done.run()).text);
  assert.deepEqual(done.events, ['step:key:true', 'step:key:true', 'step:key:false', 'release:s', 'capture']);
  assert.equal(completed.ok, true);
  assert.equal(completed.activation_protection, 'unavailable', 'one unprotected step marks the sequence');

  const stopped = holdRunner({
    stepReply: (command) =>
      command.keys === 'b'
        ? { ok: false, action: command.action, code: 'background_target_hung', input_may_have_executed: true }
        : { ok: true, action: command.action },
  });
  const failed = JSON.parse((await stopped.run()).text);
  assert.deepEqual(stopped.events, ['step:key:true', 'step:key:true', 'release:s', 'capture']);
  assert.equal(failed.stopped_reason, 'background_target_hung');

  // A step that yields to the user rejects the whole sequence to the outer queue.
  const yielded = holdRunner({
    stepReply: () => {
      throw new Error('user_input_active: the user moved');
    },
  });
  await assert.rejects(yielded.run(), /user_input_active/);
  const aborted = yielded;
  assert.deepEqual(aborted.events, ['step:key:true', 'release:s']);

  const foreground = holdRunner({ delivery: 'foreground', stepReply: (command) => ({ ok: true, action: command.action }) });
  await foreground.run();
  assert.equal(foreground.events.includes('release:s'), false, 'a foreground sequence holds nothing');
});

test('a sequence whose holds could not be ended does not report success', async () => {
  const { run } = holdRunner({
    stepReply: (command) => ({ ok: true, action: command.action }),
    release: async () => {
      throw new Error('input_cleanup_unconfirmed: the background target could not be made activatable again');
    },
  });
  const payload = JSON.parse((await run()).text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'input_cleanup_unconfirmed');
  assert.equal(payload.hold_cleanup.ok, false);
  assert.equal(payload.verdict.decision, 'escalate');
});

test('a hold cleanup failure outranks why the sequence stopped', async () => {
  const failRelease = async () => {
    throw new Error('worker_exited: the worker died');
  };
  const stopped = holdRunner({
    stepReply: (command) =>
      command.keys === 'b'
        ? { ok: false, action: command.action, code: 'background_target_hung', input_may_have_executed: true }
        : { ok: true, action: command.action },
    release: failRelease,
  });
  const payload = JSON.parse((await stopped.run()).text);
  assert.equal(payload.code, 'input_cleanup_unconfirmed');
  assert.equal(payload.stopped_reason, 'background_target_hung', 'the stop reason stays as detail');
  assert.match(payload.hold_cleanup.message, /worker_exited/);

  const yielded = holdRunner({
    stepReply: () => {
      throw new Error('user_input_active: the user moved');
    },
    release: failRelease,
  });
  await assert.rejects(yielded.run(), (error) => {
    assert.match(error.message, /^input_cleanup_unconfirmed: worker_exited/);
    assert.match(error.message, /user_input_active/);
    assert.match(error.cause.message, /^user_input_active/);
    return true;
  });
});

test('a refused worker release becomes a cleanup failure unless it names its own code', () => {
  assert.match(sequenceHoldReleaseError('the hold stayed').message, /^input_cleanup_unconfirmed: .*the hold stayed/);
  assert.match(sequenceHoldReleaseError(undefined).message, /^input_cleanup_unconfirmed:/);
  assert.equal(
    sequenceHoldReleaseError('input_cleanup_unconfirmed: the background target could not be made activatable again')
      .message,
    'input_cleanup_unconfirmed: the background target could not be made activatable again'
  );
});
