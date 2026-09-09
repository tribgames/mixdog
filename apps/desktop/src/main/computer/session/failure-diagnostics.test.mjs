import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createComputerFailureDiagnostics } from './failure-diagnostics.ts';

test('failure bundles retain bounded steps and recovery while excluding private payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-diagnostics-'));
  try {
    const diagnostics = createComputerFailureDiagnostics(directory);
    for (let index = 0; index < 85; index++) diagnostics.record('private-session', {
      action: 'click', ok: index < 60, ms: index, window_id: 'hwnd:0x123',
      text: 'private-text', app: 'private-app', title: 'private-title',
      image: { data: 'private-pixels' }, clipboard: 'private-clipboard',
      path: 'C:\\private-path', error: 'private-error with content',
      native_result: { code: 'foreground_unavailable', path: 'foreground',
        delivery_accepted: false, text: 'private-native-text', cursor: [100, 200],
        cursor_feedback: { system_theme_applied: true, system_theme_restored: true, pointer_moved: false, text: 'private-cursor' } },
      timings_ms: { delivery_ms: 3, settle_ms: 150, after_windows_ms: 4, extra: 'private-timing' },
      steps: Array.from({ length: 9 }, () => ({
        status: 'failed', message: 'private-step',
        timings_ms: { execution_ms: 200, extra: 'private-step-timing' },
      })),
      capture_after: { timings_ms: { ocr_ms: 20, text: 'private-ocr' } },
      input_recovery: { ok: false, user_control: true, focus_restored: false,
        cursor_restored: true, reasserted: true, message: 'private-recovery' },
    });
    const files = await readdir(directory);
    assert.equal(files.length, 20);
    for (const file of files) {
      const source = await readFile(join(directory, file), 'utf8');
      assert.equal(source.includes('private-'), false);
      const bundle = JSON.parse(source);
      assert.equal(bundle.records.length, 40);
      assert.equal(bundle.screenshots, 'excluded');
      assert.equal(bundle.records.at(-1).recovery.user_control, true);
      assert.deepEqual(bundle.records.at(-1).native_result,
        { code: 'foreground_unavailable', path: 'foreground', delivery_accepted: false });
      assert.equal(bundle.records.at(-1).timings_ms.delivery_ms, 3);
      assert.equal(bundle.records.at(-1).step_timings.length, 6);
      assert.equal(bundle.records.at(-1).capture_timings_ms.ocr_ms, 20);
      assert.ok(Buffer.byteLength(source) <= 128 * 1024);
    }
    const restored = diagnostics.read();
    assert.equal(restored.length, 20);
    assert.equal(restored[0].records.at(-1).step_timings[0].timings_ms.execution_ms, 200);
    assert.equal(restored[0].records.at(-1).timings_ms.settle_ms, 150);
    assert.equal(restored[0].records.at(-1).timings_ms.after_windows_ms, 4);
    assert.equal(restored[0].records.at(-1).capture_timings_ms.ocr_ms, 20);
    assert.equal(restored[0].records.at(-1).recovery.focus_restored, false);
    assert.equal(restored[0].records.at(-1).recovery.cursor_restored, true);
    assert.equal(restored[0].records.at(-1).recovery.reasserted, true);
    assert.equal(restored[0].records.at(-1).native_result.code, 'foreground_unavailable');
    assert.deepEqual(restored[0].records.at(-1).cursor_feedback,
      { system_theme_applied: true, system_theme_restored: true, pointer_moved: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
