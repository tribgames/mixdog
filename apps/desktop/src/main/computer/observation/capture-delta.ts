/**
 * What the model already holds of a window, and the delta that updates it.
 *
 * Every snapshot retires the worker's refs (`s<generation>:e<n>`): a ref from
 * an older snapshot is refused as stale, and the host never rewrites a ref the
 * model sends. A delta therefore cannot carry refs forward. It tells the model
 * which rows of the list it holds are still on screen unchanged and the live
 * ref each one has now (`unchanged: ["s1:e0..e4=s9:e0..e4"]`), and lists every
 * other row in full with its live ref. Whatever the model sends is either a
 * live ref of the newest snapshot or a retired one the worker refuses.
 *
 * "Unchanged" asserts only that a row renders identically (role, name, value,
 * state, bounds, actions); it makes no claim that the same UI object lived on
 * between the snapshots, which UIA cannot prove (RuntimeIds are reused, and
 * MSAA proxies identify rows by index). Rows are paired by an order-preserving
 * alignment of their content, so the model can rebuild exactly the list a full
 * observation would have sent.
 */
import { isFreshComputerObservation, MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS } from '../session/resources';

type ElementRow = Record<string, unknown>;

/** Consecutive deltas before a full list is sent again. Unchanged rows are
 *  named by refs from an observation that may have left the model's context. */
const MAX_CONSECUTIVE_DELTAS = 8;
/** Largest changed middle section aligned exactly; beyond it everything in the
 *  section counts as changed, which only makes the delta larger. */
const MAX_ALIGNMENT_CELLS = 250_000;

interface HeldRow {
  /** The ref the most recent reply gave this row. */
  ref: string;
  fingerprint: string;
}

export interface ObservationDeltaState {
  windowId: string;
  baselineKey: string;
  relatedWindowIds: string;
  generation: number;
  observedAt: number;
  consecutiveDeltas: number;
  /** The list the model holds, in order. */
  held: HeldRow[];
}

export type ObservationDeltaStore = Map<string, ObservationDeltaState>;

export interface ObservationInput {
  /** The rows the reply would list in full. */
  elements: ElementRow[];
  windowId: string;
  baselineKey: string;
  relatedWindowIds: string[];
  generation: unknown;
  /** Whether the rows describe the accessibility tree of a settled capture. */
  recordable: boolean;
  /** Whether this reply may be a delta against the previous observation. */
  deltaAllowed: boolean;
}

const relatedKey = (ids: string[]) => [...new Set(ids)].sort().join('\u0000');

function fingerprintOf(row: ElementRow): string {
  const { mark: _mark, ref: _ref, ...content } = row;
  return JSON.stringify(content);
}

/** A row as the delta lists it: marks renumber with every capture, so none is
 *  offered for the model to quote. */
function deltaRow(row: ElementRow): ElementRow {
  const { mark: _mark, ...rest } = row;
  return rest;
}

/** Alignment keys for one side. Rows that render identically to another row of
 *  either list cannot be told apart (which twin was removed?), so they get a
 *  key nothing else shares and are reported as removed and listed again. */
function pairableKeys(own: string[], other: string[], side: string): string[] {
  const count = (list: string[]) => {
    const counts = new Map<string, number>();
    for (const fingerprint of list) counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    return counts;
  };
  const ownCounts = count(own);
  const otherCounts = count(other);
  return own.map((fingerprint, index) =>
    ownCounts.get(fingerprint) === 1 && (otherCounts.get(fingerprint) ?? 0) <= 1
      ? fingerprint
      : `\u0000${side}:${index}`
  );
}

/** Index pairs [before, after] of equal fingerprints, in order on both sides. */
function alignRows(before: string[], after: string[]): Array<[number, number]> {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > head && afterEnd > head && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < head; index += 1) pairs.push([index, index]);
  const rows = beforeEnd - head;
  const columns = afterEnd - head;
  if (rows > 0 && columns > 0 && rows * columns <= MAX_ALIGNMENT_CELLS) {
    // lengths[i][j]: longest common subsequence of the middle sections from i, j on.
    const width = columns + 1;
    const lengths = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          before[head + i] === after[head + j]
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (before[head + i] === after[head + j]) {
        pairs.push([head + i, head + j]);
        i += 1;
        j += 1;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i += 1;
      else j += 1;
    }
  }
  const tail = before.length - beforeEnd;
  for (let offset = 0; offset < tail; offset += 1) pairs.push([beforeEnd + offset, afterEnd + offset]);
  return pairs;
}

const REF_PATTERN = /^(.+:e)(\d+)$/;

/** Pairs "held ref = live ref", folding consecutive refs on both sides into
 *  `s1:e0..e4=s9:e0..e4` so a mostly unchanged list stays a few bytes. */
