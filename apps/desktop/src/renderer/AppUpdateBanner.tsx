import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { type NativeAppUpdateState, NATIVE_UPDATE_EVENT, nativeAppInfo } from '../shared/native-app';
import { t } from './i18n';

// The Android phone app shell reports its own app-update state through the
// native bridge; this banner is the whole UI for it. Old shells answer the
// calls with null (or never answer): that reads as "feature absent".

export type AppUpdateAction = 'start' | 'later' | 'cancel' | 'install' | 'hide' | 'retry' | 'browser';

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
          { id: 'later', label: t('Later') },
        ],
      };
    case 'downloading': {
      const received = state.receivedBytes ?? 0;
      const total = state.totalBytes ?? 0;
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((received / total) * 100))) : 0;
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
        title: t('v{{version}} downloaded', { version }),
        sub: t('Installing continues on the Android install screen'),
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

export function AppUpdateBanner() {
  const [state, setState] = useState<NativeAppUpdateState | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const info = nativeAppInfo();
  const call = info?.platform === 'android' ? info.call : undefined;
  const bridge = call ? info : null;

  const apply = useCallback((next: unknown) => {
    const valid = isAppUpdateState(next) ? next : null;
    setState(valid);
    setHidden((current) => (valid && current === sessionHideGroup(valid.status) ? current : null));
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
          : id === 'install'
            ? native('installAppUpdate')
            : native('dismissAppUpdate', { version: state.version ?? '' });
    void request.then(apply).catch(() => undefined);
  };

  const strip = document.querySelector('.main-panel .workspace-tabs-shell')?.getBoundingClientRect();
  return createPortal(
    <div
      className="mx-toast app-update-banner"
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
