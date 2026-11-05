/**
 * The session recorders of this process: one per session id whose writer
 * claim this process holds, opened at its first write of the tenure and
 * finished when the claim goes. This is where the legacy seam's write half
 * lives — a session that has only its `<id>.json` gets its log through the
 * one conversion function (convertLegacySession) — and where a copy is
 * checked against the record it was loaded from.
 *
 * A loaded copy is bound to what it was read from (bindLoadedSession):
 *   log    { logId, seq } and the message references as loaded;
 *   legacy the json's sha1 and the message references as loaded.
 * The recorder then diffs that copy against exactly those references; a log
 * that moved on since (another process wrote it) refuses the copy with
 * ESESSIONCHANGED. The copy a tenure last wrote is bound the same way when
 * the tenure ends (finishRecorder), so it is refused too once another process
 * wrote since. A copy built in this process that no tenure wrote (no binding)
 * is recorded against whatever the log holds. An open recorder is used only
 * while the log still ends where it left it (recorder.atLogEnd); one the log
 * moved past outside it is retired the same way (retireRecorder).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sessionLogPath, sessionPath } from './session-paths.mjs';
import {
  sessionWriterHeldHere,
  sessionWriterRefusalError,
  setSessionWriterReleaseHook,
} from './session-writer-claim.mjs';
import {
  SESSION_LOG_ERRORS,
  convertLegacySession,
  createSessionLog,
  openSessionLog,
  setAsideSessionLog,
} from './session-log-writer.mjs';
import { fileFingerprint, sameFingerprint, sha1Hex } from './session-log-format.mjs';
import { legacyJsonPresentSync } from './session-log-reader.mjs';
import { holdsNoData } from '../../../../shared/atomic-file.mjs';
import { TRANSIENT_SESSION_KEYS, _messageForDisk, _sessionHeaderForDisk } from './serialize.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { redactSensitiveText, sensitiveValuesVersion } from '../sensitive-values.mjs';
import { redactSensitiveMessage } from '../sensitive-projection.mjs';

const _recorders = new Map(); // id → SessionLogRecorder
const _bindings = new WeakMap(); // loaded session → { log | legacy, messages }
const _lastCopies = new Map(); // id → the copy last handed to its recorder this tenure

/** Records what a loaded copy came from (`outcome`: the seam's resolution). */
export function bindLoadedSession(session, outcome) {
  if (!session || typeof session !== 'object') return;
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  if (outcome.kind === 'log' || outcome.kind === 'orphan') {
    _bindings.set(session, { log: { logId: outcome.log.logId, seq: outcome.log.seq }, messages });
  } else if (outcome.kind === 'legacy' || outcome.kind === 'diverged') {
    _bindings.set(session, { legacy: outcome.legacy.sha1, messages });
  }
}

function claimOf(id) {
  return {
    assertHeld() {
      if (!sessionWriterHeldHere(id)) throw sessionWriterRefusalError({ id, reason: 'changed' });
    },
  };
}

function recorderOptions(id) {
  return {
    claim: claimOf(id),
    transientKeys: TRANSIENT_SESSION_KEYS,
    projectHeader: _sessionHeaderForDisk,
    projectMessage: (message) => _messageForDisk(message, id),
  };
}

