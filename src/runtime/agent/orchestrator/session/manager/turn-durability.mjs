// manager/turn-durability.mjs
// One unsettled turn per session. A finished (or failed) turn stays
// unsettled — its checkpoint kept — until a landed save of its session
// carries the turn's coverage token (store/transcript-durability.mjs); only
// that acknowledgement deletes the checkpoint. The next turn of the session
// waits for it before it opens its own checkpoint or touches the session, and
// a save that cannot land blocks that turn with a TurnPersistenceError
// instead of releasing it. A settled promise, an idle queue or a coalesced,
// cancelled or dropped write is never an acknowledgement. Sessions are
// independent: nothing here waits on another session's saves.
import { readSessionLifecycleFromDisk, saveSessionAsync } from '../store.mjs';
import { landedTranscript, landedTranscriptMatches, mintTranscriptEpoch } from '../store/transcript-durability.mjs';
import { clearTurnCheckpoint } from './turn-checkpoint.mjs';

const _unsettled = new Map(); // sessionId → { session, turnToken, generation, ack, error }

export class TurnPersistenceError extends Error {
  constructor(sessionId, message, cause = null) {
    super(`Session ${sessionId}: ${message}${cause ? ` (${cause.message || cause})` : ''}`);
    this.name = 'TurnPersistenceError';
    this.code = 'ETURNNOTDURABLE';
    this.sessionId = sessionId;
    if (cause) this.cause = cause;
  }
}

// Split-brain re-adoption: another surface (e.g. desktop click-through
// of a session still actively owned by this process) may have
// resumed-and-detached this session, bumping the ON-DISK generation
// while the conversation kept going here. Every save from this process
// would then be silently dropped by _shouldDrop's ownership rule and
// the on-disk transcript would freeze at the last landed save. A new
// ask on a NON-closed session is an explicit ownership claim: adopt
// the disk generation so this turn's commits land and heal the file.
export function adoptDiskGeneration(session, sessionId) {
  const diskLifecycle = readSessionLifecycleFromDisk(sessionId);
  if (
    diskLifecycle &&
    diskLifecycle.closed !== true &&
    diskLifecycle.generation > (typeof session.generation === 'number' ? session.generation : 0)
  ) {
    session.generation = diskLifecycle.generation;
  }
}

/** Whether a landed save of `session` carries `turnToken`'s coverage. */
export function turnCoveredOnDisk(session, turnToken) {
  return landedTranscript(session)?.coverage === turnToken;
}

function release(sessionId, entry) {
  if (_unsettled.get(sessionId) !== entry) return;
  _unsettled.delete(sessionId);
  clearTurnCheckpoint(sessionId, entry.turnToken);
}

/** Keep `turnToken` (already the session's `turnCoverage`) unsettled until a
 *  landed save covers it; `save` is the save expected to. Resolves whether
 *  it did. */
export function holdTurnUntilDurable({ sessionId, session, turnToken, generation, save }) {
  const entry = { session, turnToken, generation, error: null, ack: null };
  _unsettled.set(sessionId, entry);
  entry.ack = Promise.resolve(save)
    .then(
      () => turnCoveredOnDisk(session, turnToken),
      (error) => {
        entry.error = error;
        return false;
      }
    )
    .then((covered) => {
      if (covered) release(sessionId, entry);
      return covered;
    });
  return entry.ack;
}

/** Whether this process holds a turn of `sessionId` not yet durable. */
export function hasUnsettledTurn(sessionId) {
  return _unsettled.has(sessionId);
}

/** A closed or deleted session: nothing will open on it again. */
export function forgetUnsettledTurn(sessionId) {
  _unsettled.delete(sessionId);
}

/** Resolves once the previous turn of `sessionId` is durably covered (its
 *  checkpoint then deleted). When its own save did not land it, one fresh
 *  save of the finalized transcript is attempted; if that does not land
 *  either, throws TurnPersistenceError and the checkpoint stays. A save the
 *  ownership guard refused because another surface moved the disk generation
 *  is retried under that generation: this ask is the ownership claim that
 *  adoptDiskGeneration describes, and the retry stays guarded by it, so a
 *  closed session or a further handoff still refuses it. */
export async function awaitPreviousTurnDurable(sessionId) {
  const entry = _unsettled.get(sessionId);
  if (!entry || (await entry.ack)) return;
  adoptDiskGeneration(entry.session, sessionId);
  entry.generation = Math.max(entry.generation, entry.session.generation);
  try {
    await saveSessionAsync(entry.session, { expectedGeneration: entry.generation });
  } catch (error) {
    entry.error = error;
  }
  if (!turnCoveredOnDisk(entry.session, entry.turnToken)) {
    throw new TurnPersistenceError(
      sessionId,
      'the previous turn is not saved to disk, so the next turn cannot start',
      entry.error
    );
  }
  release(sessionId, entry);
}

/** Make `session`'s current transcript durable, so a turn opening on it
 *  names a base that is on disk. A transcript that is not a pure extension
 *  of the last landed one (an unsaved rewrite) starts a new epoch first. */
export async function ensureDurableTranscript(session) {
  if (landedTranscriptMatches(session)) return;
  const landed = landedTranscript(session);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const extendsLanded =
    landed &&
    landed.epoch === session.transcriptEpoch &&
    landed.refs.length <= messages.length &&
    landed.refs.every((message, index) => message === messages[index]);
  if (typeof session.transcriptEpoch !== 'string' || (landed && !extendsLanded)) {
    session.transcriptEpoch = mintTranscriptEpoch();
  }
  let failure = null;
  try {
    await saveSessionAsync(session, { expectedGeneration: session.generation });
  } catch (error) {
    failure = error;
  }
  if (!landedTranscriptMatches(session)) {
    throw new TurnPersistenceError(
      session.id,
      'the conversation is not saved to disk, so the next turn cannot start',
      failure
    );
  }
}
