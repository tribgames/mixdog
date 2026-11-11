// Loader hooks of status-clock-preload.mjs: the daemon's one status scheduler (session-status-scheduler.mjs `sessionStatusScheduler`)
// is made on the preload's virtual clock and handed to it. The line replaced is checked: a tree where it reads otherwise fails the run.
const CREATED = 'daemonScheduler ??= createSessionStatusScheduler({ subscribeGlobalChanges: subscribeDaemonChanges });';

export async function load(url, context, next) {
  const loaded = await next(url, context);
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
