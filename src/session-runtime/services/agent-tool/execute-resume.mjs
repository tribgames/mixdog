import { resolve } from 'node:path';
import {
  callerSessionForContext,
  clean,
  isExistingDirectory,
  normalizeAgentName,
  resolvePrompt,
  terminalPidForContext,
} from './helpers.mjs';

// Continuing a reaped tag's own saved session: the prompt is appended to the
// stored transcript as one more turn (nothing earlier is rewritten), so the
// worker keeps its context and a provider's prompt cache keeps its prefix.
//
// Inputs: `registry` (resumable-session reads, tag binding, tombstones),
// `sendFlow` (the existing-session dispatch) and `defaultCwd`. Output:
// { serialized, resumeTag }; one instance is shared by `send` and `spawn`.
export function createTagResume({ registry, sendFlow, defaultCwd }) {
  const inFlight = new Map(); // owner scope + tag -> tail promise

  /** Runs `run` after every earlier call for this owner's `tag` settled, so
   *  a competing send or spawn sees the tag the first one resumed (or
   *  respawned) instead of resuming it a second time. */
  function serialized(tag, context, run) {
    const owner = callerSessionForContext(context) || `pid:${terminalPidForContext(context) || 0}`;
    const key = `${owner}\0${tag}`;
    const previous = inFlight.get(key) || Promise.resolve();
    const current = previous.then(run, run);
    const tail = current.then(
      () => {},
      () => {}
    );
    inFlight.set(key, tail);
    tail.then(() => {
      if (inFlight.get(key) === tail) inFlight.delete(key);
    });
    return current;
  }

  // A request naming another agent or directory asks for different work than
  // the saved session did; that gets a fresh session instead.
  function requestFits(session, args, callerCwd) {
    const agent = clean(args.agent);
    if (agent && normalizeAgentName(agent) !== normalizeAgentName(session.agent)) return false;
    const cwd = clean(args.cwd);
    if (!cwd) return true;
    return Boolean(clean(session.cwd)) && resolve(callerCwd || defaultCwd, cwd) === resolve(clean(session.cwd));
  }

  // The saved working directory is gone: a fresh session may start only in a
  // directory the caller names that exists, never in the missing one.
  async function refuseMissingCwd(operation, tag, missingCwd, args, callerCwd) {
    const named = clean(args.cwd) ? resolve(callerCwd || defaultCwd, clean(args.cwd)) : '';
    if (named && (await isExistingDirectory(named))) return;
    const gone = missingCwd ? `"${missingCwd}"` : '(unknown)';
    throw new Error(
      `agent ${operation}: tag "${tag}" cannot continue: its working directory ${gone} no longer exists` +
        `${named ? ` and cwd "${named}" is not a directory` : ''}; pass an existing cwd to start a fresh session there`
    );
  }

  /** Dispatches `args` onto `sessionId` under `tag` and returns the rendered
   *  result, or null when that session cannot be resumed for this caller (the
   *  caller then starts a fresh session). Throws when only its working
   *  directory is gone and the caller named no existing one. A consumed
   *  `tombstone` is the reap record the resume replaces. Call inside
   *  `serialized` for this tag. */
  async function resumeTag(
    tag,
    sessionId,
    { operation, args, callerCwd, context, notifyContext, tombstone = null, route = null }
  ) {
    const found = await registry.resumableTagSession(tag, sessionId, context);
    if (!found) return null;
    if (!found.session) {
      await refuseMissingCwd(operation, tag, found.missingCwd, args, callerCwd);
      return null;
    }
    const { session } = found;
    if (!requestFits(session, args, callerCwd)) return null;
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    const prepared = { args: { ...args, tag }, session, sessionId: session.id, prompt, ...(route ? { route } : {}) };
    await sendFlow.adoptCaller(prepared, notifyContext);
    const result = await sendFlow.dispatchToExistingSession(prepared, notifyContext, { resumed: true });
    // Only once the turn was admitted on the session: the tag resolves to it
    // again (its row is stamped fresh, so nothing ages it out before the turn
    // writes its own), and the reap record goes.
    registry.bindTag(tag, session, { turnStartedAt: new Date().toISOString() });
    if (tombstone) registry.consumeTagTombstone(tombstone);
    return result;
  }

  return { serialized, resumeTag };
}
