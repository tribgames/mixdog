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
  // A pane's OWN draft -> session promotion must NOT rebuild the timeline. The
  // virtual list AND its row keys are namespaced by this identity, which
  // survives the promotion; only the geometry cache follows the real session
  // key. Keying them by the session key remounted the list mid-turn, dropped
  // every measured row, and repainted the first prompt from the flat estimate
  // (user: 첫 프롬 입력 후 화면이 툭 튀고 말풍선이 엉뚱한 위치로 튄다).
  const transcriptIdentity = useRef('');
  const transcriptIdentitySource = useRef('');
  // Set on the promotion render, where the submit marker is still armed, and
  // consumed by the effect below; never cleared in render, so a repeated
  // render of the same commit cannot lose it.
  const promotedOwnDraft = useRef(false);
  // The pending gate below belongs to a COLD session entry. Once this identity
  // has painted its timeline, it must never be unmounted again — a promotion
  // whose Markdown-readiness flag lags one tick would otherwise discard every
  // measured row exactly like a remount.
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
  // Session ENTRY resets this visit's tool disclosures before the first row
  // renders (user: tool cards must always start collapsed; remembered
  // expansions from an earlier visit reopened them "randomly"). Idempotent
  // render-time module-map mutation; focus swaps keep the same key and do
  // not reset.
  const disclosureVisitKey = useRef('');
  if (disclosureVisitKey.current !== transcriptSessionKey) {
    disclosureVisitKey.current = transcriptSessionKey;
    resetToolDisclosureScope(transcriptSessionKey);
  }
  return { transcriptIdentity, promotedOwnDraft, showTranscriptTimeline };
}
