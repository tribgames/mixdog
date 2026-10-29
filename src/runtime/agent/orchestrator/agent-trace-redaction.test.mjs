import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('failure log previews redact --password/-p flags and URL userinfo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-redact-preview-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      traceAgentTool({
        sessionId: 'redact-preview', iteration: 1, toolName: 'shell', toolKind: 'internal',
        toolMs: 1, resultKind: 'error',
        resultText: 'Error: failed: mysql --password hunter2-flag -p hunter2-short https://user:hunter2-url@host.example/x',
      });
      await drainAgentTrace();
      // No wait for the failure log: the process exit flushes it.
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          MIXDOG_AGENT_TRACE_PATH: join(directory, 'trace.jsonl'),
          MIXDOG_TOOL_FAILURE_LOG_PATH: join(directory, 'failures.jsonl'),
          MIXDOG_AGENT_TRACE_DISABLE: '',
          MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
          MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
          MIXDOG_RUNTIME_ROOT: join(directory, 'no-service'),
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(join(directory, 'failures.jsonl'), 'utf8');
    const trace = readFileSync(join(directory, 'trace.jsonl'), 'utf8');
    assert.doesNotMatch(log + trace, /hunter2/);
    assert.match(log, /--password \[redacted\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
