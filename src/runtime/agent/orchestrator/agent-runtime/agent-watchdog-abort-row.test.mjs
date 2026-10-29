import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A shipped build keeps no agent trace; the tool-failure log is the only sink
// that stays on, so the row is checked in a child process with the local trace
// switched off and the failure log pointed at a temp file.
function runAndReadRows(script) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-stall-row-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_TOOL_FAILURE_LOG_PATH: join(directory, 'failures.jsonl'),
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '1',
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
        MIXDOG_RUNTIME_ROOT: join(directory, 'no-service'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(join(directory, 'failures.jsonl'), 'utf8');
    return { text, rows: text.trim().split(/\r?\n/).map(JSON.parse) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a stale tool_running snapshot writes exactly one stall_abort row to the failure log', () => {
  const { text, rows } = runAndReadRows(`
    import {
      AgentStallAbortError, abortAgentProgressWatchdog, evaluateAgentWatchdogAbort,
    } from './src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
    const now = Date.now();
    const policy = { firstTransportMs: 120000, firstSemanticMs: 600000, idleStaleMs: 420000 };
    const snapshot = {
      stage: 'tool_running', currentTool: 'shell', lastProgressAt: now - 425000,
      lastKeepaliveAt: now - 430000, firstActivityAt: now - 900000,
      waitingForTransport: false, waitingForFirstSemantic: false,
      askStartedAt: now - 950000, modelRequestStartedAt: now - 430000,
    };
    const error = evaluateAgentWatchdogAbort(snapshot, now, policy);
    abortAgentProgressWatchdog(new AbortController(), {
      sessionId: 'sess_daemon_1', agent: 'heavy-worker', error, snapshot, policy, now, anchorTs: now - 900000,
      iteration: 7,
    });
  `);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, 'stall_abort');
  assert.equal(row.session_id, 'sess_daemon_1');
  assert.equal(row.agent, 'heavy-worker');
  assert.equal(row.stage, 'tool_running');
  assert.equal(row.window, 'idle');
  assert.equal(row.limit_ms, 420000);
  assert.equal(row.form, 'idle_progress');
  assert.equal(row.snapshot_present, true);
  assert.equal(row.current_tool, 'shell');
  assert.equal(row.iteration, 7);
  assert.equal(row.elapsed_ms, 425000);
  assert.ok(row.last_progress_at > 0 && row.last_keepalive_at > 0 && row.anchor_ts > 0);
  assert.doesNotMatch(text, /stale \(/, 'the row carries no message text');
  // The decision: which clock was compared against the 420 s limit.
  assert.equal(row.compared_field, 'last_progress_at');
  assert.equal(row.compared_at, row.last_progress_at);
  assert.equal(row.snapshot_source, 'direct');
  assert.equal(row.last_read_error, null);
  assert.equal(row.build_version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.equal(row.registration_id, null);
  assert.equal(row.waiting_for_transport, false);
  assert.equal(row.waiting_for_first_semantic, false);
  assert.equal(row.awaiting_user, null);
  assert.ok(row.ask_started_at > 0 && row.model_request_started_at > 0);
});

// The registry sweeps on a 1 s interval and stamps Date.now(); the child
// freezes both at START and advances them one sweep at a time, so every clock
// in a row is an exact multiple of the sweep. A child whose watchdog never
// aborts throws (non-zero exit) instead of waiting on a real deadline.
const START = 1_700_000_000_000;
const FAKE_CLOCK = `
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: ${START} });
    // One registry sweep, then let the asynchronous progress reads settle.
    const sweep = async () => {
      mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
    };
    let aborted = false;
    const onAbort = (signal) => signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    const sweepUntilAbort = async (sweeps) => {
      for (let i = 1; i <= sweeps; i += 1) {
        await sweep();
        if (aborted !== (i === sweeps)) throw new Error('abort on sweep ' + i + ': ' + aborted);
      }
    };
`;

test('a manager with no progress snapshot writes snapshot_present false', () => {
  const { rows } = runAndReadRows(`
    ${FAKE_CLOCK}
    const { createProgressWatchdogRegistry } = await import('./src/session-runtime/services/agent-watchdog-registry.mjs');
    const mgr = {
      getSessionLastProgressAt: () => 0,
      linkParentSignalToSession: (_id, signal) => {
        onAbort(signal);
        return () => {};
      },
    };
    createProgressWatchdogRegistry({ mgr }).start('sess_daemon_2', { idleStaleMs: 50 }, 'worker');
    await sweepUntilAbort(1);
  `);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, 'stall_abort');
  assert.equal(row.session_id, 'sess_daemon_2');
  assert.equal(row.agent, 'worker');
  assert.equal(row.snapshot_present, false);
  assert.equal(row.form, 'idle_bare');
  assert.equal(row.window, 'idle');
  assert.equal(row.limit_ms, 50);
  assert.equal(row.stage, null);
  assert.equal(row.anchor_ts, START);
  assert.equal(row.elapsed_ms, 1000);
  assert.equal(row.compared_field, 'anchor_ts');
  assert.equal(row.compared_at, row.anchor_ts);
  assert.equal(row.snapshot_source, null);
  assert.match(row.registration_id, /^[0-9a-f]{8}$/);
});

