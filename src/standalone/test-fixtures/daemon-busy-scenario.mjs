// The busy-sessions scenario of scripts/daemon-load-bench.mjs: what a v1.4.5
// user reported as event-loop stalls that grew with the number of busy
// sessions. Against a running (seeded, see daemon-busy-seed.mjs) daemon it
// drives, through the daemon's own client protocol only:
//   - saves: every busy session's multi-MB record is rewritten again and again
//     (`session.configure` renameSessionTitle -> the store's awaited save), all
//     sessions concurrently;
//   - `session.list` with a storage refresh, plain and with the include-agent
//     flag (the service pins that flag to false in both releases, so the
//     variant is measured, and its rows compared, rather than assumed);
//   - a second process (this one) holding `session-summaries.json.lock` for a
//     few seconds at intervals;
//   - workspace management/retention on a git repo (listWorktrees,
//     previewWorktreeCleanup, pruneWorktrees) where the tree's session
//     protocol has the action; otherwise the operation is skipped and marked.
// and measures its latency from this side. The daemon-side numbers (delay
// histogram, ELU, CPU, sync fs, gap ticker) come from the probe window.
import { statSync } from 'node:fs';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { NO_DEADLINE_MS } from './daemon-steady-harness.mjs';

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** Latency summary of one operation kind (ms, measured by the caller). */
export function latency(bucket) {
  const sorted = [...bucket.ms].sort((a, b) => a - b);
  return {
    completed: bucket.ms.length,
    errors: bucket.errors,
    ...(bucket.firstError ? { firstError: bucket.firstError } : {}),
    ...(bucket.noops ? { notApplied: bucket.noops } : {}),
    p50Ms: sorted.length ? round(percentile(sorted, 0.5)) : null,
    p95Ms: sorted.length ? round(percentile(sorted, 0.95)) : null,
    maxMs: sorted.length ? round(sorted[sorted.length - 1]) : null,
    totalMs: round(bucket.ms.reduce((sum, ms) => sum + ms, 0)),
    // Cut by the window's end, not failed. `elapsedMs` is each one's time
    // observed when the wait gave up (after any late answer returned);
    // `windowBoundedMs` is its time up to the window end, for reference only.
    ...(bucket.censored.length
      ? {
          censored: {
            count: bucket.censored.length,
            elapsedMs: bucket.censored.map(({ observedMs }) => round(observedMs)),
            windowBoundedMs: bucket.censored.map(({ windowBoundedMs }) => round(windowBoundedMs)),
          },
        }
      : {}),
    // Samples that ended after the window did: their real (observed) duration
    // is already in the figures above; the window-bounded one is shown beside it.
    ...(bucket.spanning.length
      ? {
          spanningWindowEnd: {
            count: bucket.spanning.length,
            observedMs: bucket.spanning.map(({ observedMs }) => round(observedMs)),
            windowBoundedMs: bucket.spanning.map(({ windowBoundedMs }) => round(windowBoundedMs)),
          },
        }
      : {}),
    // Started after the window had ended (a chained follow-up should not be):
    // counted apart, never part of the figures above.
    ...(bucket.lateStarts.length
      ? {
          startedAfterWindow: {
            count: bucket.lateStarts.length,
            observedMs: bucket.lateStarts.map(({ observedMs }) => round(observedMs)),
          },
        }
      : {}),
    // The slowest seen, finished or still running when the wait gave up.
    longestObservedMs: round(Math.max(0, ...bucket.ms, ...bucket.censored.map(({ observedMs }) => observedMs))),
    ...(bucket.rows ? { rows: bucket.rows } : {}),
  };
}

// `censored`: operations still running when the window ended; `spanning`:
// finished ones that ended after it. `windowEnd` is set once the window is open.
export const newBucket = () => ({
  ms: [],
  censored: [],
  spanning: [],
  lateStarts: [],
  windowEnd: null,
  errors: 0,
  firstError: null,
  noops: 0,
  rows: null,
});

/** The part of [startedAt, windowEnd] that exists: never negative. */
const overlapMs = (windowEnd, startedAt) => Math.max(0, windowEnd - startedAt);

