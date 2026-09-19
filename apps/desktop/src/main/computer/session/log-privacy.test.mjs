import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerLogError, computerLogTarget } from './log-privacy.ts';
import { appendComputerRunRecord, computerRunRecord, readComputerRunRecords } from './run-log.ts';

test('a session can read back its own run history, newest last, without the truncated tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-run-history-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const sessionId = `history-${process.pid}`;
  process.env.MIXDOG_DATA_DIR = directory;
  try {
    appendComputerRunRecord(sessionId, { action: 'click', effect: 'confirmed' });
    appendComputerRunRecord(sessionId, { action: 'type', effect: 'confirmed' });
    await mkdir(join(directory, 'computer-runs'), { recursive: true });
    const records = readComputerRunRecords(sessionId, 10);
    assert.deepEqual(
      records.map((record) => record.action),
      ['click', 'type']
    );
    assert.equal(records[0].session, sessionId);
    assert.deepEqual(
      readComputerRunRecords(sessionId, 1).map((record) => record.action),
      ['type']
    );
    // A history read never invents a session and never fails a command.
    assert.deepEqual(readComputerRunRecords('', 10), []);
    assert.deepEqual(readComputerRunRecords('never-ran', 10), []);
    await writeFile(join(directory, 'computer-runs', `${sessionId}.jsonl`), '{"action":"click"}\n{"action":', 'utf8');
    assert.deepEqual(
      readComputerRunRecords(sessionId, 10).map((record) => record.action),
      ['click']
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
  }
});

test('launch diagnostics omit URL credentials, paths, query strings and fragments', () => {
  const record = computerRunRecord(
    {
      action: 'launch',
      app: 'https://user:secret@example.invalid/reset/secret?token=secret#secret',
    },
    performance.now()
  );
  assert.equal(record.app, 'https://example.invalid/');
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(computerLogTarget('custom:secret'), 'custom:[redacted]');
  assert.equal(computerLogTarget('https://[invalid/secret'), '[redacted-url]');
  assert.equal(computerLogTarget('C:\\Apps\\editor.exe'), 'editor.exe');
});

test('diagnostics retain only the error category without provider payloads', () => {
  assert.equal(computerLogError(new Error('target_required: private clipboard text')), 'target_required');
  assert.equal(computerLogError(new Error('target_mismatch|private clipboard text')), 'target_mismatch');
  assert.equal(
    computerLogError(new Error('launch failed for https://example.invalid/?secret')),
    'computer_command_failed'
  );
});

test('run history keeps sequence and capture phase timings behind the privacy boundary', () => {
  const record = computerRunRecord({ action: 'sequence' }, performance.now(), {
    text: JSON.stringify({
      ok: true,
      action: 'sequence',
      timings_ms: { total_ms: 900, steps_ms: 600, post_capture_ms: 290 },
      steps: [
        {
          status: 'succeeded',
          text: 'private-value',
          timings_ms: { delivery_ms: 40, settle_ms: 150, after_windows_ms: 5 },
        },
        { status: 'failed', message: 'private-value', timings_ms: { execution_ms: 300 } },
        { status: 'skipped', timings_ms: { execution_ms: 999 } },
      ],
      capture_after: { timings_ms: { accessibility_ms: 200, screenshot_ms: 180, ocr_ms: 70, title: 'private-value' } },
    }),
  });
  assert.deepEqual(record.timings_ms, { total_ms: 900, steps_ms: 600, post_capture_ms: 290 });
  assert.equal(record.step_timings.length, 2);
  assert.equal(record.step_timings[0].timings_ms.settle_ms, 150);
  assert.equal(record.step_timings[1].timings_ms.execution_ms, 300);
  assert.deepEqual(record.capture_timings_ms, { accessibility_ms: 200, screenshot_ms: 180, ocr_ms: 70 });
  assert.equal(JSON.stringify(record).includes('private-value'), false);
});

test('uncertain input and failed observation remain independently diagnosable', () => {
  const record = computerRunRecord({ action: 'sequence' }, performance.now(), {
    text: JSON.stringify({
      ok: false,
      completed: false,
      input_may_have_executed: true,
      steps: [
        {
          status: 'uncertain',
          code: 'background_delivery_unknown',
          delivery_accepted: null,
          input_may_have_executed: true,
          message: 'private-value',
          timings_ms: { execution_ms: 20 },
        },
      ],
      observation: {
        ok: false,
        accessibility_status: 'error',
        accessibility_error: 'computer_command_timeout: private-value',
        pixel_status: 'unavailable',
        pixel_unavailable: { code: 'pixel_unavailable', reason: 'capture_source_unavailable' },
      },
    }),
  });
  assert.equal(record.input_may_have_executed, true);
  assert.equal(record.step_timings[0].status, 'uncertain');
  assert.equal(record.step_timings[0].delivery_accepted, null);
  assert.equal(record.step_timings[0].code, 'background_delivery_unknown');
  assert.equal(record.observation.accessibility_error, 'computer_command_timeout');
  assert.equal(record.observation.pixel_reason, 'capture_source_unavailable');
  assert.equal(JSON.stringify(record).includes('private-value'), false);
});

test('plain screenshots and failed post-action captures retain bounded private-free attempt evidence', () => {
  const rows = Array.from({ length: 12 }, () => ({
    backend: 'wgc',
    scope: 'target',
    status: 'failed',
    elapsed_ms: 40,
    code: 'capture_timeout',
    cleanup: { status: 'unconfirmed', cancellation: 'unconfirmed', secret: 'private-value' },
    text: 'private-value',
    image: 'private-value',
    window_title: 'private-value',
  }));
  for (const result of [
    { text: 'Screenshot of private-value', captureAttempts: rows },
    { text: JSON.stringify({ action: 'click', ok: false, capture_after: { capture_attempts: rows } }) },
  ]) {
    const record = computerRunRecord({ action: 'screenshot' }, performance.now(), result);
    assert.equal(record.capture_attempts.length, 8);
    assert.deepEqual(record.capture_attempts[0], {
      backend: 'wgc',
      scope: 'target',
      status: 'failed',
      elapsed_ms: 40,
      code: 'capture_timeout',
      cleanup: { status: 'unconfirmed', cancellation: 'unconfirmed' },
    });
    assert.equal(JSON.stringify(record).includes('private-value'), false);
  }
});
