// The browser pane's page state (BrowserPane.lazy.tsx): what the guest page
// shows — address, load progress, history position, tabs, failure — and the
// guest events that keep it current.
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { DesktopBrowserHistoryEntry, DesktopBrowserTab } from '../shared/contract';
import type { BrowserPageElement } from './browser-page-client';
import { t } from './i18n';

type WebviewNavigationEvent = Event & { url?: string; isMainFrame?: boolean };
type WebviewLoadFailureEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
};
type WebviewRenderProcessGoneEvent = Event & {
  details?: { reason?: string; exitCode?: number };
};
export type BrowserPageFailure = {
  kind: 'load' | 'renderer' | 'unresponsive';
  title: string;
  detail: string;
};

/** Bridges one guest's page events onto the pane's state: navigation, load
 *  progress, the tab list, and the failure surface. Returns its own teardown
 *  so the caller effect stays a single wiring statement. */
export function watchBrowserPageEvents(
  view: BrowserPageElement,
  {
    addressFocused,
    agentViewports,
    refreshCredentialSuggestions,
    setAddress,
    setAddressHasFocus,
    setAgentViewport,
    setCanGoBack,
    setCanGoForward,
    setCredentialMenuOpen,
    setCredentialStatus,
    setCurrentUrl,
    setHistorySuggestions,
    setLoading,
    setPageFailure,
    setTabs,
  }: {
    addressFocused: { current: boolean };
    agentViewports: { current: Map<number, { width: number; height: number } | null> };
    refreshCredentialSuggestions(): void;
    setAddress(value: string): void;
    setAddressHasFocus(value: boolean): void;
    setAgentViewport(value: { width: number; height: number } | null): void;
    setCanGoBack(value: boolean): void;
    setCanGoForward(value: boolean): void;
    setCredentialMenuOpen(value: boolean): void;
    setCredentialStatus(value: 'idle' | 'success' | 'error'): void;
    setCurrentUrl(value: string): void;
    setHistorySuggestions(value: DesktopBrowserHistoryEntry[]): void;
    setLoading(value: boolean): void;
    setPageFailure: Dispatch<SetStateAction<BrowserPageFailure | null>>;
    setTabs(value: DesktopBrowserTab[]): void;
  }
) {
  const syncNavigationState = () => {
    // canGoBack/canGoForward throw until the guest finishes attaching.
    try {
      setCanGoBack(view.canGoBack());
      setCanGoForward(view.canGoForward());
    } catch {
      /* guest not ready yet */
    }
  };
  const onNavigate = (event: Event) => {
    const url = (event as WebviewNavigationEvent).url || '';
    const inPage = event.type === 'did-navigate-in-page' && (event as WebviewNavigationEvent).isMainFrame === false;
    if (inPage) {
      syncNavigationState();
      return;
    }
    const displayed = url === 'about:blank' ? '' : url;
    setCurrentUrl(displayed);
    setPageFailure(null);
    setCredentialMenuOpen(false);
    setCredentialStatus('idle');
    if (!addressFocused.current) setAddress(displayed);
    syncNavigationState();
    refreshCredentialSuggestions();
  };
  const onStartLoading = () => {
    setLoading(true);
    setPageFailure(null);
    setCredentialMenuOpen(false);
  };
  const onStopLoading = () => {
    setLoading(false);
    syncNavigationState();
    refreshCredentialSuggestions();
  };
  const onFinishLoading = () => setPageFailure(null);
  const onFailLoad = (event: Event) => {
    const failure = event as WebviewLoadFailureEvent;
    if (failure.isMainFrame === false || failure.errorCode === -3) return;
    setLoading(false);
    setPageFailure({
      kind: 'load',
      title: t('Failed to load page'),
      detail:
        `${failure.errorDescription || t('Network or site error')}` +
        `${failure.errorCode ? ` (${failure.errorCode})` : ''}`,
    });
  };
  const onRenderProcessGone = (event: Event) => {
    const details = (event as WebviewRenderProcessGoneEvent).details;
    setLoading(false);
    const exitCode = details?.exitCode ? ` (${details.exitCode})` : '';
    setPageFailure({
      kind: 'renderer',
      title: t('Browser crashed'),
      detail: details?.reason ? `${details.reason}${exitCode}` : t('The page renderer process exited.'),
    });
  };
  const onUnresponsive = () =>
    setPageFailure({
      kind: 'unresponsive',
      title: t('Page unresponsive'),
      detail: t('Wait or reload the page.'),
    });
  const onResponsive = () => setPageFailure((failure) => (failure?.kind === 'unresponsive' ? null : failure));
  // The host cleared the page's fault (crash mark, unresponsive, load failure).
  const onFaultCleared = () => setPageFailure(null);
  const syncTabs = () => setTabs(view.getTabs());
  const onAttach = () => {
    addressFocused.current = false;
    setAddressHasFocus(false);
    setAgentViewport(agentViewports.current.get(view.getWebContentsId()) ?? null);
    setPageFailure(null);
    setHistorySuggestions([]);
  };
  view.addEventListener('tabs-changed', syncTabs);
  view.addEventListener('did-attach', onAttach);
  syncTabs();
  view.addEventListener('did-navigate', onNavigate);
  view.addEventListener('did-navigate-in-page', onNavigate);
  view.addEventListener('did-start-loading', onStartLoading);
  view.addEventListener('did-stop-loading', onStopLoading);
  view.addEventListener('did-finish-load', onFinishLoading);
  view.addEventListener('did-fail-load', onFailLoad);
  view.addEventListener('render-process-gone', onRenderProcessGone);
  view.addEventListener('unresponsive', onUnresponsive);
  view.addEventListener('responsive', onResponsive);
  view.addEventListener('fault-cleared', onFaultCleared);
  return () => {
    view.removeEventListener('tabs-changed', syncTabs);
    view.removeEventListener('did-attach', onAttach);
    view.removeEventListener('did-navigate', onNavigate);
    view.removeEventListener('did-navigate-in-page', onNavigate);
    view.removeEventListener('did-start-loading', onStartLoading);
    view.removeEventListener('did-stop-loading', onStopLoading);
    view.removeEventListener('did-finish-load', onFinishLoading);
    view.removeEventListener('did-fail-load', onFailLoad);
    view.removeEventListener('render-process-gone', onRenderProcessGone);
    view.removeEventListener('unresponsive', onUnresponsive);
    view.removeEventListener('responsive', onResponsive);
    view.removeEventListener('fault-cleared', onFaultCleared);
  };
}

