// Connecting Gmail with an app password through the ordinary MCP server API:
// the password is checked before anything is saved, kept out of the config,
// replaces a Google sign-in, and leaves the keychain with its last server.
import assert from 'node:assert/strict';
import test from 'node:test';

import { GMAIL_APP_PASSWORD, gmailAppPasswordServerInput } from '../runtime/shared/connector-catalog.mjs';
import { createMcpGlue } from './mcp-glue.mjs';
import { createResourceApi } from './resource-api.mjs';

const EMAIL = 'me@gmail.com';
const PASSWORD = 'abcdwxyzabcdwxyz';

function harness(t, { initial = {}, reject = null } = {}) {
  let config = { mcpServers: { ...initial } };
  const keychain = new Map();
  const seen = { verified: [], forgotten: [], oauthCleared: [], clientSecrets: [] };
  const glue = createMcpGlue({ getConfig: () => config, getCurrentCwd: () => process.cwd(), mcpClient: {}, state: {} });
  const api = createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: (next) => {
      config = structuredClone(next);
    },
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    mcpStatus: () => glue.mcpStatus(),
    resolveMcpCatalog: glue.resolveMcpCatalog,
    pluginMcpServer: glue.pluginMcpServer,
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
    clearMcpServerOAuth: async (cfg) => {
      seen.oauthCleared.push(cfg.url);
      return { revoked: true };
    },
    saveOAuthClientSecret: async (url, secret) => {
      seen.clientSecrets.push([url, secret]);
    },
    gmailAppPassword: {
      async save(email, password) {
        seen.verified.push([email, password]);
        if (reject) throw reject;
        keychain.set(email, password);
      },
      async forget(email) {
        seen.forgotten.push(email);
        keychain.delete(email);
      },
    },
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  return { api, glue, keychain, seen, config: () => config };
}

test('a verified app password goes to the keychain only; the config keeps the account', async (t) => {
  const h = harness(t);
  await h.api.addMcpServer(gmailAppPasswordServerInput('gmail', EMAIL, 'abcd wxyz abcd wxyz'));
  assert.deepEqual(h.seen.verified, [[EMAIL, PASSWORD]]);
  assert.equal(h.keychain.get(EMAIL), PASSWORD);
  const saved = h.config().mcpServers.gmail;
  assert.deepEqual(saved, {
    type: 'http',
    url: GMAIL_APP_PASSWORD.url,
    headers: { [GMAIL_APP_PASSWORD.accountHeader]: EMAIL },
    connector: 'gmail',
  });
  assert.doesNotMatch(JSON.stringify(h.config()), new RegExp(PASSWORD));
  const row = h.glue.mcpStatus().servers.find((server) => server.name === 'gmail');
  assert.deepEqual(row.appPassword, { account: EMAIL });
  assert.equal(row.connector, 'gmail');
  assert.equal(row.oauth, undefined, 'never an OAuth sign-in');
  assert.doesNotMatch(JSON.stringify(row), new RegExp(PASSWORD));
});

test('a rejected or missing app password saves nothing', async (t) => {
  const rejected = harness(t, { reject: new Error('GMAIL_APP_PASSWORD_REJECTED: Google did not accept it.') });
  await assert.rejects(
    rejected.api.addMcpServer(gmailAppPasswordServerInput('gmail', EMAIL, PASSWORD)),
    /GMAIL_APP_PASSWORD_REJECTED/
  );
  assert.deepEqual(rejected.config().mcpServers, {});
  assert.equal(rejected.keychain.size, 0);

  const missing = harness(t);
  const { appPassword: _dropped, ...withoutPassword } = gmailAppPasswordServerInput('gmail', EMAIL, PASSWORD);
  await assert.rejects(missing.api.addMcpServer(withoutPassword), /GMAIL_APP_PASSWORD_FORMAT/);
  assert.deepEqual(missing.config().mcpServers, {});
  assert.deepEqual(missing.seen.verified, []);
});

test('switching the Google sign-in to an app password keeps the server and drops the old sign-in', async (t) => {
  const oauthGmail = {
    type: 'http',
    url: 'https://gmail.mixdog.invalid/mcp',
    connector: 'gmail',
    oauthClientId: 'mine',
  };
  const h = harness(t, { initial: { gmail: oauthGmail } });
  await h.api.saveMcpServer({
    ...gmailAppPasswordServerInput('gmail', EMAIL, PASSWORD),
    oauthClientId: '',
    originalName: 'gmail',
  });
  const saved = h.config().mcpServers.gmail;
  assert.equal(saved.url, GMAIL_APP_PASSWORD.url);
  assert.equal(saved.connector, 'gmail');
  assert.equal(saved.oauthClientId, undefined);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(PASSWORD));
  assert.deepEqual(h.seen.oauthCleared, ['https://gmail.mixdog.invalid/mcp']);
  assert.deepEqual(
    h.seen.clientSecrets,
    [['https://gmail.mixdog.invalid/mcp', '']],
    'the old client secret is forgotten'
  );
  // An edit without a password keeps the stored one.
  await h.api.saveMcpServer({ name: 'gmail', originalName: 'gmail', timeoutMs: 90_000 });
  assert.equal(h.seen.verified.length, 1);
  assert.equal(h.keychain.get(EMAIL), PASSWORD);
});

test('disconnect removes the app password, unless another server still uses the account', async (t) => {
  const appPasswordServer = (name) => {
    const { appPassword: _password, name: _name, ...cfg } = gmailAppPasswordServerInput(name, EMAIL, PASSWORD);
    return cfg;
  };
  const h = harness(t, { initial: { gmail: appPasswordServer('gmail'), 'gmail-2': appPasswordServer('gmail-2') } });
  h.keychain.set(EMAIL, PASSWORD);
  const shared = await h.api.removeMcpServer('gmail-2');
  assert.equal(shared.signIn, 'shared');
  assert.deepEqual(h.seen.forgotten, []);
  const removed = await h.api.removeMcpServer('gmail');
  assert.equal(removed.signIn, 'removed');
  assert.equal(removed.revoked, false, 'an app password is revoked at Google only');
  assert.deepEqual(h.seen.forgotten, [EMAIL]);
  assert.equal(h.keychain.size, 0);
  assert.deepEqual(h.seen.oauthCleared, [], 'no OAuth sign-in is touched');
});

test('two accounts with different addresses: disconnecting one keeps the other and its password', async (t) => {
  const OTHER = 'work@gmail.com';
  const config = (name, email) => {
    const { appPassword: _password, name: _name, ...cfg } = gmailAppPasswordServerInput(name, email, PASSWORD);
    return cfg;
  };
  const h = harness(t, { initial: { gmail: config('gmail', EMAIL), 'gmail-2': config('gmail-2', OTHER) } });
  h.keychain.set(EMAIL, PASSWORD);
  h.keychain.set(OTHER, 'zyxwabcdzyxwabcd');
  const rows = h.glue.mcpStatus().servers.filter((server) => server.connector === 'gmail');
  assert.deepEqual(
    rows.map((row) => [row.name, row.appPassword.account]),
    [
      ['gmail', EMAIL],
      ['gmail-2', OTHER],
    ]
  );
  const removed = await h.api.removeMcpServer('gmail-2');
  assert.equal(removed.signIn, 'removed');
  assert.deepEqual(h.seen.forgotten, [OTHER]);
  assert.equal(h.keychain.get(EMAIL), PASSWORD, 'the other account keeps its password');
  assert.deepEqual(Object.keys(h.config().mcpServers), ['gmail']);
});