/**
 * Records a finished sample: its real duration, and a note when it ended after
 * the window. Something that *started* after the window is not a window sample:
 * it is counted apart (`startedAfterWindow`) and kept out of the figures.
 */
export function sample(bucket, startedAt, endedAt = performance.now()) {
  if (bucket.windowEnd !== null && startedAt >= bucket.windowEnd) {
    bucket.lateStarts.push({ observedMs: endedAt - startedAt });
    return;
  }
  bucket.ms.push(endedAt - startedAt);
  if (bucket.windowEnd !== null && endedAt > bucket.windowEnd) {
    bucket.spanning.push({ observedMs: endedAt - startedAt, windowBoundedMs: overlapMs(bucket.windowEnd, startedAt) });
  }
}

async function timed(bucket, call) {
  const startedAt = performance.now();
  try {
    const value = await call();
    sample(bucket, startedAt);
    return value;
  } catch (error) {
    bucket.errors += 1;
    bucket.firstError ??= String(error?.message || error).slice(0, 240);
    return undefined;
  }
}

/** Whole-machine CPU (all cores) sampled once a second from the OS counters. */
function startSystemSampler(intervalMs = 1000) {
  const snapshot = () =>
    os.cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 }
    );
  const busyPercent = (from, to) => (to.total > from.total ? 100 * (1 - (to.idle - from.idle) / (to.total - from.total)) : 0);
  const first = snapshot();
  let previous = first;
  const samples = [];
  const timer = setInterval(() => {
    const current = snapshot();
    samples.push(busyPercent(previous, current));
    previous = current;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        cores: os.cpus().length,
        avgPercent: round(busyPercent(first, snapshot())),
        p95Percent: sorted.length ? round(percentile(sorted, 0.95)) : null,
        maxPercent: sorted.length ? round(sorted[sorted.length - 1]) : null,
        samples: samples.length,
        // Always 0 on Windows.
        loadAverage: os.loadavg().map((value) => round(value, 2)),
      };
    },
  };
}

/** Holds `<data>/session-summaries.json.lock` the way the store's file lock
 *  publishes it (a staged owner record linked into place), for `holdMs` every
 *  `everyMs`, for as long as `until()` allows. */
async function holdSummaryLock({ lockPath, holdMs, everyMs, firstDelayMs, until, remainingMs, signal }) {
  const stats = { holds: 0, heldMs: 0, maxAcquireWaitMs: 0 };
  const sleep = (ms) => delay(ms, undefined, { signal }).catch(() => {});
  await sleep(firstDelayMs);
  while (until()) {
    const token = `${process.pid} ${Date.now()} bench-lock-holder\n`;
    const staged = `${lockPath}.${process.pid}.bench.tmp`;
    await writeFile(staged, token);
    const waitStartedAt = performance.now();
    let held = false;
    try {
      while (until() && !held) {
        try {
          await link(staged, lockPath);
          held = true;
        } catch (error) {
          if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
          await sleep(20);
        }
      }
    } finally {
      await unlink(staged).catch(() => {});
    }
    if (!held) break;
    const heldAt = performance.now();
    stats.maxAcquireWaitMs = Math.max(stats.maxAcquireWaitMs, round(heldAt - waitStartedAt));
    try {
      // A hold never outlasts the measured window (or an abort).
      await sleep(Math.min(holdMs, Math.max(0, remainingMs())));
    } finally {
      // Never leave the lock behind, whatever ended the hold.
      if ((await readFile(lockPath, 'utf8').catch(() => '')) === token) await unlink(lockPath).catch(() => {});
    }
    stats.holds += 1;
    stats.heldMs += round(performance.now() - heldAt);
    await sleep(Math.min(Math.max(0, everyMs - holdMs), Math.max(0, remainingMs())));
  }
  return stats;
}

