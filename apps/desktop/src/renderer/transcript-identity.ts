// Cross-source transcript identity adoption.
//
// One conversation reaches the renderer under two id namespaces: the engine's
// runtime ids and the deterministic disk-restore ids (hist_<session>_N).
// Entering a working session crosses namespaces (cached previous visit → disk
// restore → live runtime frame), and every crossing used
// to reissue the React/virtualizer key of the SAME visible row: measured
// heights were dropped, the bottom of the transcript remounted at estimate
// heights, and the pinned view corrected itself frame over frame (user:
// entering the working session made the work script shake up and down until
// it stopped). Adopting the first-seen id for the aligned, content-compatible
// row keeps row identity stable across sources: content updates in place,
// nothing remounts, nothing shakes.
//
// Transcripts are append-only per session, so the positional walk is safe; a
// hard kind mismatch aborts adoption for the rest of the frame (conservative
// pass-through). Ids are DISPLAY identity only in the renderer (React keys,
// virtualizer measurement keys, image-preview keys), so adopting an id never
// changes what any host API is called with.

import type { Snapshot, TranscriptItem } from './desktop-types';
import {
  alignedRow,
  alignmentAnchored,
  findTranscriptAlignment,
  fingerprintText,
  markClippedText,
  findTranscriptPrependAlignment,
  hasOwnId,
  sameRowId,
} from './transcript-alignment';

// Must cover every concurrently visible pane lane (8) plus the focused
// pipeline with headroom: evicting a still-visible session's baseline would
// reintroduce cross-source id flapping for that pane.
const IDENTITY_SESSION_LIMIT = 12;

interface SessionTranscriptIdentity {
  items: readonly TranscriptItem[];
  tail: TranscriptItem | null;
}

// Reconciliation reads only a row's id, kind, name and the short text-ish
// fields below (alignedRow / sameRowContent / the strong-match signature).
// The baseline therefore keeps a reduced record per row instead of the full
// item (tool args/results, images, markdown bodies). Long strings are cut to
// a prefix PLUS a fingerprint of the full text (length + hash), so two long
// texts sharing the prefix never compare equal or prefix-compatible.
const IDENTITY_TEXT_CAP = 512;
const capText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (text.length <= IDENTITY_TEXT_CAP) return text;
  const { length, hash } = fingerprintText(text);
  return `${text.slice(0, IDENTITY_TEXT_CAP)}\u0002${length}:${hash}`;
};
const identityRecords = new WeakMap<object, TranscriptItem>();

function identityRecord(item: TranscriptItem): TranscriptItem {
  let record = identityRecords.get(item);
  if (!record) {
    const text = item.text === undefined || item.text === null ? undefined : String(item.text);
    record = {
      id: item.id,
      kind: item.kind,
      name: item.name,
      text: text === undefined ? undefined : text.slice(0, IDENTITY_TEXT_CAP),
      status: item.status,
      label: capText(item.label),
      tone: item.tone,
      verb: item.verb,
      count: item.count,
      completedCount: item.completedCount,
      detail: capText(item.detail),
    };
    if (text !== undefined && text.length > IDENTITY_TEXT_CAP) markClippedText(record, fingerprintText(text));
    identityRecords.set(item, record);
  }
  return record;
}

export function adoptTranscriptIdentity(
  previous: SessionTranscriptIdentity | undefined,
  incomingItems: readonly TranscriptItem[] | undefined,
  incomingTail: TranscriptItem | null,
  // The incoming list is the very array the baseline was recorded from.
  sameItems = false
): { items?: TranscriptItem[]; tail?: TranscriptItem; offset?: number } {
  const prevItems = previous?.items;
  const identical = sameItems || incomingItems === prevItems;
  let adoptedItems: TranscriptItem[] | undefined;
  let consumed = 0;
  // Whether ANY offset candidate was accepted. Without one the incoming list
  // is a different history: no id adoption, no settle carryover, no tail
  // donation from leftover baseline rows.
  let acceptedAlignment = false;
  // Index in `previous.items` the incoming window aligned at. > 0 means the
  // frame is a tail WINDOW of the transcript already displayed.
  let alignedOffset = 0;
  if (incomingItems && prevItems && incomingItems.length > 0 && prevItems.length > 0 && !identical) {
    const found = findTranscriptAlignment(prevItems, incomingItems);
    // A lone weak match (one completion row against another) is not evidence:
    // adopting across it gave an older page's first row the newest row's id.
    const inWindow = found && alignmentAnchored(found, prevItems.length, incomingItems.length) ? found : null;
    // An older page loaded above the displayed rows starts BEFORE them.
    const prepend = findTranscriptPrependAlignment(prevItems, incomingItems, inWindow);
    // No candidate at all: the incoming transcript is a different history.
    // It keeps its own ids and replaces the baseline.
    acceptedAlignment = inWindow !== null || prepend !== null;
    const offset = prepend ? 0 : (inWindow?.offset ?? 0);
    const start = prepend?.start ?? 0;
    let out: TranscriptItem[] | null = null;
    let index = start;
    for (; acceptedAlignment && index < incomingItems.length; index += 1) {
      const inc = incomingItems[index] as TranscriptItem;
      const prev = prevItems[index - start + offset];
      if (!prev) break;
      if (prev === inc) continue;
      if (!alignedRow(prev, inc)) break;
      if (hasOwnId(prev) && !sameRowId(prev, inc)) {
        out ||= incomingItems.slice();
        out[index] = { ...inc, id: prev.id };
      }
    }
    const walked = index - start;
    consumed = acceptedAlignment ? Math.min(walked + offset, prevItems.length) : 0;
    // Only a walk that actually aligned a row proves the offset.
    if (walked > 0) alignedOffset = offset;
    // Settle carryover: the first row past the shared history may be the
    // previously merged streaming tail landing as a settled row under a
    // fresh id — keep the id it was displayed with.
    const tailDonor = previous?.tail;
    if (acceptedAlignment && index < incomingItems.length && tailDonor && consumed >= prevItems.length) {
      const inc = incomingItems[index] as TranscriptItem;
      if (alignedRow(tailDonor, inc) && hasOwnId(tailDonor) && !sameRowId(tailDonor, inc)) {
        out ||= incomingItems.slice();
        out[index] = { ...inc, id: tailDonor.id };
      }
    }
    adoptedItems = out ?? undefined;
  } else if (incomingItems && prevItems && identical) {
    consumed = prevItems.length;
    acceptedAlignment = true;
  }
  let adoptedTail: TranscriptItem | undefined;
  if (incomingTail) {
    const leftover =
      acceptedAlignment && prevItems && consumed < prevItems.length
        ? (prevItems[consumed] as TranscriptItem)
        : undefined;
    let donor: TranscriptItem | undefined;
    if (previous?.tail && alignedRow(previous.tail, incomingTail)) donor = previous.tail;
    else if (leftover && alignedRow(leftover, incomingTail)) donor = leftover;
    if (donor && hasOwnId(donor) && !sameRowId(donor, incomingTail)) {
      adoptedTail = { ...incomingTail, id: donor.id };
    }
  }
  return { items: adoptedItems, tail: adoptedTail, offset: alignedOffset };
}

