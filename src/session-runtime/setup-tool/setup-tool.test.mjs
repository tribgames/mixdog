import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SETUP_ACTIONS,
  SETUP_BUILTIN_TOGGLE_FEATURES,
  SETUP_OPEN_TARGETS,
  SETUP_SECTION_OPEN_TARGETS,
  SETUP_STATUS_DOMAINS,
  SETUP_TOOL_DEFS,
} from './tool-defs.mjs';
import { SETUP_SECTION_TARGETS as TUI_SECTION_TARGETS } from '../../tui/app/use-ui-open-request.mjs';
import { createSetupToolExecutor } from './executor.mjs';
import { SETUP_OUTPUT_MAX_BYTES } from '../../runtime/shared/tool-output-limit.mjs';
import { createNotificationBus } from '../notification-bus.mjs';
import { resolveTuiRuntimeNotificationDelivery } from '../../tui/session/notification-plan.mjs';
import { SLASH_COMMANDS as TUI_SLASH_COMMANDS } from '../../tui/app/slash-commands.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const run = async (executor, args) => JSON.parse(await executor.execute(args));

test('feature and summary status omit details retained by dedicated domains', async () => {
  const localProvider = {
    enabled: true,
    installed: true,
    hardware: { gpu: 'GPU' },
    models: ['model'],
    disk: { availableBytes: 123 },
  };
  const memory = { enabled: true, installed: true, info: { model: 'embedding' } };
  const executor = createSetupToolExecutor({
    getApi: () => ({
      getToolModuleSettings: () => ({ git: { enabled: true, installed: true }, localProvider, memory }),
    }),
  });
  const features = await run(executor, { action: 'status', domain: 'features' });
  assert.deepEqual(features.localProvider, { enabled: true, installed: true });
  assert.deepEqual(features.memory, { enabled: true, installed: true });
  assert.deepEqual(features.git, { enabled: true, installed: true });
  assert.equal(typeof features.terminal.active, 'boolean');
  const summary = await run(executor, { action: 'status', domain: 'summary' });
  assert.deepEqual(summary.features.localProvider, features.localProvider);
  const local = await run(executor, { action: 'status', domain: 'local-provider' });
  assert.deepEqual(local.hardware, localProvider.hardware);
  assert.deepEqual(local.models, localProvider.models);
  const details = await run(executor, { action: 'status', domain: 'memory' });
  assert.deepEqual(details.info, memory.info);
});

test('set_instruction_files validates the mode and features status reports it', async () => {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      getToolModuleSettings: () => ({ instructionFiles: 'claude', git: { enabled: true, installed: true } }),
      setInstructionFiles: async (mode) => {
        calls.push(mode);
        return { instructionFiles: mode };
      },
    }),
  });
  const result = await run(executor, { action: 'set_instruction_files', instructionFiles: 'agents' });
  assert.deepEqual(calls, ['agents']);
  assert.equal(result.instructionFiles, 'agents');
  await assert.rejects(
    run(executor, { action: 'set_instruction_files', instructionFiles: 'some' }),
    /instructionFiles must be one of:? all, agents, claude, off/
  );
  const features = await run(executor, { action: 'status', domain: 'features' });
  assert.equal(features.instructionFiles, 'claude');
});

test('set_auto_effort_base validates the level', async () => {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      setAutoEffortBase: async (level) => {
        calls.push(level);
        return { autoEffortBase: level };
      },
    }),
  });
  assert.equal(
    (await run(executor, { action: 'set_auto_effort_base', autoEffortBase: 'high' })).autoEffortBase,
    'high'
  );
  assert.deepEqual(calls, ['high']);
  await assert.rejects(
    run(executor, { action: 'set_auto_effort_base', autoEffortBase: 'max' }),
    /autoEffortBase must be one of/
  );
});

test('tool definition: schema enums mirror the exported action/domain/target lists', () => {
  assert.equal(SETUP_TOOL_DEFS.length, 1);
  const [def] = SETUP_TOOL_DEFS;
  assert.equal(def.name, 'setup');
  assert.deepEqual(def.inputSchema.properties.action.enum, [...SETUP_ACTIONS]);
  assert.deepEqual(def.inputSchema.properties.domain.enum, [...SETUP_STATUS_DOMAINS]);
  assert.deepEqual(def.inputSchema.properties.target.enum, [...SETUP_OPEN_TARGETS]);
  assert.equal(def.annotations.agentHidden, true);
  // Secrets never travel through this schema.
  for (const key of Object.keys(def.inputSchema.properties)) {
    // A one-use deletion receipt is not an authentication credential.
    if (key === 'confirmationToken') continue;
    assert.doesNotMatch(key, /key|token|secret|password/i);
  }
});

