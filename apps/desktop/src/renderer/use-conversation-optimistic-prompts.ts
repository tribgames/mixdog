import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { settledUserRowCount, type PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { asRecord } from './text-format';

/** Drops optimistic prompt cards: on navigation away from the session, and
 *  once each card's own durable row is in the settled transcript. The core
 *  publishes that row with its turn's start, so the running turn holds the
 *  working band from the same state on. */
export function useConversationOptimisticPromptRelease({
  transcriptSessionKey,
  promotedOwnDraft,
  settledItems,
  optimisticPrompts,
  queued,
  setOptimisticPrompts,
}: {
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
  settledItems: readonly TranscriptItem[];
  optimisticPrompts: readonly PendingPromptItem[];
  /** The session runtime's queue (`snapshot.queued`). */
  queued: unknown;
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
}) {
  // The messages the session queue has held, in queue order: the last settled
  // row there was while each was still queued, once it has left the queue
  // which user row past that one is its own, and whether this pane sent it.
  const queuedMarks = useRef(new Map<string, { after: TranscriptItem['id']; row: number; own: boolean }>());
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
    queuedMarks.current.clear();
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);
  useEffect(() => {
    const acknowledged = new Set(
      settledItems
        .map((item) => item?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String)
    );
    const twins = new Set(
      optimisticPrompts
        .filter((item) => item.queuedBehindTurn && !item.delivered && item.steer !== 'failed')
        .map((item) => String(item.id))
    );
    const queuedIds = (Array.isArray(queued) ? queued : [])
      .map((entry) => String(asRecord(entry)?.id ?? ''))
      .filter(Boolean);
    const waiting = new Set(queuedIds);
    const marks = queuedMarks.current;
    const tail = settledItems.at(-1)?.id;
    // Cancelled or settled by id: nothing of this pane's to wait for.
    for (const [id, mark] of [...marks]) if (mark.own && !twins.has(id)) marks.delete(id);
    // Every entry is followed, in queue order: another surface's holds its
    // place in the drain ahead of this pane's.
    for (const id of queuedIds) marks.set(id, { after: tail, row: 0, own: twins.has(id) });
    const delivered = new Set<string>();
    // Entries out of the queue whose rows had not landed by the last pass:
    // those rows lie past every mark taken since.
    let ahead = 0;
    for (const [id, mark] of marks) {
      if (waiting.has(id)) continue;
      if (mark.row === 0) mark.row = ahead + 1;
      ahead += 1;
      const from = mark.after === undefined ? 0 : settledItems.findLastIndex((item) => item?.id === mark.after) + 1;
      const past = settledItems.slice(from);
      const landed = settledUserRowCount(past) >= mark.row;
      // An entry may leave without a row (cancelled from another surface):
      // its turn's end closes it, so it holds no place in a later drain. This
      // pane's bubble stands one row longer, through an idle drain's state
      // where the turn has ended and the entry's own turn has not begun.
      const ended = past.findIndex((item) => item?.kind === 'turndone');
      if (!landed && (ended < 0 || (mark.own && ended === past.length - 1))) continue;
      marks.delete(id);
      if (mark.own) delivered.add(id);
    }
    const held = new Set([...marks].filter(([, mark]) => mark.own).map(([id]) => id));
    setOptimisticPrompts((current) => {
      let changed = false;
      const kept = current.flatMap((item) => {
        const id = String(item.id);
        if (acknowledged.has(id)) {
          changed = true;
          return [];
        }
        if (delivered.has(id) && !item.delivered) {
          changed = true;
          return [{ ...item, delivered: true }];
        }
        if (!held.has(id) || item.queueHeld) return [item];
        changed = true;
        return [{ ...item, queueHeld: true }];
      });
      const waits = kept.some((item) => !item.delivered && item.steer !== 'failed');
      const next = waits ? kept : kept.filter((item) => !item.delivered);
      return changed || next.length !== current.length ? next : current;
    });
  }, [optimisticPrompts, queued, setOptimisticPrompts, settledItems]);
}
