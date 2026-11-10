// The "Allow all actions" developer option (shared/developer-options.mjs):
// while on, every human-approval ask is skipped except a payment or permanent
// delete; a bot's `block`, a hook deny and the schedule/webhook run rules stand.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The config and agent definitions live in a throwaway data dir.
const dataRoot = mkdtempSync(join(tmpdir(), 'allow-all-actions-'));
const previousEnv = Object.fromEntries(
  ['MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_READ_TTL_MS', 'MIXDOG_USER_DATA_BACKUP_ROOT'].map((key) => [key, process.env[key]])
);
process.env.MIXDOG_DATA_DIR = dataRoot;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dataRoot, 'backups');
for (const [id, kind] of [
  ['mailer', 'bot'],
  ['buyer', 'bot'],
  ['helper', 'agent'],
]) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: ${kind}\n---\nYou are ${id}.\n`);
}

const { updateSection } = await import('../../../../shared/config.mjs');
const { BLOCKED_ACTION_REASON, humanGateDecision, setUnattendedApprovalPort, unattendedApprovalPort } = await import(
  './gate.mjs'
);
const { applyBeforeToolHook, applyConnectorApproval } = await import('../loop/tool-exec/before-hook.mjs');
const { createHumanGateStore, setHumanGateStore } = await import('./store.mjs');

const setAllowAll = (on) =>
  updateSection('agent', (current) => ({ ...current, developer: on === undefined ? {} : { allowAllActions: on } }));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});
test.afterEach(() => setAllowAll(undefined));

const MAILER = 'sess_home_mailer';
const BUYER = 'sess_home_buyer';
const CODING = 'sess_desktop_coding'; // no bot: an ordinary coding session

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'allow-all-store-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const decide = (call, decision, sessionId, store) =>
  humanGateDecision(call, decision, { sessionId, store, annotations: {} });
const EMAIL = { name: 'mcp__gmail__send_email', args: { to: 'a@b.c', subject: 's', body: 'hi' } };
const COMMENT = { name: 'github', args: { action: 'pr.comment', repo: 'o/r', number: 7, body: 'LGTM' } };
const POST = { name: 'mcp__slack__post_message', args: { channel: '#general', text: 'hello' } };
const TRASH = { name: 'mcp__gmail__trash_emails', args: { ids: ['m1'] } };
const PAYMENT = { name: 'mcp__stripe__create_payment', args: { amount: 5, currency: 'USD', merchant: 'Notion' } };
const PERMANENT_DELETE = { name: 'mcp__drive__delete_permanently', args: { ids: ['a'] } };
const REMOTE_DELETE = { name: 'mcp__chat__delete_message', args: { id: '1' } };
const SHELL = { name: 'shell', args: { command: 'git push' } };
const EDIT = { name: 'edit', args: { path: 'a.txt', old_string: 'a', new_string: 'b' } };
const WEB_FETCH = { name: 'web_fetch', args: { url: 'https://example.test' } };
const HOOK_ASK = { action: 'ask', reason: 'hook rule' };
const noCard = () => assert.fail('no approval card');

test('off (the default): outbound calls and plain asks still ask, exactly as before', async (t) => {
  const store = tempStore(t);
  for (const call of [EMAIL, COMMENT, POST, TRASH, PAYMENT, PERMANENT_DELETE]) {
    const out = await decide(call, null, MAILER, store);
    assert.equal(out.decision.action, 'ask', call.name);
    assert.equal(out.request.kind, 'outbound', call.name);
  }
  const plain = await decide(SHELL, HOOK_ASK, MAILER, store);
  assert.equal(plain.decision.action, 'ask');
  assert.equal(plain.request.kind, 'approval');
  const coding = await decide(SHELL, HOOK_ASK, CODING, store);
  assert.equal(coding.request.kind, 'approval');
  assert.deepEqual(await store.readAudit(), []);
  // Stored false is the same as absent.
  setAllowAll(false);
  assert.equal((await decide(EMAIL, null, MAILER, store)).decision.action, 'ask');
});

test('on: an outbound email, comment, post or trash passes without a card and is audited', async (t) => {
  const store = tempStore(t);
  setAllowAll(true);
  for (const [call, category] of [
    [EMAIL, 'email'],
    [COMMENT, 'comment'],
    [POST, 'message'],
    [TRASH, 'trash'],
  ]) {
    // No hook decision, an allowing hook and an asking hook: none shows a card.
    for (const hook of [null, { action: 'allow' }, HOOK_ASK]) {
      const out = await decide(call, hook, MAILER, store);
      assert.equal(out.request, null, `${call.name} ${hook?.action}`);
      assert.equal(out.gate, null);
      assert.notEqual(out.decision?.action, 'ask', `${call.name} ${hook?.action}`);
      const [row] = await store.readAudit({ agentId: 'mailer' });
      assert.equal(row.decision, 'dev-allow-all');
      assert.equal(row.kind, 'outbound');
      assert.equal(row.action, category);
    }
  }
  // End to end: the approval hook is never reached, and the call runs as classified.
  const result = await applyBeforeToolHook({
    name: EMAIL.name,
    args: EMAIL.args,
    cwd: '/tmp',
    callerSessionId: MAILER,
    executeOpts: {},
    beforeToolHook: async () => HOOK_ASK,
    toolApprovalHook: noCard,
  });
  assert.equal(result.denial, undefined);
  assert.deepEqual(result.args, EMAIL.args);
  // An asking hook's rewrite is kept while its card is skipped.
  const rewritten = await applyBeforeToolHook({
    name: EMAIL.name,
    args: EMAIL.args,
    cwd: '/tmp',
    callerSessionId: MAILER,
    executeOpts: {},
    beforeToolHook: async () => ({ ...HOOK_ASK, args: { ...EMAIL.args, body: 'rewritten' } }),
    toolApprovalHook: noCard,
  });
  assert.equal(rewritten.args.body, 'rewritten');
});

test('on: a plain ask (hook rule, saving an automation, a non-bot session) passes without a card', async (t) => {
  const store = tempStore(t);
  setAllowAll(true);
  for (const sessionId of [MAILER, CODING]) {
    for (const call of [EDIT, WEB_FETCH, { name: 'setup', args: { action: 'save_automation' } }, EMAIL, TRASH]) {
      const out = await decide(call, HOOK_ASK, sessionId, store);
      assert.equal(out.request, null, `${sessionId} ${call.name}`);
      assert.notEqual(out.decision.action, 'ask', `${sessionId} ${call.name}`);
    }
  }
  const [row] = await store.readAudit();
  assert.equal(row.decision, 'dev-allow-all');
  const result = await applyBeforeToolHook({
    name: 'edit',
    args: EDIT.args,
    cwd: '/tmp',
    callerSessionId: CODING,
    executeOpts: {},
    beforeToolHook: async () => HOOK_ASK,
    toolApprovalHook: noCard,
  });
  assert.deepEqual(result.args, EDIT.args);
  assert.equal(result.denial, undefined);
});

test('on: a hook ask on shell, terminal, git and apply_patch passes too (truly all actions)', async (t) => {
  const store = tempStore(t);
  setAllowAll(true);
  const deleters = [
    SHELL,
    { name: 'shell', args: { command: 'Remove-Item -Recurse .\\build' } },
    { name: 'shell', args: { command: 'rm notes.txt' } },
    { name: 'terminal', args: { action: 'run', command: 'del notes.txt' } },
    { name: 'git', args: { action: 'clean' } },
    { name: 'apply_patch', args: { patch: '*** Delete File: a.txt' } },
  ];
  for (const call of deleters) {
    for (const sessionId of [CODING, MAILER]) {
      const out = await decide(call, HOOK_ASK, sessionId, store);
      const label = `${sessionId} ${call.name} ${call.args.command ?? ''}`;
      assert.equal(out.request, null, label);
      assert.notEqual(out.decision.action, 'ask', label);
    }
  }
  assert.equal((await store.readAudit()).length, deleters.length * 2);
  // End to end: the approval hook is never reached.
  const result = await applyBeforeToolHook({
    name: 'shell',
    args: SHELL.args,
    cwd: '/tmp',
    callerSessionId: CODING,
    executeOpts: {},
    beforeToolHook: async () => HOOK_ASK,
    toolApprovalHook: noCard,
  });
  assert.equal(result.denial, undefined);
  assert.deepEqual(result.args, SHELL.args);
  // Off: the same asks still ask.
  setAllowAll(false);
  for (const call of deleters) assert.equal((await decide(call, HOOK_ASK, CODING, store)).decision.action, 'ask');
});

test('an unreadable option asks instead of denying (fail-closed read)', async (t) => {
  const store = tempStore(t);
  setAllowAll(true);
  // The config path turns into something that cannot be read as a file.
  const configPath = join(dataRoot, 'mixdog-config.json');
  const saved = readFileSync(configPath);
  rmSync(configPath);
  mkdirSync(configPath);
  const asked = [];
  let result;
  let plain;
  try {
    result = await applyBeforeToolHook({
      name: EMAIL.name,
      args: EMAIL.args,
      cwd: '/tmp',
      callerSessionId: MAILER,
      executeOpts: {},
      toolApprovalHook: async (request) => {
        asked.push(request);
        return { approved: true, response: 'approve' };
      },
    });
    plain = await decide(EDIT, HOOK_ASK, CODING, store);
  } finally {
    rmSync(configPath, { recursive: true, force: true });
    writeFileSync(configPath, saved);
  }
  assert.equal(asked.length, 1, 'the card is raised');
  assert.equal(result.denial, undefined, 'the call is not denied by the failed read');
  assert.equal(plain.decision.action, 'ask');
  assert.ok(
    (await store.readAudit()).every((row) => row.decision !== 'dev-allow-all'),
    'nothing was let through'
  );
});

test('a corrupt or missing config never brings back a backed-up true', async (t) => {
  const store = tempStore(t);
  setAllowAll(true); // saved, and snapshotted into the user-data backup
  const configPath = join(dataRoot, 'mixdog-config.json');
  assert.equal((await decide(EMAIL, null, MAILER, store)).request, null, 'on while the config is intact');
  const letThrough = async () => (await store.readAudit()).length;
  const intactCount = await letThrough();
  const entries = () => readdirSync(dataRoot).sort();
  const intact = readFileSync(configPath);
  for (const damage of [
    () => writeFileSync(configPath, '{"agent": {"developer": {"allowAllActions": tr'),
    () => writeFileSync(configPath, '\0'.repeat(64)),
    () => rmSync(configPath),
  ]) {
    damage();
    const before = entries();
    const out = await decide(EMAIL, null, MAILER, store);
    assert.equal(out.decision.action, 'ask', 'asks');
    assert.equal(out.request.kind, 'outbound');
    assert.equal((await decide(EDIT, HOOK_ASK, CODING, store)).decision.action, 'ask');
    assert.deepEqual(entries(), before, 'the check renamed, restored or wrote nothing');
    // A non-strict read would have restored the backup's true; this one does not.
    writeFileSync(configPath, intact);
  }
  assert.equal(await letThrough(), intactCount, 'nothing was let through while damaged');
});

test('on: a payment and a permanent delete still ask, and are still refused when not approved', async (t) => {
  const store = tempStore(t);
  setAllowAll(true);
  for (const call of [PAYMENT, PERMANENT_DELETE, REMOTE_DELETE]) {
    for (const hook of [null, { action: 'allow' }, HOOK_ASK]) {
      const out = await decide(call, hook, BUYER, store);
      assert.equal(out.decision.action, 'ask', `${call.name} ${hook?.action}`);
      assert.equal(out.request.kind, 'outbound');
      assert.deepEqual(out.request.remember, ['once'], 'never remembered');
    }
  }
  assert.equal((await decide(PAYMENT, null, BUYER, store)).request.outbound.category, 'payment');
  assert.equal((await decide(PERMANENT_DELETE, null, BUYER, store)).request.outbound.category, 'delete');
  // Outside a bot session they stay a plain ask too.
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const out = await decide(call, HOOK_ASK, CODING, store);
    assert.equal(out.decision.action, 'ask', call.name);
    assert.equal(out.request.kind, 'approval', call.name);
  }
  assert.deepEqual(await store.readAudit(), [], 'nothing was let through');
  // End to end: the card is raised, and a "no" stops the call.
  for (const call of [PAYMENT, PERMANENT_DELETE]) {
    const asked = [];
    const result = await applyBeforeToolHook({
      name: call.name,
      args: call.args,
      cwd: '/tmp',
      callerSessionId: BUYER,
      executeOpts: {},
      toolApprovalHook: async (request) => {
        asked.push(request);
        return { approved: false, response: 'deny' };
      },
    });
    assert.equal(asked.length, 1, call.name);
    assert.match(result.denial, /was not approved/);
  }
});

test('on: a bot block still blocks, a hook deny or block still denies', async (t) => {
  const store = tempStore(t);
  await store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  setAllowAll(true);
  const blocked = await decide(EMAIL, HOOK_ASK, MAILER, store);
  assert.equal(blocked.decision.action, 'deny');
  assert.equal(blocked.decision.reason, BLOCKED_ACTION_REASON);
  assert.equal((await store.readAudit({ agentId: 'mailer' }))[0].decision, 'blocked');
  const result = await applyBeforeToolHook({
    name: EMAIL.name,
    args: EMAIL.args,
    cwd: '/tmp',
    callerSessionId: MAILER,
    executeOpts: {},
    toolApprovalHook: noCard,
  });
  assert.match(result.denial, /denied by hook: This agent's permission blocks this action/);
  // Another kind the bot did not block passes.
  assert.equal((await decide(COMMENT, null, MAILER, store)).request, null);
  for (const action of ['deny', 'block']) {
    const out = await decide(SHELL, { action, reason: 'no' }, MAILER, store);
    assert.equal(out.decision.action, action);
    const hooked = await applyBeforeToolHook({
      name: 'shell',
      args: SHELL.args,
      cwd: '/tmp',
      callerSessionId: CODING,
      executeOpts: {},
      beforeToolHook: async () => ({ action, reason: 'no' }),
      toolApprovalHook: noCard,
    });
    assert.match(hooked.denial, /denied by hook: no/);
  }
});

test('the bot permission mode and the connector needs_approval mode are bypassed only while on', async (t) => {
  const store = tempStore(t);
  // `ask` is the bot's mode for every kind without a grant: off asks, on skips.
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'email' }), 'ask');
  assert.equal((await decide(EMAIL, null, MAILER, store)).decision.action, 'ask');
  setAllowAll(true);
  assert.equal((await decide(EMAIL, null, MAILER, store)).request, null);
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'email' }), 'ask', 'the stored mode is untouched');
  // A connector tool the bot set to ask first.
  writeFileSync(
    join(dataRoot, 'agents', 'mailer', 'agent.json'),
    JSON.stringify({ name: 'mailer', connectors: { off: [], tools: { alpha: { write_it: 'needs_approval' } } } })
  );
  const connect = async () => {
    const asked = [];
    const outcome = await applyConnectorApproval(
      { name: 'mcp__alpha__write_it', args: {}, cwd: '/tmp' },
      {
        agentId: 'mailer',
        callerSessionId: MAILER,
        executeOpts: {},
        toolApprovalHook: async (request) => {
          asked.push(request);
          return { approved: true, response: 'approve' };
        },
      }
    );
    return { outcome, asked };
  };
  assert.deepEqual(await connect(), { outcome: null, asked: [] });
  setAllowAll(false);
  assert.equal((await connect()).asked.length, 1, 'off: the connector tool asks');
});

test('schedule/webhook run rules stand: a payment or permanent delete in a run is refused, never asked', async (t) => {
  const store = tempStore(t);
  const port = unattendedApprovalPort();
  setUnattendedApprovalPort({
    runOf: (sessionId) =>
      sessionId === 'sess_schedule_run' ? { kind: 'schedule', agentId: 'buyer', name: 'Daily' } : null,
    hold: noCard,
  });
  t.after(() => setUnattendedApprovalPort(port));
  setAllowAll(true);
  for (const call of [PAYMENT, PERMANENT_DELETE, REMOTE_DELETE]) {
    const result = await applyBeforeToolHook({
      name: call.name,
      args: call.args,
      cwd: '/tmp',
      callerSessionId: 'sess_schedule_run',
      executeOpts: {},
      toolApprovalHook: noCard,
    });
    assert.match(result.denial, /Payments and permanent deletes aren't allowed in schedule\/webhook runs/, call.name);
  }
  // An ordinary action in the run still goes through.
  const ok = await applyBeforeToolHook({
    name: EMAIL.name,
    args: EMAIL.args,
    cwd: '/tmp',
    callerSessionId: 'sess_schedule_run',
    executeOpts: {},
    toolApprovalHook: noCard,
  });
  assert.equal(ok.denial, undefined);
  assert.ok((await store.readAudit({ agentId: 'buyer' })).some((row) => row.decision === 'run-forbidden'));
});
