// A multi-account connector through the ordinary MCP server API: one server
// per connector (`gmail`) holding its accounts. Gmail's app password is
// checked before anything is saved, kept out of the config, replaces a Google
// sign-in, and leaves the keychain with its last account; another account
// joins the server, removing one leaves the others (and their credentials)
// alone; legacy one-account servers (`gmail`, `gmail-2`…) merge on load.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONNECTOR_CATALOG,
  GMAIL_APP_PASSWORD,
  connectorAccountsUrl,
  connectorLiveAccountServers,
  connectorServerInput,
  gmailAppPasswordServerInput,
  mergeConnectorAccountServers,
} from '../runtime/shared/connector-catalog.mjs';
import { PENDING_MERGE_FILE, migrateMergedConnectorServers } from './connector-merge-migration.mjs';
import { createMcpGlue } from './mcp-glue.mjs';
import { createResourceApi } from './resource-api.mjs';

const EMAIL = 'me@gmail.com';
const PASSWORD = 'abcdwxyzabcdwxyz';
const OTHER = 'work@gmail.com';
const OTHER_PASSWORD = 'zyxwabcdzyxwabcd';
const CALENDAR = CONNECTOR_CATALOG.find((entry) => entry.id === 'google-calendar');

/** A one-account Gmail app-password server config as earlier versions stored it. */
const legacyAppPassword = (name, email) => {
  const { appPassword: _password, name: _name, ...cfg } = gmailAppPasswordServerInput(name, email, PASSWORD);
  return cfg;
};
const appPasswordAccount = (name, email) => ({
  name,
  url: GMAIL_APP_PASSWORD.url,
  headers: { [GMAIL_APP_PASSWORD.accountHeader]: email },
});

function harness(
  t,
  {
    initial = {},
    extra = {},
    dataDir = '',
    reject = null,
    oauthState = () => null,
    connect = async () => ({ servers: [] }),
    startSwitch = () => {
      throw new Error('no browser sign-in expected');
    },
    commitSwitch = async () => async () => {},
  } = {}
) {
  let config = { ...extra, mcpServers: { ...initial } };
  const keychain = new Map();
  const seen = { verified: [], forgotten: [], oauthCleared: [], clientSecrets: [], saves: 0 };
  const glue = createMcpGlue({
    getConfig: () => config,
    getCurrentCwd: () => process.cwd(),
    mcpClient: { getMcpServerOAuthState: oauthState },
    state: {},
  });
  const api = createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: dataDir ? { getPluginData: () => dataDir } : {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: (next) => {
      seen.saves += 1;
      config = structuredClone(next);
    },
    getMcpServerOAuthState: oauthState,
    awaitKeychainPrewarm: async () => {},
    connectConfiguredMcp: connect,
    startMcpServerOAuthSwitch: (cfg, launch, name) => startSwitch(cfg, launch, name),
    commitMcpServerOAuthSwitch: (cfg, signIn) => commitSwitch(cfg, signIn),
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
    url: connectorAccountsUrl('gmail'),
    connector: 'gmail',
    accounts: [appPasswordAccount('gmail', EMAIL)],
  });
  assert.doesNotMatch(JSON.stringify(h.config()), new RegExp(PASSWORD));
  const row = h.glue.mcpStatus().servers.find((server) => server.name === 'gmail');
  assert.deepEqual(row.appPassword, { account: EMAIL }, 'one account reads like the server it was');
  assert.deepEqual(row.accounts, [{ name: 'gmail', email: EMAIL, appPassword: { account: EMAIL } }]);
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
  assert.equal(saved.connector, 'gmail');
  assert.deepEqual(saved.accounts, [appPasswordAccount('gmail', EMAIL)], 'the account is on its app password now');
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
  assert.equal(h.config().mcpServers.gmail.timeoutMs, 90_000, 'a timeout is the server’s');
  assert.deepEqual(h.config().mcpServers.gmail.accounts, [appPasswordAccount('gmail', EMAIL)]);
});

test('migration: gmail, gmail-2 and gmail-3 become one server with three accounts, keeping every credential', async (t) => {
  const THIRD = 'team@gmail.com';
  const oauthGmail = { type: 'http', url: 'https://gmail.mixdog.invalid/mcp', connector: 'gmail', timeoutMs: 60_000 };
  const custom = { type: 'http', url: 'https://example.com/mcp' };
  const h = harness(t, {
    initial: {
      'gmail-3': legacyAppPassword('gmail-3', THIRD),
      gmail: oauthGmail,
      'gmail-2': { ...legacyAppPassword('gmail-2', OTHER), enabled: false },
      notes: custom,
    },
  });
  for (const [email, password] of [
    [OTHER, OTHER_PASSWORD],
    [THIRD, PASSWORD],
  ])
    h.keychain.set(email, password);
  const before = new Map(h.keychain);

  assert.deepEqual(h.api.migrateConnectorAccounts(), [
    { connector: 'gmail', name: 'gmail', from: ['gmail', 'gmail-2', 'gmail-3'] },
  ]);
  assert.deepEqual(h.config().mcpServers, {
    gmail: {
      timeoutMs: 60_000,
      type: 'http',
      url: connectorAccountsUrl('gmail'),
      connector: 'gmail',
      accounts: [
        { name: 'gmail', url: 'https://gmail.mixdog.invalid/mcp' },
        { ...appPasswordAccount('gmail-2', OTHER), enabled: false },
        appPasswordAccount('gmail-3', THIRD),
      ],
    },
    notes: custom,
  });
  // No password was checked, saved or forgotten; no sign-in was touched.
  assert.deepEqual(h.keychain, before);
  assert.deepEqual([h.seen.verified, h.seen.forgotten, h.seen.oauthCleared], [[], [], []]);
  const [row] = h.glue.mcpStatus().servers.filter((server) => server.connector === 'gmail');
  assert.deepEqual(
    row.accounts.map((account) => [account.name, account.email]),
    [
      ['gmail', ''],
      ['gmail-2', OTHER],
      ['gmail-3', THIRD],
    ]
  );

  // Idempotent: a second run (every start runs it) changes nothing.
  const saves = h.seen.saves;
  const merged = structuredClone(h.config());
  assert.deepEqual(h.api.migrateConnectorAccounts(), []);
  assert.equal(h.seen.saves, saves, 'nothing is written');
  assert.deepEqual(h.config(), merged);
});

