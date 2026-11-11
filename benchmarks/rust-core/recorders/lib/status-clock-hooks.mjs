// Loader hooks of status-clock-preload.mjs: the daemon's one status scheduler (session-status-scheduler.mjs `sessionStatusScheduler`)
// is made on the preload's virtual clock and handed to it. The line replaced is checked: a tree where it reads otherwise fails the run.
const CREATED = 'daemonScheduler ??= createSessionStatusScheduler({ subscribeGlobalChanges: subscribeDaemonChanges });';

// The agent tool's status is empty until the keychain prewarm (real I/O) is done (agent-tool.mjs statusFor): each tool hands the
// preload its prewarm, which an order waits for before it moves the clock.
const PREWARM = '  let prewarmWatched = false;';

export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (url.endsWith('/src/session-runtime/services/agent-tool.mjs')) {
    const source = String(loaded.source);
    if (!source.includes(PREWARM)) throw new Error(`status-clock: ${url} no longer declares: ${PREWARM}`);
    return { ...loaded, source: source.replace(PREWARM, `${PREWARM}\n  globalThis.__mixdogRecStatusClock.prewarms.add(() => awaitKeychainPrewarm());`) };
  }
  if (!url.endsWith('/src/standalone/session-status-scheduler.mjs')) return loaded;
  const source = String(loaded.source);
  if (!source.includes(CREATED)) throw new Error(`status-clock: ${url} no longer makes its scheduler with: ${CREATED}`);
  return {
    ...loaded,
    source: source.replace(
      CREATED,
      'daemonScheduler ??= createSessionStatusScheduler({ subscribeGlobalChanges: subscribeDaemonChanges, now: globalThis.__mixdogRecStatusClock.now, timers: globalThis.__mixdogRecStatusClock.timers }); globalThis.__mixdogRecStatusClock.scheduler = daemonScheduler;'
    ),
  };
}
