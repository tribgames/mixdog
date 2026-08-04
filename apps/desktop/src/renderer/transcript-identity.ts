// Cross-source transcript identity adoption.
//
// One conversation reaches the renderer under THREE id namespaces: the local
// engine's runtime ids, the deterministic disk-restore ids (hist_<session>_N),
// and — for attached viewers — the OWNER process's runtime ids mirrored over
// the live-share pipe. Entering a working session crosses namespaces (cached
// previous visit → disk restore → owner full frame), and every crossing used
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

import type { Snapshot, TranscriptItem } from "./desktop-types";

// Must cover every concurrently visible pane lane (8) plus the focused
// pipeline with headroom: evicting a still-visible session's baseline would
// reintroduce cross-source id flapping for that pane.
const IDENTITY_SESSION_LIMIT = 12;

export interface SessionTranscriptIdentity {
  items: readonly TranscriptItem[];
  tail: TranscriptItem | null;
}

function itemText(item: TranscriptItem): string {
  return typeof item.text === "string" ? item.text : item.text == null ? "" : String(item.text);
}

function hasOwnId(item: TranscriptItem): boolean {
  return item.id !== undefined && item.id !== null;
}

function sameRowId(a: TranscriptItem, b: TranscriptItem): boolean {
  return hasOwnId(a) && hasOwnId(b) && String(a.id) === String(b.id);
}

/** Strict content match — locates the alignment offset of a tail-truncated
 * transcript window (DESKTOP_TRANSCRIPT_ITEM_LIMIT) inside the previously
 * displayed items. */
function sameRowContent(a: TranscriptItem, b: TranscriptItem): boolean {
  return a.kind === b.kind
    && itemText(a) === itemText(b)
    && String(a.name ?? "") === String(b.name ?? "");
}

/** Loose same-logical-row match for the positional walk. Texts may differ by
 * streaming growth (one a prefix of the other) and tool rows by result
 * detail; kind (plus tool name) anchors the row. This is COMPATIBILITY only:
 * an assistant/user prefix or a same-name tool row admits a candidate but is
 * never on its own evidence that this is the right offset. */
function alignedRow(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool") return String(a.name ?? "") === String(b.name ?? "");
  if (a.kind === "user" || a.kind === "assistant") {
    const at = itemText(a);
    const bt = itemText(b);
    return at === bt || (at.length > 0 && bt.length > 0 && (at.startsWith(bt) || bt.startsWith(at)));
  }
  return true;
}

/** The activity/completion fields a status-like row is actually identified by
 * (core completion outcome, not a parallel desktop status model). */
function statusSignature(item: TranscriptItem): string {
  return [
    item.kind, item.status, item.label, item.tone, item.verb,
    item.count, item.completedCount, item.detail,
  ].map((value) => String(value ?? "")).join("\u0001");
}

type AlignmentCandidate = {
  offset: number;
  /** Contiguous aligned rows from the start of the incoming window. */
  overlap: number;
  idMatches: number;
  strongMatches: number;
  endsAtBaselineTail: boolean;
};

/** Rank one candidate against the best so far. Repeated rows (a debugger
 * session emits many identical "status done" lines) made the old
 * first-content-equal offset land on the WRONG occurrence: the window was
 * adopted onto history it never belonged to and the recovery frame then
 * remounted the real rows. Candidates are therefore scored on evidence. */
function betterCandidate(
  candidate: AlignmentCandidate,
  best: AlignmentCandidate | null,
  incomingShorter: boolean,
): boolean {
  if (!best) return true;
  if (candidate.overlap !== best.overlap) return candidate.overlap > best.overlap;
  if (candidate.idMatches !== best.idMatches) return candidate.idMatches > best.idMatches;
  if (candidate.strongMatches !== best.strongMatches) {
    return candidate.strongMatches > best.strongMatches;
  }
  if (candidate.endsAtBaselineTail !== best.endsAtBaselineTail) {
    return candidate.endsAtBaselineTail;
  }
  // Exact tie: a shorter incoming list is a tail WINDOW, so the rightmost
  // occurrence is the one it was cut from; otherwise the transcript starts
  // where the baseline starts.
  return incomingShorter ? candidate.offset > best.offset : candidate.offset < best.offset;
}

function alignmentCandidateAt(
  prevItems: readonly TranscriptItem[],
  incomingItems: readonly TranscriptItem[],
  offset: number,
): AlignmentCandidate | null {
  const span = Math.min(prevItems.length - offset, incomingItems.length);
  let overlap = 0;
  let idMatches = 0;
  let strongMatches = 0;
  for (; overlap < span; overlap += 1) {
    const prev = prevItems[offset + overlap] as TranscriptItem;
    const inc = incomingItems[overlap] as TranscriptItem;
    if (prev !== inc && !alignedRow(prev, inc)) break;
    if (sameRowId(prev, inc)) idMatches += 1;
    if (prev === inc
      || (sameRowContent(prev, inc) && statusSignature(prev) === statusSignature(inc))) {
      strongMatches += 1;
    }
  }
  // A mismatch inside the shared span is a different history, not a shorter
  // alignment. Adopting even the compatible prefix corrupts one or more row
  // ids before the walk aborts, and the following full frame then remounts.
  if (overlap === 0 || overlap !== span) return null;
  return {
    offset,
    overlap,
    idMatches,
    strongMatches,
    endsAtBaselineTail: offset + overlap === prevItems.length,
  };
}

