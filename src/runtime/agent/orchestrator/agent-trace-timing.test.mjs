import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('tool and stream traces preserve stage timing and mirrored SSE fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-tool-timing-'));
  try {
    const tracePath = join(dir, 'agent-trace.jsonl');
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { traceAgentSse } from './src/runtime/agent/orchestrator/agent-trace.mjs';
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
      traceAgentSse({
        sessionId: 'timing-test', sseParseMs: 120.5, ttftMs: 0,
        provider: 'test-provider', model: 'test-model', transport: 'sse',
      });
      await drainAgentTrace();
      const rows = readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8')
        .trim().split(/\\r?\\n/).map(JSON.parse);
      process.stdout.write(JSON.stringify({ timing: rows[0].payload.timing, sse: rows[1] }));
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          MIXDOG_AGENT_TRACE_PATH: tracePath,
          MIXDOG_AGENT_TRACE_DISABLE: '',
          MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
          MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
        },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.timing, {
      dispatch_wait_ms: 10,
      execution_ms: 50,
      result_collection_wait_ms: 15,
      postprocess_ms: 15,
      total_ms: 90,
    });
    const { ts, ...sse } = result.sse;
    assert.ok(Number.isFinite(ts));
    assert.deepEqual(sse, {
      kind: 'sse',
      sse_parse_ms: 120.5,
      stream_total_ms: 120.5,
      ttft_ms: 0,
      first_token_ms: 0,
      provider: 'test-provider',
      model: 'test-model',
      transport: 'sse',
      payload: {
        sse_parse_ms: 120.5,
        stream_total_ms: 120.5,
        ttft_ms: 0,
        first_token_ms: 0,
        provider: 'test-provider',
        model: 'test-model',
        transport: 'sse',
      },
      session_id: 'timing-test',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
