import assert from 'node:assert/strict';
import test from 'node:test';
import { submitProviderPrompt } from './provider-prompts.mjs';

function submit(prompt, value) {
  const calls = [];
  const ctx = {
    state: { commandBusy: false },
    store: { pushNotice: () => {} },
    serviceCall: async (...args) => calls.push(args),
    clearModelCaches: () => {},
    openPanel: () => {},
    providerWrite: { inFlight: () => false, begin: () => 1, finish: (_t, fn) => fn(), fail: () => {} },
  };
  submitProviderPrompt(ctx, { kind: 'api-key', afterSave: () => {}, ...prompt }, value);
  return calls;
}

test('express-mode Vertex key saves with authMode api-key; other saves send no options', () => {
  assert.deepEqual(submit({ providerId: 'vertex-ai', authMode: 'api-key' }, 'AQ.key'), [
    ['saveProviderApiKey', 'vertex-ai', 'AQ.key', { authMode: 'api-key' }],
  ]);
  assert.deepEqual(submit({ providerId: 'vertex-ai' }, '{}'), [['saveProviderApiKey', 'vertex-ai', '{}']]);
});
