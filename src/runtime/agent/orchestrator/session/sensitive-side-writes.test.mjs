// A value a fill marked sensitive is in none of the files written beside the
// session's own: the memory database's ingest and the agent trace with its
// tool-failure log get the marker, as the session file does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rememberSensitiveValues } from './sensitive-values.mjs';
import { createMemoryIngest } from '../../../../session-runtime/lifecycle/memory-ingest.mjs';

const CODE = '482913';
const fill = { name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: CODE } } };

test('a closing session goes to memory with its sensitive values as the marker', async () => {
  const sessionId = 'sess_sensitive_memory';
  rememberSensitiveValues(sessionId, [fill]);
  const seen = [];
  const ingest = createMemoryIngest({
    getMemoryModPromise: () => Promise.resolve({ handleToolCall: async (_name, args) => seen.push(args) }),
    getCurrentCwd: () => 'C:/work',
    withTeardownDeadline: (promise) => promise,
  });
  const messages = [
    { role: 'tool', toolCallId: 'm', content: `Your code is ${CODE}` },
    { role: 'assistant', content: '', toolCalls: [{ id: 'f', ...fill }] },
  ];
  await ingest({ id: sessionId, cwd: 'C:/work', messages });
  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen[0]).includes(CODE), JSON.stringify(seen[0]));
  assert.equal(seen[0].messages[0].content, 'Your code is [redacted]');
  assert.equal(seen[0].messages[1].toolCalls[0].arguments.input.text, '[redacted]');
  assert.equal(messages[0].content, `Your code is ${CODE}`, 'the loaded session keeps the value');
});

test('a failed sensitive fill reaches the trace and the failure log with the marker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-sensitive-trace-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { rememberSensitiveValues } from './src/runtime/agent/orchestrator/session/sensitive-values.mjs';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      const fill = ${JSON.stringify(fill)};
      rememberSensitiveValues('sess_sensitive_trace', [fill]);
      traceAgentTool({
        sessionId: 'sess_sensitive_trace', iteration: 1, toolName: 'browser', toolKind: 'internal',
        toolMs: 1, toolArgs: fill.arguments, resultKind: 'error', resultText: 'Error: no such field',
      });
      await drainAgentTrace();
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          MIXDOG_AGENT_TRACE_PATH: join(directory, 'trace.jsonl'),
          MIXDOG_TOOL_FAILURE_LOG_PATH: join(directory, 'failures.jsonl'),
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const trace = readFileSync(join(directory, 'trace.jsonl'), 'utf8');
    const failures = readFileSync(join(directory, 'failures.jsonl'), 'utf8');
    for (const text of [trace, failures]) {
      assert.ok(!text.includes(CODE), text);
      assert.ok(text.includes('[redacted]'), text);
    }
    assert.equal(JSON.parse(failures.trim()).tool_args.input.text, '[redacted]');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
