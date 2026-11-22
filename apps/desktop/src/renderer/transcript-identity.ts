import type { Snapshot, TranscriptItem } from './desktop-types';
import {
  alignedRow,
  transcriptWindowAlignment,
  fingerprintText,
  markClippedText,
  hasOwnId,
  heldWindowGoesOn,
  sameRowId,
  windowAnchored,
} from './transcript-alignment';

// Must cover every concurrently visible pane lane (8) plus the focused
// pipeline with headroom: evicting a still-visible session's baseline would
// reintroduce cross-source id flapping for that pane.
const IDENTITY_SESSION_LIMIT = 12;

interface SessionTranscriptIdentity {
  items: readonly TranscriptItem[];
  tail: TranscriptItem | null;
}

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

/** The baseline record of the live row (`streamingTail`), a new object every frame while its text grows. It keeps the
 *  text itself, neither cut nor fingerprinted: the next frame's tail is matched by its id, and only a row that crosses id
 *  namespaces (the reply settling under another id) compares the text, once. */
function liveIdentityRecord(item: TranscriptItem): TranscriptItem {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    text: item.text,
    status: item.status,
    label: capText(item.label),
    tone: item.tone,
    verb: item.verb,
    count: item.count,
    completedCount: item.completedCount,
    detail: capText(item.detail),
  };
}

interface ItemAdoption {
  items?: TranscriptItem[];
  accepted: boolean;
  consumed: number;
  offset: number;
}

function adoptItemIds(
  previous: SessionTranscriptIdentity,
  prevItems: readonly TranscriptItem[],
  incomingItems: readonly TranscriptItem[],
  carriedByIncoming: (id: unknown) => boolean,
  kept = 0,
  keptOffset = 0
): ItemAdoption {
  // A lone weak match (one completion row against another) is not evidence:
  // adopting across it gave an older page's first row the newest row's id.
  // An older page loaded above the displayed rows starts BEFORE them.
  // `kept` > 0: the caller has shown (`heldWindowGoesOn`) that the alignment is the in-window one at `keptOffset`, every
  // overlapping row matched by id. The first `kept` rows are the baseline's own under their own ids, so the walk begins
  // after them.
  const aligned = kept > 0 ? null : transcriptWindowAlignment(prevItems, incomingItems);
  // No candidate at all: the incoming transcript is a different history.
  // It keeps its own ids and replaces the baseline.
  const accepted = kept > 0 || aligned?.inWindow != null || aligned?.prepend != null;
  const offset = kept > 0 ? keptOffset : aligned?.prepend ? 0 : (aligned?.inWindow?.offset ?? 0);
  const start = aligned?.prepend?.start ?? 0;
  let out: TranscriptItem[] | null = null;
  let index = Math.max(start, kept);
  for (; accepted && index < incomingItems.length; index += 1) {
    const inc = incomingItems[index] as TranscriptItem;
    const prev = prevItems[index - start + offset];
    if (!prev) break;
    if (prev === inc) continue;
    if (!alignedRow(prev, inc)) break;
    if (hasOwnId(prev) && !sameRowId(prev, inc) && !carriedByIncoming(prev.id)) {
      out ||= incomingItems.slice();
      out[index] = { ...inc, id: prev.id };
    }
  }
  const walked = index - start;
  const consumed = accepted ? Math.min(walked + offset, prevItems.length) : 0;
  // Settle carryover: the first row past the shared history may be the
  // previously merged streaming tail landing as a settled row under a
  // fresh id — keep the id it was displayed with.
  const tailDonor = previous.tail;
  if (accepted && index < incomingItems.length && tailDonor && consumed >= prevItems.length) {
    const inc = incomingItems[index] as TranscriptItem;
    if (
      hasOwnId(tailDonor) &&
      !sameRowId(tailDonor, inc) &&
      alignedRow(tailDonor, inc) &&
      !carriedByIncoming(tailDonor.id)
    ) {
      out ||= incomingItems.slice();
      out[index] = { ...inc, id: tailDonor.id };
    }
  }
  return { items: out ?? undefined, accepted, consumed, offset: walked > 0 ? offset : 0 };
}

function adoptTailId(
  previous: SessionTranscriptIdentity | undefined,
  prevItems: readonly TranscriptItem[] | undefined,
  incomingTail: TranscriptItem,
  adoption: Pick<ItemAdoption, 'accepted' | 'consumed'>,
  carriedByIncoming: (id: unknown) => boolean
): TranscriptItem | undefined {
  // The live row keeps its id from frame to frame: under the id the baseline's tail already shows, it is that row, and
  // nothing of its (growing) text is read.
  if (previous?.tail && sameRowId(previous.tail, incomingTail)) return undefined;
  const leftover =
    adoption.accepted && prevItems && adoption.consumed < prevItems.length
      ? (prevItems[adoption.consumed] as TranscriptItem)
      : undefined;
  let donor: TranscriptItem | undefined;
  if (previous?.tail && alignedRow(previous.tail, incomingTail)) donor = previous.tail;
  else if (leftover && alignedRow(leftover, incomingTail)) donor = leftover;
  if (donor && hasOwnId(donor) && !sameRowId(donor, incomingTail) && !carriedByIncoming(donor.id)) {
    return { ...incomingTail, id: donor.id };
  }
  return undefined;
}

