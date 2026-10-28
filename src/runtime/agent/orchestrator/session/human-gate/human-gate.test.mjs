import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createToolApproval } from '../../../../../tui/session/tool-approval.mjs';
import { _registerMcpServerForTest, disconnectAll } from '../../mcp/client.mjs';
import { rememberServerConnector } from '../../mcp/server-connectors.mjs';
import { applyBeforeToolHook } from '../loop/tool-exec/before-hook.mjs';
import { humanGateDecision, recordHumanDecision, setUnattendedApprovalPort } from './gate.mjs';
import { classifyOutboundCall } from './outbound-policy.mjs';
import { humanRequestFields, normalizeHumanResponse } from './requests.mjs';
import { createHumanGateStore, setHumanGateStore } from './store.mjs';

// The outbound gate applies only while a bot acts: these agents are `kind: bot`
// definitions in a throwaway data dir; `helper` is a workflow agent (`kind: agent`).
const dataRoot = mkdtempSync(join(tmpdir(), 'human-gate-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
for (const [id, kind] of [
  ['mailer', 'bot'],
  ['inspector', 'bot'],
  ['scribe', 'bot'],
  ['buyer', 'bot'],
  ['helper', 'agent'],
]) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: ${kind}\n---\nYou are ${id}.\n`);
}
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});
const BOT = { sessionId: 'sess_home_mailer' };

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'human-gate-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

/** The approval FIFO as the session runs it; `answer(request)` plays the card. */
function queue(answer) {
  let state = { toolApproval: null };
  let seq = 0;
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      if (patch.toolApproval) queueMicrotask(() => answer(patch.toolApproval, api));
    },
    nextId: () => `req-${++seq}`,
    getDisposed: () => false,
    timeoutMs: 60_000,
  });
  return { api, presented: () => state.toolApproval };
}

test('every request kind round-trips through the approval queue with its own response set', async () => {
  const cases = [
    [{ kind: 'approval' }, { approved: true }, { response: 'approve' }],
    [
      { kind: 'outbound', outbound: { target: 'o/r#1', account: 'github.com', payload: 'hi', editable: ['body'] } },
      { approved: true, response: 'edit-and-approve', editedArgs: { body: 'edited', other: 'x' } },
      { response: 'edit-and-approve', editedArgs: { body: 'edited' } },
    ],
    [
      {
        kind: 'secret',
        secret: { requestId: 'secret_abcdefgh', surface: 'browser', target: 'github.com', field: 'Password' },
      },
      { approved: true, response: 'provide-secret' },
      { response: 'provide-secret' },
    ],
    [
      { kind: 'secret', secret: { requestId: 'secret_abcdefgh' } },
      { approved: false, response: 'skip' },
      { response: 'skip' },
    ],
    [
      { kind: 'takeover', takeover: { surface: 'computer', instructions: 'Sign in' } },
      { approved: true, response: 'done' },
      { response: 'done' },
    ],
    [
      { kind: 'permission', permission: { scopes: [{ id: 'read', label: 'Read' }, { id: 'write' }] } },
      { approved: true, scope: 'write' },
      { response: 'approve', scope: 'write' },
    ],
  ];
  for (const [request, decision, expected] of cases) {
    const { api } = queue((presented, inner) => {
      const { approved, ...extra } = decision;
      inner.finishToolApproval(presented.id, approved, '', 'Pixel', undefined, undefined, extra);
    });
    const result = await api.requestToolApproval({ name: 'tool', args: {}, ...request });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${request.kind}.${key}`);
    assert.equal(result.device, 'Pixel');
  }
});

test('a presented request names the connector account its call is bound to, whatever its kind', () => {
  assert.deepEqual(humanRequestFields({ account: ' work@example.com ' }), { account: 'work@example.com' });
  assert.deepEqual(humanRequestFields({ kind: 'approval', account: 'work@example.com', remember: ['once', 'agent'] }), {
    account: 'work@example.com',
    remember: ['once', 'agent'],
  });
  assert.deepEqual(humanRequestFields({}), {});
});

