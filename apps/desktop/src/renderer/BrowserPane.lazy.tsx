// One Chromium surface per conversation session on a shared persistent
// partition. Login survives and is shared; page, tab, and target state is not.
// The pane owns only the chrome; agent control lives in main/browser/host.ts.
import { browserNavLayout } from './browser-nav-layout';
import { useEffect, useRef, useState } from 'react';
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
  KeyRound,
  Link2,
  PanelTop,
  RotateCw,
  Smartphone,
  UserCheck,
  X,
} from 'lucide-react';
import { DockHeaderRow, DockOverflowMenu, requestPaneDockClose, type DockAction } from './pane-dock-chrome';
import { BrowserPageOverlays } from './browser-page-overlays';
import { useBlankTabClaim, useBrowserNavigation } from './browser-pane-navigation';
import { useBrowserZoom, useBrowserZoomSync } from './browser-pane-zoom';
import { useBrowserPageEvents, useBrowserPageState } from './browser-pane-page-state';
import {
  useBrowserAgentFollow,
  useBrowserFullscreen,
  useEscapeRestore,
  useMainTabPageReport,
} from './browser-pane-surface';
import { requestBrowserInMain } from './browser-main-request';
import { useBrowserRemoteDriving } from './browser-remote-drive';
import { isRemoteHostRenderer } from './remote-ui-projection';

