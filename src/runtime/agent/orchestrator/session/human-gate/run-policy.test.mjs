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
import { _liveSessions } from '../store/live-state.mjs';
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
  const session = { ...record, ...(origin.delegation ? { delegation: origin.delegation } : {}), createdAt: Date.now() };
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
  assert.equal(cards[0].rememberAt, undefined);
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

test('a sub-agent of an attended bot chat asks before a delete', async (t) => {
  const { cards, call } = setup(t);
  subAgent('sess_rp_att_sub', HOME);
  subAgent('sess_rp_att_deep', 'sess_rp_att_sub');
  for (const sessionId of ['sess_rp_att_sub', 'sess_rp_att_deep']) {
    const out = await call(sessionId, deleteMessage);
    assert.equal(out.denial, undefined, sessionId);
  }
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(card.outbound.category, 'delete');
    assert.deepEqual(card.remember, ['once']);
    assert.equal(card.agentId, 'mailer');
  }
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
  assert.deepEqual(held, []);
  // No approval UI attached: the request is held for the owner, as before.
  const withoutCard = await applyBeforeToolHook({
    ...email,
    cwd: '/tmp',
    callerSessionId: member,
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'allow' }),
    toolApprovalHook: null,
  });
  assert.equal(held.length, 1);
  assert.match(withoutCard.denial, /not approved|denied/);
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

// A worker's status follows the turn that drives it: reusing a tag re-binds
// it (delegation.mjs rebindDelegation) to the session that sends it work.
const BUSY = { stage: 'tool_running' };