test('every open target is a slash command or a settings section routed by both TUI and Desktop', () => {
  const tuiNames = new Set(TUI_SLASH_COMMANDS.flatMap((cmd) => [cmd.name, ...(cmd.aliases || [])]));
  const renderer = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer');
  const desktopSource = fs.readFileSync(path.join(renderer, 'slash-commands.ts'), 'utf8');
  const desktopSections = fs.readFileSync(path.join(renderer, 'app-shell-ui-open-request.ts'), 'utf8');
  for (const target of SETUP_OPEN_TARGETS) {
    if (SETUP_SECTION_OPEN_TARGETS.includes(target)) {
      assert.ok(!tuiNames.has(target), `/${target} is a slash command, not a section target`);
      assert.match(desktopSections, new RegExp(`^\\s+${target}: '`, 'm'), `Desktop does not route ${target}`);
      continue;
    }
    assert.ok(tuiNames.has(target), `TUI slash table lacks /${target}`);
    assert.match(desktopSource, new RegExp(`name: '${target}'`), `Desktop slash table lacks /${target}`);
  }
  assert.deepEqual(Object.keys(TUI_SECTION_TARGETS).sort(), [...SETUP_SECTION_OPEN_TARGETS].sort());
});

test('TUI section targets open their surface or explain a Desktop-only one', () => {
  const calls = [];
  const sections = {
    openDeveloperPicker: () => calls.push('developer'),
    openSettingsPicker: () => calls.push('settings'),
    pushNotice: (text) => calls.push(text),
  };
  for (const target of SETUP_SECTION_OPEN_TARGETS) TUI_SECTION_TARGETS[target](sections);
  assert.deepEqual(calls.slice(0, 2), ['developer', 'settings']);
  assert.match(calls[2], /Desktop app: Settings → Connection/);
});

test('a saved mutation tells attached surfaces to re-read; reads and failures do not', async () => {
  const sent = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      setMemoryToolsEnabled: (enabled) => ({ enabled }),
      setRecapEnabled: () => {
        throw new Error('recap store failed');
      },
    }),
    getSessionId: () => 'sess-1',
    notifySessionUi: (sessionId, content, meta) => {
      sent.push({ sessionId, content, meta });
      return true;
    },
  });
  await run(executor, { action: 'set_memory_enabled', enabled: false });
  await run(executor, { action: 'open', target: 'memory' });
  await assert.rejects(executor.execute({ action: 'set_recap_enabled', enabled: true }), /recap store failed/);
  assert.deepEqual(
    sent.filter((entry) => entry.meta.kind === 'setup-changed'),
    [
      {
        sessionId: 'sess-1',
        content: 'Settings changed',
        meta: { kind: 'setup-changed', action: 'set_memory_enabled' },
      },
    ]
  );
  assert.deepEqual(resolveTuiRuntimeNotificationDelivery({ meta: sent[0].meta }, sent[0].content), {
    action: 'setup-changed',
    setupAction: 'set_memory_enabled',
  });
});

test('open: attached UI handles the request -> opened:true; headless -> guidance text', async () => {
  const sent = [];
  const attached = createSetupToolExecutor({
    getApi: () => ({}),
    getSessionId: () => 'sess-1',
    notifySessionUi: (sessionId, content, meta) => {
      sent.push({ sessionId, content, meta });
      return true;
    },
  });
  const opened = await run(attached, { action: 'open', target: 'providers' });
  assert.equal(opened.opened, true);
  assert.equal(opened.target, 'providers');
  assert.deepEqual(sent, [
    { sessionId: 'sess-1', content: 'Open /providers', meta: { kind: 'ui-open', command: 'providers' } },
  ]);

  const headless = createSetupToolExecutor({
    getApi: () => ({}),
    getSessionId: () => 'sess-2',
    notifySessionUi: () => false,
  });
  const fallback = await run(headless, { action: 'open', target: 'mcp' });
  assert.equal(fallback.opened, false);
  assert.match(fallback.note, /No interactive UI/);
  assert.match(fallback.note, /Extensions/);
  assert.match(fallback.note, /\/mcp/);

  await assert.rejects(run(headless, { action: 'open', target: 'https://evil.example' }), /target must be one of/);
  await assert.rejects(run(headless, { action: 'nuke' }), /action must be one of/);
});

