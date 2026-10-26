import { useLayoutEffect, useRef } from 'react';
import { isRoomTypingItem } from './agent-chat-place';
import type { TranscriptItem } from './desktop-types';

/** The settled rows that count toward a shrink: a group room's typing row is a
 *  transient overlay that comes and goes at every turn boundary, so it is
 *  neither history nor a removal. */
export function settledRowCount(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) if (!isRoomTypingItem(item)) count += 1;
  return count;
}

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
    const count = settledRowCount(settledItems);
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
  // The viewport is read on the next frame, not in the commit: the rows the
  // commit mounted and the list's own writes (its spacer, a landing's offset)
  // left layout dirty, so a read here forced a second full layout of the
  // mounted rows inside every rows commit of a reader scrolled up (23-33 ms
  // per commit on a phone catching up after resume). At the next frame the
  // browser has laid them out for paint, and the check reads that layout.
  // A transcript that fits is re-armed a frame later; nothing scrolls there.
  const overflowCheck = useRef(0);
  const latest = useRef({ armFollow, following });
  latest.current = { armFollow, following };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a rows commit is the trigger; the body only measures the viewport.
  useLayoutEffect(() => {
    if (following || overflowCheck.current) return;
    overflowCheck.current = window.requestAnimationFrame(() => {
      overflowCheck.current = 0;
      const element = viewport.current;
      if (latest.current.following || !element) return;
      if (element.scrollHeight - element.clientHeight > 1) return;
      latest.current.armFollow();
    });
  }, [armFollow, following, transcriptRows, viewport]);
  useLayoutEffect(
    () => () => {
      if (overflowCheck.current) window.cancelAnimationFrame(overflowCheck.current);
      overflowCheck.current = 0;
    },
    []
  );
  return following || armedFollowSessionKey.current !== transcriptSessionKey;
}
