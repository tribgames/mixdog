import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  parseDurationMs,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { createMcpGlue } from '../mcp-glue.mjs';
import {
  resolveMcpStartupTimeoutMs,
  resolveMcpCallTimeoutMs,
} from '../../runtime/agent/orchestrator/mcp/client-config.mjs';
import { createResourceApi } from '../resource-api.mjs';
import { isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { schemaValueError } from '../../runtime/shared/schema-value-error.mjs';
import { saveSchedule } from '../services/channel-admin.mjs';
import { createStandaloneHookBus } from '../services/hook-bus.mjs';

// The caller is an ordinary Lead session (the human's own) unless a test says otherwise.
const LEAD_CALLER = { id: 'sess_lead_fixture', owner: 'user' };
const run = async (api, args, options = {}) =>
  JSON.parse(
    await createSetupToolExecutor({
      getApi: () => api,
      getCallerSession: (id) => (id === LEAD_CALLER.id ? LEAD_CALLER : null),
      ...options,
    }).execute(args, { callerSessionId: LEAD_CALLER.id })
  );

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
  await run(api, { action: 'set_route', route: { autoEffort: false } });
  assert.deepEqual(calls.at(-1), { autoEffort: false });
  await run(agentApi, { action: 'set_agent_route', agent: 'worker', route: { autoEffort: true } });
  assert.deepEqual(agentCalls.at(-1), ['worker', { autoEffort: true }]);
  await assert.rejects(run(api, { action: 'set_web_search_route', route: { autoEffort: false } }), /only accepted/);
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
    getSessionGeneration: () => 0,
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

function mcpScopedFixture(t, initial = {}) {
  let config = { mcpServers: initial };
  const calls = [];
  const glue = createMcpGlue({ getConfig: () => config, getCurrentCwd: () => process.cwd(), mcpClient: {}, state: {} });
  const api = createResourceApi({
    getConfig: () => config,
    getCurrentCwd: () => process.cwd(),
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    getMcpServerConfig: glue.getMcpServerConfig,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    connectConfiguredMcp: async (opts) => {
      calls.push(opts);
      return { servers: [] };
    },
    mcpStatus: () => ({ servers: [] }),
    awaitKeychainPrewarm: async () => {},
    reloadFullConfig: () => {},
    invalidatePreSessionToolSurface: () => {},
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  return { api, calls, getConfig: () => config };
}

test('MCP startup/tool timeouts round-trip through add and save', async (t) => {
  const { api, getConfig } = mcpScopedFixture(t);
  await run(api, {
    action: 'add_mcp_server',
    server: { name: 'slow', command: 'node', startupTimeoutSec: 30, toolTimeoutSec: 300 },
  });
  assert.equal(getConfig().mcpServers.slow.startupTimeoutSec, 30);
  assert.equal(getConfig().mcpServers.slow.timeoutMs, 300000);
  await run(api, { action: 'save_mcp_server', server: { name: 'slow', cwd: 'x' } });
  assert.equal(getConfig().mcpServers.slow.startupTimeoutSec, 30);
  assert.equal(getConfig().mcpServers.slow.timeoutMs, 300000);
  await run(api, { action: 'save_mcp_server', server: { name: 'slow', toolTimeoutSec: 5 } });
  assert.equal(getConfig().mcpServers.slow.timeoutMs, 5000);
  assert.equal(getConfig().mcpServers.slow.startupTimeoutSec, 30);
  await assert.rejects(
    run(api, { action: 'add_mcp_server', server: { name: 'bad', command: 'node', toolTimeoutSec: -1 } })
  );
});

test('saving a timeout replaces conflicting aliases; unrelated saves keep disabled timeouts', async (t) => {
  const { api, getConfig } = mcpScopedFixture(t, {
    old: { command: 'node', startupTimeoutMs: 10000, timeout_ms: 7000, callTimeoutMs: 8000 },
    off: { command: 'node', startupTimeoutMs: 0, timeoutMs: 'off' },
  });
  await run(api, { action: 'save_mcp_server', server: { name: 'old', startupTimeoutSec: 90, toolTimeoutSec: 20 } });
  assert.equal(resolveMcpStartupTimeoutMs(getConfig().mcpServers.old, {}), 90000);
  assert.equal(resolveMcpCallTimeoutMs(getConfig().mcpServers.old, {}), 20000);
  await run(api, { action: 'save_mcp_server', server: { name: 'off', cwd: 'x' } });
  assert.equal(getConfig().mcpServers.off.startupTimeoutMs, 0);
  assert.equal(getConfig().mcpServers.off.timeoutMs, 'off');
  assert.equal(resolveMcpStartupTimeoutMs(getConfig().mcpServers.off, {}), 0);
});

test('adding, removing or reconnecting one MCP server only addresses that server', async (t) => {
  const { api, calls } = mcpScopedFixture(t, { keep: { command: 'node' }, other: { command: 'node' } });
  await run(api, { action: 'add_mcp_server', server: { name: 'fresh', command: 'node' } });
  // Each scoped change ends with a reconcile, which reconnects only servers
  // whose resolved config changed. None of them may open a login.
  assert.deepEqual(calls, [{ only: 'fresh', enabled: true }, { reconcile: true }]);
  calls.length = 0;
  await run(api, { action: 'reconnect_mcp', name: 'other' });
  assert.deepEqual(calls, [{ only: 'other', enabled: true }, { reconcile: true }]);
  calls.length = 0;
  await run(api, { action: 'remove_mcp_server', name: 'fresh' });
  assert.deepEqual(calls, [{ only: 'fresh', enabled: false }, { reconcile: true }]);
  calls.length = 0;
  await run(api, { action: 'reconnect_mcp' });
  assert.deepEqual(calls, [{ reset: true }]);
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

test("a schedule or webhook takes no model: every run is a turn in its bot's chat", async () => {
  for (const automationKind of ['schedule', 'webhook']) {
    await assert.rejects(
      run(
        { saveSchedule },
        {
          action: 'save_automation',
          automationKind,
          entry: { name: 'with-model', instructions: 'Test', model: 'openai/gpt-5' },
        }
      ),
      /does not accept field\(s\): model/
    );
  }
});

test('automation partial edits preserve the owner, one-shot timing and attachments; signing secrets never reach receipts', async () => {
  const attachment = { kind: 'text', name: 'keep.txt', data: 'attachment-canary' };
  const entry = {
    name: 'fixture',
    instructions: 'Keep prompt',
    owner: 'reviewer',
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
  assert.equal(received.owner, 'reviewer');
  assert.equal(Object.hasOwn(received, 'model'), false);
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
    sections: [
      { id: 'providers', options: [{ id: 'risky', label: 'Risky', warning: 'Account risk.' }, { id: 'plain' }] },
    ],
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

test('an agent cannot turn on Allow all actions, even with riskAccepted; it may turn it off', async () => {
  const calls = [];
  const view = {
    sections: [
      {
        id: 'approvals',
        options: [{ id: 'allowAllActions', label: 'Allow all actions', warning: 'Skips approvals.' }],
      },
    ],
  };
  const api = {
    getDeveloperSettings: () => view,
    setDeveloperOption: async (id, enabled) => {
      calls.push([id, enabled]);
      return view;
    },
  };
  for (const extra of [{ riskAccepted: true }, { riskAccepted: false }, {}]) {
    await assert.rejects(
      run(api, { action: 'set_developer_option', name: 'allowAllActions', enabled: true, ...extra }),
      /only the person can turn it on in Settings → Developer options/
    );
  }
  assert.deepEqual(calls, []);
  await run(api, { action: 'set_developer_option', name: 'allowAllActions', enabled: false });
  assert.deepEqual(calls, [['allowAllActions', false]]);
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
    {
      name: 'builtin-skill',
      description: 'Shipped',
      editable: false,
      toolDependencies: [{ type: 'tool', value: 'setup' }],
    },
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
  assert.deepEqual(saved.at(-1), {
    originalName: 'builtin-skill',
    dependenciesOnly: true,
    toolDependencies: dependencies,
  });
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

test('Desktop schema accepts notification volume and appearance view options within their bounds', () => {
  const { desktop, appearance } = SETUP_TOOL_DEFS[0].inputSchema.properties;
  assert.equal(schemaValueError({ notificationVolume: 400 }, desktop, 'desktop'), null);
  assert.match(schemaValueError({ notificationVolume: 401 }, desktop, 'desktop'), /at most 400/);
  assert.match(schemaValueError({ notificationVolume: 1.5 }, desktop, 'desktop'), /integer/);
  const valid = { markdownDefaultView: 'rich', linkPreview: false, toolActivityExpansion: 'commands' };
  assert.equal(schemaValueError(valid, appearance, 'appearance'), null);
  assert.match(schemaValueError({ markdownDefaultView: 'raw' }, appearance, 'appearance'), /must be one of/);
  assert.match(schemaValueError({ toolActivityExpansion: 'some' }, appearance, 'appearance'), /must be one of/);
  assert.match(schemaValueError({ linkPreview: 'yes' }, appearance, 'appearance'), /boolean/);
});

test('status features passes Auto Effort readiness and voice state through', async () => {
  const autoEffort = { supported: false, enabled: false, installed: false, installing: true, ready: false, info: {} };
  const voice = { enabled: true, installed: false, components: { whisper: true, model: false, ffmpeg: true } };
  const api = {
    getToolModuleSettings: () => ({ autoEffort, git: { enabled: true, installed: true, ready: true } }),
    getVoiceStatus: async () => ({ ...voice, busy: true, modelId: 'standard', info: {} }),
  };
  const features = await run(api, { action: 'status', domain: 'features' });
  assert.deepEqual(features.autoEffort, {
    supported: false,
    enabled: false,
    installed: false,
    installing: true,
    ready: false,
  });
  assert.deepEqual(features.git, { enabled: true, installed: true });
  assert.deepEqual(features.voice, { ...voice, installing: true });
});

test('voice toggles and installs through the runtime voice setter without a Desktop', async () => {
  const components = { whisper: true, model: true, ffmpeg: true };
  let state = { enabled: false, installed: false, components: { whisper: false, model: false, ffmpeg: false } };
  let failure = null;
  const calls = [];
  const api = {
    setVoiceEnabled: async (enabled) => {
      calls.push(enabled);
      if (failure) return { status: { ...state, busy: false }, error: failure };
      state = enabled ? { enabled: true, installed: true, components } : { ...state, enabled: false };
      return { status: { ...state, busy: false, info: {} }, error: null };
    },
  };
  const executor = createSetupToolExecutor({ getApi: () => api, getSessionId: () => '' });
  const exec = async (args) => JSON.parse(await executor.execute(args));
  const installed = await exec({ action: 'install_builtin', name: 'voice' });
  assert.deepEqual(installed.voice, { enabled: true, installed: true, components });
  assert.equal(installed.saved, true);
  const off = await exec({ action: 'set_builtin_enabled', name: 'voice', enabled: false });
  assert.deepEqual(off.voice, { enabled: false, installed: true, components });
  failure = 'Voice setup failed: offline';
  await assert.rejects(
    exec({ action: 'set_builtin_enabled', name: 'voice', enabled: true }),
    /installed and enabled state: Voice setup failed: offline/
  );
  await assert.rejects(exec({ action: 'set_builtin_enabled', name: 'voice', enabled: 'yes' }), /boolean/);
  assert.deepEqual(calls, [true, false, true]);
});

test('hook rules: status shape, validated add/toggle/delete reach the facade', async () => {
  const calls = [];
  let rules = [
    { index: 0, enabled: true, tool: 'bash', action: 'deny', match: 'rm -rf', cwd: null, reason: null, patch: null },
  ];
  const api = {
    hooksStatus: () => ({
      enabled: true,
      configMode: 'legacy',
      rulesPath: '/h.json',
      ruleCount: rules.length,
      rules,
      recent: [{ args: 'private' }],
    }),
    addHookRule: (rule) => {
      calls.push(['add', rule]);
      rules = [...rules, { index: rules.length, ...rule }];
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      calls.push(['enable', index, enabled]);
      return rules;
    },
    flushHookRules: () => calls.push(['flush']),
    deleteHookRule: (index) => {
      calls.push(['delete', index]);
      rules = rules.filter((row) => row.index !== index);
      return rules;
    },
  };
  const status = await run(api, { action: 'status', domain: 'hooks' });
  assert.equal(status.ruleCount, 1);
  assert.deepEqual(status.rules[0].tool, 'bash');
  assert.equal(Object.hasOwn(status, 'recent'), false);
  const rule = { tool: 'write', action: 'modify', patch: { dryRun: true } };
  const added = await run(api, { action: 'add_hook_rule', hookRule: rule });
  assert.equal(added.saved, true);
  assert.equal(added.rules.length, 2);
  await run(api, { action: 'set_hook_rule_enabled', ruleIndex: 1, enabled: false });
  const removed = await run(api, { action: 'delete_hook_rule', ruleIndex: 0 });
  assert.equal(removed.deleted.tool, 'bash');
  assert.match(removed.recovery, /add_hook_rule/);
  assert.deepEqual(calls, [['add', rule], ['enable', 1, false], ['flush'], ['delete', 0]]);
  for (const hookRule of [
    { tool: 'x' },
    { action: 'explode' },
    { action: 'deny', tool: ' ' },
    { action: 'deny', patch: { a: 1 } },
    { action: 'modify' },
    { action: 'modify', patch: {}, args: {} },
    { action: 'deny', extra: true },
  ])
    await assert.rejects(run(api, { action: 'add_hook_rule', hookRule }));
  await assert.rejects(run(api, { action: 'set_hook_rule_enabled', ruleIndex: 9, enabled: true }), /not found/);
  await assert.rejects(run(api, { action: 'delete_hook_rule', ruleIndex: -1 }), /at least 0/);
  await assert.rejects(run(api, { action: 'delete_hook_rule', ruleIndex: 7 }), /not found/);
  assert.equal(calls.length, 4);
});

test('hook rule argument edits never reach setup output; only their presence is reported', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-setup-hooks-'));
  const bus = createStandaloneHookBus({ dataDir });
  t.after(async () => {
    bus.flushRules();
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = {
    hooksStatus: bus.status,
    addHookRule: bus.addRule,
    setHookRuleEnabled: bus.setRuleEnabled,
    flushHookRules: bus.flushRules,
    deleteHookRule: bus.deleteRule,
  };
  const outputs = [
    await run(api, {
      action: 'add_hook_rule',
      hookRule: {
        tool: 'bash',
        action: 'modify',
        patch: { command: 'curl -H "Authorization: Bearer sk-patch-canary"' },
      },
    }),
    await run(api, {
      action: 'add_hook_rule',
      hookRule: { tool: 'write', action: 'rewrite', args: { token: 'sk-args-canary' } },
    }),
    await run(api, { action: 'add_hook_rule', hookRule: { tool: 'read', action: 'deny' } }),
    await run(api, { action: 'set_hook_rule_enabled', ruleIndex: 1, enabled: false }),
  ];
  const status = await run(api, { action: 'status', domain: 'hooks' });
  assert.deepEqual(
    status.rules.map(({ tool, hasArgumentEdit, enabled }) => [tool, hasArgumentEdit, enabled]),
    [
      ['bash', true, true],
      ['write', true, false],
      ['read', false, true],
    ]
  );
  outputs.push(status, await run(api, { action: 'delete_hook_rule', ruleIndex: 0 }));
  for (const output of outputs) assert.doesNotMatch(JSON.stringify(output), /canary|patch|"args"/);
  assert.equal(typeof bus.status().rules[0].patch, 'object', 'other summarizeRule consumers keep the field');
  assert.notEqual(bus.status().rules[0].patch, null);
});

test('media defaults: status reports the pin; set_media_default pins, clears and validates against the catalog', async () => {
  const calls = [];
  const pins = { image: null, video: null };
  const lanes = [
    { id: 'gemini', label: 'Gemini', authenticated: true, image: { models: [{ id: 'nano' }] }, video: null },
    {
      id: 'oa',
      label: 'OpenAI',
      authType: 'oauth',
      authProvider: 'openai-oauth',
      authenticated: true,
      image: { models: [{ id: 'gpt-image-2' }] },
      video: null,
    },
    { id: 'grok', label: 'Grok', authenticated: false, image: null, video: null },
  ];
  const api = {
    getMediaDefault: async (kind) => (kind === 'image' ? { kind, lane: 'gemini', model: 'nano' } : null),
    getMediaPins: async () => ({ ...pins }),
    getProviderAccounts: (id) => ({ accounts: id === 'openai-oauth' ? [{ id: 'a1' }, { id: 'a2' }] : [] }),
    listMediaLanes: async () => lanes,
    setMediaPin: async (input) => {
      calls.push(input);
      pins[input.kind] = input.lane
        ? { kind: input.kind, lane: input.lane, model: input.model ?? '', account: input.account ?? '' }
        : null;
      return pins[input.kind];
    },
  };
  let status = await run(api, { action: 'status', domain: 'media' });
  assert.deepEqual(status.pinned, { image: null, video: null });
  assert.deepEqual(status.remembered, { image: { lane: 'gemini', model: 'nano' }, video: null });
  const saved = await run(api, { action: 'set_media_default', kind: 'image', lane: 'gemini', model: 'nano' });
  assert.equal(saved.media.lane, 'gemini');
  assert.equal(saved.media.model, 'nano');
  await run(api, { action: 'set_media_default', kind: 'image', lane: 'oa', accountId: 'a2' });
  status = await run(api, { action: 'status', domain: 'media' });
  assert.deepEqual(status.pinned.image, { lane: 'oa', model: '', account: 'a2' });
  const cleared = await run(api, { action: 'set_media_default', kind: 'image', lane: '' });
  assert.equal(cleared.media, null);
  assert.deepEqual((await run(api, { action: 'status', domain: 'media' })).pinned, { image: null, video: null });
  assert.deepEqual(calls, [
    { kind: 'image', lane: 'gemini', model: 'nano', account: undefined },
    { kind: 'image', lane: 'oa', model: undefined, account: 'a2' },
    { kind: 'image', lane: '' },
  ]);
  for (const [args, pattern] of [
    [{ kind: 'skills', lane: 'gemini' }, /kind must be one of image, video/],
    [{ kind: 'audio', lane: 'gemini' }, /must be one of/],
    [{ kind: 'image', lane: 'missing' }, /Unknown media lane/],
    [{ kind: 'image', lane: 'grok' }, /not signed in/],
    [{ kind: 'video', lane: 'gemini' }, /no video models/],
    [{ kind: 'image', lane: 'gemini', model: 'other' }, /not available/],
    [{ kind: 'image', lane: '', model: 'nano' }, /need a lane/],
    [{ kind: 'image', lane: 'gemini', accountId: 'a1' }, /no accounts/],
    [{ kind: 'image', lane: 'oa', accountId: 'zz' }, /Unknown openai-oauth account/],
  ])
    await assert.rejects(run(api, { action: 'set_media_default', ...args }), pattern);
  assert.equal(calls.length, 3);
});

test('worktree settings: status reads defaults, set_worktree_settings patches and rejects invalid values', async () => {
  let config = { worktree: { autoCleanup: false }, profile: { title: 'unchanged' } };
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
  });
  const status = await run(api, { action: 'status', domain: 'worktree' });
  assert.deepEqual(status, {
    domain: 'worktree',
    newTaskDefault: 'branch',
    branchPrefix: 'mixdog/',
    sizeWarnBytes: 2 * 1024 ** 3,
    autoCleanup: false,
  });
  const saved = await run(api, {
    action: 'set_worktree_settings',
    worktree: { newTaskDefault: 'worktree', branchPrefix: 'agents/' },
  });
  assert.equal(saved.newTaskDefault, 'worktree');
  assert.equal(saved.saved, true);
  assert.deepEqual(config.worktree, {
    newTaskDefault: 'worktree',
    branchPrefix: 'agents/',
    sizeWarnBytes: 2 * 1024 ** 3,
    autoCleanup: false,
  });
  assert.deepEqual(config.profile, { title: 'unchanged' });
  for (const worktree of [{}, { newTaskDefault: 'on' }, { sizeWarnBytes: -1 }, { other: true }]) {
    await assert.rejects(run(api, { action: 'set_worktree_settings', worktree }));
  }
  await assert.rejects(run(api, { action: 'set_worktree_settings', worktree: { branchPrefix: 'no-slash' } }), /ending/);
  assert.equal(config.worktree.branchPrefix, 'agents/');
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
      formatDurationMs: String,
    });
    const result = api.getAutoClear();
    assert.equal(result.idleMs, idleMs);
    assert.equal(result.providerCustom, providerCustom);
  }
});

test('Desktop schema accepts font, skin transparency and color theme options', () => {
  const { appearance } = SETUP_TOOL_DEFS[0].inputSchema.properties;
  const valid = { uiFont: 'Inter', codeFont: '', skinTransparency: 0, colorTheme: 'builtin' };
  assert.equal(schemaValueError(valid, appearance, 'appearance'), null);
  assert.match(schemaValueError({ skinTransparency: 101 }, appearance, 'appearance'), /at most 100/);
  assert.match(schemaValueError({ skinTransparency: -1 }, appearance, 'appearance'), /at least 0/);
  assert.match(schemaValueError({ skinTransparency: 50.5 }, appearance, 'appearance'), /integer/);
  assert.equal(
    schemaValueError({ skinOuterTransparency: 0, skinMainTransparency: 100 }, appearance, 'appearance'),
    null
  );
  assert.match(schemaValueError({ skinOuterTransparency: 101 }, appearance, 'appearance'), /at most 100/);
  assert.match(schemaValueError({ skinMainTransparency: -1 }, appearance, 'appearance'), /at least 0/);
  assert.match(schemaValueError({ skinMainTransparency: 1.5 }, appearance, 'appearance'), /integer/);
  assert.match(schemaValueError({ uiFont: 3 }, appearance, 'appearance'), /string/);
});

test('Desktop schema accepts the device appearance and bot overlay options within their bounds', () => {
  const { appearance, desktop } = SETUP_TOOL_DEFS[0].inputSchema.properties;
  const valid = {
    timeFormat: '24h',
    sidePanelPosition: 'auto',
    uiScale: 0.85,
    codeSize: 20,
    codeLigatures: false,
    chatTextSize: 'extra-large',
  };
  assert.equal(schemaValueError(valid, appearance, 'appearance'), null);
  assert.match(schemaValueError({ timeFormat: '36h' }, appearance, 'appearance'), /must be one of/);
  assert.match(schemaValueError({ sidePanelPosition: 'left' }, appearance, 'appearance'), /must be one of/);
  assert.match(schemaValueError({ chatTextSize: 'huge' }, appearance, 'appearance'), /must be one of/);
  assert.match(schemaValueError({ uiScale: 1.3 }, appearance, 'appearance'), /at most 1.2/);
  assert.match(schemaValueError({ uiScale: 0.5 }, appearance, 'appearance'), /at least 0.85/);
  assert.match(schemaValueError({ codeSize: 9 }, appearance, 'appearance'), /at least 10/);
  assert.match(schemaValueError({ codeSize: 12.5 }, appearance, 'appearance'), /integer/);
  assert.match(schemaValueError({ codeLigatures: 'no' }, appearance, 'appearance'), /boolean/);
  const botOverlay = {
    enabled: true,
    position: 'pinnedHere',
    keepAbove: true,
    collapsed: false,
    autoAdvance: false,
    autoClose: true,
    scale: 200,
  };
  assert.equal(schemaValueError({ botOverlay }, desktop, 'desktop'), null);
  assert.match(schemaValueError({ botOverlay: { position: 'left' } }, desktop, 'desktop'), /must be one of/);
  assert.match(schemaValueError({ botOverlay: { scale: 105 } }, desktop, 'desktop'), /must be one of/);
  assert.match(schemaValueError({ botOverlay: { pinned: true } }, desktop, 'desktop'), /does not accept/);
});

test('auto-clear unlimited reaches the provider window; a bare unlimited means the current route provider', async () => {
  let config = { autoClear: { enabled: true, idleMs: null, providerIdleMs: {}, minContextPercent: 10 } };
  const api = createSettingsApi({
    getConfig: () => config,
    getRoute: () => ({ provider: 'openai' }),
    getSession: () => null,
    getSessionGeneration: () => 0,
    hasOwn: (value, key) => Object.hasOwn(value, key),
    normalizeAutoClearConfig,
    normalizeCompactionConfig,
    resolveAutoClearIdleMs,
    autoClearIdleMsForProvider,
    autoClearProviderDefaults,
    parseDurationMs,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    formatDurationMs: String,
    invalidateContextStatusCache: () => {},
  });
  const status = await run(api, { action: 'set_autoclear', autoclear: { duration: 'unlimited' } });
  assert.deepEqual(config.autoClear.providerIdleMs, { openai: 0 });
  assert.equal(status.unlimited, true);
  assert.equal(status.label, 'unlimited');
  await run(api, { action: 'set_autoclear', autoclear: { provider: 'gemini', duration: 'never' } });
  assert.deepEqual(config.autoClear.providerIdleMs, { openai: 0, gemini: 0 });
  await run(api, { action: 'set_autoclear', autoclear: { provider: 'openai', duration: '30m' } });
  assert.equal(config.autoClear.providerIdleMs.openai, 1800000);
  assert.equal(api.getAutoClear().unlimited, false);
  const codex = api.getAutoClear.call(api);
  assert.equal(codex.provider, 'openai');
  assert.equal(autoClearProviderDefaults(null).find((row) => row.provider === 'openai-oauth').unlimited, true);
});

test('context settings round-trip: compaction onModelChange/summaryMode and AI session titles through status compaction', async () => {
  let config = { compaction: { auto: true }, aiSessionTitles: true };
  const session = { compaction: {} };
  const api = createSettingsApi({
    getConfig: () => config,
    getSession: () => session,
    getSessionGeneration: () => 0,
    hasOwn: (value, key) => Object.hasOwn(value, key),
    normalizeAutoClearConfig,
    normalizeCompactionConfig,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    formatDurationMs: (value) => String(value),
    invalidateContextStatusCache: () => {},
  });
  let status = await run(api, { action: 'status', domain: 'compaction' });
  assert.equal(status.onModelChange, true);
  assert.equal(status.summaryMode, 'smart');
  assert.equal(status.aiSessionTitles, true);
  await run(api, { action: 'set_compaction', compaction: { onModelChange: false, summaryMode: 'self' } });
  await run(api, { action: 'set_ai_session_titles', enabled: false });
  status = await run(api, { action: 'status', domain: 'compaction' });
  assert.equal(status.onModelChange, false);
  assert.equal(status.summaryMode, 'self');
  assert.equal(status.aiSessionTitles, false);
  assert.equal(config.aiSessionTitles, false);
  await assert.rejects(run(api, { action: 'set_compaction', compaction: { summaryMode: 'bogus' } }), /summaryMode/);
  await assert.rejects(run(api, { action: 'set_ai_session_titles', enabled: 'no' }), /enabled/);
});

test('quota auto-resume, model preferences and the Lead route fallbacks round-trip', async () => {
  let autoResume = true;
  const prefs = {};
  const calls = [];
  const fallbacks = [{ provider: 'anthropic', model: 'backup' }];
  const api = {
    getQuotaAutoResume: () => autoResume,
    setQuotaAutoResume: (value) => (autoResume = value),
    getProviderSetup: async () => ({ api: [], oauth: [], local: [] }),
    setModelPreferences: (provider, changes) => {
      calls.push([provider, changes]);
      Object.assign(prefs, changes[0]);
      return { provider, changed: 1 };
    },
    listProviderModels: async () => [
      {
        provider: 'openai',
        id: 'm1',
        ...(typeof prefs.hidden === 'boolean' ? { savedHidden: prefs.hidden } : {}),
        ...(prefs.favorite ? { favorite: true } : {}),
      },
    ],
    listPresets: () => [{ id: 'workflow-lead', provider: 'openai', model: 'm1', fallbacks }],
    autoEffort: false,
    provider: 'openai',
    model: 'm1',
  };
  assert.equal((await run(api, { action: 'status', domain: 'providers' })).quotaAutoResume, true);
  await run(api, { action: 'set_quota_auto_resume', enabled: false });
  assert.equal((await run(api, { action: 'status', domain: 'providers' })).quotaAutoResume, false);
  await run(api, { action: 'set_model_preferences', provider: 'openai', model: 'm1', hidden: true, favorite: true });
  assert.deepEqual(calls, [['openai', [{ model: 'm1', hidden: true, favorite: true }]]]);
  const row = (await run(api, { action: 'list_models', catalog: { provider: 'openai' } })).models[0];
  assert.equal(row.hidden, true);
  assert.equal(row.favorite, true);
  const detail = (await run(api, { action: 'list_models', catalog: { provider: 'openai', model: 'm1' } })).model;
  assert.equal(detail.hidden, true);
  await run(api, { action: 'set_model_preferences', provider: 'openai', model: 'm1', hidden: false });
  assert.equal(
    (await run(api, { action: 'list_models', catalog: { provider: 'openai', model: 'm1' } })).model.hidden,
    false
  );
  await assert.rejects(run(api, { action: 'set_model_preferences', provider: 'openai', model: 'm1' }), /hidden or favorite/);
  const model = await run(api, { action: 'status', domain: 'model' });
  assert.equal(model.route.autoEffort, false);
  assert.deepEqual(model.route.fallbacks, fallbacks);
});
