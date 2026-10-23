import { useEffect, useRef, useState } from 'react';

import type {
  DesktopSshConfigHost,
  DesktopSshConfigSummary,
  DesktopSshConnectRequest,
  DesktopSshHost,
  DesktopSshHostKeyCheck,
  DesktopSshProgress,
} from '../../shared/contract-ssh';
import type { CapabilityApi } from './capability-data';
import type { SshHostRequest } from './connection-intent';
import { useSshAskpass } from './ssh-askpass-prompt';
import { START_VIEW, type View, viewForFailure, viewForHostKey } from './ssh-connect-view';
import { sshErrorText } from './ssh-error-text';

const failed = (reason: unknown): View => ({
  kind: 'failure',
  failure: { kind: 'failed', message: sshErrorText(reason) },
});

/** The progress list moves on only while the steps are showing. */
function withProgress(current: View, progress: DesktopSshProgress): View {
  if (current.kind !== 'steps') return current;
  return {
    ...current,
    phase: progress.phase,
    details: progress.detail ? { ...current.details, [progress.phase]: progress.detail } : current.details,
    sawInstall: current.sawInstall || progress.phase === 'install',
  };
}

/** The connection attempt behind the connect dialog: the view it shows, the
 *  inspection/connect calls to main, and the attempt main holds for it. A saved
 *  `host` starts connecting on mount; the attempt is released on unmount. */
