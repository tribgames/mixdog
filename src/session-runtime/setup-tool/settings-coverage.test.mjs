import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSetupToolExecutor } from './executor.mjs';
import { SETUP_ACTION_FIELDS, SETUP_TOOL_DEFS } from './tool-defs.mjs';
import { SETUP_EXTENDED_ACTION_FIELDS, SETUP_DESKTOP_ACTIONS } from './settings-contract.mjs';
import { EXTENDED_SETUP_HANDLERS } from './extended-actions.mjs';
import { createModelRouteApi } from '../model-route-api.mjs';
import { createWorkflowAgentsApi } from '../workflow-agents-api.mjs';
import { createWorkflowRouteHelpers } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { createSettingsApi } from '../settings-api.mjs';
import {
  normalizeAutoClearConfig,
  normalizeCompactionConfig,
  resolveAutoClearIdleMs,
  autoClearIdleMsForProvider,
  autoClearProviderDefaults,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { createMcpGlue } from '../mcp-glue.mjs';
import { createResourceApi } from '../resource-api.mjs';
import { isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { schemaValueError } from '../../runtime/shared/schema-value-error.mjs';
import { saveSchedule } from '../services/channel-admin.mjs';

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
  const agentCalls = [];
  const agentApi = { ...api, setAgentRoute: async (id, next) => agentCalls.push([id, next]) };
  await run(agentApi, { action: 'set_agent_route', agent: 'worker', route: { contextPercent: 70 } });
  assert.deepEqual(agentCalls, [['worker', { contextPercent: 70 }]]);
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

test('schedule creation rejects missing or blank models', async () => {
  for (const modelFields of [{}, { model: '' }, { model: ' \t ' }]) {
    await assert.rejects(
      run(
        { saveSchedule },
        {
          action: 'save_automation',
          automationKind: 'schedule',
          entry: {
            name: 'missing-model',
            instructions: 'Test schedule',
            at: '2035-01-01T09:00:00.000Z',
            ...modelFields,
          },
        }
      ),
      /schedule model is required/
    );
  }
});

test('schedule edits reject a missing saved model or explicitly clearing a saved model', async () => {
  for (const savedModel of [undefined, 'openai/audit-model']) {
    for (const modelFields of [{}, { model: '' }, { model: ' \t ' }]) {
      if (savedModel && !Object.hasOwn(modelFields, 'model')) continue;
      const api = {
        saveSchedule,
        getChannelSetup: async () => ({
          schedules: [
            {
              name: 'fixture',
              instructions: 'Keep prompt',
              whenAt: '2035-01-01T09:00:00.000Z',
              model: savedModel,
            },
          ],
        }),
      };
      await assert.rejects(
        run(api, {
          action: 'save_automation',
          automationKind: 'schedule',
          entry: { name: 'fixture', overwrite: true, description: 'New', ...modelFields },
        }),
        /schedule model is required/
      );
    }
  }
});

test('automation partial edits preserve model, one-shot timing and attachments; signing secrets never reach receipts', async () => {
  const attachment = { kind: 'text', name: 'keep.txt', data: 'attachment-canary' };
  const entry = {
    name: 'fixture',
    instructions: 'Keep prompt',
    model: 'openai/audit-model',
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
  assert.equal(received.model, entry.model);
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

test('failed persistence cannot produce a success receipt', async () => {
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

test('forgetting OAuth auth names one account; several accounts require an explicit accountId', async () => {
  const forgotten = [];
  let accounts = [{ id: 'a1' }, { id: 'a2' }];
  const api = {
    getProviderSetup: async () => ({ oauth: [{ id: 'oauth-fixture' }], api: [{ id: 'api-fixture' }] }),
    getProviderAccounts: () => ({ accounts }),
    forgetProviderAuth: async (...args) => {
      forgotten.push(args);
      return { forgotten: true };
    },
  };
  await assert.rejects(run(api, { action: 'forget_provider_auth', name: 'oauth-fixture' }), /2 accounts/);
  assert.deepEqual(forgotten, []);
  const named = await run(api, { action: 'forget_provider_auth', name: 'oauth-fixture', accountId: 'a2' });
  assert.equal(named.accountId, 'a2');
  accounts = [{ id: 'only' }];
  await run(api, { action: 'forget_provider_auth', name: 'oauth-fixture' });
  await run(api, { action: 'forget_provider_auth', name: 'api-fixture' });
  assert.deepEqual(forgotten, [['oauth-fixture', 'a2'], ['oauth-fixture', 'only'], ['api-fixture']]);
  await assert.rejects(
    run(api, { action: 'forget_provider_auth', name: 'api-fixture', accountId: 'a1' }),
    /only to OAuth/
  );
});

test('provider account changes reach the roster API and return no usage or identity details', async () => {
  let received;
  const api = {
    updateProviderAccounts: async (provider, change) => {
      received = [provider, change];
      return {
        selectedId: 'a2',
        auto: false,
        accounts: [{ id: 'a2', label: 'Home', authenticated: true, reauthRequired: false, identity: 'x@y.test' }],
      };
    },
  };
  const result = await run(api, {
    action: 'set_provider_account',
    name: 'oauth-fixture',
    providerAccount: { selectedId: 'a2', auto: false },
  });
  assert.deepEqual(received, ['oauth-fixture', { selectedId: 'a2', auto: false }]);
  assert.equal(result.selectedId, 'a2');
  assert.doesNotMatch(JSON.stringify(result), /x@y\.test/);
  await assert.rejects(
    run(api, { action: 'set_provider_account', name: 'oauth-fixture', providerAccount: {} }),
    /at least one setting/
  );
});

test('developer options with a warning turn on only with explicit risk acceptance', async () => {
  const calls = [];
  const view = {
    sections: [{ id: 'providers', options: [{ id: 'risky', label: 'Risky', warning: 'Account risk.' }, { id: 'plain' }] }],
  };
  const api = {
    getDeveloperSettings: () => view,
    setDeveloperOption: async (id, enabled) => {
      calls.push([id, enabled]);
      return view;
    },
  };
  await assert.rejects(
    run(api, { action: 'set_developer_option', name: 'risky', enabled: true }),
    /riskAccepted:true.*Account risk/
  );
  await run(api, { action: 'set_developer_option', name: 'risky', enabled: true, riskAccepted: true });
  await run(api, { action: 'set_developer_option', name: 'risky', enabled: false });
  await run(api, { action: 'set_developer_option', name: 'plain', enabled: true });
  await assert.rejects(run(api, { action: 'set_developer_option', name: 'missing', enabled: true }), /Unknown/);
  assert.deepEqual(calls, [
    ['risky', true],
    ['risky', false],
    ['plain', true],
  ]);
});

test('profile edits reject unknown language or experience ids instead of silently resetting them', async () => {
  const saved = [];
  const api = {
    setProfile: (profile) => {
      saved.push(profile);
      return profile;
    },
  };
  await assert.rejects(run(api, { action: 'set_profile', profile: { language: 'korean' } }), /profile\.language/);
  await assert.rejects(
    run(api, { action: 'set_profile', profile: { experienceLevel: 'senior' } }),
    /profile\.experienceLevel/
  );
  await run(api, { action: 'set_profile', profile: { language: 'ko', experienceLevel: '' } });
  assert.deepEqual(saved, [{ language: 'ko', experienceLevel: '' }]);
});

test('skill definitions read the frontmatter-free body; built-in skills accept only dependency edits', async () => {
  const saved = [];
  const rows = [
    { name: 'user-skill', description: 'Mine', whenToUse: 'Probe', editable: true, toolDependencies: [] },
    { name: 'builtin-skill', description: 'Shipped', editable: false, toolDependencies: [{ type: 'tool', value: 'setup' }] },
  ];
  const api = {
    skillContent: async (name) => ({ content: `Body of ${name}.` }),
    skillsStatus: async () => ({ skills: rows }),
    saveSkill: async (input) => {
      saved.push(input);
      return { skill: input };
    },
  };
  const read = await run(api, { action: 'read_definition', definitionKind: 'skill', name: 'user-skill' });
  assert.equal(read.body, 'Body of user-skill.');
  assert.equal(read.description, 'Mine');
  await run(api, {
    action: 'save_definition',
    definitionKind: 'skill',
    definition: { originalName: 'user-skill', description: 'Changed' },
  });
  assert.equal(saved.at(-1).body, 'Body of user-skill.');
  assert.equal(saved.at(-1).whenToUse, 'Probe');
  const dependencies = [
    { type: 'tool', value: 'setup' },
    { type: 'tool', value: 'memory' },
  ];
  await run(api, {
    action: 'save_definition',
    definitionKind: 'skill',
    definition: { originalName: 'builtin-skill', toolDependencies: dependencies },
  });
  assert.deepEqual(saved.at(-1), { originalName: 'builtin-skill', dependenciesOnly: true, toolDependencies: dependencies });
  await assert.rejects(
    run(api, {
      action: 'save_definition',
      definitionKind: 'skill',
      definition: { originalName: 'builtin-skill', description: 'Rewritten' },
    }),
    /only toolDependencies/
  );
});

test('plugin MCP enablement resolves the registered plugin by name', async () => {
  const plugin = { id: 'fixture-id', name: 'fixture', root: '/plugins/fixture', mcpScript: 'mcp.js' };
  let received;
  const api = {
    pluginsStatus: () => ({ plugins: [plugin] }),
    enablePluginMcp: async (value) => {
      received = value;
      return { serverName: 'fixture', status: { connectedCount: 1, servers: [{ name: 'fixture', connected: true }] } };
    },
  };
  const result = await run(api, { action: 'enable_plugin_mcp', name: 'fixture' });
  assert.equal(received, plugin);
  assert.equal(result.mcp.servers[0].connected, true);
  await assert.rejects(run(api, { action: 'enable_plugin_mcp', name: 'missing' }), /not found/);
});

test('getAutoClear: provider override beats global idleMs and is flagged', () => {
  const config = {
    autoClear: { enabled: true, idleMs: 7200000, providerIdleMs: { 'openai-oauth': 1800000 } },
  };
  for (const [provider, idleMs, providerCustom] of [
    ['openai-oauth', 1800000, true],
    ['anthropic-oauth', 7200000, false],
  ]) {
    const api = createSettingsApi({
      getConfig: () => config,
      getRoute: () => ({ provider }),
      hasOwn: (value, key) => Object.hasOwn(value, key),
      normalizeAutoClearConfig,
      normalizeCompactionConfig,
      resolveAutoClearIdleMs,
      autoClearIdleMsForProvider,
      autoClearProviderDefaults,
    });
    const result = api.getAutoClear();
    assert.equal(result.idleMs, idleMs);
    assert.equal(result.providerCustom, providerCustom);
  }
});
