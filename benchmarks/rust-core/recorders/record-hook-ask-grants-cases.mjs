#!/usr/bin/env node
// Recording of session/human-gate/hook-ask-grants.test.mjs (b6f10295a): a hook's own `ask` offers once / this session / always for
// every agent, keyed by the action kind (classified send or post) or the tool, never by arguments. Real human-gate modules
// (gate.mjs humanGateDecision / recordHumanDecision / unattended approval port, requests.mjs, store.mjs human-gate store and
// agent permissions, session-grants.mjs on a movable clock, outbound-policy.mjs) over a temp data dir with the test's agent roster.
// Per case: each call decided (decision, request, gate, remembered), each answer recorded, and the store's grants and audit after.
//
//   node benchmarks/rust-core/recorders/record-hook-ask-grants-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const dataRoot = mkdtempSync(join(tmpdir(), 'hook-ask-grants-data-'));
process.env.MIXDOG_DATA_DIR = dataRoot;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dataRoot, 'backups');
for (const id of ['mailer', 'scribe']) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: bot\n---\nYou are ${id}.\n`);
}
const set = openSet('hook-ask-grants-cases', import.meta.url);
const G = 'src/runtime/agent/orchestrator/session/human-gate/';
const { updateSection } = await set.load('src/runtime/shared/config.mjs');
const { humanGateDecision, recordHumanDecision, setUnattendedApprovalPort, unattendedApprovalPort } = await set.load(`${G}gate.mjs`);
const { humanRequestFields, normalizeHumanResponse } = await set.load(`${G}requests.mjs`);
const { agentPermissions, createHumanGateStore, setAgentPermission, setHumanGateStore } = await set.load(`${G}store.mjs`);
const { SESSION_GRANT_TTL_MS, createSessionGrants } = await set.load(`${G}session-grants.mjs`);
const { isRememberableAction, isToolAction, toolActionOf } = await set.load(`${G}outbound-policy.mjs`);

const LEAD = 'sess_lead_coding'; const OTHER_LEAD = 'sess_lead_other'; const MIXY = 'sess_home_lead'; const MAILER = 'sess_home_mailer';
const HOOK = { action: 'ask', reason: 'hook rule' };
const SHELL = (command) => ({ name: 'shell', args: { command } });
const EDIT = { name: 'edit', args: { path: 'a.txt', old: 'x', new: 'y' } };
const MCP = (tool) => ({ name: `mcp__acme__${tool}`, args: { id: 1 } });
const EMAIL = { name: 'mcp__gmail__send_email', args: { to: 'a@b.c', subject: 's', body: 'hi' } };
const COMMENT = { name: 'github', args: { action: 'pr.comment', repo: 'o/r', number: 1, body: 'LGTM' } };
const MERGE = { name: 'github', args: { action: 'pr.merge', repo: 'o/r', number: 1 } };
const PAYMENT = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'USD', merchant: 'Notion' } };
const PERMANENT_DELETE = { name: 'mcp__drive__delete_permanently', args: { ids: ['a'] } };
const rejected = async (promise) => { try { await promise; return { resolved: true }; } catch (e) { return { rejected: e }; } };

const cleanups = [];
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'hook-ask-grants-store-'));
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
  const h = {
    store, log,
    advance: (ms) => { clock += ms; log.push({ do: 'advance', ms }); },
    reset: (sessionId) => { lives.set(sessionId, `reset-${clock}`); log.push({ do: 'reset session life', sessionId }); },
    decide: async (call, sessionId, hook = HOOK) => {
      const out = await humanGateDecision(call, hook, ctx(sessionId));
      log.push({ do: 'decide', call, sessionId, hook, result: structuredClone(out) });
      return out;
    },
    answer: async (gate, approval) => { const r = await recordHumanDecision(gate, approval, { store, sessionGrants, sessionLife: life }); log.push({ do: 'answer', gate, approval }); return r; },
    choose: async (card, remember) => {
      const answered = normalizeHumanResponse(card.request, true, { response: 'approve', remember });
      await recordHumanDecision(card.gate, answered, { store, sessionGrants, sessionLife: life });
      log.push({ do: 'choose', remember, answered });
      return answered;
    },
    grants: async (label, filter) => { const rows = await store.listGrants(filter); log.push({ do: 'grants', label, filter, grants: structuredClone(rows) }); return rows; },
    audit: async (label, filter) => { const rows = await store.readAudit(filter); log.push({ do: 'audit', label, filter, rows: structuredClone(rows) }); return rows; },
  };
  return h;
}
async function run(name, fn) {
  await set.run(name, async () => { const h = harness(); try { const extra = await fn(h); return { log: h.log, ...(extra ?? {}) }; } finally { while (cleanups.length) await cleanups.pop()(); } });
}

await run('a coding Lead hook ask offers once / this session / always, keyed by the tool', async (h) => {
  const card = await h.decide(SHELL('git push'), LEAD);
  const presented = { kind: 'approval', ...humanRequestFields(card.request) };
  return {
    presented,
    normalized: ['once', 'session', 'always', 'agent'].map((remember) => ({ remember, response: normalizeHumanResponse(presented, true, { remember }) })),
    requestNamingNoKey: humanRequestFields({ kind: 'approval', remember: ['once', 'session', 'always'] }),
  };
});
await run('"always" saves one every-agent grant: no card for that tool in this or any other conversation', async (h) => {
  const card = await h.decide(SHELL('git push'), LEAD);
  await h.choose(card, 'always');
  await h.grants('after always');
  for (const [sessionId, call] of [[LEAD, SHELL('rm -rf build')], [OTHER_LEAD, SHELL('ls')], [MIXY, SHELL('ls')], [MAILER, SHELL('ls')]]) await h.decide(call, sessionId);
  await h.audit('lead', { agentId: 'lead' });
  await h.audit('all', { limit: 100 });
});
await run('the answered call keeps a hook rewrite and is not marked as an outbound approval', async (h) => {
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  await h.decide(SHELL('a'), LEAD, { action: 'ask', reason: 'r', args: { command: 'safe' } });
});
await run('"this session" covers the tool for that conversation only, ends on reset and after 12 h, never saved', async (h) => {
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  await h.grants('after session');
  await h.decide(SHELL('b'), LEAD); await h.decide(SHELL('b'), OTHER_LEAD); await h.decide(SHELL('b'), MIXY); await h.decide(EDIT, LEAD);
  await h.audit('lead', { agentId: 'lead' });
  h.reset(LEAD);
  await h.decide(SHELL('b'), LEAD);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  h.advance(SESSION_GRANT_TTL_MS - 1);
  await h.decide(SHELL('b'), LEAD);
  h.advance(2);
  await h.decide(SHELL('b'), LEAD);
  return { sessionGrantTtlMs: SESSION_GRANT_TTL_MS };
});
await run('the key is the tool (or the classified kind), never the arguments: nothing widens to an unrelated call', async (h) => {
  await h.choose(await h.decide(MCP('write_it'), LEAD), 'always');
  await h.decide({ name: 'mcp__acme__write_it', args: { anything: 'else' } }, LEAD);
  for (const other of [MCP('write_other'), { name: 'mcp__acme2__write_it', args: {} }, SHELL('x'), EDIT]) await h.decide(other, LEAD);
  const comment = await h.decide(COMMENT, LEAD);
  await h.choose(comment, 'always');
  await h.decide(COMMENT, LEAD); await h.decide(MERGE, LEAD); await h.decide(MERGE, LEAD);
  return {
    toolActionOf: ['shell', '', 'has space', 'a'.repeat(200), 'setup', 'ask_user', 'handoff_user', 'x/y'].map((name) => ({ name: name.length > 20 ? `a x ${name.length}` : name, key: toolActionOf(name) })),
    isToolAction: isToolAction('tool:shell'), isRememberableShell: isRememberableAction('tool:shell'), isRememberableSetup: isRememberableAction('tool:setup'),
  };
});
await run('tools that change what agents may do, and the user prompts, are asked once', async (h) => {
  for (const name of ['setup', 'ask_user', 'handoff_user']) {
    const card = await h.decide({ name, args: { action: 'set_agent_permission' } }, LEAD);
    await h.answer(card.gate, { approved: true, remember: 'always' });
  }
  await h.grants('after');
});
await run('payments and permanent deletes are never offered, stored or honoured, and are not skipped by Allow all actions', async (h) => {
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const card = await h.decide(call, LEAD);
    for (const remember of ['session', 'always']) await h.answer({ ...card.gate, remember: ['once', 'session', 'always'], sessionId: LEAD, action: `tool:${call.name}` }, { approved: true, remember });
    await h.decide(call, LEAD);
  }
  await h.store.grant({ agentId: 'lead', action: toolActionOf(PAYMENT.name), scope: 'always' });
  h.log.push({ do: 'store.grant', agentId: 'lead', action: toolActionOf(PAYMENT.name), scope: 'always' });
  await h.decide(PAYMENT, LEAD);
  await updateSection('agent', (current) => ({ ...current, developer: { allowAllActions: true } }));
  h.log.push({ do: 'config agent.developer.allowAllActions = true' });
  await h.decide(PAYMENT, LEAD); await h.decide(PERMANENT_DELETE, LEAD); await h.decide(SHELL('ls'), LEAD);
});
await run('a grant for one kind or tool never answers a payment, a delete or another kind', async (h) => {
  await h.choose(await h.decide(COMMENT, LEAD), 'always');
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  for (const call of [PAYMENT, PERMANENT_DELETE, EMAIL, EDIT]) await h.decide(call, LEAD);
});
await run('an unattended run never gets or uses a session grant; it may use a saved always grant', async (h) => {
  await h.choose(await h.decide(SHELL('a'), LEAD), 'session');
  const RUN = { kind: 'schedule', agentId: 'mailer', name: 'daily' };
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === LEAD ? RUN : null) });
  h.log.push({ do: 'unattended port: the Lead session is a run', run: RUN });
  const inRun = await h.decide(SHELL('b'), LEAD);
  await h.answer({ ...inRun.gate, remember: ['once', 'session', 'always'] }, { approved: true, remember: 'session' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: () => null });
  h.log.push({ do: 'unattended port: no run' });
  h.reset(LEAD);
  await h.decide(SHELL('c'), LEAD);
  await h.store.grant({ agentId: 'lead', action: 'tool:shell', scope: 'always' });
  h.log.push({ do: 'store.grant', agentId: 'lead', action: 'tool:shell', scope: 'always' });
  setUnattendedApprovalPort({ ...(unattendedApprovalPort() || {}), runOf: (id) => (id === LEAD ? RUN : null) });
  h.log.push({ do: 'unattended port: the Lead session is a run', run: RUN });
  await h.decide(SHELL('d'), LEAD);
});
await run('a timeout or a denial stores no decision', async (h) => {
  const card = await h.decide(SHELL('a'), LEAD);
  const denied = normalizeHumanResponse(card.request, false, { remember: 'always' });
  await h.answer(card.gate, { approved: false, response: 'deny', timedOut: true, remember: 'always' });
  await h.answer(card.gate, { approved: true, timedOut: true, remember: 'session' });
  await h.answer(card.gate, { approved: false, response: 'deny', remember: 'always' });
  await h.grants('after');
  await h.decide(SHELL('a'), LEAD);
  await h.audit('lead', { agentId: 'lead' });
  return { denied };
});
await run('a bot hook ask on a classified send offers once / session / always and is answered by those only', async (h) => {
  const card = await h.decide(EMAIL, MAILER);
  await h.choose(card, 'always');
  await h.grants('after always');
  for (const sessionId of ['sess_home_scribe', MIXY]) await h.decide(EMAIL, sessionId);
  await h.decide(EMAIL, LEAD);
  const h2 = harness();
  await h2.store.grant({ agentId: 'mailer', action: 'email', scope: 'agent' });
  h2.log.push({ do: 'store.grant', agentId: 'mailer', action: 'email', scope: 'agent' });
  await h2.decide(EMAIL, MAILER); await h2.decide(EMAIL, MAILER, { action: 'allow' });
  const h3 = harness();
  await h3.choose(await h3.decide(EMAIL, MAILER), 'session');
  await h3.decide(EMAIL, MAILER); await h3.decide(EMAIL, 'sess_home_scribe');
  await h.store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  h.log.push({ do: 'store.setMode', agentId: 'mailer', action: 'email', mode: 'block' });
  await h.decide(EMAIL, MAILER);
  return { harness2: { note: 'a bot own agent-scope allow', log: h2.log }, harness3: { note: 'a session allowance', log: h3.log } };
});
await run("a shared allow is listed in every agent's permissions and revoking it there turns it back to asking", async (h) => {
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  await h.choose(await h.decide(COMMENT, LEAD), 'always');
  const perms = async (label, agent) => h.log.push({ do: 'agentPermissions', label, agent, rows: structuredClone(await agentPermissions(agent)) });
  for (const agent of ['lead', 'mailer', 'scribe']) await perms('shared allows', agent);
  await h.store.grant({ agentId: 'mailer', action: 'comment', scope: 'agent' });
  h.log.push({ do: 'store.grant', agentId: 'mailer', action: 'comment', scope: 'agent' });
  h.log.push({ do: 'mailer comment row', row: structuredClone((await agentPermissions('mailer')).find((row) => row.action === 'comment')) });
  await setAgentPermission('mailer', 'comment', 'ask');
  h.log.push({ do: 'setAgentPermission mailer comment ask', row: (await agentPermissions('mailer')).find((row) => row.action === 'comment') });
  await h.decide(COMMENT, LEAD);
  await setAgentPermission('scribe', 'comment', 'ask'); await setAgentPermission('mailer', 'tool:shell', 'ask');
  h.log.push({ do: 'setAgentPermission scribe comment ask; mailer tool:shell ask' });
  await h.grants('after both revoked');
  await h.decide(SHELL('a'), LEAD); await h.decide(COMMENT, LEAD);
  await h.choose(await h.decide(SHELL('a'), LEAD), 'always');
  await setAgentPermission('lead', 'tool:shell', 'ask', { noWiden: true });
  h.log.push({ do: 'setAgentPermission lead tool:shell ask noWiden' });
  await h.grants('after the remote revoke');
  return { rejections: [['mailer', 'tool:shell', 'allow'], ['mailer', 'tool:shell', 'block'], ['mailer', 'tool:setup', 'ask']].map(([a, k, m]) => ({ agent: a, action: k, mode: m })), results: [await rejected(setAgentPermission('mailer', 'tool:shell', 'allow')), await rejected(setAgentPermission('mailer', 'tool:shell', 'block')), await rejected(setAgentPermission('mailer', 'tool:setup', 'ask'))] };
});
await run('a damaged or hand-edited grants file never yields a tool grant for another agent or a block', async (h) => {
  await h.store.setMode({ agentId: 'mailer', action: 'tool:shell', mode: 'allow' });
  await h.store.setMode({ agentId: '*', action: 'tool:shell', mode: 'block' });
  await h.store.setMode({ agentId: '*', action: 'tool:setup', mode: 'allow' });
  await h.grants('after the three setMode calls');
  return { setModes: [['mailer', 'tool:shell', 'allow'], ['*', 'tool:shell', 'block'], ['*', 'tool:setup', 'allow']], modeFor: await h.store.modeFor({ agentId: 'lead', action: 'tool:shell' }) };
});
await run('the card is told what the choice covers: the action kind of a classified call, else the tool', async (h) => {
  const kind = await h.decide(COMMENT, LEAD);
  const presented = { kind: 'approval', ...humanRequestFields(kind.request) };
  const grantActions = { comment: presented, shell: humanRequestFields((await h.decide(SHELL('a'), LEAD)).request), merge: humanRequestFields((await h.decide(MERGE, LEAD)).request) };
  for (const call of [PAYMENT, { name: 'setup', args: {} }]) grantActions[call.name] = humanRequestFields((await h.decide(call, LEAD)).request);
  return { grantActions };
});

await set.finish({
  entry: { runs: 'human-gate/gate.mjs (humanGateDecision, recordHumanDecision, unattended approval port), requests.mjs (humanRequestFields, normalizeHumanResponse), store.mjs (createHumanGateStore, agentPermissions, setAgentPermission), session-grants.mjs (createSessionGrants on a movable clock), outbound-policy.mjs, config updateSection', notRun: 'no desktop: the card answer is built with normalizeHumanResponse and recorded through recordHumanDecision as the desktop delivers it' },
  replay: { entry: 'mixdog-tools policy (gate.rs, grants.rs, card.rs): replay each log step in order (decide / choose / answer / advance / reset / grant / setMode / setAgentPermission / config) on a store and a session-grant registry with the recorded clock (start 1_000_000 ms) and compare every step\'s output and the grants/audit views', normalised: { dataDir: '<data> wherever it occurs (paths listed in normalised.paths)' }, exclusions: {} },
  replaceInText: [[dataRoot, '<data>']],
});
rmSync(dataRoot, { recursive: true, force: true });
process.exit(0);