export function useSshConnectAttempt({
  api,
  host,
  onConnected,
  onClose,
}: {
  api: CapabilityApi;
  host: SshHostRequest | null;
  onConnected?(host: DesktopSshHost): void;
  onClose(): void;
}) {
  const [view, setView] = useState<View>(host ? START_VIEW : { kind: 'input' });
  const [shown, setShown] = useState({ target: host?.target ?? '', name: host?.name ?? '' });
  const [summary, setSummary] = useState<DesktopSshConfigSummary | null>(null);
  const [configHosts, setConfigHosts] = useState<DesktopSshConfigHost[]>([]);
  const attempt = useRef(0);
  // The inspection waiting for the user's answer to the forwards notice, and whether they accepted it.
  const pendingInspection = useRef<{ attemptId: string; check: DesktopSshHostKeyCheck } | null>(null);
  const acceptForwards = useRef(false);
  // From the advanced options; kept across retries and the jump chain's re-runs of the same address.
  const enteredSettings = useRef<DesktopSshConnectRequest['settings']>(undefined);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // The attempt main opened for the address being connected ('' when none). It
  // fixes the address and the host key; every later call just names it.
  const attemptId = useRef('');

  /** Lets main drop the attempt this dialog holds: a key nobody confirmed, a
   *  connection in flight, a daemon nobody will stop. */
  const releaseAttempt = (): void => {
    const id = attemptId.current;
    attemptId.current = '';
    if (id) void api.sshCancel?.(id)?.catch(() => undefined);
  };
  const cancelAttempt = (): void => {
    attempt.current += 1;
    releaseAttempt();
  };

  const { question, answer } = useSshAskpass(api, (id) => id === attemptId.current);

  /** Connects the inspected attempt. `trust` is the user's confirmation of its
   *  key, `replace` the server name typed to replace a changed key, `restart`
   *  the confirmation to stop and replace the daemon the first try found. */
  const connectInspected = async (
    mine: number,
    options: { trust?: boolean; replace?: string; restart?: boolean } = {}
  ): Promise<void> => {
    const live = () => mine === attempt.current;
    setView(START_VIEW);
    try {
      const result = await api.sshConnect?.({
        attemptId: attemptId.current,
        trustHostKey: options.trust === true,
        ...(options.replace ? { replaceHostKey: options.replace } : {}),
        ...(options.restart ? { forceRestart: true } : {}),
        ...(acceptForwards.current ? { acceptForwards: true } : {}),
        ...(enteredSettings.current ? { settings: enteredSettings.current } : {}),
      });
      if (!live() || !result) return;
      // Main keeps the attempt only for a daemon it may be asked to restart.
      if (result.ok || (result.failure.kind !== 'daemon-running' && result.failure.kind !== 'daemon-busy'))
        attemptId.current = '';
      if (!result.ok && result.failure.kind === 'host-key-next') {
        // The key shown was saved; the next server on the jump chain is checked the same way.
        void runRef.current(shownRef.current.target, shownRef.current.name);
        return;
      }
      if (result.ok) {
        onConnected?.(result.host);
        onClose();
        return;
      }
      setView(viewForFailure(result.failure));
    } catch (reason) {
      if (!live()) return;
      attemptId.current = '';
      setView(failed(reason));
    }
  };

  /** After the inspection (and the forwards notice, when there is one): the key question, or the connection. */
  const proceed = async (mine: number, inspection: { check: DesktopSshHostKeyCheck }): Promise<void> => {
    if (inspection.check.status !== 'trusted') {
      setView(viewForHostKey(inspection.check));
      return;
    }
    await connectInspected(mine);
  };
  const acceptForwardsNotice = (): void => {
    const inspection = pendingInspection.current;
    if (!inspection) return;
    pendingInspection.current = null;
    acceptForwards.current = true;
    void proceed(++attempt.current, inspection);
  };

  const run = async (target: string, name: string, settings?: DesktopSshConnectRequest['settings']): Promise<void> => {
    if (settings)
      enteredSettings.current = settings.identityFile?.trim() || settings.remoteCwd?.trim() ? settings : undefined;
    const mine = ++attempt.current;
    const live = () => mine === attempt.current;
    releaseAttempt();
    acceptForwards.current = false;
    pendingInspection.current = null;
    setShown({ target, name });
    setSummary(null);
    setView(START_VIEW);
    try {
      const inspection = await api.sshInspectHostKey?.(target);
      if (!inspection) return;
      if (!live()) {
        void api.sshCancel?.(inspection.attemptId)?.catch(() => undefined);
        return;
      }
      attemptId.current = inspection.attemptId;
      setSummary(inspection.summary ?? null);
      if (inspection.summary?.forwards && inspection.summary.forwards.length > 0) {
        pendingInspection.current = inspection;
        setView({ kind: 'forwards', forwards: inspection.summary.forwards });
        return;
      }
      await proceed(mine, inspection);
    } catch (reason) {
      if (live()) setView(failed(reason));
    }
  };
  const confirmHostKey = (): void => {
    void connectInspected(++attempt.current, { trust: true });
  };
  const replaceHostKey = (typedName: string): void => {
    void connectInspected(++attempt.current, { replace: typedName });
  };
  /** The user confirmed replacing the daemon the first try found: the same attempt connects again, asking the server to restart. */
  const restartAndConnect = (): void => {
    void connectInspected(++attempt.current, { restart: true });
  };
  const runRef = useRef(run);
  runRef.current = run;
  const cancelRef = useRef(cancelAttempt);
  cancelRef.current = cancelAttempt;

  /** Back to the address field, dropping the attempt. */
  const editAddress = (): void => {
    cancelAttempt();
    setView({ kind: 'input' });
  };
  /** ConfirmDialog closes before it confirms, in the same click. Going back to
   *  the address waits one tick so a confirmed restart, which starts its own
   *  connect synchronously, keeps the attempt main is holding for it. */
  const dismissDaemon = (onEdited: () => void): void => {
    const mine = attempt.current;
    queueMicrotask(() => {
      if (mine !== attempt.current) return;
      editAddress();
      onEdited();
    });
  };

  useEffect(() => {
    const unsubscribe = api.subscribeSshProgress?.((progress) => {
      if (progress.attemptId !== attemptId.current) return;
      setView((current) => withProgress(current, progress));
    });
    return unsubscribe;
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the dialog's lifetime; `host` is its initial server.
  useEffect(() => {
    let live = true;
    void api
      .sshConfigHosts?.()
      ?.then((hosts) => live && setConfigHosts(hosts))
      .catch(() => undefined);
    if (host) void runRef.current(host.target, host.name);
    return () => {
      live = false;
      cancelRef.current();
    };
  }, []);

  return {
    view,
    shown,
    summary,
    configHosts,
    question,
    answer,
    run,
    cancelAttempt,
    editAddress,
    dismissDaemon,
    confirmHostKey,
    replaceHostKey,
    restartAndConnect,
    acceptForwardsNotice,
  };
}
