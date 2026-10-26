/**
 * Phone-fitted viewport: while a paired phone takes over a session's page (or
 * asked to fit it), the page renders at the phone pane's CSS size and device
 * pixel ratio. Only the device metrics change — the user agent, mobile and
 * touch emulation and the agent's own overrides (locale, geolocation, headers,
 * …) stay, and nothing reloads — so a sign-in, CAPTCHA or one-time-code flow
 * keeps its state and a responsive page simply re-lays out in place. Mobile
 * emulation is kept as it is because switching it turns on meta-viewport
 * handling (a desktop-only page jumps to a zoomed-out layout); touch emulation
 * would flip pointer media queries. Meanwhile the PC pane's own size, zoom and
 * viewport preset are only remembered; they come back when the phone stops.
 */
import type { WebContents } from 'electron';

import type { DesktopBrowserViewportConfig, DesktopRemoteBrowserViewport } from '../../shared/contract';

type Size = { width: number; height: number };

interface BrowserRemoteDriveHost {
  /** Size and zoom the page window the way the pane surface does. */
  setGeometry(guest: WebContents, size: Size | undefined, zoom: number | undefined): void;
  /** What the session's PC pane last asked for. */
  paneGeometry(sessionId: string): { size?: Size; zoom?: number };
  /** The pane's own viewport emulation path (a preset: every domain). */
  emulate(guest: WebContents, config: DesktopBrowserViewportConfig): Promise<void>;
  /** Lay the phone's device metrics over the page, touching no other
   *  emulation domain; `unfitMetrics` restores exactly the metrics before. */
  fitMetrics(guest: WebContents, viewport: DesktopRemoteBrowserViewport): Promise<void>;
  unfitMetrics(guest: WebContents): Promise<void>;
  /** A phone started or stopped driving any page of the session. */
  drivingChanged?(sessionId: string, driving: boolean): void;
}

interface Driven {
  sessionId: string;
  /** The page's zoom before the fit, and the pane's zoom request then. */
  zoom: number;
  paneZoom: number | undefined;
}

export function createBrowserRemoteDrive(host: BrowserRemoteDriveHost) {
  /** A pane preset chosen while a phone drove the page: applied when it stops. */
  const heldPaneConfigs = new WeakMap<WebContents, DesktopBrowserViewportConfig>();
  /** Pages a phone drives. */
  const driven = new Map<WebContents, Driven>();
  const sessionDriven = (sessionId: string) => [...driven.values()].some((entry) => entry.sessionId === sessionId);

  return {
    driven: (guest: WebContents): boolean => driven.has(guest),
    /** The pane's preset: applied, or held back while a phone drives the page. */
    async configurePane(guest: WebContents, config: DesktopBrowserViewportConfig): Promise<void> {
      if (driven.has(guest)) heldPaneConfigs.set(guest, config);
      else await host.emulate(guest, config);
    },
    /** Size the page to the phone's metrics (a take-over's fit, or an explicit
     *  fit-client resize). Only the device metrics and the zoom (1, so the CSS
     *  viewport is the phone's) change: the user agent, mobile and touch
     *  emulation and every agent override stay, and nothing reloads. Called
     *  again for each new document. */
    async apply(sessionId: string, guest: WebContents, viewport: DesktopRemoteBrowserViewport): Promise<void> {
      if (guest.isDestroyed()) return;
      const announce = !sessionDriven(sessionId);
      if (!driven.has(guest)) {
        driven.set(guest, { sessionId, zoom: guest.getZoomFactor(), paneZoom: host.paneGeometry(sessionId).zoom });
      }
      if (announce) host.drivingChanged?.(sessionId, true);
      host.setGeometry(guest, { width: viewport.width, height: viewport.height }, 1);
      await host.fitMetrics(guest, viewport);
    },
    /** The phone stopped driving the page: the metrics and zoom before the
     *  fit come back, and the pane's size — still without a reload. A zoom or
     *  preset the pane chose meanwhile wins over the one before. */
    async restore(guest: WebContents): Promise<void> {
      const entry = driven.get(guest);
      if (!entry) return;
      const { sessionId } = entry;
      driven.delete(guest);
      const held = heldPaneConfigs.get(guest);
      heldPaneConfigs.delete(guest);
      try {
        if (guest.isDestroyed()) return;
        const pane = host.paneGeometry(sessionId);
        host.setGeometry(guest, pane.size, pane.zoom !== entry.paneZoom ? pane.zoom : entry.zoom);
        await host.unfitMetrics(guest);
        if (held) await host.emulate(guest, held);
      } finally {
        if (!sessionDriven(sessionId)) host.drivingChanged?.(sessionId, false);
      }
    },
  };
}

export type BrowserRemoteDrive = ReturnType<typeof createBrowserRemoteDrive>;
