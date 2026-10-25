import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENDED_SETUP_HANDLERS } from './extended-actions.mjs';
import { createSetupToolExecutor } from './executor.mjs';
import { assertInteractiveCaller, scheduleCallerScope } from '../services/schedule-access.mjs';
import { sessionMatchesContext } from '../services/agent-tool/helpers.mjs';
import { markUnattendedRun } from '../held-requests.mjs';
import { markHeartbeatSession } from '../../runtime/shared/routine-trigger.mjs';

const WEBHOOKS = [{ name: 'hook', enabled: true, hasLastPayload: true }];

function runtime(schedules = [], webhooks = WEBHOOKS) {
  const saved = [];
  const ran = [];
  const toggled = [];
  const deleted = [];
  const defined = [];
  return {
    saved,
    ran,
    toggled,
    deleted,
    defined,
    rt: {
      getChannelSetup: async () => ({ schedules, webhooks }),
      listAgents: async () => [{ id: 'reviewer' }, { id: 'writer' }],
      saveSchedule: async (entry) => {
        saved.push(entry);
        return entry;
      },
      saveWebhook: async (entry) => {
        saved.push(entry);
        return entry;
      },
      setScheduleEnabled: async (name, enabled) => toggled.push([name, enabled]),
      setWebhookEnabled: async (name, enabled) => toggled.push([name, enabled]),
      deleteSchedule: async (name) => deleted.push(name),
      deleteWebhook: async (name) => deleted.push(name),
      runScheduleNow: async (name) => {
        ran.push(name);
        return new Promise(() => {});
      },
      runWebhookNow: async (name) => {
        ran.push(`webhook:${name}`);
        return new Promise(() => {});
      },
      saveAgentDefinition: async (definition) => defined.push(definition),
      setOrchestrationMode: async (mode) => defined.push(mode),
      getOrchestrationMode: () => 'auto',
    },
  };
}

const entry = { name: 'pr-sweep', time: '0 9 * * 1-5', instructions: 'Tidy up PRs' };
const home = (agentId) => ({ sessionId: `sess_home_${agentId}`, caller: { id: `sess_home_${agentId}` } });
const LEAD = { sessionId: 'sess_0193', caller: { id: 'sess_0193', owner: 'user', sourceType: 'lead' } };
const HEADLESS = {
  schedule: { sessionId: 'sess_run', caller: { id: 'sess_run', owner: 'user', sourceType: 'schedule' } },
  webhook: { sessionId: 'sess_hook', caller: { id: 'sess_hook', owner: 'user', sourceType: 'webhook' } },
  delegated: { sessionId: 'sess_worker', caller: { id: 'sess_worker', owner: 'agent', parentSessionId: 'sess_0193' } },
  unresolved: { sessionId: 'sess_gone', caller: null },
};
const save = (rt, input, context) =>
  EXTENDED_SETUP_HANDLERS.save_automation(rt, { automationKind: 'schedule', entry: input }, context);

test('caller provenance: home threads, the human, and headless runs', () => {
  assert.deepEqual(scheduleCallerScope({ id: 'sess_home_lead' }), { kind: 'human' });
  assert.deepEqual(scheduleCallerScope({ id: 'sess_home_reviewer' }), { kind: 'agent', agentId: 'reviewer' });
  assert.deepEqual(scheduleCallerScope({ id: 'sess_1', owner: 'cli' }), { kind: 'human' });
  assert.deepEqual(scheduleCallerScope(LEAD.caller), { kind: 'human' });
  for (const { caller } of Object.values(HEADLESS)) {
    assert.deepEqual(scheduleCallerScope(caller), { kind: 'headless' });
  }
});

