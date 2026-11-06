// Records, from today's Node product, what the keychain side of MCP server edits does
// (resource-mcp-secrets.mjs) with the effects it has on the outside world logged, plus the
// keychain account names and the OAuth credential key of a server config.
// Usage: node mcpsecrets.mjs <repo-root> <out.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
process.env.MCPT_HOST = 'example.com';
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createMcpServerSecrets } = await load('session-runtime/resource-mcp-secrets.mjs');
const servers = await load('session-runtime/resource-mcp-servers.mjs');
const oauthClient = await load('runtime/agent/orchestrator/mcp/oauth-client.mjs');
const gmail = await load('runtime/connectors/gmail-app-password.mjs');

let log = [];
let configured = {};
const secrets = createMcpServerSecrets({
  gmailAppPassword: {
    async save(account, password) {
      log.push(`gmailSave:${account}:${password}`);
      if (password.startsWith('bad')) throw new Error('GMAIL_APP_PASSWORD_REJECTED: no');
    },
    async forget(account) {
      log.push(`gmailForget:${account}`);
    },
  },
  async saveOAuthClientSecret(url, secret) {
    log.push(`clientSecret:${url}:${secret}`);
  },
  async clearMcpServerOAuth(cfg, options) {
    log.push(`clear:${cfg.name}:${options.revoke}`);
    return cfg.name === 'revoker' ? { revoked: true } : undefined;
  },
  resolveConfiguredMcpCatalog: () => ({ servers: configured }),
});

const cases = [];
const record = async (op, args, servers_ = {}) => {
  log = [];
  configured = servers_;
  let result = null;
  let error = null;
  try {
    result = (await run(op, args)) ?? null;
  } catch (e) {
    error = e.message;
  }
  cases.push({ op, args, servers: servers_, log, result, error });
};
const run = (op, a) => {
  switch (op) {
    case 'storeClient': return secrets.storeOAuthClientSecret(a[0], a[1], a[2]);
    case 'storeGmail': return secrets.storeGmailAppPassword(a[0], a[1], a[2]);
    case 'releaseOAuth': return secrets.releaseOAuth(a[0]);
    case 'forgetUnused': return secrets.forgetUnusedGmailAppPassword(a[0]);
    case 'forgetStored': return secrets.forgetStoredSecrets(a[0]);
    case 'releaseAccount': return secrets.releaseAccount(a[0]);
    case 'credential': return servers.oauthCredentialOf(a[0]);
    case 'secretAccount': return gmail.gmailAppPasswordSecretAccount(a[0]);
    case 'clientAccount': return oauthClient.mcpOAuthClientSecretAccount(a[0]);
    default: throw new Error(op);
  }
};

const gm = (email, extra = {}) => ({ type: 'http', url: 'https://gmail-imap.mixdog.invalid/mcp', headers: { 'X-Mixdog-Gmail-Account': email }, connector: 'gmail', ...extra });
const web = (name, url, extra = {}) => ({ name, type: 'http', url, ...extra });

// storeOAuthClientSecret
for (const [input, cfg, previous] of [
  [{ oauthClientSecret: ' s3 ' }, web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), undefined],
  [{ oauthClientSecret: '   ' }, web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), {}],
  [{ oauthClientSecret: 5 }, web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), {}],
  [{}, web('a', 'https://a.test/mcp'), { oauthClientId: 'old', url: 'https://old.test/mcp' }],
  [{}, web('a', 'https://a.test/mcp'), { oauthClientId: 'old' }],
  [{}, web('a', 'https://a.test/mcp'), {}],
  [{ oauthClientSecret: 's' }, { command: 'x', oauthClientId: 'cid' }, {}],
  [{ oauthClientSecret: 's' }, null, {}],
]) await record('storeClient', [input, cfg, previous ?? {}]);

// storeGmailAppPassword
for (const [input, cfg, required] of [
  [{ appPassword: 'abcd efgh ijkl mnop' }, gm('Me@Example.com '), true],
  [{ appPassword: 'abcd efgh ijkl mnop' }, gm('me@example.com'), false],
  [{}, gm('me@example.com'), false],
  [{}, gm('me@example.com'), true],
  [{ appPassword: '' }, gm('me@example.com'), false],
  [{ appPassword: 'short' }, gm('me@example.com'), false],
  [{ appPassword: null }, gm('me@example.com'), false],
  [{ appPassword: 'badbadbadbadbadb' }, gm('me@example.com'), true],
  [{ appPassword: 'abcd efgh ijkl mnop' }, web('w', 'https://w.test/mcp'), true],
  [{ appPassword: 'abcd efgh ijkl mnop' }, gm('not-an-address'), true],
]) await record('storeGmail', [input, cfg, required]);

