// A value a fill marked sensitive is in none of the files written beside the
// session's own: the memory database's ingest, the agent trace with its
// tool-failure log and a compaction's execution dump get the marker, as the
// session file does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rememberSensitiveValues } from './sensitive-values.mjs';
import { EXECUTION_RECOVERY_SOURCE, buildExecutionTail } from './compact/execution-tail.mjs';
import { createMemoryIngest } from '../../../../session-runtime/lifecycle/memory-ingest.mjs';
import { createRecallResourceApi } from '../../../../session-runtime/resource-recall-api.mjs';

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

test('a recall that stores the live session in memory stores its sensitive values as the marker', async () => {
  const sessionId = 'sess_sensitive_recall';
  rememberSensitiveValues(sessionId, [fill]);
  const seen = [];
  const messages = [
    { role: 'user', content: `The portal mailed me ${CODE}.` },
    { role: 'assistant', content: '', toolCalls: [{ id: 'f', ...fill }] },
  ];
  const api = createRecallResourceApi({
    deps: {
      getConfig: () => ({}),
      getSession: () => ({ id: sessionId, messages }),
      getCurrentCwd: () => 'C:/work',
      cfgMod: { normalizeProfileConfig: () => null },
      getMemoryModule: async () => ({
        handleToolCall: async (_name, args) => {
          seen.push(args);
          return { content: [{ type: 'text', text: '(no results)' }] };
        },
      }),
    },
  });
  // A query the session's own rows do not answer: the live session is stored, then recalled.
  await api.recall('zebra migration');
  const ingest = seen.find((args) => args.action === 'ingest_session');
  assert.ok(ingest, JSON.stringify(seen));
  assert.ok(!JSON.stringify(ingest).includes(CODE), JSON.stringify(ingest));
  assert.equal(ingest.messages[0].content, 'The portal mailed me [redacted].');
  assert.equal(messages[0].content, `The portal mailed me ${CODE}.`, 'the live session keeps the value');
});

test("a compaction's execution dump and its blobs hold the session's sensitive values as the marker", (t) => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sensitive-dump-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = 'sess_sensitive_dump';
  rememberSensitiveValues(sessionId, [fill]);
  const messages = [
    { role: 'user', content: `The portal mailed me ${CODE}.` },
    { role: 'assistant', content: '', toolCalls: [{ id: 'f', ...fill }] },
    { role: 'tool', toolCallId: 'f', content: `Filled ${CODE}\n${'page line\n'.repeat(15_000)}` },
    { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'r', content: 'ok' },
  ];
  const result = buildExecutionTail(messages, { contextWindow: 40_000, sessionId });
  const recovery = result.messages.find((m) => m.meta?.source === EXECUTION_RECOVERY_SOURCE);
  const dumpDir = dirname(recovery.content.match(/available at (.+?) \(sha256:/)[1]);
  const files = readdirSync(dumpDir);
  assert.ok(files.length >= 2, files.join(','));
  for (const name of files) {
    const text = readFileSync(join(dumpDir, name), 'utf8');
    assert.ok(!text.includes(CODE), name);
  }
  assert.equal(messages[0].content, `The portal mailed me ${CODE}.`, 'the live transcript keeps the value');
});

test('a failed sensitive fill reaches the trace and the failure log with the marker, its error text included', () => {
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
        toolMs: 1, toolArgs: fill.arguments, resultKind: 'error', resultText: 'Error: the field refused "${CODE}"',
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
    assert.equal(JSON.parse(failures.trim()).error_first_line, 'Error: the field refused "[redacted]"');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
