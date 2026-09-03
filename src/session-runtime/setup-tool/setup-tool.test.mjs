import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SETUP_ACTIONS, SETUP_OPEN_TARGETS, SETUP_STATUS_DOMAINS, SETUP_TOOL_DEFS } from './tool-defs.mjs';
import { createSetupToolExecutor } from './executor.mjs';
import { createNotificationBus } from '../notification-bus.mjs';
import { resolveTuiRuntimeNotificationDelivery } from '../../tui/session/notification-plan.mjs';
import { SLASH_COMMANDS as TUI_SLASH_COMMANDS } from '../../tui/app/slash-commands.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const run = async (executor, args) => JSON.parse(await executor.execute(args));

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
    assert.doesNotMatch(key, /key|token|secret|password/i);
  }
});

test('every open target is a slash command in both TUI and Desktop tables', () => {
  const tuiNames = new Set(TUI_SLASH_COMMANDS.flatMap((cmd) => [cmd.name, ...(cmd.aliases || [])]));
  const desktopSource = fs.readFileSync(
    path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'slash-commands.ts'),
    'utf8',
  );
  for (const target of SETUP_OPEN_TARGETS) {
    assert.ok(tuiNames.has(target), `TUI slash table lacks /${target}`);
    assert.match(desktopSource, new RegExp(`name: '${target}'`), `Desktop slash table lacks /${target}`);
  }
});

test('open: attached UI handles the request -> opened:true; headless -> guidance text', async () => {
  const sent = [];
  const attached = createSetupToolExecutor({
    getApi: () => ({}),
    getSessionId: () => 'sess-1',
    notifySessionUi: (sessionId, content, meta) => { sent.push({ sessionId, content, meta }); return true; },
  });
  const opened = await run(attached, { action: 'open', target: 'providers' });
  assert.equal(opened.opened, true);
  assert.equal(opened.target, 'providers');
  assert.deepEqual(sent, [{ sessionId: 'sess-1', content: 'Open /providers', meta: { kind: 'ui-open', command: 'providers' } }]);

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
    mgr: { enqueuePendingMessage(sessionId, message) { enqueued.push({ sessionId, message }); return 1; } },
  });
  assert.equal(bus.notifySessionUi('sess-x', 'Open /providers', { kind: 'ui-open', command: 'providers' }), false);
  assert.equal(enqueued.length, 0);

  const seen = [];
  bus.subscribeRuntimeNotification('sess-x', (event) => { seen.push(event); return true; });
  assert.equal(bus.notifySessionUi('sess-x', 'Open /providers', { kind: 'ui-open', command: 'providers' }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.command, 'providers');
  assert.equal(enqueued.length, 0);
  bus.clearRuntimeNotifications();
});

test('notification plan routes ui-open meta to the UI and never to the model', () => {
  const plan = resolveTuiRuntimeNotificationDelivery({ meta: { kind: 'ui-open', command: '/Providers' } }, 'Open /providers');
  assert.equal(plan.action, 'ui-open');
  assert.equal(plan.command, 'providers');
  assert.equal(plan.modelContent, undefined);
  assert.deepEqual(resolveTuiRuntimeNotificationDelivery({ meta: { kind: 'ui-open', command: '' } }, 'Open'), { action: 'ignore' });
});

test('status providers exposes connection state and key-console URL, never secrets', async () => {
  const executor = createSetupToolExecutor({
    getApi: () => ({
      async getProviderSetup() {
        return {
          pendingSecrets: false,
          api: [
            { id: 'openai', name: 'OpenAI', type: 'api', enabled: true, authenticated: false, url: 'https://platform.openai.com/api-keys', apiKey: 'sk-live', status: 'missing' },
            { id: 'x', name: 'X', type: 'api', enabled: true, authenticated: true, env: true, envName: 'X_KEY', url: 'javascript:alert(1)' },
          ],
          oauth: [{ id: 'anthropic', name: 'Anthropic', type: 'oauth', enabled: true, authenticated: true, accessToken: 't', refreshToken: 'r' }],
          local: [{ id: 'ollama', name: 'Ollama', type: 'local', enabled: false, detected: true, defaultURL: 'http://localhost:11434' }],
        };
      },
    }),
    getSessionId: () => '',
  });
  const status = await run(executor, { action: 'status', domain: 'providers' });
  assert.equal(status.domain, 'providers');
  assert.equal(status.api[0].keyUrl, 'https://platform.openai.com/api-keys');
  assert.equal(status.api[0].source, 'none');
  assert.equal(status.api[1].keyUrl, null);
  assert.equal(status.api[1].source, 'env:X_KEY');
  assert.equal(status.local[0].baseURL, 'http://localhost:11434');
  assert.doesNotMatch(JSON.stringify(status), /sk-live|accessToken|refreshToken|apiKey/);
  await assert.rejects(run(executor, { action: 'status', domain: 'secrets' }), /domain must be one of/);
});

