import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import type { UiOpenRequestedParams } from '../../../../packages/protocol/src/index.ts';
import {
  BROWSER_APPROVAL_SESSIONS_KEY,
  BROWSER_DIALOG_APPROVAL_SESSIONS_KEY,
  readBrowserApprovalSessions,
} from '../shared/browser-approval-sessions';
import { rpc } from './remote-protocol-files';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

const command = (host: PhoneProtocolHost, action: string, input?: Record<string, unknown>): Promise<unknown> =>
  rpc(host, 'browser/command', input ? { action, input } : { action });

const hostState = (client: Client, key: string): unknown => client.store.section('hostState' as never, key)?.value;

/** The tab list a `browserTabs` value carries (`{tabs}`). */
const tabsOf = (value: unknown): unknown[] => {
  const tabs = (value as { tabs?: unknown } | null | undefined)?.tabs;
  return Array.isArray(tabs) ? tabs : [];
};

/** Whether each page is watching the PC's tabs (Node's `browserTabs.watch(clientId, watch)`), per context. */
const watching = new WeakSet<object>();

const MARK_KEYS = [BROWSER_APPROVAL_SESSIONS_KEY, BROWSER_DIALOG_APPROVAL_SESSIONS_KEY] as const;

/** The union of the approval-session lists the host publishes under each mark key, fanned out when it changes. */
function createApprovalMarks(ctx: PhoneProtocolHost['ctx']) {
  const marks = new Map<string, string[]>();
  const publish = (ids: string[]): void => {
    if (
      ids.length === ctx.browserApprovalSessionIds.length &&
      ids.every((id, index) => id === ctx.browserApprovalSessionIds[index])
    )
      return;
    ctx.browserApprovalSessionIds = ids;
    ctx.fanOut(ctx.browserApprovalSessionListeners, ids);
  };
  return {
    read(client: Client, keys: readonly string[]): void {
      for (const key of keys) {
        const value = hostState(client, key);
        if (value === undefined) marks.delete(key);
        else {
          // A section stub is not a clear. Keep that source's last known list without blocking the other source.
          const ids = readBrowserApprovalSessions(value);
          if (ids !== null) marks.set(key, ids);
        }
      }
      publish([...new Set([...marks.values()].flat())].sort());
    },
    reset(): void {
      marks.clear();
      publish([]);
    },
  };
}

export const adapter: PhoneProtocolAdapter = {
  group: 'browser',
  calls: {
    // Node: `browserRemote('control', [sessionId, normalizeRemoteBrowserControl(input)])`; the order a relay call carried only fenced
    // the PC's own queue, which the connection's call queue (remote-protocol-queue.ts) keeps here.
    browserRemoteControl: ([sessionId, input], host) =>
      command(host, 'input', {
        ...(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
        session_id: sessionId,
      }),
    browserRemoteTabOpen: ([url], host) => command(host, 'tabOpen', { url }),
    browserRemoteTabClose: ([id], host) => command(host, 'release', { id }),
    // `browserReleasePage` answered nothing; the host releases only a main-workspace tab's page (the core refuses any other).
    browserReleasePage: async ([pageId], host) => {
      await command(host, 'release', { id: pageId });
    },
    browserHistorySearch: ([query], host) => command(host, 'history', { query }),
    browserCredentialSuggestions: ([sessionId], host) =>
      command(host, 'credentialSuggestions', { session_id: sessionId }),
    browserCredentialFill: ([sessionId, credentialId], host) =>
      command(host, 'credentialFill', { session_id: sessionId, credentialId }),
    browserProfileImportSources: (_params, host) => command(host, 'importSources'),
    browserProfileImportStart: ([request], host) =>
      command(host, 'importStart', request && typeof request === 'object' ? (request as Record<string, unknown>) : {}),
    // `browserRemoteStream([sessionId, options])`: options `null` ends this phone's subscription (a subscription lapses 4 s after
    // its last renewal).
    browserRemoteStream: async ([sessionId, options], host) => {
      await rpc(host, 'browser/stream', {
        sessionId,
        on: options != null,
        ...(options != null ? { request: options } : {}),
      });
      return null;
    },
    browserRemoteWebrtcSignal: async ([signal], host) => {
      await rpc(host, 'browser/webrtcSignal', { signal });
      return null;
    },
    browserRemoteScreenDisplays: (_params, host) => rpc(host, 'browser/screenDisplays', {}),
    // The current list, and from now on each change (`install`) while the phone watches.
    browserRemoteTabs: ([watch], host) => {
      if (watch === true) watching.add(host.ctx);
      else watching.delete(host.ctx);
      return tabsOf(hostState(host.client(), 'browserTabs'));
    },
  },
  fires: {
    browserRemoteStreamAck: ([sessionId, seq], host) =>
      host.client().notify('browser/streamAck', { sessionId, seq } as { sessionId: string; seq: number }),
  },
  install(host) {
    const { ctx } = host;
    let unwire: (() => void) | undefined;
    const approvalMarks = createApprovalMarks(ctx);
    const wire = (client: Client): void => {
      unwire?.();
      if (client.store.appFeed()) approvalMarks.read(client, MARK_KEYS);
      const offStore = client.store.subscribe((change) => {
        if (change.type === 'appSnapshot') {
          approvalMarks.read(client, MARK_KEYS);
          return;
        }
        if (change.type !== 'section' || change.section !== 'hostState') return;
        if (change.key === BROWSER_APPROVAL_SESSIONS_KEY || change.key === BROWSER_DIALOG_APPROVAL_SESSIONS_KEY) {
          if (!(client.store as { readonly owed?: unknown }).owed) approvalMarks.read(client, [change.key]);
          return;
        }
        // A snapshot or a resumed replay is what stood while the connection was away, not a change this phone is told of.
        if (!client.store.appLive()) return;
        if (change.key === 'browserTabs' && watching.has(ctx))
          ctx.fanOut(ctx.remoteBrowserTabListeners, tabsOf(hostState(client, 'browserTabs')) as never);
        if (change.key === 'browserImport') {
          const progress = hostState(client, 'browserImport');
          if (progress && typeof progress === 'object')
            ctx.fanOut(ctx.browserImportProgressListeners, progress as never);
        }
      });
      const offEvents = client.on((event) => {
        if (event.type !== 'notification') return;
        const { method, params } = event.notification as { method: string; params?: unknown };
        if (method === 'browser/frame') ctx.fanOut(ctx.remoteBrowserFrameListeners, params as never);
        else if (method === 'browser/webrtcSignal') {
          const signal = (params as { signal?: unknown } | undefined)?.signal;
          if (signal !== undefined) ctx.fanOut(ctx.remoteBrowserWebrtcListeners, signal as never);
        } else if (method === 'ui/openRequested' && client.store.appLive()) {
          const open = params as UiOpenRequestedParams | undefined;
          if (open?.kind !== 'browser' || typeof open.sessionId !== 'string' || !open.sessionId) return;
          const { kind: _kind, ...request } = open;
          ctx.fanOut(ctx.browserOpenListeners, request);
        }
      });
      unwire = () => {
        offStore();
        offEvents();
      };
    };
    const off = host.onClient?.(wire);
    const offReset = host.onPairingReset?.(() => {
      unwire?.();
      approvalMarks.reset();
    });
    if (!off)
      void ctx.phone.start().then(
        () => wire(host.client()),
        () => undefined
      );
    return () => {
      off?.();
      offReset?.();
      unwire?.();
    };
  },
};
