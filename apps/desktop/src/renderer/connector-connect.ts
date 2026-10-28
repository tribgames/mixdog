// The one-click connect, shared by Extensions → 커넥터 and the chat connect
// card (the setup tool's `connect_connector`): create (or reuse) the catalog
// server, run the existing remote MCP OAuth flow in the browser, and report
// "connected" only once the host's MCP status says so. The state is keyed by
// server name, so a flow started in chat shows on the pane's row too.
import { useSyncExternalStore } from 'react';
import {
  connectorAppPasswordOnly,
  connectorMultiAccount,
  connectorUsesGoogleClient,
  connectorServerInput,
  gmailAddress,
  gmailAppPasswordServerInput,
  type ConnectorCatalogEntry,
} from '../../../../src/runtime/shared/connector-catalog.mjs';
import type { DesktopCapability } from '../shared/contract';
import { isSshConnectionWindow } from './desktop-connection';
import { errorMessage } from './editor-pane-session-errors';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { isRemoteHostRenderer } from './remote-ui-projection';
import {
  type ConnectorLoginMode,
  type ConnectorLoginPhase,
  PENDING_LOGIN_PHASES,
  connectorAccountRows,
} from './connectors-model';
import { isScopeNotGrantedError, mcpErrorSummary } from './settings/mcp-editor-dialog';
import { friendlyCapabilityError } from './settings/remote-capability-guard';

type Row = Record<string, unknown>;

/** Fired after a connect, disconnect or add changes the MCP list. */
export const CONNECTORS_CHANGED_EVENT = 'mixdog:connectors-changed';
/** Asks the app shell to open Extensions → 커넥터. */
export const OPEN_CONNECTORS_EVENT = 'mixdog:open-connectors';

export function openConnectorsTab(): void {
  window.dispatchEvent(new Event(OPEN_CONNECTORS_EVENT));
}

export type { ConnectorLoginMode, ConnectorLoginPhase } from './connectors-model';

export interface ConnectorLoginState {
  /** The server name ('' until a new catalog server is created). */
  name: string;
  /** The catalog id it connects, when it is a catalog service. */
  connector: string;
  /** What the toast and card call it (the service name). */
  label: string;
  phase: ConnectorLoginPhase;
  mode: ConnectorLoginMode;
  /** The OAuth flow record (flowId, url, state, step). */
  flow: Row | null;
  /** Sign-in away from the host: the redirect is pasted back. */
  remote: boolean;
  /** Why it failed, already in the user's language. */
  error: string;
  /** What kind of failure, from the host's raw error: `timeout` when nobody
   *  finished the sign-in page in time, `scopeNotGranted` when the provider
   *  left a requested access out. */
  reason: string;
}

// The longest a confirmed connection waits for a list that shows it
// (retireConnectorLogin); the row's highlight is its own.
const JUST_CONNECTED_MS = 10_000;
// The longest a host status read waits for the flow's next step.
const STATUS_WAIT_MS = 10_000;
const POLL_MS = 500;

// Keyed by server name, or `catalog:<id>` while a new catalog server is made.
const states = new Map<string, ConnectorLoginState>();
const PLACEHOLDER_PREFIX = 'catalog:';
const placeholderKey = (connector: string) => PLACEHOLDER_PREFIX + connector;
const listeners = new Set<() => void>();
const timers = new Map<string, number>();
// The flow each key currently follows; a newer one retires the older loop.
const following = new Map<string, string>();

function publish(key: string, next: ConnectorLoginState | null): void {
  if (next) states.set(key, next);
  else states.delete(key);
  for (const listener of listeners) listener();
}

function patch(key: string, change: Partial<ConnectorLoginState>): void {
  const current = states.get(key);
  if (current) publish(key, { ...current, ...change });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A catalog row finds its sign-in by service too: the server it creates is
// not in the row's list until the list re-reads.
function lookup(name: string, connector = ''): ConnectorLoginState | null {
  if (name && states.has(name)) return states.get(name) ?? null;
  if (!connector) return null;
  for (const state of states.values()) if (state.connector === connector) return state;
  return null;
}

/** The live sign-in of server `name`, or of catalog service `connector`
 *  before its server exists (null when none). */
export function useConnectorLogin(name: string, connector = ''): ConnectorLoginState | null {
  return useSyncExternalStore(
    subscribe,
    () => lookup(name, connector),
    () => null
  );
}

let snapshot: ConnectorLoginState[] = [];
listeners.add(() => {
  snapshot = [...states.values()];
});

/** Every live login (the remote paste dialogs read it). */
export function useConnectorLogins(): readonly ConnectorLoginState[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  );
}

