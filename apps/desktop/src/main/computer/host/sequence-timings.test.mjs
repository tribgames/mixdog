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

function holdRunner({ stepReply, release, delivery, capture }) {
  const events = [];
  const diagnostics = [];
  const runner = createSequenceRunner({
    sessionIdFor: () => 's',
    freshObservedWindowScope: () => ({ primaryWindowId: 'hwnd:0x1', relatedWindowIds: ['hwnd:0x1'] }),
    recordDiagnostic: (_session, record) => diagnostics.push(record),
    runCommand: async (command) => {
      events.push(`step:${command.action}:${command.input_continues === true}`);
      return { text: JSON.stringify(stepReply(command)) };
    },
    captureAfterAction: async () => {
      events.push('capture');
      await capture?.();
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
  return { events, diagnostics, run };
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

  // A step the user interrupts stops the sequence as an ordinary row; the
  // holds end and the observation still follows.
  const yielded = holdRunner({
    stepReply: () => {
      throw new Error('user_input_active: the user moved');
    },
  });
  const interrupted = JSON.parse((await yielded.run()).text);
  assert.deepEqual(yielded.events, ['step:key:true', 'release:s', 'capture']);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.code, 'user_input_active');
  assert.equal(interrupted.stopped_reason, 'user_input_active');
  assert.equal(interrupted.steps[0].status, 'uncertain');

  const foreground = holdRunner({
    delivery: 'foreground',
    stepReply: (command) => ({ ok: true, action: command.action }),
  });
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
  await assert.rejects(run(), /^Error: input_cleanup_unconfirmed: .*activatable/);
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
  await assert.rejects(stopped.run(), (error) => {
    assert.match(error.message, /^input_cleanup_unconfirmed: worker_exited/);
    assert.match(error.message, /stopped: background_target_hung/, 'the stop reason stays as detail');
    return true;
  });

  const yielded = holdRunner({
    stepReply: () => {
      throw new Error('user_input_active: the user moved');
    },
    release: failRelease,
  });
  await assert.rejects(yielded.run(), (error) => {
    assert.match(error.message, /^input_cleanup_unconfirmed: worker_exited/);
    assert.match(error.message, /stopped: user_input_active/);
    return true;
  });
});

test('an unconfirmed hold release skips the after-capture and keeps counts and rows', async () => {
  const captureFails = async () => {
    throw new Error('observation_unavailable: no frame');
  };
  const unreleased = holdRunner({
    stepReply: (command) =>
      command.keys === 'c'
        ? { ok: false, action: command.action, code: 'background_target_hung', input_may_have_executed: true }
        : { ok: true, action: command.action },
    release: async () => {
      throw new Error('worker_exited: the worker died');
    },
    capture: captureFails,
  });
  await assert.rejects(unreleased.run(), (error) => {
    assert.match(error.message, /^input_cleanup_unconfirmed: worker_exited/);
    assert.match(error.message, /completed 2\/3 steps \(last completed step 2\), stopped: background_target_hung/);
    assert.match(error.cause.message, /^worker_exited/);
    return true;
  });
  assert.equal(unreleased.events.includes('capture'), false, 'no capture delays the takeover');
  assert.deepEqual(unreleased.events.slice(-1), ['release:s']);
  assert.equal(unreleased.diagnostics.length, 1);
  assert.equal(unreleased.diagnostics[0].code, 'input_cleanup_unconfirmed');
  assert.deepEqual(
    unreleased.diagnostics[0].steps.map((row) => row.status),
    ['succeeded', 'succeeded', 'uncertain']
  );

  const released = holdRunner({
    stepReply: (command) => ({ ok: true, action: command.action }),
    capture: captureFails,
  });
  await assert.rejects(released.run(), /^Error: observation_unavailable/);
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