test('a request never carries a secret value and a contradicting response falls back', () => {
  const fields = humanRequestFields({
    kind: 'secret',
    args: { value: 'SENTINEL' },
    secret: { requestId: 'secret_abcdefgh', value: 'SENTINEL', target: 't', field: 'f' },
  });
  assert.doesNotMatch(JSON.stringify(fields), /SENTINEL/);
  const response = normalizeHumanResponse({ kind: 'secret', ...fields }, true, {
    response: 'provide-secret',
    value: 'SENTINEL',
  });
  assert.deepEqual(response, { approved: true, response: 'provide-secret', remember: 'once' });
  assert.equal(normalizeHumanResponse({ kind: 'outbound' }, false, { response: 'approve' }).response, 'deny');
  const always = normalizeHumanResponse({ kind: 'outbound', remember: ['once', 'agent'] }, true, {
    remember: 'always',
  });
  assert.equal(always.remember, 'once', 'a policy that forbids always stores nothing for it');
});

test('outbound classification: GitHub writes, sends, mail, payments and permanent deletes', () => {
  assert.equal(classifyOutboundCall({ name: 'github', args: { action: 'issue.view', number: 1 } }), null);
  const comment = classifyOutboundCall({
    name: 'github',
    args: { action: 'pr.comment', repo: 'o/r', number: 7, body: 'LGTM' },
  });
  assert.deepEqual(comment, {
    category: 'comment',
    tool: 'github:pr.comment',
    target: 'o/r#7',
    account: 'github.com',
    payload: 'LGTM',
    editable: ['body'],
    details: {},
  });
  const mail = classifyOutboundCall({
    name: 'mcp__gmail__send_email',
    args: { to: 'a@b.c', cc: ['d@e.f'], subject: 's', body: 'b' },
  });
  assert.equal(mail.category, 'email');
  assert.equal(mail.target, 'a@b.c');
  assert.deepEqual(mail.editable, ['body', 'subject']);
  assert.deepEqual(mail.details, { to: 'a@b.c', cc: 'd@e.f', subject: 's' });
  // Email-sending MCP tools by name and server, whatever the tool is called.
  for (const name of ['mcp__gmail__send_message', 'mcp__outlook__reply_to_message', 'mcp__mailer__forward_email']) {
    assert.equal(classifyOutboundCall({ name, args: { to: 'x@y.z', body: 'hi' } }).category, 'email', name);
  }
  assert.equal(classifyOutboundCall({ name: 'mcp__gmail__list_messages', args: {} }), null);
  // A known send name stays outbound even when the tool claims read-only.
  assert.equal(
    classifyOutboundCall({ name: 'mcp__slack__send_message', args: {}, annotations: { readOnlyHint: true } }).category,
    'message'
  );
  assert.equal(classifyOutboundCall({ name: 'mcp__x__custom', args: {}, annotations: { readOnlyHint: true } }), null);
  assert.equal(
    classifyOutboundCall({ name: 'mcp__x__custom', args: {}, annotations: { outboundHint: true } }).category,
    'message'
  );
  // Payment and purchase tools by name; reading them is not paying.
  const pay = classifyOutboundCall({
    name: 'mcp__stripe__create_payment',
    args: { amount: 12900, currency: 'krw', merchant: 'Notion Labs', interval: 'monthly' },
  });
  assert.equal(pay.category, 'payment');
  assert.equal(pay.target, 'Notion Labs');
  assert.deepEqual(pay.details, { merchant: 'Notion Labs', amount: '12900', currency: 'KRW', recurrence: 'monthly' });
  assert.deepEqual(pay.editable, []);
  for (const name of [
    'mcp__shop__purchase_item',
    'mcp__shop__buy_now',
    'mcp__bank__send_money',
    'mcp__shop__checkout',
  ]) {
    assert.equal(classifyOutboundCall({ name, args: {} }).category, 'payment', name);
  }
  assert.equal(classifyOutboundCall({ name: 'mcp__stripe__list_payments', args: {} }), null);
  // Permanent deletes, with their count.
  const purge = classifyOutboundCall({ name: 'mcp__drive__delete_permanently', args: { file_ids: ['a', 'b', 'c'] } });
  assert.equal(purge.category, 'delete');
  assert.deepEqual(purge.details, { count: '3' });
  assert.equal(classifyOutboundCall({ name: 'mcp__drive__delete_file', args: { permanent: true } }).category, 'delete');
  assert.equal(classifyOutboundCall({ name: 'mcp__drive__delete_file', args: {} }), null);
  assert.equal(classifyOutboundCall({ name: 'shell', args: { command: 'curl -X POST' } }), null);
});