export function connectorLoginState(name: string, connector = ''): ConnectorLoginState | null {
  return lookup(name, connector);
}

export async function invoke<T = unknown>(capability: string, args: unknown[] = []): Promise<T> {
  const api = window.mixdogDesktop;
  if (!api?.invokeCapability) throw new Error(t('This can only be managed on the host computer.'));
  try {
    const result = await api.invokeCapability<T>({ capability: capability as DesktopCapability, args });
    return result.value;
  } catch (reason) {
    throw friendlyCapabilityError(reason);
  }
}

export function announceConnectorsChanged(): void {
  window.dispatchEvent(new Event(CONNECTORS_CHANGED_EVENT));
}

/** The host's current MCP status rows, a multi-account connector's server as
 *  one row per account (connectorAccountRows). */
export async function readMcpStatus(): Promise<{ servers: Row[]; googleClient: boolean }> {
  const status = (await invoke<Row>('mcpStatus')) ?? {};
  return {
    servers: Array.isArray(status.servers) ? connectorAccountRows(status.servers as Row[]) : [],
    // Only an explicit `false` means no built-in client; a host that does not
    // say (an older SSH/phone host) is attempted as before.
    googleClient: status.googleClient !== false,
  };
}

export async function readMcpServers(): Promise<Row[]> {
  return (await readMcpStatus()).servers;
}

/** Whether signing in `server` (null: a server still to be created) of `entry`
 *  needs the user's own Google client: a Google sign-in whose host
 *  reported no built-in client, and that server not on a client of its own. */
export function needsOwnGoogleClient(
  entry: ConnectorCatalogEntry | null | undefined,
  server: Row | null | undefined,
  googleClient: boolean
): boolean {
  return connectorUsesGoogleClient(entry) && !googleClient && server?.ownClient !== true;
}

/** The note for a Google sign-in this build cannot start by itself. */
export function ownGoogleClientNote(): string {
  return t(
    'This build has no built-in Google sign-in. Use your own Google client: Connectors → Add custom connector → Use my Google key.'
  );
}

const HOST_LOGIN_FAILED = /MCP OAuth (login failed|sign-in was not completed)|sign-in is no longer pending/i;
/** A failure in the user's language: the timeout and an unfinished browser
 *  sign-in get their own sentences; a server error keeps its summary (a
 *  sign-in Google granted without a requested access reads as mcpErrorSummary
 *  says, here and on the server's own row). */
export function connectorLoginErrorText(error: unknown, reason = ''): string {
  if (reason === 'timeout') return t('The sign-in timed out. Try again.');
  const message = typeof error === 'string' ? error : errorMessage(error);
  if (!message || HOST_LOGIN_FAILED.test(message)) return t('The browser sign-in was not completed.');
  return mcpErrorSummary(message);
}

function stopFollowing(key: string): void {
  window.clearTimeout(timers.get(key));
  timers.delete(key);
  following.delete(key);
}

function fail(key: string, error: string, reason = ''): void {
  stopFollowing(key);
  const current = states.get(key);
  patch(key, { phase: 'failed', error, reason });
  announceConnectorsChanged();
  showDesktopToast(t("Couldn't connect {{name}}: {{reason}}", { name: current?.label || key, reason: error }), 'error');
}

/** 연결됨, in one update that also ends the pending state. It stays marked
 *  as just connected for a moment (the row's highlight), then the row reads
 *  the host's refreshed status alone. */
function markConnected(key: string): void {
  const current = states.get(key);
  if (!current || current.phase === 'connected') return;
  stopFollowing(key);
  publish(key, { ...current, phase: 'connected', error: '', reason: '' });
  showDesktopToast(t('Connected to {{name}}', { name: current.label }), 'success');
  announceConnectorsChanged();
  timers.set(
    key,
    window.setTimeout(() => {
      if (states.get(key)?.phase === 'connected') publish(key, null);
      timers.delete(key);
    }, JUST_CONNECTED_MS)
  );
}

/** The list now shows the server connected too: the just-connected session
 *  has done its job, and from here the row follows the host status alone (a
 *  later sign-out or failure shows at once). */
export function retireConnectorLogin(name: string): void {
  if (states.get(name)?.phase !== 'connected') return;
  window.clearTimeout(timers.get(name));
  timers.delete(name);
  publish(name, null);
}

/** The host status shows the server connected while its sign-in still looks
 *  pending here: the sign-in is over (connectorRowView `finished`). */
