import assert from 'node:assert/strict';
import test from 'node:test';

const JOBS = [
  { taskId: 'job_a', command: 'npm run dev' },
  { taskId: 'job_b', command: 'tail -f log' },
];

async function runStop({ jobs = JOBS, answer = true, stopResult = { stopped: 2, stopping: 0 }, draftMode = false } = {}) {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const { overrideConfirmAction } = await import('./app-confirm.tsx');
  const calls = [];
  const notices = [];
  const errors = [];
  const confirms = [];
  overrideConfirmAction((message, options) => {
    confirms.push({ message, options });
    return answer;
  });
  try {
    const run = createSlashExecutor({
      sessionId: 'session-1',
      draftMode,
      turnBusy: true,
      provider: 'openai',
      model: 'gpt-6-sol',
      effort: 'high',
      fast: false,
      fastCapable: false,
      invokeResult: async (action) => await action(),
      invokeCapabilityResult: async (capability, args) => {
        calls.push([capability, args]);
        return { value: capability === 'listStoppableShellJobs' ? { jobs } : stopResult };
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
    const accepted = await run('/stop');
    return { accepted, calls, notices, errors, confirms };
  } finally {
    overrideConfirmAction(null);
  }
}

test('/stop with nothing running says so and asks nothing', async () => {
  const { accepted, calls, notices, confirms } = await runStop({ jobs: [] });
  assert.equal(accepted, true);
  assert.deepEqual(calls, [['listStoppableShellJobs', []]]);
  assert.deepEqual(notices, ['No background shells are running.']);
  assert.deepEqual(confirms, []);
});

test('/stop confirms once with the commands, then stops them all, even during a turn', async () => {
  const { accepted, calls, notices, confirms } = await runStop();
  assert.equal(accepted, true);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /^Stop background shells \(2\)\?\n• npm run dev\n• tail -f log$/);
  assert.equal(confirms[0].options.danger, true);
  assert.deepEqual(calls, [
    ['listStoppableShellJobs', []],
    ['stopShellJobs', []],
  ]);
  assert.deepEqual(notices, ['Stopped background shells: 2']);
});

test('cancelling the /stop confirmation stops nothing', async () => {
  const { accepted, calls, notices } = await runStop({ answer: false });
  assert.equal(accepted, true);
  assert.deepEqual(calls, [['listStoppableShellJobs', []]]);
  assert.deepEqual(notices, []);
});

test('/stop reports shells that are still stopping', async () => {
  const { notices } = await runStop({ stopResult: { stopped: 1, stopping: 1 } });
  assert.deepEqual(notices, ['Stopped background shells: 1 · still stopping: 1']);
});

test('/stop in a draft pane has no session to act on', async () => {
  const { accepted, calls, errors } = await runStop({ draftMode: true });
  assert.equal(accepted, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, ['Start the task with a message before running this command.']);
});
