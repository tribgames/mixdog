import { type Dispatch, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Sparkles, X } from 'lucide-react';
import { t } from './i18n';
import type { Toast } from './desktop-types';
import { ErrorNotice, safeErrorDetails } from './ErrorNotice';
import { groupToasts, reduceToasts } from './desktop-toast-state';
import { reportRendererNotice } from './RendererRecovery';
import { presentedModalDialog } from './surface-input-focus';
import { isPhoneSurfaceMarked } from './mobile-surface';
import { phoneSafeInsets } from './anchored-panel';
import { relayPayloadTooLargeMessage } from '../shared/remote-payload-limit';
import { type DesktopNotice, readDesktopNotice } from '../shared/desktop-notice';
import { useSectionEntries } from './section-store';

function toastTitle(tone: string): string {
  if (tone === 'success') return t('Completed');
  return tone === 'warn' || tone === 'warning' ? t('Attention') : t('Notice');
}

/** Shown (translated) when an always-allow choice was applied once but not saved. */
const ALLOW_NOT_SAVED_TEXT = 'Allowed this once. The setting could not be saved.';
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

/** A main-process or service notice (shared/desktop-notice.ts) as its toast. */
function desktopNoticeToast(notice: DesktopNotice): { text: string; tone: DesktopToastTone } {
  const name = notice.params.name || '';
  switch (notice.code) {
    case 'provider-sign-in-expired':
      return {
        text: t('Your {{name}} sign-in has expired or was refused. Sign in again under Settings → Providers.', { name }),
        tone: 'warn',
      };
    case 'connector-sign-in-expired':
      return { text: t('{{name}} needs you to sign in again. Reconnect it in Connectors.', { name }), tone: 'warn' };
    case 'secret-storage-failed':
      return {
        text: t(
          "This computer's secure storage is not working, so saved keys, passwords, and sign-ins could not be read or saved. Check the system keychain, then restart the app."
        ),
        tone: 'error',
      };
    case 'conversation-save-failed':
      return {
        text: t('A conversation could not be saved. Recent messages may be lost if the app closes.'),
        tone: 'error',
      };
    case 'offload-prune-blocked':
      return {
        text: t(
          'Saved tool output cannot be cleaned up because conversation {{name}} cannot be read. Disk use will keep growing until that conversation can be read again or is deleted.',
          { name }
        ),
        tone: 'warn',
      };
    case 'memory-runtime-preparing':
      return {
        text:
          notice.params.stage === 'embedding'
            ? t('Downloading the memory search model for the first time. This can take a few minutes.')
            : t('Downloading the memory database for the first time. This can take a few minutes.'),
        tone: 'info',
      };
    case 'remote-restore-declined':
      return {
        text: t('Remote could not be turned back on because its session no longer exists. Turn it on again.'),
        tone: 'warn',
      };
  }
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

type ToastRecords = ReturnType<typeof reduceToasts>;
type ToastDispatch = Dispatch<Parameters<typeof reduceToasts>[1]>;
type LanePlacement = { right: number; top: number; width: number; maxHeight: number };

const TOAST_LIFETIME_MS = 5000;
const TOAST_ERROR_LIFETIME_MS = 10000;

function useToastExpiry(records: ToastRecords, dispatch: ToastDispatch) {
  const timers = useRef(new Map<string, { record: ToastRecords[number]; timer: number }>());
  useEffect(() => {
    const pendingTimers = timers.current;
    const activeIds = new Set(records.filter((record) => !record.dismissed).map((record) => record.id));
    for (const [id, pending] of pendingTimers) {
      if (!activeIds.has(id)) {
        window.clearTimeout(pending.timer);
        pendingTimers.delete(id);
      }
    }
    for (const record of records) {
      if (record.dismissed) continue;
      const pending = pendingTimers.get(record.id);
      if (pending?.record === record) continue;
      if (pending) window.clearTimeout(pending.timer);
      const timer = window.setTimeout(
        () => {
          pendingTimers.delete(record.id);
          dispatch({ type: 'dismiss', ids: [record.id] });
        },
        record.tone === 'error' ? TOAST_ERROR_LIFETIME_MS : TOAST_LIFETIME_MS
      );
      pendingTimers.set(record.id, { record, timer });
    }
  }, [records, dispatch]);
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const pending of pendingTimers.values()) window.clearTimeout(pending.timer);
      pendingTimers.clear();
    };
  }, []);
}

