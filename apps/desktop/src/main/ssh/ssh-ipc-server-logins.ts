// The server login handlers of the SSH IPC: the provider logins stored on a
// server whose daemon runs models with the server's own logins. Every call
// runs on that server's attached daemon; nothing of this PC's sign-ins is
// read or sent. A subscription login starts on the server, opens in this PC's
// browser, and while it is pending the provider's localhost callback port is
// forwarded from this PC to the server over ssh, so the browser's redirect
// reaches the server. Pasting the redirected address completes it otherwise.
import type { DesktopCapability } from '../../shared/contract-capabilities';
import type {
  DesktopSshServerLogin,
  DesktopSshServerLoginFlow,
  DesktopSshServerLogins,
} from '../../shared/contract-ssh';
import type { SshModelLogin } from './ssh-context';
import type { SshHostRecord, SshHostStore } from './ssh-host-store';
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
   *  login changes; at once when it already has. Returns the unsubscribe. */
  onEnd(listener: () => void): () => void;
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
  /** Longest a pending login keeps its forward; 15 minutes by default. */
  maxForwardMs?: number;
}

const DEFAULT_MAX_FORWARD_MS = 15 * 60_000;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

/** The port of a loopback `http://localhost:<port>/…` redirect_uri in an
 *  authorization URL: the server's callback listener for this login. */
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
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) return null;
  const port = Number(redirect.port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function providerId(value: unknown): string {
  const id = text(value, 'provider');
  if (!PROVIDER_ID.test(id)) throw new Error('The provider id is not valid.');
  return id;
}

function loginRows(setup: unknown): DesktopSshServerLogin[] {
  const source = record(setup);
  const row = (entry: Record<string, unknown>, kind: DesktopSshServerLogin['kind']): DesktopSshServerLogin | null => {
    const id = optionalText(entry.id);
    if (!id) return null;
    const fromEnvironment = kind === 'api' && entry.env === true && entry.stored !== true;
    return {
      id,
      name: optionalText(entry.name) ?? id,
      kind,
      signedIn: entry.authenticated === true,
      ...(fromEnvironment ? { fromEnvironment: true } : {}),
    };
  };
  const rows = [
    ...list(source.oauth).map((entry) => row(entry, 'oauth')),
    ...list(source.api).map((entry) => row(entry, 'api')),
  ].filter((entry): entry is DesktopSshServerLogin => entry !== null);
  // Signed-in logins first; each group keeps the server's order.
  return [...rows.filter((entry) => entry.signedIn), ...rows.filter((entry) => !entry.signedIn)];
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
  return {
    flowId,
    provider: String(flow.provider || ''),
    state: FLOW_STATES.has(state) ? state : 'failed',
    url: optionalText(flow.url) ?? optionalText(flow.manualUrl),
    manualUrl: optionalText(flow.manualUrl),
    error: optionalText(flow.error),
    forwarded,
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
  /** Closes every callback forward still open. */
  dispose(): Promise<void>;
} {
  const maxForwardMs = deps.maxForwardMs ?? DEFAULT_MAX_FORWARD_MS;
  /** `<host id>\0<flow id>` → the callback forward of a pending login. Each
   *  lives no longer than the login, the 15-minute cap and the attachment
   *  that started it. */
  const forwards = new Map<string, { forward: CallbackForward; timer: NodeJS.Timeout; unwatch(): void }>();

  const closeForward = async (key: string): Promise<void> => {
    const open = forwards.get(key);
    if (!open) return;
    forwards.delete(key);
    clearTimeout(open.timer);
    open.unwatch();
    await open.forward.close().catch(() => undefined);
  };
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
      return { connected: true, modelLogin: 'server', busySessions, providers };
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
      let forwarded = false;
      if (port !== null) {
        try {
          const forward = await deps.forwardCallback(host, port);
          const timer = setTimeout(() => void closeForward(key), maxForwardMs);
          timer.unref?.();
          const open = { forward, timer, unwatch: (): void => undefined };
          forwards.set(key, open);
          // A disconnect, a quit or a changed model login ends it too.
          open.unwatch = server.onEnd(() => void closeForward(key));
          forwarded = true;
        } catch {
          // The port is taken here or ssh refused the forward: the pasted
          // redirect address completes the login instead.
        }
      }
      // Without the forward the browser cannot reach the server's listener: a
      // provider's manual page (it shows a code to paste) serves better.
      const opened = forwarded ? started.url : (started.manualUrl ?? started.url);
      if (isHttpUrl(opened)) {
        try {
          await deps.openExternal(opened);
        } catch (error) {
          await closeForward(key);
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
        // dialog's polling: the forward goes with it.
        await closeForward(key);
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
      try {
        const server = deps.connection(host.id);
        if (server?.modelLogin === 'server') await server.invoke('cancelOAuthProviderLogin', [flow]);
      } finally {
        await closeForward(`${host.id}\0${flow}`);
      }
    },

    async saveKey(id, provider, key) {
      const { server } = await serverConnection(id);
      const secret = text(key, 'key').trim();
      if (!secret || secret.length > MAX_KEY_LENGTH || CONTROL_CHARACTERS.test(secret)) {
        throw new Error('The API key is not valid.');
      }
      await server.invoke('saveProviderApiKey', [providerId(provider), secret]);
    },

    async logout(id, provider) {
      const { server } = await serverConnection(id);
      await server.invoke('forgetProviderAuth', [providerId(provider)]);
    },

    async dispose() {
      await Promise.all([...forwards.keys()].map((key) => closeForward(key)));
    },
  };
}