export function finishConnectorLogin(name: string): void {
  const current = states.get(name);
  if (current && current.phase !== 'connected' && current.phase !== 'failed') markConnected(name);
}

/** "Connected" only when the host's status confirms it. */
async function confirm(key: string): Promise<void> {
  const current = states.get(key);
  if (!current || current.phase === 'connected') return;
  patch(key, { phase: 'tools' });
  let row: Row | undefined;
  try {
    row = (await readMcpServers()).find((server) => server.name === key);
  } catch (reason) {
    fail(key, connectorLoginErrorText(reason));
    return;
  }
  if (!states.get(key)) return;
  if (row?.connected === true) {
    markConnected(key);
    return;
  }
  fail(key, row?.error ? mcpErrorSummary(row.error) : t('Sign-in required'));
}

const STEP_PHASE: Record<string, ConnectorLoginPhase> = {
  starting: 'starting',
  browser: 'browser',
  connecting: 'connecting',
  tools: 'tools',
};

/** Follows the host flow step by step. On the host each status read waits
 *  for the flow's next change, so a step shows the moment it happens; away
 *  from it (relay) the status is read every half second. */
function follow(key: string, flowId: string): void {
  stopFollowing(key);
  following.set(key, flowId);
  const remote = Boolean(states.get(key)?.remote);
  let since = '';
  const step = async () => {
    if (following.get(key) !== flowId || !states.get(key)) return;
    let next: Row;
    try {
      next =
        (await invoke<Row>(
          'getMcpOAuthLoginStatus',
          remote || !since ? [flowId] : [flowId, { since, waitMs: STATUS_WAIT_MS }]
        )) ?? {};
    } catch (reason) {
      if (following.get(key) === flowId) fail(key, connectorLoginErrorText(reason));
      return;
    }
    const current = states.get(key);
    if (following.get(key) !== flowId || !current) return;
    const state = String(next.state || 'pending');
    if (state === 'pending') {
      const version = `${state}:${String(next.step || '')}`;
      const unchanged = version === since;
      since = version;
      publish(key, {
        ...current,
        flow: { ...current.flow, ...next },
        phase: STEP_PHASE[String(next.step || '')] ?? current.phase,
      });
      // An unchanged answer is a waited-out read (or a host that does not
      // wait): pace the next one.
      timers.set(key, window.setTimeout(step, remote || unchanged ? POLL_MS : 0));
      return;
    }
    following.delete(key);
    if (state === 'complete') await confirm(key);
    else if (state === 'cancelled') {
      publish(key, null);
      announceConnectorsChanged();
    } else {
      // A failed sign-in leaves the server and its id in place; 다시 시도
      // retries under the same id.
      const reason = isScopeNotGrantedError(next.error) ? 'scopeNotGranted' : String(next.reason || '');
      fail(key, connectorLoginErrorText(next.error, reason), reason);
    }
  };
  void step();
}

/** Starts the browser sign-in of the saved server `name`: `connect` (연결),
 *  `reauth` (다시 인증: a refresh is tried first, the same connection is
 *  repaired) or `switch` (계정 바꾸기: the working connection stays until the
 *  new sign-in connects). On the host the browser opens right away; away from
 *  it the page opens on this device and the redirect is pasted back. */
export async function startConnectorLogin(
  name: string,
  label: string,
  { mode = 'connect', connector = '' }: { mode?: Exclude<ConnectorLoginMode, 'reenable'>; connector?: string } = {}
): Promise<void> {
  const active = states.get(name);
  if (active && PENDING_LOGIN_PHASES.has(active.phase)) return;
  const remote = isRemoteHostRenderer() || isSshConnectionWindow();
  stopFollowing(name);
  publish(name, {
    name,
    connector,
    label,
    phase: 'starting',
    mode,
    flow: null,
    remote,
    error: '',
    reason: '',
  });
  try {
    const options = { ...(remote ? { openBrowser: false } : {}), ...(mode !== 'connect' ? { mode } : {}) };
    const flow =
      (await invoke<Row>('beginMcpOAuthLogin', Object.keys(options).length ? [name, options] : [name])) ?? {};
    // Cancelled, or already finished by the host status (finishConnectorLogin).
    const now = states.get(name);
    if (!now || !PENDING_LOGIN_PHASES.has(now.phase)) return;
    if (String(flow.state || '') === 'complete') {
      await confirm(name);
      return;
    }
    patch(name, { phase: 'browser', flow });
    const url = String(flow.manualUrl || flow.url || '');
    if (remote && url) void window.mixdogDesktop?.openExternal?.(url).catch(() => undefined);
    follow(name, String(flow.flowId || ''));
  } catch (reason) {
    if (states.get(name)) fail(name, connectorLoginErrorText(reason));
  }
}

