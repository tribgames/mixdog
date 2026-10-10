import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Sparkles, X } from 'lucide-react';
import { t } from './i18n';
import type { Toast } from './desktop-types';
import { ErrorNotice, safeErrorDetails } from './ErrorNotice';
import { groupToasts, reduceToasts } from './desktop-toast-state';
import { reportRendererNotice } from './RendererRecovery';
import { presentedModalDialog } from './surface-input-focus';
import { relayPayloadTooLargeMessage } from '../shared/remote-payload-limit';

function toastTitle(tone: string): string {
  if (tone === 'success') return t('Completed');
  return tone === 'warn' || tone === 'warning' ? t('Attention') : 'Mixdog';
}

export const DESKTOP_TOAST_EVENT = 'mixdog:desktop-toast';
export const DESKTOP_TOAST_DISMISS_EVENT = 'mixdog:desktop-toast-dismiss';
type DesktopToastTone = 'info' | 'success' | 'warn' | 'error';
let sequence = 0;
type DesktopToastOptions = { scope?: string; groupKey?: string; lifetime?: 'event' | 'state' };

export function showDesktopToast(
  text: string,
  tone: DesktopToastTone = 'info',
  options: DesktopToastOptions = {}
): string | undefined {
  const message = safeErrorDetails(text);
  if (!message || typeof window === 'undefined') return;
  const id = `renderer:${Date.now()}:${++sequence}`;
  window.dispatchEvent(
    new window.CustomEvent<Toast>(DESKTOP_TOAST_EVENT, {
      detail: { id, text: message, tone, ...options },
    })
  );
  return id;
}

export function dismissDesktopToast(id: string | undefined) {
  if (!id || typeof window === 'undefined') return;
  window.dispatchEvent(new window.CustomEvent(DESKTOP_TOAST_DISMISS_EVENT, { detail: id }));
}

/** State-owned errors also close on success or unmount, before their toast expires. */
export function useErrorToast(error: string, scope: string) {
  useEffect(() => {
    if (!error) return;
    const id = showDesktopToast(error, 'error', { scope, lifetime: 'state' });
    return () => dismissDesktopToast(id);
  }, [error, scope]);
}