/**
 * Waits until the daemon reports the turn carrying `token` complete: the
 * session's transcript holds a `turndone` row after the user row with the
 * token (written once the turn ended and was recorded). `getTurnLiveness`
 * (null once no turn runs) is the cheap poll; the transcript is read when it
 * drops to null, or at most every 250 ms before the turn was seen live. Both
 * are public read calls of both trees.
 *
 * There is no deadline: a turn is timed until it completes, however long a
 * stalled daemon takes. The only other ends are the scenario window (`windowEnd`:
 * the turn is censored) and an abort (the failure path). A censored turn's `ms`
 * is the time observed when the wait gave up (after any late read returned),
 * so a stall that spans the window end is not cut at the window; the
 * window-bounded figure is `windowBoundedMs`. Resolves `{ outcome, ms }`,
 * outcome being the `turndone` row's status ('done', 'failed', ...),
 * 'censored' or 'cancelled'.
 */
export async function waitForTurnDone({
  client,
  sessionId,
  token,
  startedAt,
  windowEnd,
  signal = null,
  now = () => performance.now(),
  pause = (ms) => delay(ms, undefined, { signal }).catch(() => {}),
}) {
  let sawLive = false;
  let lastRead = -Infinity;
  for (;;) {
    if (signal?.aborted) return { outcome: 'cancelled', ms: now() - startedAt };
    const live = (await client.call('session.read', { sessionId, action: 'getTurnLiveness', args: [] }))?.value ?? null;
    if (live) sawLive = true;
    if (!live && (sawLive || now() - lastRead >= 250)) {
      lastRead = now();
      const view = await client.call('session.read', { sessionId });
      const items = view?.full?.items ?? [];
      const asked = items.findLastIndex((item) => item?.kind === 'user' && String(item.text ?? '').includes(token));
      const ended = asked < 0 ? null : items.slice(asked + 1).find((item) => item?.kind === 'turndone');
      if (ended) return { outcome: String(ended.status ?? 'done'), ms: now() - startedAt };
    }
    // Checked after the reads, so a completion a late answer reveals still counts.
    // The elapsed time is measured now, after any late read returned; the
    // window-bounded figure rides along but never replaces it.
    const observedAt = now();
    if (observedAt >= windowEnd) {
      return { outcome: 'censored', ms: observedAt - startedAt, windowBoundedMs: Math.max(0, windowEnd - startedAt) };
    }
    await pause(40);
  }
}

/**
 * @param {object} options
 * @param {object} options.daemon  launchObservedDaemon result
 * @param {string} options.treeRoot
 * @param {object} options.seeded  seedBusyStore result
 * @param {string} options.repoDir  git repository for the workspace operations
 * @param {object} options.config  { durationMs, saveIntervalMs, listIntervalMs, workspaceIntervalMs, lockHoldMs, lockEveryMs, seed }
 * @param {number} [options.cleanupProbeDeadlineMs]  test-only override of CLEANUP_PROBE_DEADLINE_MS
 * @param {Function} options.summarize  probe report -> summary (the driver's)
 */
export async function runBusyScenario(options) {
  // Everything that keeps running or holds something outside this function,
  // so a failure anywhere after setup still stops all of it.
  const resources = { abort: new AbortController(), sampler: null, workload: [], lock: null, windowOpen: false };
  let failure = null;
  try {
    return await measureBusy(options, resources);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    resources.abort.abort();
    resources.sampler?.stop();
    // In-flight calls are not waited for past a few seconds (the driver
    // disposes the daemon next, which closes their connections).
    const grace = new AbortController();
    await Promise.race([
      Promise.allSettled([...resources.workload, resources.lock]),
      delay(5000, undefined, { signal: grace.signal }).catch(() => {}),
    ]);
    grace.abort();
    if (resources.windowOpen) {
      resources.windowOpen = false;
      const unanswered = await closeWindowAfterFailure(options.daemon, options.cleanupProbeDeadlineMs);
      // The run is already failing; the error carries what the cleanup saw.
      if (unanswered && failure && typeof failure === 'object') Object.assign(failure, unanswered);
    }
  }
}

/** Longer than the supervisor's freeze limit (DAEMON_FREEZE_LIMIT_MS, 120 s in
 *  session-runtime/services/daemon-candidate.mjs): a stall the supervisor
 *  itself would tolerate is never cut short. */
