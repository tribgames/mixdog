import { useEffect, useRef, useState } from 'react';

import type { DesktopSshServerLogin, DesktopSshServerLoginFlow } from '../../shared/contract-ssh';
import {
  sshServerLoginBegin,
  sshServerLoginCancel,
  sshServerLoginComplete,
  sshServerLoginStatus,
  subscribeSshServerLoginUpdated,
} from '../connections-core-api';
import { t } from '../i18n';
import { followSettingsReadConnection, startSettingsReadRecovery } from './read-recovery';
import { isConnectFirstError, isUnknownSshLoginFlow, sshErrorText } from './ssh-error-text';

export function useSshServerLoginFlow({
  hostId,
  hostName,
  refresh,
  setError,
  report,
}: {
  hostId: string;
  hostName: string;
  refresh(): void;
  setError(message: string): void;
  report(reason: unknown): void;
}) {
  const [flow, setFlow] = useState<DesktopSshServerLoginFlow | null>(null);
  const [flowName, setFlowName] = useState('');
  const [pasteError, setPasteError] = useState('');
  const flowRef = useRef<DesktopSshServerLoginFlow | null>(null);
  const mounted = useRef(true);

  const cancelFlow = (flowId: string): void => {
    void Promise.resolve(sshServerLoginCancel(hostId, flowId)).catch(() => undefined);
  };
  const cancelPending = (): void => {
    const pending = flowRef.current;
    if (pending?.state !== 'pending') return;
    flowRef.current = null;
    cancelFlow(pending.flowId);
  };
  // A login still pending when the dialog goes is cancelled: its forward
  // closes. One whose start answers only after that is cancelled then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, at unmount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelPending();
    };
  }, []);

  /** A status answer: done refreshes the list, a failure says why. */
  const finish = (next: DesktopSshServerLoginFlow): void => {
    flowRef.current = null;
    setFlow(null);
    setPasteError('');
    if (next.state === 'complete') refresh();
    else if (next.state !== 'cancelled') setError(next.error || t('The sign-in did not finish.'));
  };

  /** A status or paste answer: only the active login's, in a mounted dialog. */
  const settle = (next: DesktopSshServerLoginFlow): void => {
    if (!mounted.current || flowRef.current?.flowId !== next.flowId) return;
    if (next.state === 'pending') {
      const pending = { ...flowRef.current, forwarded: next.forwarded };
      flowRef.current = pending;
      setFlow(pending);
      return;
    }
    finish(next);
  };

  const pendingId = flow?.state === 'pending' ? flow.flowId : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the pending login only.
  useEffect(() => {
    if (!pendingId) return undefined;
    let live = true;
    let pushed = 0;
    const stopPush = subscribeSshServerLoginUpdated((update) => {
      if (live && update.id === hostId && update.flow.flowId === pendingId) {
        pushed += 1;
        settle(update.flow);
      }
    });
    const recovery = startSettingsReadRecovery(
      async (signal) => {
        const seen = pushed;
        try {
          const next = await sshServerLoginStatus(hostId, pendingId);
          // A pending push can supersede another pending view, but not a
          // terminal result for the same operation.
          if (live && !signal.aborted && next?.flowId === pendingId && (next.state !== 'pending' || seen === pushed))
            settle(next);
        } catch (reason) {
          if (!live || signal.aborted || flowRef.current?.flowId !== pendingId) return;
          if (isConnectFirstError(reason)) {
            cancelPending();
            setFlow(null);
            setPasteError('');
            report(reason);
          } else if (isUnknownSshLoginFlow(reason)) {
            // The server no longer owns this flow. There is nothing to cancel.
            flowRef.current = null;
            setFlow(null);
            setPasteError('');
            report(reason);
          }
        }
      },
      3_000,
      true,
      true
    );
    const stopLink = followSettingsReadConnection(window.mixdogDesktop, recovery);
    window.addEventListener('focus', recovery.replace);
    return () => {
      live = false;
      stopPush?.();
      stopLink?.();
      recovery.stop();
      window.removeEventListener('focus', recovery.replace);
    };
  }, [hostId, pendingId]);

  const begin = (provider: DesktopSshServerLogin): Promise<void> => {
    cancelPending();
    setFlow(null);
    setPasteError('');
    return Promise.resolve(sshServerLoginBegin(hostId, provider.id)).then((started) => {
      if (!started) return;
      if (!mounted.current) {
        if (started.state === 'pending') cancelFlow(started.flowId);
        return;
      }
      setFlowName(provider.name);
      if (started.state === 'pending') {
        flowRef.current = started;
        setFlow(started);
      } else finish(started);
    });
  };

  const paste = (address: string, form: HTMLFormElement): void => {
    const pending = flowRef.current;
    if (!pending) return;
    setPasteError('');
    void Promise.resolve(sshServerLoginComplete(hostId, pending.flowId, address))
      .then((next) => {
        if (next?.flowId !== pending.flowId || !mounted.current || flowRef.current?.flowId !== pending.flowId) return;
        form.reset();
        settle(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current && flowRef.current?.flowId === pending.flowId)
          setPasteError(sshErrorText(reason, hostName));
      });
  };

  return { flow, flowName, pasteError, begin, paste };
}
