import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

mock.module('../../../runtime/agent/orchestrator/providers/registry.mjs', {
  namedExports: {
    getProvider: (name) =>
      name === 'antigravity-oauth'
        ? { firstResponseBudget: (model) => ({ transportMs: `${model}:headers`, semanticMs: `${model}:output` }) }
        : name === 'proxied-antigravity'
          ? proxiedAntigravity
          : undefined,
  },
});
mock.module('../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs', {
  namedExports: {
    prepareAgentSession: (spec) => ({ session: { id: 'local', spec }, effectiveCwd: null }),
  },
});
mock.module('../../route-state.mjs', {
  namedExports: {
    resolveRouteContextState: (route) => ({
      contextPercent: route.contextPercent,
      selectedContextWindow: route.contextPercent * 1000,
    }),
  },
});

const { createSpawnPreparer } = await import('./spawn-flow/spawn-prep.mjs');
const { ModelProxyProvider } = await import('../../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs');

// The server-side stand-in for a provider on the PC, with the PC's budget.
const proxiedAntigravity = new ModelProxyProvider('antigravity-oauth', {
  modelProxy: { firstResponseBudget: { transportMs: 130_000, semanticMs: 250_000 } },
});

function preparer(sessionSurface) {
  return createSpawnPreparer({
    cfgMod: {},
    ensureProvider: async () => {},
    sessionSurface,
  });
}

test('watchdog overrides carry the agent definition deadline and the provider first-byte window', () => {
  const dataDir = makeTempDirSync('spawn-prep');
  const sourceRoot = makeTempDirSync('spawn-prep-src');
  mkdirSync(join(dataDir, 'agents', 'art-director'), { recursive: true });
  writeFileSync(
    join(dataDir, 'agents', 'art-director', 'AGENT.md'),
    '---\nname: art-director\nfirstResponseTimeoutMs: 900000\n---\nBody\n'
  );
  const { agentWatchdogOverrides } = createSpawnPreparer({
    cfgMod: {},
    dataDir,
    STANDALONE_SOURCE_ROOT: sourceRoot,
  });
  assert.deepEqual(
    agentWatchdogOverrides({ agent: 'art-director', provider: 'antigravity-oauth', model: 'gemini-4-argon' }),
    {
      firstResponseTimeoutMs: 900_000,
      providerFirstByteTimeoutMs: 'gemini-4-argon:headers',
      providerFirstOutputTimeoutMs: 'gemini-4-argon:output',
    }
  );
  // A proxied provider forwards the PC's budget instead of the 120s / 600s defaults.
  assert.deepEqual(
    agentWatchdogOverrides({ agent: 'worker', provider: 'proxied-antigravity', model: 'gemini-4-argon' }),
    {
      firstResponseTimeoutMs: undefined,
      providerFirstByteTimeoutMs: 130_000,
      providerFirstOutputTimeoutMs: 250_000,
    }
  );
  assert.deepEqual(agentWatchdogOverrides({ agent: 'worker', provider: 'openai', model: 'gpt' }), {
    firstResponseTimeoutMs: undefined,
    providerFirstByteTimeoutMs: undefined,
    providerFirstOutputTimeoutMs: undefined,
  });
});

test('spawned agent session receives contextPercent, selectedContextWindow and modelParameters', async () => {
  const preset = { provider: 'p', model: 'm', modelParameters: { context: '1m' }, contextPercent: 40 };
  const plan = { config: {}, preset, prompt: 'x', tag: 't' };
  const spec = { preset };
  const expected = { preset, contextPercent: 40, selectedContextWindow: 40000 };

  // Covers both the canonical-surface and the local branch.
  const created = [];
  const surface = {
    canonical: true,
    createChild: async (args) => {
      created.push(args);
      return { session: {} };
    },
  };
  await preparer(surface).createSpawnedSession(plan, spec, null);
  assert.deepEqual(created[0].spec, expected);

  const local = await preparer(null).createSpawnedSession(plan, spec, null);
  assert.deepEqual(local.session.spec, expected);
  assert.deepEqual(local.session.spec.preset.modelParameters, { context: '1m' });

  const plain = await preparer(null).createSpawnedSession(
    { ...plan, preset: { provider: 'p', model: 'm' } },
    { preset: {} },
    null
  );
  assert.equal(Object.hasOwn(plain.session.spec, 'contextPercent'), false);
});
