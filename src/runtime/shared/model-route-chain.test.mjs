import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRouteChain, routeChain } from './model-route-chain.mjs';

const leaf = (route, previous = {}) => {
  const value = { ...previous, ...route };
  return value.provider && value.model ? value : null;
};

test('ordered routes retain their own tuning and preserve omitted fallback edits', () => {
  const primary = { provider: 'openai', model: 'a', effort: 'high' };
  const second = { provider: 'anthropic', model: 'b', effort: 'low' };
  const chain = normalizeRouteChain({ ...primary, fallbacks: [second] }, (value) => {
    const { fallbacks, ...entry } = value;
    return leaf(entry);
  });
  assert.deepEqual(routeChain(chain), [primary, second]);
  assert.deepEqual(normalizeRouteChain(primary, leaf, chain), chain);
  assert.deepEqual(
    normalizeRouteChain(
      { ...primary, fallbacks: [] },
      (value) => {
        const { fallbacks, ...entry } = value;
        return leaf(entry);
      },
      chain
    ),
    primary
  );
});

test('canonical providers must be unique but API and OAuth remain distinct', () => {
  assert.throws(
    () =>
      normalizeRouteChain(
        {
          provider: 'openai',
          model: 'a',
          fallbacks: [{ provider: 'openai-api', model: 'b' }],
        },
        leaf
      ),
    /duplicate route provider/
  );
  assert.equal(
    routeChain(
      normalizeRouteChain(
        {
          provider: 'openai',
          model: 'a',
          fallbacks: [{ provider: 'openai-oauth', model: 'b' }],
        },
        leaf
      )
    ).length,
    2
  );
});

test('malformed, nested and inherited fallback rows are rejected', () => {
  assert.throws(
    () =>
      normalizeRouteChain(
        {
          provider: 'openai',
          model: 'a',
          fallbacks: null,
        },
        leaf
      ),
    /must be an array/
  );
  assert.throws(() => routeChain({ fallbacks: {} }), /must be an array/);
  assert.throws(() => routeChain({ fallbacks: [{ fallbacks: [] }] }), /leaf route/);
  assert.throws(
    () =>
      normalizeRouteChain(
        {
          provider: 'openai',
          model: 'a',
          fallbacks: [{ provider: 'default', model: 'default' }],
        },
        leaf
      ),
    /only allowed/
  );
});
