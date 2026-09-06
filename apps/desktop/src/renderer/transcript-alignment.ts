import type { TranscriptItem } from "./desktop-types";

const itemText = (item: TranscriptItem): string =>
  typeof item.text === "string" ? item.text : item.text == null ? "" : String(item.text);

export const hasOwnId = (item: TranscriptItem): boolean => item.id !== undefined && item.id !== null;
export const sameRowId = (a: TranscriptItem, b: TranscriptItem): boolean =>
  hasOwnId(a) && hasOwnId(b) && String(a.id) === String(b.id);

function sameRowContent(a: TranscriptItem, b: TranscriptItem): boolean {
  return a.kind === b.kind && itemText(a) === itemText(b)
    && String(a.name ?? "") === String(b.name ?? "");
}

export function alignedRow(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool") return String(a.name ?? "") === String(b.name ?? "");
  if (a.kind === "user" || a.kind === "assistant") {
    const at = itemText(a), bt = itemText(b);
    return at === bt || (at.length > 0 && bt.length > 0 && (at.startsWith(bt) || bt.startsWith(at)));
  }
  return true;
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
  if (candidate.overlap !== best.overlap) return candidate.overlap > best.overlap;
  if (candidate.idMatches !== best.idMatches) return candidate.idMatches > best.idMatches;
  if (candidate.strongMatches !== best.strongMatches) return candidate.strongMatches > best.strongMatches;
  if (candidate.endsAtBaselineTail !== best.endsAtBaselineTail) return candidate.endsAtBaselineTail;
  return shorter ? candidate.offset > best.offset : candidate.offset < best.offset;
}

/** Identical scoring to exhaustive adoption. Fast paths stop only when upper
 * bounds prove that no unevaluated offset can outrank the current candidate. */
export function findTranscriptAlignment(
  previous: readonly TranscriptItem[],
  incoming: readonly TranscriptItem[],
): AlignmentCandidate | null {
  const shorter = incoming.length < previous.length;
  const signatures = new WeakMap<TranscriptItem, string>();
  const signature = (item: TranscriptItem): string => {
    let value = signatures.get(item);
    if (value === undefined) {
      value = [item.kind, item.status, item.label, item.tone, item.verb,
        item.count, item.completedCount, item.detail].map((part) => String(part ?? "")).join("\u0001");
      signatures.set(item, value);
    }
    return value;
  };
  const candidateAt = (offset: number): AlignmentCandidate | null => {
    const span = Math.min(previous.length - offset, incoming.length);
    let idMatches = 0, strongMatches = 0;
    for (let index = 0; index < span; index += 1) {
      const a = previous[offset + index], b = incoming[index];
      if (a !== b && !alignedRow(a, b)) return null;
      if (sameRowId(a, b)) idMatches += 1;
      if (a === b || (sameRowContent(a, b) && signature(a) === signature(b))) strongMatches += 1;
    }
    return span > 0
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
      const ids = new Set(previous.filter(hasOwnId).map((item) => String(item.id)));
      // A source namespace with no shared ids has an id-score upper bound of
      // zero. Full strict tail equality reaches every remaining score bound.
      if (!incoming.some((item) => hasOwnId(item) && ids.has(String(item.id)))) return tail;
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
    if (current && maximumOverlap < current.overlap) break;
    if (!evaluated.has(offset)) consider(offset);
  }
  return best;
}
