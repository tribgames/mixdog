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