export function adoptTranscriptIdentity(
  previous: SessionTranscriptIdentity | undefined,
  incomingItems: readonly TranscriptItem[] | undefined,
  incomingTail: TranscriptItem | null,
  // The incoming list is the very array the baseline was recorded from.
  sameItems = false,
  // The incoming list's first `kept` rows are the rows the baseline holds from its row `keptOffset` on, under the same
  // ids, and the list aligns there by the ids of every row it overlaps (`heldWindowGoesOn`).
  kept = 0,
  keptOffset = 0
): { items?: TranscriptItem[]; tail?: TranscriptItem; offset?: number } {
  const prevItems = previous?.items;
  let incomingIds: Set<string> | null = null;
  const carriedByIncoming = (id: unknown) => {
    incomingIds ??= new Set((incomingItems ?? []).filter(hasOwnId).map((item) => String(item.id)));
    return incomingIds.has(String(id));
  };
  let adoption: ItemAdoption = { accepted: false, consumed: 0, offset: 0 };
  if (previous && prevItems && incomingItems) {
    if (sameItems || incomingItems === prevItems) adoption = { accepted: true, consumed: prevItems.length, offset: 0 };
    else if (incomingItems.length > 0 && prevItems.length > 0) {
      adoption = adoptItemIds(previous, prevItems, incomingItems, carriedByIncoming, kept, keptOffset);
    }
  }
  const adoptedTail = incomingTail
    ? adoptTailId(previous, prevItems, incomingTail, adoption, carriedByIncoming)
    : undefined;
  return { items: adoption.items, tail: adoptedTail, offset: adoption.offset };
}

/** What a lane knows of the list it hands over. */
export interface TranscriptLaneFacts {
  /** The list the lane handed over last (`rows`): the incoming one holds its first `count` rows in the same places. */
  held?: { rows: readonly unknown[]; count: number };
}

interface TranscriptIdentityReconciler {
  reconcile(snapshot: Snapshot, lane?: TranscriptLaneFacts): Snapshot;
  /** Drop one session's baseline (lane unmounted with nothing cached, or the session ended). */
  forget(sessionId: string): void;
}

interface RecordedIdentity extends SessionTranscriptIdentity {
  /** The displayed array the records came from; weak, so the baseline never pins a transcript. */
  source?: WeakRef<readonly TranscriptItem[]>;
  /** The list handed over, when the records from `rawOffset` on are its rows one for one under their own ids (the records
   *  before it are rows of an earlier window kept above). */
  raw?: WeakRef<readonly TranscriptItem[]>;
  rawOffset?: number;
  /** The records from `rawOffset` on are `windowAnchored`; unset: not read yet. */
  anchored?: boolean;
}

function nextBaseline(
  previous: RecordedIdentity | undefined,
  nextItems: readonly TranscriptItem[],
  offset: number,
  sameItems: boolean,
  kept: number
): { items: readonly TranscriptItem[]; source?: WeakRef<readonly TranscriptItem[]> } {
  if (previous && previous.items.length > 0 && nextItems.length === 0) return { items: previous.items };
  if (previous && kept > 0) {
    // The records of the rows above and of the rows kept stand; only the rows after them are recorded.
    const items = previous.items as TranscriptItem[];
    items.length = Math.min(offset + kept, items.length);
    for (let index = kept; index < nextItems.length; index += 1) items.push(identityRecord(nextItems[index]!));
    return { items, source: new WeakRef(nextItems) };
  }
  if (previous && previous.items.length > 0 && offset > 0) {
    return { items: [...previous.items.slice(0, offset), ...nextItems.map(identityRecord)] };
  }
  if (sameItems && previous) return { items: previous.items, source: previous.source };
  return { items: nextItems.map(identityRecord), source: new WeakRef(nextItems) };
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
    reconcile(snapshot: Snapshot, lane?: TranscriptLaneFacts): Snapshot {
      const sessionId = String(snapshot?.sessionId || '');
      const items = Array.isArray(snapshot?.items) ? snapshot.items : undefined;
      if (!sessionId || !items) return snapshot;
      const tail =
        snapshot.streamingTail && typeof snapshot.streamingTail === 'object'
          ? (snapshot.streamingTail as TranscriptItem)
          : null;
      const previous = sessions.get(sessionId);
      const sameItems = previous?.source?.deref() === items;
      // The baseline ends in the lane's last list, row for row, and the incoming list still holds leading rows of it. Which
      // rows correspond is ranked over the whole of both lists, so those rows are left unwalked only when the rows after
      // them show the alignment to be the one at the held window (`heldWindowGoesOn`); any other frame is aligned whole.
      const above = previous?.rawOffset ?? 0;
      const held =
        previous && !sameItems && lane?.held && previous.raw?.deref() === lane.held.rows
          ? Math.min(lane.held.count, items.length, previous.items.length - above)
          : 0;
      const anchored = previous && held > 0 ? (previous.anchored ?? windowAnchored(previous.items, above)) : false;
      const kept = previous && anchored && heldWindowGoesOn(previous.items, items, above, held) ? held : 0;
      const adopted = adoptTranscriptIdentity(previous, items, tail, sameItems, kept, above);
      const nextItems = adopted.items ?? items;
      const nextTail = adopted.tail ?? tail;
      sessions.delete(sessionId);
      const { items: baselineItems, source } = nextBaseline(previous, nextItems, adopted.offset || 0, sameItems, kept);
      // Row for row under their own ids, below the records of an earlier window kept above: no id was adopted.
      const rawOffset = baselineItems.length - items.length;
      const rowForRow = !adopted.items && items.length > 0 && rawOffset >= 0;
      sessions.set(sessionId, {
        items: baselineItems,
        tail: nextTail ? liveIdentityRecord(nextTail) : null,
        source,
        ...(rowForRow ? { raw: new WeakRef(items), rawOffset } : {}),
        // A frame decided from its held rows leaves the window anchored; the same list again leaves it as it was read.
        ...(rowForRow && kept > 0
          ? { anchored: true }
          : rowForRow && sameItems && previous?.anchored !== undefined
            ? { anchored: previous.anchored }
            : {}),
      });
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
