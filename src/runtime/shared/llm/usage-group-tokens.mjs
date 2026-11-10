// The invalidation token of each group of sessions the Agents pool lists (a
// Lead and the agents under it), kept for the pool rows to carry. A token
// changes when a number the usage ledger would give for the group can have
// changed (readUsageToken) and not when anyone else's records land, so a
// reader holding a ledger read re-reads on it and on nothing else.
//
// The pool is listed far more often than the ledger changes, and a listing
// must not wait on the ledger worker (which may be building the session sums
// or serving a read): it takes the tokens known now and, when the ledger has
// committed since the tokens were asked for (or the groups changed), asks for
// them again in the background and wakes the pool once they differ.
import { emitSessionActivityChange } from '../session-activity-signal.mjs';
import { usageLedgerIfOpen } from './usage-ledger.mjs';

const known = new Map();
let wanted = new Set();
let asked = { stamp: null, groups: '' };
let inFlight = null;
let queued = null;

function refresh(ledger, groups) {
  if (inFlight) {
    queued = { ledger, groups };
    return;
  }
  const owners = [...groups.keys()];
  inFlight = ledger
    .usageTokensAsync(owners.map((owner) => ({ owner, ids: [...groups.get(owner)] })))
    .then((tokens) => {
      // Only the groups wanted now: a group dropped while this was in flight stays dropped.
      let changed = false;
      for (const owner of [...known.keys()]) {
        if (!wanted.has(owner)) {
          known.delete(owner);
          changed = true;
        }
      }
      owners.forEach((owner, index) => {
        if (!wanted.has(owner)) return;
        if (known.get(owner) !== tokens[index]) changed = true;
        known.set(owner, tokens[index]);
      });
      if (changed) emitSessionActivityChange();
    })
    .catch(() => {
      // The next listing asks again.
      asked = { stamp: null, groups: '' };
    })
    .finally(() => {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next) refresh(next.ledger, next.groups);
    });
}

/**
 * The tokens known for `groups` (owner session -> the session ids listed under
 * it, owner included), as a Map owner -> token. Never waits; a group whose
 * token is not known yet is absent.
 */
export function groupUsageTokens(groups) {
  wanted = new Set(groups.keys());
  for (const owner of [...known.keys()]) if (!wanted.has(owner)) known.delete(owner);
  if (groups.size === 0) {
    // Nothing is listed: nothing is kept, and a refresh still out has nothing to add.
    queued = null;
    asked = { stamp: null, groups: '' };
    return known;
  }
  const ledger = usageLedgerIfOpen();
  if (!ledger) return known;
  const shape = JSON.stringify([...groups].map(([owner, ids]) => [owner, [...ids].sort()]));
  const stamp = ledger.commitStamp();
  if (stamp !== asked.stamp || shape !== asked.groups) {
    asked = { stamp, groups: shape };
    refresh(ledger, groups);
  }
  return known;
}

/** Test seam: forget everything known. */
export function resetGroupUsageTokens() {
  known.clear();
  wanted = new Set();
  asked = { stamp: null, groups: '' };
  queued = null;
}
