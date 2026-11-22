// Opening a session at a record of its history (a search hit): the window the core holds is moved there, and the pane
// scrolls to the record's row once it is shown.
import { type MutableRefObject, useEffect, useSyncExternalStore } from 'react';
import { historyPositionOf } from '../../../../packages/protocol-client/src/rows.ts';
import type { TranscriptRowModel } from './transcript-rows';

/** How long a jump waits for its session's transcript and row before it is dropped. */
const JUMP_WAIT_MS = 15_000;

interface Jump {
  readonly position: string;
  readonly at: number;
  asked: boolean;
}

const jumps = new Map<string, Jump>();
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of [...listeners]) listener();
};

/** The session's pane opens at `position` (the next pane of the session to show rows takes it). */
export function requestTranscriptJump(sessionId: string, position: string): void {
  if (!sessionId || !position) return;
  jumps.set(sessionId, { position, at: Date.now(), asked: false });
  changed();
}

function endJump(sessionId: string, jump: Jump): void {
  if (jumps.get(sessionId) !== jump) return;
  jumps.delete(sessionId);
  changed();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether `row` shows the record at `position`. */
export function rowShowsPosition(row: TranscriptRowModel, position: string): boolean {
  const items = 'items' in row ? row.items : 'item' in row && row.item ? [row.item] : [];
  return items.some((item) => historyPositionOf(item) === position || historyPositionOf(item, 'after') === position);
}

/** A pane's part in a jump of its session: it asks for the window at the jump's record, leaves the live tail, and scrolls the
 *  record's row into view (`reveal`) once its rows show it. */
export function useTranscriptJump({
  sessionId,
  rows,
  leaveTail,
  reveal,
}: {
  sessionId: string;
  rows: readonly TranscriptRowModel[];
  leaveTail: () => void;
  reveal: MutableRefObject<((match: (row: TranscriptRowModel) => boolean) => boolean) | null>;
}): void {
  const jump = useSyncExternalStore(subscribe, () => (sessionId ? jumps.get(sessionId) : undefined));
  useEffect(() => {
    if (!jump) return undefined;
    if (Date.now() - jump.at > JUMP_WAIT_MS) {
      endJump(sessionId, jump);
      return undefined;
    }
    const match = (row: TranscriptRowModel) => rowShowsPosition(row, jump.position);
    if (rows.some(match)) {
      leaveTail();
      if (reveal.current?.(match)) endJump(sessionId, jump);
      return undefined;
    }
    if (!jump.asked) {
      const move = window.mixdogDesktop?.moveTranscriptWindow;
      if (!move) {
        endJump(sessionId, jump);
        return undefined;
      }
      jump.asked = true;
      leaveTail();
      void Promise.resolve(move(sessionId, { kind: 'at', position: jump.position })).then(
        (served) => {
          // Not served: the session's window is not held yet (its snapshot is on its way); asked again with the rows.
          if (!served) jump.asked = false;
        },
        () => endJump(sessionId, jump)
      );
    }
    const timer = window.setTimeout(() => endJump(sessionId, jump), JUMP_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [jump, rows, sessionId, leaveTail, reveal]);
}
