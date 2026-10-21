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

const {
  buildStableProviderPromptCacheKey,
  isLeadCacheClass,
  providerTailCacheLifetimeMs,
  resolveCacheStrategy,
  resolveOpenAiPrefixCacheTtl,
  resolveProviderPromptCacheLane,
  roleProviderCacheOpts,
  sessionTailCacheExpired,
} = await import('./cache-strategy.mjs');
const { xaiCacheRouting, xaiResponsesCacheRouting } = await import('../providers/openai-compat-xai.mjs');

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
    system: '1h',
    tier3: '1h',
    messages: 'none',
  });
  for (const agent of ['hidden-tool', 'worker']) {
    assert.deepEqual(resolveCacheStrategy(agent, { autoClear: { idleMs: 3_600_000 } }), {
      tools: 'none',
      system: '1h',
      tier3: '1h',
      messages: '5m',
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

test('bot home threads and bot task sessions are Lead class; spawned sub-agents are agent class', (t) => {
  setEnv(t, 'MIXDOG_CACHE_MESSAGES_TTL', undefined);
  const autoClear = { idleMs: 3_600_000 };
  const home = { id: 'sess_home_pm', agent: 'pm', owner: 'cli' };
  const mixyHome = { id: 'sess_home_lead', agent: 'lead', owner: 'cli' };
  const routineRun = { id: 'sess_daemon_r1', agent: 'pm', ownerAgentId: 'pm' };
  const botTask = { id: 'sess_desktop_t1', agent: 'lead', owner: 'cli', taskOrigin: { agentId: 'pm' } };
  const coding = { id: 'sess_desktop_c1', agent: 'lead', owner: 'cli' };
  const worker = { id: 'sess_daemon_w1', agent: 'worker', owner: 'agent', parentSessionId: 'sess_home_pm' };
  const botWorker = { id: 'sess_daemon_w2', agent: 'pm', owner: 'agent', parentSessionId: 'sess_desktop_t1' };
  const lead = (session) => [session.agent, { autoClear, session }];
  for (const session of [home, mixyHome, routineRun, botTask, coding]) {
    assert.equal(isLeadCacheClass(session.agent, session), true, session.id);
    assert.equal(roleProviderCacheOpts('anthropic', ...lead(session)).cacheStrategy.messages, '1h', session.id);
    assert.deepEqual(roleProviderCacheOpts('openai', ...lead(session)), { promptCachePrefixTtl: '12h' }, session.id);
    assert.equal(roleProviderCacheOpts('openai-oauth', ...lead(session)), null, session.id);
    assert.equal(resolveOpenAiPrefixCacheTtl(session.agent, session), '12h', session.id);
  }
  for (const session of [worker, botWorker]) {
    assert.equal(isLeadCacheClass(session.agent, session), false, session.id);
    assert.equal(roleProviderCacheOpts('anthropic', ...lead(session)).cacheStrategy.messages, '5m', session.id);
    assert.equal(roleProviderCacheOpts('openai', ...lead(session)), null, session.id);
    assert.equal(roleProviderCacheOpts('openai-oauth', ...lead(session)), null, session.id);
  }
  // Without a session record a non-lead agent id stays agent class.
  assert.equal(resolveCacheStrategy('pm', { autoClear }).messages, '5m');
  assert.equal(resolveCacheStrategy('pm', { autoClear, session: home }).messages, '1h');
  assert.equal(isLeadCacheClass('hidden-tool', mixyHome), false, 'hidden roles never take the Lead class');
});

test('tail cache lifetime is provider-scoped: permanent on openai-oauth, 30m on openai', () => {
  assert.equal(providerTailCacheLifetimeMs('openai-oauth', { messages: '5m' }), null);
  assert.equal(providerTailCacheLifetimeMs('openai'), 30 * 60_000);
  assert.equal(providerTailCacheLifetimeMs('anthropic-oauth', { messages: '1h' }), 60 * 60_000);
  assert.equal(providerTailCacheLifetimeMs('anthropic', { messages: '5m' }), 5 * 60_000);
  assert.equal(providerTailCacheLifetimeMs('anthropic', { messages: 'none' }), null);
  for (const provider of ['gemini', 'xai', 'grok-oauth', 'deepseek']) {
    assert.equal(providerTailCacheLifetimeMs(provider), null, provider);
  }
  const now = 10 * 3600_000;
  const idle = (provider, minutes, messages = '5m') => ({
    provider,
    lastProviderSendAt: now - minutes * 60_000,
    providerCacheOpts: { cacheStrategy: { messages } },
  });
  assert.equal(sessionTailCacheExpired(idle('openai-oauth', 600), now), false, 'never expires');
  assert.equal(sessionTailCacheExpired(idle('openai', 29), now), false);
  assert.equal(sessionTailCacheExpired(idle('openai', 31), now), true);
  assert.equal(sessionTailCacheExpired(idle('anthropic', 6), now), true);
  assert.equal(sessionTailCacheExpired(idle('anthropic', 6, '1h'), now), false);
});

test('one-shot roles share one prompt-cache lane per prefix on every key-prefix provider', (t) => {
  setEnv(t, 'MIXDOG_OAI_CACHE_KEY_SHARED', undefined);
  setEnv(t, 'MIXDOG_OAI_CODEX_THREAD_CACHE_KEY', undefined);
  setEnv(t, 'MIXDOG_XAI_RESPONSES_CACHE_SCOPE', undefined);
  assert.deepEqual(roleProviderCacheOpts('grok-oauth', 'one-shot'), { promptCacheScope: 'shared' });
  assert.equal(roleProviderCacheOpts('openai-oauth', 'worker'), null);
  assert.deepEqual(roleProviderCacheOpts('anthropic-oauth', 'one-shot'), {
    cacheStrategy: { tools: 'none', system: '1h', tier3: '1h', messages: 'none' },
    promptCacheScope: 'shared',
  });

  const prefix = { model: 'm', instructions: 'role rules', tools: [] };
  const call = (sessionId, scope) => ({ sessionId, ...(scope ? { promptCacheScope: scope } : {}) });
  for (const provider of ['openai', 'openai-oauth']) {
    const sharedA = buildStableProviderPromptCacheKey(provider, call('sess_a', 'shared'), prefix);
    assert.equal(buildStableProviderPromptCacheKey(provider, call('sess_b', 'shared'), prefix), sharedA);
    assert.notEqual(
      buildStableProviderPromptCacheKey(provider, call('sess_b', 'shared'), { ...prefix, instructions: 'other' }),
      sharedA
    );
    assert.notEqual(
      buildStableProviderPromptCacheKey(provider, call('sess_a'), prefix),
      buildStableProviderPromptCacheKey(provider, call('sess_b'), prefix)
    );
  }

  const params = { messages: [{ role: 'system', content: 'role rules' }] };
  for (const route of [xaiCacheRouting, xaiResponsesCacheRouting]) {
    const sharedA = route(call('sess_a', 'shared'), params, [], 'grok');
    assert.equal(sharedA.mode, 'prefix');
    assert.equal(route(call('sess_b', 'shared'), params, [], 'grok').key, sharedA.key);
    assert.notEqual(route(call('sess_a'), params, [], 'grok').key, route(call('sess_b'), params, [], 'grok').key);
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
  assert.equal(resolveCacheStrategy('worker').messages, '5m');
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
