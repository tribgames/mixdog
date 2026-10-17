// The one test for "this frame only grew the live answer's text". The desktop's
// remote mailbox delays such frames toward the phone, and the phone defers them
// to its next animation frame; every other transition travels at once.
import type { DesktopSessionStateUpdate } from './contract';
import { streamingTailWithPartial } from './streaming-partial';

function sameFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  omitted: readonly string[]
): boolean {
  const left = Object.keys(before).filter((key) => !omitted.includes(key));
  const right = Object.keys(after).filter((key) => !omitted.includes(key));
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(after, key) &&
        (Object.is(before[key], after[key]) || JSON.stringify(before[key]) === JSON.stringify(after[key]))
    )
  );
}

/** A proved text append. Every other state transition — including unknown
 *  future approval fields — fails without an allowlist. The appended text is
 *  the live row as painted: the line-gated tail joined with its unfinished
 *  line, so partial-line growth counts like any append. */
export function isStreamingTextAppend(
  before: DesktopSessionStateUpdate | null,
  after: DesktopSessionStateUpdate
): boolean {
  const old = before?.snapshot;
  const next = after.snapshot;
  if (
    before?.frameSource !== 'live' ||
    after.frameSource !== 'live' ||
    before.sessionId !== after.sessionId ||
    after.laneEnd ||
    !old ||
    !next ||
    old.busy !== true ||
    next.busy !== true ||
    old.items !== next.items
  )
    return false;
  const left = streamingTailWithPartial(old);
  const right = streamingTailWithPartial(next);
  if (
    !left ||
    !right ||
    left.id == null ||
    left.id !== right.id ||
    right.kind !== 'assistant' ||
    typeof left.text !== 'string' ||
    typeof right.text !== 'string' ||
    right.text.length <= left.text.length ||
    !right.text.startsWith(left.text)
  )
    return false;
  return sameFields(left, right, ['text']) && sameFields(old, next, ['streamingTail', 'streamingPartial']);
}