test('an outbound call asks even when hooks allow, and edit-and-approve replaces the args', async (t) => {
  tempStore(t);
  let asked;
  const result = await applyBeforeToolHook({
    name: 'github',
    args: { action: 'issue.comment', repo: 'o/r', number: 3, body: 'draft' },
    cwd: '/tmp',
    callerSessionId: 'sess_home_mailer',
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'allow' }),
    toolApprovalHook: async (request) => {
      asked = request;
      return { approved: true, response: 'edit-and-approve', editedArgs: { body: 'final text', repo: 'evil/x' } };
    },
  });
  assert.equal(asked.kind, 'outbound');
  assert.equal(asked.outbound.payload, 'draft');
  assert.deepEqual(asked.outbound.editable, ['body']);
  assert.deepEqual(result.args, { action: 'issue.comment', repo: 'o/r', number: 3, body: 'final text' });
});

test('an allowing hook that also returns a name or args cannot change what the outbound card shows or what runs', async (t) => {
  tempStore(t);
  let asked;
  const result = await applyBeforeToolHook({
    name: 'github',
    args: { action: 'issue.comment', repo: 'o/r', number: 3, body: 'draft' },
    cwd: '/tmp',
    callerSessionId: 'sess_home_mailer',
    executeOpts: {},
    beforeToolHook: async () => ({
      action: 'allow',
      name: 'shell',
      args: { action: 'issue.comment', repo: 'evil/x', number: 9, body: 'other' },
    }),
    toolApprovalHook: async (request) => {
      asked = request;
      return { approved: true, response: 'approve' };
    },
  });
  assert.equal(asked.kind, 'outbound');
  assert.equal(asked.outbound.payload, 'draft');
  assert.equal(result.name, 'github');
  assert.deepEqual(result.args, { action: 'issue.comment', repo: 'o/r', number: 3, body: 'draft' });
});

test('"don\'t ask again" stores an agent + action-kind grant that later auto-allows, revocably', async (t) => {
  const { store } = tempStore(t);
  let asks = 0;
  const call = (repo, number, remember = 'once', sessionId = 'sess_home_inspector') =>
    applyBeforeToolHook({
      name: 'github',
      args: { action: 'pr.comment', repo, number, body: 'ok' },
      cwd: '/tmp',
      callerSessionId: sessionId,
      executeOpts: {},
      toolApprovalHook: async (request) => {
        asks += 1;
        assert.deepEqual(request.remember, ['once', 'agent']);
        assert.equal(request.agentId, sessionId.slice('sess_home_'.length));
        return { approved: true, response: 'approve', remember };
      },
    });
  await call('o/r', 1, 'agent');
  assert.equal(asks, 1);
  const [grant] = await store.listGrants({ agentId: 'inspector' });
  assert.deepEqual(
    { agentId: grant.agentId, action: grant.action, mode: grant.mode },
    { agentId: 'inspector', action: 'comment', mode: 'allow' }
  );
  await call('o/r', 1);
  await call('other/repo', 9);
  assert.equal(asks, 1, 'the grant covers the whole action kind, any repo or target');
  await call('o/r', 1, 'once', 'sess_home_scribe');
  assert.equal(asks, 2, 'another agent still asks');
  const table = await store.permissions('inspector');
  assert.equal(table.find((row) => row.action === 'comment').mode, 'allow');
  assert.deepEqual(
    table.filter((row) => !row.rememberable).map((row) => row.action),
    ['payment', 'delete']
  );
  assert.equal(await store.revokeGrant(grant.id), true);
  assert.equal(await store.revokeGrant(grant.id), false);
  await call('o/r', 1);
  assert.equal(asks, 3, 'a revoked grant asks again');
});

test('a damaged grants file asks again, is kept aside and never throws', async (t) => {
  const { dir, store } = tempStore(t);
  for (const damaged of ['\0'.repeat(64), '{"grants":[{"id":']) {
    writeFileSync(join(dir, 'grants.json'), damaged);
    assert.deepEqual(await store.listGrants(), []);
    assert.equal(await store.modeFor({ agentId: 'mailer', action: 'comment' }), 'ask');
    assert.ok((await store.permissions('mailer')).every((row) => row.mode === 'ask'));
    assert.ok(readdirSync(dir).some((name) => name.startsWith('grants.json.corrupt-')));
  }
  assert.equal((await store.setMode({ agentId: 'mailer', action: 'comment', mode: 'allow' })).mode, 'allow');
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'comment' }), 'allow');
});