export function DesktopToastRegion({
  bridgeError,
  toasts,
  onDismissBridgeError,
}: {
  bridgeError: string;
  toasts: Toast[];
  onDismissBridgeError(): void;
}) {
  const [records, dispatch] = useReducer(reduceToasts, []);
  const expiryTimers = useRef(new Map<string, { record: (typeof records)[number]; timer: number }>());
  const [placement, setPlacement] = useState({ right: 16, top: 54, width: 320, maxHeight: 400 });
  const hostToasts = [
    ...toasts,
    ...(bridgeError ? [{ id: 'desktop-bridge', text: bridgeError, tone: 'error', lifetime: 'state' }] : []),
  ];
  const hostToken = JSON.stringify(hostToasts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hostToken is the serialized content of hostToasts; a fresh array identity alone must not re-dispatch.
  useEffect(() => {
    dispatch({ type: 'host', toasts: hostToasts });
  }, [hostToken]);
  useLayoutEffect(() => {
    const receive = (event: Event) => dispatch({ type: 'receive', toast: (event as CustomEvent<Toast>).detail });
    const dismiss = (event: Event) =>
      dispatch({ type: 'dismiss', ids: [`renderer:${String((event as CustomEvent).detail)}`] });
    window.addEventListener(DESKTOP_TOAST_EVENT, receive);
    window.addEventListener(DESKTOP_TOAST_DISMISS_EVENT, dismiss);
    const unsubscribe = window.mixdogDesktop?.subscribeRelayPayloadRefused?.((detail) => {
      showDesktopToast(
        relayPayloadTooLargeMessage({
          bytes: detail?.bytes ?? null,
          limit: detail?.limit ?? null,
          callId: null,
          scope: 'unknown',
        }),
        'error',
        { scope: 'relay' }
      );
    });
    return () => {
      window.removeEventListener(DESKTOP_TOAST_EVENT, receive);
      window.removeEventListener(DESKTOP_TOAST_DISMISS_EVENT, dismiss);
      unsubscribe?.();
    };
  }, []);
  const entries = groupToasts(records);
  useEffect(() => {
    const timers = expiryTimers.current;
    const activeIds = new Set(records.filter((record) => !record.dismissed).map((record) => record.id));
    for (const [id, pending] of timers) {
      if (!activeIds.has(id)) {
        window.clearTimeout(pending.timer);
        timers.delete(id);
      }
    }
    for (const record of records) {
      if (record.dismissed) continue;
      const pending = timers.get(record.id);
      if (pending?.record === record) continue;
      if (pending) window.clearTimeout(pending.timer);
      const timer = window.setTimeout(
        () => {
          timers.delete(record.id);
          dispatch({ type: 'dismiss', ids: [record.id] });
        },
        record.tone === 'error' ? 10000 : 5000
      );
      timers.set(record.id, { record, timer });
    }
  }, [records]);
  useEffect(() => {
    const timers = expiryTimers.current;
    return () => {
      for (const pending of timers.values()) window.clearTimeout(pending.timer);
      timers.clear();
    };
  }, []);
  const shownErrors = entries
    .filter((entry) => entry.tone === 'error')
    .map((entry) => entry.text)
    .join('\u0000');
  useEffect(() => {
    for (const text of shownErrors.split('\u0000').filter(Boolean)) reportRendererNotice(text);
  }, [shownErrors]);
  const entryCount = entries.length;
  const hasEntries = entryCount > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasEntries/entryCount re-measure the lane when toasts appear or disappear; measure reads the DOM, not these values.
  useLayoutEffect(() => {
    // Anchor to the single main panel, below its tab strip. Every open tab
    // keeps its own `.workspace` sheet mounted (parked ones included), so the
    // first sheet in the document is not the visible one.
    const measure = () => {
      const panel = document.querySelector('.main-panel');
      const sheet = panel?.getBoundingClientRect();
      if (!sheet?.width || !sheet.height) return;
      const strip = panel?.querySelector('.workspace-tabs-shell')?.getBoundingClientRect();
      const right = Math.max(16, window.innerWidth - sheet.right + 16);
      const width = Math.min(320, Math.max(0, sheet.width - 32));
      let top = Math.max(16, (strip?.height ? strip.bottom : sheet.top) + 16);
      // A presented modal keeps its header (title, close) reachable: a lane
      // whose toasts would cover that header starts just below it instead.
      const header = presentedModalDialog()
        ?.querySelector(':scope > header, .mixdog-settings__header')
        ?.getBoundingClientRect();
      const region = document.querySelector('.mx-toast-region');
      const first = region?.firstElementChild?.getBoundingClientRect();
      const last = region?.lastElementChild?.getBoundingClientRect();
      const laneHeight = first && last ? last.bottom - first.top : 0;
      const laneRight = window.innerWidth - right;
      if (
        header?.height &&
        header.left < laneRight &&
        header.right > laneRight - width &&
        header.top < top + laneHeight &&
        header.bottom > top
      ) {
        top = Math.round(header.bottom + 8);
      }
      const next = { right, top, width, maxHeight: Math.max(0, sheet.bottom - top - 16) };
      setPlacement((current) =>
        Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next])
          ? current
          : next
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const panel = document.querySelector('.main-panel');
    if (observer && panel) observer.observe(panel);
    // Dialogs portal in as body children or flip their modal state in place;
    // a second pass lands after their entrance motion settles.
    let settle = 0;
    const remeasure = () => {
      measure();
      window.clearTimeout(settle);
      settle = window.setTimeout(measure, 220);
    };
    const mounts = new MutationObserver(remeasure);
    mounts.observe(document.body, { childList: true });
    const modality = new MutationObserver(remeasure);
    modality.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      mounts.disconnect();
      modality.disconnect();
      window.clearTimeout(settle);
    };
  }, [hasEntries, entryCount]);
  if (!hasEntries) return null;
  return createPortal(
    <section
      className="mx-toast-region"
      aria-label={t('Notifications')}
      aria-live="polite"
      data-count={entries.length}
      style={placement}
    >
      {entries.map((entry) => {
        const dismiss = () => {
          dispatch({ type: 'dismiss', ids: entry.ids });
          if (entry.ids.includes('host:desktop-bridge')) onDismissBridgeError();
        };
        const ToastGlyph = entry.tone === 'success' ? Check : Sparkles;
        return (
          <article className="mx-toast" data-tone={entry.tone} key={entry.key}>
            {entry.tone === 'error' ? (
              <ErrorNotice errors={entry.details} count={entry.count} onDismiss={dismiss} />
            ) : (
              <>
                <ToastGlyph size={16} />
                <span className="mx-toast-copy" role="status">
                  <b>{toastTitle(entry.tone)}</b>
                  <span>{entry.text}</span>
                </span>
                <button
                  type="button"
                  className="mx-toast-close"
                  aria-label={t('Dismiss notification')}
                  onClick={dismiss}
                >
                  <X size={16} />
                </button>
              </>
            )}
          </article>
        );
      })}
    </section>,
    document.body
  );
}
