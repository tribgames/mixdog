import assert from 'node:assert/strict';
import test from 'node:test';
import { createSequenceRunner } from './sequence-runner.ts';

test('sequence reply exposes executed phases and one separate final observation duration', async () => {
  let captures = 0;
  let executions = 0;
  const runner = createSequenceRunner({
    sessionIdFor: () => 'timing-test',
    freshObservedWindowScope: () => ({
      primaryWindowId: 'hwnd:0x1', relatedWindowIds: ['hwnd:0x1'],
    }),
    runCommand: async (command) => {
      executions++;
      return { text: JSON.stringify({
        ok: true, action: command.action,
        timings_ms: { delivery_ms: executions, settle_ms: 150, after_windows_ms: 2 },
      }) };
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
    action: 'sequence', window_id: 'hwnd:0x1',
    steps: [{ action: 'key', keys: 'a' }, { action: 'type', text: 'value' }],
  });
  const payload = JSON.parse(reply.text);
  assert.equal(executions, 2);
  assert.equal(captures, 1);
  assert.equal(payload.completed, true);
  assert.deepEqual(payload.steps.map((row) => row.timings_ms.delivery_ms), [1, 2]);
  assert.equal(payload.capture_after.timings_ms.screenshot_ms, 12);
  assert.equal(payload.capture_after.timings_ms.ocr_ms, 5);
  assert.ok(payload.timings_ms.steps_ms >= 0);
  assert.ok(payload.timings_ms.post_capture_ms >= 0);
  assert.ok(payload.timings_ms.total_ms + 0.02
    >= payload.timings_ms.steps_ms + payload.timings_ms.post_capture_ms);
  assert.equal(reply.image.data, 'fixture');
});
