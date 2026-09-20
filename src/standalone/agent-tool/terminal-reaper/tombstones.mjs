// Tag tombstones: the record a reap leaves behind so a later session scan
// cannot re-bind the reaped tag, plus the lookups spawn/send use to consume
// one when the tag is legitimately reused.
import { clean, positiveInt, stampMs } from '../helpers.mjs';
import { tagTombstoneKey } from '../worker-rows.mjs';
import { insertTombstone, isTerminalRow, sessionActivityAt } from './row-helpers.mjs';

export function createTagTombstones({ tagMaps, index }) {
  const { tags } = tagMaps;
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
    // A tag that currently maps to this session was re-bound by a real
    // lifecycle write (spawn/send/index row); the tombstone is spent.
    if (tags.get(value) === sessionId) return false;
    const tombstone = tombstones.get(tagTombstoneKey({ tag: value, clientHostPid: session?.clientHostPid }));
    const reapedAt = stampMs(tombstone?.reapedAt);
    if (!reapedAt) return false;
    // Activity after the reap means the session legitimately came back; only a
    // session that has been idle since its own reap stays suppressed.
    return reapedAt >= sessionActivityAt(session);
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
    writeWorkerRows((_byKey, tombstonesByKey) => tombstonesByKey.delete(key));
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
