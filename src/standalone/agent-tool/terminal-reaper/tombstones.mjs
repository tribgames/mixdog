// Tag tombstones: the record a reap leaves behind so a later session scan
// cannot re-bind the reaped tag, plus the lookups spawn/send use to consume
// one when the tag is legitimately reused.
import { clean, positiveInt } from '../helpers.mjs';
import { tagTombstoneKey } from '../worker-rows.mjs';
import { insertTombstone, isTerminalRow } from './row-helpers.mjs';
import { findTagTombstone, tombstoneBlocksWork } from '../../../runtime/shared/agent-reap-state.mjs';

export function createTagTombstones({ tagMaps, index }) {
  const { readAllTagTombstones, readTagTombstones, writeWorkerRows, flushWorkerIndexMutations, removeWorkerRow } =
    index;

  function tagTombstoneIndex() {
    const byKey = new Map();
    for (const row of readAllTagTombstones()) byKey.set(tagTombstoneKey(row), row);
    return byKey;
  }

  // Without this guard a session scan re-binds a reaped tag and re-stamps the
  // row, handing the reaped worker a brand-new full reap lease on every list
  // read — the agent list could then never clear.
  function tombstoneBlocksScan(session, tag, tombstones) {
    const value = clean(tag);
    const sessionId = clean(session?.id);
    if (!value || !sessionId) return false;
    const tombstone = findTagTombstone({ ...session, tag: value }, tombstones);
    if (!tombstoneBlocksWork(session, tombstone)) return false;
    // A cached binding alone may have come from an old scan. Only a worker
    // row admitted by the same reap rule can prove a subsequent real turn.
    return !index.readWorkerRows().some((row) => row.sessionId === sessionId && row.tag === value);
  }

  function forgetTerminalSession(tag, sessionId) {
    const id = clean(sessionId);
    tagMaps.unbindIfOwned(clean(tag), id);
    if (id) removeWorkerRow({ sessionId: id });
  }

  function tombstoneTerminalSession(tag, sessionId, session = null, expectedReapAt = '') {
    const value = clean(tag);
    const id = clean(sessionId);
    if (!value || !id) {
      if (!expectedReapAt) forgetTerminalSession(value, id);
      return false;
    }
    let applied = false;
    flushWorkerIndexMutations();
    writeWorkerRows((byKey, tombstonesByKey, priorityTombstoneKeys) => {
      const matches = [...byKey.entries()].filter(([, row]) => clean(row.sessionId) === id);
      const expected = expectedReapAt
        ? matches.find(([, row]) => clean(row.reapAt) === expectedReapAt && isTerminalRow(row))
        : null;
      // A stale timer from an earlier turn must never reap newer work.
      if (expectedReapAt && !expected) return;
      const source = expected?.[1] || matches[0]?.[1] || {};
      for (const [key] of matches) {
        byKey.delete(key);
      }
      insertTombstone(tombstonesByKey, priorityTombstoneKeys, {
        tag: value,
        agent: clean(session?.agent || source.agent) || null,
        cwd: clean(session?.cwd || source.cwd) || null,
        clientHostPid: positiveInt(session?.clientHostPid || source.clientHostPid),
        sessionId: id,
        parentSessionId: clean(session?.parentSessionId || source.parentSessionId) || null,
        ownerSessionId: clean(session?.ownerSessionId || source.ownerSessionId) || null,
        reapedAt: new Date().toISOString(),
      });
      applied = true;
    });
    if (!applied) return false;
    tagMaps.unbindIfOwned(value, id);
    return true;
  }

  function tagTombstoneForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return null;
    return readTagTombstones(context).find((row) => row.tag === value) || null;
  }

  function consumeTagTombstone(tombstone) {
    if (!tombstone?.tag) return false;
    const key = tagTombstoneKey(tombstone);
    flushWorkerIndexMutations();
    writeWorkerRows((_byKey, tombstonesByKey) => {
      tombstonesByKey.delete(key);
      const legacyKey = tagTombstoneKey({ tag: tombstone.tag, clientHostPid: tombstone.clientHostPid });
      const legacy = tombstonesByKey.get(legacyKey);
      // A recovered legacy record is consumed only if it has not been
      // replaced since ownership was established.
      if (
        legacyKey !== key &&
        legacy &&
        !clean(legacy.parentSessionId || legacy.ownerSessionId) &&
        legacy.reapedAt === tombstone.reapedAt &&
        (!legacy.sessionId || legacy.sessionId === tombstone.sessionId)
      ) {
        tombstonesByKey.delete(legacyKey);
      }
    });
    return true;
  }

  return {
    tagTombstoneIndex,
    tombstoneBlocksScan,
    forgetTerminalSession,
    tombstoneTerminalSession,
    tagTombstoneForTag,
    consumeTagTombstone,
  };
}
