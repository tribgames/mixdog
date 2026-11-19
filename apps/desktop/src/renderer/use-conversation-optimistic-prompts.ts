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
    // A promotion is not a navigation: the in-flight prompt stays visible
    // until its own settled row lands (released by id), instead of blinking
    // out of the thread for the publication interval after the first submit.
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
    queuedMarks.current.clear();
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);
  useEffect(() => {
    // Neither host acknowledgement nor queue publication is settlement: the
    // optimistic card is dropped from state only once its own durable row is
    // in the transcript. Until then it is the bubble — for a queued prompt
    // through the drain's state where its queue entry has left and its row
    // has not arrived yet (steerPromptItems' local twin) — and, for an idle
    // submit, the working band's clock.
    const acknowledged = new Set(
      settledItems
        .map((item) => item?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String)
    );
    // A message a running turn reads is stored under the core's own item id,
    // not its submission id, so no id names its row. Its queue entry does:
    // the entries a drain takes leave the queue together and their rows land
    // one by one in that order, so an entry's row is the next user row past
    // the rows of the entries that left ahead of it. Rows are located from
    // the last one seen while it was queued, not counted over the transcript:
    // the live window is bounded and drops its oldest rows.
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
      // A delivered message stays only to hold its row against the messages
      // sent with it that still wait (pendingPromptTranscriptItems).
      const waits = kept.some((item) => !item.delivered && item.steer !== 'failed');
      const next = waits ? kept : kept.filter((item) => !item.delivered);
      return changed || next.length !== current.length ? next : current;
    });
  }, [optimisticPrompts, queued, setOptimisticPrompts, settledItems]);
}
