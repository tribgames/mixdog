import assert from 'node:assert/strict';
import test from 'node:test';

test('/model counts as a model choice only when it picks a different model', async () => {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const previousWindow = globalThis.window;
  globalThis.window = {
    mixdogDesktop: {
      listProviderModels: async () => [
        { provider: 'openai', model: 'gpt-6-sol', display: 'Sol' },
        { provider: 'openai', model: 'gpt-6-astra', display: 'Astra' },
      ],
      setModelRoute: async (selection) => ({ ...selection }),
    },
  };
  try {
    const applied = [];
    const run = createSlashExecutor({
      sessionId: 'session-1',
      turnBusy: false,
      provider: 'openai',
      model: 'gpt-6-sol',
      effort: 'high',
      fast: false,
      fastCapable: false,
      onRoutePreferenceApplied: (selection, options) => applied.push([selection.model, options?.modelChoice === true]),
      invokeResult: async (action) => await action(),
      invokeCapabilityResult: async () => ({ value: [] }),
      applySnapshot() {},
      submit: async () => {},
      setAttachmentError() {},
      clearNotice() {},
      showNotice() {},
      openGoalDialog() {},
      onNewTask() {},
      onResumeSession() {},
      onOpenSessions() {},
      onOpenProjects() {},
      onOpenSettings() {},
      onOpenCommandSurface() {},
    });
    await run('/model gpt-6-sol');
    await run('/model gpt-6-astra');
    assert.deepEqual(applied, [
      ['gpt-6-sol', false],
      ['gpt-6-astra', true],
    ]);
  } finally {
    globalThis.window = previousWindow;
  }
});
