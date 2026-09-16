import assert from 'node:assert/strict';
import test from 'node:test';

import {
  desktopSessionSummaries,
  filterSessionIds,
  isSessionId,
  optionalSessionId,
  requiredSessionId,
  requiredSessionIds,
  requiredVisibleSessionVersion,
} from './desktop-state.ts';

test('session ids share one shape across host, service, and IPC', () => {
  assert.equal(isSessionId('sess_lead'), true);
  assert.equal(isSessionId('bad id'), false);
  assert.equal(isSessionId('x'.repeat(257)), true);
  assert.equal(isSessionId(''), false);
  assert.equal(requiredSessionId('  lead  '), 'lead');
  assert.throws(() => requiredSessionId(1), /must be a string/);
  assert.throws(() => requiredSessionId('bad id'), /invalid/);
  assert.throws(() => requiredSessionId('x'.repeat(257)), /invalid/);
  assert.equal(optionalSessionId(undefined), undefined);
  assert.equal(optionalSessionId(null), undefined);
  assert.equal(optionalSessionId(''), undefined);
  assert.equal(optionalSessionId('lead'), 'lead');
  assert.throws(() => optionalSessionId('bad id'), /invalid/);
});

test('visible-session lists reject on IPC and drop malformed entries on the service filter', () => {
  const stored = 'x'.repeat(257);
  assert.deepEqual(requiredSessionIds(['lead', ' lead ', 'agent']), ['lead', 'agent']);
  assert.throws(() => requiredSessionIds(['lead', 'bad id']), /invalid/);
  assert.throws(() => requiredSessionIds('lead'), /bounded array/);
  assert.throws(() => requiredSessionIds(Array(257).fill('lead')), /bounded array/);
  assert.deepEqual(filterSessionIds(['lead', 'bad id', '', ' lead ', stored, 0, false, 'agent', 'lead']), [
    'lead',
    stored,
    'agent',
  ]);
  assert.deepEqual(filterSessionIds(null), []);
  assert.equal(requiredVisibleSessionVersion(2), 2);
  assert.throws(() => requiredVisibleSessionVersion(0), /version/);
  assert.throws(() => requiredVisibleSessionVersion(1.5), /version/);
});

test('catalog and stored-id filters keep pattern-only ids longer than 256', () => {
  const stored = 'x'.repeat(257);
  const summaries = desktopSessionSummaries([
    {
      id: stored,
      cwd: 'C:\\Project\\mixdog',
      title: 'Stored long id',
      desktopSession: { classification: 'task', projectPath: null },
    },
    {
      id: 'bad id',
      cwd: 'C:\\Project\\mixdog',
      title: 'Rejected',
      desktopSession: { classification: 'task', projectPath: null },
    },
  ]);
  assert.deepEqual(
    summaries.map((row) => row.id),
    [stored]
  );
});
