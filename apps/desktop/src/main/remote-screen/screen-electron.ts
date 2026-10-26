/**
 * Electron and OS pieces of the whole-PC screen source (Windows only): the
 * display list with each display's desktop-capture source id, the input
 * host process, and the on-PC indicator.
 *
 * The indicator is an OS notification posted from the main process (no
 * renderer UI): it names the phone and whether it views or controls, and a
 * click on it stops the session. It is posted again when control is granted or
 * withdrawn, and closed when the session ends.
 */
import { spawn } from 'node:child_process';

import { desktopCapturer, Notification, screen } from 'electron';

import { mixdogDataDirectory } from '../computer/shared/common';
import type { ScreenDisplay } from './screen-geometry';
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

/** The OS-notification indicator (see the header). */
export function createNotificationScreenIndicator(): ScreenIndicator {
  let view: { clientLabel: string; controlling: boolean; onStop: () => void } | null = null;
  let posted: Notification | null = null;
  const post = (): void => {
    posted?.close();
    posted = null;
    if (!view || !Notification.isSupported()) return;
    const current = view;
    const notification = new Notification({
      title: current.controlling ? 'Your phone is controlling this PC' : 'Your phone is viewing this PC',
      body: `${current.clientLabel} — click to stop.`,
      silent: true,
    });
    notification.on('click', () => {
      if (view === current) current.onStop();
    });
    notification.show();
    posted = notification;
  };
  return {
    show(next) {
      view = { ...next };
      post();
    },
    update({ controlling }) {
      if (!view || view.controlling === controlling) return;
      view = { ...view, controlling };
      post();
    },
    hide() {
      view = null;
      posted?.close();
      posted = null;
    },
  };
}
