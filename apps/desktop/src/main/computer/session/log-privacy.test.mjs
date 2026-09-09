import assert from 'node:assert/strict';
import test from 'node:test';
import { computerLogError, computerLogTarget } from './log-privacy.ts';
import { computerRunRecord } from './run-log.ts';

test('launch diagnostics omit URL credentials, paths, query strings and fragments', () => {
  const record = computerRunRecord({
    action: 'launch',
    app: 'https://user:secret@example.invalid/reset/secret?token=secret#secret',
  }, performance.now());
  assert.equal(record.app, 'https://example.invalid/');
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(computerLogTarget('custom:secret'), 'custom:[redacted]');
  assert.equal(computerLogTarget('https://[invalid/secret'), '[redacted-url]');
  assert.equal(computerLogTarget('C:\\Apps\\editor.exe'), 'editor.exe');
});

test('diagnostics retain only the error category without provider payloads', () => {
  assert.equal(computerLogError(new Error('target_required: private clipboard text')), 'target_required');
  assert.equal(computerLogError(new Error('launch failed for https://example.invalid/?secret')), 'computer_command_failed');
});

test('run history keeps sequence and capture phase timings behind the privacy boundary', () => {
  const record = computerRunRecord({ action: 'sequence' }, performance.now(), {
    text: JSON.stringify({
      ok: true, action: 'sequence',
      timings_ms: { total_ms: 900, steps_ms: 600, post_capture_ms: 290 },
      steps: [
        { status: 'succeeded', text: 'private-value',
          timings_ms: { delivery_ms: 40, settle_ms: 150, after_windows_ms: 5 } },
        { status: 'failed', message: 'private-value', timings_ms: { execution_ms: 300 } },
        { status: 'skipped', timings_ms: { execution_ms: 999 } },
      ],
      capture_after: { timings_ms: { accessibility_ms: 200, screenshot_ms: 180,
        ocr_ms: 70, title: 'private-value' } },
    }),
  });
  assert.deepEqual(record.timings_ms, { total_ms: 900, steps_ms: 600, post_capture_ms: 290 });
  assert.equal(record.step_timings.length, 2);
  assert.equal(record.step_timings[0].timings_ms.settle_ms, 150);
  assert.equal(record.step_timings[1].timings_ms.execution_ms, 300);
  assert.deepEqual(record.capture_timings_ms, { accessibility_ms: 200, screenshot_ms: 180, ocr_ms: 70 });
  assert.equal(JSON.stringify(record).includes('private-value'), false);
});
