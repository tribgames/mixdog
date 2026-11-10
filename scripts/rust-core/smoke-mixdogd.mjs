#!/usr/bin/env node
// K1 replacement of scripts/boot-smoke.mjs and scripts/smoke-loop.mjs (Node core boot, first answer, time budget, and the
// tool-failure check): starts the real `mixdogd serve` on an isolated profile, connects the protocol client
// (packages/protocol-client, the client the TUI and desktop use), opens a thread and answers a status call.
//   Budget: boot-smoke.mjs `runCase` held the interval from the spawn through the child's exit to
//   MIXDOG_BOOT_SMOKE_LIMIT_MS (5000). Here that is: spawn, first answered workload request (thread/start + toolsStatus),
//   stop, exit; the parts (serving, answered, exit) are printed so the slow part is visible.
//   Tool failures: smoke-loop.mjs ended every iteration with `tool-failures.mjs --since <loop start>`. The check here
//   provokes one failure it controls (a scripted model turn calls `read` with arguments that must fail) and requires
//   exactly that row in the core's history/tool-failures.jsonl and no other. A missing or empty spool fails.
// `--loop <ms>` repeats the boot for that long (smoke-loop). The TUI's first render is the TUI package's own test.
// Usage: node scripts/rust-core/smoke-mixdogd.mjs --mixdogd <path> [--limit-ms 5000] [--loop <ms>]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore, within } from './lib/core-session.mjs';
import { startScriptedProvider } from './lib/scripted-provider.mjs';

// A start or a call that has not answered by now is hung, not slow: it fails with a message instead of waiting.
const HANG_MS = 60_000;
const OWNER = 'rs-tool-failures';
const THREAD = { kind: 'task', session: { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: false, memory: false } };
const startThread = (core, route) =>
  within(core.call('thread/start', { ...THREAD, projectPath: core.paths.workspace, draft: { projectPath: core.paths.workspace, route, workflowId: 'headless', orchestrationMode: 'none' } }), HANG_MS, 'thread/start');

/**
 * One core on a fresh profile: `work(core)` runs against it, then the core is stopped (bounded, the child ended on every
 * failure path) and its tool-failure spool read. A failure of the work stays the thrown one with a stop failure printed
 * beside it; a stop failure alone is the run's failure.
 * @returns {Promise<{ value: any, exitMs: number|undefined, rows: string[]|null }>} `rows` is null when the core wrote no spool file
 */
async function withCore(bin, config, work) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-boot-smoke-'));
  let core;
  let value;
  let runError = null;
  let stopError = null;
  try {
    core = await startCore({ bin, root, config, readyTimeoutMs: HANG_MS });
    value = await work(core);
  } catch (error) {
    runError = error;
  }
  try {
    await core?.stop();
  } catch (error) {
    stopError = error;
  }
  const exitMs = core ? performance.now() - core.spawnedAt : undefined;
  const spool = core ? join(core.paths.dataDir, 'history', 'tool-failures.jsonl') : null;
  const rows = spool && existsSync(spool) ? readFileSync(spool, 'utf8').split(/\r?\n/).filter(Boolean) : null;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // A killed core's executable can stay locked on Windows for a moment; the directory is scratch and must not
    // replace the run's own failure.
    console.error(`could not remove ${root}: ${error.message}`);
  }
  if (runError) {
    if (stopError) console.error(stopError.message);
    throw runError;
  }
  if (stopError) throw stopError;
  return { value, exitMs, rows };
}

/** One boot: the parts of the interval from the spawn, in ms. No tool runs, so no tool failure may appear. */
export async function bootOnce(bin) {
  const { value, exitMs, rows } = await withCore(bin, {}, async (core) => {
    const servingMs = performance.now() - core.spawnedAt;
    const started = await startThread(core, { provider: 'anthropic-oauth', model: 'smoke' });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
    const status = await within(core.call('tools/toolsStatus', { threadId }), HANG_MS, 'tools/toolsStatus');
    if (!status || typeof status !== 'object') throw new Error('tools/toolsStatus answered nothing');
    return { servingMs, answeredMs: performance.now() - core.spawnedAt };
  });
  if (rows?.length) throw new Error(`tool failures appeared during the boot smoke:\n${rows.join('\n').slice(0, 600)}`);
  return { ...value, exitMs };
}

