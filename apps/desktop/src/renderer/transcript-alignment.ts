import type { TranscriptItem } from './desktop-types';
import { historyPositionOf } from '../../../../packages/protocol-client/src/rows.ts';

const itemText = (item: TranscriptItem): string => {
  if (typeof item.text === 'string') return item.text;
  return item.text == null ? '' : String(item.text);
};

type TextFingerprint = { length: number; hash: number };
const clippedFingerprints = new WeakMap<object, TextFingerprint>();

/** FNV-1a over the first `end` chars. */
function hashText(text: string, end = text.length): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < end; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

export const fingerprintText = (text: string): TextFingerprint => ({ length: text.length, hash: hashText(text) });

/** Marks `record` as carrying a clipped `text` whose full form is `fingerprint`. */
export const markClippedText = (record: object, fingerprint: TextFingerprint): void => {
  clippedFingerprints.set(record, fingerprint);
};

const hasClippedText = (item: TranscriptItem): boolean => clippedFingerprints.has(item);

function sameText(a: TranscriptItem, b: TranscriptItem): boolean {
  const fa = clippedFingerprints.get(a),
    fb = clippedFingerprints.get(b);
  if (!fa && !fb) return itemText(a) === itemText(b);
  // A clipped record against full text: length then full-text hash.
  const at = itemText(a),
    bt = itemText(b);
  const lengthA = fa ? fa.length : at.length,
    lengthB = fb ? fb.length : bt.length;
  if (lengthA !== lengthB) return false;
  const hashA = fa ? fa.hash : hashText(at),
    hashB = fb ? fb.hash : hashText(bt);
  return hashA === hashB;
}

function compatibleText(a: TranscriptItem, b: TranscriptItem): boolean {
  if (!hasClippedText(a) && !hasClippedText(b)) {
    const at = itemText(a),
      bt = itemText(b);
    return at === bt || (at.length > 0 && bt.length > 0 && (at.startsWith(bt) || bt.startsWith(at)));
  }
  const fa = clippedFingerprints.get(a),
    fb = clippedFingerprints.get(b);
  const at = itemText(a),
    bt = itemText(b);
  const lengthA = fa ? fa.length : at.length,
    lengthB = fb ? fb.length : bt.length;
  if (lengthA === lengthB) return sameText(a, b);
  if (lengthA === 0 || lengthB === 0) return false;
  const [shorterFp, longerText, longerClipped, shorterText] =
    lengthA < lengthB ? [fa, bt, !!fb, at] : [fb, at, !!fa, bt];
  if (!shorterFp) {
    // Shorter side is complete text; the longer side is a clipped record and
    // proves the prefix only when its stored text covers the shorter one.
    return longerText.length >= shorterText.length && longerText.startsWith(shorterText);
  }
  // Shorter side is a clipped record: exact only against a complete longer text.
  if (longerClipped) return false;
  return hashText(longerText, shorterFp.length) === shorterFp.hash;
}

type RowIdentity = { readonly id?: unknown };
export const hasOwnId = (item: RowIdentity): boolean => item.id !== undefined && item.id !== null;
export const sameRowId = (a: RowIdentity, b: RowIdentity): boolean =>
  hasOwnId(a) && hasOwnId(b) && String(a.id) === String(b.id);

/** Join adjacent source windows at their shared suffix/prefix. A history row
 * can carry a divider already present at the beginning of the live window. */
export function joinTranscriptWindows<T extends RowIdentity>(
  older: readonly T[],
  newer: readonly T[]
): { items: T[]; joint: number } {
  let overlap = 0;
  for (let start = 0; start < older.length; start += 1) {
    const length = older.length - start;
    if (length > newer.length) continue;
    if (
      !older.slice(start).every((row, index) => {
        const next = newer[index];
        if (!next) return false;
        const position = historyPositionOf(row);
        const nextPosition = historyPositionOf(next);
        return (
          sameRowId(row, next) &&
          ((position === undefined && nextPosition === undefined) ||
            (position !== undefined &&
              position === nextPosition &&
              historyPositionOf(row, 'after') === historyPositionOf(next, 'after')))
        );
      })
    )
      continue;
    overlap = length;
    break;
  }
  const joint = older.length - overlap;
  return { items: older.slice(0, joint).concat(newer), joint };
}