import { t } from './i18n';
import { BrowserImportDialog } from './BrowserImportDialog';
import { BrowserSignInsDialog } from './BrowserSignInsDialog';
import { onBrowserImportRequested } from './browser-page-request';
import {
  BROWSER_VIEWPORT_PRESETS,
  readBrowserViewportPreset,
  resolveBrowserViewportPreset,
  writeBrowserViewportPreset,
  type BrowserViewportPreset,
  type BrowserViewportPresetId,
} from './browser-viewport-mode';
import { BrowserZoomPill } from './BrowserZoomPill';
import { useZoomBarVisible, zoomBarAction } from './zoom-bar-pref';
import { BrowserTabStrip } from './BrowserTabStrip';
import RemoteBrowserPane from './RemoteBrowserPane';
import { IsolatedBrowserView } from './IsolatedBrowserView';
import type { BrowserPageElement } from './browser-page-client';
import type { DesktopBrowserCredentialSuggestion, DesktopBrowserHistoryEntry } from '../shared/contract';
import './desktop/32-browser-pane.css';

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
  onUserEdit,
}: {
  address: string;
  addressRef: { current: HTMLInputElement | null };
  addressFocused: { current: boolean };
  currentUrl: string;
  historySuggestions: DesktopBrowserHistoryEntry[];
  navigate(rawInput: string): void;
  setAddress(value: string): void;
  setAddressHasFocus(value: boolean): void;
  /** The person clicked or typed in the field (not the pane focusing it). */
  onUserEdit(): void;
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
        onPointerDown={onUserEdit}
        onKeyDown={onUserEdit}
        onChange={(event) => {
          onUserEdit();
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
  onSignedInSites,
}: {
  /** "로그인 유지 중인 사이트"; absent where the host has no managed profile. */
  onSignedInSites?(): void;
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
  if (onSignedInSites) {
    actions.push({
      id: 'signed-in-sites',
      label: t('Signed-in sites'),
      icon: UserCheck,
      separatorBefore: true,
      onSelect: onSignedInSites,
    });
  }
  actions.push(zoomBarAction(true));
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
  const page = useBrowserPageState();
  const {
    addressFocused,
    address,
    setAddress,
    currentUrl,
    loading,
    tabs,
    canGoBack,
    canGoForward,
    addressHasFocus,
    setAddressHasFocus,
    pageFailure,
    setPageFailure,
  } = page;
  const [importOpen, setImportOpen] = useState(false);
  const [signInsOpen, setSignInsOpen] = useState(false);
  useEffect(() => onBrowserImportRequested(sessionId, () => setImportOpen(true)), [sessionId]);
  useBrowserAgentFollow(sessionId, webviewRef);
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
  // A streaming phone sizes the page meanwhile; the pane's preset returns after.
  const remoteDriving = useBrowserRemoteDriving(sessionId);
  useEscapeRestore(active && expanded && !importOpen, onToggleExpanded);
  const pageFullscreen = useBrowserFullscreen(sessionId);
  const { agentViewport, agentViewports, setAgentViewport } = useAgentViewport(sessionId, webviewRef);
  const frameWidth = agentViewport?.width ?? viewportPreset.width;
  const frameHeight = agentViewport?.height ?? viewportPreset.height;
  const fixedViewport = frameWidth !== null && frameHeight !== null;
  const { zoomLevel, changeZoomLevel } = useBrowserZoom(sessionId, webviewRef, addressRef);
  const { toolbarRef, toolbarWidth } = useToolbarWidth();
  const { contentRef, frameScale } = useFrameFit(frameWidth, frameHeight);
  useActiveGuestReport({ webviewRef, desktopApi, sessionId, active });

  useBrowserPageEvents(webviewRef, page, {
    agentViewports,
    setAgentViewport,
    refreshCredentialSuggestions,
    setCredentialMenuOpen,
    setCredentialStatus,
    setHistorySuggestions,
  });

  const configureViewportPreset = useViewportPresetConfigurator(webviewRef, desktopApi, sessionId);
  useBrowserZoomSync({ webviewRef, active, fixedViewport, viewportPreset, zoomLevel, configureViewportPreset });

  // A fresh, blank browser tab is for typing an address first.
  useEffect(() => {
    if (active && focusAddressOnActivate && !currentUrl) addressRef.current?.focus();
  }, [active, currentUrl, focusAddressOnActivate]);

  const { navigate, navigateRequested } = useBrowserNavigation(
    webviewRef,
    setAddress,
    setHistorySuggestions,
    setPageFailure
  );
  const claimBlankTab = useBlankTabClaim(webviewRef);
  useRequestedAddress(webviewRef, sessionId, navigateRequested);
  useInitialAddress(webviewRef, mainTab, initialUrl, navigate);
  const painted = useGuestPainted(webviewRef);

  const activeTabTitle = tabs.find((tab) => tab.active)?.title ?? '';
  useMainTabPageReport(mainTab, currentUrl, activeTabTitle, onPageChange);

  // Header ⋯ menu: everything that is not page navigation lives here.
  const navLayout = browserNavLayout(toolbarWidth, Boolean(desktopApi?.browserProfileImportSources));
  const zoomBarVisible = useZoomBarVisible();
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
    onSignedInSites: desktopApi?.browserSignedInSites ? () => setSignInsOpen(true) : undefined,
  });
  const frameTransform = frameScale < 1 ? `scale(${frameScale})` : undefined;
  const viewportFrameStyle = fixedViewport
    ? { width: `${frameWidth}px`, height: `${frameHeight}px`, transform: frameTransform }
    : undefined;
  return (
    <div
      className={`browser-pane${pageFullscreen ? ' is-page-fullscreen' : ''}`}
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
                // The host's count after the close decides, not the frame this
                // click was made from: tabs may have changed in between.
                const result = await webviewRef.current?.closeTab(id);
                if (result?.remainingTabs === 0) requestPaneDockClose('browser');
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
          onUserEdit: claimBlankTab,
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
      <BrowserSignInsDialog
        open={signInsOpen}
        onClose={() => setSignInsOpen(false)}
        onImport={
          desktopApi?.browserProfileImportSources
            ? () => {
                setSignInsOpen(false);
                setImportOpen(true);
              }
            : undefined
        }
      />
      <div className={`browser-pane-content${fixedViewport ? ' is-device-frame' : ''}`} ref={contentRef}>
        <div className="browser-pane-viewport" data-viewport-preset={viewportPreset.id} style={viewportFrameStyle}>
          <IsolatedBrowserView
            ref={(element) => {
              webviewRef.current = element;
            }}
            className={`browser-pane-webview${importOpen || signInsOpen ? ' is-import-open' : ''}${historySuggestions.length ? ' is-history-open' : ''}${credentialMenuOpen ? ' is-credential-open' : ''}${pageFailure ? ' is-failed' : ''}`}
            sessionId={sessionId}
            // A load failure only covers the page: the display keeps reading
            // it, so a navigation from anywhere else clears the failure.
            active={active && !importOpen && !signInsOpen}
            native={!fixedViewport}
          />
          <BrowserPageOverlays
            painted={painted}
            pageFailure={pageFailure}
            currentUrl={currentUrl}
            initialUrl={initialUrl}
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
        {currentUrl && zoomBarVisible && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
        {remoteDriving && (
          <div className="browser-pane-remote-driving" role="status">
            <Smartphone size={13} aria-hidden="true" />
            <span>{t('Controlled from phone')}</span>
          </div>
        )}
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