const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';

/**
 * The tool-failure check: a scripted model turn calls `read` with no path, which the core must fail, and the spool must
 * hold exactly that row. Throws, naming the missing writer and its owner, when the spool is missing or empty.
 */
export async function toolFailureCheck(bin) {
  const provider = await startScriptedProvider({ tool: 'read', args: '{}' });
  let result;
  try {
    const config = { agent: { providers: { [CUSTOM]: { type: 'custom', name: 'smoke', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', models: [{ id: 'smoke' }] } } } };
    result = await withCore(bin, config, async (core) => {
      const started = await startThread(core, { provider: CUSTOM, model: 'smoke' });
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
      await within(core.call('turn/start', { threadId, input: { prompt: 'call the tool', options: {} } }), HANG_MS, 'turn/start');
      // The second model request carries the failed tool's result back: the failure has happened.
      const request = await within(provider.toolResult, HANG_MS, 'the scripted turn reaching its tool result');
      const result = JSON.parse(request.body).messages.find((m) => m.role === 'tool')?.content ?? '';
      if (!/requires "path"/.test(result)) throw new Error(`the provoked tool call did not fail as scripted; the tool answered: ${String(result).slice(0, 200)}`);
    });
  } finally {
    await provider.close();
  }
  return judgeToolFailureRows(result.rows);
}

/** The verdict on the spool after the scripted failure: exactly that one row. `rows` is null when no spool file exists. */
export function judgeToolFailureRows(rows) {
  if (!rows?.length) {
    throw new Error(
      `the core wrote ${rows ? 'an empty' : 'no'} history/tool-failures.jsonl for the scripted failure (read with no path -> 'read requires "path"'): mixdogd has no tool-failure writer yet ` +
        `(AgentTrace::append_tool_failure is not wired to the call sites of Node's _appendToolFailureRow, agent-trace-format.mjs:532 and agent-progress-watchdog.mjs:204). Owner: ${OWNER}. smoke-loop's tool-failure check is NOT covered`,
    );
  }
  if (rows.length !== 1) throw new Error(`expected exactly the one provoked tool-failure row, found ${rows.length}:\n${rows.join('\n').slice(0, 800)}`);
  const row = JSON.parse(rows[0]);
  if (row.tool_name !== 'read' || row.result_kind !== 'error' || !String(row.error_first_line).includes('requires "path"')) {
    throw new Error(`the tool-failure row is not the provoked one: ${rows[0].slice(0, 400)}`);
  }
  return row;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const bin = resolve(arg('--mixdogd'));
  const limit = Number(arg('--limit-ms', process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5000));
  const until = Date.now() + Number(arg('--loop', 0));
  const problems = [];
  let runs = 0;
  do {
    const { servingMs, answeredMs, exitMs } = await bootOnce(bin);
    runs += 1;
    console.log(`run ${runs}: spawn to serving+connected ${servingMs.toFixed(0)}ms, to first answered thread + status ${answeredMs.toFixed(0)}ms, to stopped and exited ${exitMs.toFixed(0)}ms (budget ${limit}ms on the last)`);
    if (exitMs > limit) {
      problems.push(`spawn to exit took ${exitMs.toFixed(0)}ms (serving ${servingMs.toFixed(0)}ms, answered ${answeredMs.toFixed(0)}ms), over the ${limit}ms limit`);
      break;
    }
  } while (Date.now() < until);
  try {
    const row = await toolFailureCheck(bin);
    console.log(`tool-failure check: exactly one row, ${row.tool_name} ${row.result_kind}`);
  } catch (error) {
    problems.push(error.message);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`FAILED: ${problem}`);
    process.exit(1);
  }
  console.log(`mixdogd boot smoke passed (${runs} run${runs === 1 ? '' : 's'})`);
}
