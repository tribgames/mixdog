import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES } from '../shared/contract.ts';
import { requiredCustomProviderInput } from './ipc-validation.ts';

const valid = {
  name: 'Local',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  models: [{ id: 'm', name: 'M', contextWindow: 4096, maxOutputTokens: 512 }],
};

test('custom provider capabilities are exposed on the desktop surface', () => {
  for (const name of ['saveCustomProvider', 'removeCustomProvider', 'testCustomProvider', 'discoverCustomProviderModels']) {
    assert.equal(DESKTOP_CAPABILITIES.includes(name), true);
  }
});

test('custom provider input shape is validated', () => {
  assert.equal(requiredCustomProviderInput({ ...valid, id: 'custom-x', apiKey: '' }).name, 'Local');
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...valid, models: undefined }, true));
  assert.throws(() => requiredCustomProviderInput({ ...valid, models: undefined }), /models/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, protocol: 'grpc' }), /protocol/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, extra: 1 }), /unsupported/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, models: [{ id: 'm', contextWindow: -1 }] }), /contextWindow/);
  assert.throws(() => requiredCustomProviderInput([]), /invalid/);
});
