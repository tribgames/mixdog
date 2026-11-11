#!/usr/bin/env node
// Recording of session/human-gate/session-grants.test.mjs (b6f10295a): "Allow for this session" — one answer per action kind, scoped to
// one session, expiring with it, never given to payments, permanent deletes or unattended runs, and never stored on a timeout or a
// denial. Real human-gate modules (gate.mjs, requests.mjs, store.mjs, session-grants.mjs on a movable clock), agent-room member
// session ids, and the live session store (setLiveSession + sessionLifeMark) over a temp data dir with the test's agent roster.
// Per case: each call decided (decision, request, gate, remembered), each answer recorded, and the store's grants and audit after.
//
//   node benchmarks/rust-core/recorders/record-session-grants-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const dataRoot = mkdtempSync(join(tmpdir(), 'session-grants-data-'));
process.env.MIXDOG_DATA_DIR = dataRoot;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dataRoot, 'backups');
for (const id of ['mailer', 'scribe']) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: bot\n---\nYou are ${id}.\n`);
}
mkdirSync(join(dataRoot, 'agents', 'worker'), { recursive: true });
writeFileSync(join(dataRoot, 'agents', 'worker', 'AGENT.md'), '---\nkind: agent\n---\nYou are worker.\n');
const set = openSet('session-grants-cases', import.meta.url);
const S = 'src/runtime/agent/orchestrator/session/';
const G = `${S}human-gate/`;
const { updateSection } = await set.load('src/runtime/shared/config.mjs');
const { humanGateDecision, recordHumanDecision, sessionLifeMark, setUnattendedApprovalPort, unattendedApprovalPort } = await set.load(`${G}gate.mjs`);
const { roomMemberSessionId } = await set.load(`${S}agent-room.mjs`);
const { humanRequestFields, normalizeHumanResponse } = await set.load(`${G}requests.mjs`);
const { createHumanGateStore, setHumanGateStore } = await set.load(`${G}store.mjs`);
const { SESSION_GRANT_TTL_MS, createSessionGrants } = await set.load(`${G}session-grants.mjs`);
const { setLiveSession } = await set.load(`${S}store.mjs`);

const HOME = 'sess_home_mailer'; const OTHER_HOME = 'sess_home_scribe';
const COMMENT = (repo, number) => ({ name: 'github', args: { action: 'pr.comment', repo, number, body: 'LGTM' } });
const EMAIL = { name: 'mcp__gmail__send_email', args: { to: 'a@b.c', subject: 's', body: 'hi' } };
const PAYMENT = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'USD', merchant: 'Notion' } };
const PERMANENT_DELETE = { name: 'mcp__drive__delete_permanently', args: { ids: ['a'] } };

const cleanups = [];
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'session-grants-store-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  let clock = 1_000_000;
  const lives = new Map();
  const sessionGrants = createSessionGrants({ now: () => clock });
  const port = unattendedApprovalPort();
  cleanups.push(async () => { setUnattendedApprovalPort(port); setHumanGateStore(null); rmSync(dir, { recursive: true, force: true }); await updateSection('agent', (current) => ({ ...current, developer: {} })); });
  const life = (sessionId) => (lives.has(sessionId) ? lives.get(sessionId) : `life-${sessionId}`);
  const ctx = (sessionId) => ({ sessionId, store, sessionGrants, sessionLife: life, annotations: {} });
  const log = [];
  return {
    store, sessionGrants, log,
    advance: (ms) => { clock += ms; log.push({ do: 'advance', ms }); },
    reset: (sessionId) => { lives.set(sessionId, `reset-${clock}-${lives.size}`); log.push({ do: 'reset session life', sessionId }); },
    end: (sessionId) => { lives.set(sessionId, null); log.push({ do: 'end session life (null)', sessionId }); },
    decide: async (call, sessionId, hook = null) => {
      const out = await humanGateDecision(call, hook, ctx(sessionId));
      log.push({ do: 'decide', call, sessionId, hook, decision: out.decision, request: out.request ?? null, gate: out.gate ?? null, remembered: out.remembered ?? null });
      return out;
    },
    answer: async (gate, approval) => { await recordHumanDecision(gate, approval, { store, sessionGrants, sessionLife: life }); log.push({ do: 'answer', gate, approval }); },
    grants: async (label, filter) => { const rows = (await store.listGrants(filter)).map(({ agentId, action, mode, scope }) => ({ agentId, action, mode, scope: scope ?? null })); log.push({ do: 'grants', label, grants: rows }); return rows; },
    audit: async (label, filter) => { const rows = (await store.readAudit(filter)).map((row) => ({ agentId: row.agentId, decision: row.decision, action: row.action })); log.push({ do: 'audit', label, filter: filter ?? null, rows }); return rows; },
  };
}
async function run(name, fn) {
  await set.run(name, async () => { const h = harness(); try { const extra = await fn(h); return { log: h.log, ...(extra ?? {}) }; } finally { while (cleanups.length) await cleanups.pop()(); } });
}

await run('a session grant covers the action kind on every site and target, nothing else, nobody else', async (h) => {
  const first = await h.decide(COMMENT('o/r', 1), HOME);
  const normalized = normalizeHumanResponse(first.request, true, { remember: 'session' });
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session', device: 'PC' });
  for (const repo of ['o/r', 'other/repo', 'third/site']) await h.decide(COMMENT(repo, 9), HOME, { action: 'allow' });
  await h.decide(EMAIL, HOME);
  const roomSession = roomMemberSessionId('room123abc', 'mailer');
  await h.decide(COMMENT('o/r', 1), roomSession);
  await h.decide(COMMENT('o/r', 1), OTHER_HOME);
  await h.grants('after');
  h.log.push({ do: 'modeFor mailer comment', mode: await h.store.modeFor({ agentId: 'mailer', action: 'comment' }) });
  await h.audit('mailer', { agentId: 'mailer' });
  return { normalizedRemember: normalized.remember, roomSession };
});
await run('"always" stays a saved, revocable allow and is audited like the session one', async (h) => {
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'agent' });
  const [grant] = await h.grants('after agent allow', { agentId: 'mailer' });
  await h.decide(EMAIL, HOME, { action: 'allow' });
  await h.audit('mailer', { agentId: 'mailer' });
  const all = await h.store.listGrants({ agentId: 'mailer' });
  const revoked = await h.store.revokeGrant(all[0].id);
  h.log.push({ do: 'revokeGrant (the one grant)', revoked });
  await h.decide(EMAIL, HOME);
  return { grantAction: grant.action };
});
await run('a session grant expires after its time limit', async (h) => {
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
  h.advance(SESSION_GRANT_TTL_MS - 1);
  await h.decide(EMAIL, HOME, { action: 'allow' });
  h.advance(2);
  await h.decide(EMAIL, HOME, { action: 'allow' });
  await h.decide(EMAIL, HOME, { action: 'allow' });
  return { sessionGrantTtlMs: SESSION_GRANT_TTL_MS };
});
await run('a session grant ends when its session is reset, closed or replaced', async (h) => {
  for (const [label, change] of [['reset', () => h.reset(HOME)], ['ended', () => h.end(HOME)]]) {
    h.log.push({ do: `scenario ${label}` });
    const first = await h.decide(EMAIL, HOME);
    await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
    await h.decide(EMAIL, HOME, { action: 'allow' });
    change();
    await h.decide(EMAIL, HOME, { action: 'allow' });
  }
  h.log.push({ do: 'scenario a session that cannot be read at all (life is null)' });
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, remember: 'session' });
  await h.decide(EMAIL, HOME, { action: 'allow' });
});
await run('the real session life changes when the session is cleared or closed', async (h) => {
  const id = 'sess_home_lifecheck';
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5 });
  const before = sessionLifeMark(id);
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5, compaction: { lastClearAt: 77 } });
  const afterClear = sessionLifeMark(id);
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 5, compaction: { lastClearAt: 77 }, closed: true });
  return { sessionId: id, before, afterClear, afterClose: sessionLifeMark(id), unknown: sessionLifeMark('sess_unknown_nothing'), beforeTruthy: Boolean(before), clearedDiffers: afterClear !== before };
});
await run('unattended runs never inherit a session grant but do use "always" and run policy', async (h) => {
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, response: 'approve', remember: 'session' });
  const RUN = { kind: 'schedule', agentId: 'mailer', name: 'daily' };
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === HOME ? RUN : null) });
  h.log.push({ do: 'unattended port: the home session is a run', run: RUN });
  await h.decide(EMAIL, HOME, { action: 'allow' });
  await h.store.grant({ agentId: 'mailer', action: 'email', scope: 'agent' });
  h.log.push({ do: 'store.grant', agentId: 'mailer', action: 'email', scope: 'agent' });
  await h.decide(EMAIL, HOME, { action: 'allow' });
  const runCard = await h.decide(COMMENT('o/r', 1), HOME);
  await h.answer({ ...runCard.gate, remember: ['once', 'session'] }, { approved: true, remember: 'session' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: () => null });
  h.log.push({ do: 'unattended port: no run' });
  await h.decide(COMMENT('o/r', 2), HOME, { action: 'allow' });
});
await run('payments and permanent deletes are never offered, granted or remembered for a session', async (h) => {
  const offered = [];
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const out = await h.decide(call, HOME);
    offered.push({ tool: call.name, listsMoreStillOnce: humanRequestFields({ ...out.request, remember: ['once', 'session', 'agent'] }).remember });
    await h.answer({ ...out.gate, remember: ['once', 'session', 'agent'] }, { approved: true, remember: 'session' });
    await h.answer({ ...out.gate, remember: undefined }, { approved: true, remember: 'agent' });
    await h.decide(call, HOME, { action: 'allow' });
  }
  const direct = [h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: 'payment' }), h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: 'delete' })];
  await h.grants('after');
  await updateSection('agent', (current) => ({ ...current, developer: { allowAllActions: true } }));
  h.log.push({ do: 'config agent.developer.allowAllActions = true' });
  await h.decide(PAYMENT, HOME); await h.decide(PERMANENT_DELETE, HOME);
  return { offered, sessionGrantsGrantPaymentThenDelete: direct };
});
await run('a grant for one kind never answers a payment, a delete or another kind', async (h) => {
  const kinds = ['comment', 'email', 'message', 'publish', 'form'];
  const granted = kinds.map((kind) => ({ kind, granted: h.sessionGrants.grant({ sessionId: HOME, agentId: 'mailer', action: kind }) }));
  const has = [['mailer', 'payment'], ['mailer', 'delete'], ['mailer', 'review'], ['scribe', 'email']].map(([agentId, action]) => ({ agentId, action, has: h.sessionGrants.has({ sessionId: HOME, agentId, action }) }));
  await h.decide(PAYMENT, HOME, { action: 'allow' }); await h.decide(PERMANENT_DELETE, HOME, { action: 'allow' });
  return { granted, has };
});
await run("the bot's block still stops a kind that was allowed for the session", async (h) => {
  const first = await h.decide(EMAIL, HOME);
  await h.answer(first.gate, { approved: true, remember: 'session' });
  await h.store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  h.log.push({ do: 'store.setMode', agentId: 'mailer', action: 'email', mode: 'block' });
  await h.decide(EMAIL, HOME, { action: 'allow' });
});
await run('a timeout or a denial stores no decision, whatever scope came with it', async (h) => {
  const first = await h.decide(EMAIL, HOME);
  const timedOut = normalizeHumanResponse(first.request, false, { remember: 'session' });
  await h.answer(first.gate, { approved: false, response: 'deny', timedOut: true, remember: 'session' });
  await h.answer(first.gate, { approved: true, timedOut: true, remember: 'session' });
  await h.answer(first.gate, { approved: false, response: 'deny', remember: 'agent' });
  await h.grants('after');
  await h.decide(EMAIL, HOME, { action: 'allow' });
  await h.audit('mailer', { agentId: 'mailer' });
  return { timedOutRemember: timedOut.remember };
});
await run('secret, takeover, connector and permission requests are answered once, whatever they list', async () => {
  const listed = ['once', 'session', 'agent', 'always'];
  const requests = [
    { kind: 'secret', secret: { requestId: 'secret_abcdefgh' } },
    { kind: 'takeover', takeover: { surface: 'browser', instructions: 'sign in' } },
    { kind: 'connector', connector: { server: 's', tool: 't', from: 'disabled', requested: 'auto', choices: ['auto'] } },
  ];
  return {
    listed,
    requests: requests.map((input) => {
      const fields = humanRequestFields({ ...input, remember: listed });
      const presented = { kind: input.kind, ...fields };
      return { input, remember: fields.remember, normalized: listed.map((remember) => ({ remember, result: normalizeHumanResponse(presented, true, { remember, scope: 'auto' }).remember })) };
    }),
    permissionRemember: humanRequestFields({ kind: 'permission', remember: listed }).remember,
    approvalWithoutKindRemember: humanRequestFields({ kind: 'approval', remember: listed }).remember,
  };
});
await run('the session registry is bounded: oldest first, expired entries pruned on read', async () => {
  let clock = 0;
  const grants = createSessionGrants({ now: () => clock, maxEntries: 3, ttlMs: 100 });
  const log = [];
  for (const n of [1, 2, 3, 4]) log.push({ do: 'grant', sessionId: `s${n}`, granted: grants.grant({ sessionId: `s${n}`, agentId: 'a', action: 'email' }) });
  const has = (sessionId) => grants.has({ sessionId, agentId: 'a', action: 'email' });
  log.push({ do: 'has s1 (oldest evicted)', has: has('s1') }, { do: 'has s4', has: has('s4') });
  clock = 101;
  log.push({ do: 'clock 101: has s2', has: has('s2') });
  clock = 0;
  log.push({ do: 'clock 0: has s3 (pruned, not just hidden)', has: has('s3') });
  return { maxEntries: 3, ttlMs: 100, steps: log };
});

await set.finish({
  entry: { runs: 'human-gate/gate.mjs (humanGateDecision, recordHumanDecision, sessionLifeMark, unattended approval port), requests.mjs, store.mjs, session-grants.mjs (createSessionGrants with now/maxEntries/ttlMs), agent-room roomMemberSessionId, the live session store (setLiveSession), config updateSection', notRun: 'no desktop: answers are recorded through recordHumanDecision as the desktop delivers them' },
  replay: { entry: 'mixdog-tools policy/session_grants.rs (and gate.rs/grants.rs): replay each log step in order on a store and a registry with the recorded clock (start 1_000_000 ms) and compare every step\'s output and the grants/audit views', normalised: { auditRows: 'reduced to {agentId, decision, action}', grants: 'reduced to {agentId, action, mode, scope}', dataDir: 'temp, not in the recording' } },
  replaceInText: [[dataRoot, '<data>']],
});
rmSync(dataRoot, { recursive: true, force: true });
process.exit(0);