// releaseOAuth
const shared = { other: web('other', 'https://a.test/mcp') };
for (const [cfg, conf] of [
  [web('a', 'https://a.test/mcp'), {}],
  [web('a', 'https://a.test/mcp'), shared],
  [web('a', 'https://a.test/mcp'), { a: web('a', 'https://a.test/mcp') }],
  [web('a', 'https://A.test/mcp'), shared],
  [web('revoker', 'https://a.test/mcp'), {}],
  [{ name: 'c', command: 'x' }, {}],
  [web('a', 'not a url'), {}],
  [web('a', 'http://insecure.test/mcp'), {}],
  [web('a', 'https://a.test/mcp', { oauthKey: ' k1 ' }), { x: web('x', 'https://a.test/mcp') }],
  [web('a', 'https://a.test/mcp', { oauthKey: 'k1' }), { x: web('x', 'https://other.test/mcp', { oauthKey: 'k1' }) }],
  [web('a', 'https://${MCPT_HOST}/mcp'), { x: web('x', 'https://example.com/mcp') }],
  [web('a', 'https://a.test/mcp'), { notion: { type: 'http', url: 'https://connectors.mixdog.invalid/notion/mcp', connector: 'notion', accounts: [{ name: 'n1', url: 'https://a.test/mcp' }] } }],
  [web('a', 'https://a.test/mcp'), { notion: { type: 'http', url: 'https://connectors.mixdog.invalid/notion/mcp', connector: 'notion', accounts: [{ name: 'n1', url: 'https://b.test/mcp' }] } }],
  [{ name: 's', type: 'sse', url: 'https://s.test/sse' }, {}],
  [{ name: 'w', type: 'ws', url: 'wss://s.test/ws' }, {}],
]) await record('releaseOAuth', [cfg], conf);

// forgetUnusedGmailAppPassword
const gmailServers = { g: gm('me@example.com'), n: { type: 'http', connector: 'gmail', url: 'https://connectors.mixdog.invalid/gmail/mcp', accounts: [{ name: 'g2', url: 'https://gmail-imap.mixdog.invalid/mcp', headers: { 'X-Mixdog-Gmail-Account': 'two@example.com' } }] } };
for (const [account, conf] of [['', {}], ['me@example.com', {}], ['me@example.com', gmailServers], ['two@example.com', gmailServers], ['three@example.com', gmailServers]]) {
  await record('forgetUnused', [account], conf);
}
// forgetStoredSecrets
for (const [cfg, conf] of [
  [gm('me@example.com'), {}],
  [gm('me@example.com'), gmailServers],
  [web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), {}],
  [web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), { o: web('o', 'https://a.test/mcp', { oauthClientId: 'x' }) }],
  [web('a', 'https://a.test/mcp', { oauthClientId: 'cid' }), { o: web('o', 'https://a.test/mcp') }],
  [web('a', 'https://a.test/mcp'), {}],
  [{ command: 'x' }, {}],
]) await record('forgetStored', [cfg], conf);
// releaseAccount
for (const [cfg, conf] of [
  [{ ...gm('me@example.com'), name: 'g1' }, {}],
  [{ ...gm('me@example.com'), name: 'g1' }, gmailServers],
  [web('n1', 'https://a.test/mcp'), {}],
  [web('n1', 'https://a.test/mcp'), shared],
  [web('revoker', 'https://a.test/mcp'), {}],
  [{ name: 'c', command: 'x' }, {}],
]) await record('releaseAccount', [cfg], conf);

// Names and keys
for (const cfg of [web('a', 'https://a.test/mcp'), web('a', 'https://a.test'), web('a', 'https://a.test/mcp#frag'), web('a', 'https://${MCPT_HOST}/p'), web('a', 'https://${MCPT_NOPE}/p'), web('a', 'https://${MCPT_NOPE:-fallback.test}/p'), web('a', ''), { name: 'a' }, { command: 'x' }, { type: 'sse', url: 'https://s.test/sse', oauthKey: 'k' }, { type: 'ws', url: 'wss://w.test' }, { type: 'bogus', url: 'https://b.test' }, { transport: 'http', url: 'https://t.test/x' }, web('a', 'https://a.test/mcp', { oauthKey: '  ' }), web('a', 'https://a.test/mcp', { oauthKey: 5 })]) {
  await record('credential', [cfg]);
}
for (const email of ['me@example.com', ' Me@Example.COM ', 'bad', '']) await record('secretAccount', [email]);
for (const url of ['https://a.test/mcp', 'https://a.test', 'https://A.test/mcp#f', 'http://localhost:1/x', 'nope', 'http://insecure.test/']) await record('clientAccount', [url]);

writeFileSync(out, JSON.stringify({ cases }, null, 1));
console.log(cases.length, 'cases', cases.filter((c) => c.error).length, 'errors');
