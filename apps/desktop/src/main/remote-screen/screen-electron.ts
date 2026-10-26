/**
 * Electron and OS pieces of the whole-PC screen source (Windows only): the
 * display list with each display's desktop-capture source id, the input
 * host process, and the on-PC indicator.
 *
 * The indicator is the on-PC remote-control pill (screen-indicator.ts): one
 * pill for every phone, on the viewed display, whose Stop ends each session.
 * It names the phone in its tooltip; it does not distinguish viewing from
 * controlling.
 */
import { spawn } from 'node:child_process';

import { desktopCapturer, screen } from 'electron';

import { mixdogDataDirectory } from '../computer/shared/common';
import type { ScreenDisplay } from './screen-geometry';
import { showRemoteScreenIndicator, type RemoteScreenIndicatorHandle } from './screen-indicator';
import { createScreenInputHost, type ScreenInputHost } from './screen-input-host';
import type { ScreenDisplayProvider, ScreenIndicator } from './screen-source';

export interface ElectronScreenDisplays extends ScreenDisplayProvider {
  /** Re-reads the desktop-capture source ids (desktopCapturer is async). */
  refresh(): Promise<void>;
  dispose(): void;
}

/** The displays Electron reports; one without a known capture source is left
 *  out (it cannot be streamed). */
export function createElectronScreenDisplays(): ElectronScreenDisplays {
  let captureIds = new Map<string, string>();
  const listeners = new Set<() => void>();
  const refresh = async (): Promise<void> => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    captureIds = new Map(sources.filter((source) => source.display_id).map((source) => [source.display_id, source.id]));
  };
  const changed = (): void => {
    void refresh()
      .catch(() => undefined)
      .then(() => {
        for (const listener of [...listeners]) listener();
      });
  };
  const events = ['display-added', 'display-removed', 'display-metrics-changed'] as const;
  for (const event of events) screen.on(event as 'display-added', changed);
  return {
    list(): ScreenDisplay[] {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().flatMap((display, index) => {
        const screenId = String(display.id);
        const captureSourceId = captureIds.get(screenId);
        if (!captureSourceId) return [];
        return [
          {
            screenId,
            label: display.label || `Display ${index + 1}`,
            primary: display.id === primary,
            scaleFactor: display.scaleFactor,
            bounds: { ...display.bounds },
            physical: screen.dipToScreenRect(null, display.bounds),
            captureSourceId,
          },
        ];
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose() {
      for (const event of events) screen.off(event as 'display-added', changed);
      listeners.clear();
    },
  };
}

/** The input host in the owner-only app-data folder Computer Use's host uses. */
export function createElectronScreenInputHost(): ScreenInputHost {
  return createScreenInputHost({ directory: mixdogDataDirectory(), spawn });
}

/** One session's place on the remote-control pill (see the header). */
export function createPillScreenIndicator(): ScreenIndicator {
  let handle: RemoteScreenIndicatorHandle | null = null;
  return {
    show({ clientLabel, screenId, onStop }) {
      handle?.close();
      const displayId = Number(screenId);
      handle = showRemoteScreenIndicator({
        deviceLabel: clientLabel,
        onStop,
        // The Electron display id the session views (`String(display.id)`).
        ...(Number.isSafeInteger(displayId) ? { displayId } : {}),
      });
    },
    // The pill does not show viewing versus controlling.
    update: () => undefined,
    hide() {
      handle?.close();
      handle = null;
    },
  };
}
