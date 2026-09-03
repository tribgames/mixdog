import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Keyboard,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserFrame,
} from "../shared/contract";
import { remoteBrowserImagePoint } from "../shared/remote-browser";
import { normalizeAddressInput } from "./browser-address";
import { readBrowserZoom, writeBrowserZoom } from "./browser-zoom-level";
import { BrowserZoomPill } from "./BrowserZoomPill";
import { t } from "./i18n";
import type { BrowserPaneProps } from "./BrowserPane.lazy";

/** Keep a zoomed frame's edges inside the box: the image may pan only as far
 *  as its overflow on each axis. */
function clampPan(offset: number, size: number, zoom: number): number {
  const reach = Math.max(0, (size * (zoom - 1)) / 2);
  return Math.min(reach, Math.max(-reach, offset));
}

const ACTIVE_POLL_MS = 350;
const IDLE_POLL_MS = 900;

export default function RemoteBrowserPane({
  sessionId,
  active,
}: BrowserPaneProps) {
  const api = window.mixdogDesktop;
  const ownerSessionId = sessionId;
  const addressFocused = useRef(false);
  const frameId = useRef("");
  const imageRef = useRef<HTMLImageElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composing = useRef(false);
  const wakePoll = useRef<(() => void) | null>(null);
  const pointerStart = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [address, setAddress] = useState("");
  const [frame, setFrame] = useState<DesktopRemoteBrowserFrame | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [failure, setFailure] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const refreshSoon = useCallback(() => wakePoll.current?.(), []);
  // Client-side zoom of the frame image (user: 화면 하단 중앙에 확대축소):
  // the desktop keeps sending the same frame; the phone scales and pans it.
  // Tap coordinates read the image's transformed box, so they stay exact.
  const [zoomLevel, setZoomLevel] = useState(() =>
    readBrowserZoom(window.localStorage, sessionId));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const changeZoomLevel = useCallback((level: number) => {
    const next = writeBrowserZoom(window.localStorage, ownerSessionId, level);
    setZoomLevel(next);
    const image = imageRef.current;
    setPan((current) => next <= 1 || !image
      ? { x: 0, y: 0 }
      : {
        x: clampPan(current.x, image.clientWidth, next),
        y: clampPan(current.y, image.clientHeight, next),
      });
  }, [ownerSessionId]);

  useEffect(() => {
    if (!active || !api?.remoteBrowserFrame) return undefined;
    let cancelled = false;
    let timer = 0;
    let polling = false;
    let wakeRequested = false;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      if (polling) {
        wakeRequested = true;
        return;
      }
      polling = true;
      let delay = 1_500;
      try {
        const next = await api.remoteBrowserFrame?.(ownerSessionId, frameId.current);
        if (cancelled || !next) return;
        frameId.current = next.frameId;
        setFrame(next);
        setFailure("");
        if (next.image) {
          setImageUrl(`data:${next.image.mimeType};base64,${next.image.data}`);
        }
        if (!addressFocused.current) {
          setAddress(next.url === "about:blank" ? "" : next.url);
        }
        delay = next.loading ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        polling = false;
        if (!cancelled) {
          const nextDelay = wakeRequested ? 0 : delay;
          wakeRequested = false;
          schedule(nextDelay);
        }
      }
    };
    wakePoll.current = () => {
      if (polling) {
        wakeRequested = true;
        return;
      }
      schedule(0);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      wakePoll.current = null;
    };
  }, [active, api, ownerSessionId]);

  useEffect(() => {
    if (keyboardOpen) inputRef.current?.focus();
  }, [keyboardOpen]);

  const control = useCallback(async (input: DesktopRemoteBrowserControl) => {
    if (!api?.remoteBrowserControl) return;
    try {
      await api.remoteBrowserControl(ownerSessionId, input);
      setFailure("");
      refreshSoon();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [api, ownerSessionId, refreshSoon]);

  const navigate = useCallback((raw: string) => {
    const url = normalizeAddressInput(raw);
    if (!url) return;
    setAddress(url);
    void control({ type: "navigate", url });
  }, [control]);

  const imagePoint = useCallback((clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || !frame) return null;
    const bounds = image.getBoundingClientRect();
    return remoteBrowserImagePoint(
      bounds,
      { width: frame.width, height: frame.height },
      { x: clientX, y: clientY },
    );
  }, [frame]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = imagePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStart.current = { clientX: event.clientX, clientY: event.clientY, ...point };
    panStart.current = pan;
  };

  // Zoomed in, a one-finger drag pans the frame instead of swiping the page.
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    const image = imageRef.current;
    if (!start || zoomLevel <= 1 || !image) return;
    event.preventDefault();
    setPan({
      x: clampPan(panStart.current.x + (event.clientX - start.clientX), image.clientWidth, zoomLevel),
      y: clampPan(panStart.current.y + (event.clientY - start.clientY), image.clientHeight, zoomLevel),
    });
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    event.preventDefault();
    const end = imagePoint(event.clientX, event.clientY);
    if (!end) return;
    const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    if (distance < 9) {
      void control({ type: "tap", frameId: frameId.current, x: end.x, y: end.y });
      return;
    }
    if (zoomLevel > 1) return;
    void control({
      type: "swipe",
      frameId: frameId.current,
      from: { x: start.x, y: start.y },
      to: end,
    });
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    navigate(address);
    addressFocused.current = false;
  };

  const sendPageText = (text: string) => {
    if (text) void control({ type: "text", frameId: frameId.current, text });
  };

  return <div className="browser-pane browser-remote-pane"
    data-surface-active={active ? "true" : "false"}>
    <div className="browser-pane-toolbar">
      <button type="button" className="browser-pane-nav-button"
        disabled={!frame?.canGoBack}
        onClick={() => void control({ type: "back" })}
        aria-label={t("Back")} data-tooltip={t("Back")}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button"
        disabled={!frame?.canGoForward}
        onClick={() => void control({ type: "forward" })}
        aria-label={t("Forward")} data-tooltip={t("Forward")}>
        <ArrowRight size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button"
        onClick={() => void control({ type: frame?.loading ? "stop" : "reload" })}
        aria-label={frame?.loading ? t("Stop loading") : t("Reload")}
        data-tooltip={frame?.loading ? t("Stop loading") : t("Reload")}>
        {frame?.loading ? <X size={15} /> : <RotateCw size={15} />}
      </button>
      <form className="browser-pane-address-form" onSubmit={submitAddress}>
        <input className="browser-pane-address" type="text" value={address}
          spellCheck={false} placeholder={t("Search or enter address")}
          aria-label={t("Address bar")}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            addressFocused.current = true;
            event.target.select();
          }}
          onBlur={() => {
            addressFocused.current = false;
            if (frame?.url && frame.url !== "about:blank") setAddress(frame.url);
          }} />
      </form>
      <button type="button"
        className={`browser-pane-nav-button browser-remote-keyboard-button${keyboardOpen ? " is-active" : ""}`}
        onClick={() => setKeyboardOpen((open) => !open)}
        aria-pressed={keyboardOpen}
        aria-label={t("Type on page")} data-tooltip={t("Type on page")}>
        <Keyboard size={15} />
      </button>
      <button type="button" className="browser-pane-nav-button"
        disabled={!frame?.url || frame.url === "about:blank"}
        onClick={() => {
          if (frame?.url && frame.url !== "about:blank") {
            void api?.openExternal(frame.url);
          }
        }}
        aria-label={t("Open in system browser")}
        data-tooltip={t("Open in system browser")}>
        <ExternalLink size={15} />
      </button>
    </div>
    {keyboardOpen && <div className="browser-remote-keyboard">
      <input ref={inputRef} type="text" inputMode="text"
        maxLength={2_000}
        autoComplete="off" autoCapitalize="none"
        placeholder={t("Type into selected page element")}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          sendPageText(event.currentTarget.value);
          event.currentTarget.value = "";
        }}
        onInput={(event) => {
          if (composing.current) return;
          sendPageText(event.currentTarget.value);
          event.currentTarget.value = "";
        }}
        onKeyDown={(event) => {
          if (composing.current) return;
          if (!["Backspace", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
            .includes(event.key)) return;
          event.preventDefault();
          void control({ type: "key", frameId: frameId.current, key: event.key });
        }} />
      <button type="button" onClick={() => setKeyboardOpen(false)} aria-label={t("Close")}>
        <X size={15} />
      </button>
    </div>}
    <div className="browser-pane-content browser-remote-content"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => { pointerStart.current = null; }}
      onWheel={(event) => {
        const point = imagePoint(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        void control({
          type: "scroll",
          frameId: frameId.current,
          ...point,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
      }}>
      {imageUrl
        ? <img ref={imageRef} src={imageUrl} draggable={false}
          style={zoomLevel !== 1 || pan.x || pan.y
            ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})` }
            : undefined}
          alt={frame?.title || "Browser Use"} />
        : <div className="browser-remote-empty">
            {failure
              ? <><Globe size={28} /><strong>{t("Could not connect to browser screen")}</strong>
                  <span>{failure}</span>
                  <button type="button" onClick={refreshSoon}>{t("Reconnect")}</button></>
              : <><LoaderCircle size={24} className="is-spinning" />
                  <span>{t("Connecting to desktop Browser Use…")}</span></>}
          </div>}
      {failure && imageUrl && <div className="browser-remote-status" role="status">
        <span>{failure}</span>
        <button type="button" onClick={refreshSoon}>{t("Reconnect")}</button>
      </div>}
      {imageUrl && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
    </div>
  </div>;
}
