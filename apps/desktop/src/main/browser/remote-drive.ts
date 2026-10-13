/**
 * Phone-driven viewport: while a paired phone streams a session, its page
 * renders at the phone pane's size as a mobile page. Meanwhile the PC pane's
 * own size, zoom and viewport preset are only remembered; they come back when
 * the phone stops driving.
 */
import type { WebContents } from 'electron';

import type { DesktopBrowserViewportConfig, DesktopRemoteBrowserViewport } from '../../shared/contract';
import { MOBILE_CHROME_USER_AGENT } from '../../shared/remote-browser';

type Size = { width: number; height: number };

interface BrowserRemoteDriveHost {
  /** Size and zoom the page window the way the pane surface does. */
  setGeometry(guest: WebContents, size: Size | undefined, zoom: number | undefined): void;
  /** What the session's PC pane last asked for. */
  paneGeometry(sessionId: string): { size?: Size; zoom?: number };
  /** The pane's own viewport emulation path. */
  emulate(guest: WebContents, config: DesktopBrowserViewportConfig): Promise<void>;
  /** A phone started or stopped driving any page of the session. */
  drivingChanged?(sessionId: string, driving: boolean): void;
}

/** A pane that never chose a preset: no emulation, the default user agent. */
const PANE_DEFAULT_VIEWPORT: DesktopBrowserViewportConfig = {
  width: null,
  height: null,
  deviceScaleFactor: 1,
  mobile: false,
  touch: false,
  userAgent: null,
};

export function remoteDriveViewportConfig(viewport: DesktopRemoteBrowserViewport): DesktopBrowserViewportConfig {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: true,
    touch: true,
    userAgent: MOBILE_CHROME_USER_AGENT,
  };
}

/** A changed user agent reaches the server only on the next load. */
function reloadForUserAgent(guest: WebContents, from: string | null, to: string | null): void {
  if (from === to || guest.isDestroyed()) return;
  const url = guest.getURL();
  if (url && url !== 'about:blank') guest.reload();
}

export function createBrowserRemoteDrive(host: BrowserRemoteDriveHost) {
  /** The pane's latest viewport config per page, applied or held back. */
  const paneConfigs = new WeakMap<WebContents, DesktopBrowserViewportConfig>();
  /** Pages a phone drives, with the session that streams them. */
  const driven = new Map<WebContents, string>();
  const sessionDriven = (sessionId: string) => [...driven.values()].includes(sessionId);

  return {
    driven: (guest: WebContents): boolean => driven.has(guest),
    /** The pane's preset: remembered, and applied unless a phone drives the page. */
    async configurePane(guest: WebContents, config: DesktopBrowserViewportConfig): Promise<void> {
      paneConfigs.set(guest, config);
      if (!driven.has(guest)) await host.emulate(guest, config);
    },
    /** Size the page to the phone and emulate it as a mobile device. Called
     *  again for each new document, which does not keep the emulation. */
    async apply(sessionId: string, guest: WebContents, viewport: DesktopRemoteBrowserViewport): Promise<void> {
      if (guest.isDestroyed()) return;
      const first = !driven.has(guest);
      const announce = !sessionDriven(sessionId);
      driven.set(guest, sessionId);
      if (announce) host.drivingChanged?.(sessionId, true);
      host.setGeometry(guest, { width: viewport.width, height: viewport.height }, 1);
      await host.emulate(guest, remoteDriveViewportConfig(viewport));
      if (first) reloadForUserAgent(guest, paneConfigs.get(guest)?.userAgent ?? null, MOBILE_CHROME_USER_AGENT);
    },
    /** The phone stopped driving the page: the pane's size, zoom and preset return. */
    async restore(guest: WebContents): Promise<void> {
      const sessionId = driven.get(guest);
      if (sessionId === undefined) return;
      driven.delete(guest);
      try {
        if (guest.isDestroyed()) return;
        const pane = host.paneGeometry(sessionId);
        host.setGeometry(guest, pane.size, pane.zoom);
        const config = paneConfigs.get(guest) ?? PANE_DEFAULT_VIEWPORT;
        await host.emulate(guest, config);
        reloadForUserAgent(guest, MOBILE_CHROME_USER_AGENT, config.userAgent);
      } finally {
        if (!sessionDriven(sessionId)) host.drivingChanged?.(sessionId, false);
      }
    },
  };
}

export type BrowserRemoteDrive = ReturnType<typeof createBrowserRemoteDrive>;
