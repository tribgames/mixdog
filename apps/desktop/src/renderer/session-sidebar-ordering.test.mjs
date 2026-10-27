import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSessionOrdering, rowsOfIds } from './session-sidebar-ordering.ts';

const session = (index, extra = {}) => ({
  id: `s${String(index).padStart(5, '0')}`,
  title: `title ${index}`,
  classification: 'task',
  updatedAt: 1000 + index,
  ...extra,
});
const catalog = (count) => Array.from({ length: count }, (_, index) => session(index));
const project = (sessions, previous) => projectSessionOrdering(sessions, true, true, null, previous);
const idsOf = (projection) => projection.allIds;

test('a title-only change keeps the ordering projection and shows the new title', () => {
  const sessions = catalog(2000);
  const first = project(sessions);
  const changed = sessions.slice();
  changed[5] = { ...sessions[5], title: 'renamed' };
  const second = project(changed, first);
  assert.equal(second, first);
  assert.equal(second.allIds, first.allIds);
  assert.equal(second.activityIds, first.activityIds);
  assert.equal(second.favoriteIds, first.favoriteIds);
  const byId = new Map(changed.map((row) => [row.id, row]));
  assert.equal(rowsOfIds(second.allIds, byId).find((row) => row.id === sessions[5].id).title, 'renamed');
});

test('title-only timing (informational)', () => {
  const sessions = catalog(2000);
  const first = project(sessions);
  const changed = sessions.slice();
  changed[5] = { ...sessions[5], title: 'renamed' };
  const time = (run) => {
    const start = performance.now();
    for (let i = 0; i < 50; i += 1) run();
    return (performance.now() - start) / 50;
  };
  const full = time(() => project(changed));
  const kept = time(() => project(changed, first));
  console.log(`title-only 2000 rows: full rebuild ${full.toFixed(3)}ms, kept ${kept.toFixed(3)}ms`);
  assert.ok(kept < full);
});

test('ordering-relevant changes reorder', () => {
  const sessions = catalog(5);
  const first = project(sessions);
  assert.deepEqual(idsOf(first), ['s00004', 's00003', 's00002', 's00001', 's00000']);
  const next = (index, patch) => {
    const changed = sessions.slice();
    changed[index] = { ...sessions[index], ...patch };
    return project(changed, first);
  };
  const activity = next(0, { activityAt: 99999 });
  assert.notEqual(activity, first);
  assert.equal(idsOf(activity)[0], 's00000');
  const archived = next(4, { archived: true });
  assert.ok(!archived.activityIds.includes('s00004'));
  const pinned = next(2, { favorite: true });
  assert.deepEqual(pinned.favoriteIds, ['s00002']);
  assert.ok(!pinned.activityIds.includes('s00002'));
  const reclassified = next(3, { classification: 'chat' });
  assert.ok(!reclassified.allIds.includes('s00003'));
  const automation = next(1, { sourceType: 'schedule' });
  assert.ok(!automation.activityIds.includes('s00001'));
  const agent = next(1, { agentSession: true });
  assert.ok(agent.allIds.includes('s00001'));
  assert.ok(!projectSessionOrdering(agent.source, true, false, null).allIds.includes('s00001'));
});
