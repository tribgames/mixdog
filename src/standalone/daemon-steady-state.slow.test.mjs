// The daemon's main thread at rest. The freezes of the renewal came from
// periodic refresh work and synchronous filesystem reads on hot paths; both are
// event-driven now. A real daemon (launched the way a session client launches
// it, under its supervisor when one is built) hosts several idle sessions and
// then idles for a few seconds; the probe in the daemon records every
// synchronous node:fs call and every timer callback of that window
// (test-fixtures/daemon-steady-entry.mjs).
//
// Slow lane: a daemon boot plus a settle and a window is well past 10 s.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launchObservedDaemon } from './test-fixtures/daemon-steady-harness.mjs';

const SESSIONS = 6;
const WINDOW_MS = 5000;
const SETTLE_WINDOW_MS = 1000;
const SETTLE_LIMIT_MS = 30_000;

// What may run on the main thread at rest, by call site.
const SUPERVISOR_LINK = /daemon-supervisor-link\.mjs:/;
// The one unref'd 30 s diagnostics loop, and the lag-profile flag it checks
// (an existsSync per tick). A window of a few seconds meets it only by chance.
const DIAGNOSTICS_TICK = /daemon-(telemetry|lag-profiler)\.mjs:/;

/** What a window saw that a daemon at rest must not do. */
function violations(report) {
  const found = [];
  for (const { method, site, count } of report.syncFs) {
    // The supervisor link answers each ping on fd 1 (its stdin handling).
    if (SUPERVISOR_LINK.test(site) && method === 'writeSync') continue;
    if (DIAGNOSTICS_TICK.test(site)) continue;
    found.push(`sync fs: ${method} x${count} at ${site}`);
  }
  for (const timer of report.timers) {
    if (DIAGNOSTICS_TICK.test(timer.site) || SUPERVISOR_LINK.test(timer.site)) continue;
    // An exact-deadline timer that is due fires once; a loop fires again.
    if (timer.kind === 'interval') found.push(`setInterval(${timer.delay}ms) fired x${timer.fires} at ${timer.site}`);
    else if (timer.chainFires > 1) {
      found.push(`setTimeout(${timer.delay}ms) re-armed itself ${timer.chainFires}x at ${timer.site}`);
    }
  }
  for (const { site, count } of report.promiseTimers) {
    if (count > 1) found.push(`timers/promises.setTimeout completed x${count} at ${site}`);
  }
  return found;
}

async function observe(daemon, ms) {
  await daemon.window.start();
  await delay(ms);
  return daemon.window.stop();
}

/** Startup tails (module loads, warmups) end by themselves: the window that
 *  counts opens after two quiet ones in a row. */
async function settle(daemon) {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let quiet = 0;
  let last = [];
  while (quiet < 2 && Date.now() < deadline) {
    last = violations(await observe(daemon, SETTLE_WINDOW_MS));
    quiet = last.length === 0 ? quiet + 1 : 0;
  }
  assert.equal(quiet, 2, `the daemon never settled; the last window: ${last.join('; ')}`);
}

test('an idle daemon hosting sessions runs no sync fs call and no periodic timer', async (t) => {
  // MIXDOG_STEADY_STATE_MUTATION=<module> loads that module into the daemon
  // first: how to see this test fail on a re-added poll.
  const daemon = await launchObservedDaemon({ mutation: process.env.MIXDOG_STEADY_STATE_MUTATION || '' });
  t.after(() => daemon.dispose());
  const sessionIds = await daemon.openSessions(SESSIONS);
  assert.equal(new Set(sessionIds).size, SESSIONS);
  await settle(daemon);

  const report = await observe(daemon, WINDOW_MS);
  const found = violations(report);
  t.diagnostic(
    `window ${report.elapsedMs}ms: ${report.syncFs.length} sync-fs sites, ${report.timers.length} timer sites, ` +
      `utilization ${(report.utilization * 100).toFixed(2)}%, delay p99 ${report.delayMs.p99}ms`
  );
  assert.deepEqual(found, [], `the daemon did periodic or synchronous work at rest:\n${found.join('\n')}`);
});

test('the probe catches a re-added periodic statSync', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-steady-mutation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mutation = join(dir, 'poll.mjs');
  writeFileSync(
    mutation,
    "import { statSync } from 'node:fs';\nsetInterval(() => statSync(import.meta.filename), 250);\n"
  );
  const daemon = await launchObservedDaemon({ mutation });
  t.after(() => daemon.dispose());
  await daemon.openSessions(2);

  const found = violations(await observe(daemon, 2000));
  assert.ok(
    found.some((line) => /^sync fs: statSync x\d+ at .*poll\.mjs:2$/.test(line)),
    found.join('\n')
  );
  assert.ok(
    found.some((line) => /^setInterval\(250ms\) fired x\d+ at .*poll\.mjs:2$/.test(line)),
    found.join('\n')
  );
});
