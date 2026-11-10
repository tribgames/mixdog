import { createTagResume } from './execute-resume.mjs';
import { clean, resolvePrompt } from './helpers.mjs';

// Tag-addressed send, including the dead-tag fallback (resume the saved
// session, else respawn): everything the `send` request type needs once the
// caller's scope is resolved.
//
// Inputs: `registry` (tag maps, worker rows, tombstones, session records),
// `defaultCwd`, `sendFlow`, `spawnFlow`, `spawnResult` (job -> rendered tool
// output) and `tagResume` (shared with spawn). Output: { send }.
const isDeadTarget = (err) => /not found|is closed/i.test(String(err?.message || ''));

export function createSendDispatch({
  registry,
  defaultCwd,
  sendFlow,
  spawnFlow,
  spawnResult,
  tagResume = createTagResume({ registry, sendFlow, defaultCwd }),
}) {
  // A retained row, a reap tombstone, or (once a pruned row's tombstone has
  // expired or been capped out) the tag's own session record proves that this
  // terminal owned the tag. Unknown tags stay errors even when the caller
  // supplies an agent/cwd: typo absorption requires persisted same-tag
  // evidence. Absorption identity is always terminal-local, even when live
  // resolution was explicitly requested across all terminals; a local proof
  // wins even if another terminal also owns this tag.
  function inheritedTagIdentity(fallbackTag, ownershipContext, args, callerCwd) {
    let row = null;
    try {
      row = registry.readWorkerRows(ownershipContext).find((entry) => clean(entry.tag) === fallbackTag) || null;
    } catch {
      row = null;
    }
    const tombstone = registry.tagTombstoneForTag(fallbackTag, ownershipContext);
    const record = row || tombstone ? null : registry.lastTagSession(fallbackTag, ownershipContext);
    if (!row && !tombstone && !record) return null;
    const agent = clean(args.agent) || clean(row?.agent) || clean(tombstone?.agent) || clean(record?.agent);
    const cwd = clean(args.cwd) || clean(row?.cwd) || clean(tombstone?.cwd) || clean(record?.cwd) || clean(callerCwd);
    if (!agent || !cwd) return null;
    return {
      row,
      tombstone,
      sessionId: clean(row?.sessionId),
      resumeSessionId: clean(row?.sessionId) || clean(tombstone?.sessionId) || clean(record?.id),
      agent,
      cwd,
    };
  }

  // Drop this terminal's in-memory trace and remove ONLY the persisted row
  // matching the inherited sessionId. A tag-wide removal would delete peer
  // terminals' same-tag rows; the map unbind is guarded on the tag pointing
  // at OUR sessionId so a peer cache entry is left intact (it rebuilds from
  // rows).
  function consumeInheritedTag(fallbackTag, inherited) {
    registry.forgetTerminalSession(fallbackTag, inherited.sessionId);
    if (inherited.tombstone) registry.consumeTagTombstone(inherited.tombstone);
  }

  // Dead-tag fallback: a same-scope follow-up can land after its tag was
  // reaped, or after its session was closed or deleted. A reaped tag whose
  // saved session is still stored and open continues that session (`resumed`,
  // prior context kept). Otherwise, instead of bouncing an error back to Lead
  // (who would just re-issue the same content as a spawn), respawn a FRESH
  // session under the same tag with the message as its brief; `respawned:
  // true` in the result tells Lead the worker has no prior session context.
  // Only tag-addressed sends fall back; explicit sessionId sends keep erroring
  // (the caller pinned a specific session on purpose).
  async function respawnDeadTagSend(err, args, { scopedContext, callerCwd, context, notifyContext }) {
    const fallbackTag = clean(args.tag);
    if (!fallbackTag || fallbackTag.startsWith('sess_') || !isDeadTarget(err)) throw err;
    return tagResume.serialized(fallbackTag, context, async () => {
      // A competing send or spawn of this tag may have resumed or respawned
      // it while this one waited: then this is an ordinary send to it.
      let prepared = null;
      try {
        prepared = await sendFlow.prepareSend(args, scopedContext);
      } catch (retryErr) {
        if (!isDeadTarget(retryErr)) throw retryErr;
      }
      if (prepared) return dispatchPrepared(prepared, notifyContext);
      return await resumeOrRespawn(err, fallbackTag, args, { callerCwd, context, notifyContext });
    });
  }

  async function resumeOrRespawn(err, fallbackTag, args, { callerCwd, context, notifyContext }) {
    const prompt = await resolvePrompt(args, callerCwd || defaultCwd);
    const inherited = inheritedTagIdentity(fallbackTag, context, args, callerCwd);
    if (!inherited) throw err;
    const resumed = await tagResume.resumeTag(fallbackTag, inherited.resumeSessionId, {
      operation: 'send',
      args,
      callerCwd,
      context,
      notifyContext,
      tombstone: inherited.tombstone,
    });
    if (resumed) return resumed;
    consumeInheritedTag(fallbackTag, inherited);
    const spawnArgs = {
      ...args,
      type: 'spawn',
      tag: fallbackTag,
      prompt,
      message: undefined,
      agent: inherited.agent,
      cwd: inherited.cwd,
    };
    return spawnResult(
      spawnFlow.startDeferredSpawnJob(spawnArgs, callerCwd, context, notifyContext, { respawned: true })
    );
  }

  async function dispatchPrepared(prepared, notifyContext) {
    await sendFlow.adoptCaller(prepared, notifyContext);
    return sendFlow.dispatchToExistingSession(prepared, notifyContext);
  }

  async function send(args, { scopedContext, callerCwd, context, notifyContext }) {
    try {
      const prepared = await sendFlow.prepareSend(args, scopedContext);
      await sendFlow.adoptCaller(prepared, notifyContext);
      return sendFlow.dispatchToExistingSession(prepared, notifyContext);
    } catch (err) {
      return await respawnDeadTagSend(err, args, { scopedContext, callerCwd, context, notifyContext });
    }
  }

  return { send };
}