test('a damaged grants file never restores a stale .bak: grant, revoke, damage → ask', async (t) => {
  const { dir, store } = tempStore(t);
  const file = join(dir, 'grants.json');
  const grant = await store.grant({ agentId: 'mailer', scope: 'agent', action: 'comment' });
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'comment' }), 'allow');
  const staleAllow = readFileSync(file, 'utf8');
  assert.equal(await store.revokeGrant(grant.id), true);
  assert.equal(existsSync(`${file}.bak`), false, 'grant mutations never write a .bak');
  // An older build (or a crash) left a backup that still holds the revoked allow.
  writeFileSync(`${file}.bak`, staleAllow);
  for (const damaged of ['\0'.repeat(64), '{"grants":[{"id":']) {
    writeFileSync(file, damaged);
    assert.equal(await store.modeFor({ agentId: 'mailer', action: 'comment' }), 'ask');
    assert.deepEqual(await store.listGrants(), []);
  }
  // A mutation over a damaged file does not resurrect it either.
  writeFileSync(file, '\0'.repeat(64));
  writeFileSync(`${file}.bak`, staleAllow);
  assert.equal(await store.revokeGrant(grant.id), false);
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'comment' }), 'ask');
});

test('payments and deletes never offer or keep "don\'t ask again"', async (t) => {
  const { store } = tempStore(t);
  const asked = [];
  const run = (name, args) =>
    applyBeforeToolHook({
      name,
      args,
      cwd: '/tmp',
      callerSessionId: 'sess_home_buyer',
      executeOpts: {},
      toolApprovalHook: async (request) => {
        asked.push(request);
        return { approved: true, response: 'approve', remember: 'agent' };
      },
    });
  await run('mcp__stripe__create_payment', { amount: 5, currency: 'USD' });
  await run('mcp__stripe__create_payment', { amount: 5, currency: 'USD' });
  await run('mcp__drive__delete_permanently', { ids: ['a'] });
  await run('mcp__drive__delete_permanently', { ids: ['a'] });
  assert.equal(asked.length, 4, 'every payment and delete asks');
  for (const request of asked) assert.deepEqual(request.remember, ['once']);
  assert.equal(asked[0].outbound.category, 'payment');
  assert.deepEqual(asked[0].outbound.details, { amount: '5', currency: 'USD' });
  assert.equal(asked[2].outbound.details.count, '1');
  assert.deepEqual(await store.listGrants({ agentId: 'buyer' }), []);
  assert.equal(await store.setMode({ agentId: 'buyer', action: 'payment', mode: 'allow' }), null);
  assert.equal(await store.modeFor({ agentId: 'buyer', action: 'payment' }), 'ask');
});

test('a phone answer of remember=always on a delete or payment card counts as once and stores nothing', async (t) => {
  const { store } = tempStore(t);
  for (const name of ['mcp__chat__delete_message', 'mcp__stripe__create_payment']) {
    const out = await humanGateDecision({ name, args: { id: '1', amount: 5 } }, null, {
      sessionId: 'sess_home_buyer',
      store,
      annotations: {},
    });
    assert.deepEqual(out.request.remember, ['once'], name);
    for (const remember of ['always', 'agent']) {
      const { api } = queue((presented, inner) =>
        inner.finishToolApproval(presented.id, true, '', 'Pixel', undefined, undefined, { remember })
      );
      const answer = await api.requestToolApproval({ name, args: {}, ...out.request });
      assert.equal(answer.approved, true);
      assert.equal(answer.remember, 'once', `${name} ${remember}`);
      await recordHumanDecision(out.gate, answer, { store });
      // Even an unnormalised answer cannot store a grant for a scope the card never offered.
      await recordHumanDecision(out.gate, { approved: true, remember }, { store });
    }
  }
  assert.deepEqual(await store.listGrants({ agentId: 'buyer' }), []);
});

test('막기 (block) denies the action kind without a card', async (t) => {
  const { store } = tempStore(t);
  await store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  let asks = 0;
  const result = await applyBeforeToolHook({
    name: 'mcp__gmail__send_email',
    args: { to: 'a@b.c', body: 'hi' },
    cwd: '/tmp',
    callerSessionId: 'sess_home_mailer',
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'allow' }),
    toolApprovalHook: async () => {
      asks += 1;
      return { approved: true };
    },
  });
  assert.equal(asks, 0);
  assert.match(result.denial, /denied by hook: This agent's permission blocks this action/);
  const [row] = await store.readAudit({ agentId: 'mailer' });
  assert.equal(row.decision, 'blocked');
  assert.equal(row.action, 'email');
  await store.setMode({ agentId: 'mailer', action: 'email', mode: 'ask' });
  assert.equal(await store.modeFor({ agentId: 'mailer', action: 'email' }), 'ask');
});

