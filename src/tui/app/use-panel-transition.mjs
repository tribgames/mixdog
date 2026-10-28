// Panel-transition bookkeeping: after every layout commit, records the
// signature/reserve the NEXT render diffs against, then schedules the follow-up
// epoch bump that releases the transition clearance (or the ink close mask).
import { useEffect } from 'react';

export function usePanelTransition({
  panelTransitionRef,
  panelCloseInkMaskRowsRef,
  panelLayoutSignature,
  bottomClusterRows,
  panelTransitionClearRows,
  panelTransitionGuardRows,
  latestTranscriptItem,
  setPanelInkMaskEpoch,
  setPanelTransitionEpoch,
}) {
  useEffect(() => {
    const transition = panelTransitionRef.current;
    const pendingInkMask = panelCloseInkMaskRowsRef.current;
    const hadTransitionClearance = panelTransitionClearRows > 0 || panelTransitionGuardRows > 0;
    transition.signature = panelLayoutSignature;
    transition.reserve = bottomClusterRows;
    transition.clearRows = 0;
    transition.guardRows = 0;
    if (pendingInkMask > 0) {
      panelCloseInkMaskRowsRef.current = 0;
      setPanelInkMaskEpoch((epoch) => epoch + 1);
      return undefined;
    }
    if (!hadTransitionClearance) return undefined;
    const timer = setTimeout(() => setPanelTransitionEpoch((epoch) => epoch + 1), 0);
    return () => clearTimeout(timer);
  }, [
    panelTransitionRef,
    panelCloseInkMaskRowsRef,
    panelLayoutSignature,
    bottomClusterRows,
    panelTransitionClearRows,
    panelTransitionGuardRows,
    setPanelInkMaskEpoch,
    setPanelTransitionEpoch,
  ]);
  // Record the transcript tail id AFTER every commit so the next render's
  // spinner-meta-collapse gate (doneTailAppendedThisCommit) can tell a freshly
  // appended done row from a stale one that was already at the tail.
  useEffect(() => {
    panelTransitionRef.current.tailId = latestTranscriptItem?.id ?? null;
  });
}