function changed(id) {
  return sessionWriterRefusalError({ id, reason: 'changed' });
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

// The json beside a log is not the one the log was built from (an older
// build wrote it after a downgrade, or a json appeared beside a log-born
// session). A missing json is the orphan case: the log stays authoritative.
function divergedFrom(recorder, jsonPath) {
  const st = statOrNull(jsonPath);
  if (!st) return false;
  if (recorder.legacy && sameFingerprint(recorder.legacy, fileFingerprint(st))) return false;
  const bytes = readFileSync(jsonPath);
  // A json that holds no data is none (the seam reads it the same way).
  if (holdsNoData(bytes)) return false;
  if (!recorder.legacy) return true;
  const sha1 = sha1Hex(bytes);
  return sha1 !== recorder.legacy.sha1 && sha1 !== recorder.legacy.redactedFrom;
}

function adoptBinding(recorder, binding, id) {
  if (binding?.log) recorder.adopt(binding.log, binding.messages);
  else if (binding?.legacy) {
    // Loaded from the json, converted since (by the migration or another
    // process): the same base, while nothing was recorded on it.
    if (recorder.legacy?.sha1 !== binding.legacy || recorder.seq !== 1) {
      recorder.closeUnused();
      throw changed(id);
    }
    recorder.adopt({ logId: recorder.logId, seq: 1 }, binding.messages);
  }
}

function openConverted(id, logPath, converted, binding) {
  const options = recorderOptions(id);
  const recorder = openSessionLog({ logPath, ...options });
  if (binding?.log || (binding?.legacy && binding.legacy !== converted.legacy.sha1)) {
    // The copy was read from a record this conversion did not start from.
    recorder.closeUnused();
    throw changed(id);
  }
  if (binding?.legacy) recorder.adopt({ logId: converted.logId, seq: 1 }, binding.messages);
  return recorder;
}

function openRecorder(session) {
  const id = session.id;
  const jsonPath = sessionPath(id);
  const logPath = sessionLogPath(id);
  const binding = _bindings.get(session) ?? null;
  const options = recorderOptions(id);
  let recorder = null;
  if (existsSync(logPath)) {
    try {
      recorder = openSessionLog({ logPath, ...options });
    } catch (err) {
      if (err?.code !== SESSION_LOG_ERRORS.INVALID) throw err;
      // Not a log of ours: kept whole beside the record, which then reads as
      // having no log.
      setAsideSessionLog(logPath, 'invalid');
    }
  }
  if (recorder && recorder.sessionId !== id) {
    // A log of another session under this name is no log of this one.
    recorder.closeUnused();
    recorder = null;
    setAsideSessionLog(logPath, 'invalid');
  }
  if (recorder && !divergedFrom(recorder, jsonPath)) {
    try {
      adoptBinding(recorder, binding, id);
    } catch (err) {
      recorder.closeUnused();
      throw err;
    }
    return recorder;
  }
  if (recorder) {
    // The json wins: the log is set aside whole and the session rebased on it.
    const divergedLogId = recorder.logId;
    recorder.closeUnused();
    const converted = convertLegacySession({
      jsonPath,
      logPath,
      loadLegacy: loadLegacySession,
      claim: options.claim,
      divergedLogId,
    });
    return openConverted(id, logPath, converted, binding);
  }
  if (legacyJsonPresentSync(jsonPath)) {
    const converted = convertLegacySession({ jsonPath, logPath, loadLegacy: loadLegacySession, claim: options.claim });
    return openConverted(id, logPath, converted, binding);
  }
  if (binding) throw changed(id); // its record is gone (deleted elsewhere)
  return createSessionLog({ logPath, session, ...options });
}

// A recorder that can no longer write: its claim went, or the log moved on
// outside it (records it did not write). What it holds is dropped, and the
// copy it last wrote is bound to where it left the log, so the next recorder —
// opened on the log as it is — refuses that copy once the log moved past it,
// while a copy built here is recorded on top of the log. Its message
// references are kept only when everything it recorded landed.
function retireRecorder(id, recorder) {
  _recorders.delete(id);
  const copy = _lastCopies.get(id);
  _lastCopies.delete(id);
  const { logId, seq } = recorder.acked;
  const landed = seq === recorder.seq;
  if (!recorder.finished) recorder.discard(changed(id));
  // Its file closes once a write already in flight (a claim lost mid-batch) ended.
  void recorder.close().catch(() => {});
  if (copy) _bindings.set(copy, { log: { logId, seq }, messages: landed ? recorder.recordedMessages() : null });
}

/**
 * The recorder of `session`'s id, opened (or created, or converted from the
 * legacy json) when this tenure has none yet. The caller holds the claim.
 * Throws ESESSIONCHANGED for a copy the log moved past, or the conversion's
 * error.
 */
export function recorderFor(session) {
  const id = session.id;
  const open = _recorders.get(id);
  if (open && !open.finished && open.atLogEnd) {
    _lastCopies.set(id, session);
    return open;
  }
  if (open) retireRecorder(id, open);
  _lastCopies.set(id, session);
  const recorder = openRecorder(session);
  _recorders.set(id, recorder);
  return recorder;
}

const _redactedVersions = new Map(); // id → sensitive-values version the files were rewritten for

/** Whether `id` gained a sensitive value its stored files may still hold. */
export function redactionDue(id) {
  return sensitiveValuesVersion(id) !== (_redactedVersions.get(id) ?? 0);
}

/**
 * The one redaction of a session's files: the log is replaced by a fresh base
 * holding `session` projected again, and the legacy `<id>.json` plus the
 * copies kept aside beside the log that hold a value are replaced by redacted
 * copies — the only write the json ever gets. The recorder's rewrite takes
 * the redacted json's identity as the new base's legacy identity (with
 * `redactedFrom`), so neither swap order reads as a divergence.
 */
export async function redactSessionFiles(recorder, session) {
  const id = session.id;
  const version = sensitiveValuesVersion(id);
  const acked = await recorder.rewrite(session, { redaction: redactionOf(id) });
  _redactedVersions.set(id, version);
  return acked;
}

/** redactSessionFiles, synchronously: the exit drain's. */
export function redactSessionFilesSync(recorder, session) {
  const id = session.id;
  const version = sensitiveValuesVersion(id);
  recorder.rewriteSync(session, { redaction: redactionOf(id) });
  _redactedVersions.set(id, version);
}

// The json and the copies aside are redacted where the log's messages are:
// each message through the sensitive projection the log stores it with.
function redactionOf(id) {
  return {
    jsonPath: sessionPath(id),
    redactMessage: (message) => redactSensitiveMessage(id, message),
    redactText: (text) => redactSensitiveText(id, text),
  };
}

/** The open recorder of `id`, or null. */
export function openRecorderOf(id) {
  const recorder = _recorders.get(id);
  return recorder && !recorder.finished ? recorder : null;
}

/** Whether `id` has recorded state not yet acknowledged. */
export function hasUnackedRecords(id) {
  return openRecorderOf(id)?.pending === true;
}

/** Ends `id`'s recorder: its queue lands (unless `discard`), then the file
 *  closes. Resolves once nothing of it is in flight. */
export async function finishRecorder(id, { discard = false } = {}) {
  const recorder = _recorders.get(id);
  const copy = _lastCopies.get(id);
  _lastCopies.delete(id);
  if (!recorder) return;
  _recorders.delete(id);
  if (discard) recorder.discard();
  const closed = await recorder.close().then(
    () => true,
    () => false
  );
  // The copy this tenure wrote is bound to where the log stands now: once
  // another process writes the session, a later save of it is refused
  // (ESESSIONCHANGED) instead of being recorded over that process's records.
  if (closed && copy && !discard) {
    _bindings.set(copy, { log: { logId: recorder.logId, seq: recorder.seq }, messages: recorder.recordedMessages() });
  }
}

/** Process exit: every recorder writes what it holds, synchronously. */
export function flushAllRecordersSync() {
  for (const [id, recorder] of _recorders) {
    try {
      recorder.flushSync();
    } catch (err) {
      process.stderr.write(`[session-store] exit flush of ${id} failed: ${err?.message || err}\n`);
    }
  }
  _recorders.clear();
}

// The claim goes only after its recorder finished; at exit, after it wrote what it holds.
setSessionWriterReleaseHook((id) => (_recorders.has(id) ? finishRecorder(id) : null), flushAllRecordersSync);
