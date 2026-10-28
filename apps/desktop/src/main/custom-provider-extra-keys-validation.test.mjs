import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_MAX_EXTRA_API_KEYS, requiredCustomProviderInput } from './ipc-validation.ts';

const base = { name: 'Local', protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1', models: [{ id: 'm' }] };
const KEY_ID = '0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10';

test('custom provider additional API keys are shape-checked like the setup service', async () => {
  const { MAX_ACCOUNTS } = await import('../../../../src/runtime/shared/provider-accounts.mjs');
  // The primary key and its additional keys make the roster's MAX_ACCOUNTS.
  assert.equal(CUSTOM_MAX_EXTRA_API_KEYS, MAX_ACCOUNTS - 1);
  for (const extraApiKeys of [
    [],
    [{ apiKey: 'k' }],
    [{ id: KEY_ID }],
    [{ id: KEY_ID, apiKey: '' }],
    Array.from({ length: CUSTOM_MAX_EXTRA_API_KEYS }, () => ({ apiKey: 'k' })),
  ]) {
    assert.doesNotThrow(() => requiredCustomProviderInput({ ...base, extraApiKeys }), JSON.stringify(extraApiKeys));
  }
  for (const extraApiKeys of [
    'k',
    [null],
    [{ apiKey: '' }],
    [{ apiKey: ' ' }],
    [{ apiKey: 5 }],
    [{ apiKey: 'k'.repeat(65_537) }],
    [{ id: 'custom-x' }],
    [{ id: KEY_ID }, { id: KEY_ID }],
    [{ apiKey: 'k', label: 'x' }],
    Array.from({ length: CUSTOM_MAX_EXTRA_API_KEYS + 1 }, () => ({ apiKey: 'k' })),
  ]) {
    assert.throws(
      () => requiredCustomProviderInput({ ...base, extraApiKeys }),
      TypeError,
      JSON.stringify(extraApiKeys).slice(0, 60)
    );
  }
});
