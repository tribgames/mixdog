#!/usr/bin/env node
// Starts the real `mixdogd serve` on an isolated profile, connects the protocol client (packages/protocol-client, the
// client the TUI and desktop use), opens a thread and answers a status call.
//   Budget: spawn, first answered workload request (thread/start + toolsStatus), stop, exit; the parts (serving,
//   answered, exit) are printed so the slow part is visible.
//   Tool failures: the check provokes one failure it controls (a scripted model turn calls `read` with arguments that
//   must fail) and requires exactly that row in the core's history/tool-failures.jsonl and no other. A missing or empty
//   spool fails.
// `--loop <ms>` repeats the boot for that long.
// Usage: node scripts/rust-core/smoke-mixdogd.mjs --mixdogd <path> [--limit-ms 5000] [--loop <ms>]
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore, within } from './lib/core-session.mjs';
import { startScriptedProvider } from './lib/scripted-provider.mjs';

// A start or a call that has not answered by now is hung, not slow: it fails with a message instead of waiting.
const HANG_MS = 60_000;
const OWNER = 'rs-tool-failures';
const THREAD = {
  kind: 'task',
  session: {
    toolProfile: 'headless',
    toolMode: 'full',
    approvalMode: 'implicit',
    disallowDelegation: true,
    autoWakeCompletions: false,
    webSearch: false,
    memory: false,
  },
};
const startThread = async (core, route) => {
  const started = await within(
    core.call('thread/start', {
      ...THREAD,
      projectPath: core.paths.workspace,
      draft: { projectPath: core.paths.workspace, route, workflowId: 'headless', orchestrationMode: 'none' },
    }),
    HANG_MS,
    'thread/start'
  );
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 200)}`);
  return threadId;
};

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
  const daemonLog = core ? join(core.paths.dataDir, 'daemon.log') : null;
  const phases =
    daemonLog && existsSync(daemonLog)
      ? [...readFileSync(daemonLog, 'utf8').matchAll(/boot-phase phase=(\S+) status=mark totalMs=([\d.]+)/g)].map(
          ([, phase, ms]) => ({ phase, ms: Number(ms) })
        )
      : [];
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
  return { value, exitMs, rows, phases };
}

/** The boot's slowest steps from the daemon's own marks (ms from `serve` entry, so launch and the login-shell read come before them).
 *  A mark stamped with an earlier instant can be written after later ones, so the steps follow the instants, not the file order. */
export function slowestBootSteps(phases, count = 6) {
  const marks = [{ phase: 'serve-entry', ms: 0 }, ...[...phases].sort((a, b) => a.ms - b.ms)];
  return marks
    .slice(1)
    .map((mark, i) => ({ step: `${marks[i].phase} -> ${mark.phase}`, ms: mark.ms - marks[i].ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, count);
}

/** One boot: the parts of the interval from the spawn, in ms. No tool runs, so no tool failure may appear. */
export async function bootOnce(bin) {
  const { value, exitMs, rows, phases } = await withCore(bin, {}, async (core) => {
    const servingMs = performance.now() - core.spawnedAt;
    const threadId = await startThread(core, { provider: 'anthropic-oauth', model: 'smoke' });
    const status = await within(core.call('tools/toolsStatus', { threadId }), HANG_MS, 'tools/toolsStatus');
    if (!status || typeof status !== 'object') throw new Error('tools/toolsStatus answered nothing');
    return { servingMs, answeredMs: performance.now() - core.spawnedAt };
  });
  if (rows?.length) throw new Error(`tool failures appeared during the boot smoke:\n${rows.join('\n').slice(0, 600)}`);
  return { ...value, exitMs, phases };
}

const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';

/**
 * The tool-failure check: a scripted model turn calls `read` with no path, which the core must fail, and the spool must
 * hold exactly that row, matching the expected row (judgeToolFailureRows). Throws when the spool is missing, empty or holds another row.
 */
export async function toolFailureCheck(bin) {
  const provider = await startScriptedProvider({ tool: 'read', args: '{}' });
  let result;
  try {
    const config = {
      agent: {
        providers: {
          [CUSTOM]: {
            type: 'custom',
            name: 'smoke',
            protocol: 'openai-chat',
            baseURL: provider.baseURL,
            auth: 'none',
            models: [{ id: 'smoke' }],
          },
        },
      },
    };
    const startedAt = Date.now();
    result = await withCore(bin, config, async (core) => {
      const threadId = await startThread(core, { provider: CUSTOM, model: 'smoke' });
      await within(
        core.call('turn/start', { threadId, input: { prompt: 'call the tool', options: {} } }),
        HANG_MS,
        'turn/start'
      );
      // The second model request carries the failed tool's result back: the failure has happened.
      const request = await within(provider.toolResult, HANG_MS, 'the scripted turn reaching its tool result');
      const answer = JSON.parse(request.body).messages.find((m) => m.role === 'tool')?.content ?? '';
      if (!/requires "path"/.test(answer))
        throw new Error(
          `the provoked tool call did not fail as scripted; the tool answered: ${String(answer).slice(0, 200)}`
        );
      return { sessionId: threadId, cwd: core.paths.workspace, startedAt };
    });
  } finally {
    await provider.close();
  }
  return judgeToolFailureRows(result.rows, { ...result.value, endedAt: Date.now() });
}

/** The stable fields of the row the core writes for this scripted failure; the per-run fields are checked against the run itself. */
const EXPECTED_ROW = {
  iteration: 1,
  tool_name: 'read',
  tool_kind: 'builtin',
  result_kind: 'error',
  category: 'runtime/failure',
  agent: 'lead',
  model: 'smoke',
  tool_args: null,
  error_first_line: 'Error: read requires "path" (or alias file_path).',
  error_preview: 'Error: read requires "path" (or alias file_path).',
  result_bytes_est: 49,
  result_lines_est: 1,
};
/**
 * The verdict on the spool after the scripted failure: exactly one row, and it is the provoked call's. Every stable field
 * is compared to EXPECTED_ROW, and the per-run values
 * (`session_id`, `cwd`, `ts`, `tool_ms`) to this run's own thread, workspace and clock. `rows` is null when no spool file exists.
 * @param {string[]|null} rows
 * @param {{ sessionId: string, cwd: string, startedAt: number, endedAt: number }} run
 */
export function judgeToolFailureRows(rows, run) {
  if (!rows?.length) {
    throw new Error(
      `the core wrote ${rows ? 'an empty' : 'no'} history/tool-failures.jsonl for the scripted failure (read with no path -> 'read requires "path"'): its tool-failure writer ` +
        `(AgentTrace::append_tool_failure at the tool-failure call sites) did not record the failed call. Owner: ${OWNER}. smoke-loop's tool-failure check is NOT covered`
    );
  }
  if (rows.length !== 1)
    throw new Error(
      `expected exactly the one provoked tool-failure row, found ${rows.length}:\n${rows.join('\n').slice(0, 800)}`
    );
  const row = JSON.parse(rows[0]);
  const differs = [];
  const keys = [...Object.keys(EXPECTED_ROW), 'ts', 'session_id', 'cwd', 'tool_ms'].sort();
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(keys))
    differs.push(`keys ${JSON.stringify(Object.keys(row).sort())} (expected: ${JSON.stringify(keys)})`);
  for (const key of Object.keys(EXPECTED_ROW)) {
    if (JSON.stringify(row[key]) !== JSON.stringify(EXPECTED_ROW[key]))
      differs.push(`${key} ${JSON.stringify(row[key])} (expected: ${JSON.stringify(EXPECTED_ROW[key])})`);
  }
  if (row.session_id !== run.sessionId)
    differs.push(`session_id ${JSON.stringify(row.session_id)} (this run's thread: ${run.sessionId})`);
  if (row.cwd !== run.cwd) differs.push(`cwd ${JSON.stringify(row.cwd)} (this run's workspace: ${run.cwd})`);
  if (!Number.isFinite(row.ts) || row.ts < run.startedAt || row.ts > run.endedAt)
    differs.push(`ts ${row.ts} (outside this run: ${run.startedAt}..${run.endedAt})`);
  if (!Number.isFinite(row.tool_ms) || row.tool_ms < 0) differs.push(`tool_ms ${JSON.stringify(row.tool_ms)}`);
  if (differs.length)
    throw new Error(
      `the tool-failure row is not the provoked call's; it differs from the expected row in: ${differs.join('; ')}`
    );
  return row;
}
// The module's own URL is the real path: a script named through a linked directory or drive is compared resolved too.
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  const arg = (name, fallback) =>
    process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
  const bin = resolve(arg('--mixdogd'));
  const limit = Number(arg('--limit-ms', process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5000));
  const until = Date.now() + Number(arg('--loop', 0));
  const problems = [];
  let runs = 0;
  do {
    const { servingMs, answeredMs, exitMs, phases } = await bootOnce(bin);
    runs += 1;
    console.log(
      `run ${runs}: spawn to serving+connected ${servingMs.toFixed(0)}ms, to first answered thread + status ${answeredMs.toFixed(0)}ms, to stopped and exited ${exitMs.toFixed(0)}ms (budget ${limit}ms on the last)`
    );
    const ready = phases.find((mark) => mark.phase === 'daemon-ready');
    console.log(
      `  daemon marks: ready ${ready ? `${ready.ms}ms after serve entry` : 'not logged'}; slowest steps: ${
        slowestBootSteps(phases)
          .map(({ step, ms }) => `${step} ${ms.toFixed(0)}ms`)
          .join(', ') || 'none logged'
      }`
    );
    if (exitMs > limit) {
      problems.push(
        `spawn to exit took ${exitMs.toFixed(0)}ms (serving ${servingMs.toFixed(0)}ms, answered ${answeredMs.toFixed(0)}ms), over the ${limit}ms limit`
      );
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
