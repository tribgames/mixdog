import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Sparkles, X } from "lucide-react";
import { t } from "./i18n";
import type { Toast } from "./desktop-types";
import { ErrorNotice, safeErrorDetails } from "./ErrorNotice";
import { groupToasts, reduceToasts } from "./desktop-toast-state";
import { reportRendererNotice } from "./RendererRecovery";
import { relayPayloadTooLargeMessage } from "../shared/remote-payload-limit";

export const DESKTOP_TOAST_EVENT = "mixdog:desktop-toast";
export const DESKTOP_TOAST_DISMISS_EVENT = "mixdog:desktop-toast-dismiss";
export type DesktopToastTone = "info" | "success" | "warn" | "error";
let sequence = 0;
export type DesktopToastOptions = { scope?: string; groupKey?: string; lifetime?: "event" | "state" };

export function showDesktopToast(text: string, tone: DesktopToastTone = "info", options: DesktopToastOptions = {}): string | undefined {
  const message = safeErrorDetails(text);
  if (!message || typeof window === "undefined") return;
  const id = `renderer:${Date.now()}:${++sequence}`;
  window.dispatchEvent(new window.CustomEvent<Toast>(DESKTOP_TOAST_EVENT, {
    detail: { id, text: message, tone, ...options },
  }));
  return id;
}

export function dismissDesktopToast(id: string | undefined) {
  if (!id || typeof window === "undefined") return;
  window.dispatchEvent(new window.CustomEvent(DESKTOP_TOAST_DISMISS_EVENT, { detail: id }));
}

/** State-owned errors close on success or unmount; event errors require dismissal. */
export function useErrorToast(error: string, scope: string) {
  useEffect(() => {
    if (!error) return;
    const id = showDesktopToast(error, "error", { scope, lifetime: "state" });
    return () => dismissDesktopToast(id);
  }, [error, scope]);
}

export function DesktopToastRegion({ bridgeError, toasts, onDismissBridgeError }: {
  bridgeError: string; toasts: Toast[]; onDismissBridgeError(): void;
}) {
  const [records, dispatch] = useReducer(reduceToasts, []);
  const [placement, setPlacement] = useState({ right: 16, top: 54, width: 320, maxHeight: 400 });
  const hostToasts = [...toasts, ...(bridgeError
    ? [{ id: "desktop-bridge", text: bridgeError, tone: "error", lifetime: "state" }]
    : [])];
  const hostToken = JSON.stringify(hostToasts);
  useEffect(() => { dispatch({ type: "host", toasts: hostToasts }); }, [hostToken]);
  useLayoutEffect(() => {
    const receive = (event: Event) => dispatch({ type: "receive", toast: (event as CustomEvent<Toast>).detail });
    const dismiss = (event: Event) => dispatch({ type: "dismiss", ids: [`renderer:${String((event as CustomEvent).detail)}`] });
    window.addEventListener(DESKTOP_TOAST_EVENT, receive);
    window.addEventListener(DESKTOP_TOAST_DISMISS_EVENT, dismiss);
    const unsubscribe = window.mixdogDesktop?.subscribeRelayPayloadRefused?.((detail) => {
      showDesktopToast(relayPayloadTooLargeMessage({
        bytes: detail?.bytes ?? null, limit: detail?.limit ?? null, callId: null, scope: "unknown",
      }), "error", { scope: "relay" });
    });
    return () => {
      window.removeEventListener(DESKTOP_TOAST_EVENT, receive);
      window.removeEventListener(DESKTOP_TOAST_DISMISS_EVENT, dismiss);
      unsubscribe?.();
    };
  }, []);
  const entries = groupToasts(records);
  const expiringIds = entries.filter((entry) => entry.tone !== "error").flatMap((entry) => entry.ids).join("\u0000");
  useEffect(() => {
    if (!expiringIds) return;
    const timer = window.setTimeout(() => dispatch({ type: "dismiss", ids: expiringIds.split("\u0000") }), 5000);
    return () => window.clearTimeout(timer);
  }, [expiringIds]);
  const shownErrors = entries.filter((entry) => entry.tone === "error").map((entry) => entry.text).join("\u0000");
  useEffect(() => {
    for (const text of shownErrors.split("\u0000").filter(Boolean)) reportRendererNotice(text);
  }, [shownErrors]);
  useLayoutEffect(() => {
    const measure = () => {
      const sheet = document.querySelector(".workspace")?.getBoundingClientRect();
      if (!sheet?.width || !sheet.height) return;
      const top = Math.max(16, sheet.top + 16);
      const next = {
        right: Math.max(16, window.innerWidth - sheet.right + 16), top,
        width: Math.min(320, Math.max(0, sheet.width - 32)), maxHeight: Math.max(0, sheet.bottom - top - 16),
      };
      setPlacement((current) => Object.keys(next).every((key) =>
        current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const sheet = document.querySelector(".workspace");
    if (observer && sheet) observer.observe(sheet);
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, []);
  if (!entries.length) return null;
  return createPortal(<section className="mx-toast-region" aria-label={t("Notifications")} aria-live="polite"
    data-count={entries.length} style={placement}>
    {entries.map((entry) => {
      const dismiss = () => {
        dispatch({ type: "dismiss", ids: entry.ids });
        if (entry.ids.includes("host:desktop-bridge")) onDismissBridgeError();
      };
      return <article className="mx-toast" data-tone={entry.tone} key={entry.key}>
        {entry.tone === "error" ? <ErrorNotice errors={entry.details} count={entry.count} onDismiss={dismiss} /> : <>
          {entry.tone === "success" ? <Check size={16} /> : <Sparkles size={16} />}
          <span className="mx-toast-copy" role="status"><b>{entry.tone === "success" ? t("Completed")
            : entry.tone === "warn" || entry.tone === "warning" ? t("Attention") : "Mixdog"}</b>
            <span>{entry.text}</span></span>
          <button type="button" className="mx-toast-close" aria-label={t("Dismiss notification")} onClick={dismiss}>
            <X size={16} />
          </button>
        </>}
      </article>;
    })}
  </section>, document.body);
}
