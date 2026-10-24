// The server login handlers of the SSH IPC: the provider logins stored on a
// server whose daemon runs models with the server's own logins. Every call
// runs on that server's attached daemon; nothing of this PC's sign-ins is
// read or sent. A subscription login starts on the server, opens in this PC's
// browser, and while it is pending the provider's localhost callback port is
// forwarded from this PC to the server over ssh, so the browser's redirect
// reaches the server. Pasting the redirected address completes it otherwise.
import type { DesktopCapability } from '../../shared/contract-capabilities';
import type {
  DesktopSshCredentialSource,
  DesktopSshKeychainIssue,
  DesktopSshServerLogin,
  DesktopSshServerLoginFlow,
  DesktopSshServerLogins,
} from '../../shared/contract-ssh';
import type { SshModelLogin } from './ssh-context';
import type { SshHostRecord, SshHostStore } from './ssh-host-store';
import { redactSecrets } from '../../shared/redact-secret';
import { text } from './ssh-ipc-input';

/** An attached server connection, as the login handlers use it. */
export interface ServerLoginConnection {
  readonly modelLogin: SshModelLogin;
  /** One capability call on the server's daemon: its value. */
  invoke(capability: DesktopCapability, args: unknown[]): Promise<unknown>;
  /** Sessions running a turn on the server; null when unknown. */
  busySessions(): Promise<number | null>;
  /** Calls `listener` once when this attachment stops running models with
   *  the server's logins: it is disconnected (or the app quits) or its model
   *  login changes; at once when it already has. Returns the unsubscribe.
   *  The attachment waits for a returned promise before it closes, so a call
   *  to the server made here still reaches it. */
  onEnd(listener: () => void | Promise<void>): () => void;
}

/** A forward of one callback port; closing it stops its ssh child. */
export interface CallbackForward {
  close(): Promise<void>;
}

export interface ServerLoginDeps {
  store(): Promise<SshHostStore>;
  /** The attached connection of a saved server; null when it is not attached. */
  connection(id: string): ServerLoginConnection | null;
  openExternal(url: string): Promise<void>;
  /** Forwards 127.0.0.1:`port` on this PC to 127.0.0.1:`port` on the server;
   *  resolves once this PC listens there, rejects when the port is taken here
   *  (a login of this PC's own may hold it). */
  forwardCallback(record: SshHostRecord, port: number): Promise<CallbackForward>;
  /** Calls `listener` with a saved server's id each time its connection is
   *  attached (reachable) again. Returns the unsubscribe. */
  onAttach?(listener: (id: string) => void): () => void;
  /** Longest a pending login keeps its forward; 15 minutes by default. */
  maxForwardMs?: number;
  /** Longest an ending login waits for the server to take its cancel; 3 seconds by default. */
  cancelTimeoutMs?: number;
  /** Most cancels kept for a server that cannot be reached yet; 32 by default (the oldest go first). */
  maxQueuedCancels?: number;
  /** The clock, in ms (a test seam). */
  now?(): number;
}

const DEFAULT_MAX_FORWARD_MS = 15 * 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_QUEUED_CANCELS = 32;
/** How long the server keeps a login before it drops it itself
 *  (DEFAULT_FLOW_TTL_MS in src/tui/session/oauth-flows.mjs): a cancel for an
 *  older login has nothing left to do. */
const SERVER_FLOW_LIFETIME_MS = 10 * 60_000;

/** A login pending on the server (forwarded or not), with the watch on the
 *  attachment that started it. */
interface PendingLogin {
  hostId: string;
  flowId: string;
  /** When the login started, on this PC's clock. */
  startedAt: number;
  /** The saved server's removal count when the login started: once the server
   *  is removed, no cancel for this login is kept for later. */
  generation: number;
  server: ServerLoginConnection;
  unwatch(): void;
}

