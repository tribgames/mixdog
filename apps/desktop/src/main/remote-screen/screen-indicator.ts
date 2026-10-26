/**
 * The Electron side of the remote-screen pill: the Computer Use pill's page,
 * surface and preload, in remote form (see screen-indicator-core for the
 * rules). The window is click-through outside the pill and never takes focus.
 */
import { app, BrowserWindow, screen } from 'electron';

import { overlayHtml, overlayScript } from '../computer/overlay/content';
import { hardenWindowSurface } from '../computer/overlay/cursor-surface';
import { registerComputerUseInternalWindow } from '../computer/overlay/internal-windows';
import { clipWindowToPill, type Rect } from '../computer/overlay/overlay-layout';
import { computerUsePillShown, onComputerUsePillShownChange } from '../computer/overlay/overlay-presence';
import { pillWindowOptions } from '../computer/overlay/overlay-windows';
import {
  createRemoteScreenIndicatorHost,
  handleRemoteIndicatorControl,
  type IndicatorWindow,
  type IndicatorWindowHandlers,
  type RemoteScreenIndicatorHandle,
  type RemoteScreenIndicatorOptions,
} from './screen-indicator-core';

export type { RemoteScreenIndicatorHandle, RemoteScreenIndicatorOptions } from './screen-indicator-core';

const REMOTE_ACCENT = '#30d158';

function openIndicatorWindow(bounds: Rect, handlers: IndicatorWindowHandlers): IndicatorWindow {
  const locale = app.getLocale();
  const next = new BrowserWindow({ ...pillWindowOptions(screen.getPrimaryDisplay()), ...bounds });
  const unregisterInternalWindow = registerComputerUseInternalWindow(next);
  next.setAlwaysOnTop(true, 'screen-saver');
  hardenWindowSurface(next);
  clipWindowToPill(next);
  next.webContents.on('will-navigate', (event) => event.preventDefault());
  const retire = (): void => {
    if (next.isDestroyed()) return;
    next.destroy();
  };
  next.on('unresponsive', retire);
  next.webContents.on('render-process-gone', retire);
  next.on('closed', () => {
    unregisterInternalWindow();
    handlers.gone();
  });
  next.webContents.ipc.handle('computer-overlay-control', async (event, request) => {
    if (event.sender !== next.webContents || event.senderFrame !== next.webContents.mainFrame) {
      throw new Error('Invalid overlay sender');
    }
    return await handleRemoteIndicatorControl(request, handlers.stop);
  });
  let revision = 0;
  let tooltip = '';
  const publish = (): void => {
    const view = { title: '', tooltip, accent: REMOTE_ACCENT, generation: 0, renderRevision: ++revision };
    const script = `window.mixdogComputerOverlay?.(${JSON.stringify(view).replaceAll('<', '\\u003c')})`;
    void next.webContents.executeJavaScript(script).catch(() => {});
  };
  const ready = (async () => {
    await next.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(locale, 'remote')).toString('base64')}`);
    await next.webContents.executeJavaScript(overlayScript(locale, 'remote'));
    if (next.isDestroyed()) return;
    publish();
    next.showInactive();
  })().catch(() => retire());
  return {
    setBounds(rect) {
      if (!next.isDestroyed()) next.setBounds(rect, false);
    },
    setTooltip(value) {
      tooltip = value;
      void ready.then(() => {
        if (!next.isDestroyed()) publish();
      });
    },
    destroy: retire,
  };
}

const host = createRemoteScreenIndicatorHost({
  displays: () => screen.getAllDisplays(),
  primaryDisplayId: () => screen.getPrimaryDisplay().id,
  createWindow: openIndicatorWindow,
  computerPillShown: computerUsePillShown,
  onComputerPillChange: onComputerUsePillShownChange,
  onDisplaysChange(listener) {
    const events = ['display-added', 'display-removed', 'display-metrics-changed'] as const;
    for (const event of events) screen.on(event as 'display-added', listener);
    return () => {
      for (const event of events) screen.off(event as 'display-added', listener);
    };
  },
});

/** Shows the remote pill (or adds this phone to the one already up). */
export function showRemoteScreenIndicator(options: RemoteScreenIndicatorOptions): RemoteScreenIndicatorHandle {
  return host.show(options);
}
