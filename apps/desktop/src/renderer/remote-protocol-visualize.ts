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
import { record } from './record-utils';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

const read = (host: PhoneProtocolHost, action: string, input: Record<string, unknown> = {}): Promise<any> =>
  rpc(host, 'visualize/command', { action, input });

/** The picture each tab's last forwarded event carried: a change repeats a picture never (every tab's ≤60 KB picture in every publish
 *  made the state the bulk of the traffic; a card keeps the picture it got, one it missed asks for its version's). */
const digestOf = (text: string): string => {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
};

/** Holds a digest of each forwarded picture, not the picture; `forget` drops a session's. */
export function thumbnailRule() {
  const forwarded = new Map<string, Map<string, string>>();
  const rule = (state: VisualizeSessionState): VisualizeSessionState => {
    const next = new Map<string, string>();
    const before = forwarded.get(state.sessionId);
    const tabs = state.tabs.map((tab) => {
      if (!tab.thumbnail) return tab;
      const digest = digestOf(tab.thumbnail);
      next.set(tab.id, digest);
      if (before?.get(tab.id) !== digest) return tab;
      const { thumbnail: _thumbnail, thumbnailVersion: _version, ...rest } = tab;
      return rest;
    });
    if (next.size) forwarded.set(state.sessionId, next);
    else forwarded.delete(state.sessionId);
    return { ...state, tabs };
  };
  return Object.assign(rule, { forget: (sessionId: string): void => void forwarded.delete(sessionId) });
}

const hostState = (value: unknown): VisualizeHostState | null => {
  const state = record(value);
  return typeof state.sessionId === 'string' && state.sessionId && Array.isArray(state.tabs)
    ? (state as unknown as VisualizeHostState)
    : null;
};

/** `mirror.apply`: one change of the desktop's, as the client-safe event (null when it names no session and no URL to open). */
export function remoteVisualizeEvent(
  value: unknown,
  withoutRepeatedThumbnails: (state: VisualizeSessionState) => VisualizeSessionState
): DesktopVisualizeEvent | null {
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
function exportRequest(
  tabId: unknown,
  format: unknown,
  pane: unknown
): { tabId: string; format: 'png' | 'pdf'; pane?: number } {
  if (format !== 'png' && format !== 'pdf') throw new TypeError('export format is invalid.');
  if (typeof tabId !== 'string' || !tabId.trim() || tabId.trim().length > 64)
    throw new TypeError('visualize tab id is invalid.');
  if (
    pane !== undefined &&
    pane !== null &&
    (typeof pane !== 'number' || !Number.isInteger(pane) || pane < 0 || pane > 15)
  ) {
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
    read(host, 'paneRange', {
      sessionId,
      tabId,
      rel,
      offset,
      length,
      ...(index === undefined || index === null ? {} : { pane: index }),
    }),
  visualizePanePages: ([sessionId, tabId, index, options], host) =>
    read(host, 'panePages', { sessionId, tabId, pane: index, options: record(options) }),
  visualizeExport: ([sessionId, tabId, format, pane]): VisualizeRemoteExport => {
    const request = exportRequest(tabId, format, pane);
    return {
      source: {
        kind: 'export',
        sessionId: String(sessionId),
        exportId: `${VISUALIZE_EXPORT_ID_PREFIX}${JSON.stringify(request)}`,
      },
      name: `visualize.${request.format}`,
    };
  },
};

type EventPart = { id: number; index: number; count: number; text: string };

/** An event too large for one frame arrives as ordered `part`s queued together to a connection. Returns the whole event once its last
 *  part is in, and null while parts are pending or when the sequence was lost (a sequence that does not start at part 0, a gap, or
 *  unparsable text), which asks the page to read the state again. */
function createEventAssembler(resync: () => void) {
  let assembling: { id: number; count: number; next: number; text: string } | null = null;
  return (params: unknown): unknown => {
    const part = record(record(params).part);
    if (!Object.keys(part).length) return params;
    const { id, index, count, text } = part as EventPart;
    if (index === 0 && assembling) resync();
    if (index === 0) assembling = { id, count, next: 0, text: '' };
    if (!assembling || assembling.id !== id || assembling.next !== index || typeof text !== 'string') {
      assembling = null;
      resync();
      return null;
    }
    assembling.text += text;
    assembling.next += 1;
    if (assembling.next < assembling.count) return null;
    const whole = assembling.text;
    assembling = null;
    try {
      return JSON.parse(whole);
    } catch {
      resync();
      return null;
    }
  };
}

function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let unwire: (() => void) | undefined;
  const wire = (client: Client): void => {
    unwire?.();
    const withoutRepeatedThumbnails = thumbnailRule();
    const emit = (event: DesktopVisualizeEvent): void => ctx.fanOut(ctx.visualizeListeners, event);
    const resync = (): void => ctx.requestResync();
    const assemble = createEventAssembler(resync);
    // Notifications flow only while the current connection holds the lane registration; otherwise the section drives a read.
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
      if (
        change.type !== 'section' ||
        change.section !== ('hostState' as never) ||
        change.key !== 'visualize' ||
        !client.store.appLive()
      )
        return;
      if (!notifications) resync();
    });
    const offEvents = client.on((incoming) => {
      if (incoming.type !== 'notification') return;
      const { method, params } = incoming.notification as { method: string; params?: unknown };
      if (method === 'thread/deleted') {
        const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
        if (typeof threadId === 'string') withoutRepeatedThumbnails.forget(threadId);
        return;
      }
      if (method !== 'visualize/changed') return;
      const event = remoteVisualizeEvent(assemble(params), withoutRepeatedThumbnails);
      if (event) emit(event);
    });
    const offLost = client.store.subscribe((change) => {
      if (change.type === 'subscription' && change.state === 'lost') withoutRepeatedThumbnails.forget(change.feedId);
    });
    unwire = () => {
      offLost();
      offStatus();
      offStore();
      offEvents();
    };
  };
  const off = host.onClient?.(wire);
  if (!off)
    void ctx.phone.start().then(
      () => wire(host.client()),
      () => undefined
    );
  return () => {
    off?.();
    unwire?.();
  };
}

export const adapter: PhoneProtocolAdapter = { group: 'visualize', calls, install };
