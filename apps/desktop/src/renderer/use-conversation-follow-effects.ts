import { useLayoutEffect, useRef } from 'react';
import type { TranscriptItem } from './desktop-types';

/** Follow re-arming around session entry, transcript shrink and no-overflow
 *  commits. Returns whether the virtual timeline should anchor to the bottom. */
export function useConversationFollowEffects({
  armFollow,
  following,
  scrollToEndRef,
  settledItems,
  transcriptRows,
  transcriptSessionKey,
  viewport,
}: {
  armFollow: () => void;
  following: boolean;
  scrollToEndRef: { current: (behavior?: ScrollBehavior) => void };
  settledItems: readonly TranscriptItem[];
  transcriptRows: unknown;
  transcriptSessionKey: string;
  viewport: { current: HTMLDivElement | null };
}) {
  // A session route change resumes at the latest row. Measurement
  // snapshots survive re-entry, but a stale per-session scroll offset does not.
  const armedFollowSessionKey = useRef('');
  useLayoutEffect(() => {
    if (armedFollowSessionKey.current === transcriptSessionKey) return;
    armedFollowSessionKey.current = transcriptSessionKey;
    // Entry re-arms following ONLY. The virtual timeline owns the end
    // position; writing scrollTop here too made two authorities aim at
    // different offsets across the first frames (re-entry jump/flicker).
    armFollow();
  }, [armFollow, transcriptSessionKey]);
  // Shrinking the settled transcript — especially during compaction — removes
  // rows the reader may be anchored to, so return to the live tail. The follow
  // hook watches viewport size, not content shrinkage. Same-length lane
  // publications and growing history leave the reading position alone.
  const transcriptSwapRef = useRef({ sessionKey: '', count: 0 });
  useLayoutEffect(() => {
    const count = settledItems.length;
    const previous = transcriptSwapRef.current;
    transcriptSwapRef.current = { sessionKey: transcriptSessionKey, count };
    // Session entry owns its own arm. A same-length head-id change is a lane
    // republish, not compaction — that used to fire a second scrollToEnd.
    if (previous.sessionKey !== transcriptSessionKey) return;
    if (!previous.count || !count || count >= previous.count) return;
    armFollow();
    scrollToEndRef.current();
  }, [armFollow, scrollToEndRef, settledItems, transcriptSessionKey]);
  // Content growth is watched on the rows commit (without a second
  // observer): a transcript that no longer OVERFLOWS holds no reading
  // position, so a shrink that fits inside the viewport re-arms follow instead
  // of leaving auto-scroll released with nothing left to scroll. Driven by the
  // rows commit, so virtual-core stays the only content-growth authority.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a rows commit is the trigger; the body only measures the viewport.
  useLayoutEffect(() => {
    if (following) return;
    const element = viewport.current;
    if (!element) return;
    if (element.scrollHeight - element.clientHeight > 1) return;
    armFollow();
  }, [armFollow, following, transcriptRows, viewport]);
  return following || armedFollowSessionKey.current !== transcriptSessionKey;
}
