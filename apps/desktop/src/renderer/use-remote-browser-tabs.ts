import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type { DesktopBrowserTab, DesktopRemoteBrowserTab } from '../shared/contract';
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
}: {
  api: typeof window.mixdogDesktop;
  active: boolean;
  /** The pane's own page; only a main-workspace page shows tabs. */
  sessionId: string;
  /** The page this client streams now. */
  streamId: string;
  setStreamId: Dispatch<SetStateAction<string>>;
  setActionFailure: Dispatch<SetStateAction<string>>;
}) {
  const [newTab, setNewTab] = useState(false);
  const [tabs, setTabs] = useState<DesktopRemoteBrowserTab[]>([]);
  // Only a main-workspace tab may roam over its siblings; a conversation's
  // dock page stays its own.
  const tabsSupported =
    sessionId.startsWith(MAIN_BROWSER_PAGE_PREFIX) && Boolean(api?.remoteBrowserTabs && api.onRemoteBrowserTabs);
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
      setStreamId(id);
    },
    [setStreamId]
  );
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
    () => tabs.map((tab) => ({ ...tab, active: tab.id === streamId, kind: 'page' })),
    [tabs, streamId]
  );

  return { newTab, setNewTab, tabs, tabsSupported, selectTab, openTab, closeTab, stripTabs };
}
