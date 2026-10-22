import { useEffect, useState } from 'react';
import { confirmText } from './confirm-text';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { publishReviewInvalidation, subscribeReviewInvalidation } from './review-invalidation';
import type { useSessionDiffRefresh } from './use-session-diff-refresh';

/** The session diff spans turns and has no revert contract: only the latest
 *  turn's files can be restored, and only against that turn's checkpoint,
 *  exactly like TurnReview. While a turn runs nothing is revertable. */
export function useSessionDiffRevert({
  sessionId,
  active,
  busy,
  reviewKey,
  refresh,
  setRevertError,
}: {
  sessionId: string;
  active: boolean;
  busy: boolean;
  /** Moves only when the latest turn's review can (useSessionChanges turnReviewKey). */
  reviewKey: string;
  refresh: ReturnType<typeof useSessionDiffRefresh>['refresh'];
  setRevertError(message: string): void;
}) {
  const [turnReview, setTurnReview] = useState<{ checkpointId: string; paths: ReadonlySet<string> } | null>(null);
  // Bumped by a revert of this session made anywhere (this pane, the turn
  // review, the turn changes card): it changes the review's files without a
  // new checkpoint or history epoch.
  const [reverts, setReverts] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    return subscribeReviewInvalidation(sessionId, () => setReverts((count) => count + 1));
  }, [sessionId]);
  // A turn's review is fixed once it ends: it is re-read when a turn ends
  // (busy), a new turn's checkpoint lands, its history moves, or a revert
  // lands — never on every lane publication, which re-ran the whole review
  // read every few seconds for an idle Lead whose workers reported progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reviewKey and reverts re-read the turn review when they move
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
  }, [active, sessionId, busy, reviewKey, reverts]);
  const canRevertPath = (path: string) => Boolean(!busy && turnReview?.paths.has(path));
  const revertFile = (path: string) => {
    if (!turnReview || !canRevertPath(path)) return;
    const { checkpointId } = turnReview;
    void confirmAction(
      t('Revert {{file}} to the start of the turn? This discards its changes.', { file: confirmText(path) }),
      { danger: true, confirmLabel: t('Revert') }
    ).then((approved) => {
      if (!approved) return;
      setRevertError('');
      return window.mixdogDesktop
        .invokeCapability?.({
          capability: 'revertTurnReviewFile',
          args: [path, checkpointId],
          sessionId,
        })
        .then(() => {
          publishReviewInvalidation(sessionId);
          // Every Git surface (Source Control, the Changes chip) re-reads.
          window.dispatchEvent(new Event('mixdog:git-changed'));
          return refresh(true);
        })
        .catch((reason: unknown) => setRevertError(reason instanceof Error ? reason.message : String(reason)));
    });
  };
  return { canRevertPath, revertFile };
}