test('migration: Google Calendar accounts keep their sign-in URLs and own clients; the same address twice is one account', async (t) => {
  const h = harness(t, {
    initial: {
      'google-calendar': { type: 'http', url: CALENDAR.backend.url, connector: 'google-calendar' },
      'google-calendar-2': {
        type: 'http',
        url: `${CALENDAR.backend.url}?account=google-calendar-2`,
        connector: 'google-calendar',
        oauthClientId: 'mine.apps.googleusercontent.com',
      },
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': legacyAppPassword('gmail-2', EMAIL),
    },
  });
  h.api.migrateConnectorAccounts();
  const { mcpServers } = h.config();
  assert.deepEqual(Object.keys(mcpServers).sort(), ['gmail', 'google-calendar']);
  assert.deepEqual(mcpServers['google-calendar'].accounts, [
    { name: 'google-calendar', url: CALENDAR.backend.url },
    {
      name: 'google-calendar-2',
      url: `${CALENDAR.backend.url}?account=google-calendar-2`,
      oauthClientId: 'mine.apps.googleusercontent.com',
    },
  ]);
  assert.deepEqual(mcpServers.gmail.accounts, [appPasswordAccount('gmail', EMAIL)]);
  assert.equal(mcpServers.gmail.enabled, undefined);
});

test('another account joins the one server; the same address again only takes its new password', async (t) => {
  const h = harness(t);
  const first = await h.api.addMcpServer(gmailAppPasswordServerInput('gmail', EMAIL, PASSWORD));
  assert.deepEqual([first.name, first.account], ['gmail', 'gmail']);
  const second = await h.api.addMcpServer(gmailAppPasswordServerInput('gmail-2', OTHER, OTHER_PASSWORD));
  assert.deepEqual([second.name, second.account], ['gmail', 'gmail-2']);
  assert.deepEqual(Object.keys(h.config().mcpServers), ['gmail']);
  assert.deepEqual(h.config().mcpServers.gmail.accounts, [
    appPasswordAccount('gmail', EMAIL),
    appPasswordAccount('gmail-2', OTHER),
  ]);
  // Each account's own password, under its own address.
  assert.deepEqual(
    [...h.keychain],
    [
      [EMAIL, PASSWORD],
      [OTHER, OTHER_PASSWORD],
    ]
  );
  const again = await h.api.addMcpServer(gmailAppPasswordServerInput('gmail-3', 'WORK@gmail.com', PASSWORD));
  assert.deepEqual([again.name, again.account], ['gmail', 'gmail-2'], 'no duplicate account');
  assert.equal(h.config().mcpServers.gmail.accounts.length, 2);
  assert.equal(h.keychain.get(OTHER), PASSWORD, 'the new password replaced the old one');
  assert.equal(h.keychain.get(EMAIL), PASSWORD, 'the other account is untouched');
  // A name another account holds is never reused.
  await assert.rejects(
    h.api.addMcpServer({ name: 'gmail-2', type: 'http', url: 'https://example.com/mcp' }),
    /used by a Gmail account/
  );
});

test('a second Google sign-in account gets its own URL, so its tokens never mix with the first', async (t) => {
  const h = harness(t);
  await h.api.addMcpServer(connectorServerInput(CALENDAR, 'google-calendar'));
  // Even when asked for a taken name and the shared URL, it gets its own of both.
  const added = await h.api.addMcpServer(connectorServerInput(CALENDAR, 'google-calendar'));
  assert.deepEqual([added.name, added.account], ['google-calendar', 'google-calendar-2']);
  assert.deepEqual(h.config().mcpServers['google-calendar'].accounts, [
    { name: 'google-calendar', url: CALENDAR.backend.url },
    { name: 'google-calendar-2', url: `${CALENDAR.backend.url}?account=google-calendar-2` },
  ]);
});

