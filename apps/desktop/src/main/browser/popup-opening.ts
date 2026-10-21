/**
 * A page's window.open: admission (URL policy and tab capacity), whether the
 * window comes forward (decided when Electron asks, from this window's gesture
 * evidence), and handing the created window to the lifecycle as a popup.
 */
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';

import type { BrowserGuestStateStore } from './guest-state';
import { pushBounded } from './guest-state';
import type { adoptBrowserPageWindow, createBrowserPageWindow } from './page-window';
import { popupTakesSelection, takeWindowOpenGesture } from './popup-focus';
import { assertBackgroundTabCapacity } from './tab-policy';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

export interface PopupOpeningHost {
  state: BrowserGuestStateStore;
  urlPolicy: BrowserUrlPolicy;
  backgroundCount(): number;
  /** Close idle agent pages before capacity is checked. */
  reclaimIdle(): void;
  /** Native presentation: a popup is a hosted page of its own. */
  nativeView(): boolean;
  popupWindowOptions(nativeView: boolean): Electron.BrowserWindowConstructorOptions;
  createPage: typeof createBrowserPageWindow;
  adoptWindow: typeof adoptBrowserPageWindow;
  adoptPopup(opener: WebContents, popup: { window: BaseWindow; guest: WebContents }, select: boolean): void;
}

export function handleWindowOpens(guest: WebContents, host: PopupOpeningHost): void {
  const { state, urlPolicy } = host;
  // Whether each window being opened comes forward, decided when Electron
  // asks for it: the gesture evidence is this window's and is used up then.
  const selections: Array<{ url: string; select: boolean }> = [];
  const decideSelection = (url: string, disposition: string) => {
    const record = state.peek(guest);
    const now = Date.now();
    const select = popupTakesSelection(disposition, {
      actor: record?.actor,
      userGesture: takeWindowOpenGesture(record, url, now),
      personDialogAnswerAt: record?.personDialogAnswerAt,
      now,
    });
    // A dialog answer stands for one window: the next one the page opens.
    if (record) record.personDialogAnswerAt = undefined;
    return select;
  };
  guest.setWindowOpenHandler(({ url, disposition }) => {
    try {
      if (url !== 'about:blank') normalizePageUrl(url, urlPolicy);
      host.reclaimIdle();
      assertBackgroundTabCapacity(host.backgroundCount());
      const select = decideSelection(url, disposition);
      if (host.nativeView()) {
        // A native page's popup is a hosted page of its own, so the pane can
        // present it like any tab. Electron then emits no did-create-window.
        return {
          action: 'allow',
          outlivesOpener: true,
          // Electron creates the popup's page from these before createWindow
          // adopts it, so its dialog setting must already be here.
          overrideBrowserWindowOptions: host.popupWindowOptions(true),
          createWindow: (options) => {
            const popup = host.createPage(
              host.popupWindowOptions(true),
              true,
              (options as { webContents?: WebContents }).webContents
            );
            setImmediate(() => host.adoptPopup(guest, popup, select));
            return popup.guest;
          },
        };
      }
      selections.push({ url, select });
      if (selections.length > 8) selections.shift();
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: host.popupWindowOptions(false),
      };
    } catch (error) {
      pushBounded(state.for(guest).networkFailures, `Blocked popup navigation: ${(error as Error).message}`);
      return { action: 'deny' };
    }
  });
  guest.on('did-create-window', (child: BrowserWindow, { url }) => {
    const index = selections.findIndex((entry) => entry.url === url);
    const select = index >= 0 ? selections.splice(index, 1)[0].select : false;
    host.adoptPopup(guest, { window: host.adoptWindow(child), guest: child.webContents }, select);
  });
}
