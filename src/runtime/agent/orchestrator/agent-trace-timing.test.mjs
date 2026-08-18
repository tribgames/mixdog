import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('tool traces expose dispatch, execution, collection, and postprocess timing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-tool-timing-'));
  try {
    const tracePath = join(dir, 'agent-trace.jsonl');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      traceAgentTool({
        sessionId: 'timing-test',
        iteration: 1,
        toolName: 'grep',
        toolKind: 'builtin',
        toolMs: 50,
        resultKind: 'normal',
        resultText: 'ok',
        toolTiming: {
          dispatchStartedAt: 100,
          executionStartedAt: 110,
          executionCompletedAt: 160,
          postprocessStartedAt: 175,
          resultCompletedAt: 190,
        },
      });
      await drainAgentTrace();
      const row = JSON.parse(readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8').trim());
      process.stdout.write(JSON.stringify(row.payload.timing));
    `], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_AGENT_TRACE_PATH: tracePath,
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
        MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      dispatch_wait_ms: 10,
      execution_ms: 50,
      result_collection_wait_ms: 15,
      postprocess_ms: 15,
      total_ms: 90,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
