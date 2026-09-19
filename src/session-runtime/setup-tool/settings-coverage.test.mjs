import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSetupToolExecutor } from './executor.mjs';
import { SETUP_ACTION_FIELDS, SETUP_TOOL_DEFS } from './tool-defs.mjs';
import { SETUP_EXTENDED_ACTION_FIELDS, SETUP_DESKTOP_ACTIONS } from './settings-contract.mjs';
import { EXTENDED_SETUP_HANDLERS } from './extended-actions.mjs';
import { createModelRouteApi } from '../model-route-api.mjs';
import { createWorkflowAgentsApi } from '../workflow-agents-api.mjs';
import { createWorkflowRouteHelpers } from '../workflow.mjs';
import { createSettingsApi } from '../settings-api.mjs';
import { normalizeAutoClearConfig, normalizeCompactionConfig } from '../config-helpers.mjs';
import { createMcpGlue } from '../mcp-glue.mjs';
import { createResourceApi } from '../resource-api.mjs';
import { isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { setBuiltinFirstUseApprovalInConfig } from '../builtin-features.mjs';
import { schemaValueError } from '../../runtime/shared/schema-value-error.mjs';

const run = async (api, args, options = {}) =>
  JSON.parse(await createSetupToolExecutor({ getApi: () => api, ...options }).execute(args));

test('every registered action field is exposed, and every extended action has an implementation', () => {
  const fields = SETUP_TOOL_DEFS[0].inputSchema.properties;
  for (const [action, signature] of Object.entries(SETUP_ACTION_FIELDS)) {
    for (const field of signature
      .split(' ')
      .filter(Boolean)
      .map((field) => field.replace(/\?$/, ''))) {
      assert.ok(Object.hasOwn(fields, field), `${action}: missing ${field}`);
    }
  }
  assert.deepEqual(
    Object.keys(SETUP_EXTENDED_ACTION_FIELDS).sort(),
    [...Object.keys(EXTENDED_SETUP_HANDLERS), ...SETUP_DESKTOP_ACTIONS].sort()
  );
  assert.deepEqual(fields.mode.enum, [...ORCHESTRATION_MODES]);
  assert.equal(schemaValueError(null, fields.localContextWindow, 'context'), null);
  assert.match(schemaValueError('wrong', fields.localContextWindow, 'context'), /integer/);
  assert.match(schemaValueError(12, fields.projectPath, 'projectPath'), /string/);
});

test('agent tuning preserves its model and unrelated settings; disable and inheritance are explicit', async () => {
  const previous = {
    provider: 'cursor-oauth',
    model: 'audit-model',
    effort: 'low',
    fast: true,
    modelParameters: { context: 'large' },
  };
  let config = { agents: { maintainer: { ...previous } }, profile: { title: 'unchanged' } };
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const main = { provider: 'openai', model: 'main-model' };
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    agentRouteFromConfig: helpers.agentRouteFromConfig,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : main),
    lookupModelMeta: async () => ({ fastCapable: true, fastEfforts: ['low', 'high'] }),
    ensureProvidersReady: async () => {},
    saveConfigAndAdopt: (next) => {
      config = next;
    },
  });
  const changed = await run(api, { action: 'set_agent_route', agent: 'maintainer', route: { effort: 'high' } });
  assert.equal(changed.route.provider, previous.provider);
  assert.equal(changed.route.model, previous.model);
  assert.equal(changed.route.effort, 'high');
  assert.equal(changed.route.fast, true);
  assert.deepEqual(changed.route.modelParameters, previous.modelParameters);
  assert.deepEqual(config.profile, { title: 'unchanged' });
  const stored = structuredClone(config.agents.maintainer);
  await run(api, { action: 'set_agent_route', agent: 'maintainer', route: { disabled: true } });
  assert.equal(isAgentDisabled(config, 'maintainer'), true);
  assert.deepEqual(config.agents.maintainer, stored);
  await run(api, { action: 'set_agent_route', agent: 'maintainer', route: { disabled: false } });
  assert.equal(isAgentDisabled(config, 'maintainer'), false);
  assert.deepEqual(config.agents.maintainer, stored);
  const inherited = await run(api, { action: 'set_agent_route', agent: 'maintainer', route: { provider: '' } });
  assert.equal(inherited.route.inherited, true);
  assert.equal(Object.hasOwn(config.agents, 'maintainer'), false);
});

test('Web Search Fast-only edits keep the search model and effort; explicit reset follows Main', async () => {
  const previous = {
    provider: 'openai-oauth',
    model: 'audit-search-model',
    effort: 'low',
    fast: true,
    modelParameters: { context: 'large' },
  };
  let config = { webSearchRoute: previous, agents: { untouched: { provider: 'openai', model: 'other' } } };
  let route = previous;
  const api = createModelRouteApi({
    getConfig: () => config,
    getWebSearchRouteState: () => route,
    setWebSearchRouteState: (next) => {
      route = next;
    },
    lookupModelMeta: async () => ({ id: previous.model, provider: previous.provider }),
    webSearchCapableFor: () => true,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    invalidateProviderCaches: () => {},
  });
  await run(api, { action: 'set_web_search_route', route: { fast: false } });
  assert.deepEqual(config.webSearchRoute, { ...previous, fast: false });
  assert.equal(config.agents.untouched.model, 'other');
  await run(api, { action: 'set_web_search_route', route: { provider: '' } });
  assert.deepEqual(config.webSearchRoute, { provider: 'default', model: 'default' });
});

