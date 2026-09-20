// Desktop settings, zoom, the native title bar, capability calls, and quit.
import type { App, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC, type DesktopSettings } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { readOnboardingStatusFromDisk } from './onboarding-status-file';
import type { DesktopSettingsStore } from './settings-store';
import { setDesktopTitleBarDim, setDesktopTitleBarTheme, setDesktopTitleBarZoom } from './window-options';
import {
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredDesktopSettingKey,
  requiredString,
  requiredZoomFactor,
} from './ipc-validation';

type Handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

interface WindowSettingsIpcOptions {
  window: BrowserWindow;
  app: Pick<App, 'quit'>;
  host: Pick<DesktopService, 'invokeCapability' | 'readCapabilities' | 'getSnapshot' | 'dispose'>;
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  settingsStore?: Pick<DesktopSettingsStore, 'read' | 'update' | 'readZoom' | 'updateZoom'>;
  /** Fires after a successful desktop-settings write (keep-awake wiring). */
  onDesktopSettingsChanged?: (settings: DesktopSettings) => void;
}

export function registerWindowSettingsIpc({
  window,
  app,
  host,
  handle,
  invokeDesktopOperation,
  settingsStore,
  onDesktopSettingsChanged,
}: WindowSettingsIpcOptions): void {
  let quitPromise: Promise<void> | null = null;
  const applyZoom = (factor: number) => {
    window.webContents.setZoomFactor(factor);
    setDesktopTitleBarZoom(window, factor);
  };

  handle(DESKTOP_IPC.readSettings, () => settingsStore?.read() ?? invokeDesktopOperation('readSettings', []));
  handle(DESKTOP_IPC.updateSetting, (_event, key, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    const settingKey = requiredDesktopSettingKey(key);
    const update = settingsStore
      ? settingsStore.update(settingKey, enabled)
      : invokeDesktopOperation<DesktopSettings>('updateSetting', [settingKey, enabled]);
    return update.then((saved) => {
      onDesktopSettingsChanged?.(saved);
      return saved;
    });
  });
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
  handle(DESKTOP_IPC.applyTitleBarTheme, async (_event, theme, systemPreference) => {
    setDesktopTitleBarTheme(window, requiredString(theme, 'theme'), systemPreference === true);
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
  handle(DESKTOP_IPC.invokeCapability, async (_event, input) => {
    const request = requiredDesktopCapabilityRequest(input);
    if (request.capability === 'getOnboardingStatus' && !request.sessionId) {
      const status = await readOnboardingStatusFromDisk();
      if (status) return { value: status, snapshot: host.getSnapshot() };
    }
    return host.invokeCapability(request.capability, request.args, request.sessionId);
  });
  handle(DESKTOP_IPC.readCapabilities, (_event, input) =>
    host.readCapabilities(requiredDesktopCapabilityReadRequests(input))
  );
  handle(DESKTOP_IPC.quit, () => {
    quitPromise ??= (async () => {
      try {
        await host.dispose();
      } finally {
        app.quit();
      }
    })();
    return quitPromise;
  });
}
