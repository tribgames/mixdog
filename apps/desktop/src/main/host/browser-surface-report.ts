/**
 * A session's browser surface asked to show or hide, for the core
 * (`host/browser/surface`): the agent's `open`, hide and takeover hand-off
 * reach a paired phone through the core instead of the window process.
 * A failed open reveals nothing, so it is not reported.
 */
import type { HostBrowserSurfaceParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopBrowserOpenRequest } from '../../shared/contract-browser';
import type { HostConnection } from './connection';

export const HOST_BROWSER_SURFACE = 'host/browser/surface';

export interface BrowserSurfaceChange {
  sessionId: string;
  tabId?: string;
  surface: DesktopBrowserOpenRequest;
}

export interface BrowserSurfaceSource {
  onSurfaceChanged(listener: (change: BrowserSurfaceChange) => void): () => void;
}

/** Sends each surface change as `host/browser/surface`; returns the unsubscribe. */
export function registerBrowserSurfaceReport(connection: HostConnection, source: BrowserSurfaceSource): () => void {
  return source.onSurfaceChanged(({ sessionId, tabId, surface }) => {
    const params: HostBrowserSurfaceParams = { sessionId };
    if (surface.reveal !== undefined) params.reveal = surface.reveal;
    if (surface.hide !== undefined) params.hide = surface.hide;
    if (surface.handoff !== undefined) params.handoff = surface.handoff;
    const tab = tabId ?? surface.tabId;
    if (tab) params.tabId = tab;
    if (surface.title) params.title = surface.title;
    connection.notify(HOST_BROWSER_SURFACE, params);
  });
}
