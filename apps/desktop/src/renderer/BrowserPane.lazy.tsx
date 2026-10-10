// One Chromium surface per conversation session on a shared persistent
// partition. Login survives and is shared; page, tab, and target state is not.
// The pane owns only the chrome; agent control lives in main/browser/host.ts.
import { browserNavLayout } from './browser-nav-layout';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import {
  useActiveGuestReport,
  useAgentViewport,
  useBrowserCredentials,
  useFrameFit,
  useGuestPainted,
  useHistorySuggestions,
  useInitialAddress,
  useRequestedAddress,
  useToolbarWidth,
  useViewportPresetConfigurator,
} from './browser-pane-hooks';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  PanelTop,
  RotateCw,
  Smartphone,
  X,
} from 'lucide-react';
import { DockHeaderRow, DockOverflowMenu, requestPaneDockClose, type DockAction } from './pane-dock-chrome';
import { requestBrowserInMain } from './browser-main-request';
import { isRemoteHostRenderer } from './remote-ui-projection';

import { t } from './i18n';
import { reportBrowserLoadFailure } from './browser-load-failure';
import { ErrorNotice } from './ErrorNotice';
import { normalizeAddressInput } from './browser-address';
import { BrowserImportDialog } from './BrowserImportDialog';
import { BrowserLoadingPlaceholder } from './BrowserLoadingPlaceholder';
import { watchBrowserForegroundReturns } from './browser-foreground-lifecycle';
import {
  BROWSER_VIEWPORT_PRESETS,
  browserViewportZoom,
  readBrowserViewportPreset,
  resolveBrowserViewportPreset,
  writeBrowserViewportPreset,
  type BrowserViewportPreset,
  type BrowserViewportPresetId,
} from './browser-viewport-mode';
import { readBrowserZoom, writeBrowserZoom } from './browser-zoom-level';
import { BrowserZoomPill } from './BrowserZoomPill';
import { BrowserTabStrip } from './BrowserTabStrip';
import RemoteBrowserPane from './RemoteBrowserPane';
import { IsolatedBrowserView } from './IsolatedBrowserView';
import type { BrowserPageElement } from './browser-page-client';
import type {
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserHistoryEntry,
  DesktopBrowserTab,
} from '../shared/contract';
import './desktop/32-browser-pane.css';

type WebviewNavigationEvent = Event & { url?: string; isMainFrame?: boolean };
type WebviewLoadFailureEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  isMainFrame?: boolean;
};
type WebviewRenderProcessGoneEvent = Event & {
  details?: { reason?: string; exitCode?: number };
};
type BrowserPageFailure = {
  kind: 'load' | 'renderer' | 'unresponsive';
  title: string;
  detail: string;
};

export { normalizeAddressInput } from './browser-address';

export interface BrowserPaneProps {
  sessionId: string;
  active: boolean;
  foreground: boolean;
  parked?: boolean;
  focusAddressOnActivate?: boolean;
  expanded?: boolean;
  onToggleExpanded?(): void;
  /** `main`: a user-only page in a main workspace tab. The tab strip is its
   *  header, so there is no dock header row; ⋯ moves to the nav row. */
  mode?: 'dock' | 'main';
  /** Main tab: the last known address, opened when the page has none (a new
   *  tab, or a restart that lost the live page). */
  initialUrl?: string;
  /** Main tab: the page's current address and title, for persistence. */
  onPageChange?(url: string, title: string): void;
}

/** Bridges one guest's page events onto the pane's state: navigation, load
 *  progress, the tab list, and the failure surface. Returns its own teardown
 *  so the caller effect stays a single wiring statement. */
function watchBrowserPageEvents(
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
  };
}

/** Keeps the guest's zoom factor in step with the surface: the preset
 *  baseline, the user's zoom, pane resizes and foreground returns. Returns
 *  its own teardown. */
