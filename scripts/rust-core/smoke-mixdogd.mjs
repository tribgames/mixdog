#!/usr/bin/env node
// K1 replacement of scripts/boot-smoke.mjs and scripts/smoke-loop.mjs (Node core boot, first answer, time budget):
// starts the real `mixdogd serve` on an isolated profile, connects the protocol client (packages/protocol-client, the
// client the TUI and desktop use), and checks that the core is serving, opens a thread and answers a status call
// within the budget. `--loop <ms>` repeats the whole boot for that long (smoke-loop). The TUI's first render is the
// TUI package's own test; this script proves the core side of it.
// Usage: node scripts/rust-core/smoke-mixdogd.mjs --mixdogd <path> [--limit-ms 5000] [--loop <ms>]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore, within } from './lib/core-session.mjs';

// A start or a call that has not answered by now is hung, not slow: it fails with a message instead of waiting.
const HANG_MS = 60_000;

export async function bootOnce(bin) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-boot-smoke-'));
  let core;
  let result;
  let runError = null;
  try {
    const bootStarted = performance.now();
    core = await startCore({ bin, root, config: {}, readyTimeoutMs: HANG_MS });
    const bootMs = performance.now() - bootStarted;
    const callStarted = performance.now();
    const started = await within(core.call('thread/start', { kind: 'task', projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: 'anthropic-oauth', model: 'smoke' }, workflowId: 'headless', orchestrationMode: 'none' }, session: { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false } }), HANG_MS, 'thread/start');
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
    const status = await within(core.call('tools/toolsStatus', { threadId }), HANG_MS, 'tools/toolsStatus');
    if (!status || typeof status !== 'object') throw new Error('tools/toolsStatus answered nothing');
    result = { bootMs, callMs: performance.now() - callStarted };
  } catch (error) {
    runError = error;
  }
  // The stop is bounded and ends the child on every failure path. Its failure is the run's failure; when the run
  // already failed, that error stays the thrown one and the stop failure is printed beside it.
  let stopError = null;
  try {
    await core?.stop();
  } catch (error) {
    stopError = error;
  }
  // smoke-loop.mjs ended every iteration with `tool-failures.mjs --since <loop start>`: no tool failure may appear.
  // The same check on the core's own spool, read after the stop has flushed it.
  const failures = core ? join(core.paths.dataDir, 'history', 'tool-failures.jsonl') : null;
  const failureRows = failures && existsSync(failures) ? readFileSync(failures, 'utf8').trim() : '';
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // A killed core's executable can stay locked on Windows for a moment; the directory is scratch and must not
    // replace the run's own failure.
    console.error(`could not remove ${root}: ${error.message}`);
  }
  if (!runError && !stopError && failureRows) throw new Error(`tool failures appeared during the smoke:\n${failureRows.slice(0, 600)}`);
  if (runError) {
    if (stopError) console.error(stopError.message);
    throw runError;
  }
  if (stopError) throw stopError;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const bin = resolve(arg('--mixdogd'));
  const limit = Number(arg('--limit-ms', process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5000));
  const until = Date.now() + Number(arg('--loop', 0));
  let runs = 0;
  do {
    const { bootMs, callMs } = await bootOnce(bin);
    runs += 1;
    console.log(`run ${runs}: boot ${bootMs.toFixed(0)}ms, first thread + status ${callMs.toFixed(0)}ms`);
    // boot-smoke.mjs held the whole spawn (boot to exit) to MIXDOG_BOOT_SMOKE_LIMIT_MS (5000): the start and the
    // first answer each get that budget here.
    for (const [what, ms] of [['boot (spawn to serving, protocol connected)', bootMs], ['first thread + status', callMs]]) {
      if (ms > limit) {
        console.error(`${what} took ${ms.toFixed(0)}ms, over the ${limit}ms limit`);
        process.exit(1);
      }
    }
  } while (Date.now() < until);
  console.log(`mixdogd boot smoke passed (${runs} run${runs === 1 ? '' : 's'})`);
}
