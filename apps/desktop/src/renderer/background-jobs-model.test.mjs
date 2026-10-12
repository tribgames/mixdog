import assert from 'node:assert/strict';
import test from 'node:test';

import { backgroundJobRows } from './background-jobs-model.ts';
import {
  dismissedShellJobs,
  dismissShellJobs,
  resetDismissedShellJobsCache,
} from './background-jobs-dismissed-store.ts';

const snapshot = {
  shellJobs: {
    count: 1,
    elapsedLabel: '',
    jobs: [{ taskId: 'job_3', command: 'npm run dev', cwd: '', startedAt: 3000 }],
    finished: [
      { taskId: 'job_1', command: 'make', cwd: '', startedAt: 1000, status: 'completed', exitCode: 0, finishedAt: 2000 },
      { taskId: 'job_2', command: 'test', cwd: '', startedAt: 1500, status: 'failed', exitCode: 2, finishedAt: 2500 },
    ],
  },
};

test('finished shell rows follow running ones, newest finish first, with exit info', () => {
  const rows = backgroundJobRows(snapshot);
  assert.deepEqual(
    rows.map((row) => [row.key, Boolean(row.finished)]),
    [
      ['shell:job_3', false],
      ['shell:job_2', true],
      ['shell:job_1', true],
    ]
  );
  assert.equal(rows[1].exitCode, 2);
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[2].exitCode, 0);
});

test('dismissed finished rows never come back, and persist per session', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  resetDismissedShellJobsCache();
  dismissShellJobs('sess-x', ['shell:job_2']);
  assert.deepEqual(
    backgroundJobRows(snapshot, dismissedShellJobs('sess-x')).map((row) => row.key),
    ['shell:job_3', 'shell:job_1']
  );
  // A fresh load reads the persisted ids; other sessions are unaffected.
  resetDismissedShellJobsCache();
  assert.ok(dismissedShellJobs('sess-x').has('shell:job_2'));
  assert.equal(dismissedShellJobs('sess-y').size, 0);
  delete globalThis.localStorage;
});
