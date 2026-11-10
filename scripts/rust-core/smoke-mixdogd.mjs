#!/usr/bin/env node
// K1 replacement of scripts/boot-smoke.mjs and scripts/smoke-loop.mjs (Node core boot, first answer, time budget):
// starts the real `mixdogd serve` on an isolated profile, connects the protocol client (packages/protocol-client, the
// client the TUI and desktop use), and checks that the core is serving, opens a thread and answers a status call
// within the budget. `--loop <ms>` repeats the whole boot for that long (smoke-loop). The TUI's first render is the
// TUI package's own test; this script proves the core side of it.
// Usage: node scripts/rust-core/smoke-mixdogd.mjs --mixdogd <path> [--limit-ms 5000] [--loop <ms>]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from './lib/core-session.mjs';

export async function bootOnce(bin) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-boot-smoke-'));
  let core;
  try {
    const bootStarted = performance.now();
    core = await startCore({ bin, root, config: {} });
    const bootMs = performance.now() - bootStarted;
    const callStarted = performance.now();
    const started = await core.call('thread/start', { kind: 'task', projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route: { provider: 'anthropic-oauth', model: 'smoke' }, workflowId: 'headless', orchestrationMode: 'none' }, session: { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false } });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
    const status = await core.call('tools/toolsStatus', { threadId });
    if (!status || typeof status !== 'object') throw new Error('tools/toolsStatus answered nothing');
    return { bootMs, callMs: performance.now() - callStarted };
  } finally {
    await core?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
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
    if (callMs > limit) {
      console.error(`first thread + status took ${callMs.toFixed(0)}ms, over the ${limit}ms limit`);
      process.exit(1);
    }
  } while (Date.now() < until);
  console.log(`mixdogd boot smoke passed (${runs} run${runs === 1 ? '' : 's'})`);
}