test('open never enqueues into the model queue when no UI listener is attached', () => {
  const enqueued = [];
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: {
      enqueuePendingMessage(sessionId, message) {
        enqueued.push({ sessionId, message });
        return 1;
      },
    },
  });
  assert.equal(bus.notifySessionUi('sess-x', 'Open /providers', { kind: 'ui-open', command: 'providers' }), false);
  assert.equal(enqueued.length, 0);

  const seen = [];
  bus.subscribeRuntimeNotification('sess-x', (event) => {
    seen.push(event);
    return true;
  });
  assert.equal(bus.notifySessionUi('sess-x', 'Open /providers', { kind: 'ui-open', command: 'providers' }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.command, 'providers');
  assert.equal(enqueued.length, 0);
  bus.clearRuntimeNotifications();
});

test('notification plan routes ui-open meta to the UI and never to the model', () => {
  const plan = resolveTuiRuntimeNotificationDelivery(
    { meta: { kind: 'ui-open', command: '/Providers' } },
    'Open /providers'
  );
  assert.equal(plan.action, 'ui-open');
  assert.equal(plan.command, 'providers');
  assert.equal(plan.modelContent, undefined);
  assert.deepEqual(resolveTuiRuntimeNotificationDelivery({ meta: { kind: 'ui-open', command: '' } }, 'Open'), {
    action: 'ignore',
  });
});

test('status providers exposes connection state and key-console URL, never secrets', async () => {
  const executor = createSetupToolExecutor({
    getApi: () => ({
      async getProviderSetup() {
        return {
          pendingSecrets: false,
          api: [
            {
              id: 'openai',
              name: 'OpenAI',
              type: 'api',
              enabled: true,
              authenticated: false,
              url: 'https://platform.openai.com/api-keys',
              apiKey: 'sk-live',
              status: 'missing',
            },
            {
              id: 'x',
              name: 'X',
              type: 'api',
              enabled: true,
              authenticated: true,
              env: true,
              envName: 'X_KEY',
              custom: true,
              url: 'javascript:alert(1)',
            },
          ],
          oauth: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              type: 'oauth',
              enabled: true,
              authenticated: true,
              accessToken: 't',
              refreshToken: 'r',
            },
          ],
          local: [],
        };
      },
      getProviderAccounts: () => ({
        provider: 'anthropic',
        auto: true,
        selectedId: 'a1',
        accounts: [
          {
            id: 'a1',
            label: 'Work',
            authenticated: true,
            reauthRequired: false,
            identity: 'person@example.test',
            usage: { percent: 40 },
          },
        ],
      }),
    }),
    getSessionId: () => '',
  });
  const status = await run(executor, { action: 'status', domain: 'providers', detail: true });
  assert.deepEqual(status.oauth[0].accounts, {
    selectedId: 'a1',
    auto: true,
    useCredits: false,
    accounts: [{ id: 'a1', label: 'Work', authenticated: true, reauthRequired: false }],
  });
  assert.equal(status.domain, 'providers');
  assert.equal(status.api[0].keyUrl, 'https://platform.openai.com/api-keys');
  assert.equal(status.api[0].source, 'none');
  assert.equal(status.api[1].keyUrl, null);
  assert.equal(status.api[1].source, 'env:X_KEY');
  assert.equal(status.api[0].custom, false);
  assert.equal(status.api[1].custom, true);
  assert.deepEqual(status.local, []);
  assert.doesNotMatch(JSON.stringify(status), /sk-live|accessToken|refreshToken|apiKey/);
  await assert.rejects(run(executor, { action: 'status', domain: 'secrets' }), /domain must be one of/);
});

