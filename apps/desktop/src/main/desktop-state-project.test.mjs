import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopSessionSummaries } from './desktop-state';

test('an agent home holding only routine results stays in the catalog with its last line', () => {
  const base = {
    cwd: 'C:\\workspace\\unclassified',
    desktopSession: { classification: 'task', projectPath: null },
    title: '',
    preview: '',
    realTurnCount: 0,
    lastUsedAt: 7,
    lastMessagePreview: '⏱ Schedule · nightly — ok',
  };
  const summaries = desktopSessionSummaries([
    { ...base, id: 'sess_home_lead', messageCount: 1 },
    { ...base, id: 'sess_home_empty', messageCount: 0 },
    { ...base, id: 'sess_scratch', messageCount: 1 },
  ]);
  assert.deepEqual(
    summaries.map((row) => row.id),
    ['sess_home_lead']
  );
  assert.equal(summaries[0].agentHome, 'lead');
  assert.equal(summaries[0].messageCount, 1);
  assert.equal(summaries[0].activityAt, 7);
  assert.equal(summaries[0].lastMessagePreview, '⏱ Schedule · nightly — ok');
});

test('the session catalog follows execution cwd instead of a stale project label', () => {
  const rows = [
    {
      id: 'changed',
      cwd: 'C:\\Project\\GamerScroll',
      desktopSession: { classification: 'project', projectPath: 'C:\\Project\\ProjectAA' },
    },
    {
      id: 'other',
      cwd: 'C:\\Project\\mixdog',
      desktopSession: { classification: 'project', projectPath: 'C:\\Project\\mixdog' },
    },
    { id: 'task', cwd: 'C:\\workspace\\unclassified', desktopSession: { classification: 'task', projectPath: null } },
  ];
  const summaries = desktopSessionSummaries(rows.map((row) => ({ ...row, title: `Conversation ${row.id}` })));
  assert.equal(summaries.find((row) => row.id === 'changed').projectPath, 'C:\\Project\\GamerScroll');
  assert.equal(summaries.find((row) => row.id === 'other').projectPath, 'C:\\Project\\mixdog');
  assert.equal(summaries.find((row) => row.id === 'task').projectPath, null);
});

test('a forked session carries its source id and creation time; older rows omit them', () => {
  const summaries = desktopSessionSummaries([
    { id: 'orig', title: 'Orig', cwd: '', desktopSession: { classification: 'task', projectPath: null } },
    {
      id: 'fork',
      title: 'Orig',
      cwd: '',
      createdAt: 123,
      inheritedFromSessionId: 'orig',
      desktopSession: { classification: 'task', projectPath: null },
    },
  ]);
  const fork = summaries.find((row) => row.id === 'fork');
  assert.equal(fork.inheritedFromSessionId, 'orig');
  assert.equal(fork.createdAt, 123);
  const original = summaries.find((row) => row.id === 'orig');
  assert.equal('inheritedFromSessionId' in original, false);
  assert.equal('createdAt' in original, false);
});

test('a worktree-bound session stays grouped under its registered project', () => {
  const summaries = desktopSessionSummaries([
    {
      id: 'worktree',
      title: 'Conversation worktree',
      cwd: 'C:\\data\\worktrees-v1\\0123456789abcdef\\fix-login',
      desktopSession: { classification: 'project', projectPath: 'C:\\Project\\mixdog' },
      workspace: {
        projectPath: 'C:\\Project\\mixdog',
        cwd: 'C:\\data\\worktrees-v1\\0123456789abcdef\\fix-login',
        branch: 'mixdog/fix-login',
        worktreeId: 'fix-login',
      },
    },
  ]);
  assert.equal(summaries[0].projectPath, 'C:\\Project\\mixdog');
  assert.equal(summaries[0].cwd, 'C:\\data\\worktrees-v1\\0123456789abcdef\\fix-login');
  assert.equal(summaries[0].classification, 'project');
});

test('synthetic-only, resume-scratch and legacy rows are told apart by durable provenance when no title survives', () => {
  const desktopSession = { classification: 'project', projectPath: 'C:\\Project\\mixdog' };
  const base = { cwd: 'C:\\Project\\mixdog', desktopSession, title: '', preview: '', messageCount: 4 };
  const summaries = desktopSessionSummaries([
    { ...base, id: 'synthetic', realTurnCount: 0 },
    { ...base, id: 'scratch', realTurnCount: 2, detachedReason: 'cli-resume' },
    { ...base, id: 'compacted', realTurnCount: 1 },
    { ...base, id: 'legacy' },
  ]);
  assert.deepEqual(summaries.map((row) => row.id).sort(), ['compacted', 'legacy']);
});

test('a transcript of only a [truncated] marker and an interrupted assistant row stays hidden end to end', async () => {
  const { _sessionSummary } = await import(
    '../../../../src/runtime/agent/orchestrator/session/store-summary-index.mjs'
  );
  const { listLeadSessions } = await import('../../../../src/session-runtime/lifecycle/session-catalog.mjs');
  const stored = {
    id: 'sess_truncated_only',
    cwd: 'C:\\Project\\mixdog',
    updatedAt: 1000,
    desktopSession: { classification: 'project', projectPath: 'C:\\Project\\mixdog' },
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: '[truncated]', meta: { synthetic: true } },
      { role: 'assistant', content: '[request interrupted by user]' },
    ],
  };
  const summary = _sessionSummary(stored);
  assert.equal(summary.realTurnCount, 0);
  assert.equal(summary.messageCount, 2);
  const rows = listLeadSessions({ listSessions: () => [summary] });
  assert.equal(rows.length, 1);
  assert.deepEqual(desktopSessionSummaries(rows), []);
  // The same shape with one real human turn is kept.
  stored.messages.push({ role: 'user', content: 'Fix the login bug' });
  const real = listLeadSessions({ listSessions: () => [{ ..._sessionSummary(stored), preview: '' }] });
  assert.equal(desktopSessionSummaries(real).length, 1);
});

test('a compacted project session with no surviving title source stays in the catalog; abandoned and internal rows stay hidden', () => {
  const desktopSession = { classification: 'project', projectPath: 'C:\\Project\\mixdog' };
  const base = { cwd: 'C:\\Project\\mixdog', desktopSession, title: '', preview: '' };
  const summaries = desktopSessionSummaries([
    { ...base, id: 'compacted', messageCount: 3 },
    { ...base, id: 'empty', messageCount: 0 },
    { ...base, id: 'internal', messageCount: 1, preview: '[mixdog-runtime] resume' },
  ]);
  assert.deepEqual(
    summaries.map((row) => row.id),
    ['compacted']
  );
  assert.equal(summaries[0].title, 'Untitled session');
  assert.equal(summaries[0].projectPath, 'C:\\Project\\mixdog');
  assert.equal(summaries[0].classification, 'project');
});