test("Mixy's marked heartbeat session runs in her unattended scope; a forged or other exec session stays headless", (t) => {
  const stored = { sourceType: 'exec', sourceName: 'heartbeat', ownerAgentId: 'lead' };
  const heartbeat = { id: 'sess_daemon_hb', ...stored };
  const forged = { id: 'sess_daemon_forged', ...stored };
  const other = { id: 'sess_daemon_x', sourceType: 'exec', sourceName: 'cron', ownerAgentId: 'lead' };
  const run = { kind: 'schedule', agentId: 'lead', name: 'heartbeat' };
  const unmark = [heartbeat, forged, other].map((session) => markUnattendedRun(session.id, run));
  markHeartbeatSession(heartbeat.id);
  t.after(() => {
    for (const fn of unmark) fn();
    markHeartbeatSession(heartbeat.id, true);
  });
  assert.deepEqual(scheduleCallerScope(heartbeat), { kind: 'agent', agentId: 'lead', unattended: true });
  assert.deepEqual(scheduleCallerScope(forged), { kind: 'headless' });
  assert.deepEqual(scheduleCallerScope(other), { kind: 'headless' });
});

test('an unattended run in a home chat is scoped to its own bot, checked before the home id', (t) => {
  const unmarkMixy = markUnattendedRun('sess_home_lead', { kind: 'schedule', agentId: 'lead', name: 'morning' });
  const unmarkBot = markUnattendedRun('sess_home_reviewer', { kind: 'webhook', agentId: 'reviewer', name: 'hook' });
  // A run never widens a scope: a background or mismatched session stays headless.
  const unmarkRun = markUnattendedRun('sess_run', { kind: 'schedule', agentId: 'reviewer', name: 'x' });
  const unmarkOther = markUnattendedRun('sess_home_writer', { kind: 'schedule', agentId: 'reviewer', name: 'x' });
  t.after(() => {
    for (const unmark of [unmarkMixy, unmarkBot, unmarkRun, unmarkOther]) unmark();
  });
  assert.deepEqual(scheduleCallerScope({ id: 'sess_home_lead' }), { kind: 'agent', agentId: 'lead', unattended: true });
  assert.deepEqual(scheduleCallerScope({ id: 'sess_home_reviewer' }), {
    kind: 'agent',
    agentId: 'reviewer',
    unattended: true,
  });
  assert.deepEqual(scheduleCallerScope(HEADLESS.schedule.caller), { kind: 'headless' });
  assert.deepEqual(scheduleCallerScope({ id: 'sess_home_writer' }), { kind: 'headless' });
  // Its own bot's automations and route stay open to it; global settings do not.
  const scope = scheduleCallerScope({ id: 'sess_home_reviewer' });
  for (const action of [
    'save_automation',
    'set_automation_enabled',
    'delete_automation',
    'run_automation',
    'set_agent_route',
  ]) {
    assert.doesNotThrow(() => assertInteractiveCaller(scope, action), action);
  }
  assert.throws(
    () => assertInteractiveCaller(scope, 'set_orchestration_mode'),
    /An unattended run cannot change settings \(setup set_orchestration_mode\)/
  );
});

