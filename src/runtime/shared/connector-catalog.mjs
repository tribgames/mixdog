// The built-in connector catalog: services a user connects with one click
// from Desktop (Extensions → 커넥터) or from a chat card the setup tool's
// `connect_connector` action surfaces. Each entry declares its backend
// explicitly:
//   oauth   — a remote MCP server that signs in with MCP OAuth;
//   apiKey  — an MCP server that takes one key (an HTTP header or a stdio
//             environment variable).
// GitHub is not a connector: it is the signed-in GitHub CLI (github tool).
// A connected catalog service is an ordinary user MCP server whose config
// carries `connector: <id>`. An existing custom server is never adopted into
// the catalog row.

import { connectorTrigger } from './connector-triggers.mjs';

// `oauthClient` names a pre-registered client the runtime supplies
// (mcp/oauth-client.mjs: 'google') in place of dynamic client registration;
// `scopes` are then the ones requested.
const oauth = (url, client = {}) => Object.freeze({ kind: 'oauth', url, ...client });

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth';
// The Google access each built-in connector asks for: the one place to widen
// it (e.g. gmail.readonly). openid + email name the signed-in account.
export const GOOGLE_SCOPES = Object.freeze({
  gmail: Object.freeze(['openid', 'email', `${GOOGLE_SCOPE}/gmail.send`]),
  calendar: Object.freeze(['openid', 'email', `${GOOGLE_SCOPE}/calendar.events`]),
  drive: Object.freeze(['openid', 'email', `${GOOGLE_SCOPE}/drive.file`]),
});
// Gmail / Calendar / Drive are Mixdog's built-in Google connectors
// (runtime/connectors/google-mcp.mjs), answered in-process at a reserved
// address and signed in with Mixdog's Google client. `askTools` ask before
// they run unless the agent set them.
const google = (service, scopes, askTools) =>
  oauth(`https://${service}.mixdog.invalid/mcp`, { oauthClient: 'google', scopes, askTools });
// Gmail can also connect with a Google app password instead of the sign-in:
// IMAP and SMTP over TLS (runtime/connectors/gmail-app-password.mjs), answered
// in-process at its own reserved address. Its server is still the Gmail
// connector (`connector: 'gmail'`, so Gmail's askTools apply to its tools of
// the same names); the account rides in a header, the app password lives only
// in the keychain.
export const GMAIL_APP_PASSWORD = Object.freeze({
  url: 'https://gmail-imap.mixdog.invalid/mcp',
  accountHeader: 'X-Mixdog-Gmail-Account',
  helpUrl: 'https://myaccount.google.com/apppasswords',
});
const apiKey = (spec) => Object.freeze({ kind: 'apiKey', ...spec });

export const CONNECTOR_CATALOG = Object.freeze(
  [
    { id: 'airtable', name: 'Airtable', backend: oauth('https://mcp.airtable.com/mcp') },
    { id: 'confluence', name: 'Confluence', backend: oauth('https://mcp.atlassian.com/v1/mcp/authv2') },
    { id: 'dropbox', name: 'Dropbox', backend: oauth('https://mcp.dropbox.com/mcp') },
    {
      id: 'gmail',
      name: 'Gmail',
      backend: google('gmail', GOOGLE_SCOPES.gmail, ['send_email']),
      // New Gmail connections use an app password only (GMAIL_APP_PASSWORD);
      // a Gmail server already on the Google sign-in keeps working.
      appPasswordOnly: true,
    },
    {
      id: 'google-calendar',
      name: 'Google Calendar',
      backend: google('calendar', GOOGLE_SCOPES.calendar, ['delete_event']),
    },
    {
      id: 'google-drive',
      name: 'Google Drive',
      backend: google('drive', GOOGLE_SCOPES.drive, []),
    },
    {
      id: 'hugging-face',
      name: 'Hugging Face',
      backend: apiKey({
        url: 'https://huggingface.co/mcp',
        header: 'Authorization',
        prefix: 'Bearer ',
        keyUrl: 'https://huggingface.co/settings/tokens',
      }),
    },
    { id: 'jira', name: 'Jira', backend: oauth('https://mcp.atlassian.com/v1/mcp/authv2') },
    { id: 'linear', name: 'Linear', backend: oauth('https://mcp.linear.app/mcp') },
    { id: 'notion', name: 'Notion', backend: oauth('https://mcp.notion.com/mcp') },
    {
      id: 'postgres',
      name: 'Postgres',
      backend: apiKey({
        command: 'npx',
        args: ['-y', '@microsoft/postgres-mcp@0.2.0', 'run'],
        env: 'POSTGRES_MCP_CONNECTION_STRING',
        keyUrl: 'https://github.com/microsoft/postgres-mcp/blob/main/USAGE.md',
        placeholder: 'postgresql://user:password@host:5432/db',
      }),
    },
    { id: 'sentry', name: 'Sentry', backend: oauth('https://mcp.sentry.dev/mcp') },
    {
      id: 'stripe',
      name: 'Stripe',
      backend: apiKey({
        url: 'https://mcp.stripe.com',
        header: 'Authorization',
        prefix: 'Bearer ',
        keyUrl: 'https://dashboard.stripe.com/apikeys',
        placeholder: 'rk_live_…',
      }),
    },
    { id: 'supabase', name: 'Supabase', backend: oauth('https://mcp.supabase.com/mcp') },
    { id: 'trello', name: 'Trello', backend: oauth('https://mcp.trello.com/v1') },
    { id: 'vercel', name: 'Vercel', backend: oauth('https://mcp.vercel.com') },
    // The ids are the deferred-tool manifest's curated keys: a server named by
    // its id gets that one-line trigger (connector-triggers.mjs).
  ].map((entry) => Object.freeze({ ...entry, trigger: connectorTrigger(entry.id) }))
);