function startBrowserZoomSync({
  view,
  desiredZoom,
  fixedViewport,
  viewportPreset,
  zoomLevel,
  configureViewportPreset,
}: {
  view: BrowserPageElement;
  desiredZoom: { current: number };
  fixedViewport: boolean;
  viewportPreset: BrowserViewportPreset;
  zoomLevel: number;
  configureViewportPreset(preset: BrowserViewportPreset, reload: boolean): Promise<boolean>;
}) {
  let disposed = false;
  let restoreFrame = 0;
  const applyZoom = () => {
    try {
      view.setZoomFactor(desiredZoom.current);
    } catch {
      /* guest not attached yet; dom-ready reapplies */
    }
  };
  const syncZoom = (force = false) => {
    const zoom = fixedViewport ? zoomLevel : browserViewportZoom(viewportPreset, view.clientWidth, zoomLevel);
    const changed = Math.abs(zoom - desiredZoom.current) >= 0.01;
    if (changed) desiredZoom.current = zoom;
    if (changed || force) applyZoom();
  };
  const configureGuest = async () => {
    const configured = await configureViewportPreset(viewportPreset, false);
    if (!disposed && configured) syncZoom(true);
  };
  const restoreVisibleGuest = () => {
    window.cancelAnimationFrame(restoreFrame);
    restoreFrame = window.requestAnimationFrame(() => syncZoom(true));
  };
  const observer = new ResizeObserver(() => syncZoom());
  observer.observe(view);
  const stopForegroundReturnReporting = watchBrowserForegroundReturns(window, document, restoreVisibleGuest);
  const onGuestReady = () => void configureGuest();
  view.addEventListener('did-attach', onGuestReady);
  view.addEventListener('dom-ready', onGuestReady);
  view.addEventListener('did-navigate', applyZoom);
  void configureGuest();
  return () => {
    disposed = true;
    window.cancelAnimationFrame(restoreFrame);
    stopForegroundReturnReporting();
    observer.disconnect();
    view.removeEventListener('did-attach', onGuestReady);
    view.removeEventListener('dom-ready', onGuestReady);
    view.removeEventListener('did-navigate', applyZoom);
  };
}

/** Address entry and its history completions: the one toolbar control whose
 *  value follows the guest only while the field is unfocused. */
