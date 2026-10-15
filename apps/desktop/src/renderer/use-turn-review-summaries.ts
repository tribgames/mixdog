import { useMemo } from 'react';
import type { TranscriptItem } from './desktop-types';
import { findPatch } from './transcript-diff';
import type { TurnReviewFile } from './turn-review-cache';
import {
  summarizeTurnReviewPatch,
  summarizeAuthoritativeTurnReview,
  mergeTurnReviewSummaries,
  toolPublishesPatch,
  summarizeTurnReviewOperations,
} from './turn-review-model';
import { t } from './i18n';
import { sessionChangesSourceLabel, useSessionChanges } from './session-changes-store';
import type { useTurnReviewReads } from './use-turn-review-reads';

type Reads = ReturnType<typeof useTurnReviewReads>;

/** The lead's own turn diff: the authoritative snapshot, the post-revert
 *  tracker diff, or the transcript's latest uiDiff / published patches. */
function summarizeTurnTranscript({
  items,
  startIndex,
  authoritativeLeadFiles,
  authoritativeLeadPatch,
  authoritativeSnapshotKind,
  authoritativeWorktreeSnapshot,
  revertedBoundary,
  turnBoundaryKey,
}: {
  items: TranscriptItem[];
  startIndex: number;
  authoritativeLeadFiles: TurnReviewFile[];
  authoritativeLeadPatch: string | null;
  authoritativeSnapshotKind: string;
  authoritativeWorktreeSnapshot: boolean;
  revertedBoundary: string;
  turnBoundaryKey: string;
}) {
  const patches: string[] = [];
  let latestUiDiff: string | null = null;
  for (let index = startIndex + 1; index < items.length; index++) {
    const item = items[index];
    if (item?.kind !== 'tool') continue;
    if (Object.hasOwn(item, 'uiDiff')) {
      latestUiDiff = typeof item.uiDiff === 'string' ? item.uiDiff : '';
      continue;
    }
    const count = Math.max(1, Number(item.count || 1));
    const failed = item.isError === true || Number(item.errorCount || 0) >= count;
    if (failed) continue;
    // Shell/test output can legitimately contain `@@` or a printed unified
    // diff. It is evidence to show inside that tool row, not evidence that
    // the tool changed files. Shell mutations arrive through the
    // authoritative worktree snapshot instead.
    if (!toolPublishesPatch(item)) continue;
    const patch = findPatch(item);
    if (typeof patch !== 'string' || !patch) continue;
    patches.push(patch);
  }
  // The completed tool item is published in the same frame as the mutation
  // and therefore beats the polled capability snapshot during rapid,
  // same-card edits. An explicit empty uiDiff is authoritative too: it means
  // the latest apply_patch restored the turn baseline.
  if (authoritativeWorktreeSnapshot) {
    return summarizeAuthoritativeTurnReview(authoritativeLeadFiles, authoritativeLeadPatch || '');
  }
  // After a revert the transcript's uiDiff is exactly the change that was
  // undone, so the runtime's exact-tracker diff wins until the next tool
  // completes and moves the boundary.
  const afterRevert =
    revertedBoundary !== '' && revertedBoundary === turnBoundaryKey && authoritativeLeadPatch !== null;
  // A collapsed phone bar got the tracker's counts as files, without the
  // patch text; they stand in wherever that patch would have been read.
  const trackerCountsOnly =
    authoritativeSnapshotKind === 'tool' && !authoritativeLeadPatch && authoritativeLeadFiles.length > 0;
  if (trackerCountsOnly && (afterRevert || latestUiDiff === null)) {
    return summarizeAuthoritativeTurnReview(authoritativeLeadFiles, '');
  }
  return summarizeTurnReviewPatch(
    afterRevert ? authoritativeLeadPatch : (latestUiDiff ?? authoritativeLeadPatch ?? patches.join('\n'))
  );
}

/** The turn's summaries: lead/transcript, per-agent sources, their merge, and
 *  the collapsed headline's workload stats. */
