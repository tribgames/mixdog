import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { type NativeAppUpdateState, NATIVE_UPDATE_EVENT, nativeAppInfo } from '../shared/native-app';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';

// The Android phone app shell reports its own app-update state through the
// native bridge; this banner is the whole UI for it. Old shells answer the
// calls with null (or never answer): that reads as "feature absent".

export type AppUpdateAction = 'start' | 'cancel' | 'install' | 'hide' | 'retry' | 'browser';

export interface AppUpdateView {
  kind: 'available' | 'downloading' | 'ready' | 'failed';
  role: 'status' | 'alert';
  title: string;
  sub: string;
  /** 0-100 when the banner shows a progress bar. */
  progress?: number;
  actions: Array<{ id: AppUpdateAction; label: string; primary?: boolean; disabled?: boolean }>;
  closable?: boolean;
}

const MB = 1024 * 1024;
const formatMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

/** Which "hide for this session" slot a status belongs to. */
export function sessionHideGroup(status: NativeAppUpdateState['status']): string {
  if (status === 'ready' || status === 'needs-permission' || status === 'installing') return 'ready';
  return status;
}

export function isAppUpdateState(value: unknown): value is NativeAppUpdateState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'string' &&
    typeof (value as { installed?: unknown }).installed === 'string'
  );
}

export function appUpdateView(
  state: NativeAppUpdateState | null,
  hiddenGroup: string | null = null
): AppUpdateView | null {
  if (!state || hiddenGroup === sessionHideGroup(state.status)) return null;
  const version = state.version ?? '';
  switch (state.status) {
    case 'available':
      if (state.dismissed || !version) return null;
      return {
        kind: 'available',
        role: 'status',
        title: t('Mixdog app v{{version}} is available', { version }),
        sub: t('Currently installed: v{{installed}}', { installed: state.installed }),
        actions: [
          { id: 'start', label: t('Update'), primary: true },
          { id: 'hide', label: t('Later') },
        ],
      };
    case 'downloading': {
      // The shell downloads on its own: progress lives in Settings, not a toast.
      if (state.auto) return null;
      const received = state.receivedBytes ?? 0;
      const total = state.totalBytes ?? 0;
      const percent = downloadPercent(state);
      return {
        kind: 'downloading',
        role: 'status',
        title: t('Downloading v{{version}}…', { version }),
        sub: total > 0 ? `${formatMb(received)} / ${formatMb(total)} · ${percent}%` : formatMb(received),
        progress: percent,
        actions: [{ id: 'cancel', label: t('Cancel') }],
      };
    }
    case 'ready':
    case 'needs-permission':
    case 'installing': {
      const busy = state.status === 'installing';
      return {
        kind: 'ready',
        role: 'status',
        title: t('Phone app v{{version}} is ready to install', { version }),
        sub: t('Currently installed: v{{installed}}', { installed: state.installed }),
        progress: 100,
        actions: [
          { id: 'install', label: t('Install'), primary: true, disabled: busy },
          { id: 'hide', label: t('Later'), disabled: busy },
        ],
      };
    }
    case 'failed': {
      const sub =
        state.error === 'verify'
          ? t('The downloaded update could not be verified')
          : state.error === 'storage'
            ? t('Not enough storage space for the update')
            : state.error === 'install'
              ? t('The update could not be installed')
              : t('Check your network connection and try again');
      return {
        kind: 'failed',
        role: 'alert',
        title: t("Couldn't download the update"),
        sub,
        actions: [
          { id: 'retry', label: t('Try again'), primary: true },
          { id: 'browser', label: t('Get in browser') },
        ],
        closable: true,
      };
    }
    default:
      return null;
  }
}

/** An update is on its way or waiting: available, downloading or downloaded. */
export function isAppUpdatePending(state: NativeAppUpdateState | null): boolean {
  if (!state) return false;
  if (state.status === 'available') return Boolean(state.version);
  return state.status === 'downloading' || sessionHideGroup(state.status) === 'ready';
}

export function downloadPercent(state: NativeAppUpdateState): number {
  const total = state.totalBytes ?? 0;
  return total > 0 ? Math.min(100, Math.max(0, Math.floor(((state.receivedBytes ?? 0) / total) * 100))) : 0;
}

export interface PhoneAppUpdateView {
  current: string;
  /** Newest known version; the installed one when nothing newer is known. */
  latest: string;
  /** Failure line under the group title, when the last check or download failed. */
  note: string;
  /** A check or a download is under way: "Check now" waits. */
  busy: boolean;
  install: { id: 'install' | 'start' | null; label: string };
}

function clockLabel(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleTimeString(uiFormatLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...timeFormatOptions(),
  });
}