test('a worker a run started asks when the attended chat later reuses its tag', async (t) => {
  const { store, cards, held, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  subAgent('sess_rb_w1', HOME);
  unmark();
  assert.equal((await call('sess_rb_w1', email)).denial, undefined);
  assert.equal(cards.length, 0, 'still the run: allowed without a card');
  assert.equal((await store.readAudit({ agentId: 'mailer' }))[0].decision, 'run-allowed');

  assert.equal(await rebindDelegation('sess_rb_w1', HOME), true, 'the attended chat sends it work');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_w1'), null);
  assert.equal((await call('sess_rb_w1', email)).denial, undefined, 'the person approved it on the card');
  assert.equal(cards.length, 1, 'now it asks');
  assert.deepEqual(held, []);
  assert.notEqual((await store.readAudit({ agentId: 'mailer' }))[0].decision, 'run-allowed');
  assert.equal(loadSession('sess_rb_w1').delegation.via, 'home', 'kept on the record, so a restart keeps it');
  assert.equal(await rebindDelegation('sess_rb_w1', HOME), false, 'nothing changes when the driver is the same');
});

test('a worker the attended chat started is the run only for what a run sends it', async (t) => {
  const { cards, call } = setup(t);
  subAgent('sess_rb_w2', HOME);
  assert.equal((await call('sess_rb_w2', email)).denial, undefined);
  assert.equal(cards.length, 1, 'attended: asks');

  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  assert.equal(await rebindDelegation('sess_rb_w2', HOME), true);
  assert.deepEqual(unattendedApprovalPort().runOf('sess_rb_w2'), { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  assert.equal((await call('sess_rb_w2', email)).denial, undefined);
  assert.equal(cards.length, 1, 'the run reused it: allowed without a card');
  unmark();
  // The run's work stays the run's after it ended, until the chat drives it again.
  assert.notEqual(unattendedApprovalPort().runOf('sess_rb_w2'), null);
  await rebindDelegation('sess_rb_w2', HOME);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_w2'), null);
});

test("a run's own late sub-agent stays the run's, however long after; a sibling's reuse does not touch it", async (t) => {
  const { cards, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  subAgent('sess_rb_late', HOME);
  subAgent('sess_rb_late_sibling', HOME);
  subAgent('sess_rb_late_deep', 'sess_rb_late');
  unmark();
  await rebindDelegation('sess_rb_late_sibling', HOME);
  for (const sessionId of ['sess_rb_late', 'sess_rb_late_deep']) {
    assert.equal((await call(sessionId, email)).denial, undefined, sessionId);
  }
  assert.deepEqual(cards, []);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_late_sibling'), null);
});

test("a sub-agent reached through another worker takes that worker's status", async (t) => {
  setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  subAgent('sess_rb_mid', HOME);
  subAgent('sess_rb_leaf', HOME);
  unmark();
  assert.equal(await rebindDelegation('sess_rb_leaf', 'sess_rb_mid'), true, 'driven by the run-started worker');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_leaf')?.kind, 'schedule');
  await rebindDelegation('sess_rb_mid', HOME);
  assert.equal(await rebindDelegation('sess_rb_leaf', 'sess_rb_mid'), true, 'now driven by an attended one');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_leaf'), null);
});

test('a worker busy with attended work is not made a run mid-turn; a run reaching it asks', async (t) => {
  const { cards, call } = setup(t);
  subAgent('sess_rb_busy', HOME);
  runtimeState.set('sess_rb_busy', BUSY);
  t.after(() => runtimeState.delete('sess_rb_busy'));
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  t.after(unmark);
  assert.equal(await rebindDelegation('sess_rb_busy', HOME), false, 'the in-flight attended turn is not loosened');
  assert.equal(unattendedApprovalPort().runOf('sess_rb_busy'), null);
  assert.equal((await call('sess_rb_busy', email)).denial, undefined);
  assert.equal(cards.length, 1);
  // The other way is stricter, so it applies at once: the run's in-flight work now asks.
  unmark();
  const again = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  subAgent('sess_rb_busy_run', HOME);
  again();
  runtimeState.set('sess_rb_busy_run', BUSY);
  t.after(() => runtimeState.delete('sess_rb_busy_run'));
  assert.equal(await rebindDelegation('sess_rb_busy_run', HOME), true);
  assert.equal(unattendedApprovalPort().runOf('sess_rb_busy_run'), null);
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

// A rebind that cannot establish the sender's root leaves an explicit
// unresolved binding: the legacy backfill must not hand the run back.
test('a rebind that cannot establish a root fails closed, also for its legacy child and after a restart', async (t) => {
  const { cards, held, store, call } = setup(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
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
  unmark();
  subAgent('sess_rb_orphan', 'sess_rb_gone_parent');
  assert.equal((await call('sess_rb_fc', email)).denial, undefined);
  assert.equal(cards.length, 0, 'before the rebind: the run, no card');

  assert.equal(await rebindDelegation('sess_rb_fc', 'sess_rb_orphan'), true);
  assert.equal(delegationOf('sess_rb_fc').state, 'unresolved');
  assert.equal(await rebindDelegation('sess_rb_fc', 'sess_rb_orphan'), false, 'unchanged the second time');

  const expectAsks = async (label) => {
    for (const sessionId of ['sess_rb_fc', 'sess_rb_fc_legacy']) {
      const before = cards.length;
      assert.equal((await call(sessionId, email)).denial, undefined, `${label} ${sessionId}: the card approved`);
      assert.equal(cards.length, before + 1, `${label} ${sessionId}: asks`);
      assert.deepEqual(cards.at(-1).remember, ['once'], 'once only, nothing is remembered');
    }
    assert.deepEqual(held, []);
    const decisions = (await store.readAudit({ agentId: 'mailer' })).map((row) => row.decision);
    assert.equal(decisions.filter((decision) => decision === 'run-allowed').length, 1, `${label}: no new run-allowed`);
  };
  await expectAsks('rebound');

  // A restart: nothing live, everything read back from disk.
  _liveSessions.delete('sess_rb_fc');
  assert.equal(loadSession('sess_rb_fc').delegation.unresolved, true, 'the binding is on disk');
  assert.equal(delegationOf('sess_rb_fc').state, 'unresolved');
  await expectAsks('after restart');

  // A later send by a resolvable sender binds it again.
  assert.equal(await rebindDelegation('sess_rb_fc', HOME), true);
  assert.equal(delegationOf('sess_rb_fc').state, 'resolved');
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
