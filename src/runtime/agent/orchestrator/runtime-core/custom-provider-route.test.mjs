import assert from 'node:assert/strict';
import test from 'node:test';
import { makeResolveDefaultProvider, makeResolveRoute } from './config-helpers.mjs';

test('default provider validation receives the saved custom provider configuration', () => {
  const config = {
    default: 'main',
    presets: [{ id: 'main', provider: 'custom-test', model: 'm1' }],
    providers: { 'custom-test': { type: 'custom', enabled: true } },
  };
  const resolve = makeResolveDefaultProvider((id, current) => {
    assert.equal(current, config);
    return current.providers[id]?.type === 'custom';
  });
  assert.equal(resolve(config), 'custom-test');
  assert.equal(makeResolveRoute(resolve)(config, { model: 'm2' }).provider, 'custom-test');
});
