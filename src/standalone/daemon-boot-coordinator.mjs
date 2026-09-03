/**
 * Keeps daemon control-plane readiness separate from opportunistic runtime
 * work. Desktop clients open the background lane only after desktop.init and
 * the first state resync; non-Desktop session clients have no extra handshake,
 * so their completed registration is the ready boundary.
 */
export function createDaemonBootCoordinator({
  prewarmKeychain,
  recoverActiveGoals,
  // Catalog module imports (session summaries, projects) cost ~1.1s cold and
  // used to land on the FIRST rail click. They ride the background lane
  // after Goal recovery, behind a short delay so the user's first action —
  // typically a New Task submit — never contends with them (putting them on
  // the boot path itself cost that submit ~90ms).
  prewarmCatalogs = null,
  catalogDelayMs = 1_500,
  measure = async (_phase, task) => await task(),
  schedule = (task) => setImmediate(task),
  delay = (task, ms) => setTimeout(task, ms),
  log = () => {},
} = {}) {
  if (typeof prewarmKeychain !== 'function') {
    throw new TypeError('prewarmKeychain is required');
  }
  if (typeof recoverActiveGoals !== 'function') {
    throw new TypeError('recoverActiveGoals is required');
  }

  let keychainPromise = null;
  let keychainScheduled = false;
  let backgroundPromise = null;
  let backgroundScheduled = false;

  function ensureKeychain() {
    keychainPromise ??= Promise.resolve()
      .then(prewarmKeychain)
      .catch((error) => {
        keychainPromise = null;
        log(`keychain prewarm failed (non-fatal): ${error?.message || error}`);
      });
    return keychainPromise;
  }

  function scheduleKeychain() {
    if (keychainScheduled || keychainPromise) return;
    keychainScheduled = true;
    schedule(() => {
      keychainScheduled = false;
      void ensureKeychain();
    });
  }

  function startBackground() {
    backgroundPromise ??= (async () => {
      await ensureKeychain();
      const result = await measure('active-goal-recovery', recoverActiveGoals);
      log(
        `active Goal recovery found=${result.found} resumed=${result.resumed}`
        + ` skipped=${result.skipped} failed=${result.failed}`,
      );
      if (typeof prewarmCatalogs === 'function') {
        await new Promise((resolve) => delay(resolve, catalogDelayMs));
        await measure('catalog-prewarm', prewarmCatalogs).catch((error) => {
          log(`catalog prewarm failed (non-fatal): ${error?.message || error}`);
        });
      }
      return result;
    })().catch((error) => {
      log(`active Goal recovery failed: ${error?.message || error}`);
      return null;
    });
    return backgroundPromise;
  }

  function scheduleBackground() {
    if (backgroundScheduled || backgroundPromise) return;
    backgroundScheduled = true;
    schedule(() => {
      backgroundScheduled = false;
      void startBackground();
    });
  }

  return {
    notifyClientRegistered({ clientKind = 'session' } = {}) {
      if (clientKind === 'desktop') {
        scheduleKeychain();
        return;
      }
      scheduleBackground();
    },
    notifyDesktopReady() {
      scheduleBackground();
      return { ok: true };
    },
    get status() {
      return {
        keychain: keychainPromise ? 'started' : keychainScheduled ? 'scheduled' : 'idle',
        background: backgroundPromise ? 'started' : backgroundScheduled ? 'scheduled' : 'idle',
      };
    },
  };
}