interface TranscriptIdentityReconciler {
  reconcile(snapshot: Snapshot): Snapshot;
  /** Drop one session's baseline (lane unmounted with nothing cached, or the session ended). */
  forget(sessionId: string): void;
}

interface RecordedIdentity extends SessionTranscriptIdentity {
  /** The displayed array the records came from; weak, so the baseline never pins a transcript. */
  source?: WeakRef<readonly TranscriptItem[]>;
}

/** Per-session sticky adoption: the last DISPLAYED items are the baseline for
 * the next frame, so alternating sources (disk restore ↔ owner pipe) converge
 * on the first-seen ids instead of flapping. Bounded LRU, mirroring the
 * session snapshot cache. */
export function createTranscriptIdentityReconciler(): TranscriptIdentityReconciler {
  const sessions = new Map<string, RecordedIdentity>();
  return {
    forget(sessionId: string): void {
      sessions.delete(sessionId);
    },
    reconcile(snapshot: Snapshot): Snapshot {
      const sessionId = String(snapshot?.sessionId || '');
      const items = Array.isArray(snapshot?.items) ? snapshot.items : undefined;
      if (!sessionId || !items) return snapshot;
      const tail =
        snapshot.streamingTail && typeof snapshot.streamingTail === 'object'
          ? (snapshot.streamingTail as TranscriptItem)
          : null;
      const previous = sessions.get(sessionId);
      const sameItems = previous?.source?.deref() === items;
      const adopted = adoptTranscriptIdentity(previous, items, tail, sameItems);
      const nextItems = adopted.items ?? items;
      const nextTail = adopted.tail ?? tail;
      sessions.delete(sessionId);
      // A frame that carries LESS history than the baseline must not become
      // the baseline. A transitional EMPTY frame (focus routing, engine
      // resume, cold handshake) and a tail-windowed disk/replay frame both
      // left the recovered full frame with nothing to align against: every
      // row id was reissued and the whole settled transcript remounted one
      // frame after a pane was clicked (user report, CDP-attributed). The
      // baseline therefore keeps the aligned SUPERSET; a genuine rewrite
      // (clear, compaction, branch/fork resume) fails alignment on content
      // and replaces it untouched.
      let baselineItems: readonly TranscriptItem[];
      // Set only while the baseline is a 1:1 record of `nextItems`, so the
      // same array arriving again skips the alignment walk entirely.
      let source: WeakRef<readonly TranscriptItem[]> | undefined;
      if (previous && previous.items.length > 0 && nextItems.length === 0) baselineItems = previous.items;
      else if (previous && previous.items.length > 0 && (adopted.offset || 0) > 0)
        baselineItems = [...previous.items.slice(0, adopted.offset), ...nextItems.map(identityRecord)];
      else if (sameItems && previous) {
        baselineItems = previous.items;
        source = previous.source;
      } else {
        baselineItems = nextItems.map(identityRecord);
        source = new WeakRef(nextItems);
      }
      sessions.set(sessionId, { items: baselineItems, tail: nextTail ? identityRecord(nextTail) : null, source });
      while (sessions.size > IDENTITY_SESSION_LIMIT) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      if (!adopted.items && !adopted.tail) return snapshot;
      return {
        ...snapshot,
        items: nextItems,
        ...(adopted.tail ? { streamingTail: adopted.tail } : {}),
      };
    },
  };
}
