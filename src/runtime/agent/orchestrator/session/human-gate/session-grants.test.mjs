// "Allow for this session": one answer per ACTION KIND (any site or target),
// scoped to one session, expiring with it, never given to payments, permanent
// deletes or unattended runs, and never stored on a timeout or a denial.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'session-grants-data-'));
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
mkdirSync(join(dataRoot, 'agents', 'worker'), { recursive: true });
writeFileSync(join(dataRoot, 'agents', 'worker', 'AGENT.md'), '---\nkind: agent\n---\nYou are worker.\n');

const { updateSection } = await import('../../../../shared/config.mjs');
const { humanGateDecision, recordHumanDecision, sessionLifeMark, setUnattendedApprovalPort, unattendedApprovalPort } =
  await import('./gate.mjs');
const { roomMemberSessionId } = await import('../agent-room.mjs');
const { humanRequestFields, normalizeHumanResponse } = await import('./requests.mjs');
const { createHumanGateStore, setHumanGateStore } = await import('./store.mjs');
const { SESSION_GRANT_TTL_MS, createSessionGrants } = await import('./session-grants.mjs');
const { setLiveSession } = await import('../store.mjs');

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});
test.afterEach(() => updateSection('agent', (current) => ({ ...current, developer: {} })));

const HOME = 'sess_home_mailer';
const OTHER_HOME = 'sess_home_scribe';
const COMMENT = (repo, number) => ({
  name: 'github',
  args: { action: 'pr.comment', repo, number, body: 'LGTM' },
});
const EMAIL = { name: 'mcp__gmail__send_email', args: { to: 'a@b.c', subject: 's', body: 'hi' } };
const PAYMENT = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'USD', merchant: 'Notion' } };
const PERMANENT_DELETE = { name: 'mcp__drive__delete_permanently', args: { ids: ['a'] } };

/** A store, a session-grant registry on a movable clock and a movable session life. */
function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'session-grants-store-'));
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
    sessionGrants,
    ctx,
    advance: (ms) => {
      clock += ms;
    },
    reset: (sessionId) => lives.set(sessionId, `reset-${clock}-${lives.size}`),
    end: (sessionId) => lives.set(sessionId, null),
    decide: (call, sessionId, hook = null) => humanGateDecision(call, hook, ctx(sessionId)),
    answer: (gate, approval) => recordHumanDecision(gate, approval, { store, sessionGrants, sessionLife: life }),
  };
}

test('a session grant covers the action kind on every site and target, nothing else, nobody else', async (t) => {
  const h = harness(t);
  const first = await h.decide(COMMENT('o/r', 1), HOME);
  assert.equal(first.decision.action, 'ask');
  assert.deepEqual(first.request.remember, ['once', 'session', 'agent']);
  const normalized = normalizeHumanResponse(first.request, true, { remember: 'session' });
  assert.equal(normalized.remember, 'session');
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session', device: 'PC' });

  for (const repo of ['o/r', 'other/repo', 'third/site']) {
    const again = await h.decide(COMMENT(repo, 9), HOME, { action: 'allow' });
    assert.equal(again.request, null, repo);
    assert.equal(again.remembered, true, repo);
  }
  // Another kind still asks; another session of the same bot still asks.
  assert.equal((await h.decide(EMAIL, HOME)).decision.action, 'ask');
  assert.equal((await h.decide(COMMENT('o/r', 1), roomMemberSessionId('room123abc', 'mailer'))).decision.action, 'ask');
  assert.equal((await h.decide(COMMENT('o/r', 1), OTHER_HOME)).decision.action, 'ask');
  // Nothing was written to the permanent store: "this session" is not "always".
  assert.deepEqual(await h.store.listGrants(), []);
  assert.equal(await h.store.modeFor({ agentId: 'mailer', action: 'comment' }), 'ask');

  const decisions = (await h.store.readAudit({ agentId: 'mailer' })).map((row) => row.decision);
  assert.deepEqual(decisions.slice(0, 5), [
    'session-remembered',
    'session-remembered',
    'session-remembered',
    'session-granted',
    'approve',
  ]);
});

