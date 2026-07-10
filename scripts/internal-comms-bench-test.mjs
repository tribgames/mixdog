import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  CHILD_RESULT_END,
  CHILD_RESULT_START,
  DEFAULT_LEAD_APPROVAL_PROMPT,
  buildLiveLeadDriver,
  leadModeExitCode,
  parseLiveLeadResult,
  runLiveLeadDelegation,
  validateLeadRun,
} from './internal-comms-bench.mjs';

function writeRuntime(root, managerSource) {
  const runtimePath = join(root, 'runtime.mjs');
  const tracePath = join(root, 'agent-trace-io.mjs');
  writeFileSync(runtimePath, managerSource);
  writeFileSync(tracePath, 'export async function drainAgentTrace() {}\n');
  return {
    runtimeUrl: pathToFileURL(runtimePath).href,
    traceUrl: pathToFileURL(tracePath).href,
  };
}

function writeSandboxRuntime(root, marker) {
  const runtimePath = join(root, 'mixdog-session-runtime.mjs');
  const tracePath = join(root, 'runtime', 'agent', 'orchestrator', 'agent-trace-io.mjs');
  mkdirSync(join(root, 'runtime', 'agent', 'orchestrator'), { recursive: true });
  writeFileSync(runtimePath, `
    import { writeFileSync } from 'node:fs';
    export async function createMixdogSessionRuntime() {
      writeFileSync(process.env.RUNTIME_MARKER_PATH, ${JSON.stringify(marker)});
      return {
        id: 'sess_default_resolution', sessionId: 'sess_default_resolution',
        async setFast() {},
        toolsStatus() { return { activeTools: ['agent'] }; },
        onNotification() {},
        agentStatus() { return { agentJobs: [] }; },
        async ask() { return { result: { text: 'done' } }; },
        async close() {},
      };
    }
  `);
  writeFileSync(tracePath, 'export async function drainAgentTrace() {}\n');
}