/** The same window decision must govern identity adoption and head retention. */
export function transcriptWindowAlignment(previous: readonly TranscriptItem[], incoming: readonly TranscriptItem[]) {
  const found = findTranscriptAlignment(previous, incoming);
  const inWindow = found && alignmentAnchored(found, previous.length, incoming.length) ? found : null;
  const prepend = findTranscriptPrependAlignment(previous, incoming, inWindow);
  return { inWindow, prepend, found };
}

/** Whether `transcriptWindowAlignment` of a list against the rows of `previous` can be decided from the rows a frame did
 *  not leave in place (`heldWindowGoesOn`), for a window that begins at `previous[at]` under rows kept above it:
 *   - the window's first row has an id no other row of `previous` has. An incoming list that begins with that row can
 *     then align at no other offset: every other offset sets a row of another id against it, and content never bridges
 *     an id both lists hold;
 *   - every row of the window has an id, and none has the id of `previous[0]`: no incoming window that begins inside the
 *     rows kept above can then set a window row against that first row.
 *  Read once for a window (every id, no other field); a frame decided by `heldWindowGoesOn` leaves both standing. */
export function windowAnchored(previous: readonly RowIdentity[], at: number): boolean {
  const anchor = previous[at];
  if (!anchor || !hasOwnId(anchor)) return false;
  const anchorId = String(anchor.id);
  const firstRow = at > 0 ? previous[0] : undefined;
  const first = firstRow && hasOwnId(firstRow) ? String(firstRow.id) : null;
  for (let index = 0; index < at; index += 1) {
    const row = previous[index];
    if (row && hasOwnId(row) && String(row.id) === anchorId) return false;
  }
  for (let index = at + 1; index < previous.length; index += 1) {
    const row = previous[index];
    if (!row || !hasOwnId(row)) return false;
    const id = String(row.id);
    if (id === anchorId || id === first) return false;
  }
  return true;
}

/** Whether `transcriptWindowAlignment(previous, incoming)` is the in-window alignment at `at` with every overlapping row
 *  matched by id and no prepend, read from the rows after the first `held` alone. The caller knows: `previous` from `at`
 *  on is `windowAnchored`, and `incoming`'s first `held` (>= 1) rows are the rows `previous` holds from `at` on, under
 *  the same ids. What the rows after them must then show, since the alignment is ranked over the whole overlap:
 *   - each row that overlaps a row of `previous` has that row's id (the candidate at `at` is valid, by ids alone);
 *   - each has an id, and not the first row's (the window stays anchored, and no prepend can cross the first row);
 *   - none has the id of one of the first rows kept above, as many as there are rows after the held ones (a prepend that
 *     ends before the window can only set those rows against these).
 *  false is "not known": the caller aligns whole. */
export function heldWindowGoesOn(
  previous: readonly RowIdentity[],
  incoming: readonly RowIdentity[],
  at: number,
  held: number
): boolean {
  const anchor = previous[at];
  if (held < 1 || held > incoming.length || at + held > previous.length || !anchor || !hasOwnId(anchor)) return false;
  const anchorId = String(anchor.id);
  const overlap = Math.min(previous.length - at, incoming.length);
  const above = Math.min(at, incoming.length - held);
  for (let index = held; index < incoming.length; index += 1) {
    const row = incoming[index];
    if (!row || !hasOwnId(row)) return false;
    const id = String(row.id);
    if (id === anchorId) return false;
    if (index < overlap) {
      const prior = previous[at + index];
      if (!prior || !sameRowId(prior, row)) return false;
    }
    for (let head = 0; head < above; head += 1) {
      const kept = previous[head];
      if (kept && hasOwnId(kept) && String(kept.id) === id) return false;
    }
  }
  return true;
}

