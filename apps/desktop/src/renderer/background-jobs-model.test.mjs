import assert from 'node:assert/strict';
import test from 'node:test';

import { compactCount, agentUsageMeta } from './agent-row-meta.ts';
import { t as translate } from './i18n.ts';
import { backgroundJobRows, cwdFolderName, shellFinishedLabel, shellRowAction } from './background-jobs-model.ts';
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
      {
        taskId: 'job_1',
        command: 'make',
        cwd: '',
        startedAt: 1000,
        status: 'completed',
        exitCode: 0,
        finishedAt: 2000,
      },
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

test('compact counts and usage meta omit unknown parts', () => {
  assert.deepEqual([0, 999, 1000, 128_400, 999_960, 1_250_000].map(compactCount), [
    '0',
    '999',
    '1k',
    '128.4k',
    '1M',
    '1.3M',
  ]);
  assert.equal(agentUsageMeta(undefined), '');
  assert.equal(agentUsageMeta({ usage: null, toolCalls: null }), '');
  assert.equal(
    agentUsageMeta({ usage: { totalTokens: 128_400 }, toolCalls: null }),
    translate('{{tokens}} tokens', { tokens: '128.4k' })
  );
  assert.equal(
    agentUsageMeta({ usage: { totalTokens: 41_200 }, toolCalls: 9 }),
    `${translate('{{tokens}} tokens', { tokens: '41.2k' })} · ${translate('Island: {{count}} tool calls', { count: 9 })}`
  );
  assert.equal(agentUsageMeta({ usage: null, toolCalls: 0 }), translate('Island: {{count}} tool calls', { count: 0 }));
});

test('shell row action follows the stop state; finished rows only dismiss', () => {
  const running = { finished: false };
  assert.equal(shellRowAction(running, undefined), 'stop');
  assert.equal(shellRowAction(running, 'stopping'), 'stopping');
  assert.equal(shellRowAction(running, 'failed'), 'retry');
  assert.equal(shellRowAction({ finished: true }, 'stopping'), 'dismiss');
});

test('finished shell labels: cancelled reads Stopped, then exit code, then Finished', () => {
  assert.equal(shellFinishedLabel({ status: 'cancelled', exitCode: 1 }), translate('Island: Stopped'));
  assert.equal(
    shellFinishedLabel({ status: 'failed', exitCode: 2 }),
    translate('Island: Exited {{code}}', { code: 2 })
  );
  assert.equal(shellFinishedLabel({ status: 'completed', exitCode: null }), translate('Island: Finished'));
});

test('cwd folder name takes the last segment of either separator', () => {
  assert.equal(cwdFolderName('C:\\Project\\cart-service\\'), 'cart-service');
  assert.equal(cwdFolderName('/work/api'), 'api');
  assert.equal(cwdFolderName(''), '');
  assert.equal(
    backgroundJobRows({
      shellJobs: { count: 1, elapsedLabel: '', jobs: [{ taskId: 'a', command: 'x', cwd: '/w/p', startedAt: 1 }] },
    })[0].taskId,
    'a'
  );
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
