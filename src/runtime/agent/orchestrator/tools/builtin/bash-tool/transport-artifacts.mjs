import { unlinkSync } from 'node:fs';
import { consumeFilterTeeCapture } from '../shell-analysis.mjs';
import { isShellJobRunning, subscribeShellJobSettled } from '../shell-jobs.mjs';

// Per-command transport artifacts (hoisted inline script, PowerShell filter-tee
// capture) stay in use by a command that was promoted to a background task, so
// they are removed when that TASK SETTLES. A fixed 10 s timer deleted the
// hoisted script out from under a still-running command; the ceiling below only
// covers a job whose settlement event never arrives, and the exit hook prevents
// one-shot CLI/test leftovers.
// Rules:
//   - a promoted command still USES its artifacts, so removal waits for the
//     task to settle (a fixed timer deleted the script under a live command);
//   - the fallback timer never deletes under a task that is still running: a
//     missed settlement event and a live job are not the same thing, so it
//     re-arms instead;
//   - a failed removal is retried rather than abandoned — Windows keeps the
//     file locked while a process that survived an unconfirmed kill holds it —
//     with the process-exit hook as the last resort.
const ARTIFACT_SETTLE_CEILING_MS = 30 * 60_000;
const UNTRACKED_ARTIFACT_CLEANUP_MS = 10_000;
const ARTIFACT_RETRY_MS = 30_000;
const ARTIFACT_RETRY_ATTEMPTS = 10;
const PENDING_ARTIFACT_PATHS = new Set();
let artifactExitHookInstalled = false;

function removeTransportFile(file) {
  try {
    unlinkSync(file);
    return true;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

export function consumeTeeArtifact(file) {
  try {
    consumeFilterTeeCapture(file);
  } catch {
    /* best-effort */
  }
  return removeTransportFile(file);
}

function registerTransportArtifact(file) {
  PENDING_ARTIFACT_PATHS.add(file);
  if (artifactExitHookInstalled) return;
  artifactExitHookInstalled = true;
  process.once('exit', () => {
    for (const pending of PENDING_ARTIFACT_PATHS) {
      try {
        unlinkSync(pending);
      } catch {}
    }
    PENDING_ARTIFACT_PATHS.clear();
  });
}

function finishTransportArtifact(file, remove, attempt = 0) {
  if (!PENDING_ARTIFACT_PATHS.has(file)) return;
  let removed = false;
  try {
    removed = remove(file) !== false;
  } catch {
    removed = false;
  }
  if (removed) {
    PENDING_ARTIFACT_PATHS.delete(file);
    return;
  }
  if (attempt >= ARTIFACT_RETRY_ATTEMPTS) return;
  const retry = setTimeout(() => finishTransportArtifact(file, remove, attempt + 1), ARTIFACT_RETRY_MS);
  retry.unref?.();
}

export function removeTransportFileNow(file) {
  if (!file) return;
  registerTransportArtifact(file);
  finishTransportArtifact(file, removeTransportFile);
}

export function cleanupArtifactOnTaskSettled(file, jobId, remove = removeTransportFile) {
  if (!file) return;
  registerTransportArtifact(file);
  let finished = false;
  let unsubscribe = null;
  const done = () => {
    if (finished) return;
    finished = true;
    try {
      unsubscribe?.();
    } catch {
      /* best-effort */
    }
    unsubscribe = null;
    finishTransportArtifact(file, remove);
  };
  unsubscribe = jobId ? subscribeShellJobSettled(jobId, done) : null;
  const armFallback = () => {
    const timer = setTimeout(
      () => {
        if (finished) return;
        if (jobId && isShellJobRunning(jobId)) {
          armFallback();
          return;
        }
        done();
      },
      unsubscribe ? ARTIFACT_SETTLE_CEILING_MS : UNTRACKED_ARTIFACT_CLEANUP_MS
    );
    timer.unref?.();
  };
  armFallback();
}