test('status providers is minimal by default: configured providers only, account counts', async () => {
  const executor = createSetupToolExecutor({
    getApi: () => ({
      getProviderSetup: async () => ({
        api: [
          { id: 'openai', type: 'api', authenticated: false, status: 'missing', url: 'https://k.test' },
          { id: 'xai', type: 'api', authenticated: true, status: 'ok', stored: true, url: 'https://x.test' },
        ],
        oauth: [
          { id: 'anthropic', type: 'oauth', authenticated: true, status: 'ok', expiresAt: 1, plan: 'pro' },
          { id: 'cursor', type: 'oauth', authenticated: false, reauthRequired: true, status: 'expired' },
          { id: 'gemini', type: 'oauth', authenticated: false, status: 'missing' },
        ],
        local: [],
      }),
      getProviderAccounts: () => ({ selectedId: 'a', accounts: [{ id: 'a' }, { id: 'b' }] }),
    }),
  });
  const raw = await executor.execute({ action: 'status', domain: 'providers' });
  assert.deepEqual(JSON.parse(raw), {
    domain: 'providers',
    providers: [
      { id: 'xai', kind: 'api', authenticated: true, status: 'ok' },
      { id: 'anthropic', kind: 'oauth', authenticated: true, status: 'ok', plan: 'pro', accounts: 2 },
      {
        id: 'cursor',
        kind: 'oauth',
        authenticated: false,
        status: 'expired',
        plan: null,
        reauthRequired: true,
        accounts: 0,
      },
    ],
    notConfigured: 2,
  });
  assert.equal(raw, JSON.stringify(JSON.parse(raw)), 'read-only results are compact JSON');
  const detail = await run(executor, { action: 'status', domain: 'providers', detail: true });
  assert.equal(detail.api.length, 2);
  assert.equal(detail.api[0].keyUrl, 'https://k.test');
  assert.equal(detail.oauth[0].accounts.accounts.length, 2);
});

const catalogRow = (provider, id, extra = {}) => ({
  id,
  provider,
  display: `${id} display`,
  contextWindow: 200000,
  maxContextWindow: null,
  supportsVision: false,
  fastCapable: false,
  effortOptions: [
    { value: 'low', label: 'Low', description: '' },
    { value: 'high', label: 'High', description: '' },
  ],
  reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
  modelParameterOptions: [],
  parameterVariants: [],
  serviceTiers: [],
  defaultModelParameters: {},
  ...extra,
});

function catalogExecutor(rows) {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      listProviderModels: async (options) => (calls.push(['all', options]), rows),
      listWebSearchModels: async (options) => (
        calls.push(['web', options]), rows.filter((row) => row.supportsWebSearch)
      ),
    }),
  });
  return { calls, executor };
}

test('list_models: provider index, compact paged rows, and single-model detail', async () => {
  const many = Array.from({ length: 30 }, (_, i) => catalogRow('deepseek', `m${String(i).padStart(2, '0')}`));
  const rows = [
    ...many,
    catalogRow('openai', 'gpt-x', {
      maxContextWindow: 1000000,
      supportsVision: true,
      fastCapable: true,
      fastEfforts: ['low'],
      defaultEffort: 'high',
      serviceTiers: [{ id: 'priority' }],
      modelParameterOptions: [{ id: 'speed', values: ['standard', 'ultra'] }],
      parameterVariants: [{ id: 'v1' }],
      supportsWebSearch: true,
    }),
    catalogRow('other', 'gpt-x'),
  ];
  const { calls, executor } = catalogExecutor(rows);

  const index = await run(executor, { action: 'list_models' });
  assert.deepEqual(index.providers, [
    { provider: 'deepseek', count: 30, defaultModel: 'deepseek-v4-pro' },
    { provider: 'openai', count: 1 },
    { provider: 'other', count: 1 },
  ]);
  assert.deepEqual(calls[0], ['all', { refresh: false }]);

  const first = await run(executor, { action: 'list_models', catalog: { provider: 'deepseek' } });
  assert.equal(first.total, 30);
  assert.equal(first.page, 1);
  assert.equal(first.pages, 2);
  assert.equal(first.nextPage, 2);
  assert.equal(first.models.length, 25);
  assert.deepEqual(first.models[0], { id: 'm00', display: 'm00 display', context: 200000, efforts: ['low', 'high'] });
  const second = await run(executor, { action: 'list_models', catalog: { provider: 'deepseek', page: 2, limit: 25 } });
  assert.deepEqual(
    second.models.map((row) => row.id),
    ['m25', 'm26', 'm27', 'm28', 'm29']
  );
  assert.equal(second.nextPage, undefined);
  const small = await run(executor, { action: 'list_models', catalog: { provider: 'deepseek', limit: 10, page: 3 } });
  assert.equal(small.models.length, 10);
  assert.equal(small.models[0].id, 'm20');

  const openai = await run(executor, { action: 'list_models', catalog: { provider: 'openai' } });
  assert.deepEqual(openai.models[0], {
    id: 'gpt-x',
    display: 'gpt-x display',
    context: 200000,
    maxContext: 1000000,
    efforts: ['low', 'high'],
    fast: true,
    vision: true,
  });

  const detail = await run(executor, { action: 'list_models', catalog: { model: 'gpt-x', provider: 'openai' } });
  assert.deepEqual(detail.model, {
    provider: 'openai',
    id: 'gpt-x',
    display: 'gpt-x display',
    context: 200000,
    maxContext: 1000000,
    vision: true,
    webSearch: true,
    effortOptions: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
    defaultEffort: 'high',
    fastCapable: true,
    fastEfforts: ['low'],
    serviceTiers: [{ id: 'priority' }],
    modelParameterOptions: [{ id: 'speed', values: ['standard', 'ultra'] }],
    parameterVariants: [{ id: 'v1' }],
  });
  await assert.rejects(
    run(executor, { action: 'list_models', catalog: { model: 'gpt-x' } }),
    /offered by openai, other; pass catalog.provider/
  );
  await assert.rejects(run(executor, { action: 'list_models', catalog: { model: 'nope' } }), /not found/);

  const web = await run(executor, { action: 'list_models', catalog: { webSearch: true, refresh: true } });
  assert.deepEqual(web.providers, [{ provider: 'openai', count: 1 }]);
  assert.deepEqual(calls.at(-1), ['web', { refresh: true }]);
});

