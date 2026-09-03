// One Chromium surface per conversation session on a shared persistent
// partition. Login survives and is shared; page, tab, and target state is not.
// The pane owns only the chrome; agent control lives in main/browser/host.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  LoaderCircle,
  RotateCw,
  Smartphone,
  X,
} from "lucide-react";

import { t } from "./i18n";
import { normalizeAddressInput } from "./browser-address";
import { BrowserImportDialog } from "./BrowserImportDialog";
import {
  scheduleBrowserForegroundRepaint,
  watchBrowserForegroundReturns,
} from "./browser-foreground-lifecycle";
import {
  BROWSER_VIEWPORT_PRESETS,
  browserAutoFitZoom,
  browserViewportEmulation,
  readBrowserViewportPreset,
  resolveBrowserViewportPreset,
  writeBrowserViewportPreset,
  type BrowserViewportPreset,
  type BrowserViewportPresetId,
} from "./browser-viewport-mode";
import { readBrowserZoom, writeBrowserZoom } from "./browser-zoom-level";
import { BrowserZoomPill } from "./BrowserZoomPill";
import { OpenSelect } from "./OpenSelect";
import RemoteBrowserPane from "./RemoteBrowserPane";
import type {
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserHistoryEntry,
} from "../shared/contract";
import "./desktop/32-browser-pane.css";

/** Shared persistent guest partition; main/browser/host.ts matches guests by
 *  this exact string, so the two literals must stay in sync. */
const BROWSER_PARTITION = "persist:mixdog-browser";

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
  kind: "load" | "renderer" | "unresponsive";
  title: string;
  detail: string;
};

interface WebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  setZoomFactor(factor: number): void;
}

export { normalizeAddressInput } from "./browser-address";

export interface BrowserPaneProps {
  sessionId: string;
  active: boolean;
  foreground: boolean;
  parked?: boolean;
  focusAddressOnActivate?: boolean;
}

