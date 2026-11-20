import assert from 'node:assert/strict';
import test from 'node:test';
import { computerActionsWith } from '../../../shared/core-src/runtime/computer-bridge/actions.mjs';
import { PS_RUNTIME } from './ps-runtime.ts';

// Refs belong to a window's observation: a command that neither targets nor
// observes a window (the clipboard) must not retire them, one that changes a
// window must.
test('clipboard commands keep the session refs; window mutations retire them', () => {
  const retained = computerActionsWith('retainNativeRefs');
  for (const action of ['clipboard_read', 'clipboard_write', 'list_windows']) {
    assert.ok(retained.includes(action), `${action} keeps refs`);
  }
  for (const action of ['launch', 'invoke_menu', 'click', 'type', 'close_window', 'focus_window']) {
    assert.ok(!retained.includes(action), `${action} retires refs`);
  }
  // The resident worker enforces the same list.
  const embedded = /\$readActions = (@\([^)]*\))/.exec(
    PS_RUNTIME.slice(PS_RUNTIME.indexOf('function Invalidate-RefsForRequest'))
  );
  assert.ok(embedded && embedded[1].includes('clipboard_write'));
});
