import assert from 'node:assert/strict';
import test from 'node:test';
import { configChangeSnapshot, createConfigChangeEffects, diffConfigSnapshots } from './config-change-effects.mjs';

function recorder() {
  const calls = [];
  const effects = createConfigChangeEffects({
    invalidateContextStatusCache: () => calls.push('context'),
    reinitProviders: () => calls.push('providers'),
    releaseAdmissionCooldowns: () => calls.push('cooldowns'),
    reconcileMcp: () => calls.push('mcp'),
    announceSettingsChange: () => calls.push('announce'),
    noteCacheWarmingEnabled: (enabled) => calls.push(`warming:${enabled}`),
    refreshLiveSessionsCacheOpts: (config) => calls.push(`cacheOpts:${JSON.stringify(config.autoClear)}`),
    publishAgentRoute: (id, config) => calls.push(`route:${id}:${config.agents?.[id]?.model ?? 'main'}`),
  });
  return { calls, effects };
}

test('settings whose effect only the writer ran reach every runtime that applies the change', () => {
  const config = {
    providers: {},
    mcpServers: {},
    autoClear: { enabled: true },
    agents: { worker: { provider: 'p', model: 'm1' }, reviewer: { provider: 'p', model: 'r1' } },
  };
  const before = configChangeSnapshot({ config, root: { agent: config }, secretTokens: {} });
  const run = (next) => {
    const { calls, effects } = recorder();
    effects(diffConfigSnapshots(before, configChangeSnapshot({ config: next, root: { agent: next }, secretTokens: {} })), next);
    return calls.filter((call) => call !== 'context' && call !== 'announce');
  };
  assert.deepEqual(run({ ...config, promptCacheWarming: true }), ['warming:true']);
  assert.deepEqual(run({ ...config, autoClear: { enabled: true, idleMs: 60_000 } }), [
    'cacheOpts:{"enabled":true,"idleMs":60000}',
  ]);
  assert.deepEqual(run({ ...config, developer: { cursorOAuth: true } }), ['cooldowns', 'providers']);
  // One bot re-routed, one cleared (it follows Main again); the rest untouched.
  assert.deepEqual(run({ ...config, agents: { worker: { provider: 'p', model: 'm2' } } }), [
    'route:reviewer:main',
    'route:worker:m2',
  ]);
  const off = recorder();
  const on = configChangeSnapshot({ config: { ...config, promptCacheWarming: true }, root: {}, secretTokens: {} });
  off.effects(diffConfigSnapshots(on, configChangeSnapshot({ config, root: {}, secretTokens: {} })), config);
  assert.ok(off.calls.includes('warming:false'), 'switching it off reaches the runtime too');
});

test('a failed effect is reported by domain, and one domain never runs two effects at once', async () => {
  const started = [];
  let finishFirst;
  const effects = createConfigChangeEffects({
    invalidateContextStatusCache() {},
    releaseAdmissionCooldowns() {},
    announceSettingsChange() {},
    reinitProviders: () => {
      throw new Error('init broke');
    },
    reconcileMcp: () => {
      started.push(started.length);
      if (started.length > 1) return undefined;
      return new Promise((_resolve, reject) => {
        finishFirst = () => reject(new Error('reconcile broke'));
      });
    },
  });
  const change = { providers: true, mcp: true, settings: false, cacheWarming: null, autoClear: false, agentRoutes: [] };
  const first = effects(change, {});
  const second = effects({ ...change, providers: false }, {});
  await Promise.resolve();
  assert.deepEqual(started, [0], 'the second reconcile waits for the first');
  finishFirst();
  assert.deepEqual((await first).sort(), ['mcp', 'providers']);
  assert.deepEqual(await second, []);
  assert.deepEqual(started, [0, 1]);
});

test('each kind of change runs its own effects and nothing else', () => {
  const base = configChangeSnapshot({
    config: { providers: { demo: { enabled: true } }, mcpServers: {} },
    root: { agent: {}, desktop: { keepAwake: true } },
    secretTokens: {},
  });
  const run = (next) => {
    const { calls, effects } = recorder();
    effects(diffConfigSnapshots(base, configChangeSnapshot(next)));
    return calls;
  };
  // A stored key replaced (its change token moved): providers re-init.
  assert.deepEqual(
    run({
      config: { providers: { demo: { enabled: true, apiKey: 'k' } }, mcpServers: {} },
      root: { agent: {}, desktop: { keepAwake: true } },
      secretTokens: { 'agent.demo.apiKey': 't1' },
    }),
    ['context', 'cooldowns', 'providers', 'announce']
  );
  // An MCP server edited by hand: reconcile, and open settings re-read.
  assert.deepEqual(
    run({
      config: { providers: { demo: { enabled: true } }, mcpServers: { docs: { command: 'd' } } },
      root: { agent: { mcpServers: { docs: { command: 'd' } } }, desktop: { keepAwake: true } },
      secretTokens: {},
    }),
    ['context', 'mcp', 'announce']
  );
  // A sign-in or a plugin (un)install elsewhere: config unchanged, MCP reconciles.
  for (const account of ['mcp-oauth.abc', 'mcp-oauth-client.abc', 'gmail-app-password.abc', '#plugins']) {
    assert.deepEqual(
      run({
        config: { providers: { demo: { enabled: true } }, mcpServers: {} },
        root: { agent: {}, desktop: { keepAwake: true } },
        secretTokens: { [account]: 't1' },
      }),
      ['context', 'mcp', 'announce'],
      account
    );
  }
  // A deletion of a secret the marker never listed (stored before it existed)
  // moves only the deletion epoch: providers re-init and MCP reconciles too.
  assert.deepEqual(
    run({
      config: { providers: { demo: { enabled: true } }, mcpServers: {} },
      root: { agent: {}, desktop: { keepAwake: true } },
      secretTokens: { '#deleted': 't1' },
    }),
    ['context', 'cooldowns', 'providers', 'mcp', 'announce']
  );
  // A desktop-only change is not a runtime settings change.
  assert.deepEqual(
    run({
      config: { providers: { demo: { enabled: true } }, mcpServers: {} },
      root: { agent: {}, desktop: { keepAwake: false } },
      secretTokens: {},
    }),
    ['context']
  );
});
