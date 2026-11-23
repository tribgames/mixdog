import { useLayoutEffect, useRef } from 'react';
import { isRoomTypingItem } from './agent-chat-place';
import type { TranscriptItem } from './desktop-types';
import { carriedSum } from './list-carry';

/** The settled rows that count toward a shrink: a group room's typing row is a
 *  transient overlay that comes and goes at every turn boundary, so it is
 *  neither history nor a removal. */
export function settledRowCount(items: readonly TranscriptItem[]): number {
  return settledRows(items).count;
}

/** Counted per list, and carried on from the list a frame made it from. */
const settledRows = carriedSum((item: TranscriptItem) => (isRoomTypingItem(item) ? undefined : 0));

const noReader = () => false;

/** Follow re-arming around session entry, transcript shrink and no-overflow
 *  commits. Returns whether the virtual timeline should anchor to the bottom. */
export function useConversationFollowEffects({
  armFollow,
  releaseFollow = armFollow,
  entryReader = noReader,
  following,
  scrollToEndRef,
  settledItems,
  transcriptRows,
  transcriptSessionKey,
  viewport,
  windowGeneration,
}: {
  armFollow: () => void;
  /** Lets go of the end without a reader's gesture; called only for an entry `entryReader` accepts. */
  releaseFollow?: () => void;
  /** The session is entered at a place its reader has off the end (transcript-list-reader-place.ts): the list puts the
   *  reader's row back and the entry does not follow. Absent: every entry follows. */
  entryReader?: () => boolean;
  following: boolean;
  scrollToEndRef: { current: (behavior?: ScrollBehavior) => void };
  /** A positioned transcript's generation (`transcriptGeneration`); undefined for a window whose rows are the transcript's. */
  windowGeneration?: number;
  settledItems: readonly TranscriptItem[];
  transcriptRows: unknown;
  transcriptSessionKey: string;
  viewport: { current: HTMLDivElement | null };
}) {
  // A session route change resumes at the latest row, or at the place its reader has off the end. Measurement
  // snapshots survive re-entry; a scroll offset does not, a record and its row's place in the viewport do.
  const armedFollowSessionKey = useRef('');
  const entry = useRef({ entryReader, releaseFollow });
  entry.current = { entryReader, releaseFollow };
  const entering = armedFollowSessionKey.current !== transcriptSessionKey;
  const enteredOnReader = entering && entryReader();
  useLayoutEffect(() => {
    if (armedFollowSessionKey.current === transcriptSessionKey) return;
    armedFollowSessionKey.current = transcriptSessionKey;
    // Entry re-arms following ONLY. The virtual timeline owns the end
    // position; writing scrollTop here too made two authorities aim at
    // different offsets across the first frames (re-entry jump/flicker).
    if (entry.current.entryReader()) entry.current.releaseFollow();
    else armFollow();
  }, [armFollow, transcriptSessionKey]);
  const transcriptSwapRef = useRef({ sessionKey: '', count: 0, generation: windowGeneration });
  useLayoutEffect(() => {
    const count = settledRowCount(settledItems);
    const previous = transcriptSwapRef.current;
    transcriptSwapRef.current = { sessionKey: transcriptSessionKey, count, generation: windowGeneration };
    // Session entry owns its own arm. A same-length head-id change is a lane
    // republish, not compaction — that used to fire a second scrollToEnd.
    if (previous.sessionKey !== transcriptSessionKey) return;
    // A positioned window lets go of rows far from the reader, so fewer rows are no shrink of the transcript: a history
    // reset (a rewind, a clear) is one, and names itself.
    const shrank =
      windowGeneration === undefined
        ? Boolean(previous.count && count && count < previous.count)
        : previous.generation !== undefined && previous.generation !== windowGeneration;
    if (!shrank) return;
    armFollow();
    scrollToEndRef.current();
  }, [armFollow, scrollToEndRef, settledItems, transcriptSessionKey, windowGeneration]);
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
      // A reader waiting for the rows of its place has no list yet: nothing overflows, and it is not at the end.
      if (entry.current.entryReader()) return;
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
  return entering ? !enteredOnReader : following;
}
