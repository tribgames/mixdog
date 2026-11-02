import assert from 'node:assert/strict';
import test from 'node:test';

import { registerDesktopNoticeSink } from '../../../../shared/desktop-notice-host.mjs';
import { _droppedSaveIds, _recordSaveFailure, clearSessionSaveError } from './live-state.mjs';

test('a transcript save that fails tells the desktop once per run, whichever session it was', (t) => {
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  t.after(() => {
    for (const id of ['save-notice-a', 'save-notice-b']) {
      clearSessionSaveError(id);
      _droppedSaveIds.delete(id);
    }
  });
  _recordSaveFailure('save-notice-a', new Error('ENOSPC: no space left on device'));
  _recordSaveFailure('save-notice-b', new Error('EACCES: permission denied'));
  assert.deepEqual(notices, [{ key: 'conversation-save', code: 'conversation-save-failed', params: {} }]);
});
