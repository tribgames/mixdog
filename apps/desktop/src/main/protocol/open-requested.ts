import type { UiNewTabCreatedParams, UiOpenRequestedParams } from '../../../../../packages/protocol/src/index.ts';
import type { ConnectionClientEvent } from './connection';

export const UI_OPEN_REQUESTED = 'ui/openRequested';

/** How many request ids are remembered; an id older than this many requests is not re-delivered by the core. */
const REMEMBERED_REQUESTS = 256;

export const UI_NEW_TAB_CREATED = 'ui/newTab/created';

type OpenOf<K extends UiOpenRequestedParams['kind']> = Omit<Extract<UiOpenRequestedParams, { kind: K }>, 'kind'>;

export interface OpenRequestedTargets {
  /** `browser-open-requested`: to the main window as `DESKTOP_IPC.browserOpenRequested`. */
  browser(request: OpenOf<'browser'>): void;
  /** The terminal run reveal: renderer windows receive it on their own core link; main does nothing with it. */
  terminal(request: OpenOf<'terminal'>): void;
  /** The visualize open: to the main window as `DESKTOP_IPC.visualizeChanged`. */
  visualize(event: OpenOf<'visualize'>): void;
  /** Watches for a new tab: resolves with the page id of the tab the pane made for `requestId`, else null. */
  watchNewTab(sessionId: string, requestId: string): { page: Promise<string | null> } | undefined;
  /** A client notification to the core. */
  notify(method: typeof UI_NEW_TAB_CREATED, params: UiNewTabCreatedParams): void;
}

export function createOpenRequestedHandler(targets: OpenRequestedTargets): (event: ConnectionClientEvent) => void {
  const delivered = new Set<string>();
  return (event) => {
    if (event.type !== 'notification') return;
    const { method, params } = (event as Extract<ConnectionClientEvent, { type: 'notification' }>).notification;
    if (method !== UI_OPEN_REQUESTED) return;
    const open = params as Partial<UiOpenRequestedParams> | undefined;
    const sessionId = open?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return;
    switch (open?.kind) {
      case 'browser': {
        const { kind: _kind, ...request } = open as Extract<UiOpenRequestedParams, { kind: 'browser' }>;
        targets.browser(request);
        return;
      }
      case 'terminal': {
        const { kind: _kind, ...request } = open as Extract<UiOpenRequestedParams, { kind: 'terminal' }>;
        targets.terminal(request);
        return;
      }
      case 'visualize': {
        const { kind: _kind, ...request } = open as Extract<UiOpenRequestedParams, { kind: 'visualize' }>;
        const id = request.openRequestId;
        if (id) {
          if (delivered.has(id)) return;
          delivered.add(id);
          if (delivered.size > REMEMBERED_REQUESTS) delivered.delete(delivered.values().next().value as string);
        }
        // Watch before asking the pane. The report goes out at most once, and only when the tab arrives: a request
        // that gets no tab sends nothing.
        if (id && request.openUrl) {
          void targets.watchNewTab(sessionId, id)?.page.then((pageId) => {
            if (pageId) targets.notify(UI_NEW_TAB_CREATED, { sessionId, openRequestId: id, pageId });
          });
        }
        targets.visualize(request);
        return;
      }
    }
  };
}
