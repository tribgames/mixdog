import assert from 'node:assert/strict';
import test from 'node:test';

async function runShells(command, { jobs = [], release = { released: true }, answer = true } = {}) {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const { overrideConfirmAction } = await import('./app-confirm.tsx');
  const calls = [];
  const notices = [];
  const errors = [];
  const confirms = [];
  overrideConfirmAction((message) => {
    confirms.push(message);
    return answer;
  });
  try {
    const run = createSlashExecutor({
      sessionId: 'session-1',
      draftMode: false,
      turnBusy: false,
      provider: 'openai',
      model: 'gpt-6-sol',
      effort: 'high',
      fast: false,
      fastCapable: false,
      invokeResult: async (action) => await action(),
      invokeCapabilityResult: async (capability, args) => {
        calls.push([capability, args]);
        return { value: capability === 'listShellJobs' ? { jobs } : release };
      },
      applySnapshot() {},
      submit: async () => {},
      setAttachmentError: (message) => message && errors.push(message),
      clearNotice() {},
      showNotice: (message) => notices.push(message),
      openGoalDialog() {},
      onNewTask() {},
      onResumeSession() {},
      onOpenSessions() {},
      onOpenProjects() {},
      onOpenSettings() {},
      onOpenCommandSurface() {},
    });
    const accepted = await run(command);
    return { accepted, calls, notices, errors, confirms };
  } finally {
    overrideConfirmAction(null);
  }
}

test('/shells lists shells and flags unconfirmed terminations', async () => {
  const jobs = [
    { taskId: 'job_a', command: 'npm run dev' },
    { taskId: 'job_b', command: 'tail -f log', terminationUnconfirmed: true },
  ];
  const { accepted, calls, notices } = await runShells('/shells', { jobs });
  assert.equal(accepted, true);
  assert.deepEqual(calls, [['listShellJobs', []]]);
  assert.equal(
    notices[0],
    'job_a  running  npm run dev\njob_b  termination unconfirmed  tail -f log\nRelease a held shell with /shells release <task_id>.'
  );
});

test('/shells with nothing running says so', async () => {
  const { notices } = await runShells('/shells');
  assert.deepEqual(notices, ['No shells are running.']);
});

test('/shells release confirms, then releases', async () => {
  const { accepted, calls, notices, confirms } = await runShells('/shells release job_b');
  assert.equal(accepted, true);
  assert.equal(confirms.length, 1);
  assert.deepEqual(calls, [['releaseShellJob', ['job_b']]]);
  assert.deepEqual(notices, ['Released job_b.']);
});

test('declining the /shells release confirmation releases nothing', async () => {
  const { calls } = await runShells('/shells release job_b', { answer: false });
  assert.deepEqual(calls, []);
});

test('/shells rejects an unknown action', async () => {
  const { accepted, calls, errors } = await runShells('/shells frob');
  assert.equal(accepted, false);
  assert.deepEqual(calls, []);
  assert.equal(errors.length, 1);
});
