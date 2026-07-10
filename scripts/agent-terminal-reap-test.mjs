import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUTO_CLEAR_PROVIDER_IDLE_MS,
  resolveAgentTerminalReapMs,
} from '../src/session-runtime/config-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-terminal-reap-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_AGENT_TERMINAL_REAP_MS = '1';

function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

try {
  const builtIns = Object.entries(AUTO_CLEAR_PROVIDER_IDLE_MS).filter(([provider]) => provider !== 'default');
  for (const [provider, idleMs] of builtIns) {
    assertEqual(resolveAgentTerminalReapMs({ autoClear: {} }, provider), idleMs, `${provider} built-in`);
  }

  const overrideConfig = {
    autoClear: {
      idleMs: 12 * 60 * 60 * 1000,
      providerIdleMs: { 'openai-oauth': 60_000, default: 90_000, unlisted: 60_000 },
    },
  };
  assertEqual(resolveAgentTerminalReapMs(overrideConfig, 'openai-oauth'), 60_000, 'provider override');
  assertEqual(
    resolveAgentTerminalReapMs(overrideConfig, 'anthropic'),
    AUTO_CLEAR_PROVIDER_IDLE_MS.anthropic,
    'global idleMs and default row are ignored for listed providers',
  );
  assert.equal(resolveAgentTerminalReapMs(overrideConfig, 'default'), null, 'default row is ignored');
  assert.equal(resolveAgentTerminalReapMs(overrideConfig, 'unlisted'), null, 'unlisted override is ignored');
  assert.equal(resolveAgentTerminalReapMs(overrideConfig, 'unknown'), null, 'unknown provider is ignored');

  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(join(root, 'mixdog-config.json'), JSON.stringify({
    agent: { autoClear: overrideConfig.autoClear },
  }));
  const { sweepStaleSessions } = await import('../src/runtime/agent/orchestrator/session/store.mjs');
  const old = Date.now() - 61_000;
  const known = {
    id: 'sess_known_reap',
    owner: 'agent',
    status: 'idle',
    provider: 'openai-oauth',
    createdAt: old,
    updatedAt: old,
    messages: [],
  };
  const shortOverride = {
    id: 'sess_short_override',
    owner: 'agent',
    status: 'idle',
    provider: 'openai-oauth',
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 120_000,
    messages: [],
  };
  const unknown = {
    id: 'sess_unknown_keep',
    owner: 'agent',
    status: 'idle',
    provider: 'unlisted',
    createdAt: old,
    updatedAt: old,
    messages: [],
  };
  writeFileSync(join(root, 'sessions', `${known.id}.json`), JSON.stringify(known));
  writeFileSync(join(root, 'sessions', `${shortOverride.id}.json`), JSON.stringify(shortOverride));
  writeFileSync(join(root, 'sessions', `${unknown.id}.json`), JSON.stringify(unknown));
  for (const id of [known.id, unknown.id]) utimesSync(join(root, 'sessions', `${id}.json`), old / 1000, old / 1000);
  utimesSync(join(root, 'sessions', `${shortOverride.id}.json`), shortOverride.updatedAt / 1000, shortOverride.updatedAt / 1000);
  const defaultSweep = sweepStaleSessions({ retainOpenSessions: false });
  assert.ok(
    defaultSweep.details.some((detail) => detail.id === shortOverride.id),
    'short provider override bypasses the default sweep freshness gate',
  );
  assert.ok(defaultSweep.details.some((detail) => detail.id === known.id), 'store reaps a listed provider at its Advanced duration');
  assert.ok(!defaultSweep.details.some((detail) => detail.id === unknown.id), 'store never sweeps an unlisted provider');

  const dataDir = join(root, 'worker-index');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'agent-workers.json'), JSON.stringify({
    workers: {
      known: {
        tag: 'known',
        sessionId: 'sess_known_row',
        provider: 'openai-oauth',
        status: 'idle',
        updatedAt: new Date(old).toISOString(),
      },
      unknown: {
        tag: 'unknown',
        sessionId: 'sess_unknown_row',
        provider: 'unlisted',
        status: 'idle',
        updatedAt: new Date(old).toISOString(),
      },
    },
  }));
  const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
  const agent = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => overrideConfig,
      resolveRuntimeSpec: () => ({ lane: 'agent', scopeKey: 'terminal-reap', provider: 'openai-oauth', model: 'test' }),
    },
    reg: {},
    mgr: { listSessions: () => [], getSession: () => null },
    dataDir,
    cwd: root,
  });
  const workers = agent.getStatus().workers;
  assert.ok(!workers.some((worker) => worker.tag === 'known'), 'worker row expires at the provider duration');
  assert.ok(workers.some((worker) => worker.tag === 'unknown'), 'unlisted worker row does not expire');
  agent.closeAll('agent-terminal-reap-test');

  process.stdout.write(`agent terminal reap test passed (${builtIns.length} providers)\n`);
} finally {
  delete process.env.MIXDOG_AGENT_TERMINAL_REAP_MS;
  delete process.env.MIXDOG_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
}
