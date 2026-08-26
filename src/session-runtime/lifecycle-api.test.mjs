import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResumeCwd } from './lifecycle-api.mjs';

test('project resume prefers canonical session cwd over stale desktop metadata', () => {
  assert.equal(resolveResumeCwd({
    cwd: 'C:\\Project\\mixdog',
    desktopSession: {
      classification: 'project',
      projectPath: 'C:\\Project\\GamerScroll',
    },
  }, 'C:\\fallback'), 'C:\\Project\\mixdog');
});

test('unclassified desktop task resume stays in its host-managed workspace', () => {
  assert.equal(resolveResumeCwd({
    cwd: 'C:\\old-transient',
    desktopSession: { classification: 'task', projectPath: null },
  }, 'C:\\task-workspace'), 'C:\\task-workspace');
});
