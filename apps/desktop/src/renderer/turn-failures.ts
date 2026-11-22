import type { TranscriptItem } from './desktop-types';
import { CarriedFacts, noteCarried, sharedPrefix } from './list-carry';
import { transcriptTurnKeys, turnKeysTakenOver } from './renderer-logic.mjs';

/** What a transcript says of its turns: each item's turn, and the turns that failed (in transcript order). */
export interface TurnFailures {
  turnKeys: string[];
  failedTurnKeys: string[];
  /** The characters the keys hold. */
  chars: number;
}

interface TurnOutcome {
  /** The turn's first item. */
  first: number;
  explicitFailure: boolean;
  terminalStatus: string;
}

interface Carry {
  items: WeakRef<readonly unknown[]>;
  outcomes: CarriedFacts<string, TurnOutcome>;
  failed: Set<string>;
}

/** What the fold of a list's items left, by the result made from it: the next list carries it on. */
const carries = new WeakMap<TurnFailures, Carry>();

function explicitTranscriptFailure(item: TranscriptItem | undefined): boolean {
  const kind = String(item?.kind || '').toLowerCase();
  const status = String(item?.status || '').toLowerCase();
  const tone = String(item?.tone || '').toLowerCase();
  return kind === 'error' || status === 'error' || status === 'failed' || tone === 'error';
}

const failedOutcome = (outcome: TurnOutcome | undefined): boolean =>
  outcome !== undefined &&
  (outcome.terminalStatus === 'failed' || (!outcome.terminalStatus && outcome.explicitFailure));

const charsOf = (keys: readonly string[], from = 0): number => {
  let sum = 0;
  for (let index = from; index < keys.length; index += 1) sum += keys[index]?.length ?? 0;
  return sum;
};

/** The turns of `items` and the failed ones among them. `previous` is the result for the list held before: the turns that
 *  closed before the first item that changed are taken over, and only the items from there on are read. `kept` is how many
 *  leading items the caller knows to be that list's own, in place (found by comparison when it does not say). */
export function turnFailuresOf(
  previous: TurnFailures | undefined,
  items: readonly TranscriptItem[] | undefined,
  kept?: number
): TurnFailures {
  const transcript = Array.isArray(items) ? items : [];
  const held = previous ? carries.get(previous) : undefined;
  const prior = held?.items.deref();
  if (previous && prior === transcript) return previous;
  const keptItems = previous && prior ? Math.min(kept ?? sharedPrefix(transcript, prior), transcript.length) : 0;
  const turnKeys = (
    previous && prior
      ? transcriptTurnKeys(transcript, { keys: previous.turnKeys, kept: keptItems })
      : transcriptTurnKeys(transcript)
  ) as string[];
  // A turn's end renames the items it holds: they are folded again under the new key.
  const sameKeys =
    previous && prior ? sharedPrefix(turnKeys, previous.turnKeys, turnKeysTakenOver(turnKeys)) : 0;
  const from = Math.min(keptItems, sameKeys);
  // What a pane reads of the keys is carried on from the keys left in place.
  if (previous && prior) noteCarried(turnKeys, previous.turnKeys, sameKeys);
  const outcomes = held && prior ? held.outcomes : new CarriedFacts<string, TurnOutcome>();
  const failed = held && prior ? held.failed : new Set<string>();
  if (previous) carries.delete(previous);
  const touched = new Set<string>();
  outcomes.rewind(from, (key) => touched.add(key));
  for (let index = from; index < transcript.length; index += 1) {
    const item = transcript[index];
    const turnKey = turnKeys[index];
    if (!turnKey) continue;
    const before = outcomes.get(turnKey);
    let explicitFailure = before?.explicitFailure ?? false;
    let terminalStatus = before?.terminalStatus ?? '';
    if (item?.kind === 'turndone') {
      terminalStatus = String(item.status || '').toLowerCase();
      if (!terminalStatus && explicitTranscriptFailure(item)) explicitFailure = true;
    } else if (explicitTranscriptFailure(item)) {
      explicitFailure = true;
    }
    if (before && before.explicitFailure === explicitFailure && before.terminalStatus === terminalStatus) continue;
    outcomes.set(index, turnKey, { first: before?.first ?? index, explicitFailure, terminalStatus });
    touched.add(turnKey);
  }
  // A failed turn among the ones read again may hold another place among the failed ones, as well as join or leave them.
  let reorder = !previous || !prior;
  for (const turnKey of touched) {
    const now = failedOutcome(outcomes.get(turnKey));
    if (now) failed.add(turnKey);
    else if (!failed.delete(turnKey)) continue;
    reorder = true;
  }
  let failedTurnKeys = previous?.failedTurnKeys ?? [];
  if (reorder) {
    const ordered = [...failed].sort(
      (left, right) => (outcomes.get(left)?.first ?? 0) - (outcomes.get(right)?.first ?? 0)
    );
    // The same turns in the same order are the list held: its readers see no change.
    const same = ordered.length === failedTurnKeys.length && ordered.every((key, at) => key === failedTurnKeys[at]);
    if (!same || !previous) failedTurnKeys = ordered;
  }
  const shared = previous && prior ? turnKeysTakenOver(turnKeys) : 0;
  const result: TurnFailures = {
    turnKeys,
    failedTurnKeys,
    chars:
      (previous && prior ? previous.chars - charsOf(previous.failedTurnKeys) - charsOf(previous.turnKeys, shared) : 0) +
      charsOf(turnKeys, shared) +
      charsOf(failedTurnKeys),
  };
  carries.set(result, { items: new WeakRef(transcript), outcomes, failed });
  return result;
}