/** Settings view of the phone app's update: always shown, ignores `dismissed`.
 *  Mirrors the host updater rows (current / latest / check / install). */
export function phoneAppUpdateView(state: NativeAppUpdateState | null, installedFallback = ''): PhoneAppUpdateView {
  const current = state?.installed || installedFallback;
  const version = state?.version ?? '';
  const view: PhoneAppUpdateView = {
    current,
    latest: version || current,
    note: '',
    busy: false,
    install: { id: null, label: t('Check for update') },
  };
  if (!state) return view;
  if (state.lastCheckError) {
    const time = clockLabel(state.lastCheckAt);
    view.note = time
      ? t("Couldn't check for updates · last tried {{time}}", { time })
      : t("Couldn't check for updates");
  }
  switch (state.status) {
    case 'checking':
      return { ...view, busy: true, install: { id: null, label: t('Checking for update…') } };
    case 'available':
      if (!version) break;
      return { ...view, install: { id: 'start', label: t('Update to v{{version}}', { version }) } };
    case 'downloading':
      return {
        ...view,
        busy: true,
        install: {
          id: null,
          label: t('Downloading v{{version}}… {{percent}}%', { version, percent: downloadPercent(state) }),
        },
      };
    case 'ready':
    case 'needs-permission':
      return { ...view, install: { id: 'install', label: t('Update to v{{version}}', { version }) } };
    case 'installing':
      return { ...view, install: { id: null, label: t('Installing v{{version}}…', { version }) } };
    case 'failed':
      view.note ||= t("Couldn't download the update");
      return version ? { ...view, install: { id: 'start', label: t('Try again') } } : view;
    case 'up-to-date':
      return { ...view, install: { id: null, label: t('Up to date') } };
    default:
  }
  return view;
}
/** Cached update state of the Android shell; null off Android or on old shells. */
export function useNativeAppUpdate() {
  const [state, setState] = useState<NativeAppUpdateState | null>(null);
  const info = nativeAppInfo();
  const call = info?.platform === 'android' ? info.call : undefined;
  const bridge = call ? info : null;

  const apply = useCallback((next: unknown) => {
    setState(isAppUpdateState(next) ? next : null);
  }, []);

  useEffect(() => {
    if (!bridge?.call) return undefined;
    let live = true;
    // Cached state only: the shell paces its own release lookups, and the
    // unauthenticated GitHub API is rate-limited per IP.
    const refresh = () => {
      bridge
        .call?.('getAppUpdate', {})
        .then((next) => live && apply(next))
        .catch(() => live && apply(null));
    };
    const onEvent = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener(NATIVE_UPDATE_EVENT, onEvent);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener(NATIVE_UPDATE_EVENT, onEvent);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bridge, apply]);

  return { bridge, state, apply };
}

export function AppUpdateBanner() {
  const { bridge, state, apply } = useNativeAppUpdate();
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    setHidden((current) => (state && current === sessionHideGroup(state.status) ? current : null));
  }, [state]);

  const view = bridge ? appUpdateView(state, hidden) : null;
  if (!bridge?.call || !view || !state) return null;

  const run = (id: AppUpdateAction) => {
    const native = bridge.call;
    if (!native) return;
    if (id === 'hide') {
      setHidden(sessionHideGroup(state.status));
      return;
    }
    if (id === 'browser') {
      void native('openAppUpdateInBrowser').catch(() => undefined);
      return;
    }
    const request =
      id === 'start' || id === 'retry'
        ? native('startAppUpdate')
        : id === 'cancel'
          ? native('cancelAppUpdate')
          : native('installAppUpdate');
    void request.then(apply).catch(() => undefined);
  };

  const strip = document.querySelector('.main-panel .workspace-tabs-shell')?.getBoundingClientRect();
  return createPortal(
    <div
      className="mx-toast app-update-banner"
      data-modal-background
      data-kind={view.kind}
      role={view.role}
      aria-busy={view.kind === 'downloading' || undefined}
      style={strip?.height ? { top: Math.round(strip.bottom + 8) } : undefined}
    >
      <div className="app-update-copy">
        <b>{view.title}</b>
        <span className="app-update-sub">{view.sub}</span>
        {view.progress === undefined ? null : (
          <div className="app-update-meter" data-done={view.kind === 'ready' || undefined}>
            <i style={{ width: `${view.progress}%` }} />
          </div>
        )}
        <div className="app-update-actions">
          {view.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={action.primary ? 'mx-button is-primary' : 'mx-button'}
              disabled={action.disabled}
              onClick={() => run(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
      {view.closable ? (
        <button
          type="button"
          className="app-update-close"
          aria-label={t('Dismiss update notice')}
          onClick={() => run('hide')}
        >
          ×
        </button>
      ) : null}
    </div>,
    document.body
  );
}
