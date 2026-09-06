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