function DesktopBrowserPane({
  sessionId,
  active,
  parked = false,
  focusAddressOnActivate = true,
}: BrowserPaneProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const appliedViewportPreset = useRef<string | null>(null);
  const viewportConfigurationRequest = useRef(0);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const addressFocused = useRef(false);
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [addressHasFocus, setAddressHasFocus] = useState(false);
  const [historySuggestions, setHistorySuggestions] = useState<DesktopBrowserHistoryEntry[]>([]);
  const [credentialSuggestions, setCredentialSuggestions] = useState<DesktopBrowserCredentialSuggestion[]>([]);
  const [credentialMenuOpen, setCredentialMenuOpen] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<"idle" | "success" | "error">("idle");
  const [pageFailure, setPageFailure] = useState<BrowserPageFailure | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [viewportPresetId, setViewportPresetId] = useState<BrowserViewportPresetId>(() =>
    readBrowserViewportPreset(window.localStorage, sessionId).id);
  const desktopApi = window.mixdogDesktop;
  const ownerSessionId = sessionId;
  const viewportPreset = resolveBrowserViewportPreset(viewportPresetId);
  // Device metrics the agent's `emulate` command put on this session's guest.
  // The pane frames the page at that size, centered, exactly like a picker
  // preset — otherwise the emulated page lays out top-left inside the full
  // box (user: 브라우저 왜 가운데 정렬 안 되냐). The pane's own configure
  // echoes back through the same event and reads as "no override".
  const [agentViewport, setAgentViewport] =
    useState<{ width: number; height: number } | null>(null);
  useEffect(() => window.mixdogDesktop?.onBrowserGuestViewportChanged?.((change) => {
    if (change.sessionId !== ownerSessionId) return;
    const preset = resolveBrowserViewportPreset(
      readBrowserViewportPreset(window.localStorage, ownerSessionId).id,
    );
    const ownPreset = change.viewport !== null
      && change.viewport.width === preset.width
      && change.viewport.height === preset.height;
    setAgentViewport(ownPreset ? null : change.viewport);
  }), [ownerSessionId]);
  const frameWidth = agentViewport?.width ?? viewportPreset.width;
  const frameHeight = agentViewport?.height ?? viewportPreset.height;
  const fixedViewport = frameWidth !== null && frameHeight !== null;
  // User zoom on top of the surface baseline (auto-fit factor, or 1 inside a
  // device frame). Page zoom in both modes: inside a frame the page grows and
  // scrolls within it, the way a phone's own browser zooms.
  const [zoomLevel, setZoomLevel] = useState(() =>
    readBrowserZoom(window.localStorage, sessionId));
  const changeZoomLevel = useCallback((level: number) => {
    setZoomLevel(writeBrowserZoom(window.localStorage, ownerSessionId, level));
  }, [ownerSessionId]);
  // A device frame taller or wider than the pane scales down to fit, staying
  // centered on both axes (user: 상하좌우 가운데 정렬 — PC·모바일 공통). The
  // guest keeps its real metrics; only the composited frame shrinks.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [frameScale, setFrameScale] = useState(1);
  // Layout effect: the fitted scale lands in the same paint as the new frame
  // size, so a preset switch never shows one oversized frame first.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !fixedViewport) {
      setFrameScale(1);
      return undefined;
    }
    const fit = () => {
      const styles = window.getComputedStyle(content);
      const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const roomWidth = content.clientWidth - padX;
      const roomHeight = content.clientHeight - padY;
      if (roomWidth <= 0 || roomHeight <= 0) return;
      const scale = Math.min(1, roomWidth / frameWidth!, roomHeight / frameHeight!);
      setFrameScale((current) => Math.abs(current - scale) < 0.001 ? current : scale);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => observer.disconnect();
  }, [fixedViewport, frameWidth, frameHeight]);

  useEffect(() => {
    const view = webviewRef.current;
    const setGuestActive = desktopApi?.browserSetActiveGuest;
    if (!view || !setGuestActive) return undefined;
    let reportedId = 0;
    const report = () => {
      try {
        const webContentsId = view.getWebContentsId();
        if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
        reportedId = webContentsId;
        void setGuestActive(ownerSessionId, webContentsId, active).catch(() => {});
      } catch { /* guest not attached yet; did-attach/dom-ready retries */ }
    };
    report();
    const stopForegroundReturnReporting = active
      ? watchBrowserForegroundReturns(window, document, report)
      : () => {};
    const stopSettledForegroundRepaint = active
      ? scheduleBrowserForegroundRepaint(window, report)
      : () => {};
    view.addEventListener("did-attach", report);
    view.addEventListener("dom-ready", report);
    return () => {
      stopForegroundReturnReporting();
      stopSettledForegroundRepaint();
      view.removeEventListener("did-attach", report);
      view.removeEventListener("dom-ready", report);
      if (reportedId) void setGuestActive(ownerSessionId, reportedId, false).catch(() => {});
    };
  }, [active, desktopApi, ownerSessionId]);

  const refreshCredentialSuggestions = useCallback(() => {
    if (!desktopApi?.browserCredentialSuggestions) {
      setCredentialSuggestions([]);
      return;
    }
    void desktopApi.browserCredentialSuggestions(ownerSessionId).then((suggestions) => {
      setCredentialSuggestions(suggestions);
      if (!suggestions.length) setCredentialMenuOpen(false);
    }).catch(() => {
      setCredentialSuggestions([]);
      setCredentialMenuOpen(false);
    });
  }, [desktopApi, ownerSessionId]);

  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return undefined;
    const syncNavigationState = () => {
      // canGoBack/canGoForward throw until the guest finishes attaching.
      try {
        setCanGoBack(view.canGoBack());
        setCanGoForward(view.canGoForward());
      } catch { /* guest not ready yet */ }
    };
    const onNavigate = (event: Event) => {
      const url = (event as WebviewNavigationEvent).url || "";
      const inPage = event.type === "did-navigate-in-page"
        && (event as WebviewNavigationEvent).isMainFrame === false;
      if (!url || url === "about:blank" || inPage) {
        syncNavigationState();
        return;
      }
      setCurrentUrl(url);
      setPageFailure(null);
      setCredentialMenuOpen(false);
      setCredentialStatus("idle");
      if (!addressFocused.current) setAddress(url);
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
        kind: "load",
        title: t("Failed to load page"),
        detail: `${failure.errorDescription || t("Network or site error")}`
          + `${failure.errorCode ? ` (${failure.errorCode})` : ""}`,
      });
    };
    const onRenderProcessGone = (event: Event) => {
      const details = (event as WebviewRenderProcessGoneEvent).details;
      setLoading(false);
      setPageFailure({
        kind: "renderer",
        title: t("Browser crashed"),
        detail: details?.reason
          ? `${details.reason}${details.exitCode ? ` (${details.exitCode})` : ""}`
          : t("The page renderer process exited."),
      });
    };
    const onUnresponsive = () => setPageFailure({
      kind: "unresponsive",
      title: t("Page unresponsive"),
      detail: t("Wait or reload the page."),
    });
    const onResponsive = () => setPageFailure((failure) =>
      failure?.kind === "unresponsive" ? null : failure);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("did-start-loading", onStartLoading);
    view.addEventListener("did-stop-loading", onStopLoading);
    view.addEventListener("did-finish-load", onFinishLoading);
    view.addEventListener("did-fail-load", onFailLoad);
    view.addEventListener("render-process-gone", onRenderProcessGone);
    view.addEventListener("unresponsive", onUnresponsive);
    view.addEventListener("responsive", onResponsive);
    return () => {
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("did-start-loading", onStartLoading);
      view.removeEventListener("did-stop-loading", onStopLoading);
      view.removeEventListener("did-finish-load", onFinishLoading);
      view.removeEventListener("did-fail-load", onFailLoad);
      view.removeEventListener("render-process-gone", onRenderProcessGone);
      view.removeEventListener("unresponsive", onUnresponsive);
      view.removeEventListener("responsive", onResponsive);
    };
  }, [refreshCredentialSuggestions]);

  useEffect(() => {
    if (credentialStatus === "idle") return undefined;
    const timer = window.setTimeout(() => setCredentialStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [credentialStatus]);

  const configureViewportPreset = useCallback(async (
    preset: BrowserViewportPreset,
    reload: boolean,
  ): Promise<boolean> => {
    const view = webviewRef.current;
    if (!view) return false;
    const configKey = `${ownerSessionId}\u0000${preset.id}`;
    if (appliedViewportPreset.current === configKey) return true;
    // Metrics and touch apply live; only a user-agent change needs the page
    // to load again. Reloading on every size step blanked the page for a
    // beat (user: 폰 해상도 바꿀 때 튄다, 배경이 잠깐 보인다).
    const previousUserAgent = appliedViewportPreset.current
      ? resolveBrowserViewportPreset(appliedViewportPreset.current.split("\u0000")[1]).userAgent
      : null;
    const userAgentChanged = previousUserAgent !== (preset.userAgent ?? null);
    const configure = desktopApi?.browserConfigureGuestViewport;
    if (!configure) {
      appliedViewportPreset.current = configKey;
      return true;
    }
    let webContentsId = 0;
    try {
      webContentsId = view.getWebContentsId();
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return false;
    const request = ++viewportConfigurationRequest.current;
    try {
      await configure(
        ownerSessionId,
        webContentsId,
        browserViewportEmulation(preset),
      );
    } catch (error) {
      console.error("Browser viewport emulation failed.", error);
      return false;
    }
    if (request !== viewportConfigurationRequest.current) return false;
    appliedViewportPreset.current = configKey;
    if (reload && userAgentChanged) {
      try {
        if (view.getURL() && view.getURL() !== "about:blank") view.reload();
      } catch { /* detached guest; its next attach applies the preset */ }
    }
    return true;
  }, [desktopApi, ownerSessionId]);

  // Auto fits desktop-width sites to the pane. Device presets keep zoom at one
  // and apply actual UA/touch/device metrics through the Browser CDP host.
  const desiredZoom = useRef(1);
  useEffect(() => {
    if (!active) return undefined;
    const view = webviewRef.current;
    if (!view) return undefined;
    let disposed = false;
    let restoreFrame = 0;
    const applyZoom = () => {
      try {
        view.setZoomFactor(desiredZoom.current);
      } catch { /* guest not attached yet; dom-ready reapplies */ }
    };
    const syncZoom = (force = false) => {
      const zoom = (fixedViewport ? 1 : browserAutoFitZoom(view.clientWidth)) * zoomLevel;
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
    const stopForegroundReturnReporting = watchBrowserForegroundReturns(
      window,
      document,
      restoreVisibleGuest,
    );
    const onGuestReady = () => void configureGuest();
    view.addEventListener("did-attach", onGuestReady);
    view.addEventListener("dom-ready", onGuestReady);
    view.addEventListener("did-navigate", applyZoom);
    void configureGuest();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(restoreFrame);
      stopForegroundReturnReporting();
      observer.disconnect();
      view.removeEventListener("did-attach", onGuestReady);
      view.removeEventListener("dom-ready", onGuestReady);
      view.removeEventListener("did-navigate", applyZoom);
    };
  }, [
    active,
    configureViewportPreset,
    fixedViewport,
    ownerSessionId,
    viewportPreset,
    viewportPresetId,
    zoomLevel,
  ]);

  // A fresh, blank browser tab is for typing an address first.
  useEffect(() => {
    if (active && focusAddressOnActivate && !currentUrl) addressRef.current?.focus();
  }, [active, currentUrl, focusAddressOnActivate]);

  const navigate = useCallback((rawInput: string) => {
    const url = normalizeAddressInput(rawInput);
    const view = webviewRef.current;
    if (!url || !view) return;
    setAddress(url);
    setHistorySuggestions([]);
    // loadURL rejects on user-aborted navigations and throws synchronously
    // while the guest is still attaching; neither is an error here.
    try {
      void view.loadURL(url).catch(() => undefined);
      view.focus();
    } catch {
      view.src = url;
    }
  }, []);

  useEffect(() => {
    if (!addressHasFocus || !address.trim() || !desktopApi?.browserHistorySearch) {
      setHistorySuggestions([]);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void desktopApi.browserHistorySearch?.(address).then((entries) => {
        if (live) setHistorySuggestions(entries);
      }).catch(() => {
        if (live) setHistorySuggestions([]);
      });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, addressHasFocus, desktopApi]);

  const displayedUrl = currentUrl;

  const fillStoredCredential = useCallback((credentialId: string) => {
    if (!desktopApi?.browserCredentialFill || credentialBusy) return;
    setCredentialBusy(true);
    setCredentialMenuOpen(false);
    setCredentialStatus("idle");
    void desktopApi.browserCredentialFill(ownerSessionId, credentialId).then((result) => {
      setCredentialStatus(result.passwordFilled ? "success" : "error");
    }).catch(() => setCredentialStatus("error"))
      .finally(() => setCredentialBusy(false));
  }, [credentialBusy, desktopApi, ownerSessionId]);

  return <div className="browser-pane" data-pane-instance={sessionId}
    data-surface-active={active || parked ? "true" : "false"}>
    <div className="browser-pane-toolbar">
      <button type="button" className="browser-pane-nav-button"
        disabled={!canGoBack}
        onClick={() => webviewRef.current?.goBack()}
        aria-label={t("Back")} data-tooltip={t("Back")}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button"
        disabled={!canGoForward}
        onClick={() => webviewRef.current?.goForward()}
        aria-label={t("Forward")} data-tooltip={t("Forward")}>
        <ArrowRight size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button"
        onClick={() => {
          const view = webviewRef.current;
          if (!view) return;
          if (loading) view.stop();
          else if (currentUrl) view.reload();
          else navigate(address);
        }}
        aria-label={loading ? t("Stop loading") : t("Reload")}
        data-tooltip={loading ? t("Stop loading") : t("Reload")}>
        {loading ? <X size={15} /> : <RotateCw size={15} />}
      </button>
      <form className="browser-pane-address-form"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(address);
        }}>
        <input ref={addressRef} className="browser-pane-address"
          type="text" value={address} spellCheck={false}
          placeholder={t("Search or enter address")}
          aria-label={t("Address bar")}
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
          }} />
        {historySuggestions.length > 0 && <div className="browser-pane-history-suggestions">
          {historySuggestions.map((entry) => <button type="button" key={entry.url}
            onMouseDown={(event) => {
              event.preventDefault();
              navigate(entry.url);
              setAddressHasFocus(false);
            }}>
            <span>{entry.title || entry.url}</span>
            <code>{entry.url}</code>
          </button>)}
        </div>}
      </form>
      <div className="browser-pane-viewport-picker" data-tooltip={viewportPreset.label}>
        <OpenSelect className="browser-pane-viewport-control"
          value={viewportPresetId}
          ariaLabel={t("Browser viewport size: {{label}}", { label: viewportPreset.label })}
          localizeLabels={false}
          leading={<Smartphone size={15} aria-hidden="true" />}
          menuMinWidth={236}
          options={BROWSER_VIEWPORT_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
          onChange={(value) => {
            const preset = resolveBrowserViewportPreset(value);
            void configureViewportPreset(preset, true).then((configured) => {
              if (!configured) return;
              writeBrowserViewportPreset(window.localStorage, ownerSessionId, preset.id);
              setViewportPresetId(preset.id);
            });
          }} />
      </div>
      {credentialSuggestions.length > 0 && <div className="browser-pane-credential-control">
        <button type="button"
          className={`browser-pane-nav-button browser-pane-credential-button is-${credentialStatus}`}
          disabled={credentialBusy}
          onClick={() => {
            if (credentialSuggestions.length === 1) {
              fillStoredCredential(credentialSuggestions[0].id);
            } else {
              setCredentialMenuOpen((open) => !open);
            }
          }}
          aria-label={credentialStatus === "success"
            ? t("Filled stored credentials")
            : credentialStatus === "error"
              ? t("Could not fill stored credentials")
              : t("Fill with stored credentials")}
          data-tooltip={credentialStatus === "success"
            ? t("Filled stored credentials")
            : credentialStatus === "error"
              ? t("Could not fill stored credentials")
              : t("Fill with stored credentials")}>
          {credentialBusy
            ? <LoaderCircle size={15} className="is-spinning" />
            : credentialStatus === "success"
              ? <Check size={15} />
              : credentialStatus === "error"
                ? <AlertTriangle size={15} />
                : <KeyRound size={15} />}
        </button>
        {credentialMenuOpen && <div className="browser-pane-credential-menu" role="menu">
          {credentialSuggestions.map((credential) => <button type="button"
            key={credential.id} role="menuitem"
            onClick={() => fillStoredCredential(credential.id)}>
            <KeyRound size={15} />
            <span>{credential.label}</span>
          </button>)}
        </div>}
      </div>}
      <button type="button" className="browser-pane-nav-button" disabled={!displayedUrl}
        onClick={() => {
          if (displayedUrl) void window.mixdogDesktop?.openExternal(displayedUrl);
        }}
        aria-label={t("Open in system browser")}
        data-tooltip={t("Open in system browser")}>
        <ExternalLink size={15} />
      </button>
      {desktopApi?.browserProfileImportSources && <button type="button"
        className="browser-pane-nav-button browser-pane-import-button"
        onClick={() => setImportOpen(true)}
        aria-label={t("Import from browser")}
        data-tooltip={t("Import from browser")}>
        {/* Import links this pane to a system browser's profile (user: 링크를
            연상시키는 버튼) — a chain glyph, not a download arrow. */}
        <Link2 size={15} />
      </button>}
    </div>
    <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    <div className={`browser-pane-content${fixedViewport ? " is-device-frame" : ""}`}
      ref={contentRef}>
      <div className="browser-pane-viewport"
        data-viewport-preset={viewportPreset.id}
        style={fixedViewport ? {
          width: `${frameWidth}px`,
          height: `${frameHeight}px`,
          transform: frameScale < 1 ? `scale(${frameScale})` : undefined,
        } : undefined}>
        <webview ref={(element) => {
          webviewRef.current = element as unknown as WebviewElement | null;
        }}
          className={`browser-pane-webview${importOpen ? " is-import-open" : ""}${historySuggestions.length ? " is-history-open" : ""}${credentialMenuOpen ? " is-credential-open" : ""}${pageFailure ? " is-failed" : ""}`}
          src="about:blank"
          partition={BROWSER_PARTITION} />
        {/* about:blank paints Chromium's default white; until a real page is
            committed the pane stays in the app theme instead. */}
        {!currentUrl && <div className="browser-pane-empty" aria-hidden="true">
          <Globe size={28} />
          <span>{t("Search or enter address")}</span>
        </div>}
        {pageFailure && <div className="browser-pane-failure" role="status" aria-live="polite">
          <AlertTriangle size={26} />
          <strong>{pageFailure.title}</strong>
          <span>{pageFailure.detail}</span>
          <button type="button" onClick={() => {
            const view = webviewRef.current;
            setPageFailure(null);
            if (!view) return;
            try {
              view.reload();
            } catch {
              navigate(currentUrl || address);
            }
          }}>
            <RotateCw size={14} />
            {t("Reload")}
          </button>
        </div>}
      </div>
      {currentUrl && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
    </div>
  </div>;
}

export default function BrowserPane(props: BrowserPaneProps) {
  if (typeof window.mixdogDesktop?.remoteBrowserFrame === "function") {
    return <RemoteBrowserPane {...props} />;
  }
  return <DesktopBrowserPane {...props} />;
}