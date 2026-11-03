// A hook's own `ask` (the only card a coding Lead raises) offers once / this
// session / always for every agent: keyed by the action kind for a classified
// send or post, else by the tool — never by arguments. The choice is honoured on
// later matching calls, in other conversations for "always"; floors, unattended
// runs, timeouts and revocation behave as for every other grant.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'hook-ask-grants-data-'));
const previousEnv = Object.fromEntries(
  ['MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_READ_TTL_MS', 'MIXDOG_USER_DATA_BACKUP_ROOT'].map((key) => [key, process.env[key]])
);
process.env.MIXDOG_DATA_DIR = dataRoot;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dataRoot, 'backups');
for (const id of ['mailer', 'scribe']) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: bot\n---\nYou are ${id}.\n`);
}

const { updateSection } = await import('../../../../shared/config.mjs');
const { humanGateDecision, recordHumanDecision, setUnattendedApprovalPort, unattendedApprovalPort } = await import(
  './gate.mjs'
);
const { humanRequestFields, normalizeHumanResponse } = await import('./requests.mjs');
const { agentPermissions, createHumanGateStore, setAgentPermission, setHumanGateStore } = await import('./store.mjs');
const { SESSION_GRANT_TTL_MS, createSessionGrants } = await import('./session-grants.mjs');
const { isRememberableAction, isToolAction, toolActionOf } = await import('./outbound-policy.mjs');

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});
test.afterEach(() => updateSection('agent', (current) => ({ ...current, developer: {} })));

const LEAD = 'sess_lead_coding';
const OTHER_LEAD = 'sess_lead_other';
const MIXY = 'sess_home_lead';
const MAILER = 'sess_home_mailer';
const HOOK = { action: 'ask', reason: 'hook rule' };
const SHELL = (command) => ({ name: 'shell', args: { command } });
const EDIT = { name: 'edit', args: { path: 'a.txt', old: 'x', new: 'y' } };
const MCP = (tool) => ({ name: `mcp__acme__${tool}`, args: { id: 1 } });
const EMAIL = { name: 'mcp__gmail__send_email', args: { to: 'a@b.c', subject: 's', body: 'hi' } };
const COMMENT = { name: 'github', args: { action: 'pr.comment', repo: 'o/r', number: 1, body: 'LGTM' } };
const MERGE = { name: 'github', args: { action: 'pr.merge', repo: 'o/r', number: 1 } };
const PAYMENT = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'USD', merchant: 'Notion' } };
const PERMANENT_DELETE = { name: 'mcp__drive__delete_permanently', args: { ids: ['a'] } };

/** A store, a session-grant registry on a movable clock and movable session lives. */
function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-ask-grants-store-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  let clock = 1_000_000;
  const lives = new Map();
  const sessionGrants = createSessionGrants({ now: () => clock });
  const port = unattendedApprovalPort();
  t.after(() => {
    setUnattendedApprovalPort(port);
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const life = (sessionId) => (lives.has(sessionId) ? lives.get(sessionId) : `life-${sessionId}`);
  const ctx = (sessionId) => ({ sessionId, store, sessionGrants, sessionLife: life, annotations: {} });
  return {
    store,
    advance: (ms) => {
      clock += ms;
    },
    reset: (sessionId) => lives.set(sessionId, `reset-${clock}`),
    decide: (call, sessionId, hook = HOOK) => humanGateDecision(call, hook, ctx(sessionId)),
    answer: (gate, approval) => recordHumanDecision(gate, approval, { store, sessionGrants, sessionLife: life }),
    /** The card's answer as the desktop would deliver it. */
    choose: async (card, remember) => {
      const answered = normalizeHumanResponse(card.request, true, { response: 'approve', remember });
      await recordHumanDecision(card.gate, answered, { store, sessionGrants, sessionLife: life });
      return answered;
    },
  };
}
const asks = (out) => out.decision.action === 'ask';

test('a coding Lead hook ask offers once / this session / always, keyed by the tool', async (t) => {
  const h = harness(t);
  const card = await h.decide(SHELL('git push'), LEAD);
  assert.equal(card.decision.action, 'ask');
  assert.deepEqual(card.request.remember, ['once', 'session', 'always']);
  assert.equal(card.request.grantAction, 'tool:shell');
  assert.equal(card.gate.action, 'tool:shell');
  // The presented request keeps the choices; a response is normalized to one of them.
  const presented = { kind: 'approval', ...humanRequestFields(card.request) };
  assert.deepEqual(presented.remember, ['once', 'session', 'always']);
  for (const remember of ['once', 'session', 'always']) {
    assert.equal(normalizeHumanResponse(presented, true, { remember }).remember, remember);
  }
  assert.equal(normalizeHumanResponse(presented, true, { remember: 'agent' }).remember, 'once', 'not offered');
  // A request that names no key offers neither session nor always.
  assert.deepEqual(humanRequestFields({ kind: 'approval', remember: ['once', 'session', 'always'] }).remember, ['once']);
});

test('"always" saves one every-agent grant: no card for that tool in this or any other conversation', async (t) => {
  const h = harness(t);
  const card = await h.decide(SHELL('git push'), LEAD);
  const answered = await h.choose(card, 'always');
  assert.equal(answered.remember, 'always');
  assert.deepEqual(
    (await h.store.listGrants()).map(({ agentId, action, mode }) => ({ agentId, action, mode })),
    [{ agentId: '*', action: 'tool:shell', mode: 'allow' }]
  );
  // Same conversation, another command; another coding conversation; Mixy; a bot's chat.
  for (const [sessionId, call] of [
    [LEAD, SHELL('rm -rf build')],
    [OTHER_LEAD, SHELL('ls')],
    [MIXY, SHELL('ls')],
    [MAILER, SHELL('ls')],
  ]) {
    const again = await h.decide(call, sessionId);
    assert.equal(again.request, null, sessionId);
    assert.equal(again.gate, null, sessionId);
    assert.equal(again.decision.action, 'allow', 'the hook ask is answered, not left pending');
  }
  assert.deepEqual(
    (await h.store.readAudit({ agentId: 'lead' })).map((row) => [row.decision, row.action]).slice(0, 3),
    [
      ['remembered', 'tool:shell'],
      ['remembered', 'tool:shell'],
      ['remembered', 'tool:shell'],
    ]
  );
  const rows = await h.store.readAudit({ limit: 100 });
  assert.deepEqual(rows.slice(-2).map((row) => row.decision), ['granted', 'approve']);
});

test('the answered call keeps a hook rewrite and is not marked as an outbound approval', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  const again = await h.decide(SHELL('a'), LEAD, { action: 'ask', reason: 'r', args: { command: 'safe' } });
  assert.equal(again.decision.action, 'modify');
  assert.deepEqual(again.decision.args, { command: 'safe' });
  assert.equal(again.remembered, undefined, 'a connector layer is still asked its own question');
});

test('"this session" covers the tool for that conversation only, ends on reset and after 12 h, never saved', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  assert.deepEqual(await h.store.listGrants(), [], 'nothing saved');
  assert.equal((await h.decide(SHELL('b'), LEAD)).request, null);
  assert.ok(asks(await h.decide(SHELL('b'), OTHER_LEAD)), 'another conversation still asks');
  assert.ok(asks(await h.decide(SHELL('b'), MIXY)));
  assert.ok(asks(await h.decide(EDIT, LEAD)), 'another tool still asks');
  assert.deepEqual(
    (await h.store.readAudit({ agentId: 'lead' })).map((row) => row.decision).slice(0, 3),
    ['session-remembered', 'session-granted', 'approve']
  );
  h.reset(LEAD);
  assert.ok(asks(await h.decide(SHELL('b'), LEAD)), 'a reset session asks again');
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  h.advance(SESSION_GRANT_TTL_MS - 1);
  assert.equal((await h.decide(SHELL('b'), LEAD)).request, null);
  h.advance(2);
  assert.ok(asks(await h.decide(SHELL('b'), LEAD)), 'expired');
});

test('the key is the tool (or the classified kind), never the arguments: nothing widens to an unrelated call', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(MCP('write_it'), LEAD), 'always');
  assert.equal((await h.decide({ name: 'mcp__acme__write_it', args: { anything: 'else' } }, LEAD)).request, null);
  for (const other of [MCP('write_other'), { name: 'mcp__acme2__write_it', args: {} }, SHELL('x'), EDIT]) {
    assert.ok(asks(await h.decide(other, LEAD)), other.name);
  }
  // A classified send is keyed by its kind, not by the multiplexing tool's name.
  const comment = await h.decide(COMMENT, LEAD);
  assert.equal(comment.request.grantAction, 'comment');
  await h.choose(comment, 'always');
  assert.equal((await h.decide(COMMENT, LEAD)).request, null);
  assert.ok(asks(await h.decide(MERGE, LEAD)), 'another github action is a different key');
  assert.equal((await h.decide(MERGE, LEAD)).request.grantAction, 'tool:github');
  // The key's shape.
  assert.equal(toolActionOf('shell'), 'tool:shell');
  for (const name of ['', 'has space', 'a'.repeat(200), 'setup', 'ask_user', 'handoff_user', 'x/y']) {
    assert.equal(toolActionOf(name), '', name);
  }
  assert.equal(isToolAction('tool:shell'), true);
  assert.equal(isRememberableAction('tool:shell'), true);
  assert.equal(isRememberableAction('tool:setup'), false);
});

test('tools that change what agents may do, and the user prompts, are asked once', async (t) => {
  const h = harness(t);
  for (const name of ['setup', 'ask_user', 'handoff_user']) {
    const card = await h.decide({ name, args: { action: 'set_agent_permission' } }, LEAD);
    assert.deepEqual(card.request.remember, ['once'], name);
    assert.equal(card.gate.action, undefined, name);
    await h.answer(card.gate, { approved: true, remember: 'always' });
  }
  assert.deepEqual(await h.store.listGrants(), []);
});

test('payments and permanent deletes are never offered, stored or honoured, and are not skipped by Allow all actions', async (t) => {
  const h = harness(t);
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const card = await h.decide(call, LEAD);
    assert.deepEqual(card.request.remember, ['once'], call.name);
    assert.equal(card.request.grantAction, undefined, call.name);
    assert.equal(card.gate.action, undefined, call.name);
    for (const remember of ['session', 'always']) {
      await h.answer({ ...card.gate, remember: ['once', 'session', 'always'], sessionId: LEAD, action: 'tool:' + call.name },
        { approved: true, remember });
    }
    // Even a stored or session grant for the tool's key answers nothing.
    assert.ok(asks(await h.decide(call, LEAD)), `${call.name} asks again`);
  }
  await h.store.grant({ agentId: 'lead', action: toolActionOf(PAYMENT.name), scope: 'always' });
  assert.ok(asks(await h.decide(PAYMENT, LEAD)), 'a hand-written grant is never honoured for a payment');
  await updateSection('agent', (current) => ({ ...current, developer: { allowAllActions: true } }));
  assert.ok(asks(await h.decide(PAYMENT, LEAD)));
  assert.ok(asks(await h.decide(PERMANENT_DELETE, LEAD)));
  // An ordinary tool is skipped by the option, as before (and audited so).
  assert.equal((await h.decide(SHELL('ls'), LEAD)).request, null);
});

test('a grant for one kind or tool never answers a payment, a delete or another kind', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(COMMENT, LEAD), 'always');
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  assert.ok(asks(await h.decide(PAYMENT, LEAD)));
  assert.ok(asks(await h.decide(PERMANENT_DELETE, LEAD)));
  assert.ok(asks(await h.decide(EMAIL, LEAD)), 'another kind');
  assert.ok(asks(await h.decide(EDIT, LEAD)), 'another tool');
});

test('an unattended run never gets or uses a session grant; it may use a saved always grant', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  const RUN = { kind: 'schedule', agentId: 'mailer', name: 'daily' };
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === LEAD ? RUN : null) });
  const inRun = await h.decide(SHELL('b'), LEAD);
  assert.ok(asks(inRun), 'the run does not inherit the session grant');
  assert.deepEqual(inRun.request.remember, ['once'], 'a run is offered neither this-session nor always');
  // A session answer recorded for the run stores nothing.
  await h.answer({ ...inRun.gate, remember: ['once', 'session', 'always'] }, { approved: true, remember: 'session' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: () => null });
  h.reset(LEAD);
  assert.ok(asks(await h.decide(SHELL('c'), LEAD)));
  // A saved every-agent allow is what a run may use (as for every other saved grant).
  await h.store.grant({ agentId: 'lead', action: 'tool:shell', scope: 'always' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === LEAD ? RUN : null) });
  assert.equal((await h.decide(SHELL('d'), LEAD)).request, null);
});

test('a timeout or a denial stores no decision', async (t) => {
  const h = harness(t);
  const card = await h.decide(SHELL('a'), LEAD);
  const denied = normalizeHumanResponse(card.request, false, { remember: 'always' });
  assert.equal(denied.remember, 'once');
  await h.answer(card.gate, { approved: false, response: 'deny', timedOut: true, remember: 'always' });
  await h.answer(card.gate, { approved: true, timedOut: true, remember: 'session' });
  await h.answer(card.gate, { approved: false, response: 'deny', remember: 'always' });
  assert.deepEqual(await h.store.listGrants(), []);
  assert.ok(asks(await h.decide(SHELL('a'), LEAD)));
  const rows = await h.store.readAudit({ agentId: 'lead' });
  assert.ok(rows.every((row) => !['granted', 'session-granted'].includes(row.decision)));
  assert.equal(rows.filter((row) => row.decision === 'timeout').length, 2);
});

test('a bot hook ask on a classified send offers once / session / always and is answered by those only', async (t) => {
  const h = harness(t);
  const card = await h.decide(EMAIL, MAILER);
  assert.equal(card.request.kind, 'outbound');
  assert.deepEqual(card.request.remember, ['once', 'session', 'always']);
  await h.choose(card, 'always');
  assert.deepEqual(
    (await h.store.listGrants()).map(({ agentId, action }) => [agentId, action]),
    [['*', 'email']]
  );
  // Every conversation (another bot, Mixy, a coding Lead's hook ask) is answered.
  for (const sessionId of ['sess_home_scribe', MIXY]) {
    const again = await h.decide(EMAIL, sessionId);
    assert.equal(again.request, null, sessionId);
    assert.equal(again.decision.action, 'allow', sessionId);
    // It answers the hook's ask only: the flag that skips a connector's own approval layer is not set.
    assert.equal(again.remembered, undefined, sessionId);
  }
  assert.equal((await h.decide(EMAIL, LEAD)).request, null);
  // A bot's own "this agent" allow is not an answer to a hook's ask, as before.
  const h2 = harness(t);
  await h2.store.grant({ agentId: 'mailer', action: 'email', scope: 'agent' });
  assert.ok(asks(await h2.decide(EMAIL, MAILER)), 'the hook still asks');
  // A bot's own standing allow on a plain (non-hook) call is the outbound grant that does skip the connector layer.
  assert.equal((await h2.decide(EMAIL, MAILER, { action: 'allow' })).remembered, true, 'a plain call is allowed');
  // A session allowance answers a hook ask for the same session only.
  const h3 = harness(t);
  await h3.choose(await h3.decide(EMAIL, MAILER), 'session');
  const viaSession = await h3.decide(EMAIL, MAILER);
  assert.equal(viaSession.request, null);
  assert.equal(viaSession.remembered, undefined, 'only the hook ask is answered');
  assert.ok(asks(await h3.decide(EMAIL, 'sess_home_scribe')));
  // The bot's block still wins over an every-agent allow.
  await h.store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  assert.equal((await h.decide(EMAIL, MAILER)).decision.action, 'deny');
});

test('a shared allow is listed in every agent\'s permissions and revoking it there turns it back to asking', async (t) => {
  const h = harness(t);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  await h.choose(await h.decide(COMMENT, LEAD), 'always');
  for (const agent of ['lead', 'mailer', 'scribe']) {
    const rows = (await agentPermissions(agent)).filter((row) => row.mode === 'allow');
    assert.deepEqual(
      rows.map(({ action, shared, rememberable }) => ({ action, shared, rememberable })),
      [
        { action: 'comment', shared: true, rememberable: true },
        { action: 'tool:shell', shared: true, rememberable: true },
      ],
      agent
    );
  }
  // An agent's own allow for the same kind is a separate, unshared row.
  await h.store.grant({ agentId: 'mailer', action: 'comment', scope: 'agent' });
  const own = (await agentPermissions('mailer')).find((row) => row.action === 'comment');
  assert.equal(own.shared, undefined);
  // Asking again removes the agent's own allow first; the shared one stays until asked again.
  await setAgentPermission('mailer', 'comment', 'ask');
  assert.equal((await agentPermissions('mailer')).find((row) => row.action === 'comment').shared, true);
  assert.equal((await h.decide(COMMENT, LEAD)).request, null);
  await setAgentPermission('scribe', 'comment', 'ask');
  await setAgentPermission('mailer', 'tool:shell', 'ask');
  assert.deepEqual(await h.store.listGrants(), []);
  assert.ok(asks(await h.decide(SHELL('a'), LEAD)));
  assert.ok(asks(await h.decide(COMMENT, LEAD)));
  // A remote client's revoke narrows and is accepted; a tool can only be set back to asking.
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  await setAgentPermission('lead', 'tool:shell', 'ask', { noWiden: true });
  assert.deepEqual(await h.store.listGrants(), []);
  await assert.rejects(setAgentPermission('mailer', 'tool:shell', 'allow'), /only be set back to ask/);
  await assert.rejects(setAgentPermission('mailer', 'tool:shell', 'block'), /only be set back to ask/);
  await assert.rejects(setAgentPermission('mailer', 'tool:setup', 'ask'), /action must be one of/);
});

test('a damaged or hand-edited grants file never yields a tool grant for another agent or a block', async (t) => {
  const h = harness(t);
  await h.store.setMode({ agentId: 'mailer', action: 'tool:shell', mode: 'allow' });
  await h.store.setMode({ agentId: '*', action: 'tool:shell', mode: 'block' });
  await h.store.setMode({ agentId: '*', action: 'tool:setup', mode: 'allow' });
  assert.deepEqual(await h.store.listGrants(), []);
  assert.equal(await h.store.modeFor({ agentId: 'lead', action: 'tool:shell' }), 'ask');
});

test('the card is told what the choice covers: the action kind of a classified call, else the tool', async (t) => {
  const h = harness(t);
  const kind = await h.decide(COMMENT, LEAD);
  const presented = { kind: 'approval', ...humanRequestFields(kind.request) };
  assert.equal(presented.grantAction, 'comment', 'not the multiplexing tool "github"');
  assert.equal(humanRequestFields((await h.decide(SHELL('a'), LEAD)).request).grantAction, 'tool:shell');
  assert.equal(humanRequestFields((await h.decide(MERGE, LEAD)).request).grantAction, 'tool:github');
  // Once-only requests carry none.
  for (const call of [PAYMENT, { name: 'setup', args: {} }]) {
    assert.equal(humanRequestFields((await h.decide(call, LEAD)).request).grantAction, undefined, call.name);
  }
});