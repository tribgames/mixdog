import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearProviderCatalogFailures,
  recordProviderCatalogOutcome,
} from '../../runtime/agent/orchestrator/providers/catalog-failures.mjs';
import { withCatalogErrors } from './setup.mjs';

test('a provider whose model list failed carries its reason on its setup row; the cached setup is untouched', () => {
  clearProviderCatalogFailures();
  const setup = {
    api: [
      { id: 'deepseek', name: 'DeepSeek API', authenticated: true },
      { id: 'openai', name: 'OpenAI', authenticated: true },
    ],
    oauth: [{ id: 'openai-oauth', authenticated: true }],
    local: [],
  };
  recordProviderCatalogOutcome(
    'deepseek',
    Object.assign(new Error('deepseek models 401'), {
      status: 401,
      providerError: { message: 'This API key has expired.' },
    })
  );
  const overlaid = withCatalogErrors(setup);
  assert.equal(overlaid.api[0].catalogError.message, 'deepseek models 401: This API key has expired.');
  assert.equal(overlaid.api[0].catalogError.errorKind.kind, 'auth');
  assert.equal('catalogError' in overlaid.api[1], false);
  assert.equal('catalogError' in overlaid.oauth[0], false);
  assert.equal('catalogError' in setup.api[0], false);
  recordProviderCatalogOutcome('deepseek', null);
  assert.equal('catalogError' in withCatalogErrors(setup).api[0], false);
});
