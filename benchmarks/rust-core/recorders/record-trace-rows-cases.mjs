#!/usr/bin/env node
// Records Node's trace sinks for the k1 UNTESTED agent-trace-failures.test.mjs (:90, redaction), the two registry cases
// of agent-watchdog-abort-row.test.mjs (:104, :137) and buffered-appender.test.mjs (gaps-rest.md section 3, mixdog-trace).
// Each case runs as its test runs it, in a child Node process over the exact tree:
//   redaction: the test's three `traceAgentTool` calls, then `drainAgentTrace`, with the clock fixed; the whole
//     `trace.jsonl` and `failures.jsonl` texts are recorded;
//   watchdog: the test's registry script under its fake clock; the failure log's rows are recorded;
//   appender: the test file itself under `node --test` (its cases mock `node:fs/promises`); each case's verdict.
//
//   node benchmarks/rust-core/recorders/record-trace-rows-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/trace-rows-cases/{golden.json,MANIFEST.json}.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-trace-rows-cases.mjs';
const TESTS = [
  'src/runtime/agent/orchestrator/agent-trace-failures.test.mjs',
  'src/runtime/agent/orchestrator/agent-runtime/agent-watchdog-abort-row.test.mjs',
  'src/runtime/shared/buffered-appender.test.mjs',
];
const NOW = Date.parse('2026-03-01T10:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const cases = [];

function child(script, env, directory) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, MIXDOG_RUNTIME_ROOT: join(directory, 'no-service'), ...env },
  });
  if (result.status !== 0) throw new Error(`child failed (${result.status}): ${result.stderr}`);
}
const read = (path) => readFileSync(path, 'utf8');

// The redaction case's calls, as the test makes them.
const REDACTION_CALLS = [
  {
    sessionId: 'structured-failure', iteration: 1, toolName: 'computer', toolKind: 'internal', toolMs: 1, resultKind: 'error',
    resultText: {
      isError: true,
      content: [
        { type: 'text', text: 'Error: foreground_unavailable\nAuthorization: Bearer secret-example-token' },
        { type: 'image', mimeType: 'image/png', data: 'image-bytes-must-not-enter-logs' },
      ],
    },
  },
  {
    sessionId: 'structured-failure', iteration: 1, toolName: 'shell', toolKind: 'internal', toolMs: 1, resultKind: 'error',
    resultText: '\r\n ⚠️ destructive command warning\r\n Error: Session "sess_cancelled" closed: aborted during call',
  },
  {
    sessionId: 'structured-failure', iteration: 1, toolName: 'shell', toolKind: 'internal', toolMs: 1, resultKind: 'error',
    resultText: 'Error: failed: mysql --password hunter2-flag -p hunter2-short https://user:hunter2-url@host.example/x',
  },
];
{
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-trace-rows-'));
  try {
    child(
      `
      Date.now = () => ${NOW};
      const { traceAgentTool } = await import('./src/runtime/agent/orchestrator/agent-trace-format.mjs');
      const { drainAgentTrace } = await import('./src/runtime/agent/orchestrator/agent-trace-io.mjs');
      for (const call of ${JSON.stringify(REDACTION_CALLS)}) traceAgentTool(call);
      await drainAgentTrace();
    `,
      {
        MIXDOG_AGENT_TRACE_PATH: join(directory, 'trace.jsonl'),
        MIXDOG_TOOL_FAILURE_LOG_PATH: join(directory, 'failures.jsonl'),
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
      },
      directory
    );
    cases.push({
      case: 'failure traces redact secrets and preserve structured errors without logging session cancellations',
      kind: 'redaction',
      now: NOW,
      calls: REDACTION_CALLS,
      recorded: { trace: read(join(directory, 'trace.jsonl')), failures: read(join(directory, 'failures.jsonl')) },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The watchdog registry cases: the test's fake clock and scripts.
const START = 1_700_000_000_000;
const FAKE_CLOCK = `
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: ${START} });
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
const WATCHDOG = {
  'a failed-checks stop reports the last successful sweep as its compared clock': `
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
  `,
  'a cached snapshot after a failed read shows the stale read time and the error name only': `
    ${FAKE_CLOCK}
    const { createAgentTree } = await import('./src/standalone/session-service/agent-tree.mjs');
    const { createProgressWatchdogRegistry } = await import('./src/session-runtime/services/agent-watchdog-registry.mjs');
    let reads = 0;
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
  `,
};
for (const [name, script] of Object.entries(WATCHDOG)) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-trace-rows-'));
  try {
    child(
      script,
      {
        MIXDOG_TOOL_FAILURE_LOG_PATH: join(directory, 'failures.jsonl'),
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '1',
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
      },
      directory
    );
    const rows = read(join(directory, 'failures.jsonl')).trim().split(/\r?\n/).map(JSON.parse);
    for (const row of rows) if (row.registration_id) row.registration_id = '<registration>';
    cases.push({ case: name, kind: 'watchdog', recorded: { rows } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The appender cases: the test file under node --test; each case's verdict.
{
  const result = spawnSync(process.execPath, ['--test', '--experimental-test-module-mocks', '--test-reporter=tap', TESTS[2]], { cwd: tree, encoding: 'utf8' });
  for (const name of ['a mid-write sync drain does not duplicate the in-flight payload', 'data dropped after repeated flush failures is recorded']) {
    const ok = new RegExp(`^ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(result.stdout);
    if (!ok) throw new Error(`${name} did not pass in Node:\n${result.stdout}\n${result.stderr}`);
    cases.push({ case: name, kind: 'appender', recorded: { passed: ok } });
  }
}

const excluded = {
  'a failed-checks stop reports the last successful sweep as its compared clock':
    "the core reads a worker's progress snapshot in-process (run_host/watchdog.rs `snapshot(now)`); a read cannot fail, so no " +
    'checks_failed stop exists and the row always carries the direct read',
  'a cached snapshot after a failed read shows the stale read time and the error name only':
    'the core reads the progress snapshot in-process; a read cannot fail, so no cached snapshot or read error reaches the row',
  'a mid-write sync drain does not duplicate the in-flight payload':
    "the core has no asynchronous write in flight to drain: a spool's flush takes its lines and writes them in one call " +
    '(spool.rs `flush`)',
  'data dropped after repeated flush failures is recorded':
    'DIFFERENCE: Node requeues a failed flush three times (four appends) and then counts the dropped bytes; the core drops ' +
    'the chunk at the first failed write and returns a warning, with no retry and no dropped-bytes count',
};

const finalDir = join(FIXTURES_ROOT, 'trace-rows-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's trace sinks at ${NODE_COMMIT}, per case of ${RECORDER}`, tests: TESTS, cases });
writeSetManifest(stage, {
  set: 'trace-rows-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'redaction: the whole trace.jsonl and failures.jsonl texts after the three calls and a flush',
    masked: 'watchdog rows: registration ids as <registration>; the redaction clock is fixed at 2026-03-01T10:00:00.000Z',
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`trace-rows-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