export function useTurnReviewSummaries({
  items,
  reviewScope,
  reviewState,
  revertedBoundary,
  turnBoundaryKey,
}: {
  items: TranscriptItem[];
  reviewScope: Reads['reviewScope'];
  reviewState: Reads['reviewState'];
  revertedBoundary: string;
  turnBoundaryKey: string;
}) {
  const agentReviews = reviewState.reviews;
  const authoritativeLeadPatch = reviewState.leadPatch;
  const authoritativeLeadFiles = reviewState.files;
  const authoritativeSnapshotKind = reviewState.snapshotKind;
  // A recorded ("scoped") review is the same Git diff as a live worktree
  // baseline, only limited to the session's own paths, so its file list is
  // trusted the same way. Otherwise a revert served from the record left the
  // transcript's stale diff on screen and looked like nothing had happened.
  const authoritativeWorktreeSnapshot =
    authoritativeSnapshotKind === 'worktree' || authoritativeSnapshotKind === 'scoped';
  const transcriptSummary = useMemo(
    () =>
      summarizeTurnTranscript({
        items,
        startIndex: reviewScope.startIndex,
        authoritativeLeadFiles,
        authoritativeLeadPatch,
        authoritativeSnapshotKind,
        authoritativeWorktreeSnapshot,
        revertedBoundary,
        turnBoundaryKey,
      }),
    [
      authoritativeLeadFiles,
      authoritativeLeadPatch,
      authoritativeSnapshotKind,
      authoritativeWorktreeSnapshot,
      items,
      reviewScope.startIndex,
      revertedBoundary,
      turnBoundaryKey,
    ]
  );
  const agentSources = useMemo(
    () =>
      agentReviews.flatMap((review, index) => {
        const reviewSummary = summarizeTurnReviewPatch(review.patch);
        if (reviewSummary.files.size === 0) return [];
        const label =
          review.tag && review.agent && review.tag !== review.agent
            ? `${review.tag} · ${review.agent}`
            : review.tag || review.agent || '';
        return [
          {
            key: `${review.sessionId}:${index}`,
            label,
            summary: reviewSummary,
          },
        ];
      }),
    [agentReviews]
  );
  const agentSummary = useMemo(
    () => mergeTurnReviewSummaries(agentSources.map((source) => source.summary)),
    [agentSources]
  );
  const summary = useMemo(
    () =>
      authoritativeWorktreeSnapshot ? transcriptSummary : mergeTurnReviewSummaries([transcriptSummary, agentSummary]),
    [transcriptSummary, agentSummary, authoritativeWorktreeSnapshot]
  );
  const operationSummary = useMemo(
    () => summarizeTurnReviewOperations(items, reviewScope.startIndex),
    [items, reviewScope.startIndex]
  );
  // The file set and expanded rows remain the authoritative turn-start → current
  // diff. The collapsed headline mirrors the activity cards' edit workload so
  // replaced/deleted intermediate lines do not disappear into a net +N count.
  // A truncated transcript holds only part of the turn's edits, so its
  // workload count is partial; the review's own totals stand in.
  const turnHeadlineStats = operationSummary.hasLineStats && !reviewScope.truncated ? operationSummary : summary;
  return {
    authoritativeWorktreeSnapshot,
    transcriptSummary,
    agentSources,
    agentSummary,
    summary,
    turnHeadlineStats,
  };
}

/** What the bar shows: the island segment's Changes (the selected Git source,
 *  or a non-Git root's session diff — the same store the pane lists), else the
 *  turn's own, with its source groups and headline stats. */
export function useShownTurnReview({
  sessionScoped,
  sessionId,
  active,
  cwd,
  turn,
}: {
  sessionScoped: boolean;
  sessionId: string | undefined;
  active: boolean;
  cwd: string | undefined;
  turn: ReturnType<typeof useTurnReviewSummaries>;
}) {
  const { summary, transcriptSummary, agentSources, authoritativeWorktreeSnapshot, turnHeadlineStats } = turn;
  const changes = useSessionChanges({
    cwd: sessionScoped ? cwd : '',
    sessionId: sessionScoped ? sessionId : '',
    active: sessionScoped && active,
  });
  const sessionSummary = changes.summary;
  // Already translated: the source header shows it verbatim.
  const sessionLabel = changes.repository ? sessionChangesSourceLabel(changes.source) : t('Session');
  const shownSummary = sessionScoped ? sessionSummary : summary;
  const headlineStats = sessionScoped ? sessionSummary : turnHeadlineStats;
  const sources = useMemo(() => {
    if (sessionScoped) {
      return sessionSummary.files.size > 0 ? [{ key: 'session', label: sessionLabel, summary: sessionSummary }] : [];
    }
    const transcriptSource = {
      key: authoritativeWorktreeSnapshot ? 'turn' : 'lead',
      label: authoritativeWorktreeSnapshot ? 'Turn' : 'Lead',
      summary: transcriptSummary,
    };
    return [...(transcriptSummary.files.size > 0 ? [transcriptSource] : []), ...agentSources];
  }, [sessionScoped, sessionSummary, sessionLabel, transcriptSummary, agentSources, authoritativeWorktreeSnapshot]);
  // The segment's name follows the source; a non-Git root lists the session's files.
  const segmentLabel = changes.repository ? sessionLabel : t('Files changed this session');
  return { shownSummary, headlineStats, sources, segmentLabel };
}