/** 다시 켜기: switch a turned-off server back on with its stored sign-in (a
 *  refresh if needed), never a browser. */
export async function reenableConnector(name: string, label: string, connector = ''): Promise<void> {
  const active = states.get(name);
  if (active && PENDING_LOGIN_PHASES.has(active.phase)) return;
  stopFollowing(name);
  publish(name, {
    name,
    connector,
    label,
    phase: 'tools',
    mode: 'reenable',
    flow: null,
    remote: false,
    error: '',
    reason: '',
  });
  try {
    await invoke('setMcpServerEnabled', [name, true]);
  } catch (reason) {
    fail(name, connectorLoginErrorText(reason));
    return;
  }
  await confirm(name);
}

export function cancelConnectorLogin(name: string, connector = ''): void {
  const found = lookup(name, connector);
  const key = found ? (found.name && states.get(found.name) === found ? found.name : placeholderKey(connector)) : name;
  const current = states.get(key);
  stopFollowing(key);
  publish(key, null);
  const flowId = String(current?.flow?.flowId || '');
  if (flowId) void invoke('cancelMcpOAuthLogin', [flowId]).catch(() => undefined);
  announceConnectorsChanged();
}

/** Remote sign-in: the pasted redirect URL completes the pending flow. */
export async function completeConnectorLogin(name: string, callbackUrl: string): Promise<void> {
  const current = states.get(name);
  const flowId = String(current?.flow?.flowId || '');
  if (!current || !flowId) return;
  patch(name, { phase: 'connecting' });
  const next = (await invoke<Row>('completeMcpOAuthLogin', [flowId, callbackUrl])) ?? {};
  if (String(next.state || '') === 'complete') {
    stopFollowing(name);
    await confirm(name);
  }
}

/** A Gmail app-password row (the host's `appPassword.account`), or ''. */
export function appPasswordAccount(server: Row | null | undefined): string {
  const account = (server?.appPassword as Row | undefined)?.account;
  return typeof account === 'string' ? account : '';
}

/** The app-password failure of a Gmail connect in the user's language; any
 *  other failure keeps its own text. */
export function gmailAppPasswordErrorText(reason: unknown): string {
  const message = errorMessage(reason);
  const code = /GMAIL_APP_PASSWORD_([A-Z]+)/.exec(message)?.[1] ?? '';
  if (code === 'ADDRESS') return t('Enter a Gmail address.');
  if (code === 'FORMAT') return t('An app password has 16 characters.');
  if (code === 'REJECTED') {
    return t('Google did not accept this address and app password. Check both and try again.');
  }
  if (code === 'UNAVAILABLE') {
    return t(
      'App passwords are not available for this account. Turn on 2-Step Verification, or ask your Workspace admin whether app passwords and IMAP are allowed.'
    );
  }
  if (code === 'NETWORK') return t("Couldn't reach Gmail. Check your network connection and try again.");
  if (code === 'MISSING') return t('The app password is not saved on this computer. Connect again.');
  if (code === 'FAILED') return t('Gmail refused the sign-in. Try again later.');
  return message;
}

/** Connects catalog entry `entry`: the same server id on every retry; an
 *  apiKey entry takes `key`, and Gmail takes `appPassword` in place of the
 *  Google sign-in (the host checks it with Gmail before anything is saved).
 *  The row turns to "starting" on the click itself, before the host has
 *  created the server. Resolves once the flow has started (OAuth) or the host
 *  confirmed the connection (key, app password). */
