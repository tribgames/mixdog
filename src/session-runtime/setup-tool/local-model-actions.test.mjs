import assert from 'node:assert/strict';
import test from 'node:test';
import { createSetupToolExecutor } from './executor.mjs';

test('HF discovery, consent and maintenance route to their explicit runtime operations', async () => {
  const calls = [];
  const facade = Object.fromEntries([
    'searchLocalProviderModels', 'inspectHuggingFaceModel', 'registerHuggingFaceModel',
    'getLocalProviderModelDetails', 'startLocalProviderModelMaintenance', 'deleteLocalProviderModel',
  ].map((name) => [name, async (...args) => { calls.push([name, args]); return { ok: true }; }]));
  const executor = createSetupToolExecutor({ getApi: () => facade });
  const run = (args) => executor.execute(args);
  await run({ action: 'search_local_models', query: 'coding gguf' });
  await run({ action: 'inspect_hf_model', repository: 'publisher/model', filename: 'model.gguf', contextWindow: 8192 });
  await run({ action: 'register_hf_model', previewId: 'inspected', licenseAccepted: true });
  await run({ action: 'local_model_details', modelId: 'registered' });
  await run({ action: 'maintain_local_model', modelId: 'registered', operation: 'repair' });
  await run({ action: 'delete_local_model', confirmationToken: 'confirmed' });
  assert.deepEqual(calls, [
    ['searchLocalProviderModels', ['coding gguf']],
    ['inspectHuggingFaceModel', [{ repository: 'publisher/model', filename: 'model.gguf', contextWindow: 8192 }]],
    ['registerHuggingFaceModel', ['inspected', true]],
    ['getLocalProviderModelDetails', ['registered']],
    ['startLocalProviderModelMaintenance', ['registered', 'repair']],
    ['deleteLocalProviderModel', ['confirmed']],
  ]);
  await assert.rejects(run({ action: 'register_hf_model', previewId: 'x' }), /licenseAccepted/);
  await assert.rejects(run({ action: 'maintain_local_model', modelId: 'registered', operation: 'execute' }), /operation/);
});
