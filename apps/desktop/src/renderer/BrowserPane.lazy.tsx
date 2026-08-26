// In-app Chromium browser pane (Utilities → Browser). Hosts one <webview>
// guest on the shared persistent partition, so login sessions survive app
// restarts and the agent bridge in the main process can drive the same page
// the user sees. The pane owns only the chrome (address bar, nav buttons);
// guest control for agents lives in main/browser-host.ts via CDP.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";

import { t } from "./i18n";
import "./desktop/32-browser-pane.css";

/** Shared persistent guest partition; main/browser-host.ts matches guests by
 *  this exact string, so the two literals must stay in sync. */
const BROWSER_PARTITION = "persist:mixdog-browser";

type WebviewNavigationEvent = Event & { url?: string; isMainFrame?: boolean };

interface WebviewElement extends HTMLElement {
  src: string;
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

export default function BrowserPane({
  paneId,
  active,
}: {
  paneId: string;
  active: boolean;
}) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const addressFocused = useRef(false);
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

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
      if (!addressFocused.current) setAddress(url);
      syncNavigationState();
    };
    const onStartLoading = () => setLoading(true);
    const onStopLoading = () => {
      setLoading(false);
      syncNavigationState();
    };
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("did-start-loading", onStartLoading);
    view.addEventListener("did-stop-loading", onStopLoading);
    return () => {
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("did-start-loading", onStartLoading);
      view.removeEventListener("did-stop-loading", onStopLoading);
    };
  }, []);

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
    // loadURL rejects on user-aborted navigations and throws synchronously
    // while the guest is still attaching; neither is an error here.
    try {
      void view.loadURL(url).catch(() => undefined);
      view.focus();
    } catch {
      view.src = url;
    }
  }, []);

  return <div className="browser-pane" data-pane-instance={paneId}
    data-surface-active={active ? "true" : "false"}>
    <div className="browser-pane-toolbar">
      <button type="button" className="browser-pane-nav-button" disabled={!canGoBack}
        onClick={() => webviewRef.current?.goBack()}
        aria-label={t("Back")} data-tooltip={t("Back")}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button" disabled={!canGoForward}
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
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            addressFocused.current = true;
            event.target.select();
          }}
          onBlur={() => {
            addressFocused.current = false;
            if (currentUrl) setAddress(currentUrl);
          }} />
      </form>
      <button type="button" className="browser-pane-nav-button" disabled={!currentUrl}
        onClick={() => {
          if (currentUrl) void window.mixdogDesktop?.openExternal(currentUrl);
        }}
        aria-label={t("Open in system browser")}
        data-tooltip={t("Open in system browser")}>
        <ExternalLink size={15} />
      </button>
    </div>
    <div className="browser-pane-content">
      <webview ref={(element) => {
        webviewRef.current = element as unknown as WebviewElement | null;
      }}
        className="browser-pane-webview"
        src="about:blank"
        partition={BROWSER_PARTITION} />
      {/* about:blank paints Chromium's default white; until a real page is
          committed the pane stays in the app theme instead. */}
      {!currentUrl && <div className="browser-pane-empty" aria-hidden="true">
        <Globe size={28} />
        <span>{t("Search or enter address")}</span>
      </div>}
    </div>
  </div>;
}