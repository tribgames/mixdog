import { useEffect, useState } from 'react';
import { t } from './i18n';
import type { useSessionDiffRefresh } from './use-session-diff-refresh';

/** The session diff spans turns and has no revert contract: only the latest
 *  turn's files can be restored, and only against that turn's checkpoint,
 *  exactly like TurnReview. While a turn runs nothing is revertable. */
export function useSessionDiffRevert({
  sessionId,
  active,
  busy,
  revision,
  refresh,
  setRevertError,
}: {
  sessionId: string;
  active: boolean;
  busy: boolean;
  revision: string;
  refresh: ReturnType<typeof useSessionDiffRefresh>['refresh'];
  setRevertError(message: string): void;
}) {
  const [turnReview, setTurnReview] = useState<{ checkpointId: string; paths: ReadonlySet<string> } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads the turn review after each activity change
  useEffect(() => {
    setTurnReview(null);
    if (!active || !sessionId || busy) return;
    let stale = false;
    void window.mixdogDesktop
      .invokeCapability?.({ capability: 'getTurnReviewDiff', args: [{ summary: true }], sessionId })
      .then((reply) => {
        const value = reply?.value as { checkpointId?: unknown; files?: unknown } | null | undefined;
        const files = Array.isArray(value?.files) ? (value.files as Array<{ path?: unknown }>) : [];
        const checkpointId = typeof value?.checkpointId === 'string' ? value.checkpointId : '';
        if (stale || !checkpointId) return;
        setTurnReview({ checkpointId, paths: new Set(files.map((file) => String(file?.path ?? ''))) });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [active, sessionId, busy, revision]);
  const canRevertPath = (path: string) => Boolean(!busy && turnReview?.paths.has(path));
  const revertFile = (path: string) => {
    if (!turnReview || !canRevertPath(path)) return;
    if (!window.confirm(t('Revert {{file}} to the start of the turn? This discards its changes.', { file: path })))
      return;
    setRevertError('');
    void window.mixdogDesktop
      .invokeCapability?.({
        capability: 'revertTurnReviewFile',
        args: [path, turnReview.checkpointId],
        sessionId,
      })
      .then(() => {
        // Every Git surface (Source Control, the Changes chip) re-reads.
        window.dispatchEvent(new Event('mixdog:git-changed'));
        return refresh(true);
      })
      .catch((reason: unknown) => setRevertError(reason instanceof Error ? reason.message : String(reason)));
  };
  return { canRevertPath, revertFile };
}
