// Terminal-session reaping for the agent tag registry: tag tombstones, the
// scan admission guard they impose, the delayed reap timers and their
// recovery after a restart. Reaping expires only the tag/runtime lease — the
// session record stays open so the transcript remains visible from the parent
// task. Each concern lives under ./terminal-reaper/; this file wires them.
import { createTagTombstones } from './terminal-reaper/tombstones.mjs';
import { createReapTimers } from './terminal-reaper/reap-timers.mjs';
import { createScanAdmission } from './terminal-reaper/scan-admission.mjs';
import { createStaleRowTransition } from './terminal-reaper/stale-rows.mjs';

export function createTerminalReaper({ cfgMod, mgr, tagMaps, index, getLiveSession, tagForSession }) {
  const tombstones = createTagTombstones({ tagMaps, index });
  const timers = createReapTimers({
    cfgMod,
    mgr,
    index,
    getLiveSession,
    tagForSession,
    tombstoneTerminalSession: tombstones.tombstoneTerminalSession,
  });
  const scan = createScanAdmission({
    cfgMod,
    mgr,
    index,
    tombstoneBlocksScan: tombstones.tombstoneBlocksScan,
    timers,
  });
  const { transitionStaleNonterminalRows } = createStaleRowTransition({ cfgMod, tagMaps, index, getLiveSession });

  return {
    reapTimers: timers.reapTimers,
    tagTombstoneIndex: tombstones.tagTombstoneIndex,
    tombstoneBlocksScan: tombstones.tombstoneBlocksScan,
    scanUpsertSession: scan.scanUpsertSession,
    settleScannedTerminalRows: scan.settleScannedTerminalRows,
    forgetTerminalSession: tombstones.forgetTerminalSession,
    tombstoneTerminalSession: tombstones.tombstoneTerminalSession,
    tagTombstoneForTag: tombstones.tagTombstoneForTag,
    consumeTagTombstone: tombstones.consumeTagTombstone,
    clearScheduledReaps: timers.clearScheduledReaps,
    cancelReap: timers.cancelReap,
    scheduleReap: timers.scheduleReap,
    recoverTerminalReaps: timers.recoverTerminalReaps,
    transitionStaleNonterminalRows,
  };
}
