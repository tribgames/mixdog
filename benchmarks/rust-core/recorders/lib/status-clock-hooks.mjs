// Loader hooks of status-clock-preload.mjs: the daemon's one status scheduler (session-status-scheduler.mjs `sessionStatusScheduler`)
// is made on the preload's virtual clock and handed to it. The line replaced is checked: a tree where it reads otherwise fails the run.
const CREATED = 'daemonScheduler ??= createSessionStatusScheduler({ subscribeGlobalChanges: subscribeDaemonChanges });';

// The agent tool's status is empty until the keychain prewarm (real I/O) is done (agent-tool.mjs statusFor): each tool hands the
// preload its prewarm, which an order waits for before it moves the clock.
const PREWARM = '  let prewarmWatched = false;';

// A settings change reaches the sessions on the clock (status-clock-preload.mjs): the config-change debounce runs on its timers,
// and the pass, its effects and each notification's delivery are work an order waits for.
const CLOCK = 'globalThis.__mixdogRecStatusClock';
const REPLACED = {
  '/src/runtime/shared/config.mjs': [
    ['clearTimeout(_configChangeTimer);', `${CLOCK}.timers.clearTimeout(_configChangeTimer);`],
    // The watch's events are real I/O: an order waits until the watched bytes the last event saw are the bytes on disk.
    [
      "      dropConfigReadCache();\n      if (name !== USER_DATA_INIT_MARKER) notifyConfigChanged({ fromWatch: true });",
      `      dropConfigReadCache();\n      ${CLOCK}.config.seen(watchedContent());\n      if (name !== USER_DATA_INIT_MARKER) notifyConfigChanged({ fromWatch: true });`,
    ],
    ['  _configWatchStarts += 1;\n  _configWatcher = watcher;', `  _configWatchStarts += 1;\n  _configWatcher = watcher;\n  ${CLOCK}.config.watching(watchedContent);`],
    [
      '  _configChangeTimer = setTimeout(() => {\n    _configChangeTimer = null;\n    void runConfigChangeListeners();\n  }, CONFIG_CHANGE_DEBOUNCE_MS);',
      `  _configChangeTimer = ${CLOCK}.timers.setTimeout(() => {\n    _configChangeTimer = null;\n    ${CLOCK}.track(runConfigChangeListeners());\n  }, CONFIG_CHANGE_DEBOUNCE_MS);`,
    ],
  ],
  // A session's state change goes out on the projection's publish timer (real time, the display-frame clock): an order answers once
  // the publication it scheduled went out, or the entry was disposed.
  '/src/standalone/session-service/projection/frames.mjs': [
    [
      '    entry.timer = setTimeout(\n      () => {\n        entry.timer = null;\n        publish(entry);\n      },',
      `    let fired;\n    ${CLOCK}.track(new Promise((resolve) => (fired = resolve)));\n    entry.timer = setTimeout(\n      () => {\n        entry.timer = null;\n        try {\n          publish(entry);\n        } finally {\n          fired();\n        }\n      },`,
    ],
    ['    entry.timer.unref?.();', '    entry.timer.recFired = fired;\n    entry.timer.unref?.();'],
  ],
  // The session store coalesces its publications to a 16 ms frame (real time): the frame it scheduled is work an order waits for;
  // a frame cancelled (flushed early, disposed) counts as done.
  '/src/tui/session/frame-batched-store.mjs': [
    [
      '    timer = scheduleFrame(flush, frameMs);',
      `    let fired;\n    ${CLOCK}.track(new Promise((resolve) => (fired = resolve)));\n    timer = scheduleFrame(() => {\n      try {\n        flush();\n      } finally {\n        fired();\n      }\n    }, frameMs);\n    frameDone = fired;`,
    ],
    ['  let timer = null;\n  let emitPending = false;', '  let timer = null;\n  let frameDone = null;\n  let emitPending = false;'],
    ['    if (timer !== null) {\n      cancelFrame(timer);\n      timer = null;\n    }', '    if (timer !== null) {\n      cancelFrame(timer);\n      timer = null;\n      frameDone?.();\n    }'],
    ['    else if (timer !== null) cancelFrame(timer);', '    else if (timer !== null) {\n      cancelFrame(timer);\n      frameDone?.();\n    }'],
  ],
  '/src/standalone/session-service/entries/disposal.mjs': [['      clearTimeout(entry.timer);', '      entry.timer.recFired?.();\n      clearTimeout(entry.timer);']],
  // A session's config save is debounced on a real timer (createDebouncedWriter): an order first lands the saves accepted before it.
  '/src/session-runtime/config-lifecycle/config-writers.mjs': [
    ['export async function drainSessionConfigWrites() {', `${CLOCK}.drainWrites = () => drainSessionConfigWrites();\nexport async function drainSessionConfigWrites() {`],
  ],
  '/src/session-runtime/config-change-effects.mjs': [
    ['    return Promise.all(runs).then((results) => results.filter(Boolean));', `    return ${CLOCK}.track(Promise.all(runs).then((results) => results.filter(Boolean)));`],
  ],
  '/src/tui/session/agent-job-feed/notification-chain.mjs': [
    ['      .then(() => {\n        pendingCount -= 1;\n      });', `      .then(() => {\n        pendingCount -= 1;\n      });\n    ${CLOCK}.track(chain);`],
  ],
};

// Each frame stream the daemon makes hands the preload its broadcast, so an order's answer ends with a marker frame every attached
// client reads after the publications the order's passes made (one stream, in order; a paused client's queue keeps that order).
const STREAM = '  function attachSse(token, res) {';

export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (url.endsWith('/src/standalone/session-frame-stream.mjs')) {
    const source = String(loaded.source);
    if (!source.includes(STREAM)) throw new Error(`status-clock: ${url} no longer declares: ${STREAM}`);
    return { ...loaded, source: source.replace(STREAM, `  ${CLOCK}.streams.add(broadcast);\n${STREAM}`) };
  }
  const replaced = Object.entries(REPLACED).find(([path]) => url.endsWith(path));
  if (replaced) {
    const [path, pairs] = replaced;
    let source = String(loaded.source).replaceAll('\r\n', '\n');
    for (const [from, to] of pairs) {
      if (!source.includes(from)) throw new Error(`status-clock: ${path} no longer reads: ${from}`);
      source = source.replaceAll(from, to);
    }
    return { ...loaded, source };
  }
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