export const CLEANUP_PROBE_DEADLINE_MS = 150_000;

/** Failure path only: ask the probe to stop the window it still has open, so a
 *  broken run can reach the driver's `daemon.dispose()`. The measured path never
 *  uses a deadline (a long stall is a result). When the probe does not answer
 *  within the deadline its connection is closed and the wait is reported.
 *  `deadlineMs` is overridable for tests only. */
async function closeWindowAfterFailure(daemon, deadlineMs = CLEANUP_PROBE_DEADLINE_MS) {
  const timer = new AbortController();
  const startedAt = performance.now();
  try {
    await Promise.race([
      daemon.window.stop(),
      delay(deadlineMs, undefined, { signal: timer.signal }).then(() => {
        throw Object.assign(new Error('unanswered'), { unanswered: true });
      }),
    ]);
    return null;
  } catch (error) {
    if (!error?.unanswered) return null;
    daemon.window.close();
    return { cleanupProbeUnanswered: true, cleanupProbeWaitedMs: Math.round(performance.now() - startedAt) };
  } finally {
    timer.abort();
  }
}

/** One probe request, timed, with no deadline: its round trip is a result. */
async function timedProbeRequest(request) {
  const startedAt = performance.now();
  const answer = await request();
  return { answer, ms: Math.round(performance.now() - startedAt) };
}