test('"always" stays a saved, revocable allow and is audited like the session one', async (t) => {
  const h = harness(t);
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'agent' });
  const [grant] = await h.store.listGrants({ agentId: 'mailer' });
  assert.equal(grant.action, 'email');
  const again = await h.decide(EMAIL, HOME, { action: 'allow' });
  assert.equal(again.remembered, true);
  assert.deepEqual((await h.store.readAudit({ agentId: 'mailer' })).map((row) => row.decision).slice(0, 3), [
    'remembered',
    'granted',
    'approve',
  ]);
  assert.equal(await h.store.revokeGrant(grant.id), true);
  assert.equal((await h.decide(EMAIL, HOME)).decision.action, 'ask');
});

test('a session grant expires after its time limit', async (t) => {
  const h = harness(t);
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
  h.advance(SESSION_GRANT_TTL_MS - 1);
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).remembered, true);
  h.advance(2);
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).decision.action, 'ask', 'expired: asks again');
  // The limit is not sliding: using it did not extend it, and it does not come back.
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).decision.action, 'ask');
});

test('a session grant ends when its session is reset, closed or replaced', async (t) => {
  const h = harness(t);
  for (const [label, change] of [
    ['reset', () => h.reset(HOME)],
    ['ended', () => h.end(HOME)],
  ]) {
    const first = await h.decide(EMAIL, HOME);
    await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
    assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).remembered, true, label);
    change();
    assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).decision.action, 'ask', label);
  }
  // A session that cannot be read at all grants nothing.
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, remember: 'session' });
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).decision.action, 'ask');
});

test('the real session life changes when the session is cleared or closed', () => {
  const id = 'sess_home_lifecheck';
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5 });
  const before = sessionLifeMark(id);
  assert.ok(before);
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5, compaction: { lastClearAt: 77 } });
  const afterClear = sessionLifeMark(id);
  assert.notEqual(afterClear, before);
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5, compaction: { lastClearAt: 77 }, closed: true });
  assert.equal(sessionLifeMark(id), null);
  assert.equal(sessionLifeMark('sess_unknown_nothing'), null);
});

test('unattended runs never inherit a session grant but do use "always" and run policy', async (t) => {
  const h = harness(t);
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
  // The same session id is now owned by a schedule run (a routine turn in the home chat).
  const RUN = { kind: 'schedule', agentId: 'mailer', name: 'daily' };
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === HOME ? RUN : null) });
  const inRun = await h.decide(EMAIL, HOME, { action: 'allow' });
  assert.equal(inRun.decision.action, 'ask', 'the run asks (and run policy then answers it)');
  assert.ok(!inRun.request.remember.includes('session'), 'a run is never offered this-session');
  assert.equal(inRun.remembered, undefined);
  // An "always" grant is what a run may use.
  await h.store.grant({ agentId: 'mailer', action: 'email', scope: 'agent' });
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).remembered, true);
  // And a session answer recorded for a run's session stores nothing.
  const runCard = await h.decide(COMMENT('o/r', 1), HOME);
  await h.answer({ ...runCard.gate, remember: ['once', 'session'] }, { approved: true, remember: 'session' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: () => null });
  assert.equal((await h.decide(COMMENT('o/r', 2), HOME, { action: 'allow' })).decision.action, 'ask');
});

test('payments and permanent deletes are never offered, granted or remembered for a session', async (t) => {
  const h = harness(t);
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const out = await h.decide(call, HOME);
    assert.equal(out.decision.action, 'ask', call.name);
    assert.deepEqual(out.request.remember, ['once'], call.name);
    assert.deepEqual(
      humanRequestFields({ ...out.request, remember: ['once', 'session', 'agent'] }).remember,
      ['once'],
      'a request that lists more still offers once'
    );
    // Even a forged answer (or a gate that lists session) stores no allowance.
    await h.answer({ ...out.gate, remember: ['once', 'session', 'agent'] }, { approved: true, remember: 'session' });
    await h.answer({ ...out.gate, remember: undefined }, { approved: true, remember: 'agent' });
    assert.equal((await h.decide(call, HOME, { action: 'allow' })).decision.action, 'ask', `${call.name} asks again`);
  }
  assert.equal(h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: 'payment' }), false);
  assert.equal(h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: 'delete' }), false);
  assert.deepEqual(await h.store.listGrants(), []);
  // "Allow all actions" skips ordinary asks but not these.
  await updateSection('agent', (current) => ({ ...current, developer: { allowAllActions: true } }));
  assert.equal((await h.decide(PAYMENT, HOME)).decision.action, 'ask');
  assert.equal((await h.decide(PERMANENT_DELETE, HOME)).decision.action, 'ask');
});

