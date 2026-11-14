// The window's own Electron settings that stay in main: the zoom factor, the native title bar, the notification sound preview and
// quit. The desktop settings, capability calls and the font list are requests of the window's own core connection.
import type { App, BrowserWindow } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopSettingsStore } from './settings-store';
import { setDesktopTitleBarDim, setDesktopTitleBarTheme, setDesktopTitleBarZoom } from './window-options';
import { requiredString, requiredZoomFactor } from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';

interface WindowSettingsIpcOptions {
  window: BrowserWindow;
  app: Pick<App, 'quit'>;
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  settingsStore?: Pick<DesktopSettingsStore, 'readZoom' | 'updateZoom'>;
  /** Settings → Notifications: play the notification sound at the saved volume. */
  previewNotificationSound?: () => Promise<string>;
}

export function registerWindowSettingsIpc({
  window,
  app,
  handle,
  invokeDesktopOperation,
  settingsStore,
  previewNotificationSound,
}: WindowSettingsIpcOptions): void {
  const applyZoom = (factor: number) => {
    window.webContents.setZoomFactor(factor);
    setDesktopTitleBarZoom(window, factor);
  };

  handle(DESKTOP_IPC.previewNotificationSound, () => previewNotificationSound?.() ?? 'unsupported');
  handle(DESKTOP_IPC.getZoomFactor, async () => {
    const factor = settingsStore
      ? await settingsStore.readZoom()
      : await invokeDesktopOperation<number>('readZoom', []);
    applyZoom(factor);
    return factor;
  });
  handle(DESKTOP_IPC.setZoomFactor, async (_event, value) => {
    const requested = requiredZoomFactor(value);
    const factor = settingsStore
      ? await settingsStore.updateZoom(requested)
      : await invokeDesktopOperation<number>('updateZoom', [requested]);
    applyZoom(factor);
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, factor);
    return factor;
  });
  // Renderer-resolved DESKTOP theme (system preference / stored preference)
  // is the only owner of the native band, caption symbols, and the DWM frame
  // theme. The engine/TUI theme is a separate user setting — the old
  // getTheme/setTheme capability hook let it overwrite this band with a
  // mismatched palette, so capabilities stay theme-neutral now.
  let appliedTheme: string | undefined;
  handle(DESKTOP_IPC.applyTitleBarTheme, async (_event, theme, systemPreference) => {
    const resolved = requiredString(theme, 'theme');
    setDesktopTitleBarTheme(window, resolved, systemPreference === true);
    // The first apply is the window booting; a later change is the user's choice,
    // which paired browsers without their own theme follow.
    const applied = `${resolved}|${systemPreference === true}`;
    const changed = appliedTheme !== undefined && appliedTheme !== applied;
    appliedTheme = applied;
    if (changed) void invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
  });
  // Fullscreen-modal dim for the native WCO caption band: the renderer sends
  // pre-composited hex colors; anything malformed clears back to the theme.
  handle(DESKTOP_IPC.setTitleBarDim, async (_event, dim) => {
    const record = (dim && typeof dim === 'object' ? dim : {}) as Record<string, unknown>;
    const hex = /^#[0-9a-f]{6}$/i;
    const valid =
      typeof record.color === 'string' &&
      hex.test(record.color) &&
      typeof record.symbolColor === 'string' &&
      hex.test(record.symbolColor);
    setDesktopTitleBarDim(
      window,
      valid ? { color: record.color as string, symbolColor: record.symbolColor as string } : null
    );
  });
  // before-quit owns the confirmation and the host teardown: disposing the
  // host here first would leave a cancelled quit with a dead service.
  handle(DESKTOP_IPC.quit, () => {
    app.quit();
  });
}
