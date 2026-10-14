import type { WebContents } from 'electron';

import type { DesktopBrowserPageDialog, DesktopRemoteBrowserStreamFrame } from '../../shared/contract';
import type { PictureView } from './remote-stream';
import type { SessionTabStrip } from './tabs-close-result';

/** What a frame reports besides the page itself. */
export interface FrameFacts {
  tabs?: SessionTabStrip;
  dialog?(guest: WebContents): DesktopBrowserPageDialog | undefined;
}

/** Everything a frame reports besides pixels; a change pushes a frame. */
function pageSignature(facts: FrameFacts, guest: WebContents, documentId: string, sessionId: string): string {
  const history = guest.navigationHistory;
  return [
    JSON.stringify(facts.tabs?.list(sessionId) ?? []),
    documentId,
    guest.getURL(),
    guest.getTitle(),
    guest.isLoadingMainFrame(),
    history.canGoBack(),
    history.canGoForward(),
    facts.dialog?.(guest)?.id ?? '',
    guest.getZoomFactor(),
  ].join('\u0000');
}

/** What a client is told besides pixels: the page's facts and the picture
 *  described — a resize that retires the picture is news too. */
export function frameSignature(
  facts: FrameFacts,
  sessionId: string,
  guest: WebContents,
  documentId: string,
  view: PictureView
): string {
  const picture = [view.size.width, view.size.height, view.viewport.width, view.viewport.height].join('x');
  return `${pageSignature(facts, guest, documentId, sessionId)}\u0000${picture}`;
}

/** A page's document facts, and the picture `view` describes (0×0 for none)
 *  with `image` when one goes out with it. */
export function buildFrame(
  facts: FrameFacts,
  sessionId: string,
  seq: number,
  guest: WebContents,
  documentId: string,
  view: PictureView,
  image: DesktopRemoteBrowserStreamFrame['image']
): DesktopRemoteBrowserStreamFrame {
  const history = guest.navigationHistory;
  const dialog = facts.dialog?.(guest);
  return {
    sessionId,
    seq,
    frameId: `rbf_${seq.toString(36)}`,
    documentId,
    url: guest.getURL() || 'about:blank',
    title: guest.getTitle(),
    loading: guest.isLoadingMainFrame(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
    width: view.size.width,
    height: view.size.height,
    viewportWidth: view.viewport.width,
    viewportHeight: view.viewport.height,
    ...(facts.tabs ? { tabs: facts.tabs.list(sessionId) } : {}),
    ...(dialog ? { dialog } : {}),
    ...(image ? { image } : {}),
  };
}
