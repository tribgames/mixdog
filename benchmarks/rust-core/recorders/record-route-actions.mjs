#!/usr/bin/env node
// Golden twin of the setup route actions (session-runtime/setup-tool/executor.mjs `set_route`,
// `set_agent_route`, session-route-actions.mjs): Node's real setup executor runs scenarios over
// recorded live sessions. Each case holds what the session layer knows (the caller's scope and
// fallback position, the sessions an action can reach), what Node answered, and the effects it
// produced (the caller's own route switch, the calls on the daemon's configure lane). The route
// itself of `set_route` / `set_agent_route` is the route services' (their own twins), so it is
// not compared. Rust `domains::ai_admin::route_actions` must equal it.
//
//   node benchmarks/rust-core/recorders/record-route-actions.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const orch = 'src/runtime/agent/orchestrator/session/';
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const live = await importFrom(tree, `${orch}store/live-state.mjs`);
const chain = await importFrom(tree, `${orch}manager/route-fallback-chain.mjs`);
const { sameRouteModel } = await importFrom(tree, `${orch}manager/owner-route-fallbacks.mjs`);
const { resolveSessionMode } = await importFrom(tree, `${orch}agent-mode.mjs`);
const { agentHomeSessionId } = await importFrom(tree, `${orch}agent-home.mjs`);
const { scheduleCallerScope } = await importFrom(tree, 'src/session-runtime/services/schedule-access.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const modelOf = (route) => ({ provider: route?.provider || '', model: route?.model || '' });
const CHAIN = [
  { provider: 'anthropic', model: 'opus' },
  { provider: 'google', model: 'gemini' },
];
const OTHER_CHAIN = [{ provider: 'google', model: 'gemini' }];
const LEAD_CONFIG = {
  default: 'workflow-lead',
  presets: [{ id: 'workflow-lead', name: 'WORKFLOW LEAD', provider: 'openai', model: 'gpt', effort: 'high', fallbacks: CHAIN }],
};
const BARE_CONFIG = { default: 'workflow-lead', presets: [{ ...LEAD_CONFIG.presets[0], fallbacks: undefined }] };
const HELPER_CONFIG = { ...LEAD_CONFIG, agents: { helper: { provider: 'openai', model: 'gpt', fallbacks: CHAIN } } };

const hopped = (id, agent = 'lead') => ({
  id,
  owner: 'user',
  agent,
  provider: 'anthropic',
  model: 'opus',
  routeFallbackIndex: 1,
  routeFallbackPrimary: { provider: 'openai', model: 'gpt', effort: 'high' },
  routeFallbackFailures: [{ provider: 'openai', model: 'gpt', kind: 'quota_exhausted', error: 'limit' }],
});
const fresh = (id, model = 'gpt', agent = 'lead') => ({ id, owner: 'user', agent, provider: 'openai', model });
const botHome = (agent) => ({ ...hopped(agentHomeSessionId(agent), agent) });

// The route a reset returns a session to, as session-route-actions.mjs reads it.
function primaryRoute(session, config) {
  if (session.routeFallbackPrimary?.provider) return chain.routeLeaf(session.routeFallbackPrimary);
  const primary = chain.sessionRoutePrimary(session);
  const source = chain.sessionChainSource(session, config);
  return source && sameRouteModel(source, primary) ? chain.routeLeaf(source) : chain.routeLeaf(primary);
}

const factsOf = (session, config) => ({
  id: session.id,
  actingAgent: resolveSessionMode({ session }).agentId || String(session.agent ?? '').trim(),
  current: modelOf(session),
  closed: session.closed === true,
  hopped: chain.routeFallbackHopped(session),
  primary: plain(primaryRoute(session, config)),
});

const cases = [];

async function record(name, { caller, config = LEAD_CONFIG, others = [], args, controlAnswer = true }) {
  const all = [caller, ...others];
  const records = Object.fromEntries(all.map((s) => [s.id, s]));
  // Every write the executor makes, in order, with the arguments it made it with. The stubs
  // answer the route they were given, so the answer's `route` is the executor's own input.
  const calls = { writes: [], control: [] };
  const rt = {
    setRoute: async (route, options) => {
      calls.writes.push(plain({ call: 'setRoute', route, options }));
      return route;
    },
    setAgentRoute: async (agent, route) => {
      calls.writes.push(plain({ call: 'setAgentRoute', agent, route }));
      return route;
    },
    getOrchestrationMode: () => 'none',
  };
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getConfig: () => config,
    getSessionId: () => caller.id,
    getCallerSession: (id) => records[id] || null,
    executeSessionControl: async (call, context) => {
      calls.control.push(plain({ call, context }));
      return controlAnswer;
    },
  });
  const added = all.filter((s) => s !== caller);
  for (const s of all) live.setLiveSession(s);
  let result;
  try {
    const out = JSON.parse(await executor.execute(args, { callerSessionId: caller.id }));
    // The receipt wrapper (saved, appliesTo, installation scope) is the setup service's.
    delete out.saved;
    delete out.appliesTo;
    if (out.scope === 'installation') delete out.scope;
    result = { value: out };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  } finally {
    for (const s of all) live._clearLiveSession(s.id);
  }
  const scope = scheduleCallerScope(caller);
  const agent = typeof args.agent === 'string' ? args.agent.trim() : '';
  // The chats of the agent a reset names: held here (home, room seats), then its home thread.
  const agentSessions = {};
  if (agent) agentSessions[agent] = all.filter((s) => resolveSessionMode({ session: s }).agentId === agent).map((s) => s.id);
  cases.push({
    name,
    args,
    config,
    controlAnswer,
    caller: { id: caller.id, scope: { kind: scope.kind, agentId: scope.agentId ?? null } },
    chain: caller.agent
      ? {
          position: plain(chain.routeFallbackPosition(caller, config)),
          sourceIsPrimary: sameRouteModel(chain.sessionChainSource(caller, config), chain.sessionRoutePrimary(caller)),
        }
      : null,
    sessions: all.map((s) => factsOf(s, config)),
    agentSessions,
    ...result,
    effects: { writes: calls.writes, control: calls.control.map(({ call }) => [call.session_id, call.method, call.input ?? null]) },
  });
  void added;
}

