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
    core = await startCore({ bin, root, config: {}, readyTimeoutMs: HANG_MS });
    const servingMs = performance.now() - core.spawnedAt;
    const started = await within(core.call('thread/start', { kind: 'task', projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: 'anthropic-oauth', model: 'smoke' }, workflowId: 'headless', orchestrationMode: 'none' }, session: { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false } }), HANG_MS, 'thread/start');
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
    const status = await within(core.call('tools/toolsStatus', { threadId }), HANG_MS, 'tools/toolsStatus');
    if (!status || typeof status !== 'object') throw new Error('tools/toolsStatus answered nothing');
    // One interval: process start to the answered workload request. servingMs is only the part of it that
    // ends when the protocol is connected, kept to show where the time goes.
    result = { answeredMs: performance.now() - core.spawnedAt, servingMs };
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
  // That is only checkable on the core's own spool, which mixdogd does not write yet. A missing spool is therefore
  // not "no failures": it fails naming the missing writer, unless open-gaps.json records the gap as open, in which
  // case the run says plainly that the failure detection is not covered.
  const failures = core ? join(core.paths.dataDir, 'history', 'tool-failures.jsonl') : null;
  const failureRows = failures && existsSync(failures) ? readFileSync(failures, 'utf8').trim() : '';
  let writerGap = null;
  let writerError = null;
  if (core && !runError && !stopError && !existsSync(failures)) {
    const gap = JSON.parse(readFileSync(new URL('./open-gaps.json', import.meta.url), 'utf8'))['tool-failures-writer'];
    if (gap?.open) writerGap = gap;
    else writerError = new Error(`mixdogd wrote no ${failures}: the core has no tool-failure writer (AgentTrace::append_tool_failure is not wired to the call sites of Node's _appendToolFailureRow), so smoke-loop's tool-failure check cannot be made`);
  }
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
  if (writerError) throw writerError;
  return { ...result, writerGap };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const bin = resolve(arg('--mixdogd'));
  const limit = Number(arg('--limit-ms', process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5000));
  const until = Date.now() + Number(arg('--loop', 0));
  let runs = 0;
  let gap = null;
  do {
    const { answeredMs, servingMs, writerGap } = await bootOnce(bin);
    runs += 1;
    gap = writerGap;
    console.log(`run ${runs}: process start to answered thread + status ${answeredMs.toFixed(0)}ms (serving and connected at ${servingMs.toFixed(0)}ms)`);
    // boot-smoke.mjs held the whole spawn to MIXDOG_BOOT_SMOKE_LIMIT_MS (5000): one budget for the interval from
    // process start to the first answered workload request.
    if (answeredMs > limit) {
      console.error(`process start to the first answered request took ${answeredMs.toFixed(0)}ms, over the ${limit}ms limit`);
      process.exit(1);
    }
  } while (Date.now() < until);
  console.log(`mixdogd boot smoke passed (${runs} run${runs === 1 ? '' : 's'})`);
  if (gap) console.log(`NOT COVERED: tool-failure detection (smoke-loop's tool-failures.mjs check). ${gap.what}. Open gap, owner ${gap.owner}.`);
}
