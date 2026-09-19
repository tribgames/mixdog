// The dock's single Git action lane: one action at a time, guards that are
// re-read at execution time, and the reload that follows a landed action.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopGitStatus } from '../shared/contract';
import { leavesStateBehind } from './source-control-support';

export type GitActionRunner = (
  key: string,
  action: () => Promise<unknown> | undefined,
  after?: () => void
) => Promise<void>;

export function useSourceControlRunner({
  status,
  reload,
  setError,
}: {
  status: DesktopGitStatus | null;
  reload: (key: string) => Promise<void>;
  setError: (message: string) => void;
}) {
  const [busy, setBusy] = useState('');
  /** The guards are also read at EXECUTION time. An open context menu holds
   *  the `busy` / `status.operation` SNAPSHOT of the render that built it, so
   *  an action started while it is open would otherwise slip past the
   *  disabled-at-render check inside those item closures. */
  const busyRef = useRef('');
  const statusRef = useRef<DesktopGitStatus | null>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const guardReason = useCallback((): string => {
    if (busyRef.current) return 'Another Git action is running';
    const operation = statusRef.current?.operation;
    return operation ? `Finish the in-progress ${operation.replace('-', ' ')} first` : '';
  }, []);
  /** Runs a menu action only if the guards STILL allow it; a stale entry
   *  reports the reason instead of acting on a repository that moved. */
  const guarded = useCallback(
    (action: () => void) => {
      const reason = guardReason();
      if (reason) {
        setError(reason);
        return;
      }
      action();
    },
    [guardReason, setError]
  );
  const run = useCallback<GitActionRunner>(
    async (key, action, after) => {
      // Read from the REF, not from this closure's `busy`: a context-menu item
      // built before the running action started still carries the old snapshot.
      if (busyRef.current) return;
      busyRef.current = key;
      setBusy(key);
      setError('');
      try {
        await action();
        after?.();
        await reload(key);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        // A rejected action can have changed the repository FIRST (a conflicted
        // revert/cherry-pick, an interrupted merge), so the surface is re-read
        // instead of waiting for the poll.
        if (leavesStateBehind(key)) {
          try {
            await reload(key);
          } catch {
            /* the refusal above is the message that matters */
          }
          // loadHistory clears the banner on a successful page, so the refusal
          // is restored after the refresh it triggered.
          setError(message);
        }
      } finally {
        busyRef.current = '';
        setBusy('');
      }
    },
    [reload, setError]
  );
  return { busy, setBusy, busyRef, guardReason, guarded, run };
}