/** One toast per standing `notice` section entry (key = notice key), shown again only after the key left and came back; a withdrawn notice leaves with its toast. */
function useStandingNoticeToasts() {
  const noticeEntries = useSectionEntries('notice');
  const shownNotices = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    const shown = shownNotices.current;
    const standing = new Set<string>();
    for (const entry of noticeEntries) {
      const notice = readDesktopNotice(entry.value);
      if (!notice) continue;
      standing.add(notice.key);
      if (shown.has(notice.key)) continue;
      const { text, tone } = desktopNoticeToast(notice);
      shown.set(notice.key, showDesktopToast(text, tone, { groupKey: notice.key }));
    }
    for (const [key, toastId] of shown) {
      if (standing.has(key)) continue;
      dismissDesktopToast(toastId);
      shown.delete(key);
    }
  }, [noticeEntries]);
}

/** The lane's place beside the single main panel, below its tab strip, clear of a presented modal's header and the phone update banner; null while the panel has no size. */
function measureToastLane(): LanePlacement | null {
  const panel = document.querySelector('.main-panel');
  const sheet = panel?.getBoundingClientRect();
  if (!sheet?.width || !sheet.height) return null;
  const strip = panel?.querySelector('.workspace-tabs-shell')?.getBoundingClientRect();
  // The PC lane is a 320px column at the right; a phone's spans the screen
  // inside the notch's safe area.
  const inset = phoneSafeInsets();
  const right = Math.max(16, window.innerWidth - sheet.right + 16) + inset.right;
  const room = Math.max(0, sheet.width - 32 - inset.left - inset.right);
  const width = isPhoneSurfaceMarked() ? room : Math.min(320, room);
  let top = Math.max(16, (strip?.height ? strip.bottom : sheet.top) + 16);
  const header = presentedModalDialog()
    ?.querySelector(':scope > header, .mixdog-settings__header')
    ?.getBoundingClientRect();
  const banner = document.querySelector('.app-update-banner')?.getBoundingClientRect();
  if (banner?.height) top = Math.max(top, Math.round(banner.bottom + 8));
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
  return { right, top, width, maxHeight: Math.max(0, sheet.bottom - top - 16) };
}

function useToastLanePlacement(hasEntries: boolean, entryCount: number): LanePlacement {
  const [placement, setPlacement] = useState<LanePlacement>({ right: 16, top: 54, width: 320, maxHeight: 400 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasEntries/entryCount re-measure the lane when toasts appear or disappear; measure reads the DOM, not these values.
  useLayoutEffect(() => {
    if (!hasEntries) return undefined;
    const measure = () => {
      const next = measureToastLane();
      if (!next) return;
      setPlacement((current) =>
        (Object.keys(next) as Array<keyof LanePlacement>).every((key) => current[key] === next[key]) ? current : next
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const panel = document.querySelector('.main-panel');
    if (observer && panel) observer.observe(panel);
    else window.addEventListener('resize', measure);
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
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      mounts.disconnect();
      modality.disconnect();
      window.clearTimeout(settle);
    };
  }, [hasEntries, entryCount]);
  return placement;
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
  const hostToasts = [
    // The main process owns the lasting-outage toast and sends its English key.
    ...toasts.map((toast) => {
      if (
        toast.id === 'service-connection-stopped' &&
        toast.text === 'The service connection has been lost for a while. Still retrying automatically.'
      ) {
        return { ...toast, text: t('The service connection has been lost for a while. Still retrying automatically.') };
      }
      // The runtime sends its English key when a "항상 허용" could not be saved.
      return toast.text === ALLOW_NOT_SAVED_TEXT
        ? { ...toast, text: t('Allowed this once. The setting could not be saved.') }
        : toast;
    }),
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
    const unsubscribeNotices = window.mixdogDesktop?.subscribeDesktopNotices?.((notice) => {
      const { text, tone } = desktopNoticeToast(notice);
      showDesktopToast(text, tone, { groupKey: notice.key });
    });
    return () => {
      window.removeEventListener(DESKTOP_TOAST_EVENT, receive);
      window.removeEventListener(DESKTOP_TOAST_DISMISS_EVENT, dismiss);
      unsubscribe?.();
      unsubscribeNotices?.();
    };
  }, []);
  useStandingNoticeToasts();
  const entries = groupToasts(records);
  useToastExpiry(records, dispatch);
  const shownErrors = entries
    .filter((entry) => entry.tone === 'error')
    .map((entry) => entry.text)
    .join('\u0000');
  useEffect(() => {
    for (const text of shownErrors.split('\u0000').filter(Boolean)) reportRendererNotice(text);
  }, [shownErrors]);
  const entryCount = entries.length;
  const hasEntries = entryCount > 0;
  const placement = useToastLanePlacement(hasEntries, entryCount);
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
