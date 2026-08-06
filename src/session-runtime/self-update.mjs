// Self-update controller: registry version check + background staging of the
// next version. Extracted from runtime-core so the runtime facade owns wiring
// only. State is per-runtime and in-memory; the 24h TTL lives in the shared
// update-checker cache.
import {
  checkLatestVersion,
  isDevInstall,
} from '../runtime/shared/update-checker.mjs';
import {
  spawnStagedInstall,
  runStagedInstall,
  isStagedComplete,
} from '../runtime/shared/staged-update.mjs';

const STAGE_POLL_MS = 3_000;
const STAGE_POLL_MAX_MS = 10 * 60 * 1000;
// A backend daemon can host many session runtimes. Their boot controllers all
// need the same update state, not one forced registry request per pane.
const processBootChecks = new Map();

function processBootCheck(dataDir) {
  const key = String(dataDir || '');
  let pending = processBootChecks.get(key);
  if (!pending) {
    pending = checkLatestVersion({ force: true, dataDir });
    processBootChecks.set(key, pending);
  }
  return pending;
}

export function createSelfUpdateController({ getConfig, getDataDir, emitNotification }) {
  let checkState = {
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    lastCheckedAt: 0,
  };
  // phase: 'idle' | 'checking' | 'installing' | 'installed' | 'failed'
  let processState = { phase: 'idle', version: null, error: null };
  let bootTimer = null;

  function autoUpdateEnabled() {
    return getConfig()?.update?.auto !== false;
  }

  async function checkForUpdate({ force = false } = {}) {
    if (processState.phase !== 'installing') processState.phase = 'checking';
    try {
      const result = await checkLatestVersion({ force, dataDir: getDataDir() });
      checkState = {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        updateAvailable: result.updateAvailable,
        lastCheckedAt: result.lastCheckedAt,
      };
    } catch {
      // checkLatestVersion() is already silent-safe; this catch is belt-and-
      // braces so a boot-time call can never crash the runtime.
    } finally {
      if (processState.phase === 'checking') processState.phase = 'idle';
    }
    return checkState;
  }

  async function runUpdateNow() {
    if (processState.phase === 'installing') {
      return { ...processState, alreadyInstalling: true, error: 'update already in progress' };
    }
    if (isDevInstall()) {
      processState = { phase: 'failed', version: null, error: 'dev install — update skipped' };
      return processState;
    }
    const ver = checkState.latestVersion;
    if (!ver || !checkState.updateAvailable) {
      processState = { phase: 'idle', version: null, error: null };
      return { ...processState, error: 'no update available' };
    }
    // "Update now" stages the new version (verified, self-contained) rather than
    // installing over the live global dir; the swap applies on the next launch.
    // phase 'installed' here means "staged & ready — restart to apply".
    processState = { phase: 'installing', version: ver, error: null };
    try {
      const result = await runStagedInstall(ver);
      processState = result?.ok
        ? { phase: 'installed', version: result.version || ver, error: null }
        : { phase: 'failed', version: null, error: result?.error || 'update failed' };
    } catch (err) {
      processState = { phase: 'failed', version: null, error: err?.message || String(err) };
    }
    return processState;
  }

  // Non-blocking boot hook: the caller defers it past the synchronous runtime
  // construction, so a slow/hanging registry request can never delay boot. The
  // check ALWAYS runs (it populates the maintenance picker), but an available
  // update only kicks off a hidden BACKGROUND staging install; the swap into
  // the global dir happens on the next clean launch (cli.mjs pre-import), so
  // npm never overwrites files this live process holds. force:true — the 24h
  // disk cache went stale-visible (it kept reporting an older "latest" than the
  // installed version); checkLatestVersion still falls back to it offline.
  // isDevInstall(): a git checkout must never self-update.
  function startBootCheck() {
    if (bootTimer) return bootTimer;
    bootTimer = setTimeout(() => {
      bootTimer = null;
      void (async () => {
        const result = await processBootCheck(getDataDir());
        checkState = {
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          updateAvailable: result.updateAvailable,
          lastCheckedAt: result.lastCheckedAt,
        };
        if (!(autoUpdateEnabled() && !isDevInstall() && checkState.updateAvailable)) return;
        const ver = checkState.latestVersion;
        if (!ver) return;
        // The notice fires ONLY once staging completed (a ready-to-apply package
        // sits on disk) — never upfront — so no "update available" nag runs
        // while the background stage does.
        const announceReady = () => {
          emitNotification('update ready', { kind: 'update-notice', version: ver, tone: 'info' });
        };
        if (isStagedComplete(ver)) { announceReady(); return; }
        try { spawnStagedInstall(ver); } catch { /* best-effort background stage */ }
        // Poll for completion, then announce once. Unref'd so it never holds the
        // process open; gives up silently after the cap (next launch retries).
        const startedAt = Date.now();
        const poll = setInterval(() => {
          if (isStagedComplete(ver)) {
            clearInterval(poll);
            announceReady();
          } else if (Date.now() - startedAt > STAGE_POLL_MAX_MS) {
            clearInterval(poll);
          }
        }, STAGE_POLL_MS);
        poll.unref?.();
      })().catch(() => {});
    }, 0);
    bootTimer.unref?.();
    return bootTimer;
  }

  function stopBootCheck() {
    if (!bootTimer) return;
    clearTimeout(bootTimer);
    bootTimer = null;
  }

  return {
    autoUpdateEnabled,
    checkForUpdate,
    runUpdateNow,
    getCheckState: () => checkState,
    getProcessState: () => processState,
    startBootCheck,
    stopBootCheck,
  };
}
