// Revision clock and revision steps: identity-cached wire snapshots, the
// per-entry advance that yields a delta against the previously published
// snapshot, and the bodies served to broadcast views and to a caller that
// announced the revision it holds.
import { diffSessionState } from '../../session-state-patch.mjs';
import { projectSessionState } from '../../session-state-projection.mjs';
import { windowTranscriptSnapshot } from './transcript-window.mjs';

function snapshotOf(entry) {
  const raw = entry.runtime.getState?.() ?? null;
  // Store states are immutable snapshots (every mutation makes a new object),
  // so identity is a sound cache key. Without this the whole transcript was
  // re-sanitized on every call AND every published frame.
  if (raw && entry.snapshotSource === raw) return entry.snapshotCache;
  // Runtime-worker IPC has already produced a wire-safe graph. Reusing it
  // removes the daemon's second full transcript clone; in-process runtimes
  // keep the sanitizer boundary below.
  const cloned = entry.runtime?.isWireSafe === true ? raw : projectSessionState(entry, raw);
  entry.snapshotSource = raw;
  entry.snapshotCache = cloned;
  return cloned;
}

/** Broadcast body: every attached view is, by construction, at the previous
 *  revision — one that is not resyncs itself off the revision gap. A view
 *  that announced `transcriptPrepend` receives an older-history page as the
 *  revealed rows only (`prependPatch`). */
export function frameBody(step, prepend = false) {
  const patch = prepend && step.prependPatch ? step.prependPatch : step.patch;
  return patch
    ? { revision: step.revision, baseRevision: step.previousRevision, patch }
    : { revision: step.revision, full: step.snapshot };
}

/** Response body for the CALLER, which announced the revision it holds. */
export function bodyForClient(step, baseRevision, prepend = false) {
  if (!step.changed && baseRevision === step.revision) return { revision: step.revision };
  if (step.patch && baseRevision === step.previousRevision) return frameBody(step, prepend);
  return { revision: step.revision, full: step.snapshot };
}

/** The same delta with rows revealed above the previous list sent as
 *  `itemsPrepend`, or null when the list did not grow at its head. */
function headGrowthPatch(previous, snapshot) {
  const before = previous?.items;
  const after = snapshot?.items;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0 || after[0] === before[0]) return null;
  const patch = diffSessionState(previous, snapshot, { prepend: true });
  return patch?.itemsPrepend ? patch : null;
}

export function createRevisionSteps({ revisionEpoch, index, updateEntryBusy }) {
  // One clock owns every snapshot served by this daemon, including stored
  // views and replacement runtimes. Per-entry counters restarted after idle
  // eviction, so clients retaining the old baseline discarded new turns.
  let revision = revisionEpoch;
  const nextRevision = () => ++revision;

  /** A revision this daemon issued: the caller holds a baseline it can keep. */
  const issuedRevision = (baseRevision) =>
    Number.isSafeInteger(baseRevision) && baseRevision > revisionEpoch && baseRevision <= revision;

  /** The bodiless answer for a caller whose stored projection is known to be
   *  current, or null when its baseline is not one this daemon issued. */
  function unchangedProjectionResult(sessionId, projectionStamp, baseRevision) {
    if (!projectionStamp || !issuedRevision(baseRevision)) return null;
    return { sessionId, reservedOnly: false, projection: true, revision: baseRevision, projectionStamp, unchanged: true };
  }

  function projectionResult(
    sessionId,
    projection,
    { baseRevision = null, baseProjectionStamp = null, allowUnchanged = false } = {}
  ) {
    const stamp = typeof projection?.projectionStamp === 'string' ? projection.projectionStamp : '';
    // A stamp alone identifies content, not the caller's wire baseline.
    // Preserve a known baseline; otherwise return a full, freshly ordered body.
    const unchanged = allowUnchanged && stamp && stamp === baseProjectionStamp && issuedRevision(baseRevision);
    return {
      sessionId,
      reservedOnly: false,
      projection: true,
      revision: unchanged ? baseRevision : nextRevision(),
      ...(stamp ? { projectionStamp: stamp } : {}),
      ...(unchanged ? { unchanged: true } : { full: projection }),
    };
  }

  /** Advance the session runtime's published revision one step. */
  function advance(entry) {
    // Deltas are computed against the WINDOWED snapshot, so a tail-only
    // baseline keeps receiving ordinary suffix patches.
    const snapshot = windowTranscriptSnapshot(entry, snapshotOf(entry));
    const projectedSessionId = String(snapshot?.sessionId || '');
    const addressedSessionId = String(entry.addressedSessionId || '');
    if (addressedSessionId && projectedSessionId && projectedSessionId !== addressedSessionId) {
      throw new Error(`session ${addressedSessionId} changed its durable address to ${projectedSessionId}`);
    }
    if (!addressedSessionId && projectedSessionId) {
      entry.addressedSessionId = projectedSessionId;
    }
    index.indexSessionEntry(entry, projectedSessionId);
    updateEntryBusy(entry, snapshot);
    const previous = entry.publishedSnapshot;
    const previousRevision = entry.revision || 0;
    if (snapshot === previous) {
      return { changed: false, snapshot, revision: previousRevision, previousRevision, patch: null, prependPatch: null };
    }
    entry.publishedSnapshot = snapshot;
    entry.revision = nextRevision();
    return {
      changed: true,
      snapshot,
      revision: entry.revision,
      previousRevision,
      patch: previous ? diffSessionState(previous, snapshot) : null,
      prependPatch: previous ? headGrowthPatch(previous, snapshot) : null,
    };
  }

  return { advance, projectionResult, unchangedProjectionResult };
}
