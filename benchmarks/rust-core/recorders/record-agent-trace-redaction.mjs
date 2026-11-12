#!/usr/bin/env node
// What Node's trace writers keep of a failed tool call's secrets, over the three calls of its own test
// (agent-trace-failures.test.mjs, "failure traces redact secrets and preserve structured errors without logging session
// cancellations"): a structured error result whose text carries a bearer header and an image part, a session cancellation,
// and a failure whose text carries `--password`, `-p` and URL userinfo values. The real `traceAgentTool` runs in a child
// process (its failure log is flushed by the child's exit); the parent keeps both sinks' bytes whole: the trace rows and the
// failure rows.
//
//   node benchmarks/rust-core/recorders/record-agent-trace-redaction.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/agent-trace-redaction/golden.json
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-agent-trace-redaction.mjs';
const T0 = 1_700_000_000_000;

const cases = [
  {
    sessionId: 'structured-failure', iteration: 1, toolName: 'computer', toolKind: 'internal', toolMs: 1, resultKind: 'error',
    resultText: { isError: true, content: [
      { type: 'text', text: 'Error: foreground_unavailable\nAuthorization: Bearer secret-example-token' },
      { type: 'image', mimeType: 'image/png', data: 'image-bytes-must-not-enter-logs' },
    ] },
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

if (process.argv[2] === '--child') {
  Date.now = () => T0;
  const orchestrator = (name) => import(pathToFileURL(join(process.env.MIXDOG_TREE, 'src/runtime/agent/orchestrator', name)).href);
  const { traceAgentTool } = await orchestrator('agent-trace-format.mjs');
  const { drainAgentTrace } = await orchestrator('agent-trace-io.mjs');
  for (const call of cases) traceAgentTool(structuredClone(call));
  await drainAgentTrace();
  // No wait for the failure log: the process exit flushes it, which is what keeps a short-lived process's failure rows.
} else {
  const tree = resolveTree(parseArgs());
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const scratch = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-trace-redaction-'));
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: scratch,
      USERPROFILE: scratch,
      APPDATA: scratch,
      LOCALAPPDATA: scratch,
      MIXDOG_TREE: tree,
      MIXDOG_DATA_DIR: join(scratch, 'data'),
      MIXDOG_AGENT_TRACE_PATH: join(scratch, 'trace.jsonl'),
      MIXDOG_TOOL_FAILURE_LOG_PATH: join(scratch, 'failures.jsonl'),
      MIXDOG_AGENT_TRACE_DISABLE: '',
      MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
      MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
      MIXDOG_RUNTIME_ROOT: join(scratch, 'no-service'),
    },
  });
  if (run.status !== 0) throw new Error(`child failed: ${run.stderr || run.stdout}`);
  const golden = { note: 'the trace rows and failure rows of real Node over the three calls of its redaction test', now: T0, cases, trace: readFileSync(join(scratch, 'trace.jsonl'), 'utf8'), failures: readFileSync(join(scratch, 'failures.jsonl'), 'utf8') };
  rmSync(scratch, { recursive: true, force: true });

  const finalDir = join(FIXTURES_ROOT, 'agent-trace-redaction');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), golden);
  writeSetManifest(stage, {
    set: 'agent-trace-redaction',
    recorder,
    command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      syntheticInputs: ['the three tool calls of agent-trace-failures.test.mjs, given to traceAgentTool unchanged; the clock is fixed at `now`'],
      keptWhole: 'the trace sink and the failure sink as Node wrote them, every line, nothing excluded',
    },
  });
  commitStage(stage, finalDir);
  console.log(`trace lines=${golden.trace.trim().split('\n').length} failure lines=${golden.failures.trim().split('\n').length}`);
}