test('mutations go through the runtime facade with validated input', async () => {
  const calls = [];
  const facade = {
    async setRoute(route) { calls.push(['setRoute', route]); return { provider: 'openai', model: 'gpt', ...route }; },
    async setAgentRoute(agent, route) { calls.push(['setAgentRoute', agent, route]); return route; },
    async setBuiltinToolEnabled(name, enabled) { calls.push(['setBuiltinToolEnabled', name, enabled]); return { name, enabled }; },
    setCompactionSettings(next) { calls.push(['setCompactionSettings', next]); return next; },
    async setDisabledSkills(list) { calls.push(['setDisabledSkills', list]); return { disabled: list }; },
  };
  const executor = createSetupToolExecutor({ getApi: () => facade, getSessionId: () => '' });

  const route = await run(executor, { action: 'set_route', route: { model: 'gpt-5' } });
  assert.deepEqual(calls[0], ['setRoute', { model: 'gpt-5' }]);
  assert.match(route.appliesTo, /next session/);

  await run(executor, { action: 'set_agent_route', agent: 'worker', route: { provider: '' } });
  assert.deepEqual(calls[1], ['setAgentRoute', 'worker', { provider: '' }]);

  await run(executor, { action: 'set_builtin_enabled', name: 'office', enabled: false });
  assert.deepEqual(calls[2], ['setBuiltinToolEnabled', 'office', false]);
  await assert.rejects(run(executor, { action: 'set_builtin_enabled', name: 'memory', enabled: true }), /name must be one of git, office/);
  await assert.rejects(run(executor, { action: 'set_builtin_enabled', name: 'git', enabled: 'yes' }), /enabled \(boolean\)/);

  await run(executor, { action: 'set_compaction', enabled: true });
  assert.deepEqual(calls[3], ['setCompactionSettings', { auto: true }]);

  await run(executor, { action: 'set_disabled_skills', skills: [' a ', '', 'b'] });
  assert.deepEqual(calls[4], ['setDisabledSkills', ['a', 'b']]);

  await assert.rejects(run(executor, { action: 'set_route', route: {} }), /at least one of/);
  await assert.rejects(run(executor, { action: 'set_agent_route', route: { model: 'x' } }), /agent is required/);
});

test('mutations fail clearly before the runtime facade is assembled', async () => {
  const executor = createSetupToolExecutor({ getApi: () => null, getSessionId: () => '' });
  await assert.rejects(run(executor, { action: 'set_workflow', workflow: 'default' }), /runtime facade is not ready/);
});

test('setup skill documents every tool action and open target', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'src', 'defaults', 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: setup$/m);
  assert.match(skill, /^description: .*`setup` tool/m);
  for (const action of SETUP_ACTIONS) {
    assert.ok(skill.includes('`' + action + '`'), `SKILL.md does not document action ${action}`);
  }
  for (const target of SETUP_OPEN_TARGETS) {
    assert.ok(new RegExp('(?<![\\w-])' + target + '(?![\\w-])').test(skill), `SKILL.md does not list open target ${target}`);
  }
  assert.match(skill, /Extensions/);
  assert.doesNotMatch(skill, /Settings\s*→\s*(MCP|Skills|Plugins)\b/, 'MCP/Skills/Plugins live under Extensions, not Settings');
});