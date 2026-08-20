#!/usr/bin/env node
// Turn-loop stage probe (manual, real provider turns).
//
// Runs ONE spread worker through a deliberately sequential multi-round task
// with the agent trace enabled, then prints the per-iteration stage rows:
//   loop        — send_ms / pre_send_ms / tool_resume_ms / message_count
//   sse         — ttft_ms / stream_total_ms per provider request
//   turn_timing — queue/route/preflight/provider attribution
//   usage       — input/cached tokens per request (prefix-cache hit signal)
//
// Run: node scripts/agent-turn-trace-probe.mjs [provider model effort]
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-turn-trace-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';
process.env.MIXDOG_BOOT_CORE_MEMORY = '0';
// The probe's whole point is the trace: explicit path plus timing rows.
const TRACE_PATH = join(ROOT, 'agent-trace.jsonl');
delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
process.env.MIXDOG_AGENT_TRACE_PATH = TRACE_PATH;
process.env.MIXDOG_AGENT_TRACE_TIMING = '1';

const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const REAL_DATA_DIR = join(homedir(), '.mixdog', 'data');
for (const file of [
  'mixdog-config.json',
  'grok-oauth.json',
  'grok-oauth-models.json',
  'openai-oauth.json',
  'openai-oauth-models.json',
  'anthropic-oauth-credentials.json',
  'anthropic-oauth-models.json',
]) {
  const from = join(REAL_DATA_DIR, file);
  if (existsSync(from)) copyFileSync(from, join(DATA_DIR, file));
}
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const PROVIDER = process.argv[2] || 'grok-oauth';
const MODEL = process.argv[3] || 'grok-4.3';
const EFFORT = process.argv[4] || 'low';
const REPO = 'C:/Project/mixdog';
const JOB_TIMEOUT_MS = 240_000;

const cfgMod = await import('../src/runtime/agent/orchestrator/config.mjs');
const reg = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
const mgr = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
const { ensureDaemon, readSessionDiscovery, shutdownDaemon } = await import('../src/standalone/session-client.mjs');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

try {
  await ensureDaemon({ cwd: REPO, log: () => {} });
  const agent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir: join(ROOT, 'data-probe'), cwd: REPO });
  const t0 = Date.now();
  const out = await agent.execute({
    type: 'spawn',
    agent: 'worker',
    provider: PROVIDER,
    model: MODEL,
    effort: EFFORT,
    tag: 'turn-trace',
    cwd: REPO,
    prompt: [
      'Execute these steps strictly IN ORDER, exactly ONE tool call per assistant message',
      '(never batch two calls in one message — this measures sequential rounds):',
      '1) read package.json',
      '2) read README.md (first 40 lines)',
      '3) run the shell command: node -v',
      '4) read apps/desktop/package.json',
      '5) grep the string "createSessionRuntimeHost" under src/standalone (files list only)',
      'Then reply with one line: DONE <package name> <node version>. Do not edit anything.',
    ].join('\n'),
  }, { invocationSource: 'model-tool', cwd: REPO });
  const id = String(out).match(/agent task: (\S+)/)?.[1];
  if (!id) throw new Error(`no task id: ${out}`);
  let last = '';
  while (Date.now() - t0 < JOB_TIMEOUT_MS) {
    last = await agent.execute({ type: 'read', task_id: id }, { invocationSource: 'model-tool', cwd: REPO });
    if (/status: (completed|failed|error|cancelled)/.test(last)) break;
    await sleep(500);
  }
  process.stdout.write(`wall=${((Date.now() - t0) / 1000).toFixed(1)}s\n--- result ---\n${last.slice(0, 400)}\n`);
  try { agent.closeAll('turn-trace probe end'); } catch { /* teardown */ }

  // The runtime worker flushes its local trace buffer on a short timer.
  await sleep(9_000);
  const rows = existsSync(TRACE_PATH)
    ? readFileSync(TRACE_PATH, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
    : [];
  process.stdout.write(`--- trace (${rows.length} rows) ---\n`);
  for (const row of rows) {
    if (row.kind === 'loop') {
      process.stdout.write(`[loop] iter=${row.iteration ?? row.payload?.iteration} send=${row.send_ms ?? row.payload?.send_ms}ms`
        + ` preSend=${row.pre_send_ms ?? row.payload?.pre_send_ms}ms toolResume=${row.tool_resume_ms ?? row.payload?.tool_resume_ms}ms`
        + ` msgs=${row.message_count ?? row.payload?.message_count}\n`);
    } else if (row.kind === 'sse') {
      process.stdout.write(`[sse] ttft=${row.ttft_ms}ms streamTotal=${row.stream_total_ms}ms\n`);
    } else if (row.kind === 'turn_timing') {
      process.stdout.write(`[turn] status=${row.status} ttft=${row.ttft_ms}ms e2eTtft=${row.end_to_end_ttft_ms}ms`
        + ` queue=${row.queue_ms}ms route=${row.route_ms}ms preflight=${row.preflight_ms}ms provider=${row.provider_ms}ms\n`);
    } else if (row.kind === 'usage_raw') {
      process.stdout.write(`[usage] iter=${row.iteration} input=${row.input_tokens} cached=${row.cached_tokens}`
        + ` cacheWrite=${row.cache_write_tokens} uncached=${row.uncached_input_tokens} output=${row.output_tokens}`
        + ` chain=${row.chain_continuous ?? '-'}\n`);
    } else if (row.kind === 'tool') {
      const p = row.payload || row;
      process.stdout.write(`[tool] ${row.tool || row.tool_name || p.tool || p.tool_name || ''}`
        + ` ${row.duration_ms ?? row.tool_ms ?? p.duration_ms ?? p.tool_ms ?? '?'}ms\n`);
    } else {
      process.stdout.write(`[${row.kind}] ${JSON.stringify(row).slice(0, 220)}\n`);
    }
  }
} finally {
  try { await shutdownDaemon(readSessionDiscovery()); } catch { /* teardown */ }
  await sleep(300);
  try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
}
process.exit(0);
