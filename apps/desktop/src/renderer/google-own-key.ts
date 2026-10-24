// "내 Google 키 사용": the user's own Google OAuth client for Gmail, Calendar
// and Drive, as a fallback when Mixdog's shared client is full. The downloaded
// client_secret_*.json is parsed here; the secret goes to the host only in the
// apply call (saveMcpServer → keychain), never into config or renderer state.
import { CONNECTOR_CATALOG, connectorServerInput } from '../../../../src/runtime/shared/connector-catalog.mjs';
import { uniqueServerName } from './connectors-model';

export interface GoogleOwnKey {
  clientId: string;
  clientSecret: string;
}

type Invoke = (capability: string, args?: unknown[]) => Promise<unknown>;
type Row = Record<string, unknown>;

// Calendar and Drive: the Google sign-in connectors the user's own key covers.
const GOOGLE_ENTRIES = CONNECTOR_CATALOG.filter((entry: { id: string }) =>
  ['google-calendar', 'google-drive'].includes(entry.id)
);

/** The client id and secret of a Google `client_secret_*.json` (Desktop app).
 *  Throws an Error with a user-facing message for anything else. */
export function parseGoogleClientJson(source: string): GoogleOwnKey {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error('This is not a JSON file.');
  }
  const root = json && typeof json === 'object' ? (json as Row) : {};
  const client = root.installed && typeof root.installed === 'object' ? (root.installed as Row) : null;
  if (!client) throw new Error('This is not a Desktop app OAuth client file (no "installed" section).');
  const clientId = typeof client.client_id === 'string' ? client.client_id.trim() : '';
  const clientSecret = typeof client.client_secret === 'string' ? client.client_secret.trim() : '';
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
    throw new Error('The file has no valid client_id and client_secret.');
  }
  return { clientId, clientSecret };
}

/** The Google connector servers that exist, by catalog id. */
async function googleServers(invoke: Invoke) {
  const status = ((await invoke('mcpStatus')) as Row | undefined) ?? {};
  const servers = Array.isArray(status.servers) ? (status.servers as Row[]) : [];
  return { servers, byId: (id: string) => servers.find((s) => s.connector === id && s.source !== 'plugin') };
}

/** Gives all three Google connectors `key` (creating missing servers) and
 *  forgets their stored sign-ins so the next connect uses the new client.
 *  With `newAccountOf` (a catalog id) it instead adds ONE more account of that
 *  connector on `key` and touches no existing server; resolves its name. */
export async function applyGoogleOwnKey(invoke: Invoke, key: GoogleOwnKey, newAccountOf = ''): Promise<string> {
  const { servers, byId } = await googleServers(invoke);
  const taken = servers.map((s) => String(s.name));
  const own = { oauthClientId: key.clientId, oauthClientSecret: key.clientSecret };
  const extra = GOOGLE_ENTRIES.find((entry: { id: string }) => entry.id === newAccountOf);
  if (extra) {
    const name = uniqueServerName(extra.id, taken);
    await invoke('addMcpServer', [
      { ...connectorServerInput(extra, name, '', { extraAccount: Boolean(byId(extra.id)) }), ...own },
    ]);
    return name;
  }
  for (const entry of GOOGLE_ENTRIES) {
    const existing = byId(entry.id);
    if (!existing) {
      const name = uniqueServerName(entry.id, taken);
      taken.push(name);
      await invoke('addMcpServer', [{ ...connectorServerInput(entry, name), ...own }]);
      continue;
    }
    const name = String(existing.name);
    await invoke('signOutMcpServer', [name]);
    await invoke('saveMcpServer', [{ name, originalName: name, ...own }]);
  }
  return '';
}

/** Back to Mixdog's built-in client: the id and the keychain secret go, and a
 *  server that never connected goes with them (its catalog row stays). */
export async function revertGoogleOwnKey(invoke: Invoke): Promise<void> {
  const { servers } = await googleServers(invoke);
  for (const existing of servers) {
    if (!GOOGLE_ENTRIES.some((entry: { id: string }) => entry.id === existing.connector)) continue;
    const name = String(existing.name);
    if (existing.connected !== true) {
      await invoke('removeMcpServer', [name]);
      continue;
    }
    await invoke('signOutMcpServer', [name]);
    await invoke('saveMcpServer', [{ name, originalName: name, oauthClientId: '' }]);
  }
}

/** Whether the server `name` runs on the user's own Google client. */
export async function usesGoogleOwnKey(invoke: Invoke, name: string): Promise<boolean> {
  const config = ((await invoke('getMcpServerConfig', [name])) as Row | undefined) ?? {};
  const inner = config.config && typeof config.config === 'object' ? (config.config as Row) : config;
  return typeof inner.oauthClientId === 'string' && inner.oauthClientId.trim() !== '';
}
