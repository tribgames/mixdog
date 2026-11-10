// ingest/ingest-occurrences.mjs
// Which messages one ingest_session call stores and under which identity: the
// cached identity fields per message object, and the occurrence ordinal that
// makes a full/subset re-ingest reproduce the same source_ref while a genuine
// untimestamped repeat lands on a FREE ordinal above every persisted copy.
import {
  normalizeIngestRole,
  stableSessionSourceRef,
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
} from '../session-ingest.mjs';
import { cleanMemoryText } from '../memory.mjs';
import { createPriorSnapshotMatcher, identityHash } from './ordinal-state.mjs';

/** { role, content, rawContent } for dedup identity and storage, or null if the
 *  message would be skipped by ingest (no role / excluded / empty content after
 *  cleaning). Cached per message OBJECT (WeakMap — entries vanish once the
 *  message is GC'd) so repeated calls over the same transcript prefix never
 *  re-run the expensive clean/normalize regex pipeline. */
export function createIdentityFieldsCache() {
  const cache = new WeakMap();
  return (m) => {
    if (cache.has(m)) return cache.get(m);
    let fields = null;
    const role = normalizeIngestRole(m.role);
    if (role && !shouldExcludeIngestMessage(m)) {
      const rawContent = sessionMessageContentForIngest(m);
      if (rawContent?.trim()) {
        // Preserve existing replay identities without persisting their lossy
        // search projection. Previously skipped code/URL-only rows get their
        // full content as identity; there is no legacy row to collide with.
        const content = cleanMemoryText(rawContent) || rawContent;
        fields = { role, content, rawContent };
      }
    }
    cache.set(m, fields);
    return fields;
  };
}

const isUntimestamped = (m) => {
  const rawTs = m.ts ?? m.timestamp;
  return !((typeof rawTs === 'number' && Number.isFinite(rawTs)) || (typeof rawTs === 'string' && rawTs.trim()));
};

/**
 * Walks the WHOLE array (the prefix [0,start) is replayed so a SUBSET
 * re-ingest reproduces the refs a full re-ingest would) and returns the rows
 * at or past `start` with their occurrence ordinals. A re-presented object
 * reuses its recorded ordinal; a row matched in the previous ordered snapshot
 * reuses that occurrence; a first-seen row takes the next free ordinal — lifted
 * to the durable high-water only in a WARM call (one whose ordinal state was
 * already established by an earlier ingest; in the establishing cold call every
 * message is positional-replayed, so the floor must NOT apply).
 */
export function assignMessageOccurrences({ sessionId, messages, start, ordinalState, ordinals, identityFields }) {
  const occNext = ordinalState.occNext;
  const warmCall = ordinalState.seeded;
  const takePrior = createPriorSnapshotMatcher(ordinalState.snapshot);
  const currentSnapshot = [];
  const prepared = [];
  let considered = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const fields = identityFields(m);
    if (!fields) continue;
    const { role, content, rawContent } = fields;
    const occKey = `${role}\u0000${content}`;
    const untimestamped = isUntimestamped(m);
    const idHash = untimestamped ? identityHash(occKey) : null;
    // occurrence=0 makes a stable match key: timestamp/tool ids remain part
    // of the key, while repeated untimestamped text shares a key and is
    // disambiguated by ordered snapshot occurrences.
    const snapshotKey = stableSessionSourceRef(sessionId, m, role, content, 0);
    let occurrence;
    if (ordinals.hasOrdinal(m)) {
      occurrence = ordinals.assignOccurrence(occNext, occKey, m);
      takePrior(snapshotKey, occurrence);
    } else {
      const prior = takePrior(snapshotKey);
      if (prior) {
        occurrence = ordinals.reuseOccurrence(occNext, occKey, m, prior.occurrence);
      } else {
        const floor = warmCall && untimestamped ? (ordinalState.durable.get(idHash) ?? 0) : 0;
        occurrence = ordinals.assignOccurrence(occNext, occKey, m, floor);
      }
    }
    if (untimestamped && occurrence >= 1) {
      // Duplicate untimestamped identity (occurrence>0): record/raise its durable
      // next-ordinal (write-behind persisted after the insert loop). Monotonic —
      // never regresses a loaded K, so a cold replay counting only survivors
      // can't shrink it.
      const cur = ordinalState.durable.get(idHash) ?? 0;
      if (occurrence + 1 > cur) {
        ordinalState.durable.set(idHash, occurrence + 1);
        ordinalState.dirty = true;
      }
    }
    currentSnapshot.push({ key: snapshotKey, occurrence });
    if (i >= start) {
      considered += 1;
      prepared.push({ m, role, content, rawContent, occurrence, index: i, untimestamped });
    }
  }
  ordinalState.snapshot = currentSnapshot;
  ordinalState.seeded = true;
  return { prepared, considered };
}
