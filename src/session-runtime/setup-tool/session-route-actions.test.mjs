// Setup's reads and writes of running sessions' fallback positions, their
// quota actions, and the per-agent switches; with the caller gates.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSetupToolExecutor } from './executor.mjs';
import { setLiveSession, _clearLiveSession } from '../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { createHumanGateStore, setHumanGateStore } from '../../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { createRouteControl } from '../../standalone/daemon-session-control/route-control.mjs';

const LEAD_CONFIG = {
  default: 'workflow-lead',
  presets: [
    {
      id: 'workflow-lead',
      name: 'WORKFLOW LEAD',
      provider: 'openai',
      model: 'gpt',
      effort: 'high',
      fallbacks: [
        { provider: 'anthropic', model: 'opus' },
        { provider: 'google', model: 'gemini' },
      ],
    },
  ],
};

// A Lead conversation that hopped once: from openai/gpt to anthropic/opus.
const hoppedLead = (id) => ({
  id,
  owner: 'user',
  agent: 'lead',
  provider: 'anthropic',
  model: 'opus',
  routeFallbackIndex: 1,
  routeFallbackPrimary: { provider: 'openai', model: 'gpt', effort: 'high' },
  routeFallbackFailures: [{ provider: 'openai', model: 'gpt', kind: 'quota_exhausted', error: 'limit' }],
});

function harness({
  caller = hoppedLead('sess_lead_caller'),
  sessions = {},
  api = {},
  control = true,
  config = LEAD_CONFIG,
} = {}) {
  const records = { [caller.id]: caller, ...sessions };
  const calls = { setRoute: [], control: [] };
  const rt = {
    setRoute: async (route, options) => {
      calls.setRoute.push({ route, options });
      return route;
    },
    listPresets: () => LEAD_CONFIG.presets,
    getOrchestrationMode: () => 'none',
    ...api,
  };
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getConfig: () => config,
    getSessionId: () => caller.id,
    getCallerSession: (id) => records[id] || null,
    ...(control
      ? {
          executeSessionControl: async (args, context) => {
            calls.control.push({ args, context });
            return true;
          },
        }
      : {}),
  });
  const run = async (args) => JSON.parse(await executor.execute(args, { callerSessionId: caller.id }));
  return { run, calls };
}

test('status model reports where this conversation and other Leads are on their chain', async (t) => {
  const other = hoppedLead('sess_lead_other');
  setLiveSession(other);
  t.after(() => _clearLiveSession(other.id));
  const { run } = harness();
  const model = await run({ action: 'status', domain: 'model' });
  assert.deepEqual(model.session.current, { provider: 'anthropic', model: 'opus' });
  assert.deepEqual(model.session.primary, { provider: 'openai', model: 'gpt' });
  assert.equal(model.session.onPrimary, false);
  assert.equal(model.session.fallbackIndex, 1);
  assert.deepEqual(model.session.next, { provider: 'google', model: 'gemini' });
  assert.equal(model.session.failures[0].kind, 'quota_exhausted');
  assert.deepEqual(
    model.sessions.map((row) => row.sessionId),
    ['sess_lead_other']
  );
  // A bot chat is listed under status agents, not model.
  const bot = { ...hoppedLead(agentHomeSessionId('helper')), agent: 'helper' };
  setLiveSession(bot);
  t.after(() => _clearLiveSession(bot.id));
  const agents = await run({ action: 'status', domain: 'agents' });
  assert.deepEqual(
    agents.sessions.map((row) => [row.sessionId, row.kind]),
    [[bot.id, 'bot']]
  );
});

test('a chain edit reports appliedToCurrentSession only for the route this conversation follows', async () => {
  const api = { setAgentRoute: async (_agent, route) => route };
  const chain = LEAD_CONFIG.presets[0].fallbacks;
  // Identical chains: the Lead's own edit applies, an unrelated bot's does not.
  const lead = harness({ api });
  assert.equal((await lead.run({ action: 'set_route', route: { fallbacks: chain } })).appliedToCurrentSession, true);
  assert.equal(
    (await lead.run({ action: 'set_agent_route', agent: 'helper', route: { fallbacks: chain } }))
      .appliedToCurrentSession,
    false
  );
  // Both chains empty: still only the Lead's own route.
  const bare = { default: 'workflow-lead', presets: [{ ...LEAD_CONFIG.presets[0], fallbacks: undefined }] };
  const onPrimary = { id: 'sess_lead_bare', owner: 'user', agent: 'lead', provider: 'openai', model: 'gpt' };
  const empty = harness({ caller: onPrimary, api, config: bare });
  assert.equal(
    (await empty.run({ action: 'set_agent_route', agent: 'helper', route: { fallbacks: [] } })).appliedToCurrentSession,
    false
  );
  assert.equal((await empty.run({ action: 'set_route', route: { fallbacks: [] } })).appliedToCurrentSession, true);
  // Still on the previous Lead model (saved Main moved to another one): it follows
  // no chain, so even an equal empty one is not applied to it.
  const previous = { ...onPrimary, id: 'sess_lead_previous', model: 'old' };
  const moved = harness({ caller: previous, api, config: bare });
  assert.equal((await moved.run({ action: 'set_route', route: { fallbacks: [] } })).appliedToCurrentSession, false);
});