test('lead delegation resolves default runtime and trace imports from the variant plugin root', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-bench-test-'));
  const pluginA = join(root, 'plugin-A');
  const pluginB = join(root, 'plugin-B');
  const markerPath = join(root, 'runtime-marker');
  const priorMarkerPath = process.env.RUNTIME_MARKER_PATH;
  try {
    process.env.RUNTIME_MARKER_PATH = markerPath;
    writeSandboxRuntime(pluginA, 'A');
    writeSandboxRuntime(pluginB, 'B');
    for (const [pluginRoot, expected] of [[pluginA, 'A'], [pluginB, 'B']]) {
      const run = runLiveLeadDelegation({
        pluginRoot,
        dataDir: root,
        taskCwd: root,
        prompt: 'Use the variant runtime.',
        provider: 'test-provider',
        model: 'test-model',
        fast: false,
      });
      assert.equal(run.ok, true, run.stderr || run.stdout);
      assert.equal(readFileSync(markerPath, 'utf8'), expected);
    }
  } finally {
    if (priorMarkerPath === undefined) delete process.env.RUNTIME_MARKER_PATH;
    else process.env.RUNTIME_MARKER_PATH = priorMarkerPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lead driver plans before explicit approval, drains traces, and exits despite open handles', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-bench-test-'));
  const promptsPath = join(root, 'prompts.jsonl');
    const tracePath = join(root, 'trace-drained');
    const activeToolsPath = join(root, 'active-tools.json');
  try {
    const runtimeUrls = writeRuntime(root, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      let calls = 0;
      let fastApplied = false;
      setInterval(() => {}, 1000);
      export async function createMixdogSessionRuntime() {
        return {
          id: 'sess_bench_test', sessionId: 'sess_bench_test',
          async setFast(value) {
            if (typeof value !== 'boolean') throw new Error('fast must be boolean');
            fastApplied = true;
            writeFileSync(process.env.FAST_PATH, JSON.stringify(value));
          },
          toolsStatus() {
            writeFileSync(process.env.ACTIVE_TOOLS_PATH, JSON.stringify(['agent']));
            return { activeTools: ['agent'] };
          },
          onNotification() {},
          agentStatus() { return { agentJobs: [] }; },
          async ask(prompt) {
            if (!fastApplied) throw new Error('fast was not applied before prompting');
            appendFileSync(process.env.PROMPTS_PATH, JSON.stringify(prompt) + '\\n');
            calls += 1;
            return { result: calls === 1 ? { text: 'plan' } : { text: 'completed {math.js:1}' } };
          },
          async close() { this.id = ''; this.sessionId = ''; },
        };
      }
    `);
    writeFileSync(join(root, 'agent-trace-io.mjs'), `
      import { writeFileSync } from 'node:fs';
      export async function drainAgentTrace() {
        await new Promise((resolve) => setTimeout(resolve, 75));
        writeFileSync(process.env.TRACE_PATH, 'drained');
      }
    `);
    const driver = buildLiveLeadDriver({
      ...runtimeUrls,
      taskCwd: root,
      prompt: 'Plan the benchmark task.',
      provider: 'test-provider',
      model: 'test-model',
      fast: false,
    });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      env: { ...process.env, PROMPTS_PATH: promptsPath, ACTIVE_TOOLS_PATH: activeToolsPath, TRACE_PATH: tracePath, FAST_PATH: join(root, 'fast.json') },
      timeout: 2000,
    });

    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(
      readFileSync(promptsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse),
      ['Plan the benchmark task.', DEFAULT_LEAD_APPROVAL_PROMPT],
    );
    assert.deepEqual(JSON.parse(readFileSync(activeToolsPath, 'utf8')), ['agent']);
    assert.equal(JSON.parse(readFileSync(join(root, 'fast.json'), 'utf8')), false);
    assert.equal(readFileSync(tracePath, 'utf8'), 'drained');
    assert.deepEqual(parseLiveLeadResult(child.stdout), {
      text: 'completed {math.js:1}',
      sessionId: 'sess_bench_test',
    });
    assert.match(child.stdout, new RegExp(`${CHILD_RESULT_START}.*${CHILD_RESULT_END}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lead validation rejects successful child output without worker and reviewer participation', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-bench-test-'));
  try {
    writeFileSync(join(root, 'math.js'), `export function mul(a, b) { return a * b; }\nexport function add(a, b) { return a + b; }\n`);
    const split = {
      byRole: {
        lead: { usage_rows: 1 },
        worker: { usage_rows: 0 },
        reviewer: { usage_rows: 0 },
        other: { usage_rows: 0 },
      },
      total: { usage_rows: 1 },
    };
    const validation = validateLeadRun({ taskCwd: root, run: { ok: true }, split });
    assert.equal(validation.valid, false);
    assert.deepEqual(validation.reasons, [
      'worker participation/usage is missing',
      'reviewer participation/usage is missing',
    ]);
    assert.equal(leadModeExitCode(
      { A: [{ valid: false }], B: [{ valid: true }] },
      { A: [], B: [split] },
    ), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('child failures retain stdout and stderr diagnostics and cannot succeed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-bench-test-'));
  try {
    const runtimeUrls = writeRuntime(root, `
      export async function createMixdogSessionRuntime() {
        return {
          id: 'sess_bench_failure', sessionId: 'sess_bench_failure',
          async setFast() {},
          toolsStatus() { return { activeTools: ['agent'] }; },
          onNotification() {},
          agentStatus() { return { agentJobs: [] }; },
          async ask() {
            console.log('provider stdout {diagnostic}');
            console.error('provider stderr {diagnostic}');
            throw new Error('provider failure');
          },
          async close() {},
        };
      }
    `);
    const run = runLiveLeadDelegation({
      pluginRoot: root,
      dataDir: root,
      taskCwd: root,
      prompt: 'Plan the benchmark task.',
      provider: 'test-provider',
      model: 'test-model',
      fast: false,
      runtimeUrls,
    });
    assert.equal(run.ok, false);
    assert.equal(run.sessionId, null);
    assert.match(run.stdout, /provider stdout \{diagnostic\}/);
    assert.match(run.stderr, /provider stderr \{diagnostic\}/);
    assert.equal(leadModeExitCode(
      { A: [{ valid: false }], B: [{ valid: false }] },
      { A: [], B: [] },
    ), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
