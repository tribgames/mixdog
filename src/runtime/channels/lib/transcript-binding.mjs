import * as fs from "fs";
import * as path from "path";
// Transcript binding / rebind / pending-rearm cluster extracted from
// channels/index.mjs (behavior-preserving). Bound to live runtime getters and
// shared primitives so file-level reference semantics are unchanged.
export function createTranscriptBinding({
  forwarder,
  statusState,
  readActiveInstance,
  refreshActiveInstance,
  instanceId,
  memoryIngestTranscript,
  memoryDrainBuffer,
  dropTrace,
  discoverSessionBoundTranscript,
  sameResolvedPath,
  getConfig,
  getChannelBridgeActive,
  getBridgeRuntimeConnected,
  RUNTIME_ROOT,
}) {
function sessionIdFromTranscriptPath(transcriptPath) {
  const base = path.basename(transcriptPath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : "";
}
function getPersistedTranscriptPath() {
  const state = statusState.read();
  if (typeof state.transcriptPath === "string" && state.transcriptPath) return state.transcriptPath;
  return readActiveInstance()?.transcriptPath ?? "";
}
function pickUsableTranscriptPath(bound, previousPath) {
  if (bound?.exists) return bound.transcriptPath;
  if (!previousPath) return "";
  if (!bound?.sessionId) return previousPath;
  return sessionIdFromTranscriptPath(previousPath) === bound.sessionId ? previousPath : "";
}
function applyTranscriptBinding(channelId, transcriptPath, options = {}) {
  if (!transcriptPath) return;
  forwarder.setContext(channelId, transcriptPath, {
    replayFromStart: options.replayFromStart,
    catchUpFromPersisted: options.catchUpFromPersisted,
    recoverUnsyncedTail: options.recoverUnsyncedTail,
  });
  const boundTranscriptPath = forwarder.transcriptPath || transcriptPath;
  forwarder.startWatch();
  void memoryIngestTranscript(boundTranscriptPath, { cwd: options.cwd });
  // Opportunistic drain: an ingest that had to buffer (memory port not yet
  // published) leaves entry-/ingest- files behind; kick the drainer so they
  // replay as soon as the port appears, without waiting for the periodic tick.
  void memoryDrainBuffer().catch(() => {});
  // onlyIfOwned: binds happen on the owned path, but discovery/poll loops
  // above can outlast an ownership handoff — never overwrite a newer owner.
  refreshActiveInstance(instanceId, { channelId, transcriptPath: boundTranscriptPath }, { onlyIfOwned: true });
  if (options.persistStatus !== false) {
    statusState.update((state) => {
      const wasSameTranscript = typeof state.transcriptPath === "string"
        && state.transcriptPath
        && sameResolvedPath(state.transcriptPath, boundTranscriptPath);
      const prevSentCount = Number(state.sentCount ?? 0);
      const nextSentCount = Number(forwarder.sentCount ?? 0);
      state.channelId = channelId;
      state.transcriptPath = boundTranscriptPath;
      state.lastFileSize = forwarder.lastFileSize;
      if (wasSameTranscript) {
        state.sentCount = Math.max(
          Number.isFinite(prevSentCount) ? prevSentCount : 0,
          Number.isFinite(nextSentCount) ? nextSentCount : 0,
        );
        if (forwarder.lastHash) state.lastSentHash = forwarder.lastHash;
        else if (typeof state.lastSentHash !== "string") state.lastSentHash = "";
        if (!Number.isFinite(Number(state.lastSentTime))) state.lastSentTime = 0;
        if (typeof state.sessionIdle !== "boolean") state.sessionIdle = false;
      } else {
        state.sentCount = forwarder.sentCount;
        state.lastSentHash = forwarder.lastHash;
        state.lastSentTime = 0;
        state.sessionIdle = false;
      }
      if (options.cwd !== undefined) state.sessionCwd = options.cwd ?? null;
      else if (!wasSameTranscript) state.sessionCwd = null;
    });
  }
}
// ── Pending-transcript re-arm ────────────────────────────────────────
// fs.watch cannot watch a file that does not exist yet, so when we bind a
// session's known-but-not-yet-written transcript path, OutputForwarder.
// startWatch() silently fails (watch.start.catch) and the file's later
// creation is never observed. This bounded poll bridges that gap: once the
// transcript-writer creates the file, we install the watch and forward the
// backlog. It self-cancels on success, on timeout, and whenever a fresh
// (re)bind supersedes it — so no timers leak and no double-forward occurs.
let _pendingRearmTimer = null;
const PENDING_REARM_INTERVAL_MS = 250;
const PENDING_REARM_MAX_MS = 60_000;
function cancelPendingTranscriptRearm() {
  if (_pendingRearmTimer) {
    clearTimeout(_pendingRearmTimer);
    _pendingRearmTimer = null;
    dropTrace("rebind.rearm.cancel");
  }
}
function schedulePendingTranscriptRearm(channelId, boundPath) {
  cancelPendingTranscriptRearm();
  if (!boundPath) return;
  const deadline = Date.now() + PENDING_REARM_MAX_MS;
  dropTrace("rebind.rearm.schedule", { channelId, path: boundPath });
  const tick = () => {
    _pendingRearmTimer = null;
    // A different transcript got bound in the meantime — abandon this poll.
    if (forwarder.transcriptPath !== boundPath) {
      dropTrace("rebind.rearm.superseded", { path: boundPath, now: forwarder.transcriptPath || "(none)" });
      return;
    }
    // Ownership may have been lost (bridge deactivated / superseded owner)
    // while this poll was pending. Do not reinstall the fs.watch handle after
    // teardown; startWatch() is not owner-gated so guard it here.
    if (!getBridgeRuntimeConnected()) {
      dropTrace("rebind.rearm.not-owner", { path: boundPath });
      return;
    }
    if (fs.existsSync(boundPath)) {
      dropTrace("rebind.rearm.fire", { channelId, path: boundPath });
      forwarder.startWatch();
      void forwarder.forwardNewText().catch((err) => {
        try { process.stderr.write(`mixdog: rearm forwardNewText rejection: ${err?.stack || err}\n`); } catch {}
      });
      return;
    }
    if (Date.now() >= deadline) {
      dropTrace("rebind.rearm.timeout", { channelId, path: boundPath });
      return;
    }
    _pendingRearmTimer = setTimeout(tick, PENDING_REARM_INTERVAL_MS);
    _pendingRearmTimer?.unref?.();
  };
  _pendingRearmTimer = setTimeout(tick, PENDING_REARM_INTERVAL_MS);
  _pendingRearmTimer?.unref?.();
}
async function rebindTranscriptContext(channelId, options = {}) {
  const previousPath = options.previousPath ?? "";
  const mode = options.mode ?? "same";
  // A new (re)bind supersedes any pending re-arm poll left over from a prior
  // bind of a not-yet-existing transcript, so we never leak timers or
  // double-forward once the fresh bind takes over.
  cancelPendingTranscriptRearm();
  const explicitTranscriptPath = typeof options.transcriptPath === "string" ? options.transcriptPath.trim() : "";
  if (explicitTranscriptPath) {
    let explicitExists = false;
    try {
      explicitExists = fs.statSync(explicitTranscriptPath).isFile();
    } catch {
      explicitExists = false;
    }
    if (explicitExists) {
      applyTranscriptBinding(channelId, explicitTranscriptPath, {
        replayFromStart: Boolean(options.catchUp),
        catchUpFromPersisted: options.catchUpFromPersisted,
        persistStatus: options.persistStatus,
        recoverUnsyncedTail: options.recoverUnsyncedTail,
      });
      if (options.catchUp || options.catchUpFromPersisted) {
        await forwarder.forwardNewText();
      }
      return explicitTranscriptPath;
    }
  }
  let sawPendingTranscript = false;
  let pendingSessionId = "";
  // Distinct from sawPendingTranscript/pendingSessionId (which only track the
  // sessionId): remember the FULL not-yet-on-disk candidate — its concrete
  // transcriptPath (from the session record) + cwd — so we can bind it after
  // the loop even though the `.jsonl` does not exist yet. This breaks the
  // chicken-and-egg deadlock where the first assistant reply is only written
  // seconds after inbound time.
  let pendingTranscriptPath = "";
  let pendingTranscriptCwd = null;
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts)) : 30;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(25, Math.floor(options.pollMs)) : 150;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const bound = discoverSessionBoundTranscript();
    if (bound?.exists) {
      const acceptable = mode === "same" || !previousPath || bound.transcriptPath !== previousPath;
      if (acceptable) {
        const replayFromStart = Boolean(
          options.catchUp && !previousPath && sawPendingTranscript && pendingSessionId === bound.sessionId
        );
        applyTranscriptBinding(channelId, bound.transcriptPath, {
          replayFromStart,
          catchUpFromPersisted: options.catchUpFromPersisted,
          recoverUnsyncedTail: options.recoverUnsyncedTail,
          persistStatus: options.persistStatus,
          cwd: bound.sessionCwd,
        });
        if (replayFromStart || options.catchUpFromPersisted) {
          await forwarder.forwardNewText();
        }
        return bound.transcriptPath;
      }
    } else if (bound?.sessionId) {
      sawPendingTranscript = true;
      pendingSessionId = bound.sessionId;
      if (bound.transcriptPath) {
        pendingTranscriptPath = bound.transcriptPath;
        pendingTranscriptCwd = bound.sessionCwd ?? null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // No existing transcript surfaced during the loop, but the session record
  // named a concrete transcript path that simply is not on disk yet. Bind it
  // now: applyTranscriptBinding persists state.transcriptPath (so the
  // getPersistedTranscriptPath() fallback works for future rebinds) and calls
  // forwarder.startWatch(). Because fs.watch cannot watch a missing file, we
  // also schedule a bounded re-arm poll that installs the watch + catches up
  // once the transcript-writer creates the file.
  if (pendingTranscriptPath) {
    // Same wrong-session guard as the exists:true path: refuse to bind a
    // candidate that conflicts with an explicit previousPath when this is a
    // switch (mode!=="same").
    const acceptable = mode === "same" || !previousPath || pendingTranscriptPath !== previousPath;
    if (acceptable) {
      dropTrace("rebind.pending.bind", { channelId, path: pendingTranscriptPath, sessionId: pendingSessionId });
      // If the persisted cursor belongs to THIS transcript, resume from it;
      // otherwise this is a freshly-discovered session transcript that was
      // never bound before (the chicken-and-egg case), so forward from the
      // start of file. Binding with catchUpFromPersisted against a
      // non-matching persisted path would set the read cursor to EOF and
      // silently skip the first reply (output-forwarder setContext).
      // Resume from the persisted cursor only when it belongs to THIS
      // transcript; otherwise forward from the start of file (see comment
      // above). sameResolvedPath handles Windows case-insensitive paths.
      const samePersisted = sameResolvedPath(getPersistedTranscriptPath(), pendingTranscriptPath);
      applyTranscriptBinding(channelId, pendingTranscriptPath, {
        replayFromStart: !samePersisted,
        catchUpFromPersisted: samePersisted,
        recoverUnsyncedTail: options.recoverUnsyncedTail,
        cwd: pendingTranscriptCwd,
        persistStatus: options.persistStatus,
      });
      const boundPath = forwarder.transcriptPath || pendingTranscriptPath;
      if (fs.existsSync(boundPath)) {
        // Raced: file appeared between discovery and bind — forward immediately.
        await forwarder.forwardNewText();
      } else {
        schedulePendingTranscriptRearm(channelId, boundPath);
      }
      process.stderr.write(`mixdog: rebind pending: bound not-yet-existing transcript ${boundPath}\n`);
      return pendingTranscriptPath;
    }
  }
  if (previousPath && options.fallbackPrevious !== false) {
    applyTranscriptBinding(channelId, previousPath, {
      catchUpFromPersisted: true,
      recoverUnsyncedTail: options.recoverUnsyncedTail,
      cwd: statusState.read().sessionCwd
    });
    if (fs.existsSync(previousPath)) {
      await forwarder.forwardNewText();
    } else {
      // Same not-yet-on-disk situation as the pending branch: arm a poll so
      // forwarding starts when the file is created.
      schedulePendingTranscriptRearm(channelId, forwarder.transcriptPath || previousPath);
    }
    process.stderr.write(`mixdog: rebind fallback: bound previous transcript ${previousPath}\n`);
    return previousPath;
  }
  process.stderr.write(`mixdog: rebind failed: no transcript found and no previous path to fall back to\n`);
  return "";
}
async function bindPersistedTranscriptIfAny() {
  // Main-channel fallback requires getChannelBridgeActive() (set in start() before
  // refreshBridgeOwnership → startOwnedRuntime, including pre-connect binds).
  // Resolve channelId first from persisted status; fall back to the most
  // recent status-*.json snapshot, then to the configured main channel when
  // the bridge is active. No exists-gate here — once we have a channelId,
  // hand off to rebindTranscriptContext(), which owns the 30-attempt retry
  // for transcripts that are not yet on disk at boot/activate time.
  let currentStatus = statusState.read();
  if (!currentStatus.channelId) {
    try {
      const files = fs.readdirSync(RUNTIME_ROOT).filter((f) => f.startsWith("status-") && f.endsWith(".json")).map((f) => {
        const full = path.join(RUNTIME_ROOT, f);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      for (const { path: fp } of files) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (data.channelId) {
            statusState.update((state) => {
              Object.assign(state, data);
            });
            currentStatus = statusState.read();
            process.stderr.write(`mixdog: restored status from ${fp}
`);
            break;
          }
        } catch {
        }
      }
    } catch {
    }
  }
  if (!currentStatus.channelId && getChannelBridgeActive()) {
    const mainId = getConfig().channelId;
    if (mainId) {
      statusState.update((state) => {
        state.channelId = mainId;
      });
      currentStatus = statusState.read();
      process.stderr.write(`mixdog: auto-bound to main channel ${mainId}
`);
    }
  }
  if (!currentStatus.channelId) return;
  const bound = await rebindTranscriptContext(currentStatus.channelId, {
    previousPath: getPersistedTranscriptPath(),
    persistStatus: true,
    catchUpFromPersisted: true,
    recoverUnsyncedTail: true,
  });
  if (bound) {
    process.stderr.write(`mixdog: initial transcript bind: ${bound}
`);
  }
}
  return {
    sessionIdFromTranscriptPath,
    getPersistedTranscriptPath,
    pickUsableTranscriptPath,
    applyTranscriptBinding,
    cancelPendingTranscriptRearm,
    schedulePendingTranscriptRearm,
    rebindTranscriptContext,
    bindPersistedTranscriptIfAny,
  };
}