/** A cancel the server has not taken yet; `startedAt` tells which login it is for. */
interface QueuedCancel {
  hostId: string;
  flowId: string;
  startedAt: number;
}
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A custom provider's generated id (CUSTOM_ID_RE in provider-admin.mjs). */
const CUSTOM_PROVIDER_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEY_LENGTH = 8_192;
const MAX_URL_LENGTH = 16_384;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FLOW_STATES = new Set<DesktopSshServerLoginFlow['state']>([
  'pending',
  'complete',
  'failed',
  'cancelled',
  'expired',
]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
const optionalText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The port of an IPv4 loopback `http://localhost:<port>/…` redirect_uri in an
 *  authorization URL: the server's callback listener for this login. An IPv6
 *  `[::1]` redirect is refused (null): the forward is IPv4-only, so such a
 *  login completes by pasting the redirected address. */
export function callbackPortOf(authUrl: string | null): number | null {
  if (!authUrl) return null;
  let redirect: URL;
  try {
    const raw = new URL(authUrl).searchParams.get('redirect_uri');
    if (!raw) return null;
    redirect = new URL(raw);
  } catch {
    return null;
  }
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) return null;
  const port = Number(redirect.port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** A failed key save, safe to show and log: the key itself is blanked out of
 *  the server's message. */
function keyFailure(error: unknown, secret: string): Error {
  return new Error(redactSecrets(error instanceof Error ? error.message : String(error), [secret]));
}

function providerId(value: unknown): string {
  const id = text(value, 'provider');
  if (!PROVIDER_ID.test(id)) throw new Error('The provider id is not valid.');
  return id;
}

const CREDENTIAL_SOURCES: readonly DesktopSshCredentialSource[] = ['keychain', 'private-file', 'environment'];

function loginRows(setup: unknown): DesktopSshServerLogin[] {
  const source = record(setup);
  const row = (entry: Record<string, unknown>, kind: DesktopSshServerLogin['kind']): DesktopSshServerLogin | null => {
    const id = optionalText(entry.id);
    if (!id) return null;
    // Reported as the server states it; the actions follow `fromEnvironment` alone.
    const credentialSource = kind === 'api' ? CREDENTIAL_SOURCES.find((known) => known === entry.credentialSource) : undefined;
    // An environment key with nothing stored is read-only; a stored key can still be changed or
    // logged out. A custom provider with a key variable takes no key saved here.
    const fromEnvironment =
      kind === 'api' &&
      ((entry.env === true && entry.stored !== true) || (entry.custom === true && optionalText(entry.apiKeyEnv) !== null));
    return {
      id,
      name: optionalText(entry.name) ?? id,
      kind,
      signedIn: entry.authenticated === true,
      ...(credentialSource ? { credentialSource } : {}),
      ...(fromEnvironment ? { fromEnvironment: true } : {}),
      ...(kind === 'api' && entry.detail === 'stored in private file' ? { storedInPrivateFile: true } : {}),
      ...(kind === 'api' && entry.custom === true ? { custom: true } : {}),
      ...(kind === 'api' && entry.custom === true && entry.auth === 'none' ? { keyless: true } : {}),
    };
  };
  const rows = [
    ...list(source.oauth).map((entry) => row(entry, 'oauth')),
    ...list(source.api).map((entry) => row(entry, 'api')),
  ].filter((entry): entry is DesktopSshServerLogin => entry !== null);
  // Signed-in logins first; each group keeps the server's order.
  return [...rows.filter((entry) => entry.signedIn), ...rows.filter((entry) => !entry.signedIn)];
}

/** The server's credential-storage issue from its setup, reduced to plain
 *  bounded text (state, kind, hint, folder); undefined without one. */
function keychainIssueOf(setup: unknown): DesktopSshKeychainIssue | undefined {
  const issue = record(record(setup).keychain);
  const bounded = (value: unknown, max: number): string | null => {
    const found = optionalText(value);
    return found && found.length <= max && !CONTROL_CHARACTERS.test(found) ? found : null;
  };
  const state = bounded(issue.state, 40);
  const message = bounded(issue.message, 400);
  if (!state || !message) return undefined;
  const kind = bounded(issue.kind, 40);
  const path = bounded(issue.path, 1_024);
  return { state, message, ...(kind ? { kind } : {}), ...(path ? { path } : {}) };
}

/** The selected account of a server's subscription roster, as it names
 *  itself (its email); null without one. */
function accountIdentity(roster: unknown): string | null {
  const source = record(roster);
  const accounts = list(source.accounts);
  const account = accounts.find((entry) => entry.id === source.selectedId) ?? accounts[0];
  return account ? (optionalText(account.email) ?? optionalText(account.identity)) : null;
}

function flowOf(value: unknown, forwarded: boolean): DesktopSshServerLoginFlow & { manualUrl: string | null } {
  const flow = record(value);
  const flowId = optionalText(flow.flowId);
  if (!flowId) throw new Error('The server did not start a login.');
  const state = String(flow.state || 'pending') as DesktopSshServerLoginFlow['state'];
  const userCode = optionalText(flow.userCode);
  return {
    flowId,
    provider: String(flow.provider || ''),
    state: FLOW_STATES.has(state) ? state : 'failed',
    url: optionalText(flow.url) ?? optionalText(flow.manualUrl),
    manualUrl: optionalText(flow.manualUrl),
    error: optionalText(flow.error),
    forwarded,
    ...(userCode ? { userCode } : {}),
    ...(typeof flow.manualCodeSupported === 'boolean' ? { manualCodeSupported: flow.manualCodeSupported } : {}),
  };
}

const publicFlow = ({ manualUrl: _manualUrl, ...flow }: ReturnType<typeof flowOf>): DesktopSshServerLoginFlow => flow;

const isHttpUrl = (url: string | null): url is string => {
  try {
    return url !== null && ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

export function createServerLoginHandlers(deps: ServerLoginDeps): {
  logins(id: unknown): Promise<DesktopSshServerLogins>;
  begin(id: unknown, provider: unknown): Promise<DesktopSshServerLoginFlow>;
  status(id: unknown, flowId: unknown): Promise<DesktopSshServerLoginFlow>;
  complete(id: unknown, flowId: unknown, redirectUrl: unknown): Promise<DesktopSshServerLoginFlow>;
  cancel(id: unknown, flowId: unknown): Promise<void>;
  saveKey(id: unknown, provider: unknown, key: unknown): Promise<void>;
  logout(id: unknown, provider: unknown): Promise<void>;
  removeCustomProvider(id: unknown, provider: unknown): Promise<void>;
  /** A saved server was removed: the cancels still waiting for it are dropped. */
  forgetHost(id: unknown): void;
  /** Closes every callback forward still open and cancels the logins pending. */
  dispose(): Promise<void>;
} {
  const maxForwardMs = deps.maxForwardMs ?? DEFAULT_MAX_FORWARD_MS;
  /** `<host id>\0<flow id>` → the callback forward of a pending login. Each
   *  lives no longer than the login, the 15-minute cap and the attachment
   *  that started it. */
  const forwards = new Map<string, { forward: CallbackForward; timer: NodeJS.Timeout }>();
  /** `<host id>\0<flow id>` → a login pending on the server. The server's own
   *  listener lives until the login ends or its 10-minute expiry. */
  const pendingLogins = new Map<string, PendingLogin>();
  /** `<host id>\0<flow id>` → a cancel to send once that server is reachable
   *  again: the PC side of the login ended while the connection could not
   *  carry it. Kept only for the server's flow lifetime, at most
   *  `maxQueuedCancels` of them, oldest dropped first. */
  const queuedCancels = new Map<string, QueuedCancel>();
  /** Queued cancels being sent now, so two attaches never send one twice. */
  const replaying = new Set<string>();
  /** Host id → how many times that saved server was removed. A cancel still in
   *  flight when its server is removed (or this manager disposed) must not
   *  queue itself afterwards. */
  const removals = new Map<string, number>();
  let disposed = false;
  const now = (): number => deps.now?.() ?? Date.now();

  const closeForward = async (key: string): Promise<void> => {
    const open = forwards.get(key);
    if (!open) return;
    forwards.delete(key);
    clearTimeout(open.timer);
    await open.forward.close().catch(() => undefined);
  };
  /** The login is over on the server too (or being cancelled separately). */
  const forgetLogin = (key: string): PendingLogin | null => {
    const login = pendingLogins.get(key);
    if (!login) return null;
    pendingLogins.delete(key);
    login.unwatch();
    return login;
  };
  const pruneQueuedCancels = (): void => {
    for (const [key, queued] of queuedCancels) {
      if (now() - queued.startedAt >= SERVER_FLOW_LIFETIME_MS) queuedCancels.delete(key);
    }
  };
  const queueCancel = (login: PendingLogin): void => {
    if (disposed || login.generation !== (removals.get(login.hostId) ?? 0)) return;
    const key = `${login.hostId}\0${login.flowId}`;
    pruneQueuedCancels();
    if (now() - login.startedAt >= SERVER_FLOW_LIFETIME_MS) return;
    queuedCancels.delete(key);
    queuedCancels.set(key, { hostId: login.hostId, flowId: login.flowId, startedAt: login.startedAt });
    const most = deps.maxQueuedCancels ?? DEFAULT_MAX_QUEUED_CANCELS;
    for (const oldest of queuedCancels.keys()) {
      if (queuedCancels.size <= most) break;
      queuedCancels.delete(oldest);
    }
  };
  /** True when the server took the cancel (a flow it no longer knows is refused: false). */
  const cancelOnServer = async (server: ServerLoginConnection, flowId: string): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        server.invoke('cancelOAuthProviderLogin', [flowId]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The server did not answer.')),
            deps.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
          );
          timer.unref?.();
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  /** The PC side of a pending login ends without the user finishing it (a
   *  disconnect, a quit, a changed model login): the forward closes and the
   *  server drops its listener, now when it can be reached, else once it can. */
  const cancelOrQueue = async (login: PendingLogin, server = login.server): Promise<void> => {
    if (!(await cancelOnServer(server, login.flowId))) queueCancel(login);
  };
  /** Ends a login (`only`: that very login, not a later one reusing its id). */
  const endLogin = async (key: string, only?: PendingLogin): Promise<void> => {
    if (only && pendingLogins.get(key) !== only) return;
    const login = forgetLogin(key);
    await closeForward(key);
    if (login) await cancelOrQueue(login);
  };
  /** Sends the cancels queued for a server that is reachable again. One the
   *  server did not take stays for the next attach until it expires. */
  const flushQueuedCancels = async (hostId: string): Promise<void> => {
    const server = deps.connection(hostId);
    if (!server) return;
    pruneQueuedCancels();
    const due = [...queuedCancels].filter(([, queued]) => queued.hostId === hostId);
    await Promise.all(
      due.map(async ([key, queued]) => {
        // A server back on this PC's logins runs no login of its own; a live
        // login that owns the id now is a newer one, which a stale cancel
        // must never end.
        if (server.modelLogin !== 'server' || pendingLogins.has(key)) {
          if (queuedCancels.get(key) === queued) queuedCancels.delete(key);
          return;
        }
        if (replaying.has(key)) return;
        replaying.add(key);
        try {
          if ((await cancelOnServer(server, queued.flowId)) && queuedCancels.get(key) === queued) {
            queuedCancels.delete(key);
          }
        } finally {
          replaying.delete(key);
        }
      })
    );
  };
  const unsubscribeAttach = deps.onAttach?.((hostId) => void flushQueuedCancels(hostId));
  const flowKey = (id: unknown, flowId: unknown): string => `${text(id, 'id')}\0${text(flowId, 'flowId')}`;

  const savedHost = async (id: unknown): Promise<SshHostRecord> => {
    const host = (await deps.store()).get(text(id, 'id'));
    if (!host) throw new Error('This SSH server is no longer saved.');
    return host;
  };

  /** The attached server, running models with its own logins: the only
   *  place any of these calls may go. */
  const serverConnection = async (id: unknown): Promise<{ host: SshHostRecord; server: ServerLoginConnection }> => {
    const host = await savedHost(id);
    const server = deps.connection(host.id);
    if (!server) throw new Error(`Connect to ${host.name} to manage its logins.`);
    if (server.modelLogin !== 'server') {
      throw new Error(`${host.name} uses this PC's accounts. Switch it to server accounts to manage its logins.`);
    }
    return { host, server };
  };

  /** A status answer: a login that ended no longer needs its forward. */
  const settle = async (key: string, value: unknown): Promise<DesktopSshServerLoginFlow> => {
    const flow = publicFlow(flowOf(value, forwards.has(key)));
    if (flow.state !== 'pending') {
      forgetLogin(key);
      await closeForward(key);
      return { ...flow, forwarded: false };
    }
    return flow;
  };

  return {
    async logins(id) {
      const host = await savedHost(id);
      const server = deps.connection(host.id);
      if (!server) return { connected: false, modelLogin: null, busySessions: null, providers: null };
      const busySessions = await server.busySessions().catch(() => null);
      if (server.modelLogin !== 'server') {
        return { connected: true, modelLogin: server.modelLogin, busySessions, providers: null };
      }
      const setup = await server.invoke('getProviderSetup', [{ force: true }]);
      const providers = await Promise.all(
        loginRows(setup).map(async (row) => {
          if (row.kind !== 'oauth' || !row.signedIn) return row;
          const identity = accountIdentity(await server.invoke('getProviderAccounts', [row.id]).catch(() => null));
          return identity ? { ...row, identity } : row;
        })
      );
      const keychain = keychainIssueOf(setup);
      return { connected: true, modelLogin: 'server', busySessions, providers, ...(keychain ? { keychain } : {}) };
    },

    async begin(id, provider) {
      const { host, server } = await serverConnection(id);
      // The server never opens a browser of its own: this PC's does.
      const started = flowOf(
        await server.invoke('beginOAuthProviderLogin', [providerId(provider), { openBrowser: false }]),
        false
      );
      const key = `${host.id}\0${started.flowId}`;
      const port = started.state === 'pending' ? callbackPortOf(started.url) : null;
      // A disconnect, a quit or a changed model login ends the login on this
      // PC: its forward closes and the server is told to drop it.
      let login: PendingLogin | null = null;
      if (started.state === 'pending') {
        const own: PendingLogin = {
          hostId: host.id,
          flowId: started.flowId,
          startedAt: now(),
          generation: removals.get(host.id) ?? 0,
          server,
          unwatch: () => undefined,
        };
        login = own;
        // A cancel queued for an older login that had this id is stale now.
        queuedCancels.delete(key);
        pendingLogins.set(key, own);
        own.unwatch = server.onEnd(() => endLogin(key, own));
      }
      let forward: CallbackForward | null = null;
      if (port !== null) {
        try {
          forward = await deps.forwardCallback(host, port);
        } catch {
          // The port is taken here or ssh refused the forward: the pasted
          // redirect address completes the login instead.
        }
      }
      // The login ended while the forward was being made (a disconnect, a
      // quit): that forward is closed at once, and no browser opens for it.
      if (login && pendingLogins.get(key) !== login) {
        await forward?.close().catch(() => undefined);
        return { ...publicFlow(started), state: 'cancelled', url: null, forwarded: false };
      }
      let forwarded = false;
      if (forward) {
        const timer = setTimeout(() => void closeForward(key), maxForwardMs);
        timer.unref?.();
        forwards.set(key, { forward, timer });
        forwarded = true;
      }
      // Without the forward the browser cannot reach the server's listener: a
      // provider's manual page (it shows a code to paste) serves better.
      const opened = forwarded ? started.url : (started.manualUrl ?? started.url);
      if (isHttpUrl(opened)) {
        try {
          await deps.openExternal(opened);
        } catch (error) {
          await endLogin(key);
          throw error;
        }
      }
      return { ...publicFlow(started), url: opened, forwarded };
    },

    async status(id, flowId) {
      const key = flowKey(id, flowId);
      try {
        const { server } = await serverConnection(id);
        return await settle(key, await server.invoke('getOAuthProviderLoginStatus', [text(flowId, 'flowId')]));
      } catch (error) {
        // A status nobody can read (the server went, the call failed) ends the
        // dialog's polling: the forward goes with it, and the server is told
        // to drop the login (not awaited: the error must not wait for a dead link).
        const login = forgetLogin(key);
        await closeForward(key);
        if (login) void cancelOrQueue(login);
        throw error;
      }
    },

    async complete(id, flowId, redirectUrl) {
      const { host, server } = await serverConnection(id);
      const flow = text(flowId, 'flowId');
      const pasted = text(redirectUrl, 'redirectUrl').trim();
      if (!pasted || pasted.length > MAX_URL_LENGTH || CONTROL_CHARACTERS.test(pasted)) {
        throw new Error('The pasted address is not valid.');
      }
      return settle(`${host.id}\0${flow}`, await server.invoke('completeOAuthProviderLogin', [flow, pasted]));
    },

    async cancel(id, flowId) {
      const host = await savedHost(id);
      const flow = text(flowId, 'flowId');
      const key = `${host.id}\0${flow}`;
      const pending = forgetLogin(key);
      // The forward closes at once, whatever the server answers or when.
      const closing = closeForward(key);
      const server = deps.connection(host.id);
      if (server?.modelLogin === 'server') {
        // Bounded, and kept for the next attach when the server did not take it.
        if (pending) await cancelOrQueue(pending, server);
        else await cancelOnServer(server, flow);
      } else if (!server && pending) {
        // Not attached: the dialog's last read failed, and the server still holds it.
        queueCancel(pending);
      }
      await closing;
    },

    async saveKey(id, provider, key) {
      const { server } = await serverConnection(id);
      const secret = text(key, 'key').trim();
      if (!secret || secret.length > MAX_KEY_LENGTH || CONTROL_CHARACTERS.test(secret)) {
        throw new Error('The API key is not valid.');
      }
      const providerName = providerId(provider);
      // A custom provider's key is replaced on its own, so the provider's other
      // settings are never rewritten from a stale read.
      const custom = CUSTOM_PROVIDER_ID.test(providerName);
      try {
        await server.invoke(custom ? 'saveCustomProviderKey' : 'saveProviderApiKey', [providerName, secret]);
      } catch (error) {
        throw keyFailure(error, secret);
      }
    },

    async logout(id, provider) {
      const { server } = await serverConnection(id);
      await server.invoke('forgetProviderAuth', [providerId(provider)]);
    },

    /** Deletes a custom provider (and its models) on the server: only the explicit Delete asks for it. */
    async removeCustomProvider(id, provider) {
      const { server } = await serverConnection(id);
      const providerName = providerId(provider);
      if (!CUSTOM_PROVIDER_ID.test(providerName)) throw new Error('The provider id is not valid.');
      await server.invoke('removeCustomProvider', [providerName]);
    },

    forgetHost(id) {
      if (typeof id !== 'string') return;
      removals.set(id, (removals.get(id) ?? 0) + 1);
      for (const [key, queued] of queuedCancels) if (queued.hostId === id) queuedCancels.delete(key);
    },

    async dispose() {
      disposed = true;
      unsubscribeAttach?.();
      await Promise.all([...new Set([...pendingLogins.keys(), ...forwards.keys()])].map((key) => endLogin(key)));
      // Nothing is left to attach to: what could not be sent is dropped.
      queuedCancels.clear();
    },
  };
}
