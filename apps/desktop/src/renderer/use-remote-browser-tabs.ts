import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type { DesktopBrowserTab, DesktopRemoteBrowserControl, DesktopRemoteBrowserTab } from '../shared/contract';
import { MAIN_BROWSER_PAGE_PREFIX } from '../shared/contract-browser';
import { normalizeAddressInput } from './browser-address';
import { REMOTE_CONNECTION_READY_EVENT } from './use-remote-browser-stream';

/** Panes watching the tab list share one host-side watch per client. */
let tabWatchers = 0;

/** The host's sibling main-workspace tabs this pane may roam over: the watch,
 *  selection (which retargets the stream), and open/close. */
export function useRemoteBrowserTabs({
  api,
  active,
  sessionId,
  streamId,
  setStreamId,
  setActionFailure,
  frameTabs,
}: {
  api: typeof window.mixdogDesktop;
  active: boolean;
  /** The pane's own page; only a main-workspace page shows tabs. */
  sessionId: string;
  /** The page this client streams now. */
  streamId: string;
  setStreamId: Dispatch<SetStateAction<string>>;
  setActionFailure: Dispatch<SetStateAction<string>>;
  /** The conversation browser's own tab strip, as its stream frames carry it. */
  frameTabs?: DesktopBrowserTab[];
}) {
  const [newTab, setNewTab] = useState(false);
  const [tabs, setTabs] = useState<DesktopRemoteBrowserTab[]>([]);
  // Only a main-workspace tab may roam over its siblings; a conversation's
  // dock page stays its own.
  const tabsSupported =
    sessionId.startsWith(MAIN_BROWSER_PAGE_PREFIX) && Boolean(api?.remoteBrowserTabs && api.onRemoteBrowserTabs);
  // A conversation's browser keeps its tabs inside its own side-panel browser:
  // the host streams the strip and takes the same tab controls as the PC pane.
  const sessionTabsSupported =
    !sessionId.startsWith(MAIN_BROWSER_PAGE_PREFIX) &&
    api?.remoteBrowserSessionTabs === true &&
    Boolean(api.remoteBrowserControl);
  const sessionTabControl = useCallback(
    /** The host's reply (a close reports the tabs left), or null when it failed. */
    async (control: DesktopRemoteBrowserControl): Promise<{ remainingTabs?: number } | null> => {
      try {
        const reply = await api?.remoteBrowserControl?.(sessionId, control);
        return reply ?? {};
      } catch (error) {
        setActionFailure(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [api, sessionId, setActionFailure]
  );
  useEffect(() => {
    if (!active || !tabsSupported || !api?.remoteBrowserTabs || !api.onRemoteBrowserTabs) {
      setTabs([]);
      return undefined;
    }
    let live = true;
    const watch = () => {
      api.remoteBrowserTabs?.(true).then(
        (list) => {
          if (live) setTabs(list);
        },
        () => {}
      );
    };
    const unsubscribe = api.onRemoteBrowserTabs((list) => {
      if (live) setTabs(list);
    });
    tabWatchers += 1;
    watch();
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, watch);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, watch);
      tabWatchers -= 1;
      if (tabWatchers === 0) api.remoteBrowserTabs?.(false).catch(() => {});
    };
  }, [active, api, tabsSupported]);

  const selectTab = useCallback(
    (id: string) => {
      setNewTab(false);
      if (sessionTabsSupported) void sessionTabControl({ type: 'select-tab', tabId: id });
      else setStreamId(id);
    },
    [setStreamId, sessionTabsSupported, sessionTabControl]
  );
  const createSessionTab = () => sessionTabControl({ type: 'new-tab' });
  const closeSessionTab = (id: string) => sessionTabControl({ type: 'close-tab', tabId: id });
  const reportFailure = (error: unknown) => setActionFailure(error instanceof Error ? error.message : String(error));
  const openTab = async (raw: string) => {
    const url = normalizeAddressInput(raw);
    if (!url || !api?.remoteBrowserOpenTab) return;
    setNewTab(false);
    try {
      const tab = await api.remoteBrowserOpenTab(url);
      setTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
      selectTab(tab.id);
    } catch (error) {
      reportFailure(error);
    }
  };
  const closeTab = async (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0 || tabs.length < 2 || !api?.remoteBrowserCloseTab) return;
    // Leave the page before it is released, or the live stream would recreate it.
    if (id === streamId) selectTab((tabs[index + 1] ?? tabs[index - 1]).id);
    try {
      await api.remoteBrowserCloseTab(id);
      setTabs((current) => current.filter((tab) => tab.id !== id));
    } catch (error) {
      reportFailure(error);
    }
  };
  const stripTabs = useMemo<DesktopBrowserTab[]>(
    () =>
      sessionTabsSupported
        ? (frameTabs ?? [])
        : tabs.map((tab) => ({ ...tab, active: tab.id === streamId, kind: 'page' })),
    [tabs, streamId, sessionTabsSupported, frameTabs]
  );

  return {
    newTab,
    setNewTab,
    tabs,
    tabsSupported,
    sessionTabsSupported,
    selectTab,
    openTab,
    closeTab,
    createSessionTab,
    closeSessionTab,
    stripTabs,
  };
}
