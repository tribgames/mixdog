// Tag registry: owns the tag maps (tag -> sessionId/agent/cwd) and every
// resolution/mutation path — resolve/next/bind/forget and the session-index
// refresh. Worker-index persistence lives in worker-index.mjs and terminal
// tombstones/reap timers in terminal-reaper.mjs; the tag maps are shared by
// reference so all three sides see the same live state.
import { agentTagOf } from './helpers.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';
import { createWorkerIndex } from './worker-index.mjs';
import { createTagMaps } from './tag-maps.mjs';
import { createTerminalReaper } from './terminal-reaper.mjs';
import { createTagLookup } from './tag-registry/tag-lookup.mjs';
import { createTagRefresh } from './tag-registry/tag-refresh.mjs';

export function createTagRegistry({ dataDir, cfgMod, mgr }) {
  const tagMaps = createTagMaps();
  const { tags } = tagMaps;
  const index = createWorkerIndex({
    dataDir,
    cfgMod,
    mgr,
    tags,
    tagAgents: tagMaps.tagAgents,
    tagCwds: tagMaps.tagCwds,
  });
  const { readWorkerRows, upsertWorkerSessionDeferred, removeWorkerRow, refreshTagsFromIndex } = index;
  const { upsertLeadSession } = createLeadWorkerIndex({
    dataDir,
    cfgMod,
    workerRowFromSession: index.workerRowFromSession,
  });

  function getLiveSession(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    return session && session.closed !== true ? session : null;
  }

  function tagForSession(sessionId) {
    const session = getLiveSession(sessionId);
    const persistedTag = agentTagOf(session);
    if (persistedTag) return persistedTag;
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  const reaper = createTerminalReaper({ cfgMod, mgr, tagMaps, index, getLiveSession, tagForSession });

  function wantsSessionScan(args = {}) {
    return args.recover === true || args.scanSessions === true || args.scan_sessions === true;
  }

  const refreshTagsFromSessions = createTagRefresh({
    tags,
    tagMaps,
    mgr,
    reaper,
    refreshTagsFromIndex,
    getLiveSession,
  });
  const { resolveTag, agentSessionEntries, nextTag } = createTagLookup({
    tags,
    mgr,
    readWorkerRows,
    reaper,
    getLiveSession,
    refreshTagsFromSessions,
  });

  function bindTag(tag, session, extra = {}) {
    if (!tag || !session?.id) return;
    tagMaps.bind(tag, session);
    upsertWorkerSessionDeferred(session, tag, extra);
  }

  function forgetTag(tag) {
    if (!tag) return;
    const sessionId = tags.get(tag) || '';
    tagMaps.unbind(tag);
    removeWorkerRow({ tag, sessionId });
  }

  reaper.recoverTerminalReaps();

  return {
    readAllTagTombstones: index.readAllTagTombstones,
    readTagTombstones: index.readTagTombstones,
    readWorkerRows,
    writeWorkerRows: index.writeWorkerRows,
    flushWorkerIndexMutations: index.flushWorkerIndexMutations,
    upsertWorkerSession: index.upsertWorkerSession,
    upsertWorkerSessionDeferred,
    upsertLeadSession,
    removeWorkerRow,
    refreshTagsFromIndex,
    tags,
    tagAgents: tagMaps.tagAgents,
    tagCwds: tagMaps.tagCwds,
    reapTimers: reaper.reapTimers,
    wantsSessionScan,
    resolveTag,
    getLiveSession,
    tagForSession,
    agentSessionEntries,
    nextTag,
    refreshTagsFromSessions,
    bindTag,
    forgetTag,
    forgetTerminalSession: reaper.forgetTerminalSession,
    tombstoneTerminalSession: reaper.tombstoneTerminalSession,
    tagTombstoneForTag: reaper.tagTombstoneForTag,
    consumeTagTombstone: reaper.consumeTagTombstone,
    cancelReap: reaper.cancelReap,
    clearScheduledReaps: reaper.clearScheduledReaps,
    scheduleReap: reaper.scheduleReap,
    recoverTerminalReaps: reaper.recoverTerminalReaps,
    transitionStaleNonterminalRows: reaper.transitionStaleNonterminalRows,
  };
}
