/**
 * What every new page is wired to as it appears: its state record, the host's
 * own watchers, injected page tweaks, navigation admission, document
 * tracking, window.open handling, fault reporting, and its debugger.
 */
import type { WebContents } from 'electron';

import type { BrowserGuestCdp } from './cdp';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { watchPageFaults } from './page-faults';
import { injectJsonViewerTweaks } from './page-json-viewer';
import { injectPageScrollbarCss } from './page-scrollbar-css';
import { type PopupOpeningHost, handleWindowOpens } from './popup-opening';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

/** When a page's debugger comes up — at once (`now`), at once for a page
 *  window.open is navigating (`opened`), or after a restored page's first
 *  document (`restored`). */
export type GuestAttach = 'now' | 'opened' | 'restored';

interface BrowserGuestInitializerHost {
  state: BrowserGuestStateStore;
  cdp: Pick<BrowserGuestCdp, 'guestDebugger' | 'attachOpenedPage'>;
  urlPolicy: BrowserUrlPolicy;
  onGuest?(guest: WebContents): void;
}

/** Navigation admission for one page: whatever the URL policy rejects is
 *  prevented and recorded where the page's own failures are reported. */
function blockUnsafeNavigation(
  state: BrowserGuestStateStore,
  urlPolicy: BrowserUrlPolicy,
  guest: WebContents
): (event: Electron.Event, url: string) => void {
  return (event, url) => {
    if (url === 'about:blank') return;
    try {
      normalizePageUrl(url, urlPolicy);
    } catch (error) {
      event.preventDefault();
      pushBounded(state.for(guest).networkFailures, `Blocked page navigation: ${(error as Error).message}`);
    }
  };
}

export function createBrowserGuestInitializer(host: BrowserGuestInitializerHost, popupOpening: PopupOpeningHost) {
  const { state, cdp, urlPolicy } = host;

  /** `attach`: when the page's debugger comes up (see GuestAttach). */
  function initializeGuest(guest: WebContents, attach: GuestAttach = 'now'): void {
    state.for(guest);
    host.onGuest?.(guest);
    injectPageScrollbarCss(guest);
    injectJsonViewerTweaks(guest);
    const blockNavigation = blockUnsafeNavigation(state, urlPolicy, guest);
    guest.on('will-navigate', blockNavigation);
    guest.on('will-redirect', blockNavigation);
    guest.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame) state.beginDocument(guest, isInPlace);
    });
    // Emitted only once a main-frame navigation commits a new document.
    guest.on('did-navigate', () => state.commitDocument(guest));
    handleWindowOpens(guest, popupOpening);
    watchPageFaults(state, guest);
    // Every page gets its debugger up front, agent bridge or not: a page
    // dialog only reaches the pane through it. A popup is attached at once
    // too, without the blank first load (its navigation is window.open's):
    // a dialog its first document opens while parsing would otherwise slip
    // past the bridge.
    if (attach === 'restored') {
      // A restored page commits its own blank document first; attaching
      // earlier would load about:blank over the URL being restored.
      guest.once('dom-ready', () => {
        if (!guest.isDestroyed()) attachDebuggerEagerly(guest);
      });
    } else attachDebuggerEagerly(guest, attach === 'opened');
  }

  /** Bring CDP up ahead of the first command; a failure is a page diagnostic,
   *  not a host error. */
  function attachDebuggerEagerly(guest: WebContents, openedByPage = false): void {
    void (openedByPage ? cdp.attachOpenedPage(guest) : cdp.guestDebugger(guest)).catch((error) =>
      state.for(guest).console.recordInternal(`CDP initialization failed: ${(error as Error).message}`)
    );
  }

  return { initializeGuest, attachDebuggerEagerly };
}