test('list_models: a full page stays far below the setup output budget and is compact', async () => {
  const rows = Array.from({ length: 204 }, (_, i) =>
    catalogRow('big', `model-with-a-long-identifier-${i}`, {
      description: 'x'.repeat(400),
      modelParameterOptions: [{ id: 'p', values: ['a', 'b', 'c'] }],
    })
  );
  const { executor } = catalogExecutor(rows);
  const raw = await executor.execute({ action: 'list_models', catalog: { provider: 'big', limit: 100 } });
  assert.ok(Buffer.byteLength(raw) < SETUP_OUTPUT_MAX_BYTES, `${raw.length} bytes`);
  assert.equal(raw, JSON.stringify(JSON.parse(raw)));
  await assert.rejects(
    executor.execute({ action: 'list_models', catalog: { provider: 'big', limit: 101 } }),
    /tool-input-validation/
  );
});

test('mutations go through the runtime facade with validated input', async () => {
  const calls = [];
  const facade = {
    async setRoute(route) {
      calls.push(['setRoute', route]);
      return { provider: 'openai', model: 'gpt', ...route };
    },
    async setAgentRoute(agent, route) {
      calls.push(['setAgentRoute', agent, route]);
      return route;
    },
    async setBuiltinToolEnabled(name, enabled) {
      calls.push(['setBuiltinToolEnabled', name, enabled]);
      return { name, enabled };
    },
    async installBuiltinFeature(name) {
      calls.push(['installBuiltinFeature', name]);
      return { [name]: { enabled: true, installed: true } };
    },
    setCompactionSettings(next) {
      calls.push(['setCompactionSettings', next]);
      return next;
    },
    async setDisabledSkills(list) {
      calls.push(['setDisabledSkills', list]);
      return { disabled: list };
    },
  };
  const executor = createSetupToolExecutor({ getApi: () => facade, getSessionId: () => '' });

  const route = await run(executor, { action: 'set_route', route: { model: 'gpt-5' } });
  assert.deepEqual(calls[0], ['setRoute', { model: 'gpt-5' }]);
  assert.match(route.appliesTo, /next session/);

  const agentRoute = await run(executor, { action: 'set_agent_route', agent: 'worker', route: { provider: '' } });
  assert.deepEqual(calls[1], ['setAgentRoute', 'worker', { provider: '' }]);
  assert.match(agentRoute.appliesTo, /chats from their next turn/);
  assert.doesNotMatch(agentRoute.appliesTo, /new sessions/);

  await run(executor, { action: 'set_builtin_enabled', name: 'office', enabled: false });
  assert.deepEqual(calls[2], ['setBuiltinToolEnabled', 'office', false]);
  await run(executor, { action: 'set_builtin_enabled', name: 'localProvider', enabled: true });
  assert.deepEqual(calls[3], ['setBuiltinToolEnabled', 'localProvider', true]);
  await assert.rejects(
    run(executor, { action: 'set_builtin_enabled', name: 'memory', enabled: true }),
    /name must be one of git, office, tidy, localProvider/
  );
  // Terminal follows the Desktop terminal bridge; it has no persisted toggle.
  await assert.rejects(
    run(executor, { action: 'set_builtin_enabled', name: 'terminal', enabled: true }),
    /name must be one of/
  );
  await assert.rejects(
    run(executor, { action: 'set_builtin_enabled', name: 'git', enabled: 'yes' }),
    /enabled must be a boolean/
  );

  await run(executor, { action: 'set_compaction', enabled: true });
  assert.deepEqual(calls[4], ['setCompactionSettings', { auto: true }]);

  await run(executor, { action: 'set_disabled_skills', skills: [' a ', '', 'b'] });
  assert.deepEqual(calls[5], ['setDisabledSkills', ['a', 'b']]);

  await assert.rejects(run(executor, { action: 'set_route', route: {} }), /at least one of/);
  await assert.rejects(run(executor, { action: 'set_agent_route', route: { model: 'x' } }), /agent is required/);

  // Code tidy installs and toggles through the same two settings-api methods
  // office uses, so the setup tool can activate it without the desktop UI.
  const installed = await run(executor, { action: 'install_builtin', name: 'tidy' });
  assert.deepEqual(calls.at(-1), ['installBuiltinFeature', 'tidy']);
  assert.deepEqual(installed.tidy, { enabled: true, installed: true });
  assert.equal(installed.saved, true);
  await run(executor, { action: 'set_builtin_enabled', name: 'tidy', enabled: false });
  assert.deepEqual(calls.at(-1), ['setBuiltinToolEnabled', 'tidy', false]);
  await assert.rejects(
    run(executor, { action: 'install_builtin', name: 'shell' }),
    /name must be one of git, memory, office, tidy, localProvider/
  );
  assert.ok(SETUP_BUILTIN_TOGGLE_FEATURES.includes('tidy'));
});

