import assert from 'node:assert/strict';
import test from 'node:test';

const STALLED = { id: 'goal-old', objective: 'Verify the markets', status: 'duration_reached' };

async function runGoal({ answer = true, existing = STALLED } = {}) {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const { overrideConfirmAction } = await import('./app-confirm.tsx');
  const calls = [];
  const notices = [];
  const confirms = [];
  overrideConfirmAction((message, options) => {
    confirms.push({ message, options });
    return answer;
  });
  try {
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
        const [request] = args;
        if (existing && !request.replace) {
          return {
            value: { ok: false, action: 'create', code: 'goal-replace-required', goal: existing, message: 'exists' },
          };
        }
        return { value: { ok: true, action: 'create', goal: { id: 'goal-new' }, message: 'Goal active · New work' } };
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
    const accepted = await run('/goal New work --time 30m');
    return { accepted, calls, notices, confirms };
  } finally {
    overrideConfirmAction(null);
  }
}

test('/goal over a stalled Goal asks once, then sends the same command as a replacement', async () => {
  const { accepted, calls, notices, confirms } = await runGoal();
  assert.equal(accepted, true);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /^Replace the current goal\?\nVerify the markets \(Time budget reached\) will be replaced/);
  assert.equal(confirms[0].options.danger, true);
  assert.deepEqual(calls, [
    ['goalControl', [{ command: 'New work --time 30m' }]],
    ['goalControl', [{ command: 'New work --time 30m', replace: true, expectedGoalId: 'goal-old' }]],
  ]);
  assert.deepEqual(notices, ['Goal active · New work']);
});

test('declining the replacement keeps the stalled Goal and the draft', async () => {
  const { accepted, calls, notices } = await runGoal({ answer: false });
  assert.equal(accepted, false);
  assert.deepEqual(calls, [['goalControl', [{ command: 'New work --time 30m' }]]]);
  assert.deepEqual(notices, []);
});

test('/goal with no stalled Goal asks nothing', async () => {
  const { accepted, calls, confirms } = await runGoal({ existing: null });
  assert.equal(accepted, true);
  assert.deepEqual(confirms, []);
  assert.equal(calls.length, 1);
});