export function adoptTranscriptIdentity(
  previous: SessionTranscriptIdentity | undefined,
  incomingItems: readonly TranscriptItem[] | undefined,
  incomingTail: TranscriptItem | null,
): { items?: TranscriptItem[]; tail?: TranscriptItem; offset?: number } {
  const prevItems = previous?.items;
  let adoptedItems: TranscriptItem[] | undefined;
  let consumed = 0;
  // Whether ANY offset candidate was accepted. Without one the incoming list
  // is a different history: no id adoption, no settle carryover, no tail
  // donation from leftover baseline rows.
  let acceptedAlignment = false;
  // Index in `previous.items` the incoming window aligned at. > 0 means the
  // frame is a tail WINDOW of the transcript already displayed.
  let alignedOffset = 0;
  if (incomingItems && prevItems && incomingItems.length > 0 && prevItems.length > 0
    && incomingItems !== prevItems) {
    // Evaluate EVERY offset the window could sit at (bounded by the host's
    // transcript item limit on both sides) and keep the best-evidenced one.
    const incomingShorter = incomingItems.length < prevItems.length;
    let best: AlignmentCandidate | null = null;
    for (let index = 0; index < prevItems.length; index += 1) {
      const candidate = alignmentCandidateAt(prevItems, incomingItems, index);
      if (candidate && betterCandidate(candidate, best, incomingShorter)) best = candidate;
    }
    acceptedAlignment = best !== null;
    // No candidate at all: the incoming transcript is a different history.
    // It keeps its own ids and replaces the baseline.
    const offset = best?.offset ?? 0;
    let out: TranscriptItem[] | null = null;
    let index = 0;
    for (; best && index < incomingItems.length; index += 1) {
      const inc = incomingItems[index] as TranscriptItem;
      const prev = prevItems[index + offset];
      if (!prev) break;
      if (prev === inc) continue;
      if (!alignedRow(prev, inc)) break;
      if (hasOwnId(prev) && !sameRowId(prev, inc)) {
        out ||= incomingItems.slice();
        out[index] = { ...inc, id: prev.id };
      }
    }
    consumed = best ? Math.min(index + offset, prevItems.length) : 0;
    // Only a walk that actually aligned a row proves the offset.
    if (index > 0) alignedOffset = offset;
    // Settle carryover: the first row past the shared history may be the
    // previously merged streaming tail landing as a settled row under a
    // fresh id — keep the id it was displayed with.
    const tailDonor = previous?.tail;
    if (best && index < incomingItems.length && tailDonor && consumed >= prevItems.length) {
      const inc = incomingItems[index] as TranscriptItem;
      if (alignedRow(tailDonor, inc) && hasOwnId(tailDonor) && !sameRowId(tailDonor, inc)) {
        out ||= incomingItems.slice();
        out[index] = { ...inc, id: tailDonor.id };
      }
    }
    adoptedItems = out ?? undefined;
  } else if (incomingItems && prevItems && incomingItems === prevItems) {
    consumed = prevItems.length;
    acceptedAlignment = true;
  }
  let adoptedTail: TranscriptItem | undefined;
  if (incomingTail) {
    const leftover = acceptedAlignment && prevItems && consumed < prevItems.length
      ? prevItems[consumed] as TranscriptItem
      : undefined;
    const donor = previous?.tail && alignedRow(previous.tail, incomingTail)
      ? previous.tail
      : leftover && alignedRow(leftover, incomingTail) ? leftover : undefined;
    if (donor && hasOwnId(donor) && !sameRowId(donor, incomingTail)) {
      adoptedTail = { ...incomingTail, id: donor.id };
    }
  }
  return { items: adoptedItems, tail: adoptedTail, offset: alignedOffset };
}

export interface TranscriptIdentityReconciler {
  reconcile(snapshot: Snapshot): Snapshot;
}

/** Per-session sticky adoption: the last DISPLAYED items are the baseline for
 * the next frame, so alternating sources (disk restore ↔ owner pipe) converge
 * on the first-seen ids instead of flapping. Bounded LRU, mirroring the
 * session snapshot cache. */
export function createTranscriptIdentityReconciler(): TranscriptIdentityReconciler {
  const sessions = new Map<string, SessionTranscriptIdentity>();
  return {
    reconcile(snapshot: Snapshot): Snapshot {
      const sessionId = String(snapshot?.sessionId || "");
      const items = Array.isArray(snapshot?.items) ? snapshot.items : undefined;
      if (!sessionId || !items) return snapshot;
      const tail = snapshot.streamingTail && typeof snapshot.streamingTail === "object"
        ? snapshot.streamingTail as TranscriptItem
        : null;
      const previous = sessions.get(sessionId);
      const adopted = adoptTranscriptIdentity(previous, items, tail);
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
      const baselineItems = previous && previous.items.length > 0
        ? nextItems.length === 0
          ? previous.items
          : (adopted.offset || 0) > 0
            ? [...previous.items.slice(0, adopted.offset), ...nextItems]
            : nextItems
        : nextItems;
      sessions.set(sessionId, { items: baselineItems, tail: nextTail });
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
