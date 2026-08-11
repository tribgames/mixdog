import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_MAINTENANCE } from '../src/runtime/agent/orchestrator/config.mjs';
import { resolveMaintenanceRoute } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { resolveAgentSpawnPreset } from '../src/standalone/agent-tool.mjs';

const main = { id: 'main', name: 'MAIN', type: 'agent', provider: 'main-provider', model: 'main-model', tools: 'full' };
const configWithMain = (overrides = {}) => ({
  default: 'main',
  presets: [main],
  maintenance: { ...DEFAULT_MAINTENANCE },
  ...overrides,
});
const normalizedRoute = (route, provider = route.provider || 'anthropic-oauth') => ({
  provider,
  model: route.model,
  effort: undefined,
  fast: false,
});

test('empty Maintainer route inherits Main in hidden and public dispatch', () => {
  assert.equal(DEFAULT_MAINTENANCE.memory, undefined);
  assert.equal(DEFAULT_MAINTENANCE.scheduler, undefined);
  assert.equal(DEFAULT_MAINTENANCE.webhook.provider, 'anthropic-oauth');
  assert.match(DEFAULT_MAINTENANCE.webhook.model, /haiku/i);

  const config = configWithMain();
  assert.equal(resolveMaintenanceRoute({ agent: 'cycle1-agent', config }), 'main');
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'maintainer' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'worker' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'custom-agent' }).preset, main);
});

test('agents without an override or configured Main fail instead of using role defaults', () => {
  assert.throws(
    () => resolveAgentSpawnPreset({ presets: [] }, { agent: 'worker' }),
    /no Main model assignment/,
  );
});

test('public agent, workflow, and maintenance routes override Main inheritance', () => {
  const maintainerWorkflow = { provider: 'workflow-provider', model: 'workflow-model' };
  assert.deepEqual(
    resolveAgentSpawnPreset(configWithMain({
      workflowRoutes: { memory: maintainerWorkflow },
      maintenance: { ...DEFAULT_MAINTENANCE, memory: { provider: 'ignored-provider', model: 'ignored-model' } },
    }), { agent: 'maintainer' }).preset,
    { id: 'agent-maintainer', name: 'AGENT MAINTAINER', type: 'agent', ...maintainerWorkflow, effort: undefined, fast: false, tools: 'full' },
  );
});

test('hidden Maintainer routes use public precedence, including the legacy maintainer alias', () => {
  const agentRoute = { provider: 'agent-provider', model: 'agent-model' };
  const workflowRoute = { provider: 'workflow-provider', model: 'workflow-model' };
  const maintenanceRoute = { provider: 'maintenance-provider', model: 'maintenance-model' };
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle1-agent',
    config: configWithMain({
      workflowRoutes: { memory: workflowRoute },
      maintenance: { ...DEFAULT_MAINTENANCE, memory: maintenanceRoute },
    }),
  }), normalizedRoute(workflowRoute));
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle2-agent',
    config: configWithMain({
      maintenance: { ...DEFAULT_MAINTENANCE, memory: maintenanceRoute },
    }),
  }), normalizedRoute(maintenanceRoute));
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle3-agent',
    config: configWithMain({ agents: { maintenance: agentRoute } }),
  }), normalizedRoute(agentRoute));
});

test('providerless routes are not overrides and inherit Main', () => {
  const modelOnly = { model: 'model-only' };
  assert.equal(
    resolveMaintenanceRoute({ agent: 'cycle1-agent', config: configWithMain({ defaultProvider: 'gemini', agents: { maintenance: modelOnly } }) }),
    'main',
  );
  assert.equal(
    resolveMaintenanceRoute({ agent: 'cycle2-agent', config: configWithMain({ maintenance: { ...DEFAULT_MAINTENANCE, memory: modelOnly } }) }),
    'main',
  );
});

test('loadConfig removes retired routes and migrates Maintainer into canonical agents', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-maintenance-config-'));
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({
    agent: {
      maintenance: { memory: { model: 'gpt-maintainer-test' } },
      workflowRoutes: {
        memory: { provider: 'openai', model: 'ignored-memory' },
      },
      agents: {
        explorer: { provider: 'grok-oauth', model: 'retired' },
        maintenance: { provider: 'openai', model: 'gpt-maintainer-canonical' },
      },
      searchRoute: { model: 'providerless-search' },
      presets: [
        { id: 'workflow-explorer', name: 'WORKFLOW EXPLORER', type: 'agent', provider: 'openai', model: 'ignored', tools: 'full' },
        { id: 'keep-me', name: 'KEEP ME', type: 'agent', provider: 'openai', model: 'kept', tools: 'full' },
      ],
    },
  }));
  const runner = [
    "import { loadConfig } from './src/runtime/agent/orchestrator/config.mjs';",
    "const config = loadConfig({ secrets: false });",
    "console.log(JSON.stringify({ defaultProvider: config.defaultProvider, agents: config.agents, maintenance: config.maintenance, workflowRoutes: config.workflowRoutes, presets: config.presets, searchRoute: config.searchRoute }));",
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: process.cwd(),
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.agents.explore, undefined);
  assert.equal(migrated.agents.explorer, undefined);
  assert.deepEqual(migrated.agents.maintainer, { provider: 'openai', model: 'gpt-maintainer-canonical' });
  assert.equal(migrated.agents.maintenance, undefined);
  assert.equal(migrated.maintenance.explore, undefined);
  assert.equal(migrated.maintenance.memory, undefined);
  assert.equal(migrated.workflowRoutes, undefined);
  assert.deepEqual(migrated.presets.map((preset) => preset.id), ['keep-me']);
  assert.equal(migrated.defaultProvider, undefined);
  assert.equal(migrated.presets[0].provider, 'openai');
  assert.deepEqual(migrated.searchRoute, { provider: 'default', model: 'default' });
});

test('config maintenance migration has no standalone provider runtime dependency', () => {
  const source = readFileSync(new URL('../src/runtime/agent/orchestrator/config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /standalone\/provider-admin/);
  assert.doesNotMatch(source, /DEFAULT_AGENT_PROVIDER|CONFIG_PROVIDER_IDS/);
});