function sameRowContent(a: TranscriptItem, b: TranscriptItem): boolean {
  return a.kind === b.kind && sameText(a, b) && String(a.name ?? '') === String(b.name ?? '');
}

export function alignedRow(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tool') return String(a.name ?? '') === String(b.name ?? '');
  if (a.kind === 'user' || a.kind === 'assistant') return compatibleText(a, b);
  return true;
}

function transcriptSourceAlignment(previous: readonly TranscriptItem[], incoming: readonly TranscriptItem[]) {
  const previousIds = new Set(previous.filter(hasOwnId).map((row) => String(row.id)));
  const sharedIds = new Set(
    incoming.filter((row) => hasOwnId(row) && previousIds.has(String(row.id))).map((row) => String(row.id))
  );
  return {
    hasSharedIds: sharedIds.size > 0,
    aligned(a: TranscriptItem, b: TranscriptItem): boolean {
      if (sameRowId(a, b)) return true;
      // Content can bridge source namespaces, never relocate an id both
      // sources already identify.
      if ((hasOwnId(a) && sharedIds.has(String(a.id))) || (hasOwnId(b) && sharedIds.has(String(b.id)))) return false;
      return alignedRow(a, b);
    },
  };
}

function compareAlignment(
  a: { idMatches: number; overlap: number },
  b: { idMatches: number; overlap: number }
): number {
  return a.idMatches - b.idMatches || a.overlap - b.overlap;
}

const MIN_ANONYMOUS_OVERLAP = 8;

function alignmentAnchored(
  candidate: { overlap: number; idMatches: number },
  previousLength: number,
  incomingLength: number
): boolean {
  return (
    candidate.idMatches > 0 || candidate.overlap >= Math.min(previousLength, incomingLength, MIN_ANONYMOUS_OVERLAP)
  );
}

type PrependAlignment = { start: number; overlap: number; idMatches: number };

/** An incoming window that starts BEFORE the displayed one (an older page
 *  loaded above it) carries `previous` from index `start` > 0. Offsets inside
 *  `previous` belong to findTranscriptAlignment; shared source ids rank
 *  before overlap length in both directions. */
function findTranscriptPrependAlignment(
  previous: readonly TranscriptItem[],
  incoming: readonly TranscriptItem[],
  floor: { overlap: number; idMatches: number } | null
): PrependAlignment | null {
  const source = transcriptSourceAlignment(previous, incoming);
  let best: PrependAlignment | null = null;
  for (let start = 1; start < incoming.length; start += 1) {
    // Non-increasing in `start`: once it cannot win, no later start can.
    const span = Math.min(previous.length, incoming.length - start);
    const upper = { overlap: span, idMatches: source.hasSharedIds ? span : 0 };
    if (best && compareAlignment(upper, best) < 0) break;
    if (floor && compareAlignment(upper, floor) <= 0) break;
    let idMatches = 0;
    let aligned = true;
    for (let index = 0; index < span; index += 1) {
      const a = previous[index],
        b = incoming[start + index];
      if (!source.aligned(a, b)) {
        aligned = false;
        break;
      }
      if (sameRowId(a, b)) idMatches += 1;
    }
    if (!aligned || (source.hasSharedIds && idMatches === 0)) continue;
    const candidate = { start, overlap: span, idMatches };
    if (!alignmentAnchored(candidate, previous.length, incoming.length)) continue;
    if (floor && compareAlignment(candidate, floor) <= 0) continue;
    if (!best || compareAlignment(candidate, best) > 0) best = candidate;
    if (idMatches === span) break;
  }
  return best;
}