export async function connectCatalogConnector(
  entry: ConnectorCatalogEntry,
  key = '',
  appPassword: { email: string; password: string } | null = null,
  // `add`: one more account of a multi-account connector (a new server, unless
  // that Gmail address is already connected); `server`: reconnect that server.
  // Neither: the connector's first server, as before.
  { add = false, server: target = '' }: { add?: boolean; server?: string } = {}
): Promise<void> {
  const placeholder = placeholderKey(entry.id);
  let viaOAuth = entry.backend.kind === 'oauth' && !appPassword;
  const starting: ConnectorLoginState = {
    name: '',
    connector: entry.id,
    label: entry.name,
    phase: viaOAuth ? 'starting' : 'tools',
    mode: 'connect',
    flow: null,
    remote: false,
    error: '',
    reason: '',
  };
  publish(placeholder, starting);
  let name = '';
  try {
    const { servers, googleClient } = await readMcpStatus();
    const ofConnector = servers.filter((server) => server.connector === entry.id && server.source !== 'plugin');
    const address = appPassword ? gmailAddress(appPassword.email) : '';
    const existing = target
      ? ofConnector.find((server) => server.name === target)
      : add && connectorMultiAccount(entry)
        ? address
          ? ofConnector.find((server) => appPasswordAccount(server) === address)
          : undefined
        : ofConnector[0];
    name = existing ? String(existing.name) : '';
    if (!states.get(placeholder)) return;
    // A Gmail already on an app password reconnects as it is; the Google
    // sign-in replaces it only after 연결 해제.
    if (existing && appPasswordAccount(existing)) viaOAuth = false;
    // Gmail takes no new Google sign-in; one already on it keeps reconnecting.
    if (viaOAuth && connectorAppPasswordOnly(entry) && !existing) {
      throw new Error(t('Gmail connects with an app password only.'));
    }
    // The chosen server's own client counts, not another account's; a new
    // account has none yet.
    if (viaOAuth && needsOwnGoogleClient(entry, existing, googleClient)) {
      throw new Error(ownGoogleClientNote());
    }
    if (!existing) {
      // The host picks a free account name; that account is what signs in.
      const added = await invoke<Row>('addConnectorAccount', [
        {
          connector: entry.id,
          ...(key ? { key } : {}),
          ...(appPassword ? { email: appPassword.email, appPassword: appPassword.password } : {}),
        },
      ]);
      name = String(added?.account ?? '');
    } else {
      const input = appPassword ? gmailAppPasswordServerInput(name, appPassword.email, appPassword.password) : null;
      if (input) {
        // From the Google sign-in to an app password: the host drops the old
        // sign-in once the new connection is saved.
        await invoke('saveMcpServer', [{ ...input, oauthClientId: '', originalName: name }]);
      } else if (entry.backend.kind === 'apiKey' && key) {
        await invoke('saveMcpServer', [{ ...connectorServerInput(entry, name, key), originalName: name }]);
      }
      if (existing.enabled === false) await invoke('setMcpServerEnabled', [name, true]);
    }
  } catch (reason) {
    publish(placeholder, null);
    throw reason;
  }
  // Cancelled while the server was being made.
  if (!states.get(placeholder)) return;
  // The named sign-in takes over in the same tick the placeholder goes.
  if (!viaOAuth) publish(name, { ...starting, name, phase: 'tools' });
  const started = viaOAuth ? startConnectorLogin(name, entry.name, { connector: entry.id }) : confirm(name);
  publish(placeholder, null);
  announceConnectorsChanged();
  await started;
}

/** 연결 해제 of a configured server. A catalog connection is removed with its
 *  local sign-in (revoked at the provider where it documents how); any other
 *  connection is switched off, keeping its config and sign-in. The toast says
 *  which happened, and whether the provider confirmed the revocation. */
export async function disconnectConnector(
  name: string,
  label: string,
  catalog: boolean,
  // The panel passes its own mutation runner (pending state, list refresh).
  mutate: (capability: DesktopCapability, args: unknown[]) => Promise<unknown> = (capability, args) =>
    invoke(capability, args)
): Promise<void> {
  if (states.has(name)) cancelConnectorLogin(name);
  if (!catalog) {
    await mutate('setMcpServerEnabled', [name, false]);
    announceConnectorsChanged();
    showDesktopToast(t('{{name}} is turned off. Its sign-in is kept.', { name: label }), 'info');
    return;
  }
  const result = ((await mutate('removeMcpServer', [name])) as Row | undefined) ?? {};
  announceConnectorsChanged();
  if (result.signIn === 'removed' && result.revoked === true) {
    showDesktopToast(t('Disconnected {{name}} and revoked its access.', { name: label }), 'success');
  } else if (result.signIn === 'removed') {
    showDesktopToast(
      t('Disconnected {{name}}. Its sign-in was deleted from this computer; to revoke access, use {{name}} settings.', {
        name: label,
      }),
      'info'
    );
  } else if (result.signIn === 'shared') {
    showDesktopToast(
      t('Disconnected {{name}}. Its sign-in is kept for another connection to the same address.', { name: label }),
      'info'
    );
  } else {
    showDesktopToast(t('Disconnected {{name}}.', { name: label }), 'info');
  }
}