test('Main context and model parameters reach the route API, while agent-only flags are rejected', async () => {
  const calls = [];
  const api = {
    setRoute: async (value) => {
      calls.push(value);
      return value;
    },
  };
  const route = { modelParameters: { context: 'large' }, contextPercent: 70 };
  await run(api, { action: 'set_route', route });
  assert.deepEqual(calls, [route]);
  await assert.rejects(run(api, { action: 'set_route', route: { disabled: true } }), /only accepted/);
  await assert.rejects(run(api, { action: 'set_web_search_route', route: { contextPercent: 70 } }), /only accepted/);
  await assert.rejects(run(api, { action: 'set_route', route: { contextPercent: 7 } }), /contextPercent/);
});

test('auto-clear resets preserve unrelated overrides; percentage budgets replace tokens in config and live session', async () => {
  let config = {
    autoClear: {
      enabled: true,
      idleMs: 600000,
      providerIdleMs: { openai: 900000, gemini: 1200000 },
      minContextPercent: 10,
    },
    compaction: { auto: true, mainBufferTokens: 8000 },
  };
  const session = { compaction: { auto: true, mainBufferTokens: 8000 } };
  const api = createSettingsApi({
    getConfig: () => config,
    getSession: () => session,
    hasOwn: (value, key) => Object.hasOwn(value, key),
    normalizeAutoClearConfig,
    normalizeCompactionConfig,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    formatDurationMs: (value) => String(value),
    invalidateContextStatusCache: () => {},
  });
  api.getAutoClear = () => config.autoClear;
  await run(api, {
    action: 'set_autoclear',
    autoclear: { provider: 'openai', resetProvider: true, minContextPercent: 20 },
  });
  assert.deepEqual(config.autoClear.providerIdleMs, { gemini: 1200000 });
  assert.equal(config.autoClear.idleMs, 600000);
  assert.equal(config.autoClear.minContextPercent, 20);
  await run(api, { action: 'set_autoclear', autoclear: { reset: true } });
  assert.equal(config.autoClear.idleMs, null);
  assert.deepEqual(config.autoClear.providerIdleMs, { gemini: 1200000 });
  await run(api, { action: 'set_compaction', compaction: { mainBufferPercent: 15 } });
  assert.equal(config.compaction.mainBufferPercent, 15);
  assert.equal(session.compaction.mainBufferPercent, 15);
  assert.equal(Object.hasOwn(config.compaction, 'mainBufferTokens'), false);
  assert.equal(Object.hasOwn(session.compaction, 'mainBufferTokens'), false);
  await assert.rejects(
    run(api, { action: 'set_compaction', compaction: { mainBufferTokens: 1000, mainBufferPercent: 15 } }),
    /not both/
  );
  await assert.rejects(run(api, { action: 'set_autoclear', autoclear: { resetProvider: true } }), /requires provider/);
});