type AlignmentCandidate = {
  offset: number;
  overlap: number;
  idMatches: number;
  strongMatches: number;
  endsAtBaselineTail: boolean;
};

function better(candidate: AlignmentCandidate, best: AlignmentCandidate | null, shorter: boolean): boolean {
  if (!best) return true;
  const order = compareAlignment(candidate, best);
  if (order !== 0) return order > 0;
  if (candidate.strongMatches !== best.strongMatches) return candidate.strongMatches > best.strongMatches;
  if (candidate.endsAtBaselineTail !== best.endsAtBaselineTail) return candidate.endsAtBaselineTail;
  return shorter ? candidate.offset > best.offset : candidate.offset < best.offset;
}

/** Identical scoring to exhaustive adoption. Fast paths stop only when upper
 * bounds prove that no unevaluated offset can outrank the current candidate. */
export function findTranscriptAlignment(
  previous: readonly TranscriptItem[],
  incoming: readonly TranscriptItem[]
): AlignmentCandidate | null {
  const shorter = incoming.length < previous.length;
  const source = transcriptSourceAlignment(previous, incoming);
  const signatures = new WeakMap<TranscriptItem, string>();
  const signature = (item: TranscriptItem): string => {
    let value = signatures.get(item);
    if (value === undefined) {
      value = [item.kind, item.status, item.label, item.tone, item.verb, item.count, item.completedCount, item.detail]
        .map((part) => String(part ?? ''))
        .join('\u0001');
      signatures.set(item, value);
    }
    return value;
  };
  const candidateAt = (offset: number): AlignmentCandidate | null => {
    const span = Math.min(previous.length - offset, incoming.length);
    let idMatches = 0,
      strongMatches = 0;
    for (let index = 0; index < span; index += 1) {
      const a = previous[offset + index],
        b = incoming[index];
      if (!source.aligned(a, b)) return null;
      if (sameRowId(a, b)) idMatches += 1;
      if (a === b || (sameRowContent(a, b) && signature(a) === signature(b))) strongMatches += 1;
    }
    return span > 0 && (!source.hasSharedIds || idMatches > 0)
      ? { offset, overlap: span, idMatches, strongMatches, endsAtBaselineTail: offset + span === previous.length }
      : null;
  };
  let best: AlignmentCandidate | null = null;
  const evaluated = new Set<number>();
  const consider = (offset: number): void => {
    evaluated.add(offset);
    const candidate = candidateAt(offset);
    if (candidate && better(candidate, best, shorter)) best = candidate;
  };
  if (shorter && incoming.length > 0) {
    const tailOffset = previous.length - incoming.length;
    const tail = candidateAt(tailOffset);
    evaluated.add(tailOffset);
    best = tail;
    if (tail?.strongMatches === incoming.length) {
      if (tail.idMatches === incoming.length) return tail;
      // A source namespace with no shared ids has an id-score upper bound of
      // zero. Full strict tail equality reaches every remaining score bound.
      if (!source.hasSharedIds) return tail;
    }
    if (hasOwnId(incoming[0])) {
      for (let offset = 0; offset < previous.length; offset += 1) {
        if (!evaluated.has(offset) && sameRowId(previous[offset], incoming[0])) consider(offset);
      }
      const anchored = best as AlignmentCandidate | null;
      // Every full-id match must start with that same first id; all such
      // offsets have now been evaluated, including duplicates.
      if (anchored?.overlap === incoming.length && anchored.idMatches === incoming.length) return anchored;
    }
  }
  for (let offset = 0; offset < previous.length; offset += 1) {
    const maximumOverlap = Math.min(previous.length - offset, incoming.length);
    const current = best as AlignmentCandidate | null;
    const upper = { overlap: maximumOverlap, idMatches: source.hasSharedIds ? maximumOverlap : 0 };
    if (current && compareAlignment(upper, current) < 0) break;
    if (!evaluated.has(offset)) consider(offset);
  }
  return best;
}
