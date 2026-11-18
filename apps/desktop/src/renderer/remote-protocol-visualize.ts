// The agent `visualize` panel on a paired phone (Node's `remoteVisualizeMethods`, remote-visualize.ts at 0bf8fe0457, and the daemon
// mirror's push). The core keeps the desktop's tabs (`hostState` `visualize`, folded into `VisualizePanes`) and answers a phone's reads
// through `visualize/command`: the state with no host path (:1-5), an inline pane's source, a pane's file facts and byte ranges under
// the access rules of `servedFile` (:139-181), a PDF or Office pane's pages (:300-315), and the tab commands with Node's limits
// (`required_tab_command`, the network and PNG/PDF refusals :228-241). The shaping Node did on the way out (`remoteVisualizeState`,
// `withDeferredInline`, the repeated-thumbnail rule of the mirror's `apply`, :58-98) is shared code run here.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import {
  type DesktopVisualizeEvent,
  type VisualizeHostEvent,
  type VisualizeHostState,
  type VisualizeRemoteExport,
  type VisualizeSessionState,
  VISUALIZE_EXPORT_ID_PREFIX,
  remoteVisualizeState,
  withDeferredInline,
} from '../shared/visualize';
import { rpc } from './remote-protocol-files';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

const read = (host: PhoneProtocolHost, action: string, input: Record<string, unknown> = {}): Promise<any> =>
  rpc(host, 'visualize/command', { action, input });

/** The picture each tab's last forwarded event carried: a change repeats a picture never (every tab's ≤60 KB picture in every publish
 *  made the state the bulk of the traffic; a card keeps the picture it got, one it missed asks for its version's). */
function thumbnailRule() {
  let forwarded = new Map<string, string>();
  return (state: VisualizeSessionState): VisualizeSessionState => {
    const next = new Map<string, string>();
    const tabs = state.tabs.map((tab) => {
      const key = `${state.sessionId}\0${tab.id}`;
      if (!tab.thumbnail) return tab;
      next.set(key, tab.thumbnail);
      if (forwarded.get(key) !== tab.thumbnail) return tab;
      const { thumbnail: _thumbnail, thumbnailVersion: _version, ...rest } = tab;
      return rest;
    });
    for (const key of forwarded.keys()) if (key.startsWith(`${state.sessionId}\0`)) forwarded.delete(key);
    forwarded = new Map([...forwarded, ...next]);
    return { ...state, tabs };
  };
}

const hostState = (value: unknown): VisualizeHostState | null => {
  const state = record(value);
  return typeof state.sessionId === 'string' && state.sessionId && Array.isArray(state.tabs) ? (state as unknown as VisualizeHostState) : null;
};

/** `mirror.apply`: one change of the desktop's, as the client-safe event (null when it names no session and no URL to open). */
export function remoteVisualizeEvent(value: unknown, withoutRepeatedThumbnails: (state: VisualizeSessionState) => VisualizeSessionState): DesktopVisualizeEvent | null {
  const event = record(value) as Partial<VisualizeHostEvent>;
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  if (!sessionId) return null;
  const state = event.state === undefined ? null : hostState(event.state);
  const openUrl = typeof event.openUrl === 'string' && event.openUrl ? event.openUrl : '';
  if (!state && !openUrl) return null;
  return {
    sessionId,
    ...(state ? { state: withoutRepeatedThumbnails(remoteVisualizeState({ ...state, sessionId })) } : {}),
    ...(event.reveal === true ? { reveal: true } : {}),
    ...(event.reveal === true && typeof event.tab === 'string' && event.tab ? { tab: event.tab } : {}),
    ...(state && typeof event.updated === 'string' && event.updated ? { updated: event.updated } : {}),
    ...(state && event.held === true ? { held: true } : {}),
    ...(state && event.held === true && Number.isFinite(event.heldSince) ? { heldSince: event.heldSince } : {}),
    ...(openUrl ? { openUrl } : {}),
  };
}

/** `visualizeExport`'s argument checks (`requiredVisualizeTabCommand` for an export): png or pdf, the pane optional. */
function exportRequest(tabId: unknown, format: unknown, pane: unknown): { tabId: string; format: 'png' | 'pdf'; pane?: number } {
  if (format !== 'png' && format !== 'pdf') throw new TypeError('export format is invalid.');
  if (typeof tabId !== 'string' || !tabId.trim() || tabId.trim().length > 64) throw new TypeError('visualize tab id is invalid.');
  if (pane !== undefined && pane !== null && (typeof pane !== 'number' || !Number.isInteger(pane) || pane < 0 || pane > 15)) {
    throw new TypeError('visualize pane index is invalid.');
  }
  return { tabId: tabId.trim(), format, ...(typeof pane === 'number' ? { pane } : {}) };
}