test('the audit records agent, kind, action, tool, target, decision, device and time — never a value', async (t) => {
  const { dir, store } = tempStore(t);
  await applyBeforeToolHook({
    name: 'mcp__gmail__send_email',
    args: { to: 'boss@example.com', body: 'PAYLOAD-SENTINEL-1234' },
    cwd: '/tmp',
    callerSessionId: 'sess_home_mailer',
    executeOpts: {},
    toolApprovalHook: async () => ({ approved: false, response: 'deny', device: 'Pixel' }),
  });
  const [row] = await store.readAudit({ agentId: 'mailer' });
  assert.deepEqual(Object.keys(row).sort(), [
    'action',
    'agentId',
    'at',
    'decision',
    'device',
    'kind',
    'target',
    'tool',
  ]);
  assert.deepEqual(
    { ...row, at: 0 },
    {
      at: 0,
      agentId: 'mailer',
      kind: 'outbound',
      action: 'email',
      tool: 'mcp__gmail__send_email',
      target: 'boss@example.com',
      decision: 'deny',
      device: 'Pixel',
    }
  );
  assert.doesNotMatch(readFileSync(join(dir, 'audit.jsonl'), 'utf8'), /PAYLOAD-SENTINEL/);
});

test('a Gmail trash card lists sender and subject from the connector, keyed on the real ids', async (t) => {
  const { store } = tempStore(t);
  const asked = [];
  const scopeId = 'gate-describe-test';
  _registerMcpServerForTest(scopeId, 'gmail-9', [{ name: 'trash_emails' }], {
    callTool: async ({ name, arguments: args }) => {
      asked.push({ name, args });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              account: 'me@gmail.com',
              emails: args.ids.map((id) => ({
                id,
                from: 'Kim <kim@example.com>',
                subject: `S${id}`,
                date: '2026-01-02T03:04:05.000Z',
              })),
            }),
          },
        ],
      };
    },
  });
  t.after(() => disconnectAll({ scopeId }));
  const ids = ['1', '2', '3', '4', '5'];
  const call = { name: 'mcp__gmail-9__trash_emails', args: { ids } };
  // A mail server that is not the Gmail connector is never sent the unlisted call.
  rememberServerConnector('gmail-9', {});
  await humanGateDecision(call, null, { ...BOT, store, annotations: {}, mcpScopeId: scopeId });
  assert.deepEqual(asked, []);
  rememberServerConnector('gmail-9', { connector: 'gmail' });
  t.after(() => rememberServerConnector('gmail-9', {}));
  const out = await humanGateDecision(call, null, { ...BOT, store, annotations: {}, mcpScopeId: scopeId });
  assert.deepEqual(asked, [{ name: 'describe_emails', args: { ids: ['1', '2', '3'] } }]);
  assert.equal(out.request.outbound.account, 'me@gmail.com');
  assert.equal(
    out.request.outbound.details.messages,
    'Kim <kim@example.com> · S1 · 2026-01-02\nKim <kim@example.com> · S2 · 2026-01-02\nKim <kim@example.com> · S3 · 2026-01-02'
  );
  assert.equal(out.request.outbound.details.more, '2');
  assert.equal(out.request.outbound.details.count, '5');
  assert.equal(out.gate.target, ids.join(', '), 'the decision stays keyed on the actual ids');
});