async function measureBusy(
  { daemon, treeRoot, seeded, repoDir, config, summarize, fake = null },
  resources
) {
  const { signal } = resources.abort;
  const protocol = await import(pathToFileURL(join(treeRoot, 'src/standalone/session-protocol.mjs')).href);
  const hasRead = (action) => protocol.SESSION_READ_ACTION_SET?.has(action) === true;
  const hasConfigure = (action) => protocol.SESSION_CONFIGURE_ACTION_SET?.has(action) === true;
  const skipped = {};
  const requireAction = (name, present) => {
    if (!present) skipped[name] = 'action is not in this tree\'s session protocol';
    return present;
  };
  const doSaves = requireAction('save', hasConfigure('renameSessionTitle'));
  const workspaceOps = [
    ['listWorktrees', requireAction('listWorktrees', hasRead('listWorktrees')), 'session.read'],
    ['previewWorktreeCleanup', requireAction('previewWorktreeCleanup', hasRead('previewWorktreeCleanup')), 'session.read'],
    ['pruneWorktrees', requireAction('pruneWorktrees', hasConfigure('pruneWorktrees')), 'session.configure'],
  ].filter(([, present]) => present);
  const doWorktrees = requireAction('requestWorktree', hasConfigure('requestWorktree'));
  const doAgents = requireAction('agentControl', hasConfigure('agentControl'));
  const doTurns = fake !== null && config.turnIntervalMs > 0;
  if (!doTurns) skipped.turns = 'no scripted provider (fake endpoint disabled)';
  if (!doAgents) skipped.agentRehydrationListing = skipped.agentControl;

  // Setup (not measured): a control session per busy session, one for the
  // workspace calls, and one warm-up pass so the store is in its running state.
  const busyRows = seeded.busy;
  // Every call of the run waits for its answer however long the daemon takes
  // (the client's own default would give up after 300 s): a slow call is a
  // sample, never an error.
  const patient = (client) => ({
    call: (name, args, options) => client.call(name, args, { timeoutMs: NO_DEADLINE_MS, ...options }),
  });
  const sessionClientOf = (sessionId) => patient(daemon.sessionClient(sessionId));
  const controlIds = await daemon.openSessions(busyRows.length);
  const [workspaceId] = await daemon.openSessions(1, { cwd: repoDir });
  const listClient = patient(await daemon.attach());
  // The desktop's sidebar listing (session-host.ts listSessions): the ordinary
  // catalog, answered by the catalog DB worker, never a storage rescan.
  const desktopList = () => listClient.call('session.list', { refreshFromStorage: false });
  // The TUI resume picker's listing: an authoritative rescan of every record
  // (`--list-refresh`, optional).
  const listCall = (extra) => listClient.call('session.list', { refreshFromStorage: true, ...extra });
  const warmupStartedAt = performance.now();
  await desktopList();
  await Promise.all(
    busyRows.map((row, index) =>
      doSaves
        ? sessionClientOf(controlIds[index]).call('session.configure', {
            sessionId: controlIds[index],
            action: 'renameSessionTitle',
            args: [row.id, `busy ${index} warm-up`],
          })
        : null
    )
  );
  const warmupMs = Math.round(performance.now() - warmupStartedAt);

  const buckets = {
    save: newBucket(),
    list: newBucket(),
    ...(config.listRefresh ? { listRefresh: newBucket(), listRefreshIncludeAgent: newBucket() } : {}),
    ...Object.fromEntries(workspaceOps.map(([name]) => [name, newBucket()])),
    sessionCreate: newBucket(),
    workspaceSessionCreate: newBucket(),
    requestWorktree: newBucket(),
    turnSubmit: newBucket(),
    turnEndToEnd: newBucket(),
    agentFirstCall: newBucket(),
    agentList: newBucket(),
    agentSpawn: newBucket(),
  };
  const createParams = (cwd, extra = {}) => ({
    cwd,
    provider: 'openai',
    model: 'gpt-4o-mini',
    toolMode: 'full',
    remote: false,
    desktopSession: null,
    ...extra,
  });
  const jitter = (() => {
    let state = (config.seed >>> 0) || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })();

  const system = startSystemSampler();
  resources.sampler = system;
  const cpuBefore = process.cpuUsage();
  const wallStartedAt = performance.now();
  const probeStartMs = (await timedProbeRequest(() => daemon.window.start({ ticker: true }))).ms;
  resources.windowOpen = true;
  const windowStartedAt = performance.now();
  const deadline = windowStartedAt + config.durationMs;
  for (const bucket of Object.values(buckets)) bucket.windowEnd = deadline;
  const running = () => !signal.aborted && performance.now() < deadline;
  const loop = async (firstDelayMs, intervalMs, body) => {
    // Waits never run past the window, so it lasts `durationMs` plus the
    // operations still in flight; an abort ends them at once.
    const wait = (ms) =>
      delay(Math.min(ms, Math.max(0, deadline - performance.now())), undefined, { signal }).catch(() => {});
    await wait(firstDelayMs);
    for (let n = 1; running(); n += 1) {
      await body(n);
      await wait(intervalMs);
    }
  };

  // The finalizer in runBusyScenario settles these, so loops started before a
  // later setup step fails are stopped too.
  const loops = resources.workload;
  if (doSaves) {
    busyRows.forEach((row, index) =>
      loops.push(
        loop(jitter() * config.saveIntervalMs, config.saveIntervalMs, async (n) => {
          const value = await timed(buckets.save, () =>
            sessionClientOf(controlIds[index]).call('session.configure', {
              sessionId: controlIds[index],
              action: 'renameSessionTitle',
              args: [row.id, `busy ${index} save ${n}`],
            })
          );
          if (value !== undefined && value?.value !== true) buckets.save.noops += 1;
        })
      )
    );
  }
  const rowCounts = {};
  loops.push(
    loop(jitter() * config.listIntervalMs, config.listIntervalMs, async () => {
      const listed = await timed(buckets.list, desktopList);
      if (listed) rowCounts.list = listed.sessions?.length ?? 0;
    })
  );
  if (config.listRefresh) {
    for (const [name, extra] of [
      ['listRefresh', {}],
      ['listRefreshIncludeAgent', { includeAgentOnly: true }],
    ]) {
      loops.push(
        loop(jitter() * config.listIntervalMs, config.listIntervalMs, async () => {
          const listed = await timed(buckets[name], () => listCall(extra));
          if (listed) rowCounts[name] = listed.sessions?.length ?? 0;
        })
      );
    }
  }
  const workspaceClient = workspaceOps.length ? sessionClientOf(workspaceId) : null;
  if (workspaceOps.length) {
    loops.push(
      loop(jitter() * config.workspaceIntervalMs, config.workspaceIntervalMs, async (n) => {
        const [name, , route] = workspaceOps[(n - 1) % workspaceOps.length];
        await timed(buckets[name], () =>
          workspaceClient.call(route, {
            sessionId: workspaceId,
            action: name,
            args: name === 'listWorktrees' ? [] : [{ repoCommonDir: join(repoDir, '.git') }],
          })
        );
      })
    );
  }
  const createClient = patient(await daemon.attach());
  // Concurrent session creation: the report's worst stalls end with
  // "session created".
  loops.push(
    loop(jitter() * config.createIntervalMs, config.createIntervalMs, () =>
      timed(buckets.sessionCreate, () => createClient.call('session.create', createParams(daemon.root)))
    )
  );
  // Workspace admission: a session in the git repo asks for a worktree
  // (creation, admission ledger, retention) and is left bound to it.
  if (doWorktrees && config.worktreeIntervalMs > 0) {
    loops.push(
      loop(jitter() * config.worktreeIntervalMs, config.worktreeIntervalMs, async (n) => {
        const created = await timed(buckets.workspaceSessionCreate, () =>
          createClient.call('session.create', createParams(repoDir))
        );
        // A follow-up is not started once the window has ended (a slow create
        // can finish after it): never started, so not a sample.
        if (!created?.sessionId || !running()) return;
        await timed(buckets.requestWorktree, () =>
          createClient.call('session.configure', {
            sessionId: created.sessionId,
            action: 'requestWorktree',
            args: [{ provision: true, name: `bench-${n}`, prompt: `bench worktree ${n}`, txId: `bench-tx-${n}`, carryChanges: 'leave' }],
          })
        );
      })
    );
  }
  // Running turns on the busy sessions (cwd = the git repo, so each turn also
  // passes workspace admission), answered by the scripted provider.
  if (doTurns) {
    busyRows.forEach((row, index) =>
      loops.push(
        loop(jitter() * config.turnIntervalMs, config.turnIntervalMs, async (n) => {
          const token = `BENCH-TURN-${index}-${n}`;
          const startedAt = performance.now();
          const accepted = await timed(buckets.turnSubmit, () =>
            sessionClientOf(controlIds[index]).call('session.submit', {
              sessionId: row.id,
              prompt: `continue the work ${token}`,
            })
          );
          if (accepted === undefined) return;
          if (accepted?.accepted !== true) buckets.turnSubmit.noops += 1;
          const { outcome, ms, windowBoundedMs } = await waitForTurnDone({
            client: sessionClientOf(controlIds[index]),
            sessionId: row.id,
            token,
            startedAt,
            windowEnd: deadline,
            signal,
          });
          if (outcome === 'done') sample(buckets.turnEndToEnd, startedAt, startedAt + ms);
          else if (outcome === 'censored') buckets.turnEndToEnd.censored.push({ observedMs: ms, windowBoundedMs });
          else if (outcome !== 'cancelled') {
            buckets.turnEndToEnd.errors += 1;
            buckets.turnEndToEnd.firstError ??= `turn ended ${outcome}`;
          }
        })
      )
    );
  }
  // The agent-including listing: any agent tool call first rehydrates agent
  // sessions from storage (listSessions includeAgentOnly), once per daemon;
  // then list and spawn (a sub-agent session created and run by the daemon).
  if (doAgents) {
    const agentClient = sessionClientOf(controlIds[0]);
    const agentCall = (args) =>
      agentClient.call('session.configure', { sessionId: controlIds[0], action: 'agentControl', args: [args] });
    loops.push(
      loop(0, config.agentIntervalMs, async (n) => {
        await timed(n === 1 ? buckets.agentFirstCall : buckets.agentList, () => agentCall({ type: 'list' }));
        if (doTurns && n % 2 === 0 && running()) {
          await timed(buckets.agentSpawn, () =>
            agentCall({
              type: 'spawn',
              provider: 'custom-bench',
              model: 'bench-model',
              prompt: `BENCH-AGENT-${n} summarize the repository`,
            })
          );
        }
      })
    );
  }
  const lockLoop = holdSummaryLock({
    lockPath: join(daemon.dataDir, 'session-summaries.json.lock'),
    holdMs: config.lockHoldMs,
    everyMs: config.lockEveryMs,
    firstDelayMs: Math.min(config.lockEveryMs, config.durationMs) / 2,
    until: running,
    remainingMs: () => deadline - performance.now(),
    signal,
  });
  resources.lock = lockLoop;
  await Promise.all(loops);
  const summariesLock = await lockLoop;
  const drainedMs = Math.round(performance.now() - windowStartedAt);
  resources.windowOpen = false;
  // No deadline: a daemon stalled for 60 s answers after 60 s and that round
  // trip is recorded (`probeStopMs`) next to the gap ticker's numbers.
  const { answer: probeReport, ms: probeStopMs } = await timedProbeRequest(() => daemon.window.stop());
  const wallMs = Math.round(performance.now() - wallStartedAt);
  const systemCpu = system.stop();
  const cpu = process.cpuUsage(cpuBefore);
  // The daemon's own account of the run, for cross-checking the numbers above.
  const logLines = daemon.daemonLog().split('\n');
  const matching = (pattern) => logLines.filter((line) => pattern.test(line));
  const stalls = matching(/event loop stalled/);
  const summaryLock = matching(/session-summaries\.json\.lock/);

  for (const name of ['list', 'listRefresh', 'listRefreshIncludeAgent']) {
    if (buckets[name]) buckets[name].rows = rowCounts[name] ?? null;
  }
  const results = Object.fromEntries(Object.entries(buckets).map(([name, bucket]) => [name, latency(bucket)]));
  const completed = Object.values(results).reduce((sum, result) => sum + result.completed, 0);
  const machinePercent = (coresPercent) => round(coresPercent / systemCpu.cores);
  const daemonOfMachine = machinePercent(probeReport.cpuPercent);
  const driverOfMachine = machinePercent(((cpu.user + cpu.system) / 1000 / drainedMs) * 100);
  return {
    config,
    skipped,
    warmupMs,
    windowMs: drainedMs,
    // Round trip of the probe's own start/stop requests. A daemon stalled when
    // `stop` arrives answers late: that shows here, next to the gap ticker.
    probeStartMs,
    probeStopMs,
    wallMs,
    operations: {
      ...results,
      completedTotal: completed,
      completedPerSecond: round(completed / (drainedMs / 1000), 2),
      ...(config.listRefresh
        ? { includeAgentVariantReturnsSameRows: rowCounts.listRefresh === rowCounts.listRefreshIncludeAgent }
        : {}),
    },
    scriptedProvider: fake ? { ...fake.stats } : null,
    turnCompletion: doTurns
      ? {
          signal: 'turndone row in the session transcript (session.read), after getTurnLiveness drops to null',
          resolutionMs: 40,
        }
      : null,
    admissionLedger: (() => {
      try {
        return { bytes: statSync(join(repoDir, '.git', 'mixdog-workspace-admission.json')).size };
      } catch {
        return { bytes: null };
      }
    })(),
    summariesLockHolder: { ...summariesLock, holdMs: config.lockHoldMs, everyMs: config.lockEveryMs },
    eventLoop: summarize(probeReport),
    gapTicker: probeReport.gapTicker,
    daemonLog: {
      eventLoopStalledLines: stalls.length,
      summaryLockLines: summaryLock.length,
      sample: [...stalls.slice(0, 3), ...summaryLock.slice(0, 3)].map((line) => line.slice(0, 240)),
    },
    system: {
      ...systemCpu,
      daemonPercentOfMachine: daemonOfMachine,
      driverPercentOfMachine: driverOfMachine,
      // Everything else running on the machine; a run with this high is not
      // comparable with one taken on an idle PC.
      competingPercentOfMachine: round(Math.max(0, systemCpu.avgPercent - daemonOfMachine - driverOfMachine)),
    },
  };
}