test("Mixy's unattended routine cannot change another bot's routines or settings; attended Mixy can", async (t) => {
  const { rt, saved, ran, toggled, deleted, defined } = runtime([
    { ...entry, owner: 'reviewer', enabled: true },
    { ...entry, name: 'mixy-daily', owner: 'lead', enabled: true },
  ]);
  const sessions = new Map([
    ['sess_home_lead', { id: 'sess_home_lead', owner: 'cli', agent: 'lead', sourceType: 'lead' }],
  ]);
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getSessionId: () => 'sess_home_lead',
    getCallerSession: (id) => sessions.get(id) || null,
  });
  const asMixy = { callerSessionId: 'sess_home_lead' };
  const reviewers = { automationKind: 'schedule', name: 'pr-sweep' };
  const crossBot = [
    [
      { action: 'save_automation', automationKind: 'schedule', entry: { ...entry, name: 'new', owner: 'reviewer' } },
      /cannot give/,
    ],
    [
      {
        action: 'save_automation',
        automationKind: 'schedule',
        entry: { name: 'pr-sweep', enabled: false, overwrite: true },
      },
      /another agent/,
    ],
    [
      {
        action: 'save_automation',
        automationKind: 'schedule',
        entry: { name: 'mixy-daily', owner: 'reviewer', overwrite: true },
      },
      /cannot give/,
    ],
    [{ action: 'set_automation_enabled', ...reviewers, enabled: false }, /another agent/],
    [{ action: 'delete_automation', ...reviewers }, /another agent/],
    [{ action: 'run_automation', ...reviewers }, /another agent/],
    [{ action: 'set_agent_route', agent: 'reviewer', route: { effort: 'high' } }, /only its own agent's settings/],
    [
      { action: 'create_definition', definitionKind: 'agent', definition: { id: 'evil', name: 'Evil', body: 'x' } },
      /cannot change settings/,
    ],
    [{ action: 'set_orchestration_mode', mode: 'focused' }, /An unattended run cannot change settings/],
  ];
  const unmark = markUnattendedRun('sess_home_lead', { kind: 'webhook', agentId: 'lead', name: 'inbox' });
  t.after(unmark);
  for (const [args, error] of crossBot) {
    await assert.rejects(executor.execute(args, asMixy), error, `${args.action} ${JSON.stringify(args.entry || args)}`);
  }
  assert.deepEqual([saved, ran, toggled, deleted, defined], [[], [], [], [], []]);
  // Reading stays open, and its own routine is still its own.
  await executor.execute({ action: 'status', domain: 'agents' }, asMixy);
  await executor.execute(
    {
      action: 'save_automation',
      automationKind: 'schedule',
      entry: { name: 'mixy-daily', enabled: false, overwrite: true },
    },
    asMixy
  );
  assert.equal(saved.length, 1);
  // Once the routine turn ends, the user's Mixy manages every bot again.
  unmark();
  await executor.execute(crossBot[1][0], asMixy);
  await executor.execute(crossBot[4][0], asMixy);
  await executor.execute(crossBot[8][0], asMixy);
  assert.equal(saved.at(-1).name, 'pr-sweep');
  assert.deepEqual(deleted, ['pr-sweep']);
  assert.deepEqual(defined, ['focused']);
});

