import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createLeadReapTimers } from './reap-timers.mjs';

const MIN = 60_000;

test('a Lead row with a short provider reap window is kept for the full pane hour', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
  try {
    const removed = [];
    const timers = createLeadReapTimers({ removeRow: (id, reapAt) => removed.push([id, reapAt]) });
    const now = new Date(Date.now()).toISOString();
    const reapAt = new Date(Date.now() + 30 * MIN).toISOString();
    timers.schedule({ sessionId: 'lead-a', finishedAt: now, reapAt });
    mock.timers.tick(31 * MIN);
    assert.deepEqual(removed, [], 'the provider window ended but the pane still lists the Lead');
    mock.timers.tick(30 * MIN);
    assert.deepEqual(removed, [['lead-a', reapAt]]);
  } finally {
    mock.timers.reset();
  }
});

test('a Lead row whose provider reap window outlasts the pane hour keeps that window', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
  try {
    const removed = [];
    const timers = createLeadReapTimers({ removeRow: (id) => removed.push(id) });
    const now = new Date(Date.now()).toISOString();
    timers.schedule({ sessionId: 'lead-b', finishedAt: now, reapAt: new Date(Date.now() + 120 * MIN).toISOString() });
    mock.timers.tick(119 * MIN);
    assert.deepEqual(removed, []);
    mock.timers.tick(2 * MIN);
    assert.deepEqual(removed, ['lead-b']);
  } finally {
    mock.timers.reset();
  }
});