test('mutations fail clearly before the runtime facade is assembled', async () => {
  const executor = createSetupToolExecutor({ getApi: () => null, getSessionId: () => '' });
  await assert.rejects(run(executor, { action: 'set_workflow', workflow: 'default' }), /runtime facade is not ready/);
});

test('setup skill documents every tool action and open target', () => {
  const skillRoot = path.join(repoRoot, 'src', 'defaults', 'skills', 'setup');
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const references = fs
    .readdirSync(path.join(skillRoot, 'references'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => fs.readFileSync(path.join(skillRoot, 'references', name), 'utf8'));
  const documentation = [skill, ...references].join('\n');
  assert.match(skill, /^name: setup$/m);
  assert.match(skill, /^description: .*\bsetup tool\b/m);
  for (const action of SETUP_ACTIONS) {
    assert.ok(documentation.includes(`\`${action}\``), `setup docs do not document action ${action}`);
  }
  for (const target of SETUP_OPEN_TARGETS) {
    assert.ok(
      new RegExp(`(?<![\\w-])${target}(?![\\w-])`).test(documentation),
      `setup docs do not list open target ${target}`
    );
  }
  assert.match(documentation, /Extensions/);
  assert.doesNotMatch(
    documentation,
    /Settings\s*→\s*(MCP|Skills|Plugins)\b/,
    'MCP/Skills/Plugins live under Extensions, not Settings'
  );
});

test('remote setup-tool statuses retain desktop ownership and never read or mutate server accounts', async () => {
  const forbidden = () => assert.fail('server account roster must stay untouched');
  const executor = createSetupToolExecutor({
    getApi: () => ({
      getProviderSetup: async () => ({
        managedByClient: true,
        oauth: [
          { id: 'openai-oauth', authenticated: true, status: 'Connected' },
          { id: 'anthropic-oauth', authenticated: false, status: 'Not connected' },
        ],
      }),
      getProviderAccounts: forbidden,
      forgetProviderAuth: forbidden,
      updateProviderAccounts: forbidden,
    }),
  });
  assert.deepEqual(await run(executor, { action: 'status', domain: 'providers' }), {
    domain: 'providers',
    managedByClient: true,
    unavailable: false,
    providers: [{ id: 'openai-oauth', kind: 'oauth', authenticated: true, status: 'Connected', plan: null }],
    notConfigured: 1,
  });
  const detail = await run(executor, { action: 'status', domain: 'providers', detail: true });
  assert.equal(detail.managedByClient, true);
  assert.equal(detail.oauth[0].accounts, undefined);
  await assert.rejects(run(executor, { action: 'forget_provider_auth', name: 'openai-oauth' }), /local desktop window/);
  await assert.rejects(
    run(executor, { action: 'set_provider_account', name: 'openai-oauth', providerAccount: { selectedId: 'x' } }),
    /local desktop window/
  );
});