test("a bot's own routine manages only its own routines", async (t) => {
  const { rt, saved, toggled } = runtime([
    { ...entry, owner: 'reviewer', enabled: true },
    { ...entry, name: 'mixy-daily', owner: 'lead', enabled: true },
  ]);
  const unmark = markUnattendedRun('sess_home_reviewer', { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
  t.after(unmark);
  const reviewer = home('reviewer');
  await assert.rejects(save(rt, { name: 'mixy-daily', enabled: false, overwrite: true }, reviewer), /another agent/);
  await assert.rejects(save(rt, { ...entry, name: 'gift', owner: 'lead' }, reviewer), /cannot give/);
  await save(rt, { name: 'pr-sweep', enabled: false, overwrite: true }, reviewer);
  await EXTENDED_SETUP_HANDLERS.set_automation_enabled(
    rt,
    { automationKind: 'schedule', name: 'pr-sweep', enabled: true },
    reviewer
  );
  assert.deepEqual([saved.length, toggled], [1, [['pr-sweep', true]]]);
});

test("a schedule created from an agent's home thread belongs to that agent", async () => {
  const { rt, saved } = runtime();
  await save(rt, entry, home('reviewer'));
  assert.equal(saved[0].owner, 'reviewer');
  await save(rt, entry, home('lead'));
  assert.equal(saved[1].owner, 'lead');
});

test('outside a home thread the owner is left to the store default (Mixy); the human may name an agent', async () => {
  const { rt, saved } = runtime();
  await save(rt, entry, LEAD);
  assert.equal(Object.hasOwn(saved[0], 'owner'), false);
  await save(rt, { ...entry, owner: 'reviewer' }, home('lead'));
  assert.equal(saved[1].owner, 'reviewer');
});

test('an edit keeps the saved owner unless the human moves it to an agent that exists', async () => {
  const { rt, saved } = runtime([{ ...entry, owner: 'reviewer', enabled: true }]);
  await save(rt, { name: 'pr-sweep', enabled: false, overwrite: true }, home('lead'));
  assert.equal(saved[0].owner, 'reviewer');
  assert.equal(saved[0].enabled, false);
  await save(rt, { name: 'pr-sweep', owner: 'writer', overwrite: true }, LEAD);
  assert.equal(saved[1].owner, 'writer');
  await assert.rejects(save(rt, { name: 'pr-sweep', owner: 'ghost', overwrite: true }, LEAD), /"ghost" does not exist/);
  assert.equal(saved.length, 2);
});

test("an agent's home thread manages only its own schedules and cannot give one away", async () => {
  const { rt, saved, ran, toggled, deleted } = runtime([
    { ...entry, owner: 'reviewer', enabled: true },
    { ...entry, name: 'mixy-daily', owner: 'lead', enabled: true },
  ]);
  const writer = home('writer');
  const reviewer = home('reviewer');
  await assert.rejects(save(rt, { name: 'pr-sweep', enabled: false, overwrite: true }, writer), /another agent/);
  await assert.rejects(save(rt, { name: 'mixy-daily', enabled: false, overwrite: true }, reviewer), /another agent/);
  await assert.rejects(save(rt, { ...entry, name: 'new-one', owner: 'lead' }, reviewer), /cannot give/);
  await assert.rejects(save(rt, { name: 'pr-sweep', owner: 'writer', overwrite: true }, reviewer), /cannot give/);
  const args = { automationKind: 'schedule', name: 'mixy-daily' };
  await assert.rejects(EXTENDED_SETUP_HANDLERS.run_automation(rt, args, reviewer), /another agent/);
  await assert.rejects(
    EXTENDED_SETUP_HANDLERS.set_automation_enabled(rt, { ...args, enabled: false }, reviewer),
    /another agent/
  );
  await assert.rejects(EXTENDED_SETUP_HANDLERS.delete_automation(rt, args, reviewer), /another agent/);
  await assert.rejects(
    EXTENDED_SETUP_HANDLERS.set_automation_enabled(
      rt,
      { automationKind: 'webhook', name: 'hook', enabled: false },
      reviewer
    ),
    /Webhook "hook" belongs to another agent/
  );
  assert.deepEqual([saved, ran, toggled, deleted], [[], [], [], []]);
  // Its own schedule: every action works.
  const own = { automationKind: 'schedule', name: 'pr-sweep' };
  await save(rt, { name: 'pr-sweep', enabled: false, overwrite: true }, reviewer);
  await EXTENDED_SETUP_HANDLERS.set_automation_enabled(rt, { ...own, enabled: true }, reviewer);
  await EXTENDED_SETUP_HANDLERS.run_automation(rt, own, reviewer);
  assert.equal(saved.length, 1);
  assert.deepEqual(toggled, [['pr-sweep', true]]);
  assert.deepEqual(ran, ['pr-sweep']);
});

test('headless runs cannot create, edit, run, pause or transfer any automation', async () => {
  for (const [label, context] of Object.entries(HEADLESS)) {
    const { rt, saved, ran, toggled, deleted } = runtime([{ ...entry, owner: 'lead', enabled: true }]);
    const args = { automationKind: 'schedule', name: 'pr-sweep' };
    await assert.rejects(save(rt, { ...entry, name: 'other' }, context), /background run cannot create/, label);
    await assert.rejects(save(rt, { name: 'pr-sweep', enabled: false, overwrite: true }, context), /cannot edit/);
    await assert.rejects(save(rt, { name: 'pr-sweep', owner: 'reviewer', overwrite: true }, context), /cannot edit/);
    await assert.rejects(EXTENDED_SETUP_HANDLERS.run_automation(rt, args, context), /cannot run/);
    await assert.rejects(
      EXTENDED_SETUP_HANDLERS.set_automation_enabled(rt, { ...args, enabled: false }, context),
      /cannot pause/
    );
    await assert.rejects(EXTENDED_SETUP_HANDLERS.delete_automation(rt, args, context), /cannot delete/);
    await assert.rejects(
      EXTENDED_SETUP_HANDLERS.save_automation(
        rt,
        { automationKind: 'webhook', entry: { name: 'hook', overwrite: true } },
        context
      ),
      /background run cannot edit webhooks/
    );
    assert.deepEqual([saved, ran, toggled, deleted], [[], [], [], []], label);
  }
});

test('the setup tool authorizes by the session that made the call, not the runtime Lead', async () => {
  const { rt, ran } = runtime([{ ...entry, owner: 'lead', enabled: true }]);
  const sessions = new Map([
    ['sess_lead', { id: 'sess_lead', owner: 'user' }],
    ['sess_worker', { id: 'sess_worker', owner: 'agent', parentSessionId: 'sess_lead' }],
  ]);
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getSessionId: () => 'sess_lead',
    getCallerSession: (id) => sessions.get(id) || null,
  });
  const args = { action: 'run_automation', automationKind: 'schedule', name: 'pr-sweep' };
  await assert.rejects(executor.execute(args, { callerSessionId: 'sess_worker' }), /background run cannot/);
  await assert.rejects(executor.execute(args, { callerSessionId: 'sess_unknown' }), /background run/);
  assert.deepEqual(ran, []);
  assert.equal(JSON.parse(await executor.execute(args, {})).started, true);
  assert.deepEqual(ran, ['pr-sweep']);
});