/** The ids the setup tool's `connect_connector` offers: the whole catalog. */
export const CONNECTOR_IDS = Object.freeze(CONNECTOR_CATALOG.map((entry) => entry.id));

/** The catalog entry for `id`, or null. */
export function connectorById(id) {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) || null;
}

const urlKey = (url) =>
  String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();

/** The catalog id a configured MCP server connects: its `connector` marker,
 *  '' for none (or a marker the catalog no longer knows). */
export function connectorOfServer(cfg) {
  const marker = typeof cfg?.connector === 'string' ? cfg.connector : '';
  return connectorById(marker) ? marker : '';
}

/** The permission a catalog connector's tool has when nothing set its own:
 *  `needs_approval` for the high-risk tools it names, else `auto`. */
export function connectorToolDefault(connectorId, tool) {
  const backend = connectorById(connectorId)?.backend;
  return backend?.askTools?.includes(tool) ? 'needs_approval' : 'auto';
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+$/;

/** A Gmail address as typed (trimmed, lowercased), or '' when it is none. */
export function gmailAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase();
  return EMAIL.test(address) ? address : '';
}

/** A Google app password as typed, its spaces removed; '' unless it then
 *  has the 16 characters Google issues. */
export function gmailAppPasswordValue(value) {
  const password = String(value ?? '').replace(/\s+/g, '');
  return password.length === 16 ? password : '';
}

/** The account of a Gmail app-password server config, '' for any other. */
export function gmailAppPasswordAccount(cfg) {
  if (urlKey(cfg?.url) !== urlKey(GMAIL_APP_PASSWORD.url)) return '';
  const headers = cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
  const header = GMAIL_APP_PASSWORD.accountHeader.toLowerCase();
  const key = Object.keys(headers).find((name) => name.toLowerCase() === header);
  return key ? gmailAddress(headers[key]) : '';
}

/** The MCP server input that connects Gmail under `name` as `email` with an
 *  app password. `appPassword` only travels to the host, which checks it
 *  with Gmail and keeps it in the keychain; it never reaches the config. */
export function gmailAppPasswordServerInput(name, email, password) {
  const address = gmailAddress(email);
  if (!address) throw new Error('GMAIL_APP_PASSWORD_ADDRESS: Enter a Gmail address.');
  const appPassword = gmailAppPasswordValue(password);
  if (!appPassword) throw new Error('GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.');
  return {
    name,
    type: 'http',
    url: GMAIL_APP_PASSWORD.url,
    headers: { [GMAIL_APP_PASSWORD.accountHeader]: address },
    connector: 'gmail',
    appPassword,
  };
}

/** Whether several accounts of catalog connector `entry` can be connected at
 *  once: every catalog connector holds its accounts in one server. */
export function connectorMultiAccount(entry) {
  return Boolean(entry?.id) && connectorById(entry.id) === entry;
}