const callers = {
  hoppedLead: hopped('sess_lead_caller'),
  freshLead: fresh('sess_lead_caller'),
  previousLead: fresh('sess_lead_caller', 'old'),
  helperHome: botHome('helper'),
};

// Chain edit receipts.
for (const [cname, caller] of Object.entries(callers)) {
  for (const [config_name, config] of [['lead', LEAD_CONFIG], ['bare', BARE_CONFIG], ['helper', HELPER_CONFIG]]) {
    for (const [fname, fallbacks] of [['same', CHAIN], ['empty', []], ['other', OTHER_CHAIN]]) {
      await record(`set_route ${fname} chain: ${cname} on ${config_name}`, {
        caller, config, args: { action: 'set_route', route: { fallbacks } },
      });
      for (const agent of ['helper', 'lead', 'other']) {
        await record(`set_agent_route ${agent} ${fname} chain: ${cname} on ${config_name}`, {
          caller, config, args: { action: 'set_agent_route', agent, route: { fallbacks } },
        });
      }
    }
  }
  await record(`set_route without a chain: ${cname}`, {
    caller, args: { action: 'set_route', route: { effort: 'high' } },
  });
  await record(`set_agent_route without a chain: ${cname}`, {
    caller, args: { action: 'set_agent_route', agent: 'helper', route: { effort: 'high' } },
  });
}
// A route as the executor copies it (routeInput): every field it reads, and a chain that is not
// a list of routes.
const FALLBACK_SHAPES = [
  null, 'x', 5, true, {}, [null], ['x'], [5], [[]], [{}], [{ provider: ' a ', model: ' b ', effort: ' high ', fast: 'yes' }],
  [{ provider: 'a', model: 'b', fallbacks: null }], [{ provider: 'a', model: 'b', fallbacks: [{ provider: 'c' }] }],
  [{ provider: null, model: 7, modelParameters: { a: 1 }, contextPercent: 5, contextTokens: null, disabled: true, autoEffort: false }],
];
for (const fallbacks of FALLBACK_SHAPES) {
  await record(`set_route fallbacks ${JSON.stringify(fallbacks)}`, {
    caller: callers.hoppedLead, args: { action: 'set_route', route: { fallbacks } },
  });
  await record(`set_agent_route fallbacks ${JSON.stringify(fallbacks)}`, {
    caller: callers.hoppedLead, args: { action: 'set_agent_route', agent: 'helper', route: { fallbacks } },
  });
}
for (const route of [
  { provider: '', model: ' m ', effort: ' ', fast: true, autoEffort: 'no', modelParameters: { tier: 'x' }, contextPercent: 0, contextTokens: 100 },
  { provider: null }, { model: 5 }, { provider: ' p ' }, { effort: 'high', modelParameters: null }, { modelParameters: [1] },
]) {
  await record(`set_route fields ${JSON.stringify(route)}`, { caller: callers.hoppedLead, args: { action: 'set_route', route } });
  await record(`set_agent_route fields ${JSON.stringify(route)}`, {
    caller: callers.hoppedLead, args: { action: 'set_agent_route', agent: ' helper ', route },
  });
}
await record('set_agent_route needs an agent', { caller: callers.hoppedLead, args: { action: 'set_agent_route', agent: '  ', route: { fallbacks: [] } } });

