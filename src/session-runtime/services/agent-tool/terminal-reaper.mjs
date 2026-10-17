// Terminal-session bookkeeping for the agent tag registry: tag tombstones, the
// scan admission guard they impose and stale worker-row transitions. Terminal
// sessions are never closed on a timer — the session record stays open so the
// transcript remains visible from the parent task. Each concern lives under
// ./terminal-reaper/; this file wires them.
import { createTagTombstones } from './terminal-reaper/tombstones.mjs';
import { createScanAdmission } from './terminal-reaper/scan-admission.mjs';
import { createStaleRowTransition } from './terminal-reaper/stale-rows.mjs';

export function createTerminalReaper({ cfgMod, mgr, tagMaps, index, getLiveSession }) {
  const tombstones = createTagTombstones({ tagMaps, index });
  const scan = createScanAdmission({
    mgr,
    index,
    tombstoneBlocksScan: tombstones.tombstoneBlocksScan,
  });
  const { transitionStaleNonterminalRows } = createStaleRowTransition({ cfgMod, tagMaps, index, getLiveSession });

  return {
    tagTombstoneIndex: tombstones.tagTombstoneIndex,
    tombstoneBlocksScan: tombstones.tombstoneBlocksScan,
    scanUpsertSession: scan.scanUpsertSession,
    forgetTerminalSession: tombstones.forgetTerminalSession,
    tombstoneTerminalSession: tombstones.tombstoneTerminalSession,
    tagTombstoneForTag: tombstones.tagTombstoneForTag,
    consumeTagTombstone: tombstones.consumeTagTombstone,
    transitionStaleNonterminalRows,
  };
}