// ── One server per connector ────────────────────────────────────────────────
// A catalog connector is ONE MCP server (`gmail`, `notion`, `postgres`…)
// holding its accounts:
//   { type: 'http', url: connectorAccountsUrl(id), connector: id,
//     accounts: [{ name, type?, url?, headers?, oauthClientId?, oauthKey?,
//                  command?, args?, env? }, …] }
// Each account keeps the transport it had as a server of its own (its remote
// URL and sign-in, its key header, its app-password address, or its local
// command and environment), so its keychain entries are untouched. A remote
// sign-in is stored under the account's URL, or under its own `oauthKey` when
// another account of the connector already signs in at that URL. Account names
// share the server-name space (`notion`, `notion-2`…): a name-based call
// (remove, sign in, sign out) that names an account acts on that account. The
// server is answered in-process (connectors/connector-accounts-mcp.mjs): one
// tool set with an `account` argument.
const ACCOUNT_FIELDS = ['type', 'url', 'headers', 'oauthClientId', 'oauthKey', 'command', 'args', 'env'];

/** The reserved (never resolvable) address of connector `id`'s accounts server. */
export function connectorAccountsUrl(id) {
  return `https://connectors.mixdog.invalid/${encodeURIComponent(id)}/mcp`;
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The stored accounts of a connector server, [] for any other config (a
 *  legacy one-account server included). */
export function connectorAccountsOf(cfg) {
  if (!isRecord(cfg) || !Array.isArray(cfg.accounts) || !connectorOfServer(cfg)) return [];
  return cfg.accounts.filter(
    (account) =>
      isRecord(account) &&
      typeof account.name === 'string' &&
      account.name &&
      (typeof account.url === 'string' || typeof account.command === 'string')
  );
}

/** The one-account server config of `account` of server `cfg` (the shape the
 *  account had as a server of its own), named by the account. */
export function connectorAccountServer(cfg, account) {
  const out = { name: account.name, type: 'http' };
  for (const field of ACCOUNT_FIELDS) if (account[field] !== undefined) out[field] = account[field];
  out.connector = cfg.connector;
  return out;
}

/** `cfg` without what is an account's own connection: the settings of the
 *  server holding its accounts (timeouts, enabled…). */
export function connectorServerSettings(cfg) {
  return Object.fromEntries(Object.entries(cfg).filter(([key]) => key !== 'accounts' && !ACCOUNT_FIELDS.includes(key)));
}

/** Every account of `cfg` as its one-account server config. */
export function connectorAccountServers(cfg) {
  return connectorAccountsOf(cfg).map((account) => connectorAccountServer(cfg, account));
}

/** Whether stored account `account` is switched on (`enabled: false` is off). */
export const connectorAccountEnabled = (account) => account.enabled !== false;

/** The switched-on accounts of `cfg` as their one-account server configs: the
 *  ones the server connects and routes calls to. */
export function connectorLiveAccountServers(cfg) {
  return connectorAccountsOf(cfg)
    .filter(connectorAccountEnabled)
    .map((account) => connectorAccountServer(cfg, account));
}

/**
 * Server `cfg` with its account `name` switched on or off. Off flags the
 * account (`enabled: false`) and switches the server off with its last
 * switched-on account. On drops the flag (a switched-on account carries none)
 * and switches the server on. Every other entry stays as stored.
 */
export function withConnectorAccountEnabled(cfg, name, enabled) {
  const accounts = cfg.accounts.map((account) => {
    if (!isRecord(account) || account.name !== name) return account;
    const { enabled: _enabled, ...rest } = account;
    return enabled ? rest : { ...rest, enabled: false };
  });
  const next = { ...cfg, accounts };
  if (enabled) return { ...next, enabled: true };
  return connectorAccountsOf(next).some(connectorAccountEnabled) ? next : { ...next, enabled: false };
}

/** The stored account entry of one-account config `cfg` under `name` (an
 *  http transport is the default and is not stored). */
export function connectorAccountEntry(name, cfg) {
  const out = { name };
  for (const field of ACCOUNT_FIELDS) if (cfg?.[field] !== undefined) out[field] = cfg[field];
  if (out.type === 'http') delete out.type;
  return out;
}

const naturalOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** What makes an account the same connection as another: its transport
 *  (URL, sign-in key, headers, command and environment), whatever its name. */
const connectionOf = (cfg, account) => JSON.stringify({ ...connectorAccountServer(cfg, account), name: '' });

/**
 * Merges every catalog connector's servers into one server holding the
 * accounts: legacy one-account servers (`notion`, `notion-2`…, Gmail, Calendar
 * and Drive alike) and any second accounts server. The server keeps the name
 * of an existing accounts server, else the connector id when a server has it,
 * else the first name; its other fields come from that server. Accounts keep
 * their names, transports and order (that server's first); a second entry
 * for the same name, app-password address or connection is dropped. The
 * merged server is off only when every merged one was; otherwise the accounts
 * of a merged server that was off stay off (`enabled: false` on the account),
 * and an account's own `enabled: false` is kept. A server left with no
 * switched-on account is off. Idempotent: `merged` is empty when nothing
 * changed. Returns `{ servers, merged: [{ connector, name, from }] }`.
 */
export function mergeConnectorAccountServers(input) {
  const servers = isRecord(input) ? { ...input } : {};
  const merged = [];
  for (const entry of CONNECTOR_CATALOG) {
    const names = Object.keys(servers)
      .filter((name) => isRecord(servers[name]) && connectorOfServer(servers[name]) === entry.id)
      .sort(naturalOrder);
    if (!names.length) continue;
    const grouped = names.filter((name) => Array.isArray(servers[name].accounts));
    if (names.length === 1 && grouped.length === 1) continue;
    const target = grouped[0] ?? (names.includes(entry.id) ? entry.id : names[0]);
    const order = [target, ...names.filter((name) => name !== target)];
    const off = order.every((name) => input[name].enabled === false);
    const accounts = [];
    const seenNames = new Set();
    const seenAddresses = new Set();
    const seenConnections = new Set();
    for (const name of order) {
      const cfg = servers[name];
      const own = Array.isArray(cfg.accounts) ? connectorAccountsOf(cfg) : [connectorAccountEntry(name, cfg)];
      // A merged server that was off keeps its accounts off, unless the whole
      // connector is off (then re-enabling it brings every account back).
      const serverOff = !off && cfg.enabled === false;
      for (const account of own) {
        const address = gmailAppPasswordAccount(connectorAccountServer(cfg, account));
        const connection = connectionOf(cfg, account);
        if (seenNames.has(account.name) || (address && seenAddresses.has(address)) || seenConnections.has(connection)) {
          continue;
        }
        seenNames.add(account.name);
        if (address) seenAddresses.add(address);
        seenConnections.add(connection);
        accounts.push(serverOff ? { ...account, enabled: false } : account);
      }
    }
    const { enabled: _enabled, ...rest } = connectorServerSettings(servers[target]);
    for (const name of order) delete servers[name];
    servers[target] = {
      ...rest,
      type: 'http',
      url: connectorAccountsUrl(entry.id),
      connector: entry.id,
      accounts,
      ...(off || (accounts.length > 0 && !accounts.some(connectorAccountEnabled)) ? { enabled: false } : {}),
    };
    merged.push({ connector: entry.id, name: target, from: order });
  }
  return { servers, merged };
}

/** Whether a new connection of `entry` goes by app password only (Gmail). */
export function connectorAppPasswordOnly(entry) {
  return entry?.appPasswordOnly === true;
}

/** Whether `entry` signs in with Mixdog's built-in Google client (or the
 *  user's own Google client in its place). */
export function connectorUsesGoogleClient(entry) {
  return entry?.backend?.kind === 'oauth' && entry.backend.oauthClient === 'google';
}

/** The MCP server input that connects catalog entry `entry` under `name`
 *  (oauth / apiKey); `key` fills an apiKey backend. Every account keeps the
 *  service's real URL; another account at that URL gets its own sign-in key
 *  (resource-mcp-connector-accounts.mjs). */
export function connectorServerInput(entry, name, key = '') {
  const { backend } = entry;
  if (backend.kind === 'oauth') return { name, type: 'http', url: backend.url, connector: entry.id };
  if (backend.kind !== 'apiKey') throw new Error(`${entry.name} is not an MCP connector`);
  const value = String(key || '').trim();
  if (!value) throw new Error(`${entry.name} needs a key`);
  if (backend.url) {
    return {
      name,
      type: 'http',
      url: backend.url,
      headers: { [backend.header]: `${backend.prefix || ''}${value}` },
      connector: entry.id,
    };
  }
  return {
    name,
    type: 'stdio',
    command: backend.command,
    args: [...backend.args],
    env: { [backend.env]: value },
    connector: entry.id,
  };
}
