import { clean, resolvePrompt } from './helpers.mjs';

// Tag-addressed send, including the dead-tag respawn fallback: everything the
// `send` request type needs once the caller's scope is resolved.
//
// Inputs: `registry` (tag maps, worker rows, tombstones), `defaultCwd`,
// `sendFlow`, `spawnFlow`, and `spawnResult` (job -> rendered tool output).
// Output: { send }.
export function createSendDispatch({ registry, defaultCwd, sendFlow, spawnFlow, spawnResult }) {
  // A retained row or reap tombstone proves that this terminal owned the tag.
  // Unknown tags stay errors even when the caller supplies an agent/cwd: typo
  // absorption requires persisted same-tag evidence. Absorption identity is
  // always terminal-local, even when live resolution was explicitly requested
  // across all terminals; a local proof wins even if another terminal also
  // owns this tag.
  function inheritedTagIdentity(fallbackTag, ownershipContext, args, callerCwd) {
    let row = null;
    try {
      row = registry.readWorkerRows(ownershipContext).find((entry) => clean(entry.tag) === fallbackTag) || null;
    } catch {
      row = null;
    }
    const tombstone = registry.tagTombstoneForTag(fallbackTag, ownershipContext);
    if (!row && !tombstone) return null;
    const agent = clean(args.agent) || clean(row?.agent) || clean(tombstone?.agent);
    const cwd = clean(args.cwd) || clean(row?.cwd) || clean(tombstone?.cwd) || clean(callerCwd);
    if (!agent || !cwd) return null;
    return { row, tombstone, sessionId: clean(row?.sessionId), agent, cwd };
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

  // Reaped/dead-tag fallback: with the 5m terminal-reap window a same-scope
  // follow-up often lands after the session is gone. Instead of bouncing an
  // error back to Lead (who would just re-issue the same content as a spawn),
  // respawn a FRESH session under the same tag with the message as its brief.
  // `respawned: true` in the result tells Lead the worker has no prior session
  // context. Only tag-addressed sends fall back; explicit sessionId sends keep
  // erroring (the caller pinned a specific session on purpose).
  async function respawnDeadTagSend(err, args, { callerCwd, context, notifyContext }) {
    const fallbackTag = clean(args.tag);
    const isDeadTarget = /not found|is closed/i.test(String(err?.message || ''));
    if (!fallbackTag || fallbackTag.startsWith('sess_') || !isDeadTarget) throw err;
    const prompt = await resolvePrompt(args, callerCwd || defaultCwd);
    const inherited = inheritedTagIdentity(fallbackTag, context, args, callerCwd);
    if (!inherited) throw err;
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

  async function send(args, { scopedContext, callerCwd, context, notifyContext }) {
    try {
      const prepared = await sendFlow.prepareSend(args, scopedContext);
      return sendFlow.dispatchToExistingSession(prepared, notifyContext);
    } catch (err) {
      return await respawnDeadTagSend(err, args, { callerCwd, context, notifyContext });
    }
  }

  return { send };
}
