import { type RefObject, useCallback, useRef } from 'react';
import type { DesktopBrowserHistoryEntry } from '../shared/contract';
import { normalizeAddressInput } from './browser-address';
import { reportBrowserLoadFailure } from './browser-load-failure';
import type { BrowserPageElement } from './browser-page-client';

/** Address navigation for the pane's page: `navigate` loads a typed address
 *  into the shown tab (true once handled, false while there is no view yet);
 *  `navigateRequested` may open it in a new tab first. */
export function useBrowserNavigation(
  webviewRef: RefObject<BrowserPageElement | null>,
  setAddress: (address: string) => void,
  setHistorySuggestions: (entries: DesktopBrowserHistoryEntry[]) => void,
  setPageFailure: (failure: null) => void
) {
  const navigate = useCallback(
    (rawInput: string) => {
      const url = normalizeAddressInput(rawInput);
      const view = webviewRef.current;
      // An empty address has nothing to wait for; a missing view does.
      if (!url) return true;
      if (!view) return false;
      setAddress(url);
      setHistorySuggestions([]);
      // A failed page parks the view; a new address must wake it, as Retry
      // does, or the load waits behind the parked view until the next one.
      setPageFailure(null);
      // loadURL throws synchronously while the guest is still attaching, and
      // rejects on user-aborted navigations; only other rejections are failures.
      try {
        void view.loadURL(url).catch(reportBrowserLoadFailure);
        view.focus();
      } catch {
        view.src = url;
      }
      return true;
    },
    [webviewRef, setAddress, setHistorySuggestions, setPageFailure]
  );

  const navigateRequested = useCallback(
    (url: string, newTab?: boolean, requestId?: string) => {
      const view = webviewRef.current;
      if (!newTab) return navigate(url);
      if (!view) return false;
      // The new tab becomes the shown page; load the address into it once created.
      view
        .createTab(requestId)
        .then(() => {
          navigate(url);
        })
        .catch(reportBrowserLoadFailure);
      return true;
    },
    [webviewRef, navigate]
  );
  return { navigate, navigateRequested };
}

/** A blank tab the person starts typing an address into is theirs now: the
 *  host must not close it as a leftover stand-in when the agent moves on. */
export function useBlankTabClaim(webviewRef: RefObject<BrowserPageElement | null>): () => void {
  const claimedBlankTab = useRef('');
  return useCallback(() => {
    const view = webviewRef.current;
    const tab = view?.getTabs().find((candidate) => candidate.active);
    if (!view || !tab || claimedBlankTab.current === tab.id) return;
    if (tab.url !== '' && tab.url !== 'about:blank') return;
    claimedBlankTab.current = tab.id;
    view.selectTab(tab.id).catch(() => {
      claimedBlankTab.current = '';
    });
  }, [webviewRef]);
}
