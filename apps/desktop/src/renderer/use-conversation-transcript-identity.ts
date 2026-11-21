import { useRef } from 'react';
import {
  nextDraftTranscriptNamespace,
  readTranscriptVirtualSnapshot,
  rememberTranscriptRowNamespace,
  transcriptRowNamespace,
} from './transcript-virtual-cache';
import { resetToolDisclosureScope } from './transcript-tool-ui';

/** Render-time identity of the transcript timeline for one pane: the row
 *  namespace (stable across the pane's own draft -> session promotion), the
 *  cold-entry mount gate, and the per-visit tool-disclosure reset. */
export function useConversationTranscriptIdentity({
  transcriptSessionKey,
  transcriptPending,
  timelineMounted,
  suppressDraftSubmitPaintHandoff,
}: {
  transcriptSessionKey: string;
  transcriptPending: boolean;
  timelineMounted: { current: boolean };
  suppressDraftSubmitPaintHandoff: { current: boolean };
}) {
  const transcriptIdentity = useRef('');
  const transcriptIdentitySource = useRef('');
  // Set on the promotion render, where the submit marker is still armed, and
  // consumed by the effect below; never cleared in render, so a repeated
  // render of the same commit cannot lose it.
  const promotedOwnDraft = useRef(false);
  if (transcriptIdentitySource.current !== transcriptSessionKey) {
    const ownPromotion =
      transcriptIdentitySource.current === 'new-task' &&
      transcriptSessionKey !== 'new-task' &&
      suppressDraftSubmitPaintHandoff.current;
    transcriptIdentitySource.current = transcriptSessionKey;
    if (ownPromotion) {
      promotedOwnDraft.current = true;
      // Re-entry must still match the geometry cached under the REAL session
      // key, so the draft's namespace outlives this mount.
      rememberTranscriptRowNamespace(transcriptSessionKey, transcriptIdentity.current);
    } else {
      transcriptIdentity.current =
        transcriptSessionKey === 'new-task'
          ? nextDraftTranscriptNamespace()
          : transcriptRowNamespace(transcriptSessionKey);
      timelineMounted.current = Boolean(readTranscriptVirtualSnapshot(transcriptSessionKey)?.measurements?.length);
    }
  }
  const showTranscriptTimeline = !transcriptPending || timelineMounted.current;
  if (showTranscriptTimeline) timelineMounted.current = true;
  const disclosureVisitKey = useRef('');
  if (disclosureVisitKey.current !== transcriptSessionKey) {
    disclosureVisitKey.current = transcriptSessionKey;
    resetToolDisclosureScope(transcriptSessionKey);
  }
  return { transcriptIdentity, promotedOwnDraft, showTranscriptTimeline };
}