test('a grant for one kind never answers a payment, a delete or another kind', async (t) => {
  const h = harness(t);
  for (const kind of ['comment', 'email', 'message', 'publish', 'form']) {
    assert.equal(h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: kind }), true, kind);
  }
  assert.equal(h.sessionGrants.has({ sessionId: HOME, agentId: 'mailer', action: 'payment' }), false);
  assert.equal(h.sessionGrants.has({ sessionId: HOME, agentId: 'mailer', action: 'delete' }), false);
  assert.equal(h.sessionGrants.has({ sessionId: HOME, agentId: 'mailer', action: 'review' }), false);
  assert.equal(h.sessionGrants.has({ sessionId: HOME, agentId: 'scribe', action: 'email' }), false);
  assert.equal((await h.decide(PAYMENT, HOME, { action: 'allow' })).decision.action, 'ask');
  assert.equal((await h.decide(PERMANENT_DELETE, HOME, { action: 'allow' })).decision.action, 'ask');
});

test("the bot's block still stops a kind that was allowed for the session", async (t) => {
  const h = harness(t);
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, remember: 'session' });
  await h.store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  const out = await h.decide(EMAIL, HOME, { action: 'allow' });
  assert.equal(out.decision.action, 'deny');
});

test('a timeout or a denial stores no decision, whatever scope came with it', async (t) => {
  const h = harness(t);
  const first = await h.decide(EMAIL, HOME);
  const timedOut = normalizeHumanResponse(first.request, false, { remember: 'session' });
  assert.equal(timedOut.remember, 'once');
  await h.answer(first.gate, { approved: false, response: 'deny', timedOut: true, remember: 'session' });
  await h.answer(first.gate, { approved: true, timedOut: true, remember: 'session' });
  await h.answer(first.gate, { approved: false, response: 'deny', remember: 'agent' });
  assert.deepEqual(await h.store.listGrants(), []);
  assert.equal((await h.decide(EMAIL, HOME, { action: 'allow' })).decision.action, 'ask');
  const rows = await h.store.readAudit({ agentId: 'mailer' });
  assert.ok(rows.every((row) => !['granted', 'session-granted'].includes(row.decision)));
  assert.equal(rows.filter((row) => row.decision === 'timeout').length, 2);
});

test('secret, takeover, connector and permission requests are answered once, whatever they list', () => {
  const listed = ['once', 'session', 'agent', 'always'];
  const requests = [
    { kind: 'secret', secret: { requestId: 'secret_abcdefgh' } },
    { kind: 'takeover', takeover: { surface: 'browser', instructions: 'sign in' } },
    {
      kind: 'connector',
      connector: { server: 's', tool: 't', from: 'disabled', requested: 'auto', choices: ['auto'] },
    },
  ];
  for (const input of requests) {
    const fields = humanRequestFields({ ...input, remember: listed });
    assert.deepEqual(fields.remember, ['once'], input.kind);
    const presented = { kind: input.kind, ...fields };
    for (const remember of listed) {
      assert.equal(normalizeHumanResponse(presented, true, { remember, scope: 'auto' }).remember, 'once', input.kind);
    }
  }
  // A permission request has no action kind: no this-session scope exists for it.
  assert.ok(!humanRequestFields({ kind: 'permission', remember: listed }).remember.includes('session'));
  // Neither does an ordinary approval that names no kind.
  assert.ok(!humanRequestFields({ kind: 'approval', remember: listed }).remember.includes('session'));
});

test('the session registry is bounded: oldest first, expired entries pruned on read', () => {
  let clock = 0;
  const grants = createSessionGrants({ now: () => clock, maxEntries: 3, ttlMs: 100 });
  for (const n of [1, 2, 3, 4]) grants.grant({ sessionId: `s${n}`, agentId: 'a', action: 'email' });
  assert.equal(grants.has({ sessionId: 's1', agentId: 'a', action: 'email' }), false, 'oldest evicted');
  assert.equal(grants.has({ sessionId: 's4', agentId: 'a', action: 'email' }), true);
  clock = 101;
  assert.equal(grants.has({ sessionId: 's2', agentId: 'a', action: 'email' }), false);
  clock = 0;
  assert.equal(grants.has({ sessionId: 's3', agentId: 'a', action: 'email' }), false, 'pruned, not just hidden');
});
