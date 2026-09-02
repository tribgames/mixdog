// One Chromium surface per conversation session on a shared persistent
// partition. Login survives and is shared; page, tab, and target state is not.
// The pane owns only the chrome; agent control lives in main/browser/host.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
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
  const fixedViewport = viewportPreset.width !== null && viewportPreset.height !== null;

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
        title: "페이지를 불러오지 못했습니다",
        detail: `${failure.errorDescription || "네트워크 또는 사이트 응답 오류"}`
          + `${failure.errorCode ? ` (${failure.errorCode})` : ""}`,
      });
    };
    const onRenderProcessGone = (event: Event) => {
      const details = (event as WebviewRenderProcessGoneEvent).details;
      setLoading(false);
      setPageFailure({
        kind: "renderer",
        title: "브라우저 화면이 중단되었습니다",
        detail: details?.reason
          ? `${details.reason}${details.exitCode ? ` (${details.exitCode})` : ""}`
          : "페이지 renderer가 종료되었습니다.",
      });
    };
    const onUnresponsive = () => setPageFailure({
      kind: "unresponsive",
      title: "페이지가 응답하지 않습니다",
      detail: "잠시 기다리거나 페이지를 다시 불러오세요.",
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
    if (reload) {
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
      const zoom = fixedViewport ? 1 : browserAutoFitZoom(view.clientWidth);
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
          ariaLabel={`브라우저 화면 크기: ${viewportPreset.label}`}
          localizeLabels={false}
          leading={<Smartphone size={14} aria-hidden="true" />}
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
            ? "저장된 계정을 채웠습니다"
            : credentialStatus === "error"
              ? "저장된 계정을 채우지 못했습니다"
              : "저장된 계정으로 채우기"}
          data-tooltip={credentialStatus === "success"
            ? "저장된 계정을 채웠습니다"
            : credentialStatus === "error"
              ? "저장된 계정을 채우지 못했습니다"
              : "저장된 계정으로 채우기"}>
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
            <KeyRound size={14} />
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
        aria-label="브라우저에서 가져오기"
        data-tooltip="브라우저에서 가져오기">
        <Download size={15} />
      </button>}
    </div>
    <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    <div className={`browser-pane-content${fixedViewport ? " is-device-frame" : ""}`}>
      <div className="browser-pane-viewport"
        data-viewport-preset={viewportPreset.id}
        style={fixedViewport ? {
          width: `${viewportPreset.width}px`,
          height: `${viewportPreset.height}px`,
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
            다시 불러오기
          </button>
        </div>}
      </div>
    </div>
  </div>;
}

export default function BrowserPane(props: BrowserPaneProps) {
  if (typeof window.mixdogDesktop?.remoteBrowserFrame === "function") {
    return <RemoteBrowserPane {...props} />;
  }
  return <DesktopBrowserPane {...props} />;
}