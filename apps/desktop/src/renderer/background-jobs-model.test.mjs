import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmText } from './confirm-text.ts';
import { t as translate } from './i18n.ts';

test('confirmText collapses newlines and truncates long commands to one ~100-char line', () => {
  assert.equal(confirmText('echo a\n  echo b\r\n'), 'echo a echo b');
  const shown = confirmText(`node -e "${'x'.repeat(500)}"\nrm -rf /`);
  assert.equal(Array.from(shown).length, 100);
  assert.equal(shown.endsWith('…'), true);
  assert.equal(shown.includes('\n'), false);
  assert.equal(confirmText('short'), 'short');
});
import {
  backgroundJobRows,
  cwdFolderName,
  expiredShellRows,
  SHELL_AUTO_DISMISS_MS,
  shellFinishedLabel,
  shellRowAction,
} from './background-jobs-model.ts';
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

test('shell row action follows the stop state; finished rows only dismiss', () => {
  const running = { finished: false };
  assert.equal(shellRowAction(running, undefined), 'stop');
  assert.equal(shellRowAction(running, 'stopping'), 'stopping');
  assert.equal(shellRowAction(running, 'failed'), 'retry');
  assert.equal(shellRowAction(running, 'unconfirmed'), 'stopping');
  assert.equal(shellRowAction({ finished: true }, 'stopping'), 'dismiss');
});

test('finished shell labels: exit 0 reads Exited, a stop Stopped, anything else Failed', () => {
  assert.equal(shellFinishedLabel({ status: 'completed', exitCode: 0 }), translate('Island: Exited'));
  assert.equal(shellFinishedLabel({ status: 'cancelled', exitCode: 1 }), translate('Island: Stopped'));
  assert.equal(shellFinishedLabel({ status: 'failed', exitCode: 2 }), translate('Failed'));
  assert.equal(shellFinishedLabel({ status: 'completed', exitCode: null }), translate('Failed'));
  assert.equal(shellFinishedLabel({ status: 'failed', exitCode: 0 }), translate('Failed'));
});

test('only clean exits expire, SHELL_AUTO_DISMISS_MS after they finished (or were first seen)', () => {
  const row = (key, exitCode, finishedAt, status = 'completed') => ({
    key,
    kind: 'shell',
    label: key,
    startedAt: 0,
    finished: true,
    exitCode,
    status,
    finishedAt,
  });
  const rows = [
    { key: 'run', kind: 'shell', label: 'run', startedAt: 0 },
    row('ok-old', 0, 1_000),
    row('ok-new', 0, 50_000),
    row('ok-unknown', 0, 0),
    row('failed', 2, 1_000, 'failed'),
    row('stopped', null, 1_000, 'cancelled'),
  ];
  const seen = () => 30_000;
  assert.equal(SHELL_AUTO_DISMISS_MS, 60_000);
  assert.deepEqual(expiredShellRows(rows, 61_000, seen), { keys: ['ok-old'], nextAt: 90_000 });
  assert.deepEqual(expiredShellRows(rows, 110_000, seen), { keys: ['ok-old', 'ok-new', 'ok-unknown'], nextAt: 0 });
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

test('a running shell that leaves the running list is kept until its finished record, or a bounded grace', async () => {
  const { EMPTY_SHELL_ROW_RETENTION, retainVanishedShellRows, SHELL_FINISH_GRACE_MS } = await import(
    './background-jobs-model.ts'
  );
  const running = (id, startedAt) => ({ shellJobs: { count: 1, jobs: [{ taskId: id, command: id, startedAt }] } });
  const finished = (id, startedAt) => ({
    shellJobs: {
      count: 0,
      jobs: [],
      finished: [{ taskId: id, command: id, startedAt, status: 'completed', exitCode: 0, finishedAt: 5000 }],
    },
  });
  let retention = EMPTY_SHELL_ROW_RETENTION;
  const step = (snap, now) => {
    const out = retainVanishedShellRows(retention, backgroundJobRows(snap), now);
    retention = out.retention;
    return out;
  };
  step(running('job_32', 1000), 10_000);
  // The host frame between the two: not running, not yet finished.
  const gap = step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 10_050);
  assert.deepEqual(
    gap.rows.map((row) => [row.key, Boolean(row.finished)]),
    [['shell:job_32', false]],
    'never dropped'
  );
  assert.equal(gap.expiresAt, 10_050 + SHELL_FINISH_GRACE_MS);
  const again = step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 10_900);
  assert.equal(again.rows.length, 1, 'still kept on a repeated frame');
  assert.equal(again.expiresAt, 10_050 + SHELL_FINISH_GRACE_MS, 'the grace does not restart');
  const done = step(finished('job_32', 1000), 11_000);
  assert.deepEqual(
    done.rows.map((row) => [row.key, Boolean(row.finished)]),
    [['shell:job_32', true]],
    'replaced, not duplicated'
  );
  assert.equal(done.expiresAt, 0);
  // A finished record that never comes lapses after the grace.
  step(running('job_40', 2000), 20_000);
  step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100);
  assert.equal(
    step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100 + SHELL_FINISH_GRACE_MS - 1).rows.length,
    1
  );
  assert.equal(
    step({ shellJobs: { count: 0, jobs: [], finished: [] } }, 20_100 + SHELL_FINISH_GRACE_MS).rows.length,
    0
  );
});