const calls: Record<string, NodeCall> = {
  visualizeState: async ([options], host) => {
    const states = ((await read(host, 'state')) as VisualizeHostState[]).map(remoteVisualizeState);
    // A client that reads inline sources on open asks for the snapshot without them.
    return record(options).deferInline === true ? states.map(withDeferredInline) : states;
  },
  visualizePaneInline: ([sessionId, tabId, index], host) => read(host, 'paneInline', { sessionId, tabId, pane: index }),
  visualizeCommand: async ([command], host) => {
    const { action, ...input } = record(command);
    return (await read(host, typeof action === 'string' ? action : '', input)) ?? null;
  },
  visualizePaneFile: ([sessionId, tabId, index], host) => read(host, 'paneFile', { sessionId, tabId, pane: index }),
  visualizePaneRange: ([sessionId, tabId, rel, offset, length, index], host) =>
    read(host, 'paneRange', { sessionId, tabId, rel, offset, length, ...(index === undefined || index === null ? {} : { pane: index }) }),
  visualizePanePages: ([sessionId, tabId, index, options], host) => read(host, 'panePages', { sessionId, tabId, pane: index, options: record(options) }),
  // PNG / PDF of displayed pane `pane`, rendered on the PC and offered as a download of this device: the source names the render and the
  // core's `export` transfer source draws it when the download is authorized (remote-protocol-files.ts `authorizeDownload`).
  visualizeExport: ([sessionId, tabId, format, pane]): VisualizeRemoteExport => {
    const request = exportRequest(tabId, format, pane);
    return {
      source: { kind: 'export', sessionId: String(sessionId), exportId: `${VISUALIZE_EXPORT_ID_PREFIX}${JSON.stringify(request)}` },
      name: `visualize.${request.format}`,
    };
  },
};

function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let unwire: (() => void) | undefined;
  const wire = (client: Client): void => {
    unwire?.();
    const withoutRepeatedThumbnails = thumbnailRule();
    const emit = (event: DesktopVisualizeEvent): void => ctx.fanOut(ctx.visualizeListeners, event);
    // Anything the live notifications may have missed is made good by the page reading the current state again, as a complete replacement
    // (the store's own resync: holds and removed sessions included).
    const resync = (): void => ctx.requestResync();
    // The registration belongs to a connection, and the client object outlives its connections: the page registers the visualize lane on
    // every connection that becomes ready (Node's `setRemoteLanes`: every page with the store loaded reads it, whatever it shows), and
    // the core then sends it the changes as notifications. Notifications flow only while the current connection holds the registration;
    // otherwise (a core that refuses it, an older one, a connection not yet registered) the section, which always holds the current state,
    // drives a read of it.
    let notifications = false;
    let registering = 0;
    const register = (): void => {
      const attempt = ++registering;
      notifications = false;
      void read({ ...host, client: () => client }, 'lane', { on: true }).then(
        () => {
          if (attempt !== registering) return;
          notifications = true;
          // Changes between the connection's read and its registration went to nobody.
          resync();
        },
        () => undefined
      );
    };
    if (client.status.state === 'ready') register();
    const offStatus = client.on((incoming) => {
      if (incoming.type !== 'status') return;
      registering++;
      notifications = false;
      if (incoming.status.state === 'ready') register();
    });
    const offStore = client.store.subscribe((change) => {
      if (change.type !== 'section' || change.section !== ('hostState' as never) || change.key !== 'visualize' || !client.store.appLive()) return;
      if (!notifications) resync();
    });
    // An event is a `visualize/changed` notification, queued to this connection in order and never merged (a section key keeps only
    // its latest value and a slow subscriber's lane recovers with merged state, so events cannot travel on it). An event too large for
    // one frame arrives as ordered `part`s the core queued together: all of an event's parts reach a connection, or none. A part
    // sequence that does not start at its first part (this client is new, and the core only sends what was queued to it) is dropped.
    let assembling: { id: number; count: number; next: number; text: string } | null = null;
    const offEvents = client.on((incoming) => {
      if (incoming.type !== 'notification') return;
      const { method, params } = incoming.notification as { method: string; params?: unknown };
      if (method !== 'visualize/changed') return;
      let published: unknown = params;
      const part = record(record(params).part);
      if (Object.keys(part).length) {
        const { id, index, count, text } = part as { id: number; index: number; count: number; text: string };
        // A new sequence that starts while another was unfinished: the unfinished event was lost.
        if (index === 0 && assembling) ctx.requestResync();
        if (index === 0) assembling = { id, count, next: 0, text: '' };
        if (!assembling || assembling.id !== id || assembling.next !== index || typeof text !== 'string') {
          // Parts of an event were missed: the page reads the current state again (what the events would have said is read from the
          // state the core holds; an effect, an automatic reveal, is the most that can be lost).
          assembling = null;
          ctx.requestResync();
          return;
        }
        assembling.text += text;
        assembling.next += 1;
        if (assembling.next < assembling.count) return;
        const whole = assembling.text;
        assembling = null;
        try {
          published = JSON.parse(whole);
        } catch {
          ctx.requestResync();
          return;
        }
      }
      // Applied as it came: the state it announces with its own effect fields (`held` only while the turn is held, so a release that
      // carries no `held` is one), in the order the core queued them.
      const event = remoteVisualizeEvent(published, withoutRepeatedThumbnails);
      if (event) emit(event);
    });
    unwire = () => {
      offStatus();
      offStore();
      offEvents();
    };
  };
  const off = host.onClient?.(wire);
  if (!off) void ctx.phone.start().then(() => wire(host.client()), () => undefined);
  return () => {
    off?.();
    unwire?.();
  };
}

export const adapter: PhoneProtocolAdapter = { group: 'visualize', calls, install };
