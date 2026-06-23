import { readFileSync, statSync } from 'fs';
import { hashText } from './hash-utils.mjs';
import { statMatchesSnapshot } from './snapshot-helpers.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { getPathMutationGeneration } from './cache-layers.mjs';

// Change detection: a full stat match (size + mtime±1 + ctime±1) is
// proof the file is untouched since the preflight snapshot — accept
// without re-reading the body (fast-path). Only when stat drifts do we
// fall back to the authoritative content-hash compare. Tradeoff
// (accepted policy, parity with write's isSnapshotStale): a size-
// preserving write that ALSO restores mtime AND ctime is not caught —
// vanishingly rare, since ctime is not userland-settable on the usual
// platforms.
export function validatePreparedEditBase(prepared) {
    if (!prepared || !prepared.fullPath) return 'Error [code 7]: edit prewrite check failed — missing prepared file path';
    // In-process CAS, checked before the stat fast-path below. Every committed
    // write bumps the target's mutation generation (bumpPathMutationGeneration,
    // reached via invalidateBuiltinResultCache after each atomic/byte write).
    // If the generation captured at preflight no longer matches, a concurrent
    // in-process edit committed between this edit's snapshot and now. This
    // signal is deterministic and independent of mtime/size granularity — it
    // closes the window where the stat fast-path (size + mtime±1 + ctime±1)
    // false-negatives on a same-size write that lands within the mtime
    // tolerance (e.g. two concurrent cross-file batches racing the same
    // targets), which would otherwise wave drift through. Only enforced when a
    // generation was captured (Number.isFinite) so callers that omit it keep
    // their prior behavior; sequential edits capture and commit without an
    // intervening write, so the generation is stable and never false-positives.
    if (Number.isFinite(prepared.baseMutationGeneration)
        && getPathMutationGeneration(prepared.fullPath) !== prepared.baseMutationGeneration) {
        return `Error [code 7]: file modified between edit preflight and write — read it again before editing: ${prepared.filePath}`;
    }
    let currentStat;
    try { currentStat = statSync(prepared.fullPath); }
    catch (err) {
        return `Error [code 7]: file changed before edit write — read it again before editing: ${prepared.filePath} (${normalizeErrorMessage(err instanceof Error ? err.message : String(err))})`;
    }
    // Fast-path: clean stat match ⇒ untouched, accept without reading.
    // statMatchesSnapshot returns false when baseStatSnapshot is missing
    // or incomplete, so an incomplete snapshot falls through to the
    // fail-closed / content-hash path below (no fail-open).
    if (statMatchesSnapshot(currentStat, prepared.baseStatSnapshot)) return null;
    // Stat drifted (or no stat material) → content hash is authoritative.
    // Without baseContentHash we cannot prove identity, so fail closed.
    if (!prepared.baseContentHash) {
        return `Error [code 7]: file modified between edit preflight and write — read it again before editing: ${prepared.filePath}`;
    }
    let current;
    try { current = readFileSync(prepared.fullPath); }
    catch (err) {
        return `Error [code 7]: file changed before edit write — read it again before editing: ${prepared.filePath} (${normalizeErrorMessage(err instanceof Error ? err.message : String(err))})`;
    }
    if (hashText(current) !== prepared.baseContentHash) {
        return `Error [code 7]: file modified between edit preflight and write — read it again before editing: ${prepared.filePath}`;
    }
    return null;
}
