// The remote browser pane's parity methods. The service (daemon) side
// validates a paired client's call and forwards it to the window process, which
// owns the Browser Use host; `runBrowserRemoteRequest` is that window-side end.
// Saved passwords never travel: the host fills them straight into its guest.
import type { DesktopRemoteBrowserControl, DesktopRemoteBrowserStreamOptions } from '../shared/contract';
import {
  normalizeBrowserCredentialId,
  normalizeBrowserHistoryQuery,
  normalizeBrowserImportRequest,
  normalizeRemoteBrowserTabId,
} from '../shared/remote-browser';
import type { BrowserHost } from './browser/host';
import { requiredSessionId } from './desktop-state';

export type BrowserRemoteMethod =
  | 'stream'
  | 'control'
  | 'release'
  | 'tabsWatch'
  | 'tabOpen'
  | 'history'
  | 'credentialSuggestions'
  | 'credentialFill'
  | 'importSources'
  | 'importStart';

export const BROWSER_REMOTE_METHODS: ReadonlySet<string> = new Set<BrowserRemoteMethod>([
  'stream',
  'control',
  'release',
  'tabsWatch',
  'tabOpen',
  'history',
  'credentialSuggestions',
  'credentialFill',
  'importSources',
  'importStart',
]);

/** An import may wait on the host's administrator prompt. */
const IMPORT_TIMEOUT_MS = 10 * 60_000;
const MAX_TAB_URL = 4_096;

type BrowserRemoteHost = Pick<
  BrowserHost,
  | 'remoteBrowserStream'
  | 'remoteBrowserControl'
  | 'releaseSession'
  | 'remoteTabsWatch'
  | 'remoteTabOpen'
  | 'browserHistorySearch'
  | 'browserCredentialSuggestions'
  | 'browserCredentialFill'
  | 'browserImportSources'
  | 'browserImport'
>;

/** Window-process end of a daemon `browserRemote` request. */
export async function runBrowserRemoteRequest(
  host: BrowserRemoteHost,
  method: BrowserRemoteMethod,
  args: unknown[]
): Promise<unknown> {
  const sessionId = typeof args[0] === 'string' ? args[0] : '';
  switch (method) {
    case 'stream':
      return host.remoteBrowserStream(sessionId, args[1] as DesktopRemoteBrowserStreamOptions | null);
    case 'control':
      return host.remoteBrowserControl(sessionId, args[1] as DesktopRemoteBrowserControl);
    case 'release':
      return host.releaseSession(sessionId);
    case 'tabsWatch':
      return host.remoteTabsWatch(args[0] === true);
    case 'tabOpen':
      return host.remoteTabOpen(String(args[0] ?? ''));
    case 'history':
      return host.browserHistorySearch(String(args[0] ?? ''));
    case 'credentialSuggestions':
      return host.browserCredentialSuggestions(sessionId);
    case 'credentialFill':
      return host.browserCredentialFill(sessionId, String(args[1] ?? ''));
    case 'importSources':
      return host.browserImportSources();
    case 'importStart':
      return host.browserImport(args[0] as Parameters<BrowserRemoteHost['browserImport']>[0]);
  }
}

type RemoteBrowserRequest = (method: BrowserRemoteMethod, args: unknown[], timeoutMs?: number) => Promise<unknown>;

/** Daemon-side RPC table for the parity methods; each validates before forwarding. */
export function browserParityRemoteMethods(browserRemote: RemoteBrowserRequest | undefined) {
  const request: RemoteBrowserRequest = (method, args, timeoutMs) => {
    if (!browserRemote) throw new TypeError('Remote Browser Use is unavailable.');
    return browserRemote(method, args, timeoutMs);
  };
  return {
    browserRemoteTabOpen: ([url]: unknown[]) => {
      if (typeof url !== 'string' || url.length < 1 || url.length > MAX_TAB_URL) {
        throw new TypeError('remote browser url is invalid.');
      }
      return request('tabOpen', [url]);
    },
    browserRemoteTabClose: ([id]: unknown[]) => request('release', [normalizeRemoteBrowserTabId(id)]),
    browserHistorySearch: ([query]: unknown[]) => request('history', [normalizeBrowserHistoryQuery(query)]),
    browserCredentialSuggestions: ([sessionId]: unknown[]) =>
      request('credentialSuggestions', [requiredSessionId(sessionId)]),
    browserCredentialFill: ([sessionId, credentialId]: unknown[]) =>
      request('credentialFill', [requiredSessionId(sessionId), normalizeBrowserCredentialId(credentialId)]),
    browserProfileImportSources: () => request('importSources', []),
    browserProfileImportStart: ([value]: unknown[]) =>
      request('importStart', [normalizeBrowserImportRequest(value)], IMPORT_TIMEOUT_MS),
  };
}