test('removing an account removes only its credentials; the last one takes the server with it', async (t) => {
  const signIn = { signedIn: true, account: 'cal@example.com' };
  const h = harness(t, {
    initial: {
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': legacyAppPassword('gmail-2', OTHER),
      'google-calendar': { type: 'http', url: CALENDAR.backend.url, connector: 'google-calendar' },
      'google-calendar-2': {
        type: 'http',
        url: `${CALENDAR.backend.url}?account=google-calendar-2`,
        connector: 'google-calendar',
      },
    },
    oauthState: (cfg) => (cfg.headers || !String(cfg.url).includes('calendar') ? null : signIn),
  });
  h.keychain.set(EMAIL, PASSWORD);
  h.keychain.set(OTHER, OTHER_PASSWORD);
  h.api.migrateConnectorAccounts();

  const removed = await h.api.removeMcpServer('gmail-2');
  assert.equal(removed.signIn, 'removed');
  assert.equal(removed.revoked, false, 'an app password is revoked at Google only');
  assert.deepEqual(h.seen.forgotten, [OTHER]);
  assert.equal(h.keychain.get(EMAIL), PASSWORD, 'the other account keeps its password');
  assert.deepEqual(h.config().mcpServers.gmail.accounts, [appPasswordAccount('gmail', EMAIL)]);

  const calendar = await h.api.removeMcpServer('google-calendar');
  assert.equal(calendar.signIn, 'removed');
  assert.deepEqual(h.seen.oauthCleared, [CALENDAR.backend.url], 'only that account’s tokens');
  assert.deepEqual(h.config().mcpServers['google-calendar'].accounts, [
    { name: 'google-calendar-2', url: `${CALENDAR.backend.url}?account=google-calendar-2` },
  ]);
  // The server keeps its name and now answers for its other account.
  const [row] = h.glue.mcpStatus().servers.filter((server) => server.connector === 'google-calendar');
  assert.deepEqual(
    row.accounts.map((account) => account.name),
    ['google-calendar-2']
  );
  assert.deepEqual(row.oauth, signIn);

  await h.api.removeMcpServer('gmail');
  assert.equal(h.config().mcpServers.gmail, undefined, 'the last account takes the server with it');
  assert.deepEqual(h.seen.forgotten, [OTHER, EMAIL]);
  assert.equal(h.keychain.size, 0);
});

test('signing in, out or switching an account goes by its name; a several-account server needs the account', async (t) => {
  const h = harness(t, {
    initial: {
      'google-calendar': { type: 'http', url: CALENDAR.backend.url, connector: 'google-calendar' },
      'google-calendar-2': {
        type: 'http',
        url: `${CALENDAR.backend.url}?account=google-calendar-2`,
        connector: 'google-calendar',
      },
    },
    oauthState: () => ({ signedIn: true, account: '' }),
  });
  h.api.migrateConnectorAccounts();
  await assert.rejects(h.api.beginMcpOAuthLogin('google-calendar-3'), /not configured/);
  const out = await h.api.signOutMcpServer('google-calendar-2');
  assert.equal(out.revoked, true);
  assert.deepEqual(h.seen.oauthCleared, [`${CALENDAR.backend.url}?account=google-calendar-2`]);
  // The server's own name (no account has it) with several accounts signs every one out.
  const harness2 = harness(t, {
    initial: {
      calendar: {
        type: 'http',
        url: connectorAccountsUrl('google-calendar'),
        connector: 'google-calendar',
        accounts: [
          { name: 'cal-a', url: CALENDAR.backend.url },
          { name: 'cal-b', url: `${CALENDAR.backend.url}?account=cal-b` },
        ],
      },
    },
    oauthState: () => ({ signedIn: true, account: '' }),
  });
  await harness2.api.signOutMcpServer('calendar');
  assert.deepEqual(harness2.seen.oauthCleared, [CALENDAR.backend.url, `${CALENDAR.backend.url}?account=cal-b`]);
  await assert.rejects(harness2.api.beginMcpOAuthLogin('calendar'), /several accounts; name the account/);
});

test('re-authenticating a signed-in account tries its stored sign-in first; the browser opens only when that fails', async (t) => {
  const calendar = () => ({
    'google-calendar': { type: 'http', url: CALENDAR.backend.url, connector: 'google-calendar' },
    'google-calendar-2': {
      type: 'http',
      url: `${CALENDAR.backend.url}?account=google-calendar-2`,
      connector: 'google-calendar',
    },
  });
  const switches = [];
  const startSwitch = (cfg, launch) => {
    switches.push([cfg.name, launch.accountMode]);
    return { done: Promise.reject(new Error('MCP OAuth login cancelled')), cancel() {}, answer() {} };
  };
  const signedIn = () => ({ signedIn: true, account: '' });

  // The repaired connection works: complete at once, no browser.
  const works = harness(t, {
    initial: calendar(),
    oauthState: signedIn,
    connect: async ({ only }) => ({ servers: [{ name: only, connected: true }] }),
    startSwitch,
  });
  works.api.migrateConnectorAccounts();
  const repaired = await works.api.beginMcpOAuthLogin('google-calendar-2', { mode: 'reauth' });
  assert.equal(repaired.state, 'complete');
  assert.deepEqual(switches, [], 'no browser sign-in');

  // Still broken after the repair: the browser sign-in starts (here: cancelled).
  const broken = harness(t, {
    initial: calendar(),
    oauthState: signedIn,
    connect: async ({ only }) => ({ servers: [{ name: only, connected: false, error: 'invalid_grant' }] }),
    startSwitch,
  });
  broken.api.migrateConnectorAccounts();
  await assert.rejects(broken.api.beginMcpOAuthLogin('google-calendar-2', { mode: 'reauth' }), /cancelled/);
  assert.deepEqual(switches, [['google-calendar-2', 'reauth']], 'its own mode: no forced account choice');

  // 계정 바꾸기 always asks the browser.
  switches.length = 0;
  await assert.rejects(works.api.beginMcpOAuthLogin('google-calendar-2', { mode: 'switch' }), /cancelled/);
  assert.deepEqual(switches, [['google-calendar-2', 'switch']]);
});

