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
 *  once: Gmail (also by app password), Calendar and Drive with the Google
 *  sign-in. Other remote servers keep one (their tokens and URL are shared). */
export function connectorMultiAccount(entry) {
  return entry?.backend?.kind === 'oauth' && entry.backend.oauthClient === 'google';
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
 *  (oauth / apiKey); `key` fills an apiKey backend; `extraAccount`
 *  makes it one more account of a multi-account connector. */
export function connectorServerInput(entry, name, key = '', { extraAccount = false } = {}) {
  const { backend } = entry;
  if (backend.kind === 'oauth') {
    // Tokens are stored per exact server URL, so another account of the same
    // connector needs its own URL; the in-process Google servers ignore the query.
    const url =
      extraAccount && connectorMultiAccount(entry) ? `${backend.url}?account=${encodeURIComponent(name)}` : backend.url;
    return { name, type: 'http', url, connector: entry.id };
  }
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
