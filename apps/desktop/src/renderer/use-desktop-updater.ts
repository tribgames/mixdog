import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopUpdaterState } from '../shared/contract';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';
import { isSshConnectionWindow } from './desktop-connection';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

type Invoke = (action: () => unknown) => Promise<void>;

/** The toast a download's outcome earns: only a change seen from `downloading`,
 *  so polling, a repeated state or an update already downloaded at app start
 *  announces nothing. */
export function updaterOutcomeToast(
  previous: DesktopUpdaterState,
  next: DesktopUpdaterState
): { text: string; tone: 'success' | 'error' } | null {
  if (previous.status !== 'downloading') return null;
  if (next.status === 'ready') {
    return {
      text: t('Mixdog v{{version}} downloaded. Restart to apply the update.', { version: next.version }),
      tone: 'success',
    };
  }
  if (next.status === 'error') {
    return { text: t('Could not download the update: {{error}}', { error: next.message }), tone: 'error' };
  }
  return null;
}

/** Why an install was held back: running agent tasks, or a status that could not be read. */
export function updaterBusyNotice(busyTasks: number | null): string {
  return busyTasks === null
    ? t('Could not check whether agent tasks are running. Installing now may stop them.')
    : t('{{count}} agent tasks running. Installing now stops them.', { count: busyTasks });
}

export function useDesktopUpdater(invoke: Invoke) {
  const [state, setStateRaw] = useState<DesktopUpdaterState>({ status: 'disabled' });
  const latest = useRef(state);
  const setState = useCallback((next: DesktopUpdaterState) => {
    const toast = updaterOutcomeToast(latest.current, next);
    latest.current = next;
    setStateRaw(next);
    if (toast) showDesktopToast(toast.text, toast.tone);
  }, []);
  const [ready, setReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (state.status !== 'ready') setDialogOpen(false);
  }, [state.status]);

  useEffect(() => {
    // The updater is this PC's: a server window offers no update entry.
    if (isSshConnectionWindow()) {
      setReady(true);
      return;
    }
    const host = window.mixdogDesktop;
    let live = true;
    const getState = host?.getUpdaterState;
    const read =
      typeof getState === 'function'
        ? () => {
            void getState()
              .then((next) => {
                if (live) setState(next);
              })
              .catch(() => {})
              .finally(() => {
                if (live) setReady(true);
              });
          }
        : null;
    if (read) read();
    else setReady(true);
    const unsubscribe = host?.subscribeUpdaterState?.((next) => {
      if (live) setState(next);
    });
    // Remote clients: a read made while the connection was down fails and
    // would leave the update state stale until a reload.
    if (read) window.addEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    return () => {
      live = false;
      unsubscribe?.();
      if (read) window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    };
  }, [setState]);

  const openDialog = useCallback(() => {
    if (state.status === 'ready') setDialogOpen(true);
  }, [state.status]);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  // The dialog stays up when the install is held back for the user to confirm;
  // a started install leaves `ready`, which closes it.
  const install = useCallback((confirmed?: boolean) => {
    void invoke(async () => {
      const next = await window.mixdogDesktop.showDesktopUpdate(confirmed === true);
      setState(next);
    });
  }, [invoke, setState]);

  return {
    state,
    ready,
    dialogOpen,
    openDialog,
    closeDialog,
    install,
  };
}