test('MCP edits use documented names, retain omitted credentials and arguments, and rename without duplicating', async (t) => {
  let config = {
    mcpServers: {
      fixture: {
        type: 'stdio',
        command: 'node',
        args: ['original'],
        env: { API_TOKEN: 'credential-canary' },
        enabled: false,
      },
    },
  };
  const glue = createMcpGlue({ getConfig: () => config, getCurrentCwd: () => process.cwd(), mcpClient: {}, state: {} });
  const status = () => ({
    servers: Object.entries(config.mcpServers).map(([name, entry]) => ({ name, enabled: entry.enabled })),
  });
  const api = createResourceApi({
    getConfig: () => config,
    getCurrentCwd: () => process.cwd(),
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    getMcpServerConfig: glue.getMcpServerConfig,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    connectConfiguredMcp: async () => status(),
    mcpStatus: status,
    invalidatePreSessionToolSurface: () => {},
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  await run(api, { action: 'save_mcp_server', server: { name: 'fixture', cwd: 'subdir' } });
  assert.equal(config.mcpServers.fixture.cwd, resolve(process.cwd(), 'subdir'));
  assert.deepEqual(config.mcpServers.fixture.args, ['original']);
  assert.equal(config.mcpServers.fixture.env.API_TOKEN, 'credential-canary');
  assert.equal(config.mcpServers.fixture.enabled, false);
  await run(api, { action: 'save_mcp_server', server: { name: 'fixture', env: { LABEL: 'new' } } });
  assert.equal(config.mcpServers.fixture.env.API_TOKEN, 'credential-canary');
  assert.equal(config.mcpServers.fixture.env.LABEL, 'new');
  await run(api, { action: 'save_mcp_server', server: { originalName: 'fixture', name: 'renamed' } });
  assert.deepEqual(Object.keys(config.mcpServers), ['renamed']);
  const safe = await run(api, { action: 'get_mcp_server', name: 'renamed' });
  assert.doesNotMatch(JSON.stringify(safe), /credential-canary|original/);
  assert.deepEqual(safe.environmentNames, ['API_TOKEN', 'LABEL']);
  await assert.rejects(
    run(api, { action: 'add_mcp_server', server: { name: 'renamed', command: 'node' } }),
    /already exists/
  );
});

test('typed MCP input rejects misspellings, wrong types, credentials and conflicting transports before mutation', async () => {
  let calls = 0;
  const api = {
    addMcpServer: async () => {
      calls++;
    },
  };
  for (const server of [
    { name: 'x', comand: 'node' },
    { name: 'x', command: 'node', args: 'not-an-array' },
    { name: 'x', command: 'node', env: { TOKEN: 'secret' } },
    { name: 'x', url: 'https://example.test', headers: { Authorization: 'secret' } },
    { name: 'x', url: 'https://name:secret@example.test' },
    { name: 'x', url: 'https://example.test?token=secret' },
    { name: 'x', command: 'node', url: 'https://example.test' },
  ])
    await assert.rejects(run(api, { action: 'add_mcp_server', server }));
  assert.equal(calls, 0);
});

test('definition partial edits preserve names and bodies not requested for change', async () => {
  let workflow = { id: 'fixture', name: 'Keep name', description: 'Old', body: 'Keep instructions' };
  const api = {
    getWorkflowPack: () => workflow,
    saveWorkflowPack: async (next) => {
      workflow = next;
      return next;
    },
  };
  const result = await run(api, {
    action: 'save_definition',
    definitionKind: 'workflow',
    definition: { id: 'fixture', description: 'New' },
  });
  assert.deepEqual(workflow, { id: 'fixture', name: 'Keep name', description: 'New', body: 'Keep instructions' });
  assert.equal(result.saved, true);
  await assert.rejects(
    run(api, {
      action: 'save_definition',
      definitionKind: 'workflow',
      definition: { id: 'fixture', whenToUse: 'not a workflow field' },
    }),
    /not a workflow/
  );
});

test('automation partial edits preserve one-shot timing and attachments; signing secrets never reach receipts', async () => {
  const attachment = { kind: 'text', name: 'keep.txt', data: 'attachment-canary' };
  const entry = {
    name: 'fixture',
    instructions: 'Keep prompt',
    whenAt: '2035-01-01T09:00:00.000Z',
    time: 'at 2035-01-01T09:00:00.000Z',
    attachments: [attachment],
    enabled: false,
  };
  let received;
  const api = {
    getChannelSetup: async () => ({
      schedules: [entry],
      webhooks: [{ name: 'hook', instructions: 'Keep prompt', secretSet: true }],
      webhook: { enabled: true },
    }),
    saveSchedule: async (value) => {
      received = value;
      return value;
    },
    saveWebhook: async (value) => ({ ...value, secret: 'signing-canary' }),
  };
  const result = await run(api, {
    action: 'save_automation',
    automationKind: 'schedule',
    entry: { name: 'fixture', overwrite: true, description: 'New' },
  });
  assert.equal(received.at, entry.whenAt);
  assert.equal(Object.hasOwn(received, 'time'), false);
  assert.deepEqual(received.attachments, [attachment]);
  assert.equal(received.enabled, false);
  assert.equal(received.instructions, entry.instructions);
  assert.doesNotMatch(JSON.stringify(result), /attachment-canary/);
  const hook = await run(api, {
    action: 'save_automation',
    automationKind: 'webhook',
    entry: { name: 'hook', overwrite: true, description: 'New' },
  });
  assert.equal(hook.secretSet, true);
  assert.doesNotMatch(JSON.stringify(hook), /signing-canary/);
  await assert.rejects(
    run(api, { action: 'save_automation', automationKind: 'webhook', entry: { name: 'hook', time: '* * * * *' } }),
    /not accepted/
  );
});

test('first-use approval can be inspected, and failed persistence cannot produce a success receipt', async () => {
  const config = setBuiltinFirstUseApprovalInConfig({}, 'browser', false);
  const features = await run(
    { getToolModuleSettings: () => ({}) },
    { action: 'status', domain: 'features' },
    { getConfig: () => config }
  );
  assert.equal(features.browser.firstUseApproval, false);
  assert.equal(features.computer.firstUseApproval, true);
  await assert.rejects(
    run(
      { setProfile: () => ({ title: 'Changed' }) },
      { action: 'set_profile', profile: { title: 'Changed' } },
      {
        flushSettings: async () => {
          throw new Error('disk unavailable');
        },
      }
    ),
    /disk unavailable/
  );
});