test('an account switch refuses an address another account has, and rolls back a sign-in that cannot connect', async (t) => {
  const calendar = {
    'google-calendar': { type: 'http', url: CALENDAR.backend.url, connector: 'google-calendar' },
    'google-calendar-2': {
      type: 'http',
      url: `${CALENDAR.backend.url}?account=google-calendar-2`,
      connector: 'google-calendar',
    },
  };
  const events = [];
  let identity = 'Me@Example.com';
  const h = harness(t, {
    initial: calendar,
    oauthState: (cfg) => ({ signedIn: true, account: cfg.name === 'google-calendar' ? 'me@example.com' : '' }),
    connect: async ({ only }) => {
      events.push(['connect', only]);
      return { servers: [{ name: only, connected: false, error: 'invalid_grant' }] };
    },
    startSwitch: (cfg) => {
      events.push(['start', cfg.name]);
      return { done: Promise.resolve({ identity: { account: identity } }), cancel() {}, answer() {} };
    },
    commitSwitch: async (cfg, signIn) => {
      events.push(['commit', cfg.name, signIn.identity.account]);
      return async () => events.push(['rollback', cfg.name]);
    },
  });
  h.api.migrateConnectorAccounts();
  // The address the other account already signed in with: refused, nothing committed.
  await assert.rejects(
    h.api.beginMcpOAuthLogin('google-calendar-2', { mode: 'switch' }),
    /Me@Example\.com is already connected/
  );
  assert.deepEqual(events, [['start', 'google-calendar-2']]);
  // A new address that cannot connect is committed, then rolled back and reconnected.
  events.length = 0;
  identity = 'new@example.com';
  await assert.rejects(h.api.beginMcpOAuthLogin('google-calendar-2', { mode: 'switch' }), /invalid_grant/);
  assert.deepEqual(events, [
    ['start', 'google-calendar-2'],
    ['commit', 'google-calendar-2', 'new@example.com'],
    ['connect', 'google-calendar'],
    ['rollback', 'google-calendar-2'],
    ['connect', 'google-calendar'],
  ]);
});

test('an OAuth client secret goes to the keychain under the server URL, and clearing the client id forgets it', async (t) => {
  const h = harness(t);
  await h.api.addMcpServer({
    name: 'custom',
    type: 'http',
    url: 'https://mcp.example/mcp',
    oauthClientId: 'mine',
    oauthClientSecret: '  s3cret  ',
  });
  assert.deepEqual(h.seen.clientSecrets, [['https://mcp.example/mcp', 's3cret']]);
  assert.doesNotMatch(JSON.stringify(h.config()), /s3cret/);
  await h.api.saveMcpServer({ name: 'custom', originalName: 'custom', oauthClientId: '' });
  assert.deepEqual(h.seen.clientSecrets, [
    ['https://mcp.example/mcp', 's3cret'],
    ['https://mcp.example/mcp', ''],
  ]);
});

test('a new connector server never takes a name an account of another connector has', async (t) => {
  const h = harness(t, {
    initial: { gmail: legacyAppPassword('gmail', EMAIL), 'gmail-2': legacyAppPassword('gmail-2', OTHER) },
  });
  h.api.migrateConnectorAccounts();
  await assert.rejects(
    h.api.addMcpServer(connectorServerInput(CALENDAR, 'gmail-2')),
    /"gmail-2" is used by a Gmail account/
  );
  assert.equal(h.config().mcpServers['gmail-2'], undefined);
  assert.equal(h.config().mcpServers['google-calendar'], undefined, 'nothing was created');
  const made = await h.api.addMcpServer(connectorServerInput(CALENDAR, 'google-calendar'));
  assert.deepEqual([made.name, made.account], ['google-calendar', 'google-calendar']);
});

test('migration drops the settings of a merged-away server name; the server keeps its own', async (t) => {
  const h = harness(t, {
    initial: {
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': { ...legacyAppPassword('gmail-2', OTHER), enabled: false },
    },
    extra: { extensionScopes: { mcp: { 'gmail-2': ['C:/work'], gmail: ['C:/home'] } } },
  });
  h.api.migrateConnectorAccounts();
  assert.deepEqual(Object.keys(h.config().extensionScopes.mcp), ['gmail'], 'gmail-2’s scope is gone, gmail’s kept');
  // The formerly switched-off account stays off while the server is on.
  assert.equal(h.config().mcpServers.gmail.enabled, undefined);
  assert.deepEqual(h.config().mcpServers.gmail.accounts, [
    appPasswordAccount('gmail', EMAIL),
    { ...appPasswordAccount('gmail-2', OTHER), enabled: false },
  ]);
});

