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
      timings_ms: { delivery_ms: 3, extra: 'private-timing' },
      input_recovery: { ok: false, user_control: true, message: 'private-recovery' },
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
      assert.equal(bundle.records.at(-1).timings_ms.delivery_ms, 3);
      assert.ok(Buffer.byteLength(source) <= 128 * 1024);
    }
    assert.equal(diagnostics.read().length, 20);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
