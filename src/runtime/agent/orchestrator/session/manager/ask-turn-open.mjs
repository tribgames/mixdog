// manager/ask-turn-open.mjs
// Opening one turn: settle the previous turn's durability and the durable
// base this turn opens on (settleTurnBase, awaited before anything below),
// load and reconcile the stored session and claim the
// runtime entry with a fresh abort controller (claimTurnRuntime), then arm
// the turn's durability — the crash-checkpoint scheduler and the close
// snapshot hook (armTurnDurability). Both are synchronous so closeSession()
// cannot interleave between load and registration.
import { randomUUID } from 'node:crypto';
import { loadSession, readSessionLifecycleFromDisk } from '../store.mjs';
import { durableTranscriptBase } from '../store/transcript-durability.mjs';
import { createAbortController } from '../../../../shared/abort-controller.mjs';
import { normalizeStaleCompactingStage } from './compaction-runner.mjs';
import { linkParentSignalToSession, markSessionAskStart, _touchRuntime } from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { ensureCodexWireSessionId, mintUuidV7 } from './session-id.mjs';
import { createTurnInterruptionTracker } from './turn-interruption.mjs';
import { _recoverTurnCheckpointDurably, setAsideUnrecoveredCheckpoint } from './turn-checkpoint-recovery.mjs';
import { awaitPreviousTurnDurable, ensureDurableTranscript } from './turn-durability.mjs';
import { emitAskSessionStart } from './ask-support.mjs';
import { createAskTurnState, createCloseSnapshot, createTurnCheckpointScheduler } from './ask-turn-state.mjs';

// Split-brain re-adoption: another surface (e.g. desktop click-through
// of a session still actively owned by this process) may have
// resumed-and-detached this session, bumping the ON-DISK generation
// while the conversation kept going here. Every save from this process
// would then be silently dropped by _shouldDrop's ownership rule and
// the on-disk transcript would freeze at the last landed save. A new
// ask on a NON-closed session is an explicit ownership claim: adopt
// the disk generation so this turn's commits land and heal the file.
function adoptDiskGeneration(session, sessionId) {
  const diskLifecycle = readSessionLifecycleFromDisk(sessionId);
  if (
    diskLifecycle &&
    diskLifecycle.closed !== true &&
    diskLifecycle.generation > (typeof session.generation === 'number' ? session.generation : 0)
  ) {
    session.generation = diskLifecycle.generation;
  }
}

/** Before a turn claims the session: the previous turn's finalized
 *  transcript is durably saved (its checkpoint deleted only then), a crashed
 *  turn's checkpoint is recovered (`recoverCheckpoint`, once per ask), and
 *  the transcript the turn opens on is the one a landed save holds — so the
 *  new checkpoint names a base that is on disk. Throws TurnPersistenceError
 *  when a save does not land; other sessions never wait on this one. */
export async function settleTurnBase(sessionId, { recoverCheckpoint }) {
  await awaitPreviousTurnDurable(sessionId);
  const session = loadSession(sessionId);
  // claimTurnRuntime reports a missing or closed session.
  if (!session || session.closed === true) return;
  adoptDiskGeneration(session, sessionId);
  if (recoverCheckpoint) _recoverTurnCheckpointDurably(session, sessionId);
  await ensureDurableTranscript(session);
  // This turn's checkpoint replaces the session's checkpoint file. Whatever
  // is still there (a conflict, an unreadable header, a crashed turn this
  // ask did not recover) is set aside first, never overwritten.
  setAsideUnrecoveredCheckpoint(session, sessionId);
}

/** Loads the session for a new turn and reconciles its on-disk lifecycle:
 *  a stale compacting stage and split-brain re-adoption of a disk generation
 *  another surface bumped. */
function loadTurnSession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  if (session.closed === true) {
    throw new SessionClosedError(sessionId, 'session already closed');
  }
  const codexWireSessionId = ensureCodexWireSessionId(session);
  // A prior crash/partial-save during compaction may have pinned
  // compaction.lastStage='compacting'. This ask is starting fresh, so
  // recover the stale transient stage before the loop's pre-send compact
  // path runs (it will overwrite lastStage with real telemetry).
  normalizeStaleCompactingStage(session);
  adoptDiskGeneration(session, sessionId);
  return { session, codexWireSessionId };
}

/** Loads the session and installs this turn's controller on the runtime
 *  entry, re-cascading any parent abort link and marking the ask started. */
export function claimTurnRuntime({ sessionId, askOpts, emitStart }) {
  const { session: preSession, codexWireSessionId } = loadTurnSession(sessionId);
  const askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
  const runtime = _touchRuntime(sessionId);
  // Preserve any parent-abort link agent-dispatch established BEFORE we
  // swap in a fresh controller: replacing runtime.controller drops the
  // abort state, so an already/early-aborted parent signal (user ESC /
  // owner abort landing during setup) would be lost and provider
  // computation would run detached. Capture the linked signal, install the
  // fresh controller, then re-cascade it — aborting the new controller
  // immediately when the parent already fired, or re-arming the listener.
  const linkedParentSignal = askOpts?.signal || runtime.parentAbortLink?.signal;
  // Fresh controller per ask — the previous ask's controller may have aborted.
  runtime.controller = createAbortController();
  const turnSignal = runtime.controller.signal;
  runtime.generation = askGeneration;
  runtime.closed = false;
  runtime.session = preSession;
  if (linkedParentSignal instanceof AbortSignal) {
    linkParentSignalToSession(sessionId, linkedParentSignal);
  }
  markSessionAskStart(sessionId);
  if (emitStart) {
    emitAskSessionStart(askOpts, {
      sessionId,
      agent: preSession.agent || null,
      model: preSession.model || null,
      provider: preSession.provider || null,
      owner: preSession.owner || null,
    });
  }
  return { preSession, codexWireSessionId, askGeneration, runtime, turnSignal };
}

/** Creates the turn state with its checkpoint scheduler and close snapshot,
 *  and exposes the snapshot hook to closeSession() through the runtime. */
export function armTurnDurability({
  sessionId,
  preSession,
  codexWireSessionId,
  askGeneration,
  runtime,
  pendingEntries,
}) {
  const turn = createAskTurnState(preSession);
  turn.pendingEntries = pendingEntries;
  const interruption = createTurnInterruptionTracker();
  const turnToken = randomUUID();
  const startedAt = Date.now();
  const codexTurnId = codexWireSessionId ? mintUuidV7(startedAt) : null;
  const checkpoint = createTurnCheckpointScheduler({
    sessionId,
    generation: askGeneration,
    turnToken,
    startedAt,
    turn,
    interruption,
    base: durableTranscriptBase(preSession),
  });
  const prepareCloseSnapshot = createCloseSnapshot({ turn, interruption, checkpoint, runtime });
  // closeSession is synchronous and generation-first by design. Expose a
  // turn-local hook so it can canonicalize the in-flight transcript
  // before bumpSessionGeneration()/markSessionClosed() writes the disk
  // snapshot and invalidates the ordinary cancellation cleanup save.
  runtime.prepareCloseSnapshot = prepareCloseSnapshot;
  return { turn, interruption, checkpoint, prepareCloseSnapshot, turnToken, startedAt, codexTurnId };
}