test('Gmail trash_emails asks and may be remembered; payments and permanent deletes may not', async (t) => {
  const { store } = tempStore(t);
  const call = { name: 'mcp__gmail-2__trash_emails', args: { ids: ['9001', '9002'] } };
  const trash = classifyOutboundCall({ ...call, annotations: { readOnlyHint: false } });
  assert.equal(trash.category, 'trash');
  assert.deepEqual(trash.details, { count: '2' });
  assert.equal(trash.payload, '');
  assert.equal(classifyOutboundCall({ name: 'mcp__gmail__archive_emails', args: { ids: ['1'] } }), null);

  const first = await humanGateDecision(call, null, { ...BOT, store, annotations: {} });
  assert.equal(first.decision.action, 'ask');
  assert.deepEqual(first.request.remember, ['once', 'agent']);

  const normalized = normalizeHumanResponse(first.request, true, { remember: 'agent' });
  assert.equal(normalized.remember, 'agent');
  await recordHumanDecision(first.gate, { approved: true, remember: 'agent' }, { store });
  const again = await humanGateDecision(call, null, { ...BOT, store, annotations: {} });
  assert.equal(again.request, null, 'a remembered trash grant stops asking');

  for (const name of ['mcp__shop__checkout', 'mcp__drive__delete_permanently']) {
    const out = await humanGateDecision({ name, args: { ids: ['1'] } }, null, { ...BOT, store, annotations: {} });
    assert.deepEqual(out.request.remember, ['once'], name);
  }
});

test('the outbound gate applies only when a bot acts', async (t) => {
  const { store } = tempStore(t);
  const comment = { name: 'github', args: { action: 'issue.comment', repo: 'o/r', number: 3, body: 'hi' } };
  const decide = (sessionId, decision = null) =>
    humanGateDecision(comment, decision, { sessionId, store, annotations: {} });

  // A coding session (no home thread, room or unattended run) sends without a card or an audit line.
  for (const sessionId of ['sess_coding_1', undefined]) {
    const out = await decide(sessionId, { action: 'allow' });
    assert.deepEqual(out, { decision: { action: 'allow' }, request: null, gate: null });
  }
  // A hook's own ask is still the plain approval request.
  const hookAsk = await decide('sess_coding_1', { action: 'ask', reason: 'hook says' });
  assert.equal(hookAsk.decision.reason, 'hook says');
  assert.equal(hookAsk.request.kind, 'approval');
  assert.deepEqual(hookAsk.request.remember, ['once']);
  // A coding session is not blocked by a block set for Mixy or any bot either.
  await store.setMode({ agentId: 'lead', action: 'comment', mode: 'block' });
  assert.equal((await decide('sess_coding_1')).decision, null);
  assert.deepEqual(await store.readAudit({}), []);
  await store.setMode({ agentId: 'lead', action: 'comment', mode: 'ask' });

  // Mixy in her home thread, a bot's home thread and a bot's room member session ask.
  for (const [sessionId, agentId] of [
    ['sess_home_lead', 'lead'],
    ['sess_home_inspector', 'inspector'],
    ['sess_rmem_abcdef12_inspector', 'inspector'],
  ]) {
    const out = await decide(sessionId);
    assert.equal(out.decision.action, 'ask', sessionId);
    assert.equal(out.request.kind, 'outbound', sessionId);
    assert.equal(out.request.agentId, agentId, sessionId);
  }
  // A workflow agent's home thread is no bot.
  assert.equal((await decide('sess_home_helper')).request, null);
});

test('an unattended run is gated only when a bot or Mixy owns it', async (t) => {
  const { store } = tempStore(t);
  const runs = {
    sess_run_bot: { kind: 'schedule', agentId: 'inspector', name: 'nightly' },
    sess_run_mixy: { kind: 'webhook', agentId: 'lead', name: 'hook' },
    sess_run_agent: { kind: 'schedule', agentId: 'helper', name: 'nightly' },
  };
  setUnattendedApprovalPort({ runOf: (sessionId) => runs[sessionId] || null });
  t.after(() => setUnattendedApprovalPort(null));
  const comment = { name: 'github', args: { action: 'issue.comment', repo: 'o/r', number: 3, body: 'hi' } };
  const decide = (sessionId) => humanGateDecision(comment, null, { sessionId, store, annotations: {} });
  assert.equal((await decide('sess_run_bot')).decision.action, 'ask');
  assert.equal((await decide('sess_run_mixy')).decision.action, 'ask');
  assert.deepEqual(await decide('sess_run_agent'), { decision: null, request: null, gate: null });
  assert.deepEqual(await store.readAudit({ agentId: 'helper' }), []);
});

test('a presented trash card keeps its message list and remainder', () => {
  const messages = ['Kim · S1 · 2026-01-02', 'Kim · S2 · 2026-01-02', 'Kim · S3 · 2026-01-02'].join('\n');
  const { outbound } = humanRequestFields({
    kind: 'outbound',
    outbound: { category: 'trash', details: { count: '5', messages, more: '2' } },
  });
  assert.deepEqual(outbound.details, { count: '5', messages, more: '2' });
});