test('a custom server named like a connector account is refused as a used account name, not a "server"', async (t) => {
  const h = harness(t, {
    initial: {
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': legacyAppPassword('gmail-2', OTHER),
      notes: { type: 'http', url: 'https://example.com/mcp' },
    },
  });
  h.api.migrateConnectorAccounts();
  const taken = /Error: The name "gmail-2" is used by a Gmail account\. Choose another name\.$/;
  await assert.rejects(h.api.addMcpServer({ name: 'gmail-2', type: 'http', url: 'https://example.com/other' }), taken);
  await assert.rejects(
    h.api.saveMcpServer({ originalName: 'notes', name: 'gmail-2', type: 'http', url: 'https://example.com/mcp' }),
    taken
  );
  // A plain server name keeps the old wording.
  await assert.rejects(
    h.api.addMcpServer({ name: 'notes', type: 'http', url: 'https://example.com/other' }),
    /Error: MCP server already exists: notes$/
  );
  assert.deepEqual(Object.keys(h.config().mcpServers).sort(), ['gmail', 'notes']);
});

test('migration maps per-agent, per-project and hook settings of merged-away servers onto the surviving one', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'connector-merge-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(join(dataDir, ...path.slice(0, -1)), { recursive: true });
    writeFileSync(join(dataDir, ...path), `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = (...path) => JSON.parse(readFileSync(join(dataDir, ...path), 'utf8'));
  const raw = (...path) => readFileSync(join(dataDir, ...path), 'utf8');

  put(['agents', 'one-off', 'agent.json'], { name: 'One off', connectors: { off: ['gmail-2'] } });
  put(['agents', 'all-off', 'agent.json'], { connectors: { off: ['gmail', 'gmail-2', 'gmail-3', 'notes'] } });
  put(['agents', 'tools', 'agent.json'], {
    connectors: {
      off: [],
      tools: {
        gmail: { send_email: 'disabled', read_email: 'needs_approval' },
        'gmail-2': { send_email: 'auto', delete_email: 'disabled' },
        notes: { write: 'auto' },
      },
    },
  });
  put(['agents', 'dormant', 'agent.json'], {
    connectors: {
      off: ['gmail-2'],
      tools: { 'gmail-2': { send_email: 'auto' }, gmail: { send_email: 'needs_approval' } },
    },
  });
  put(['agents', 'legacy', 'agent.json'], {
    connectors: [
      { id: 'gmail-2', enabled: true, tools: { send_email: 'auto' } },
      { id: 'notes', enabled: true },
    ],
  });
  put(['agents', 'untouched', 'agent.json'], { connectors: { off: ['notes'], tools: { notes: { write: 'auto' } } } });
  put(['bots', 'robot', 'agent.json'], {
    route: { provider: 'p', model: 'm' },
    connectors: { off: ['gmail-3'] },
  });
  put(['project-connectors.json'], {
    projects: {
      'C:/a': { off: ['gmail-2'] },
      'C:/b': { off: ['gmail', 'gmail-2', 'gmail-3'] },
      'C:/c': { off: ['notes'] },
    },
  });
  put(['hooks.json'], {
    hooks: {
      PreToolUse: [
        {
          matcher: 'mcp__gmail-2__send_email|Bash',
          hooks: [
            { type: 'mcp_tool', server: 'gmail-2', tool: 'audit' },
            { type: 'mcp_tool', server: 'notes', tool: 'audit' },
          ],
        },
        { matcher: 'mcp__gmail-20__x', hooks: [] },
      ],
    },
  });

  const h = harness(t, {
    dataDir,
    initial: {
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': legacyAppPassword('gmail-2', OTHER),
      'gmail-3': legacyAppPassword('gmail-3', 'team@gmail.com'),
    },
  });
  h.api.migrateConnectorAccounts();

  // Off only when every merged server was off for the agent; the key is gone otherwise.
  assert.deepEqual(read('agents', 'one-off', 'agent.json'), { name: 'One off' });
  assert.deepEqual(read('agents', 'all-off', 'agent.json').connectors, { off: ['gmail', 'notes'] });
  // Per-tool entries move to the surviving name; on a conflict the more permissive wins
  // (as "on beats off" does for the server); other servers keep theirs.
  assert.deepEqual(read('agents', 'tools', 'agent.json').connectors, {
    off: [],
    tools: {
      gmail: { send_email: 'auto', read_email: 'needs_approval', delete_email: 'disabled' },
      notes: { write: 'auto' },
    },
  });
  // What a switched-off server held was dormant and does not come alive with the merge.
  assert.deepEqual(read('agents', 'dormant', 'agent.json').connectors, {
    off: [],
    tools: { gmail: { send_email: 'needs_approval' } },
  });
  assert.deepEqual(read('agents', 'legacy', 'agent.json').connectors, [
    { id: 'gmail', enabled: true, tools: { send_email: 'auto' } },
    { id: 'notes', enabled: true },
  ]);
  assert.deepEqual(read('bots', 'robot', 'agent.json'), { route: { provider: 'p', model: 'm' } });
  assert.deepEqual(read('project-connectors.json'), {
    projects: { 'C:/b': { off: ['gmail'] }, 'C:/c': { off: ['notes'] } },
  });
  const hooks = read('hooks.json').hooks.PreToolUse;
  assert.equal(hooks[0].matcher, 'mcp__gmail__send_email|Bash');
  assert.deepEqual(
    hooks[0].hooks.map((hook) => hook.server),
    ['gmail', 'notes']
  );
  assert.equal(hooks[1].matcher, 'mcp__gmail-20__x', 'a longer name is not a merged one');
  // No key names a merged-away server anywhere.
  for (const file of [
    ['agents', 'one-off', 'agent.json'],
    ['agents', 'all-off', 'agent.json'],
    ['agents', 'tools', 'agent.json'],
    ['agents', 'dormant', 'agent.json'],
    ['agents', 'legacy', 'agent.json'],
    ['bots', 'robot', 'agent.json'],
    ['project-connectors.json'],
  ]) {
    assert.doesNotMatch(raw(...file), /gmail-[23]/, file.join('/'));
  }
  assert.equal(raw('agents', 'untouched', 'agent.json').includes('"notes"'), true);

  // Idempotent: the same merge applied again rewrites nothing.
  const snapshot = [
    'agents/one-off',
    'agents/all-off',
    'agents/tools',
    'agents/dormant',
    'agents/legacy',
    'agents/untouched',
    'bots/robot',
  ]
    .map((dir) => raw(...dir.split('/'), 'agent.json'))
    .concat(raw('project-connectors.json'), raw('hooks.json'));
  const again = migrateMergedConnectorServers(dataDir, [
    { connector: 'gmail', name: 'gmail', from: ['gmail', 'gmail-2', 'gmail-3'] },
  ]);
  assert.deepEqual(again, { agents: [], projects: [], hooks: [], failed: [] });
  assert.deepEqual(
    [
      'agents/one-off',
      'agents/all-off',
      'agents/tools',
      'agents/dormant',
      'agents/legacy',
      'agents/untouched',
      'bots/robot',
    ]
      .map((dir) => raw(...dir.split('/'), 'agent.json'))
      .concat(raw('project-connectors.json'), raw('hooks.json')),
    snapshot
  );
  assert.deepEqual(h.api.migrateConnectorAccounts(), []);
});

test('a store that fails to migrate stays pending and is retried on the next start, the others still migrate', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'connector-merge-retry-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(join(dataDir, ...path.slice(0, -1)), { recursive: true });
    writeFileSync(join(dataDir, ...path), text);
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const read = (...path) => JSON.parse(readFileSync(join(dataDir, ...path), 'utf8'));
  const pending = join(dataDir, PENDING_MERGE_FILE);
  const exists = (path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  };

  put(['agents', 'ok', 'agent.json'], json({ connectors: { off: ['gmail-3'] } }));
  // Its write fails: a non-empty directory sits where the backup copy goes.
  put(
    ['agents', 'blocked', 'agent.json'],
    json({ connectors: { off: ['gmail-2'], tools: { 'gmail-2': { send: 'auto' } } } })
  );
  put(['agents', 'blocked', 'agent.json.bak', 'keep'], 'x');
  // Malformed now, fixed by the user later.
  put(['agents', 'broken', 'agent.json'], '{ not json');
  put(['hooks.json'], json({ hooks: { PreToolUse: [{ matcher: 'mcp__gmail-3__send', hooks: [] }] } }));

  const h = harness(t, {
    dataDir,
    initial: {
      gmail: legacyAppPassword('gmail', EMAIL),
      'gmail-2': legacyAppPassword('gmail-2', OTHER),
      'gmail-3': legacyAppPassword('gmail-3', 'team@gmail.com'),
    },
  });
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    h.api.migrateConnectorAccounts();
  } finally {
    process.stderr.write = origWrite;
  }
  // The config is merged for good, but the failed stores are remembered.
  assert.deepEqual(Object.keys(h.config().mcpServers), ['gmail']);
  assert.deepEqual(read('agents', 'ok', 'agent.json'), {}, 'an independent store migrated');
  assert.equal(read('hooks.json').hooks.PreToolUse[0].matcher, 'mcp__gmail__send');
  assert.deepEqual(read('agents', 'blocked', 'agent.json').connectors.off, ['gmail-2'], 'not migrated yet');
  assert.deepEqual(read(PENDING_MERGE_FILE), {
    merged: [{ name: 'gmail', from: ['gmail', 'gmail-2', 'gmail-3'] }],
  });

  // Fixed: the next start migrates them and clears the record.
  rmSync(join(dataDir, 'agents', 'blocked', 'agent.json.bak'), { recursive: true, force: true });
  writeFileSync(
    join(dataDir, 'agents', 'broken', 'agent.json'),
    json({ connectors: { off: ['gmail', 'gmail-2', 'gmail-3'] } })
  );
  assert.deepEqual(h.api.migrateConnectorAccounts(), []);
  assert.deepEqual(read('agents', 'blocked', 'agent.json'), {}, 'the retried write landed');
  assert.deepEqual(read('agents', 'broken', 'agent.json').connectors, { off: ['gmail'] });
  assert.equal(exists(pending), false, 'the record is cleared once everything migrated');
  const saves = h.seen.saves;
  h.api.migrateConnectorAccounts();
  assert.equal(h.seen.saves, saves);
});

test('merging keeps a disabled account off; a connector with every account off stays off and brings them back when enabled', () => {
  const oauth = { type: 'http', url: 'https://gmail.mixdog.invalid/mcp', connector: 'gmail' };
  const mixed = mergeConnectorAccountServers({
    gmail: oauth,
    'gmail-2': { ...legacyAppPassword('gmail-2', OTHER), enabled: false },
  }).servers.gmail;
  assert.equal(mixed.enabled, undefined);
  assert.deepEqual(
    mixed.accounts.map((account) => [account.name, account.enabled]),
    [
      ['gmail', undefined],
      ['gmail-2', false],
    ]
  );
  // An account that is already off in a stored accounts server stays off.
  const stored = mergeConnectorAccountServers({
    gmail: { ...mixed, accounts: [mixed.accounts[0], { ...mixed.accounts[1], enabled: false }] },
    'gmail-3': legacyAppPassword('gmail-3', 'team@gmail.com'),
  }).servers.gmail;
  assert.deepEqual(
    stored.accounts.map((account) => [account.name, account.enabled]),
    [
      ['gmail', undefined],
      ['gmail-2', false],
      ['gmail-3', undefined],
    ]
  );
  // Every server off: the connector is off and no account is flagged.
  const off = mergeConnectorAccountServers({
    gmail: { ...oauth, enabled: false },
    'gmail-2': { ...legacyAppPassword('gmail-2', OTHER), enabled: false },
  }).servers.gmail;
  assert.equal(off.enabled, false);
  assert.deepEqual(
    off.accounts.map((account) => account.enabled),
    [undefined, undefined]
  );
  // Every account of a stored server off: the connector is off.
  const none = mergeConnectorAccountServers({
    gmail: { ...mixed, accounts: mixed.accounts.map((account) => ({ ...account, enabled: false })) },
    'gmail-3': { ...legacyAppPassword('gmail-3', 'team@gmail.com'), enabled: false },
  }).servers.gmail;
  assert.equal(none.enabled, false);
});

test('migration reports an unreadable agents directory and keeps the mapping pending; a missing one completes', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'connector-merge-readdir-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const merged = [{ connector: 'gmail', name: 'gmail', from: ['gmail', 'gmail-2'] }];
  const pending = join(dataDir, PENDING_MERGE_FILE);
  const refuse = (code) => () => {
    throw Object.assign(new Error(`${code}: cannot list`), { code });
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let denied;
  try {
    denied = migrateMergedConnectorServers(dataDir, merged, { readdir: refuse('EACCES') });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.deepEqual(denied.failed, [join(dataDir, 'agents'), join(dataDir, 'bots')]);
  assert.deepEqual(JSON.parse(readFileSync(pending, 'utf8')), {
    merged: [{ name: 'gmail', from: ['gmail', 'gmail-2'] }],
  });

  // The next start finds no such directory: nothing to migrate, record cleared.
  const missing = migrateMergedConnectorServers(dataDir, [], { readdir: refuse('ENOENT') });
  assert.deepEqual(missing.failed, []);
  assert.throws(() => readFileSync(pending), { code: 'ENOENT' });
});

/** A Gmail connector server over `accounts`, and a harness that records every connect it is asked for. */
function accountsHarness(t, accounts) {
  const connects = [];
  const h = harness(t, {
    initial: { gmail: { type: 'http', url: connectorAccountsUrl('gmail'), connector: 'gmail', accounts } },
    connect: async (options) => {
      connects.push(options);
      return { servers: [] };
    },
  });
  const server = () => h.config().mcpServers.gmail;
  return {
    ...h,
    connects,
    server,
    flags: () => server().accounts.map((account) => account.enabled),
    live: () => connectorLiveAccountServers(server()).map((account) => account.name),
    rowFlags: () =>
      h.glue
        .mcpStatus()
        .servers.find((row) => row.name === 'gmail')
        .accounts.map((row) => row.enabled),
  };
}

test('an account turns on and off by its own flag and its server reconnects; the connector toggle and edits leave the flags alone', async (t) => {
  const THIRD = 'team@gmail.com';
  const h = accountsHarness(t, [
    appPasswordAccount('gmail', EMAIL),
    { ...appPasswordAccount('gmail-2', OTHER), enabled: false },
    appPasswordAccount('gmail-3', THIRD),
  ]);
  assert.deepEqual(h.rowFlags(), [undefined, false, undefined]);

  // Editing a disabled account never turns it on.
  await h.api.saveMcpServer({
    ...gmailAppPasswordServerInput('gmail-2', OTHER, OTHER_PASSWORD),
    originalName: 'gmail-2',
  });
  assert.deepEqual(h.flags(), [undefined, false, undefined]);
  assert.deepEqual(h.live(), ['gmail', 'gmail-3']);

  // Turning it on drops its flag and reconnects the server, which now connects it.
  h.connects.length = 0;
  await h.api.setMcpServerEnabled('gmail-2', true);
  assert.deepEqual(h.flags(), [undefined, undefined, undefined]);
  assert.equal(h.server().enabled, true);
  assert.deepEqual(h.live(), ['gmail', 'gmail-2', 'gmail-3']);
  assert.deepEqual(h.rowFlags(), [undefined, undefined, undefined]);
  assert.deepEqual(h.connects, [{ only: 'gmail', enabled: true }]);

  // Turning it off flags that account only; the server stays on and reconnects without it.
  h.connects.length = 0;
  await h.api.setMcpServerEnabled('gmail-2', false);
  assert.deepEqual(h.flags(), [undefined, false, undefined]);
  assert.equal(h.server().enabled, true);
  assert.deepEqual(h.live(), ['gmail', 'gmail-3']);
  assert.deepEqual(h.rowFlags(), [undefined, false, undefined]);
  assert.deepEqual(h.connects, [{ only: 'gmail', enabled: true }]);

  // The connector itself switches as before and every account keeps its own flag.
  h.connects.length = 0;
  await h.api.setMcpServerEnabled('gmail', false);
  assert.equal(h.server().enabled, false);
  assert.deepEqual(h.flags(), [undefined, false, undefined]);
  await h.api.setMcpServerEnabled('gmail', true);
  assert.equal(h.server().enabled, true);
  assert.deepEqual(h.flags(), [undefined, false, undefined]);
  assert.deepEqual(h.connects, [
    { only: 'gmail', enabled: false },
    { only: 'gmail', enabled: true },
  ]);

  // Turning on an account of a turned-off connector turns the connector on with it.
  await h.api.setMcpServerEnabled('gmail', false);
  await h.api.setMcpServerEnabled('gmail-3', true);
  assert.equal(h.server().enabled, true);
  assert.deepEqual(h.flags(), [undefined, false, undefined]);
});

test('the account that shares its server’s name turns on with that name; turning it off is turning off the connector', async (t) => {
  const h = accountsHarness(t, [
    { ...appPasswordAccount('gmail', EMAIL), enabled: false },
    appPasswordAccount('gmail-2', OTHER),
  ]);
  assert.deepEqual(h.live(), ['gmail-2']);

  await h.api.setMcpServerEnabled('gmail', true);
  assert.deepEqual(h.flags(), [undefined, undefined]);
  assert.deepEqual(h.live(), ['gmail', 'gmail-2']);

  await h.api.setMcpServerEnabled('gmail', false);
  assert.equal(h.server().enabled, false);
  assert.deepEqual(h.flags(), [undefined, undefined]);
});

test('turning off the last live account turns its server off, and turning an account on turns it back on', async (t) => {
  const h = accountsHarness(t, [
    { ...appPasswordAccount('gmail', EMAIL), enabled: false },
    appPasswordAccount('gmail-2', OTHER),
  ]);
  await h.api.setMcpServerEnabled('gmail-2', false);
  assert.equal(h.server().enabled, false);
  assert.deepEqual(h.flags(), [false, false]);
  assert.deepEqual(h.connects, [{ only: 'gmail', enabled: false }]);

  await h.api.setMcpServerEnabled('gmail-2', true);
  assert.equal(h.server().enabled, true);
  assert.deepEqual(h.flags(), [false, undefined]);
  assert.deepEqual(h.live(), ['gmail-2']);
  assert.deepEqual(h.connects.at(-1), { only: 'gmail', enabled: true });
});

test('hook migration renames tool identifiers only, never argument conditions or other data', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'connector-merge-hooks-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'hooks'), { recursive: true });
  writeFileSync(
    join(dataDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo mcp__gmail-2__x', if: 'Bash(mcp__gmail-2__*)' }],
          },
          {
            matcher: 'mcp__gmail-2__send_email|Bash',
            hooks: [
              { type: 'mcp_tool', server: 'gmail-2', tool: 'audit', input: { note: 'mcp__gmail-2__x' } },
              { type: 'command', command: 'check', if: 'mcp__gmail-2__send_email(to=*)' },
            ],
          },
        ],
      },
    })
  );
  writeFileSync(
    join(dataDir, 'hooks', 'hooks.json'),
    JSON.stringify([
      { tool: 'mcp__gmail-2__send_email', action: 'deny', match: 'mcp__gmail-2__', reason: 'mcp__gmail-2__' },
    ])
  );
  const outcome = migrateMergedConnectorServers(dataDir, [
    { connector: 'gmail', name: 'gmail', from: ['gmail', 'gmail-2'] },
  ]);
  assert.deepEqual(outcome.failed, []);
  const [bashGroup, mcpGroup] = JSON.parse(readFileSync(join(dataDir, 'hooks.json'), 'utf8')).hooks.PreToolUse;
  assert.deepEqual(bashGroup.hooks[0], {
    type: 'command',
    command: 'echo mcp__gmail-2__x',
    if: 'Bash(mcp__gmail-2__*)',
  });
  assert.equal(mcpGroup.matcher, 'mcp__gmail__send_email|Bash');
  assert.deepEqual(mcpGroup.hooks[0], {
    type: 'mcp_tool',
    server: 'gmail',
    tool: 'audit',
    input: { note: 'mcp__gmail-2__x' },
  });
  assert.equal(mcpGroup.hooks[1].if, 'mcp__gmail__send_email(to=*)', 'the tool part of a condition moves');
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'hooks', 'hooks.json'), 'utf8')), [
    { tool: 'mcp__gmail__send_email', action: 'deny', match: 'mcp__gmail-2__', reason: 'mcp__gmail-2__' },
  ]);
});
