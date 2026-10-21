import assert from 'node:assert/strict';
import test from 'node:test';

async function runAutoClear(command, status) {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const calls = [];
  const notices = [];
  const run = createSlashExecutor({
    sessionId: 'session-1',
    turnBusy: false,
    provider: 'openai',
    model: 'gpt-6-sol',
    effort: 'high',
    fast: false,
    fastCapable: false,
    invokeResult: async (action) => await action(),
    invokeCapabilityResult: async (capability, args) => {
      calls.push([capability, args]);
      return { value: status };
    },
    applySnapshot() {},
    submit: async () => {},
    setAttachmentError() {},
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
  assert.equal(await run(command), true);
  return { calls, notices };
}

test('/autoclear shows the idle window as a human duration, not raw milliseconds', async () => {
  const minute = await runAutoClear('/autoclear 1m', { enabled: true, idleMs: 60_000, label: '1m' });
  assert.deepEqual(minute.calls, [['setAutoClear', [{ duration: '1m' }]]]);
  assert.deepEqual(minute.notices, ['Auto-clear on · idle 1m']);
  const hour = await runAutoClear('/autoclear status', { enabled: true, idleMs: 3_600_000, label: '1h' });
  assert.deepEqual(hour.notices, ['Auto-clear on · idle 1h']);
});

test('/autoclear unlimited and never go to the runtime and read back as unlimited', async () => {
  for (const word of ['unlimited', 'never']) {
    const { calls, notices } = await runAutoClear(`/autoclear ${word}`, {
      enabled: true,
      idleMs: 0,
      unlimited: true,
      label: 'unlimited',
    });
    assert.deepEqual(calls, [['setAutoClear', [{ duration: word }]]]);
    assert.deepEqual(notices, ['Auto-clear on · unlimited']);
  }
});