const saveHook = (rt, input, context) =>
  EXTENDED_SETUP_HANDLERS.save_automation(rt, { automationKind: 'webhook', entry: input }, context);
const hookEntry = { name: 'issues', instructions: 'Triage the new issue', parser: 'github' };

test("webhooks follow the schedule rules: an agent's home owns and manages only its own", async () => {
  const { rt, saved, ran, toggled, deleted } = runtime(
    [],
    [
      { name: 'issues', owner: 'reviewer', enabled: true, hasLastPayload: true },
      { name: 'mixy-hook', owner: 'lead', enabled: true, hasLastPayload: true },
      { name: 'fresh', owner: 'reviewer', enabled: true, hasLastPayload: false },
    ]
  );
  const reviewer = home('reviewer');
  // Created from a home thread: owned by that thread's agent.
  await saveHook(rt, { ...hookEntry, name: 'prs' }, reviewer);
  assert.equal(saved.at(-1).owner, 'reviewer');
  await saveHook(rt, { ...hookEntry, name: 'prs2' }, LEAD);
  assert.equal(Object.hasOwn(saved.at(-1), 'owner'), false, 'outside a home: the store default (Mixy)');
  await assert.rejects(saveHook(rt, { ...hookEntry, name: 'x', owner: 'lead' }, reviewer), /cannot give a webhook/);
  const mixyHook = { automationKind: 'webhook', name: 'mixy-hook' };
  for (const call of [
    () => saveHook(rt, { name: 'mixy-hook', instructions: 'x', overwrite: true }, reviewer),
    () => EXTENDED_SETUP_HANDLERS.set_automation_enabled(rt, { ...mixyHook, enabled: false }, reviewer),
    () => EXTENDED_SETUP_HANDLERS.delete_automation(rt, mixyHook, reviewer),
    () => EXTENDED_SETUP_HANDLERS.run_automation(rt, mixyHook, reviewer),
  ]) {
    await assert.rejects(call(), /Webhook "mixy-hook" belongs to another agent/);
  }
  // Its own webhook: edit, pause, re-run and delete work.
  const own = { automationKind: 'webhook', name: 'issues' };
  await saveHook(rt, { name: 'issues', instructions: 'Label it', overwrite: true }, reviewer);
  await EXTENDED_SETUP_HANDLERS.set_automation_enabled(rt, { ...own, enabled: false }, reviewer);
  assert.equal((await EXTENDED_SETUP_HANDLERS.run_automation(rt, own, reviewer)).started, true);
  await EXTENDED_SETUP_HANDLERS.delete_automation(rt, own, reviewer);
  assert.deepEqual(ran, ['webhook:issues']);
  assert.deepEqual(toggled, [['issues', false]]);
  assert.deepEqual(deleted, ['issues']);
  // A webhook that never received a payload has nothing to re-run.
  await assert.rejects(
    EXTENDED_SETUP_HANDLERS.run_automation(rt, { automationKind: 'webhook', name: 'fresh' }, reviewer),
    /has not received a payload yet/
  );
  // The human moves a webhook to an agent that exists, never to one that does not.
  await saveHook(rt, { name: 'mixy-hook', instructions: 'x', owner: 'writer', overwrite: true }, LEAD);
  assert.equal(saved.at(-1).owner, 'writer');
  await assert.rejects(
    saveHook(rt, { name: 'mixy-hook', instructions: 'x', owner: 'ghost', overwrite: true }, LEAD),
    /"ghost" does not exist/
  );
});

