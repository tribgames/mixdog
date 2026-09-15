import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopSessionSummaries } from './desktop-state';

test('the session catalog follows execution cwd instead of a stale project label', () => {
  const rows = [
    { id: 'changed', cwd: 'C:\\Project\\GamerScroll', desktopSession: { classification: 'project', projectPath: 'C:\\Project\\ProjectAA' } },
    { id: 'other', cwd: 'C:\\Project\\mixdog', desktopSession: { classification: 'project', projectPath: 'C:\\Project\\mixdog' } },
    { id: 'task', cwd: 'C:\\workspace\\unclassified', desktopSession: { classification: 'task', projectPath: null } },
  ];
  const summaries = desktopSessionSummaries(rows.map((row) => ({ ...row, title: `Conversation ${row.id}` })));
  assert.equal(summaries.find((row) => row.id === 'changed').projectPath, 'C:\\Project\\GamerScroll');
  assert.equal(summaries.find((row) => row.id === 'other').projectPath, 'C:\\Project\\mixdog');
  assert.equal(summaries.find((row) => row.id === 'task').projectPath, null);
});
