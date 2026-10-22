import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedProviderModels } from './desktop-support.ts';

test('a custom provider name survives row normalization', () => {
  const [named, plain] = normalizedProviderModels([
    { provider: 'custom-a', id: 'm', providerName: ' Gateway ' },
    { provider: 'custom-b', id: 'm' },
  ]);
  assert.equal(named.providerName, 'Gateway');
  assert.equal('providerName' in plain, false);
});

test('partial catalog state survives row normalization; complete rows carry none', () => {
  const [partial] = normalizedProviderModels([
    { provider: 'p', id: 'm', catalogPartial: true, catalogMissing: ['offline'], catalogRetryAt: 123 },
  ]);
  assert.equal(partial.catalogPartial, true);
  assert.deepEqual(partial.catalogMissing, ['offline']);
  assert.equal(partial.catalogRetryAt, 123);
  const [complete] = normalizedProviderModels([{ provider: 'p', id: 'm' }]);
  assert.equal('catalogPartial' in complete || 'catalogMissing' in complete || 'catalogRetryAt' in complete, false);
});
