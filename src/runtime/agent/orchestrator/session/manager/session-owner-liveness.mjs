// manager/session-owner-liveness.mjs
// Is another live process driving this session right now?
//
// Attach-on-resume guard: resuming a session that another live process is
// ACTIVELY driving right now must not create a second writer on the same
// file — that split-brain silently freezes one side's transcript (generation
// ownership drops the loser's saves). Such a resume ATTACHES instead: the
// caller gets the live transcript flagged remoteAttached, its submits are
// persisted into the shared pending spool (the owner's injection poller runs
// them as normal user turns), and its view refreshes from disk. ONE writer,
// ONE transcript, every surface talking into the same conversation. Idle
// sessions keep the normal single-identity handoff.
//
// The answer comes from three durable signals — the in-process runtime entry,
// the `.own` presence sidecar and the `.hb` heartbeat — each verified against
// the pid the sidecar recorded so a force-killed owner can never look live.
// The session file's own `lastHeartbeatAt`/`clientHostPid` are NOT liveness
// evidence: the file outlives its writer, and its host pid can name an older
// process (or a recycled pid), so a restart within the freshness window
// reopened the session as a viewer whose prompts spooled to nobody.
import {
  loadSession,
  saveSession,
  readSessionHeartbeatMtime,
  readSessionPresenceMtime,
  isSessionPresenceOwnerDead,
  deleteSessionPresence,
  isSessionHeartbeatOwnerDead,
  readSessionHeartbeatOwnerPid,
  deleteHeartbeat,
} from '../store.mjs';
import { _getRuntimeEntry } from './runtime-liveness.mjs';
import { clearTurnCheckpoint, recoverTurnCheckpoint } from './turn-checkpoint.mjs';

const ACTIVE_OWNER_HB_FRESH_MS = 2 * 60 * 1000; // heartbeat freshness window

export function _isActivelyOwnedElsewhere(_session, sessionId) {
  // This process already owns the runtime for the id — switching back to
  // one of our own sessions (desktop tab switch, TUI /resume) never attaches.
  const entry = _getRuntimeEntry(sessionId);
  if (entry && entry.closed !== true) return false;
  // A FORCE-KILLED owner leaves its `.own` sidecar behind looking fresh.
  // The recorded pid is authoritative: when it no longer exists, the owner
  // is gone — clear the stale sidecar and resume with normal ownership
  // instead of viewer-attaching into a spool nobody drains.
  if (isSessionPresenceOwnerDead(sessionId)) {
    deleteSessionPresence(sessionId);
    return false;
  }
  const now = Date.now();
  // Presence (`.own`, pid-verified just above) covers the idle gaps between
  // turns: a live interactive surface keeps refreshing it (~20s) for its
  // CURRENT session, so cross-opening an idle-but-open session still
  // attaches as a viewer instead of splitting ownership into two writers
  // that clobber each other's saves.
  const presenceAt = Number(readSessionPresenceMtime(sessionId)) || 0;
  if (presenceAt > 0 && now - presenceAt <= ACTIVE_OWNER_HB_FRESH_MS) return true;
  // Heartbeats publish only while a turn is running (≤5s cadence) and the
  // sidecar is deleted on detach/close, so freshness here means another
  // process is mid-conversation on this session right now — PROVIDED that
  // process still exists. Without the pid check a force-killed owner (app
  // upgrade restart, crash) kept looking live for the whole freshness
  // window, so every cross-open attached as a viewer and the user's
  // messages spooled to a queue nobody drains (silently dropped 30m later).
  if (isSessionHeartbeatOwnerDead(sessionId)) {
    void deleteHeartbeat(sessionId);
    return false;
  }
  // Fresh sidecar whose recorded pid is alive: a real owner is driving this
  // session right now. Anything weaker (no sidecar, a pid-less legacy one)
  // proves no live owner, whatever the session file remembers.
  const sidecarAt = Number(readSessionHeartbeatMtime(sessionId)) || 0;
  return sidecarAt > 0 && now - sidecarAt <= ACTIVE_OWNER_HB_FRESH_MS && readSessionHeartbeatOwnerPid(sessionId) > 0;
}

// Viewer self-heal probe: true when a re-resume of this session would NO
// LONGER attach (owner dead or every liveness signal stale). Attached
// surfaces poll this so a dead owner promotes the viewer instead of leaving
// it spooling messages to nobody. Single source of truth: the same guard
// the resume path uses.
export function isSessionOwnerGone(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return false;
  return !_isActivelyOwnedElsewhere(session, sessionId);
}

export function _recoverTurnCheckpointDurably(session, sessionId) {
  const recovery = recoverTurnCheckpoint(session);
  if (!recovery.changed) return recovery;
  // Recovery is a durable reconnect boundary, not a renderer-only view.
  // Persist before removing the checkpoint so a second crash leaves at
  // least one complete copy of the interrupted turn.
  saveSession(session, {
    sync: true,
    expectedGeneration: session.generation,
  });
  if (recovery.turnToken) {
    clearTurnCheckpoint(sessionId, recovery.turnToken);
  }
  // A force-killed owner cannot clear its activity/presence sidecars. Once
  // its checkpoint is committed as interrupted, neither sidecar may keep a
  // restored pane busy or make a new prompt queue behind a dead process.
  deleteSessionPresence(sessionId);
  void deleteHeartbeat(sessionId);
  return recovery;
}

// Reconnect-safe historical read used by desktop pane peeks. Unlike a normal
// read-only load, it resolves a dead owner's durable turn checkpoint before
// returning the transcript. A genuinely live foreign owner remains untouched.
export function recoverSessionAfterProcessRestart(sessionId) {
  const session = loadSession(sessionId);
  if (!session || session.closed === true) return session || null;
  if (_isActivelyOwnedElsewhere(session, sessionId)) return session;
  _recoverTurnCheckpointDurably(session, sessionId);
  return session;
}