function pairRuns(pairs: Array<{ held: string; live: string }>): string[] {
  const runs: string[] = [];
  let index = 0;
  while (index < pairs.length) {
    const first = pairs[index];
    const heldMatch = REF_PATTERN.exec(first.held);
    const liveMatch = REF_PATTERN.exec(first.live);
    let end = index;
    if (heldMatch && liveMatch) {
      while (end + 1 < pairs.length) {
        const next = pairs[end + 1];
        const nextHeld = REF_PATTERN.exec(next.held);
        const nextLive = REF_PATTERN.exec(next.live);
        const length = end + 1 - index;
        if (
          nextHeld?.[1] !== heldMatch[1] ||
          nextLive?.[1] !== liveMatch[1] ||
          Number(nextHeld[2]) !== Number(heldMatch[2]) + length ||
          Number(nextLive[2]) !== Number(liveMatch[2]) + length
        )
          break;
        end += 1;
      }
    }
    if (end === index || !heldMatch || !liveMatch) runs.push(`${first.held}=${first.live}`);
    else {
      const last = pairs[end];
      const lastHeld = REF_PATTERN.exec(last.held) as RegExpExecArray;
      const lastLive = REF_PATTERN.exec(last.live) as RegExpExecArray;
      runs.push(`${first.held}..e${lastHeld[2]}=${first.live}..e${lastLive[2]}`);
    }
    index = end + 1;
  }
  return runs;
}

function sameWindowLineage(previous: ObservationDeltaState, input: ObservationInput, now: number): boolean {
  return (
    previous.windowId === input.windowId &&
    previous.baselineKey === input.baselineKey &&
    previous.relatedWindowIds === relatedKey(input.relatedWindowIds) &&
    typeof input.generation === 'number' &&
    input.generation > previous.generation &&
    previous.consecutiveDeltas < MAX_CONSECUTIVE_DELTAS &&
    isFreshComputerObservation(previous.observedAt, now, MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS)
  );
}

/**
 * Record this observation as the one the model now holds and, when the
 * previous one is a valid baseline and the change is smaller than the list,
 * return the delta to send instead of the full rows. Anything that cannot be
 * proven a continuation (no baseline, another window or read, a dialog, a
 * generation that did not advance, OCR rows, a delta no smaller) answers
 * undefined and resets the baseline to this full list.
 */
export function recordObservation(
  store: ObservationDeltaStore,
  sessionId: string,
  input: ObservationInput
): ElementRow | undefined {
  if (!input.recordable || input.elements.some((row) => row.source === 'ocr') || typeof input.generation !== 'number') {
    store.delete(sessionId);
    return undefined;
  }
  const now = performance.now();
  const rows = input.elements.map((row) => ({ ref: String(row.ref), fingerprint: fingerprintOf(row), row }));
  const previous = store.get(sessionId);
  const remember = (held: HeldRow[], consecutiveDeltas: number) =>
    store.set(sessionId, {
      windowId: input.windowId,
      baselineKey: input.baselineKey,
      relatedWindowIds: relatedKey(input.relatedWindowIds),
      generation: input.generation as number,
      observedAt: now,
      consecutiveDeltas,
      held,
    });

  const liveRefs = new Set(rows.map((row) => row.ref));
  // A ref the model holds that is also a live one (a worker whose generation
  // restarted) would name a different element than the model means.
  if (
    input.deltaAllowed &&
    previous &&
    sameWindowLineage(previous, input, now) &&
    !previous.held.some((held) => liveRefs.has(held.ref))
  ) {
    const pairs = alignRows(
      pairableKeys(
        previous.held.map((held) => held.fingerprint),
        rows.map((row) => row.fingerprint),
        'held'
      ),
      pairableKeys(
        rows.map((row) => row.fingerprint),
        previous.held.map((held) => held.fingerprint),
        'live'
      )
    );
    const heldIndexByLive = new Map(pairs.map(([heldIndex, liveIndex]) => [liveIndex, heldIndex]));
    const keptHeld = new Set(heldIndexByLive.values());
    const added = rows.flatMap((row, index) => (heldIndexByLive.has(index) ? [] : [deltaRow(row.row)]));
    const removed = previous.held.flatMap((held, index) => (keptHeld.has(index) ? [] : [held.ref]));
    const delta: ElementRow = {
      unchanged: pairRuns(
        pairs.map(([heldIndex, liveIndex]) => ({ held: previous.held[heldIndex].ref, live: rows[liveIndex].ref }))
      ),
      ...(added.length ? { added } : {}),
      ...(removed.length ? { removed } : {}),
    };
    if (JSON.stringify(delta).length < JSON.stringify(input.elements).length) {
      // The model applies this reply to its list, so it now holds exactly the
      // live refs published here: the next delta addresses these, not older ones.
      remember(
        rows.map((row) => ({ ref: row.ref, fingerprint: row.fingerprint })),
        previous.consecutiveDeltas + 1
      );
      return delta;
    }
  }
  remember(
    rows.map((row) => ({ ref: row.ref, fingerprint: row.fingerprint })),
    0
  );
  return undefined;
}