test('a failed-checks stop reports the last successful sweep as its compared clock', () => {
  // Sweep 1 reads fine; sweeps 2 and 3 fail. Measured from sweep 1, the third
  // sweep is the first past the 1.5 s limit (2 s); measured from the anchor,
  // the second would already be (2 s).
  const { rows } = runAndReadRows(`
    ${FAKE_CLOCK}
    const { createProgressWatchdogRegistry } = await import('./src/session-runtime/services/agent-watchdog-registry.mjs');
    let calls = 0;
    const mgr = {
      getSessionProgressSnapshot: () => {
        calls += 1;
        if (calls > 1) throw new Error('progress read broke');
        return { stage: 'streaming', lastProgressAt: Date.now() };
      },
      linkParentSignalToSession: (_id, signal) => {
        onAbort(signal);
        return () => {};
      },
    };
    createProgressWatchdogRegistry({ mgr }).start('sess_daemon_4', { idleStaleMs: 1500 }, 'worker');
    await sweepUntilAbort(3);
  `);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.form, 'checks_failed');
  assert.equal(row.compared_field, 'last_successful_check_at');
  assert.equal(row.anchor_ts, START);
  assert.equal(row.compared_at, START + 1000);
  assert.equal(row.ts, START + 3000);
  assert.equal(row.elapsed_ms, 2000);
});

test('a cached snapshot after a failed read shows the stale read time and the error name only', () => {
  const { text, rows } = runAndReadRows(`
    ${FAKE_CLOCK}
    const { createAgentTree } = await import('./src/standalone/session-service/agent-tree.mjs');
    const { createProgressWatchdogRegistry } = await import('./src/session-runtime/services/agent-watchdog-registry.mjs');
    let reads = 0;
    // The first read (sweep 1) succeeds with a progress clock at the anchor;
    // every later read fails, so the watchdog keeps judging that cached
    // snapshot until sweep 3 passes the 2.5 s limit.
    const runtime = {
      isWireSafe: true,
      abort: () => { aborted = true; },
      getTurnLiveness: async () => {
        reads += 1;
        if (reads === 1) return { stage: 'streaming', lastProgressAt: Date.now() - 1000, askStartedAt: Date.now() - 5000 };
        const error = new Error('read failed at /private/secret/path');
        error.code = 'EWIRE';
        throw error;
      },
    };
    const tree = createAgentTree({ sessionOwner: () => ({ runtime }) });
    createProgressWatchdogRegistry({ mgr: tree.agentManager }).start('sess_daemon_3', { idleStaleMs: 2500 }, 'worker');
    await sweepUntilAbort(3);
  `);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.snapshot_present, true);
  assert.equal(row.snapshot_source, 'cache');
  assert.equal(row.last_read_error, 'EWIRE');
  // The watchdog judged the read taken at sweep 1, not current activity.
  assert.equal(row.last_read_ok_at, START + 1000);
  assert.equal(row.ts, START + 3000);
  assert.equal(row.compared_at, START);
  assert.equal(row.compared_field, 'last_progress_at');
  assert.doesNotMatch(text, /private\/secret/);
});
