// One Gmail server holds several accounts. A mail call that names one with
// `account` is approved as that account: the card shows its address, and the
// connector's describe_emails lookup is made for it, not for the default.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'outbound-account-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
mkdirSync(join(dataRoot, 'agents', 'mailer'), { recursive: true });
writeFileSync(join(dataRoot, 'agents', 'mailer', 'AGENT.md'), '---\nkind: bot\n---\nYou are mailer.\n');
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const { _registerMcpServerForTest, disconnectAll } = await import('../../mcp/client.mjs');
const { rememberServerConnector } = await import('../../mcp/server-connectors.mjs');
const { humanGateDecision } = await import('./gate.mjs');
const { createHumanGateStore, setHumanGateStore } = await import('./store.mjs');

const BOT = { sessionId: 'sess_home_mailer' };
const DEFAULT_ADDRESS = 'a@example.com';
const ADDRESSES = { 'b-account': 'b@example.com' };

function gmailServer(t) {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-account-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  const scopeId = 'outbound-account-test';
  const asked = [];
  _registerMcpServerForTest(scopeId, 'gmail-acct', [{ name: 'send_email' }, { name: 'trash_emails' }], {
    callTool: async ({ name, arguments: args }) => {
      asked.push({ name, args });
      const account = args.account === undefined ? DEFAULT_ADDRESS : ADDRESSES[args.account];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              account,
              emails: (args.ids || []).map((id) => ({
                id,
                from: 'Kim <kim@example.com>',
                subject: `S${id}`,
                date: '2026-01-02',
              })),
            }),
          },
        ],
      };
    },
  });
  rememberServerConnector('gmail-acct', { connector: 'gmail' });
  t.after(() => {
    rememberServerConnector('gmail-acct', {});
    disconnectAll({ scopeId });
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, scopeId, asked };
}

const decide = (call, { store, scopeId }) =>
  humanGateDecision(call, null, { ...BOT, store, annotations: {}, mcpScopeId: scopeId });

test('send_email with a chosen account shows that account and looks it up with that account', async (t) => {
  const server = gmailServer(t);
  const out = await decide(
    {
      name: 'mcp__gmail-acct__send_email',
      args: { to: 'boss@example.com', subject: 'Hi', body: 'x', account: 'b-account' },
    },
    server
  );
  assert.equal(out.request.kind, 'outbound');
  assert.equal(out.request.outbound.account, 'b@example.com');
  assert.deepEqual(server.asked, [{ name: 'describe_emails', args: { ids: [], account: 'b-account' } }]);
});

test('trash_emails with a chosen account shows that account and looks it up with that account', async (t) => {
  const server = gmailServer(t);
  const out = await decide(
    { name: 'mcp__gmail-acct__trash_emails', args: { ids: ['1', '2'], account: 'b-account' } },
    server
  );
  assert.equal(out.request.outbound.account, 'b@example.com');
  assert.deepEqual(server.asked, [{ name: 'describe_emails', args: { ids: ['1', '2'], account: 'b-account' } }]);
  assert.match(out.request.outbound.details.messages, /S1/);
});

test('without a chosen account the lookup names none and the card shows the default account', async (t) => {
  const server = gmailServer(t);
  const mail = await decide(
    { name: 'mcp__gmail-acct__send_email', args: { to: 'boss@example.com', subject: 'Hi', body: 'x' } },
    server
  );
  const trash = await decide({ name: 'mcp__gmail-acct__trash_emails', args: { ids: ['7'] } }, server);
  assert.equal(mail.request.outbound.account, DEFAULT_ADDRESS);
  assert.equal(trash.request.outbound.account, DEFAULT_ADDRESS);
  assert.deepEqual(server.asked, [
    { name: 'describe_emails', args: { ids: [] } },
    { name: 'describe_emails', args: { ids: ['7'] } },
  ]);
});