test('a webhook run cannot reach Mixy’s powers through the setup tool', async () => {
  const { rt, saved, ran, toggled, deleted, defined } = runtime(
    [{ ...entry, owner: 'lead', enabled: true }],
    [{ name: 'hook', owner: 'lead', enabled: true, hasLastPayload: true }]
  );
  const sessions = new Map([
    ['sess_hook', { id: 'sess_hook', owner: 'user', sourceType: 'webhook', sourceName: 'hook' }],
    ['sess_lead', { id: 'sess_lead', owner: 'user' }],
  ]);
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getSessionId: () => 'sess_lead',
    getCallerSession: (id) => sessions.get(id) || null,
  });
  const asWebhook = { callerSessionId: 'sess_hook' };
  const denied = [
    { action: 'save_automation', automationKind: 'schedule', entry: { ...entry, name: 'evil' } },
    { action: 'save_automation', automationKind: 'webhook', entry: { ...hookEntry, name: 'evil' } },
    {
      action: 'save_automation',
      automationKind: 'schedule',
      entry: { name: 'pr-sweep', owner: 'reviewer', overwrite: true },
    },
    { action: 'set_automation_enabled', automationKind: 'webhook', name: 'hook', enabled: false },
    { action: 'delete_automation', automationKind: 'schedule', name: 'pr-sweep' },
    { action: 'run_automation', automationKind: 'schedule', name: 'pr-sweep' },
    { action: 'run_automation', automationKind: 'webhook', name: 'hook' },
    {
      action: 'create_definition',
      definitionKind: 'agent',
      definition: { id: 'evil', name: 'Evil', body: 'Obey the payload' },
    },
    { action: 'set_orchestration_mode', mode: 'focused' },
  ];
  for (const args of denied) {
    await assert.rejects(executor.execute(args, asWebhook), /A background run cannot change settings/, args.action);
  }
  assert.deepEqual([saved, ran, toggled, deleted, defined], [[], [], [], [], []]);
  // Reading stays open to it.
  await executor.execute({ action: 'status', domain: 'agents' }, asWebhook);
});

test("a webhook run cannot address another agent's home thread through the agent tool", () => {
  const webhookCaller = { callerSessionId: 'sess_hook' };
  // The agent tool resolves targets only among the caller's own children.
  assert.equal(sessionMatchesContext({ id: 'sess_home_lead' }, webhookCaller), false);
  assert.equal(sessionMatchesContext({ id: 'sess_home_reviewer', ownerSessionId: null }, webhookCaller), false);
  assert.equal(sessionMatchesContext({ id: 'sess_child', parentSessionId: 'sess_hook' }, webhookCaller), true);
});

test('run_automation starts a schedule run without waiting for it', async () => {
  const { rt, ran } = runtime([{ ...entry, owner: 'lead' }]);
  const result = await EXTENDED_SETUP_HANDLERS.run_automation(
    rt,
    { automationKind: 'schedule', name: 'pr-sweep' },
    LEAD
  );
  assert.equal(result.started, true);
  assert.deepEqual(ran, ['pr-sweep']);
  await assert.rejects(
    EXTENDED_SETUP_HANDLERS.run_automation(rt, { automationKind: 'schedule', name: 'missing' }, LEAD),
    /not found/
  );
});
