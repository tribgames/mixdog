// In-app Chromium browser pane (Utilities → Browser Use). Hosts one <webview>
// guest on the shared persistent partition, so login sessions survive app
// restarts and the agent bridge in the main process can drive the same page
// the user sees. The pane owns only the chrome (address bar, nav buttons);
// guest control for agents lives in main/browser-host.ts via CDP.
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
  X,
} from "lucide-react";

import { t } from "./i18n";
import { normalizeAddressInput } from "./browser-address";
import { BrowserImportDialog } from "./BrowserImportDialog";
import { watchBrowserForegroundReturns } from "./browser-foreground-lifecycle";
import RemoteBrowserPane from "./RemoteBrowserPane";
import type {
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserHistoryEntry,
} from "../shared/contract";
import "./desktop/32-browser-pane.css";

/** Shared persistent guest partition; main/browser-host.ts matches guests by
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

/** Fit-width viewport: fixed-width desktop layouts (portals commonly assume
 *  ~1100-1200px) zoom out inside a narrow pane instead of clipping behind a
 *  horizontal scrollbar. A pane at least this wide renders at 100%. */
const FIT_CONTENT_WIDTH = 1160;
const MIN_FIT_ZOOM = 0.5;

export { normalizeAddressInput } from "./browser-address";

export interface BrowserPaneProps {
  paneId: string;
  active: boolean;
  foreground: boolean;
}

function DesktopBrowserPane({
  paneId,
  active,
  foreground,
}: BrowserPaneProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
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
  const desktopApi = window.mixdogDesktop;

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
        void setGuestActive(paneId, webContentsId, foreground).catch(() => {});
      } catch { /* guest not attached yet; did-attach/dom-ready retries */ }
    };
    report();
    const stopForegroundReturnReporting = foreground
      ? watchBrowserForegroundReturns(window, document, report)
      : () => {};
    view.addEventListener("did-attach", report);
    view.addEventListener("dom-ready", report);
    return () => {
      stopForegroundReturnReporting();
      view.removeEventListener("did-attach", report);
      view.removeEventListener("dom-ready", report);
      if (reportedId) void setGuestActive(paneId, reportedId, false).catch(() => {});
    };
  }, [desktopApi, foreground, paneId]);

  const refreshCredentialSuggestions = useCallback(() => {
    if (!desktopApi?.browserCredentialSuggestions) {
      setCredentialSuggestions([]);
      return;
    }
    void desktopApi.browserCredentialSuggestions().then((suggestions) => {
      setCredentialSuggestions(suggestions);
      if (!suggestions.length) setCredentialMenuOpen(false);
    }).catch(() => {
      setCredentialSuggestions([]);
      setCredentialMenuOpen(false);
    });
  }, [desktopApi]);

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

  // Fit-width zoom follows the pane size, and is reapplied after navigations
  // because Chromium's per-origin zoom memory would otherwise override it.
  const desiredZoom = useRef(1);
  useEffect(() => {
    if (!active) return undefined;
    const view = webviewRef.current;
    if (!view) return undefined;
    let restoreFrame = 0;
    const applyZoom = () => {
      try {
        view.setZoomFactor(desiredZoom.current);
      } catch { /* guest not attached yet; dom-ready reapplies */ }
    };
    const syncZoom = (width: number, force = false) => {
      if (!width) return;
      const zoom = Math.min(1, Math.max(MIN_FIT_ZOOM, width / FIT_CONTENT_WIDTH));
      const changed = Math.abs(zoom - desiredZoom.current) >= 0.01;
      if (changed) desiredZoom.current = zoom;
      if (changed || force) applyZoom();
    };
    const restoreVisibleGuest = () => {
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = window.requestAnimationFrame(() => {
        syncZoom(view.clientWidth, true);
      });
    };
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || view.clientWidth;
      syncZoom(width);
    });
    observer.observe(view);
    const stopForegroundReturnReporting = watchBrowserForegroundReturns(
      window,
      document,
      restoreVisibleGuest,
    );
    view.addEventListener("dom-ready", applyZoom);
    view.addEventListener("did-navigate", applyZoom);
    restoreVisibleGuest();
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      stopForegroundReturnReporting();
      observer.disconnect();
      view.removeEventListener("dom-ready", applyZoom);
      view.removeEventListener("did-navigate", applyZoom);
    };
  }, [active]);

  // A fresh, blank browser tab is for typing an address first.
  useEffect(() => {
    if (active && !currentUrl) addressRef.current?.focus();
  }, [active, currentUrl]);

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
    void desktopApi.browserCredentialFill(credentialId).then((result) => {
      setCredentialStatus(result.passwordFilled ? "success" : "error");
    }).catch(() => setCredentialStatus("error"))
      .finally(() => setCredentialBusy(false));
  }, [credentialBusy, desktopApi]);

  return <div className="browser-pane" data-pane-instance={paneId}
    data-surface-active={active ? "true" : "false"}>
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
    <div className="browser-pane-content">
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
  </div>;
}

export default function BrowserPane(props: BrowserPaneProps) {
  if (typeof window.mixdogDesktop?.remoteBrowserFrame === "function") {
    return <RemoteBrowserPane {...props} />;
  }
  return <DesktopBrowserPane {...props} />;
}