import assert from 'node:assert/strict';
import test from 'node:test';

import { updaterOutcomeToast } from './use-desktop-updater.ts';
import { quotaStopIsNew } from './quota-continue.ts';

test('update toast fires only for a download finishing or failing, never at start or on repeats', () => {
  const downloading = { status: 'downloading', version: '2.0.0', percent: 40 };
  const ready = { status: 'ready', version: '2.0.0' };
  assert.equal(updaterOutcomeToast({ status: 'disabled' }, ready), null);
  assert.equal(updaterOutcomeToast(ready, ready), null);
  assert.equal(updaterOutcomeToast(downloading, { ...downloading, percent: 50 }), null);
  assert.equal(updaterOutcomeToast({ status: 'installing', version: '2.0.0' }, ready), null);
  assert.deepEqual(updaterOutcomeToast(downloading, ready), {
    text: 'Mixdog v2.0.0 downloaded. Restart to apply the update.',
    tone: 'success',
  });
  assert.deepEqual(updaterOutcomeToast(downloading, { status: 'error', message: 'net down' }), {
    text: 'Could not download the update: net down',
    tone: 'error',
  });
  assert.equal(updaterOutcomeToast({ status: 'checking' }, { status: 'error', message: 'x' }), null);
});

const failure = (turnKey) => ({
  turnKey,
  kind: 'quota_exhausted',
  quota: { provider: 'p', model: 'm', resetAt: null },
});

test('quota stop toasts once per occurrence across consumers, never for history or switches', () => {
  // session opened with an old stop already in the transcript
  assert.equal(quotaStopIsNew('a', failure('t1'), true), false);
  assert.equal(quotaStopIsNew('a', failure('t1'), true), false);
  // a stop appearing later (even between snapshots, no busy needed) toasts once for two consumers
  assert.equal(quotaStopIsNew('a', failure('t2'), true), true);
  assert.equal(quotaStopIsNew('a', failure('t2'), true), false);
  // switching away and back re-reads the same stop
  assert.equal(quotaStopIsNew('b', null, true), false);
  assert.equal(quotaStopIsNew('a', failure('t2'), true), false);
  // history hydrating after the session id appears is the baseline, not a new stop
  assert.equal(quotaStopIsNew('c', null, false), false);
  assert.equal(quotaStopIsNew('c', failure('t9'), true), false);
  assert.equal(quotaStopIsNew('c', failure('t10'), true), true);
});
