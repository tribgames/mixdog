/**
 * Write admission for the session store: the ownership/freshness verdict a
 * save attempt must pass, and the pre-admission authority the async/worker
 * path consults before publishing ANY owned state. Both are pure disk reads
 * that decide whether bytes may be committed — no queueing, no commit, no
 * markers — which is why they stay out of the write pipeline itself.
 */
import { sessionPath } from './paths-heartbeat.mjs';
import {
  readCanonicalSessionRecord as _readCanonicalRecord,
  CANONICAL_RECORD_UNREADABLE as LIFECYCLE_AMBIGUOUS,
  statSessionStamp as _statSessionStamp,
  sameSessionStamp as _sameSessionStamp,
} from './canonical-reader.mjs';

const _observeStamp = (target) => {
  try {
    return _statSessionStamp(target);
  } catch {
    return null;
  }
};

/**
 * The write-authority record for `target`: own-commit stamp or strict read,
 * never the settled-stamp cache. `attempt` (optional) is the scratch state of
 * ONE save operation: a later check of that same save reuses the verdict an
 * earlier check read strictly only while the file's FULL stamp is identical
 * to the one observed unchanged around that read — stat first, and any
 * difference (another writer's rename, an in-place rewrite, deletion) reads
 * strictly again. Nothing outlives the save that created it.
 */
function _writeAuthorityRecord(target, attempt) {
  if (attempt?.stamp) {
    const current = _observeStamp(target);
    if (current && _sameSessionStamp(current, attempt.stamp)) return attempt.record;
    attempt.stamp = null;
    attempt.record = undefined;
  }
  const before = attempt ? _observeStamp(target) : null;
  const record = _readCanonicalRecord(target, true, { ownCommitsOnly: true });
  if (attempt && before && record && record !== LIFECYCLE_AMBIGUOUS) {
    const after = _observeStamp(target);
    if (after && _sameSessionStamp(before, after)) {
      attempt.stamp = before;
      attempt.record = record;
    }
  }
  return record;
}
import { isCancelledWrite as _isCancelledWrite } from './write-guards.mjs';
import { _setSessionWriteAuthorityCheck } from './save-worker.mjs';

/**
 * Write admission for ONE save attempt. Consulted upfront, after the scratch
 * write and again while the commit lock is held, so the final verdict is
 * taken under the lock, immediately before the rename.
 *
 * OWNERSHIP FIRST, freshness second. Every save — guarded or not — must find
 * OUR record (or nothing) at the canonical path:
 *   absent                        → this write creates the file;
 *   ambiguous/unreadable          → refuse (never "open at generation 0");
 *   foreign / identity-less id    → refuse, with or without a generation
 *                                   guard: an ordinary appendMessage save
 *                                   must not rename over another session's
 *                                   record just because it carries no
 *                                   expectedGeneration;
 *   ours                          → apply the generation rules below.
 * NOTHING is exempt. The old `allowClosed` opt-out is gone: it existed for a
 * tombstone plant that has not gone through this path in a long time (the
 * barriers write the canonical file themselves), and any surviving caller of
 * it would have been able to skip the absent-vs-owned-vs-ambiguous check
 * entirely — the exact hole this guard exists to close.
 */
export function _shouldDrop(id, opts, attempt = null) {
  if (_isCancelledWrite(opts)) return true;
  const expected = typeof opts?.expectedGeneration === 'number' ? opts.expectedGeneration : null;
  const target = sessionPath(id);
  let record;
  try {
    // Own-commit stamp or strict read — never the settled-stamp cache: this
    // is the final drop verdict (see the note below). Within one save
    // (`attempt`) only a stamp-identical file reuses that save's own verdict.
    record = _writeAuthorityRecord(target, attempt);
  } catch {
    // The guard could not establish WHAT is on disk. Refusing the write is
    // the only safe verdict: the alternative renames over a record whose
    // ownership/tombstone state is unknown.
    return true;
  }
  // Ambiguous/corrupt record (duplicate top-level lifecycle keys, malformed
  // JSON, unreadable file that nonetheless exists). It must NEVER be read as
  // "open at generation 0" — that is precisely the fail-open that lets a
  // late save resurrect a session over an ambiguous tombstone. Drop.
  if (record === LIFECYCLE_AMBIGUOUS) return true;
  if (!record) return false; // no file on disk → this save creates it
  // Durable identity is mandatory, exactly as for every other authority
  // read: a record naming another session (or naming none at all) is not
  // ours to overwrite.
  if (record.id !== id) return true;
  if (expected === null) return false; // unguarded save over our own record
  const generation = typeof record.generation === 'number' ? record.generation : 0;
  // Closed with a generation at least as new as ours: our write is stale.
  if (record.closed === true) return generation >= expected;
  // Not closed, but `generation` also doubles as an ownership counter:
  // normal in-place saves (updateSession/appendMessage/etc.) never bump
  // it, only closeSession()-family calls do (markSessionClosed and its
  // non-tombstoning sibling bumpSessionGeneration). So if disk
  // generation is strictly greater than what this write expected,
  // ownership moved on (session was detached-closed and possibly
  // resumed) after our turn started — drop the stale write rather than
  // let it clobber whatever happened after the handoff.
  return generation > expected;
}

// ── Lifecycle read for the ownership guard ───────────────────────────────────
// _shouldDrop consults this up to three times per save (upfront, post-temp
// write, in-commit). mtimeMs + size alone would NOT move for a same-size
// rewrite inside one clock tick — a generation bump such as 1 → 2 — so no
// memo keys on them. The only reuse is this realm's OWN last rename, stamped
// { dev, ino, size, mtimeNs, ctimeNs } right after the commit and verified to
// be our inode: every writer replaces the file by rename (new inode, new
// ctime), so any foreign replacement misses the stamp and is re-read and
// strictly parsed exactly as before.
//
// Three distinct outcomes, never collapsed: `null` = no file (write freely),
// LIFECYCLE_AMBIGUOUS = a file exists but its bytes cannot be trusted (refuse
// the write), otherwise the strict record itself ({ doc, id, closed,
// generation }) — the single disk authority shared by the save guard and the
// lifecycle barriers.
// Full lifecycle barriers still parse a private document.

// Pre-admission authority for the async/worker path (registered here because
// save-worker.mjs cannot import this module back). A refusal keeps the caller
// from publishing ANY owned state — no live snapshot, no optimistic summary.
// It runs per saveSessionAsync call, so beyond own commits it also reuses a
// verdict strictly read at a settled stamp: coalesced calls against an
// unchanged file cost one stat each, and the final verdict is still taken
// under the lock by _shouldDrop.
export function _sessionWriteAuthorityRefusal(id, attempt = null) {
  if (!id) return null;
  let authority;
  try {
    // A synchronous save passes its `attempt`: its pre-admission is then the
    // first strict write-authority read of that same save (see _shouldDrop).
    authority = attempt ? _writeAuthorityRecord(sessionPath(id), attempt) : _readCanonicalRecord(sessionPath(id), true);
  } catch {
    // A THROWN authority check is never acceptance: fail closed.
    return 'unreadable';
  }
  if (authority === LIFECYCLE_AMBIGUOUS) return 'ambiguous';
  if (authority && authority.id !== id) return 'foreign';
  return null; // absent (creatable) or ours
}

_setSessionWriteAuthorityCheck(_sessionWriteAuthorityRefusal);
