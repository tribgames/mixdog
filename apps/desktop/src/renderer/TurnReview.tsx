import { memo, useEffect, useState } from 'react';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { readDiffStyle, TURN_REVIEW_DIFF_STYLE_KEY, type TranscriptItem, writeDiffStyle } from './desktop-types';
import { useTurnReviewDisclosure } from './use-turn-review-disclosure';
import { useTurnReviewReads } from './use-turn-review-reads';
import { useShownTurnReview, useTurnReviewSummaries } from './use-turn-review-summaries';
import { turnReviewFileItems, turnReviewHead, turnReviewSegment } from './turn-review-parts';

export const TurnReviewBar = memo(function TurnReviewBar({
  items,
  cwd,
  sessionId,
  active = true,
  busy = false,
  onOpenFile,
  variant = 'bar',
  onOpenChanges,
}: {
  items: TranscriptItem[];
  cwd?: string;
  sessionId?: string;
  active?: boolean;
  busy?: boolean;
  onOpenFile?: (project: string, rel: string) => void;
  /** `segment`: the composer island's "Files N +a −b" entry, which opens the
   *  pane's session diff (onOpenChanges). Without onOpenChanges (no side
   *  dock) it is an island tab that expands into this file list. */
  variant?: 'bar' | 'segment';
  onOpenChanges?: () => void;
}) {
  const islandTab = variant === 'segment' && !onOpenChanges;
  const disclosure = useTurnReviewDisclosure(islandTab);
  const {
    expanded,
    setExpanded,
    openFile,
    setOpenFile,
    confirmFile,
    setConfirmFile,
    reverted,
    setReverted,
    revertError,
    setRevertError,
    revertedBoundary,
    setRevertedBoundary,
    barElement,
  } = disclosure;
  const { reviewScope, reviewState, entryPending, turnBoundaryKey, refreshAgentReviews } = useTurnReviewReads({
    items,
    sessionId,
    active,
    busy,
    disclosure,
  });
  const authoritativeCheckpointId = reviewState.checkpointId;
  // The bar's own persisted Unified/Split choice, separate from the Source
  // Control and Session Diff tabs (user: 3개 분리 저장).
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(() => readDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY));
  useEffect(() => {
    writeDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY, diffStyle);
  }, [diffStyle]);
  const turn = useTurnReviewSummaries({ items, reviewScope, reviewState, revertedBoundary, turnBoundaryKey });
  const { authoritativeWorktreeSnapshot, transcriptSummary, agentSources, agentSummary } = turn;
  const sessionScoped = variant === 'segment';
  const { shownSummary, headlineStats, sources, islandSummary, historyTurns } = useShownTurnReview({
    sessionScoped,
    sessionId,
    active,
    busy,
    turnBoundaryKey,
    items,
    cwd,
    turn,
  });
  // The island shows (and counts) only its own set: a Git project's
  // uncommitted session files, else the session's.
  const reviewVisible = !entryPending && (sessionScoped ? islandSummary : shownSummary).files.size > 0;
  // An island tab whose files went away closes with them.
  const closeEmptyTab = islandTab && expanded && !reviewVisible;
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeEmptyTab is the trigger; setExpanded is rebuilt each render
  useEffect(() => {
    if (closeEmptyTab) setExpanded(false);
  }, [closeEmptyTab]);
  const requestedCheckpointId = reviewScope.key === 'none' ? authoritativeCheckpointId : reviewScope.key;
  const checkpointMatches = !authoritativeCheckpointId || authoritativeCheckpointId === requestedCheckpointId;
  // Revert availability is decided by the runtime at click time. A transient
  // or stale capability read must not permanently disable an otherwise valid
  // checkpoint, but a known ID mismatch is never allowed to hit another turn.
  const canRevertTurn = Boolean(cwd && sessionId && requestedCheckpointId && checkpointMatches);
  // The prior turn's review must leave at the next user boundary. Conversation
  // reserves geometry only after the CURRENT turn actually touches files, so
  // carrying an empty review row through every busy turn creates a fixed black
  // gap above the composer while new output streams above it.
  // An undecided entry holds the conversation's reveal (use-transcript-reveal).
  if (!reviewVisible) return entryPending ? <span hidden data-entry-pending /> : null;
  if (variant === 'segment' && !expanded) {
    return turnReviewSegment({
      fileCount: islandSummary.files.size,
      headlineStats: islandSummary,
      onOpenChanges,
      setExpanded,
      sessionId,
      historyTurns,
      busy,
    });
  }
  return (
    <section
      ref={barElement}
      className="turn-review-bar"
      aria-label={sessionScoped ? t('Files changed this session') : t('Files changed this turn')}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {turnReviewHead({
        expanded,
        setExpanded,
        setOpenFile,
        setConfirmFile,
        setRevertError,
        summary: shownSummary,
        headlineStats,
        transcriptSummary,
        agentSummary,
        agentSources: sessionScoped ? [] : agentSources,
        authoritativeWorktreeSnapshot,
        diffStyle,
        setDiffStyle,
      })}
      {/* A refusal stays OUTSIDE the disclosure so its reason is readable
          without expanding the bar. */}
      {revertError && <ErrorNotice error={revertError} />}
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
            {turnReviewFileItems({
              sources,
              cwd,
              reverted,
              confirmFile,
              canRevertTurn,
              busy,
              openFile,
              setOpenFile,
              onOpenFile,
              diffStyle,
              sessionId,
              requestedCheckpointId,
              turnBoundaryKey,
              setConfirmFile,
              setRevertError,
              setReverted,
              setRevertedBoundary,
              refreshAgentReviews,
            })}
          </ul>
        </div>
      </div>
    </section>
  );
});
