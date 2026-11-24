import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export default {};export const BrowserWindow = {};export const ipcMain = {};', shortCircuit: true }
      : next(specifier, context);
  },
});
const { endSessionRuntime } = await import('./session-runtime-end.ts');
const { secretInputs } = await import('./secret-input.ts');

test('a deleted session no longer has its filled secrets redacted or kept', () => {
  secretInputs.remember('gone', 'hunter2-plain');
  secretInputs.remember('kept', 'other-secret');
  assert.doesNotMatch(secretInputs.redact('gone', 'pw hunter2-plain'), /hunter2-plain/);
  endSessionRuntime('gone');
  assert.match(secretInputs.redact('gone', 'pw hunter2-plain'), /hunter2-plain/, 'nothing of it is held any more');
  assert.doesNotMatch(secretInputs.redact('kept', 'x other-secret'), /other-secret/, 'other sessions keep theirs');
});
