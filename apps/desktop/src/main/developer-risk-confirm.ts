import type { BrowserWindow, IpcMainEvent } from 'electron';
import { HOST_CONFIRM_SURFACE_IPC, type HostConfirmSurfaceMessage } from '../shared/host-confirm-surface';
import { isAllowAllActionsEnable } from '../shared/remote-blocked-capabilities';
import { hostConfirmPageUrl, type HostConfirmText } from './host-confirm-page';
import { withHumanOnlyApproval } from './human-only-approval';

/** Opens the hidden, unloaded surface over `parent` (host-confirm-window.ts). */
export type OpenHostConfirmSurface = (parent: BrowserWindow) => BrowserWindow | Promise<BrowserWindow>;

const openRealSurface: OpenHostConfirmSurface = async (parent) =>
  (await import('./host-confirm-window')).openHostConfirmWindow(parent);

/** Centers the surface over the parent's content at the card's height, then shows it. */
function present(parent: BrowserWindow, surface: BrowserWindow, height?: number): void {
  if (parent.isDestroyed() || surface.isDestroyed()) return;
  const area = parent.getContentBounds();
  const current = surface.getBounds();
  const nextHeight = Math.min(Math.max(Math.ceil(height ?? current.height), 120), Math.max(area.height, 120));
  surface.setBounds({
    x: Math.round(area.x + (area.width - current.width) / 2),
    y: Math.round(area.y + (area.height - nextHeight) / 2),
    width: current.width,
    height: nextHeight,
  });
  if (!surface.isVisible()) surface.show();
}

/** Asks `text` on main's surface over `parent`; true only for the person's yes. */
async function askOnSurface(
  parent: BrowserWindow,
  text: HostConfirmText,
  openSurface: OpenHostConfirmSurface
): Promise<boolean> {
  if (parent.isDestroyed() || parent.webContents.isDestroyed()) return false;
  const parentContents = parent.webContents;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let surface: BrowserWindow | null = null;
    let detachSurface = () => {};
    const decline = () => finish(false);
    const onParentNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) decline();
    };
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      detachSurface();
      parentContents.removeListener('did-start-navigation', onParentNavigation as never);
      parentContents.removeListener('render-process-gone', decline);
      parentContents.removeListener('destroyed', decline);
      parent.removeListener('closed', decline);
      if (surface && !surface.isDestroyed()) surface.destroy();
      resolve(accepted);
    };
    // The asking window is watched from before the surface opens: leaving it meanwhile is a no.
    parentContents.on('did-start-navigation', onParentNavigation as never);
    parentContents.on('render-process-gone', decline);
    parentContents.once('destroyed', decline);
    parent.once('closed', decline);

    const ask = (opened: BrowserWindow) => {
      // Abandoned while it opened: the surface returned afterwards is closed unused.
      if (settled) {
        if (!opened.isDestroyed()) opened.destroy();
        return;
      }
      surface = opened;
      const contents = opened.webContents;
      let initialLoad = true;
      const onMessage = (event: IpcMainEvent, raw: unknown) => {
        if (event.senderFrame !== contents.mainFrame) return;
        const message = raw as Partial<HostConfirmSurfaceMessage> | null;
        if (message?.type === 'answer') finish((message as { accepted?: unknown }).accepted === true);
        else if (message?.type === 'size')
          present(parent, opened, Number((message as { height?: unknown }).height) || undefined);
      };
      // Only the page main loads; any later document (a reload) is a no.
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        if (initialLoad) initialLoad = false;
        else decline();
      };
      // A page whose preload never measured it still shows, at the default height.
      const onLoaded = () => {
        if (!opened.isDestroyed() && !opened.isVisible()) present(parent, opened);
      };
      detachSurface = () => {
        contents.ipc.removeListener(HOST_CONFIRM_SURFACE_IPC, onMessage);
        contents.removeListener('did-start-navigation', onNavigation as never);
        contents.removeListener('did-finish-load', onLoaded);
        contents.removeListener('preload-error', decline);
        contents.removeListener('render-process-gone', decline);
        opened.removeListener('unresponsive', decline);
        opened.removeListener('closed', decline);
      };
      contents.ipc.on(HOST_CONFIRM_SURFACE_IPC, onMessage);
      contents.on('did-start-navigation', onNavigation as never);
      contents.on('did-finish-load', onLoaded);
      contents.on('preload-error', decline);
      contents.on('render-process-gone', decline);
      opened.on('unresponsive', decline);
      opened.once('closed', decline);
      opened.loadURL(hostConfirmPageUrl(text)).catch(decline);
    };
    Promise.resolve()
      .then(() => openSurface(parent))
      .then(ask, decline);
  });
}

/** The person's confirmation to turn on "Allow all actions", resolved true only
 *  when they accept the risk. Text mirrors the runtime registry entry
 *  (src/runtime/shared/developer-options.mjs); a test keeps them equal. */
export function createAllowAllActionsConfirm(deps: {
  window: BrowserWindow;
  nativeT: (key: string) => string;
  openSurface?: OpenHostConfirmSurface;
}): () => Promise<boolean> {
  const { window, nativeT, openSurface = openRealSurface } = deps;
  return () =>
    withHumanOnlyApproval(() =>
      askOnSurface(
        window,
        {
          title: nativeT('Allow all actions'),
          description: nativeT(
            'Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk.'
          ),
          confirmLabel: nativeT('Accept risk and turn on'),
          cancelLabel: nativeT('Cancel'),
          danger: true,
        },
        openSurface
      )
    );
}

export { isAllowAllActionsEnable };
