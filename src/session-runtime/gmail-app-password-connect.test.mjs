// A multi-account connector through the ordinary MCP server API: one server
// per connector (`gmail`) holding its accounts. Gmail's app password is
// checked before anything is saved, kept out of the config, replaces a Google
// sign-in, and leaves the keychain with its last account; another account
// joins the server, removing one leaves the others (and their credentials)
// alone; legacy one-account servers (`gmail`, `gmail-2`…) merge on load.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTOR_CATALOG,
  GMAIL_APP_PASSWORD,
  connectorAccountsUrl,
  connectorServerInput,
  gmailAppPasswordServerInput,
} from '../runtime/shared/connector-catalog.mjs';
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
    reject = null,
    oauthState = () => null,
    connect = async () => ({ servers: [] }),
    startSwitch = () => {
      throw new Error('no browser sign-in expected');
    },
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
    cfgMod: {},
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
    commitMcpServerOAuthSwitch: async () => async () => {},
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
        appPasswordAccount('gmail-2', OTHER),
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
  assert.deepEqual([...h.keychain], [
    [EMAIL, PASSWORD],
    [OTHER, OTHER_PASSWORD],
  ]);
  const again = await h.api.addMcpServer(gmailAppPasswordServerInput('gmail-3', 'WORK@gmail.com', PASSWORD));
  assert.deepEqual([again.name, again.account], ['gmail', 'gmail-2'], 'no duplicate account');
  assert.equal(h.config().mcpServers.gmail.accounts.length, 2);
  assert.equal(h.keychain.get(OTHER), PASSWORD, 'the new password replaced the old one');
  assert.equal(h.keychain.get(EMAIL), PASSWORD, 'the other account is untouched');
  // A name another account holds is never reused.
  await assert.rejects(h.api.addMcpServer({ name: 'gmail-2', type: 'http', url: 'https://example.com/mcp' }), /already exists/);
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
  assert.deepEqual(row.accounts.map((account) => account.name), ['google-calendar-2']);
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

test('a new connector server never takes a name an account of another connector has', async (t) => {
  const h = harness(t, {
    initial: { gmail: legacyAppPassword('gmail', EMAIL), 'gmail-2': legacyAppPassword('gmail-2', OTHER) },
  });
  h.api.migrateConnectorAccounts();
  await assert.rejects(h.api.addMcpServer(connectorServerInput(CALENDAR, 'gmail-2')), /already exists: gmail-2/);
  assert.equal(h.config().mcpServers['gmail-2'], undefined);
  assert.equal(h.config().mcpServers['google-calendar'], undefined, 'nothing was created');
  const made = await h.api.addMcpServer(connectorServerInput(CALENDAR, 'google-calendar'));
  assert.deepEqual([made.name, made.account], ['google-calendar', 'google-calendar']);
});

test('migration drops the settings of a merged-away server name; the server keeps its own', async (t) => {
  const h = harness(t, {
    initial: { gmail: legacyAppPassword('gmail', EMAIL), 'gmail-2': { ...legacyAppPassword('gmail-2', OTHER), enabled: false } },
    extra: { extensionScopes: { mcp: { 'gmail-2': ['C:/work'], gmail: ['C:/home'] } } },
  });
  h.api.migrateConnectorAccounts();
  assert.deepEqual(Object.keys(h.config().extensionScopes.mcp), ['gmail'], 'gmail-2’s scope is gone, gmail’s kept');
  // On/off is the server's: the formerly switched-off account is usable with it.
  assert.equal(h.config().mcpServers.gmail.enabled, undefined);
  assert.deepEqual(h.config().mcpServers.gmail.accounts, [
    appPasswordAccount('gmail', EMAIL),
    appPasswordAccount('gmail-2', OTHER),
  ]);
});
