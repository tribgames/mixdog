import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('../internal-agents.mjs', {
  namedExports: {
    getHiddenAgent: (agent) => {
      if (agent === 'one-shot') return { kind: 'maintenance', toolSchemaProfile: 'none' };
      if (agent === 'hidden-tool') return { kind: 'maintenance', toolSchemaProfile: 'full' };
      return null;
    },
  },
});

const { resolveCacheStrategy, resolveProviderPromptCacheLane } = await import('./cache-strategy.mjs');

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('cache tiers distinguish one-shot, other agents, and Lead idle policy', (t) => {
  setEnv(t, 'MIXDOG_CACHE_MESSAGES_TTL', undefined);
  assert.deepEqual(resolveCacheStrategy('one-shot'), {
    tools: 'none',
    system: 'none',
    tier3: 'none',
    messages: 'none',
  });
  for (const agent of ['hidden-tool', 'worker']) {
    assert.deepEqual(resolveCacheStrategy(agent, { autoClear: { idleMs: 1 } }), {
      tools: 'none',
      system: '1h',
      tier3: '1h',
      messages: '1h',
    });
  }
  for (const agent of ['lead', '', null, undefined]) {
    assert.deepEqual(resolveCacheStrategy(agent, { autoClear: { idleMs: 1 } }), {
      tools: 'none',
      system: '1h',
      tier3: '1h',
      messages: '5m',
    });
    assert.equal(resolveCacheStrategy(agent, { autoClear: { enabled: false } }).messages, '1h');
    assert.equal(resolveCacheStrategy(agent, { autoClear: { idleMs: 3_600_000 } }).messages, '1h');
  }
});

test('message TTL overrides apply to reusable sessions but never to one-shot roles', (t) => {
  setEnv(t, 'MIXDOG_CACHE_MESSAGES_TTL', undefined);
  for (const ttl of ['1h', '5m', 'none']) {
    process.env.MIXDOG_CACHE_MESSAGES_TTL = ` ${ttl} `;
    for (const agent of ['worker', 'hidden-tool', 'lead']) {
      assert.equal(resolveCacheStrategy(agent).messages, ttl);
    }
    assert.equal(resolveCacheStrategy('one-shot').messages, 'none');
  }
  process.env.MIXDOG_CACHE_MESSAGES_TTL = 'invalid';
  assert.equal(resolveCacheStrategy('worker').messages, '1h');
  assert.equal(resolveCacheStrategy('lead').messages, '5m');
});

test('cache lanes default to one shard and preserve explicit and legacy overrides', (t) => {
  for (const name of [
    'MIXDOG_TEST_CACHE_CACHE_LANE_SHARDS',
    'MIXDOG_TEST_CACHE_CACHE_MAX_PARALLEL',
    'MIXDOG_OPENAI_CACHE_LANE_SHARDS',
    'MIXDOG_OPENAI_CACHE_MAX_PARALLEL',
  ]) {
    setEnv(t, name, undefined);
  }
  for (const raw of [undefined, null, '']) {
    const lane = resolveProviderPromptCacheLane('test-cache', { promptCacheLaneShards: raw, sessionId: 'fixed' });
    assert.equal(lane.enabled, false);
    assert.equal(lane.auto, false);
    assert.equal(lane.shards, 1);
    assert.equal(lane.slot, 0);
  }
  const explicit = resolveProviderPromptCacheLane('test-cache', {
    promptCacheLaneShards: 3,
    promptCacheLaneMaxParallel: 8,
    promptCacheLaneSlot: 5,
  });
  assert.equal(explicit.shards, 3);
  assert.equal(explicit.slot, 2);
  const legacy = resolveProviderPromptCacheLane('test-cache', { promptCacheLaneMaxParallel: 4 });
  assert.equal(legacy.shards, 4);
  const ignored = resolveProviderPromptCacheLane('test-cache', {
    promptCacheLaneMaxParallel: 4,
    promptCacheLaneIgnoreAliases: true,
  });
  assert.equal(ignored.shards, 1);
  const auto = resolveProviderPromptCacheLane('test-cache', {
    promptCacheLaneShards: 'auto',
    promptCacheLaneSlot: 5,
  });
  assert.equal(auto.enabled, true);
  assert.equal(auto.auto, true);
  assert.equal(auto.shards, 0);
  assert.equal(auto.slot, 5);
});