test('reset_route_fallback returns this conversation to its primary through its own route switch', async () => {
  const { run, calls } = harness();
  const receipt = await run({ action: 'reset_route_fallback' });
  assert.equal(receipt.scope, 'session');
  assert.equal(receipt.saved, undefined);
  assert.match(receipt.appliesTo, /next turn/);
  assert.deepEqual(receipt.reset, [
    {
      sessionId: 'sess_lead_caller',
      from: { provider: 'anthropic', model: 'opus' },
      to: { provider: 'openai', model: 'gpt' },
    },
  ]);
  assert.deepEqual(calls.setRoute, [
    {
      route: { provider: 'openai', model: 'gpt', effort: 'high' },
      options: { sessionOnly: true, switchEstablished: true, deferUntilNextTurn: true },
    },
  ]);
  assert.deepEqual(calls.control, []);
});

test('reset_route_fallback reaches another session and every chat of a bot through the session lane', async (t) => {
  const other = hoppedLead('sess_lead_other');
  const home = { ...hoppedLead(agentHomeSessionId('helper')), agent: 'helper' };
  setLiveSession(home);
  t.after(() => _clearLiveSession(home.id));
  const { run, calls } = harness({ sessions: { [other.id]: other } });
  await run({ action: 'reset_route_fallback', sessionId: other.id });
  const receipt = await run({ action: 'reset_route_fallback', agent: 'helper' });
  assert.deepEqual(
    receipt.reset.map((row) => row.sessionId),
    [home.id]
  );
  assert.deepEqual(
    calls.control.map(({ args }) => [args.action, args.session_id, args.method, args.input.model]),
    [
      ['route', other.id, 'setRoute', 'gpt'],
      ['route', home.id, 'setRoute', 'gpt'],
    ]
  );
  // A session on its primary is left alone.
  const onPrimary = { id: 'sess_lead_fresh', owner: 'user', agent: 'lead', provider: 'openai', model: 'gpt' };
  const fresh = harness({ sessions: { [onPrimary.id]: onPrimary } });
  const unchanged = await fresh.run({ action: 'reset_route_fallback', sessionId: onPrimary.id });
  assert.deepEqual(unchanged.reset, []);
  assert.equal(unchanged.alreadyOnPrimary[0].sessionId, onPrimary.id);
  // Without a hosting daemon another session is out of reach.
  const local = harness({ sessions: { [other.id]: other }, control: false });
  await assert.rejects(local.run({ action: 'reset_route_fallback', sessionId: other.id }), /reachable only/);
});

test('quota actions round-trip on another session, never on the running caller', async () => {
  const stopped = { id: 'sess_lead_stopped', owner: 'user', agent: 'lead', provider: 'openai', model: 'gpt' };
  const { run, calls } = harness({ sessions: { [stopped.id]: stopped } });
  assert.equal((await run({ action: 'schedule_quota_resume', sessionId: stopped.id })).scheduled, true);
  assert.equal((await run({ action: 'cancel_quota_resume', sessionId: stopped.id })).cancelled, true);
  const continued = await run({
    action: 'continue_in_model',
    sessionId: stopped.id,
    route: { provider: 'anthropic', model: 'opus', effort: 'low' },
  });
  assert.equal(continued.continued, true);
  assert.deepEqual(
    calls.control.map(({ args }) => [args.method, args.input ?? null]),
    [
      ['scheduleQuotaResume', null],
      ['cancelQuotaResume', null],
      ['continueSessionInModel', { provider: 'anthropic', model: 'opus', effort: 'low' }],
    ]
  );
  await assert.rejects(run({ action: 'schedule_quota_resume', sessionId: 'sess_lead_caller' }), /another session/);
});

test('route control forwards only route fields, session-only, to another session', async () => {
  const configured = [];
  const control = createRouteControl(() => ({
    configureSession: async (request) => {
      configured.push(request);
      return { value: true };
    },
  }));
  await control(
    {
      session_id: 'sess_target',
      method: 'setRoute',
      input: { provider: 'openai', model: 'gpt', keepMainModel: false, applyToCurrentSession: true },
    },
    'sess_caller'
  );
  assert.deepEqual(configured[0], {
    sessionId: 'sess_target',
    action: 'setRoute',
    args: [{ provider: 'openai', model: 'gpt', sessionOnly: true }],
  });
  await assert.rejects(control({ session_id: 'sess_caller', method: 'setRoute', input: {} }, 'sess_caller'), /another/);
  await assert.rejects(control({ session_id: 'sess_target', method: 'deleteSession' }, 'sess_caller'), /unsupported/);
});