/** The page's state as the pane shows it. `addressFocused` mirrors focus
 *  synchronously, so a navigation never overwrites an address being typed. */
export function useBrowserPageState() {
  const addressFocused = useRef(false);
  const [address, setAddress] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState<DesktopBrowserTab[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [addressHasFocus, setAddressHasFocus] = useState(false);
  const [pageFailure, setPageFailure] = useState<BrowserPageFailure | null>(null);
  return {
    addressFocused,
    address,
    setAddress,
    currentUrl,
    setCurrentUrl,
    loading,
    setLoading,
    tabs,
    setTabs,
    canGoBack,
    setCanGoBack,
    canGoForward,
    setCanGoForward,
    addressHasFocus,
    setAddressHasFocus,
    pageFailure,
    setPageFailure,
  };
}

/** Keeps the page state in step with the attached guest's events. */
export function useBrowserPageEvents(
  webviewRef: RefObject<BrowserPageElement | null>,
  page: ReturnType<typeof useBrowserPageState>,
  {
    agentViewports,
    setAgentViewport,
    refreshCredentialSuggestions,
    setCredentialMenuOpen,
    setCredentialStatus,
    setHistorySuggestions,
  }: {
    agentViewports: { current: Map<number, { width: number; height: number } | null> };
    setAgentViewport(value: { width: number; height: number } | null): void;
    refreshCredentialSuggestions(): void;
    setCredentialMenuOpen(value: boolean): void;
    setCredentialStatus(value: 'idle' | 'success' | 'error'): void;
    setHistorySuggestions(value: DesktopBrowserHistoryEntry[]): void;
  }
) {
  const {
    addressFocused,
    setAddress,
    setAddressHasFocus,
    setCanGoBack,
    setCanGoForward,
    setCurrentUrl,
    setLoading,
    setPageFailure,
    setTabs,
  } = page;
  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return undefined;
    return watchBrowserPageEvents(view, {
      addressFocused,
      agentViewports,
      refreshCredentialSuggestions,
      setAddress,
      setAddressHasFocus,
      setAgentViewport,
      setCanGoBack,
      setCanGoForward,
      setCredentialMenuOpen,
      setCredentialStatus,
      setCurrentUrl,
      setHistorySuggestions,
      setLoading,
      setPageFailure,
      setTabs,
    });
  }, [
    webviewRef,
    addressFocused,
    agentViewports,
    refreshCredentialSuggestions,
    setAddress,
    setAddressHasFocus,
    setAgentViewport,
    setCanGoBack,
    setCanGoForward,
    setCredentialMenuOpen,
    setCredentialStatus,
    setCurrentUrl,
    setHistorySuggestions,
    setLoading,
    setPageFailure,
    setTabs,
  ]);
}