// A session's return to its primary.
const other = hopped('sess_lead_other');
const stopped = fresh('sess_lead_stopped');
const closed = { ...hopped('sess_lead_closed'), closed: true };
const botChat = hopped(agentHomeSessionId('helper'), 'helper');
const roomSeat = { ...hopped('sess_room_seat', 'helper') };
for (const [cname, caller] of Object.entries(callers)) {
  const others = [other, stopped, closed, ...(cname === 'helperHome' ? [] : [botChat])];
  for (const args of [
    {},
    { sessionId: other.id },
    { sessionId: stopped.id },
    { sessionId: closed.id },
    { sessionId: 'sess_missing' },
    { sessionId: botChat.id },
    { agent: 'helper' },
    { agent: 'lead' },
    { agent: 'other' },
    { agent: '' },
    { agent: 'helper', sessionId: other.id },
  ]) {
    await record(`reset_route_fallback ${JSON.stringify(args)}: ${cname}`, {
      caller, others, args: { action: 'reset_route_fallback', ...args },
    });
  }
}
await record('reset_route_fallback in a config whose chain source is the primary', {
  caller: { ...hopped('sess_lead_caller'), routeFallbackPrimary: undefined },
  args: { action: 'reset_route_fallback' },
});
await record('reset_route_fallback of two chats of a bot', {
  caller: callers.hoppedLead,
  others: [botChat, roomSeat],
  args: { action: 'reset_route_fallback', agent: 'helper' },
});

// The quota card's actions.
for (const [cname, caller] of Object.entries(callers)) {
  for (const action of ['schedule_quota_resume', 'cancel_quota_resume', 'continue_in_model']) {
    for (const answer of [true, false]) {
      for (const sessionId of [stopped.id, other.id, caller.id, 'sess_missing', closed.id]) {
        const args = { action, sessionId };
        if (action === 'continue_in_model') {
          args.route = { provider: 'anthropic', model: 'opus', effort: 'low', fast: true };
        }
        await record(`${action} ${sessionId} answer ${answer}: ${cname}`, {
          caller, others: [other, stopped, closed], args, controlAnswer: answer,
        });
      }
    }
  }
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'route-actions-twin.json'), {
  domain: 'route-actions-twin',
  recorder: 'benchmarks/rust-core/recorders/record-route-actions.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-route-actions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-route-actions.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${cases.length} route-action cases (${cases.filter((c) => c.error).length} errors)`);