function browserAddressField({
  address,
  addressRef,
  addressFocused,
  currentUrl,
  historySuggestions,
  navigate,
  setAddress,
  setAddressHasFocus,
}: {
  address: string;
  addressRef: { current: HTMLInputElement | null };
  addressFocused: { current: boolean };
  currentUrl: string;
  historySuggestions: DesktopBrowserHistoryEntry[];
  navigate(rawInput: string): void;
  setAddress(value: string): void;
  setAddressHasFocus(value: boolean): void;
}) {
  return (
    <form
      className="browser-pane-address-form"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(address);
      }}
    >
      <input
        ref={addressRef}
        className="browser-pane-address"
        type="text"
        value={address}
        spellCheck={false}
        placeholder={t('Search or enter address')}
        aria-label={t('Address bar')}
        onChange={(event) => {
          setAddress(event.target.value);
        }}
        onFocus={(event) => {
          addressFocused.current = true;
          setAddressHasFocus(true);
          event.target.select();
        }}
        onBlur={() => {
          addressFocused.current = false;
          setAddressHasFocus(false);
          if (currentUrl) setAddress(currentUrl);
        }}
      />
      {historySuggestions.length > 0 && (
        <div className="browser-pane-history-suggestions">
          {historySuggestions.map((entry) => (
            <button
              type="button"
              key={entry.url}
              onMouseDown={(event) => {
                event.preventDefault();
                navigate(entry.url);
                setAddressHasFocus(false);
              }}
            >
              <span>{entry.title || entry.url}</span>
              <code>{entry.url}</code>
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** Stored-credential affordance: one suggestion fills straight away, several
 *  open a menu, and the button itself reports the outcome of the last fill. */
export function browserHeaderActions({
  currentUrl,
  viewportPresetId,
  selectViewportPreset,
  credentialSuggestions,
  credentialBusy,
  credentialStatus,
  fillStoredCredential,
  onOpenInMain,
}: {
  currentUrl: string;
  viewportPresetId: BrowserViewportPresetId;
  selectViewportPreset(preset: BrowserViewportPreset): void;
  /** Absent where a main browser tab does not exist (main tab itself, phone). */
  onOpenInMain?(): void;
  credentialSuggestions: DesktopBrowserCredentialSuggestion[];
  credentialBusy: boolean;
  credentialStatus: 'idle' | 'success' | 'error';
  fillStoredCredential(credentialId: string): void;
}): DockAction[] {
  const actions: DockAction[] = [
    { id: 'device-heading', label: t('Device view'), icon: Smartphone, disabled: true, onSelect() {} },
    ...BROWSER_VIEWPORT_PRESETS.map((preset) => ({
      id: `device-${preset.id}`,
      label: preset.label,
      checked: preset.id === viewportPresetId,
      onSelect: () => selectViewportPreset(preset),
    })),
    {
      id: 'open-external',
      label: t('Open in system browser'),
      icon: ExternalLink,
      separatorBefore: true,
      // A visible header button just left of ⋯; folds into the menu only when
      // the row is too narrow (priority 'open-external').
      disabled: !currentUrl,
      onSelect: () => void window.mixdogDesktop?.openExternal(currentUrl),
    },
  ];
  if (onOpenInMain) {
    actions.push({
      id: 'open-main',
      label: t('Open in main tab'),
      icon: PanelTop,
      disabled: !currentUrl,
      onSelect: onOpenInMain,
    });
  }
  let credentialLabel = t('Fill with stored credentials');
  if (credentialStatus === 'success') credentialLabel = t('Filled stored credentials');
  else if (credentialStatus === 'error') credentialLabel = t('Could not fill stored credentials');
  for (const [index, credential] of credentialSuggestions.entries()) {
    actions.push({
      id: `credential-${credential.id}`,
      label:
        credentialSuggestions.length === 1
          ? credentialLabel
          : `${t('Fill with stored credentials')}: ${credential.label}`,
      icon: KeyRound,
      separatorBefore: index === 0,
      disabled: credentialBusy,
      onSelect: () => fillStoredCredential(credential.id),
    });
  }
  return actions;
}

function DesktopBrowserPane({
  sessionId,
  active,
  parked = false,
  focusAddressOnActivate = true,
  expanded = false,
  onToggleExpanded,
  mode = 'dock',
  initialUrl,
  onPageChange,
}: BrowserPaneProps) {
  const mainTab = mode === 'main';
  const webviewRef = useRef<BrowserPageElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const addressFocused = useRef(false);
  const [address, setAddress] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState<DesktopBrowserTab[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [addressHasFocus, setAddressHasFocus] = useState(false);
  const [pageFailure, setPageFailure] = useState<BrowserPageFailure | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [viewportPresetId, setViewportPresetId] = useState<BrowserViewportPresetId>(
    () => readBrowserViewportPreset(window.localStorage, sessionId).id
  );
  const desktopApi = window.mixdogDesktop;
  const {
    credentialBusy,
    credentialMenuOpen,
    credentialStatus,
    credentialSuggestions,
    fillStoredCredential,
    refreshCredentialSuggestions,
    setCredentialMenuOpen,
    setCredentialStatus,
  } = useBrowserCredentials(desktopApi, sessionId);
  const { historySuggestions, setHistorySuggestions } = useHistorySuggestions(desktopApi, address, addressHasFocus);
  const viewportPreset = resolveBrowserViewportPreset(viewportPresetId);
  useEffect(() => {
    if (!active || !expanded || !onToggleExpanded || importOpen) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      onToggleExpanded();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [active, expanded, onToggleExpanded, importOpen]);
  const { agentViewport, agentViewports, setAgentViewport } = useAgentViewport(sessionId, webviewRef);
  const frameWidth = agentViewport?.width ?? viewportPreset.width;
  const frameHeight = agentViewport?.height ?? viewportPreset.height;
  const fixedViewport = frameWidth !== null && frameHeight !== null;
  // User zoom on top of the surface baseline (auto-fit factor, or 1 inside a
  // device frame). Page zoom in both modes: inside a frame the page grows and
  // scrolls within it, the way a phone's own browser zooms.
  const [zoomLevel, setZoomLevel] = useState(() => readBrowserZoom(window.localStorage, sessionId));
  const changeZoomLevel = useCallback(
    (level: number) => {
      setZoomLevel(writeBrowserZoom(window.localStorage, sessionId, level));
    },
    [sessionId]
  );
  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    const shortcut = (event: Event) => {
      const action = (event as Event & { shortcut: string }).shortcut;
      if (action === 'address') {
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (['zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) {
        const zoomFactor = action === 'zoom-in' ? 1.1 : 1 / 1.1;
        setZoomLevel((previous) =>
          writeBrowserZoom(window.localStorage, sessionId, action === 'zoom-reset' ? 1 : previous * zoomFactor)
        );
      }
    };
    view.addEventListener('browser-shortcut', shortcut);
    return () => view.removeEventListener('browser-shortcut', shortcut);
  }, [sessionId]);
  const { toolbarRef, toolbarWidth } = useToolbarWidth();
  const { contentRef, frameScale } = useFrameFit(frameWidth, frameHeight);
  useActiveGuestReport({ webviewRef, desktopApi, sessionId, active });

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
    agentViewports,
    refreshCredentialSuggestions,
    setAgentViewport,
    setCredentialMenuOpen,
    setCredentialStatus,
    setHistorySuggestions,
  ]);

  const configureViewportPreset = useViewportPresetConfigurator(webviewRef, desktopApi, sessionId);

  // Normal browsing preserves the user's zoom as the pane resizes. Fit is an
  // explicit mode; device presets retain their actual UA/touch/device metrics.
  const desiredZoom = useRef(1);
  useEffect(() => {
    if (!active) return undefined;
    const view = webviewRef.current;
    if (!view) return undefined;
    return startBrowserZoomSync({
      view,
      desiredZoom,
      fixedViewport,
      viewportPreset,
      zoomLevel,
      configureViewportPreset,
    });
  }, [active, configureViewportPreset, fixedViewport, viewportPreset, zoomLevel]);

  // A fresh, blank browser tab is for typing an address first.
  useEffect(() => {
    if (active && focusAddressOnActivate && !currentUrl) addressRef.current?.focus();
  }, [active, currentUrl, focusAddressOnActivate]);

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
    [setHistorySuggestions]
  );

  useRequestedAddress(webviewRef, sessionId, navigate);
  useInitialAddress(webviewRef, mainTab, initialUrl, navigate);
  const painted = useGuestPainted(webviewRef);

  const activeTabTitle = tabs.find((tab) => tab.active)?.title ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: onPageChange is a fresh callback per parent render; the page reports only when its address or title changes.
  useEffect(() => {
    if (mainTab && currentUrl) onPageChange?.(currentUrl, activeTabTitle);
  }, [mainTab, currentUrl, activeTabTitle]);

  // Header ⋯ menu: everything that is not page navigation lives here.
  const navLayout = browserNavLayout(toolbarWidth, Boolean(desktopApi?.browserProfileImportSources));
  const headerActions = browserHeaderActions({
    currentUrl,
    viewportPresetId,
    selectViewportPreset: (preset) => {
      void configureViewportPreset(preset, true).then((configured) => {
        if (!configured) return;
        writeBrowserViewportPreset(window.localStorage, sessionId, preset.id);
        setViewportPresetId(preset.id);
      });
    },
    credentialSuggestions,
    credentialBusy,
    credentialStatus,
    fillStoredCredential,
    onOpenInMain:
      mainTab || isRemoteHostRenderer()
        ? undefined
        : () => requestBrowserInMain({ sessionId, url: currentUrl, title: activeTabTitle }),
  });
  const frameTransform = frameScale < 1 ? `scale(${frameScale})` : undefined;
  const viewportFrameStyle = fixedViewport
    ? { width: `${frameWidth}px`, height: `${frameHeight}px`, transform: frameTransform }
    : undefined;
  return (
    <div
      className="browser-pane"
      data-pane-instance={sessionId}
      data-browser-mode={mode}
      data-surface-active={active || parked ? 'true' : 'false'}
    >
      {!mainTab && (
        <DockHeaderRow
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
          expandLabel={t('Expand browser')}
          restoreLabel={t('Restore browser')}
          onClose={() => requestPaneDockClose('browser')}
          actions={headerActions}
          left={
            <BrowserTabStrip
              tabs={tabs}
              onSelect={async (id) => {
                await webviewRef.current?.selectTab(id);
              }}
              onClose={async (id) => {
                await webviewRef.current?.closeTab(id);
              }}
              onCreate={async () => {
                await webviewRef.current?.createTab();
                addressRef.current?.focus();
              }}
            />
          }
        />
      )}
      <div className="browser-pane-toolbar" ref={toolbarRef}>
        <button
          type="button"
          className="browser-pane-nav-button"
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
          aria-label={t('Back')}
          data-tooltip={t('Back')}
        >
          <ArrowLeft size={15} />
        </button>
        {navLayout.forward && (
          <button
            type="button"
            className="browser-pane-nav-button"
            disabled={!canGoForward}
            onClick={() => webviewRef.current?.goForward()}
            aria-label={t('Forward')}
            data-tooltip={t('Forward')}
          >
            <ArrowRight size={15} />
          </button>
        )}
        <button
          type="button"
          className="browser-pane-nav-button"
          onClick={() => {
            const view = webviewRef.current;
            if (!view) return;
            if (loading) view.stop();
            else if (currentUrl) view.reload();
            else navigate(address);
          }}
          aria-label={loading ? t('Stop loading') : t('Reload')}
          data-tooltip={loading ? t('Stop loading') : t('Reload')}
        >
          {loading ? <X size={15} /> : <RotateCw size={15} />}
        </button>
        {browserAddressField({
          address,
          addressRef,
          addressFocused,
          currentUrl,
          historySuggestions,
          navigate,
          setAddress,
          setAddressHasFocus,
        })}
        {navLayout.import && (
          <button
            type="button"
            className="browser-pane-nav-button browser-pane-import-button"
            onClick={() => setImportOpen(true)}
            aria-label={t('Import from browser')}
            data-tooltip={t('Import from browser')}
          >
            <Link2 size={15} />
          </button>
        )}
        {mainTab && <DockOverflowMenu items={headerActions} />}
      </div>
      {mainTab && tabs.length > 1 && (
        <div className="browser-pane-popup-tabs">
          <BrowserTabStrip
            tabs={tabs}
            onSelect={async (id) => {
              await webviewRef.current?.selectTab(id);
            }}
            onClose={async (id) => {
              await webviewRef.current?.closeTab(id);
            }}
          />
        </div>
      )}
      <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <div className={`browser-pane-content${fixedViewport ? ' is-device-frame' : ''}`} ref={contentRef}>
        <div className="browser-pane-viewport" data-viewport-preset={viewportPreset.id} style={viewportFrameStyle}>
          <IsolatedBrowserView
            ref={(element) => {
              webviewRef.current = element;
            }}
            className={`browser-pane-webview${importOpen ? ' is-import-open' : ''}${historySuggestions.length ? ' is-history-open' : ''}${credentialMenuOpen ? ' is-credential-open' : ''}${pageFailure ? ' is-failed' : ''}`}
            sessionId={sessionId}
            active={active && !importOpen && !pageFailure}
            native={!fixedViewport}
          />
          {/* about:blank paints Chromium's default white; until a real page is
            committed the pane stays in the app theme instead. */}
          {!painted && !pageFailure && <BrowserLoadingPlaceholder url={currentUrl || initialUrl || ''} />}
          {painted && !currentUrl && (
            <div className="browser-pane-empty" aria-hidden="true">
              <Globe size={28} />
              <span>{t('Search or enter address')}</span>
            </div>
          )}
          {pageFailure && (
            <div className="browser-pane-failure">
              <ErrorNotice
                error={pageFailure.detail}
                title={pageFailure.title}
                role="status"
                onRetry={() => {
                  const view = webviewRef.current;
                  setPageFailure(null);
                  if (!view) return;
                  try {
                    view.reload();
                  } catch {
                    navigate(currentUrl || address);
                  }
                }}
              />
            </div>
          )}
        </div>
        {currentUrl && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
      </div>
    </div>
  );
}

export default function BrowserPane(props: BrowserPaneProps) {
  if (typeof window.mixdogDesktop?.remoteBrowserStream === 'function') {
    return <RemoteBrowserPane {...props} />;
  }
  return <DesktopBrowserPane {...props} />;
}
