// A core connection's sidebar rows are classified as Node's are: a stored classification is kept, a row the core sends with
// none (`classification: {}`) falls back to its folder (`desktopSessionSummaries`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopSessionSummaries } from '../desktop-state.ts';
import { summariesOfThreadRows } from './thread-rows.ts';

const row = (id, extra) => ({
  id,
  title: 'Titled',
  preview: 'hello',
  messageCount: 2,
  updatedAt: 10,
  classification: {},
  projectPath: null,
  ...extra,
});

test('a stored classification of a core row is kept', () => {
  const [task, project] = summariesOfThreadRows([
    row('t_task', { cwd: 'C:\\Repo', classification: 'task' }),
    row('t_project', { cwd: 'C:\\Repo', classification: 'project', projectPath: 'C:\\Repo' }),
  ]);
  assert.equal(task.classification, 'task');
  assert.equal(task.projectPath, null);
  assert.equal(project.classification, 'project');
  assert.equal(project.projectPath, 'C:\\Repo');
});

test("an agent's worker session keeps the mark the sidebar hides it by, as Node's stored row gives it", () => {
  const [lead, worker] = summariesOfThreadRows([
    row('t_lead', { cwd: 'C:\\Repo', classification: 'project', projectPath: 'C:\\Repo' }),
    row('t_worker', { cwd: 'C:\\Repo', classification: 'project', projectPath: 'C:\\Repo', agentSession: true }),
  ]);
  // The same two as Node's listing holds them: the worker is `agent-only`.
  const node = desktopSessionSummaries([
    { ...row('t_lead', { cwd: 'C:\\Repo' }), classification: undefined, owner: 'cli', agent: 'lead', visibility: 'ordinary' },
    { ...row('t_worker', { cwd: 'C:\\Repo' }), classification: undefined, owner: 'agent', agent: 'worker', visibility: 'agent-only' },
  ]);
  assert.deepEqual([lead.agentSession, worker.agentSession], [undefined, true]);
  assert.deepEqual([lead.agentSession, worker.agentSession], node.map((summary) => summary.agentSession));
});

test('a core row with no stored classification falls back to its folder, as a Node row does', () => {
  const folder = 'C:\\Users\\me\\AppData\\Roaming\\Mixdog\\workspace\\unclassified';
  const [inTasks, inProject] = summariesOfThreadRows(
    [row('t_a', { cwd: folder }), row('t_b', { cwd: 'C:\\Repo' })],
    {},
    {},
    folder
  );
  assert.equal(inTasks.classification, 'task');
  assert.equal(inProject.classification, 'project');
  assert.equal(inProject.projectPath, 'C:\\Repo');
  // The same rows as Node holds them (no `desktopSession`) classify identically.
  const held = (id, cwd) => ({ ...row(id, { cwd }), classification: undefined });
  const node = desktopSessionSummaries([held('t_a', folder), held('t_b', 'C:\\Repo')], {}, {}, folder);
  assert.deepEqual(
    [inTasks, inProject].map((summary) => [summary.classification, summary.projectPath]),
    node.map((summary) => [summary.classification, summary.projectPath])
  );
});
