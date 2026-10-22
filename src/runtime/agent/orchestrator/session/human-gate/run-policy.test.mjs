// Schedule and webhook runs never ask (run-policy.mjs): the saved schedule is
// the grant. Outbound actions and ordinary tool asks are allowed with no card,
// held row or push; payments and permanent deletes are denied at once; a bot's
// `block` still blocks; room members and attended chats keep asking.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyBeforeToolHook } from '../loop/tool-exec/before-hook.mjs';
import { setLiveSession } from '../store.mjs';
import { loadSession } from '../store/load-session.mjs';
import { runtimeState } from '../manager/runtime-state.mjs';
import { delegationOf, rebindDelegation } from './delegation.mjs';
import { humanGateDecision, setUnattendedApprovalPort, unattendedApprovalPort } from './gate.mjs';
import { AUTOMATION_GRANT_REASON, RUN_FORBIDDEN_REASON } from './run-policy.mjs';
import { createHumanGateStore, setHumanGateStore } from './store.mjs';
import { roomMemberSessionId } from '../agent-room.mjs';
import { sessionOriginFields } from '../manager/session-record.mjs';
import { markUnattendedRun } from '../../../../../session-runtime/held-requests.mjs';

const dataRoot = mkdtempSync(join(tmpdir(), 'run-policy-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
for (const [id, kind] of [
  ['mailer', 'bot'],
  ['worker', 'agent'],
]) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: ${kind}\n---\nYou are ${id}.\n`);
}
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const HOME = 'sess_home_mailer';
const created = (record) => {
  const origin = sessionOriginFields(record, {
    profile: null,
    presetObj: null,
    providerCacheOpts: null,
    surface: { toolPermission: null, hasCallerAllow: false },
  });
  const session = {
    ...record,
    ...(origin.delegation ? { delegation: origin.delegation } : {}),
    ...(origin.run ? { run: origin.run } : {}),
    createdAt: Date.now(),
  };
  setLiveSession(session);
  return session;
};
const subAgent = (id, parent) =>
  created({
    id,
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    parentSessionId: parent,
    ownerSessionId: parent,
  });

const email = { name: 'mcp__gmail__send_email', args: { to: 'boss@example.com', subject: 's', body: 'hi' } };
const payment = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'usd', merchant: 'Shop' } };
const permanentDelete = { name: 'mcp__drive__empty_trash', args: {} };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'run-policy-gate-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  const cards = [];
  const held = [];
  const port = unattendedApprovalPort();
  // The real port, with its hold watched: a granted run must never reach it.
  setUnattendedApprovalPort({
    ...port,
    hold: async (request) => {
      held.push(request);
      return { approved: false, response: 'deny' };
    },
  });
  t.after(() => {
    setUnattendedApprovalPort(port);
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (sessionId, tool, hookDecision = { action: 'allow' }) =>
    applyBeforeToolHook({
      ...tool,
      cwd: '/tmp',
      callerSessionId: sessionId,
      executeOpts: {},
      beforeToolHook: async () => hookDecision,
      toolApprovalHook: async (request) => {
        cards.push(request);
        return { approved: true, response: 'approve' };
      },
    });
  return { dir, store, cards, held, call };
}

for (const kind of ['schedule', 'webhook']) {
  test(`a ${kind} run sends mail without asking: no card, no held row, no push; audited`, async (t) => {
    const { store, cards, held, call } = setup(t);
    const unmark = markUnattendedRun(HOME, { kind, agentId: 'mailer', name: 'Daily' });
    t.after(unmark);
    const out = await call(HOME, email);
    assert.equal(out.denial, undefined, 'the send runs');
    assert.equal(out.name, email.name);
    assert.deepEqual(cards, []);
    assert.deepEqual(held, []);
    const [row] = await store.readAudit({ agentId: 'mailer' });
    assert.equal(row.decision, 'run-allowed');
    assert.equal(row.action, 'email');
    assert.deepEqual(await store.listGrants({ agentId: 'mailer' }), [], 'nothing is remembered from a run');
  });

  test(`a sub-agent a ${kind} run started sends mail without asking`, async (t) => {
    const { cards, held, call } = setup(t);
    const unmark = markUnattendedRun(HOME, { kind, agentId: 'mailer', name: 'Nightly' });
    subAgent(`sess_rp_${kind}_sub`, HOME);
    subAgent(`sess_rp_${kind}_deep`, `sess_rp_${kind}_sub`);
    unmark();
    // Still the run's work after the run ended.
    for (const sessionId of [`sess_rp_${kind}_sub`, `sess_rp_${kind}_deep`]) {
      const out = await call(sessionId, email);
      assert.equal(out.denial, undefined, sessionId);
    }
    assert.deepEqual(cards, []);
    assert.deepEqual(held, []);
  });
}

test('an ordinary tool ask in a run is allowed without asking', async (t) => {
  const { cards, held, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  t.after(unmark);
  const out = await call(HOME, { name: 'shell', args: { command: 'echo hi' } }, { action: 'ask', reason: 'policy' });
  assert.equal(out.denial, undefined);
  assert.deepEqual(cards, []);
  assert.deepEqual(held, []);
});

for (const [label, tool, category] of [
  ['a payment', payment, 'payment'],
  ['a permanent delete', permanentDelete, 'delete'],
]) {
  test(`${label} in a run is denied at once with a result the bot can report`, async (t) => {
    const { store, cards, held, call } = setup(t);
    const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
    t.after(unmark);
    const out = await call(HOME, tool);
    assert.match(out.denial, new RegExp(RUN_FORBIDDEN_REASON.replace(/[/;']/g, '.')));
    assert.match(out.denial, /do it from the chat/);
    assert.deepEqual(cards, []);
    assert.deepEqual(held, [], 'no wait: nothing is held');
    const [row] = await store.readAudit({ agentId: 'mailer' });
    assert.equal(row.decision, 'run-forbidden');
    assert.equal(row.action, category);
  });
}

test('in a run only a recoverable trash deletes remote items; read names stay reads', async (t) => {
  const { store, cards, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  t.after(unmark);
  for (const tool of ['delete_message', 'delete_file', 'remove_member', 'destroy_record', 'purge_cache']) {
    const out = await call(HOME, { name: `mcp__chat__${tool}`, args: { id: '1' } });
    assert.match(out.denial, /do it from the chat/, tool);
  }
  const [row] = await store.readAudit({ agentId: 'mailer' });
  assert.equal(row.decision, 'run-forbidden');
  for (const tool of ['trash_emails', 'list_deleted_items', 'get_removed_members']) {
    const out = await call(HOME, { name: `mcp__gmail__${tool}`, args: { ids: ['1'] } });
    assert.equal(out.denial, undefined, tool);
  }
  assert.deepEqual(cards, []);
});

const deleteMessage = { name: 'mcp__chat__delete_message', args: { id: '1' } };

test('an attended bot chat asks before delete_message, on a card with no "always"', async (t) => {
  const { cards, held, call } = setup(t);
  const out = await call(HOME, deleteMessage);
  assert.equal(out.denial, undefined, 'the person approved it on the card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'outbound');
  assert.equal(cards[0].outbound.category, 'delete');
  assert.deepEqual(cards[0].remember, ['once']);
  assert.deepEqual(held, []);
  // A deny stops it.
  const denied = await applyBeforeToolHook({
    ...deleteMessage,
    cwd: '/tmp',
    callerSessionId: HOME,
    executeOpts: {},
    toolApprovalHook: async () => ({ approved: false, response: 'deny' }),
  });
  assert.match(denied.denial, /denied|not approved/);
});

test('a room member asks before a delete on its card', async (t) => {
  const { cards, call } = setup(t);
  const out = await call(roomMemberSessionId('room123abc', 'mailer'), deleteMessage);
  assert.equal(out.denial, undefined);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].outbound.category, 'delete');
  assert.deepEqual(cards[0].remember, ['once']);
});

test('a sub-agent of a bot chat or room seat is no bot: no outbound ask, not even a delete', async (t) => {
  const { cards, held, call } = setup(t);
  const member = roomMemberSessionId('room123abc', 'mailer');
  subAgent('sess_rp_att_sub', HOME);
  subAgent('sess_rp_att_deep', 'sess_rp_att_sub');
  subAgent('sess_rp_room_sub', member);
  for (const sessionId of ['sess_rp_att_sub', 'sess_rp_att_deep', 'sess_rp_room_sub']) {
    for (const tool of [deleteMessage, email, payment]) {
      const out = await call(sessionId, tool);
      assert.equal(out.denial, undefined, `${sessionId} ${tool.name}`);
    }
    assert.equal(unattendedApprovalPort().runOf(sessionId), null, sessionId);
  }
  assert.deepEqual(cards, []);
  assert.deepEqual(held, []);
});

test('a coding Lead and its sub-agents delete without a card, as before', async (t) => {
  const { cards, call } = setup(t);
  setLiveSession({ id: 'sess_rp_lead', owner: 'cli', agent: 'lead' });
  subAgent('sess_rp_lead_sub', 'sess_rp_lead');
  const permanent = { name: 'mcp__files__delete_permanently', args: { ids: ['a'] } };
  for (const sessionId of ['sess_rp_lead', 'sess_rp_lead_sub']) {
    for (const tool of [permanent, deleteMessage, payment]) {
      const out = await call(sessionId, tool);
      assert.equal(out.denial, undefined, `${sessionId} ${tool.name}`);
    }
  }
  assert.deepEqual(cards, []);
});

test('trash moves and read-only deleted listings add no delete card in a bot chat', async (t) => {
  const { cards, call } = setup(t);
  for (const name of [
    'mcp__files__trash_files',
    'mcp__gmail__list_deleted_messages',
    'mcp__chat__get_removed_members',
  ]) {
    const out = await call(HOME, { name, args: { ids: ['1'] } });
    assert.equal(out.denial, undefined, name);
  }
  assert.deepEqual(cards, []);
  // Gmail's own trash card is the existing recoverable kind, never a permanent-delete card.
  await call(HOME, { name: 'mcp__gmail__trash_emails', args: { ids: ['1'] } });
  assert.deepEqual(
    cards.map((card) => card.outbound.category),
    ['trash']
  );
});

test('a stored always-grant for a delete tool is ignored: the bot chat still asks', async (t) => {
  const { dir, cards, call } = setup(t);
  const stored = (agentId) => ({ id: `grant_${agentId}`, agentId, action: 'delete', mode: 'allow', device: '', at: 1 });
  writeFileSync(join(dir, 'grants.json'), JSON.stringify({ grants: [stored('mailer'), stored('*')] }));
  const out = await call(HOME, deleteMessage, { action: 'allow' });
  assert.equal(out.denial, undefined);
  assert.equal(cards.length, 1, 'asked despite the stored allow');
  assert.deepEqual(cards[0].remember, ['once']);
});

test("a bot's blocked permission still blocks in a run, before any allowance", async (t) => {
  const { store, cards, held, call } = setup(t);
  await store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  t.after(unmark);
  const out = await call(HOME, email);
  assert.match(out.denial, /permission blocks this action/);
  assert.deepEqual(cards, []);
  assert.deepEqual(held, []);
});

test('a room member keeps its approval: asked on its card, held when it has none', async (t) => {
  const { cards, held, call } = setup(t);
  const member = roomMemberSessionId('room123abc', 'mailer');
  const out = await call(member, email);
  assert.equal(out.denial, undefined, 'the card approved it');
  assert.equal(cards.length, 1, 'a room asks on its own card');
  assert.deepEqual(cards[0].remember, ['once', 'agent'], 'as in the bot home: always-allow is offered');
  assert.equal(cards[0].agentId, 'mailer');
  assert.deepEqual(held, []);
  // No approval UI attached: the request is held for the owner, with the same scopes.
  const withoutCard = await applyBeforeToolHook({
    ...email,
    cwd: '/tmp',
    callerSessionId: member,
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'allow' }),
    toolApprovalHook: null,
  });
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].remember, ['once', 'agent']);
  assert.match(withoutCard.denial, /not approved|denied/);
});

// Production only marks a run on the bot's home thread id (routine-home-turn.mjs:
// markUnattendedRun(agentHomeSessionId)), never on a room member's session id, so a
// schedule/webhook inside a room seat cannot occur. If one were marked, the run
// would win over the seat: nothing asked, held or remembered, payments denied.
test('a run marked on a room member session is still a run: no ask, no hold, nothing remembered', async (t) => {
  const { store, cards, held, call } = setup(t);
  const member = roomMemberSessionId('room123abc', 'mailer');
  const unmark = markUnattendedRun(member, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  t.after(unmark);
  assert.equal((await call(member, email)).denial, undefined);
  assert.match((await call(member, permanentDelete)).denial, /do it from the chat/);
  assert.deepEqual(cards, []);
  assert.deepEqual(held, []);
  assert.deepEqual(await store.listGrants({ agentId: 'mailer' }), []);
  unmark();
  assert.equal((await call(member, email)).denial, undefined, 'a seat again once the run ends');
  assert.deepEqual(cards.at(-1).remember, ['once', 'agent']);
});

test('an attended bot chat still asks, for mail and for a payment', async (t) => {
  const { cards, held, call } = setup(t);
  assert.equal((await call(HOME, email)).denial, undefined);
  assert.equal((await call(HOME, payment)).denial, undefined, 'the person approved it on the card');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].outbound.category, 'payment');
  assert.deepEqual(cards[1].remember, ['once']);
  assert.deepEqual(held, []);
});

// Reusing a tag re-binds a worker (delegation.mjs rebindDelegation) to the root
// and the run (if any) of the session that sends it work.
test('a worker a run started stays the run, however long after; the attended chat reusing its tag ends that', async (t) => {
  const { store, cards, held, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  subAgent('sess_rb_w1', HOME);
  subAgent('sess_rb_w1_deep', 'sess_rb_w1');
  unmark();
  for (const sessionId of ['sess_rb_w1', 'sess_rb_w1_deep']) {
    assert.equal((await call(sessionId, email)).denial, undefined, sessionId);
    assert.equal(unattendedApprovalPort().runOf(sessionId)?.kind, 'schedule', sessionId);
  }
  assert.deepEqual(cards, [], 'auto-allowed: never a card');
  assert.deepEqual(held, []);
  assert.equal((await store.readAudit({ agentId: 'mailer' }))[0].decision, 'run-allowed');
  assert.match((await call('sess_rb_w1', payment)).denial, /do it from the chat/);

  assert.equal(await rebindDelegation('sess_rb_w1', HOME), true, 'the attended chat sends it work');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_w1'), null);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_w1_deep')?.kind, 'schedule', 'a sibling keeps its own');
  assert.equal((await call('sess_rb_w1', email)).denial, undefined);
  assert.deepEqual(cards, [], 'a bot home sub-agent still has no bot ask');
  assert.equal(await rebindDelegation('sess_rb_w1', HOME), false, 'nothing changes when the driver is the same');
  assert.equal(loadSession('sess_rb_w1').delegation.via, 'bot');
});

test('a worker the attended chat started is the run only for what a run sends it; a busy turn is not loosened', async (t) => {
  const { call } = setup(t);
  subAgent('sess_rb_w3', HOME);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_w3'), null);
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  t.after(unmark);
  runtimeState.set('sess_rb_w3', { stage: 'tool_running' });
  assert.equal(await rebindDelegation('sess_rb_w3', HOME), false, 'the in-flight attended turn stays attended');
  runtimeState.delete('sess_rb_w3');
  assert.equal(await rebindDelegation('sess_rb_w3', HOME), true);
  assert.deepEqual(unattendedApprovalPort().runOf('sess_rb_w3'), { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  assert.equal((await call('sess_rb_w3', email)).denial, undefined);
});

test("a worker reused by a coding Lead takes the Lead's root; by a bot seat, none", async (t) => {
  const { cards, call } = setup(t);
  setLiveSession({ id: 'sess_rb_lead', owner: 'cli', agent: 'lead' });
  subAgent('sess_rb_w2', HOME);
  assert.equal(await rebindDelegation('sess_rb_w2', 'sess_rb_lead'), true);
  assert.equal(loadSession('sess_rb_w2').delegation.via, 'coding');
  assert.equal(loadSession('sess_rb_w2').delegation.rootSessionId, 'sess_rb_lead');
  assert.equal(await rebindDelegation('sess_rb_w2', HOME), true);
  assert.equal(loadSession('sess_rb_w2').delegation.via, 'bot');
  assert.equal((await call('sess_rb_w2', email)).denial, undefined);
  assert.deepEqual(cards, []);
});

test('rebinding ignores sessions it cannot be applied to', async (t) => {
  setup(t);
  assert.equal(await rebindDelegation('sess_rb_nope', HOME), false, 'no record');
  setLiveSession({ id: 'sess_rb_top', owner: 'cli', agent: 'lead' });
  assert.equal(await rebindDelegation('sess_rb_top', HOME), false, 'a top-level session has no delegation');
  subAgent('sess_rb_self', HOME);
  assert.equal(await rebindDelegation('sess_rb_self', 'sess_rb_self'), false, 'a session never drives itself');
  assert.equal(await rebindDelegation('sess_rb_self', ''), false, 'no caller, no change');
});

test('a rebind that cannot establish a root changes nothing, and an unknown-parent session never asks', async (t) => {
  const { cards, held, call } = setup(t);
  subAgent('sess_rb_fc', HOME);
  setLiveSession({
    id: 'sess_rb_fc_legacy',
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    parentSessionId: 'sess_rb_fc',
    ownerSessionId: 'sess_rb_fc',
    createdAt: Date.now(),
  });
  subAgent('sess_rb_orphan', 'sess_rb_gone_parent');
  assert.equal((await call('sess_rb_fc', email)).denial, undefined);
  assert.equal(cards.length, 0, "before the rebind: a bot's sub-agent, no card");

  // A sender whose root cannot be established changes nothing; the session
  // never becomes a bot's, so it never asks for an outbound call.
  assert.equal(await rebindDelegation('sess_rb_fc', 'sess_rb_orphan'), false);
  assert.equal(delegationOf('sess_rb_fc').via, 'bot');
  assert.equal(delegationOf('sess_rb_orphan').state, 'top', 'no root, no delegation');
  for (const sessionId of ['sess_rb_fc', 'sess_rb_fc_legacy', 'sess_rb_orphan']) {
    assert.equal((await call(sessionId, email)).denial, undefined, sessionId);
  }
  assert.deepEqual(cards, []);
  assert.deepEqual(held, []);
});

test('the run passes between sender and worker whether or not the sender has a resolvable root', async (t) => {
  const { cards, held, call } = setup(t);
  const run = { kind: 'schedule', agentId: 'mailer', name: 'Nightly' };
  // Senders with no derivable root: their parent record is gone.
  const orphan = (id, extra = {}) =>
    setLiveSession({
      id,
      owner: 'agent',
      agent: 'worker',
      visibility: 'agent-only',
      parentSessionId: 'sess_rb_gone_parent',
      ownerSessionId: 'sess_rb_gone_parent',
      createdAt: Date.now(),
      ...extra,
    });
  orphan('sess_rb_runsender', { run });
  orphan('sess_rb_attsender');
  assert.equal(delegationOf('sess_rb_runsender').state, 'top');

  // A run-stamped sender passes the run to an attended worker; its root stays.
  subAgent('sess_rb_pw', HOME);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_pw'), null);
  assert.equal(await rebindDelegation('sess_rb_pw', 'sess_rb_runsender'), true);
  assert.deepEqual(unattendedApprovalPort().runOf('sess_rb_pw'), run);
  assert.equal(delegationOf('sess_rb_pw').via, 'bot', 'the root it had is kept');
  assert.equal((await call('sess_rb_pw', email)).denial, undefined);
  assert.match((await call('sess_rb_pw', payment)).denial, /do it from the chat/);
  assert.deepEqual(loadSession('sess_rb_pw').run, run, 'persisted');
  assert.equal(await rebindDelegation('sess_rb_pw', 'sess_rb_runsender'), false, 'nothing more to change');

  // An attended sender ends the run of a worker (and a stale stamp is not kept).
  assert.equal(await rebindDelegation('sess_rb_pw', 'sess_rb_attsender'), true);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_pw'), null);
  assert.equal(loadSession('sess_rb_pw').run, null);
  assert.equal(delegationOf('sess_rb_pw').via, 'bot');
  assert.equal((await call('sess_rb_pw', payment)).denial, undefined, 'attended again: no run denial');
  assert.deepEqual(cards, [], 'a bot home sub-agent still has no bot ask');
  assert.deepEqual(held, []);

  // A worker stored by the old code as the run's (`via: 'run'`) is that run's until an attended sender reuses it, then for good.
  setLiveSession({
    id: 'sess_rb_old',
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    parentSessionId: HOME,
    ownerSessionId: HOME,
    createdAt: Date.now(),
    delegation: {
      rootSessionId: HOME,
      rootAgentId: 'mailer',
      via: 'run',
      run: { kind: 'schedule', name: 'Nightly' },
      path: [{ kind: 'agent', agent: 'worker' }],
    },
  });
  assert.deepEqual(unattendedApprovalPort().runOf('sess_rb_old'), run);
  assert.equal(await rebindDelegation('sess_rb_old', 'sess_rb_attsender'), true);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_old'), null, 'the old record no longer brings the run back');
  assert.equal(delegationOf('sess_rb_old').via, 'bot');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_old'), null);

  // A busy attended turn is never made a run mid-turn, root or not.
  subAgent('sess_rb_pw2', HOME);
  runtimeState.set('sess_rb_pw2', { stage: 'tool_running' });
  t.after(() => runtimeState.delete('sess_rb_pw2'));
  assert.equal(await rebindDelegation('sess_rb_pw2', 'sess_rb_runsender'), false);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_pw2'), null);
});

test('saving a schedule or webhook says what the approval grants', async (t) => {
  const { store } = setup(t);
  for (const automationKind of ['schedule', 'webhook']) {
    const out = await humanGateDecision(
      { name: 'setup', args: { action: 'save_automation', automationKind, entry: { name: 'x' } } },
      { action: 'ask', reason: 'approval requested by hook' },
      { sessionId: HOME, store }
    );
    assert.equal(out.decision.action, 'ask');
    assert.equal(out.decision.reason, AUTOMATION_GRANT_REASON);
  }
  assert.match(AUTOMATION_GRANT_REASON, /runs act without asking, within the bot's permissions/);
  assert.match(AUTOMATION_GRANT_REASON, /Payments and permanent deletes are never done in runs/);
  const other = await humanGateDecision(
    { name: 'setup', args: { action: 'set_agent_route' } },
    { action: 'ask', reason: 'policy' },
    { sessionId: HOME, store }
  );
  assert.equal(other.decision.reason, 'policy', 'other asks keep their reason');
});
