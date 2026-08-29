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
  Cookie,
  Download,
  ExternalLink,
  Globe,
  Hand,
  History,
  KeyRound,
  LoaderCircle,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";

import { t } from "./i18n";
import type {
  DesktopBrowserActivity,
  DesktopBrowserCredentialSuggestion,
  DesktopBrowserHandoffRequest,
  DesktopBrowserHistoryEntry,
  DesktopBrowserImportItem,
  DesktopBrowserImportProgress,
  DesktopBrowserImportSource,
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

/** Address-bar entry → URL: explicit schemes pass through, host-shaped text
 *  gets https://, anything else becomes a web search. */
export function normalizeAddressInput(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^(https?|file|about):/i.test(text)) return text;
  const hostLike = /^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(text)
    || /^localhost(:\d+)?([/?#]\S*)?$/i.test(text)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]\S*)?$/i.test(text);
  if (hostLike && !/\s/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** Progress strip wording. A general user watching the page should never have
 *  to read tool calls, so every action collapses into one plain sentence. */
function browserActivityLabel(action: string): string {
  switch (action) {
    case "navigate":
    case "back":
    case "forward":
      return t("Opening a page");
    case "wait":
      return t("Waiting for the page");
    case "upload":
      return t("Uploading a file");
    case "handoff":
      return t("Waiting for you");
    case "snapshot":
    case "read":
    case "extract":
    case "locate":
    case "status":
    case "console":
    case "network":
    case "list_tabs":
    case "downloads":
    case "performance":
      return t("Reading the page");
    default:
      return t("Acting on the page");
  }
}

export default function BrowserPane({
  paneId,
  active,
  foreground,
}: {
  paneId: string;
  active: boolean;
  foreground: boolean;
}) {
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
  const [importSources, setImportSources] = useState<DesktopBrowserImportSource[]>([]);
  const [importSourceId, setImportSourceId] = useState("");
  const [importProfileId, setImportProfileId] = useState("");
  const [importItems, setImportItems] = useState<Record<DesktopBrowserImportItem, boolean>>({
    passwords: true,
    cookies: true,
    history: true,
  });
  const [administratorApproved, setAdministratorApproved] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importFinished, setImportFinished] = useState(false);
  const [importError, setImportError] = useState("");
  const [importProgress, setImportProgress] = useState<
    Partial<Record<DesktopBrowserImportItem, DesktopBrowserImportProgress>>
  >({});
  const [activity, setActivity] = useState<DesktopBrowserActivity | null>(null);
  const [goal, setGoal] = useState("");
  const [handoff, setHandoff] = useState<DesktopBrowserHandoffRequest | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const desktopApi = window.mixdogDesktop;

  // Agent handoff: the browser tool parked on a captcha, a 2FA prompt, or an
  // identity check. Main clears the request by publishing null.
  useEffect(() => {
    const subscribe = desktopApi?.onBrowserHandoffChanged;
    if (!subscribe) return undefined;
    return subscribe((request) => {
      setHandoff(request);
      setHandoffBusy(false);
    });
  }, [desktopApi]);

  // Progress strip: main publishes null as soon as the last command settles.
  useEffect(() => {
    const subscribe = desktopApi?.onBrowserActivityChanged;
    if (!subscribe) return undefined;
    return subscribe(setActivity);
  }, [desktopApi]);

  const resolveHandoff = useCallback((completed: boolean) => {
    const resolve = desktopApi?.browserHandoffResolve;
    if (!handoff || !resolve || handoffBusy) return;
    setHandoffBusy(true);
    void resolve(handoff.id, completed).catch(() => setHandoffBusy(false));
  }, [desktopApi, handoff, handoffBusy]);

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
    view.addEventListener("did-attach", report);
    view.addEventListener("dom-ready", report);
    return () => {
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
    const view = webviewRef.current;
    if (!view) return undefined;
    const applyZoom = () => {
      try {
        view.setZoomFactor(desiredZoom.current);
      } catch { /* guest not attached yet; dom-ready reapplies */ }
    };
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || view.clientWidth;
      if (!width) return;
      const zoom = Math.min(1, Math.max(MIN_FIT_ZOOM, width / FIT_CONTENT_WIDTH));
      if (Math.abs(zoom - desiredZoom.current) < 0.01) return;
      desiredZoom.current = zoom;
      applyZoom();
    });
    observer.observe(view);
    view.addEventListener("dom-ready", applyZoom);
    view.addEventListener("did-navigate", applyZoom);
    return () => {
      observer.disconnect();
      view.removeEventListener("dom-ready", applyZoom);
      view.removeEventListener("did-navigate", applyZoom);
    };
  }, []);

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

  const closeImporter = useCallback(() => {
    if (importBusy) return;
    setImportOpen(false);
    setImportFinished(false);
    setImportError("");
    setImportProgress({});
    setAdministratorApproved(false);
  }, [importBusy]);

  const openImporter = useCallback(() => {
    if (!desktopApi?.browserProfileImportSources || importBusy) return;
    setImportOpen(true);
    setImportLoading(true);
    setImportFinished(false);
    setImportError("");
    setImportProgress({});
    void desktopApi.browserProfileImportSources().then((sources) => {
      setImportSources(sources);
      const source = sources[0];
      const profile = source?.profiles[0];
      setImportSourceId(source?.id || "");
      setImportProfileId(profile?.id || "");
      setImportItems({
        passwords: source?.supports.passwords === true,
        cookies: source?.supports.cookies === true,
        history: source?.supports.history === true,
      });
      if (!source || !profile) setImportError("가져올 수 있는 Chrome 프로필을 찾지 못했습니다.");
    }).catch((reason) => {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setImportLoading(false));
  }, [desktopApi, importBusy]);

  useEffect(() => {
    if (!desktopApi?.onBrowserProfileImportProgress) return undefined;
    return desktopApi.onBrowserProfileImportProgress((progress) => {
      setImportProgress((current) => ({
        ...current,
        [progress.item]: progress,
      }));
    });
  }, [desktopApi]);

  const startImport = useCallback(() => {
    if (!desktopApi?.browserProfileImportStart || importBusy) return;
    const selectedItems = (Object.keys(importItems) as DesktopBrowserImportItem[])
      .filter((item) => importItems[item]);
    if (!selectedItems.length) {
      setImportError("가져올 항목을 하나 이상 선택하세요.");
      return;
    }
    if (selectedItems.includes("passwords") && !administratorApproved) {
      setImportError("저장된 비밀번호를 가져오려면 관리자 승인 안내를 확인하세요.");
      return;
    }
    const jobId = crypto.randomUUID().replaceAll("-", "");
    setImportBusy(true);
    setImportFinished(false);
    setImportError("");
    setImportProgress({});
    void desktopApi.browserProfileImportStart({
      jobId,
      sourceId: importSourceId,
      profileId: importProfileId,
      items: selectedItems,
      administratorApproved,
    }).then((result) => {
      setImportFinished(true);
      const failures = Object.values(result.errors).filter(Boolean);
      if (failures.length) setImportError(failures.join("\n"));
    }).catch((reason) => {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setImportBusy(false));
  }, [
    administratorApproved,
    desktopApi,
    importBusy,
    importItems,
    importProfileId,
    importSourceId,
  ]);

  const selectedSource = importSources.find((source) => source.id === importSourceId);
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

  const importItemRow = (
    item: DesktopBrowserImportItem,
    label: string,
    icon: React.ReactNode,
  ) => {
    const supported = selectedSource?.supports[item] !== false;
    const progress = importProgress[item];
    const selected = supported && importItems[item];
    const showProgress = (importBusy || importFinished) && selected;
    const progressState = progress?.state || (importBusy ? "running" : "failed");
    return <label className={`browser-import-item${supported ? "" : " is-disabled"}`}>
      <span className="browser-import-item-icon">{icon}</span>
      <span className="browser-import-item-label">
        <strong>{label}</strong>
        {!supported && item === "passwords" && selectedSource?.passwordSupportReason
          ? <small>{selectedSource.passwordSupportReason}</small>
          : null}
        {showProgress && progressState === "completed"
          ? <small>{progress?.count?.toLocaleString() || "0"}개 가져옴</small>
          : null}
        {showProgress && progressState === "failed"
          ? <small>가져오지 못함</small>
          : null}
      </span>
      {showProgress
        ? <span className={`browser-import-state is-${progressState}`}
          aria-label={progressState === "completed" ? "완료" : progressState === "failed" ? "실패" : "진행 중"}>
          {progressState === "completed"
            ? <Check size={16} />
            : progressState === "failed"
              ? <AlertTriangle size={16} />
              : <LoaderCircle size={16} className="is-spinning" />}
        </span>
        : importBusy || importFinished
          ? <span className="browser-import-skipped">제외</span>
        : <input type="checkbox"
          checked={supported && importItems[item]}
          disabled={!supported || importLoading}
          onChange={(event) => setImportItems((current) => ({
            ...current,
            [item]: event.target.checked,
          }))} />}
    </label>;
  };

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
        disabled={importBusy}
        onClick={openImporter}
        aria-label="브라우저에서 가져오기"
        data-tooltip="브라우저에서 가져오기">
        <Download size={15} />
      </button>}
    </div>
    {importOpen && <div className="browser-import-backdrop">
      <section className="browser-import-dialog" role="dialog" aria-modal="true"
        aria-label="브라우저에서 가져오기">
        <header>
          <div>
            <h2>브라우저에서 가져오기</h2>
            <p>{importBusy
              ? "브라우저 데이터를 가져오는 중..."
              : importFinished
                ? importError
                  ? "일부 데이터를 가져오지 못했습니다"
                  : "브라우저 데이터를 가져왔습니다"
                : "내장 브라우저로 가져올 데이터를 선택하세요"}</p>
          </div>
          {!importBusy && <button type="button" className="browser-pane-nav-button"
            onClick={closeImporter} aria-label={t("Close")}>
            <X size={16} />
          </button>}
        </header>
        {!importBusy && !importFinished && <div className="browser-import-source">
          <span>원본</span>
          <select value={`${importSourceId}\u0000${importProfileId}`}
            aria-label="가져올 Chrome 프로필"
            disabled={importLoading}
            onChange={(event) => {
              const [sourceId, profileId] = event.target.value.split("\u0000");
              const source = importSources.find((candidate) => candidate.id === sourceId);
              setImportSourceId(sourceId);
              setImportProfileId(profileId);
              setImportItems({
                passwords: source?.supports.passwords === true,
                cookies: source?.supports.cookies === true,
                history: source?.supports.history === true,
              });
              setAdministratorApproved(false);
            }}>
            {importSources.flatMap((source) => source.profiles.map((profile) =>
              <option key={`${source.id}:${profile.id}`}
                value={`${source.id}\u0000${profile.id}`}>
                {source.name} · {profile.name}{profile.accountEmail ? ` (${profile.accountEmail})` : ""}
              </option>))}
          </select>
        </div>}
        <div className="browser-import-items">
          {importItemRow("passwords", "저장된 비밀번호", <KeyRound size={18} />)}
          {importItemRow("cookies", "쿠키", <Cookie size={18} />)}
          {importItemRow("history", "방문 기록", <History size={18} />)}
        </div>
        {!importBusy && !importFinished && importItems.passwords && selectedSource?.supports.passwords && <label
          className="browser-import-admin">
          <strong>관리자 승인 필요</strong>
          <span className="browser-import-admin-check">
            <input type="checkbox" checked={administratorApproved}
              onChange={(event) => setAdministratorApproved(event.target.checked)} />
            앱이 Chrome 데이터를 가져오려고 관리자 승인을 요청한다는 점을 이해합니다
          </span>
        </label>}
        {importError && <div className="browser-import-error">{importError}</div>}
        <footer>
          <button type="button" className="browser-import-secondary"
            disabled={importBusy} onClick={closeImporter}>
            {importFinished ? "닫기" : "취소"}
          </button>
          {(!importFinished || Boolean(importError)) && <button type="button" className="browser-import-primary"
            disabled={
              importBusy
              || importLoading
              || !importProfileId
              || !(Object.values(importItems).some(Boolean))
              || (importItems.passwords && selectedSource?.supports.passwords === true && !administratorApproved)
            }
            onClick={startImport}>
            {importBusy ? <LoaderCircle size={15} className="is-spinning" /> : null}
            {importFinished ? "다시 시도" : "가져오기"}
          </button>}
        </footer>
      </section>
    </div>}
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
      {handoff && <div className="browser-pane-handoff" role="status" aria-live="polite">
        <Hand className="browser-pane-handoff-icon" size={18} aria-hidden="true" />
        <div className="browser-pane-handoff-body">
          <strong>{t("The agent needs you to continue here")}</strong>
          <span>{handoff.reason}</span>
        </div>
        <button type="button" onClick={() => resolveHandoff(false)} disabled={handoffBusy}>
          {t("Cancel")}
        </button>
        <button type="button" className="is-primary"
          onClick={() => resolveHandoff(true)} disabled={handoffBusy}>
          <Check size={14} aria-hidden="true" />
          {t("Done")}
        </button>
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
    {activity && <div className="browser-pane-activity" role="status" aria-live="polite">
      <LoaderCircle className="browser-pane-activity-spin" size={13} aria-hidden="true" />
      <span>{browserActivityLabel(activity.action)}</span>
      {activity.background && <em>{t("in a background tab")}</em>}
    </div>}
    {/* Goal bar: the plain-language entry point. App owns what happens next —
        the pane only reports the errand and the page it was stated on. */}
    <form className="browser-pane-goal"
      onSubmit={(event) => {
        event.preventDefault();
        const text = goal.trim();
        if (!text) return;
        window.dispatchEvent(new CustomEvent("mixdog:browser-task", {
          detail: { text, url: currentUrl },
        }));
        setGoal("");
      }}>
      <Sparkles size={15} aria-hidden="true" />
      <input type="text" value={goal} spellCheck={false}
        placeholder={t("Ask the agent to do something with this page")}
        aria-label={t("Ask the agent to do something with this page")}
        onChange={(event) => setGoal(event.target.value)} />
      <button type="submit" disabled={!goal.trim()}>{t("Start")}</button>
    </form>
  </div>;
}