test('headless and other-agent callers stay blocked from session and agent writes', async () => {
  const worker = { id: 'sess_worker', owner: 'agent', agent: 'worker', parentSessionId: 'sess_lead_caller' };
  const headless = harness({ caller: worker });
  for (const args of [
    { action: 'reset_route_fallback' },
    { action: 'set_cache_warming_enabled', enabled: false },
    { action: 'set_agent_permission', agent: 'worker', actionKind: 'email', permissionMode: 'block' },
  ]) {
    await assert.rejects(headless.run(args), /background run cannot change settings/);
  }
  // Another bot's home thread manages only its own sessions and settings.
  const botHome = { id: agentHomeSessionId('helper'), owner: 'user', agent: 'helper', provider: 'p', model: 'm' };
  const lead = hoppedLead('sess_lead_other');
  const bot = harness({ caller: botHome, sessions: { [lead.id]: lead } });
  await assert.rejects(bot.run({ action: 'reset_route_fallback', sessionId: lead.id }), /only its own agent/);
  await assert.rejects(bot.run({ action: 'reset_route_fallback', agent: 'other' }), /only its own agent/);
  await assert.rejects(
    bot.run({ action: 'set_agent_connector', agent: 'other', name: 'gmail', enabled: false }),
    /only its own agent/
  );
  await assert.rejects(
    bot.run({ action: 'restore_definition', definitionKind: 'agent', name: 'old' }),
    /representative agent/
  );
});

test('agent settings round-trip; a change that widens what an agent may do is refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-setup-gate-'));
  setHumanGateStore(createHumanGateStore(dir));
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const writes = [];
  let warming = true;
  let order = [];
  const api = {
    getAgentConnectors: () => [{ id: 'gmail', enabled: true }],
    getAgentAlwaysAllowedTools: () => [],
    getProjectConnectors: (path) => [{ id: 'gmail', enabled: path === 'C:/p' }],
    setAgentConnectorEnabled: async (...args) => {
      writes.push(['agent', ...args]);
      return [{ id: 'gmail', enabled: args[2] }];
    },
    setAgentConnectorToolPermission: async (...args) => writes.push(['tool', ...args]),
    setProjectConnectorEnabled: (...args) => {
      writes.push(['project', ...args]);
      return [{ id: 'gmail', enabled: args[2] }];
    },
    restoreAgentDefinition: async (id) => writes.push(['restore', id]),
    getBotOrder: () => ({ order }),
    setBotOrder: (next) => {
      order = next;
      return { order };
    },
    getCacheWarmingSettings: () => ({ enabled: warming }),
    setCacheWarmingEnabled: (enabled) => {
      warming = enabled;
      return { enabled };
    },
    listAgents: () => [],
    getOrchestrationMode: () => 'none',
  };
  const caller = { id: 'sess_lead_human', owner: 'user' };
  const { run } = harness({ caller, api });
  const blocked = await run({
    action: 'set_agent_permission',
    agent: 'helper',
    actionKind: 'email',
    permissionMode: 'block',
  });
  assert.equal(blocked.permissions.find((row) => row.action === 'email').mode, 'block');
  await assert.rejects(
    run({ action: 'set_agent_permission', agent: 'helper', actionKind: 'email', permissionMode: 'allow' }),
    /widen/
  );
  const settings = await run({ action: 'read_agent_settings', agent: 'helper' });
  assert.equal(settings.permissions.find((row) => row.action === 'email').mode, 'block');
  assert.deepEqual(settings.connectors, [{ id: 'gmail', enabled: true }]);
  await run({ action: 'set_agent_connector', agent: 'helper', name: 'gmail', enabled: false });
  await run({
    action: 'set_agent_connector_tool',
    agent: 'helper',
    name: 'gmail',
    tool: 'send',
    permission: 'needs_approval',
  });
  await run({ action: 'set_project_connector', projectPath: 'C:/p', name: 'gmail', enabled: false });
  assert.deepEqual((await run({ action: 'read_project_connectors', projectPath: 'C:/p' })).connectors, [
    { id: 'gmail', enabled: true },
  ]);
  assert.deepEqual(writes.slice(0, 3), [
    ['agent', 'helper', 'gmail', false, { noWiden: true }],
    ['tool', 'helper', 'gmail', 'send', 'needs_approval', { noWiden: true }],
    ['project', 'C:/p', 'gmail', false, { noWiden: true }],
  ]);
  const restored = await run({ action: 'restore_definition', definitionKind: 'agent', name: 'old' });
  assert.equal(restored.restored, 'old');
  await assert.rejects(
    run({ action: 'restore_definition', definitionKind: 'workflow', name: 'w' }),
    /Only an archived agent/
  );
  assert.deepEqual((await run({ action: 'set_bot_order', botOrder: ['b', 'a'] })).botOrder, ['b', 'a']);
  assert.deepEqual((await run({ action: 'status', domain: 'agents' })).botOrder, ['b', 'a']);
  assert.equal((await run({ action: 'set_cache_warming_enabled', enabled: false })).promptCacheWarming, false);
  assert.equal((await run({ action: 'status', domain: 'compaction' })).promptCacheWarming, false);
});
