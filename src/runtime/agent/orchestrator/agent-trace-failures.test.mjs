import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyToolFailure, summarizeToolArgs } from './agent-trace-format.mjs';

test('failure rows keep read file_path and the full size of clipped path batches', () => {
  const many = Array.from({ length: 12 }, (_, index) => `f${index}.mjs`);
  assert.deepEqual(summarizeToolArgs('read', { file_path: 'a.mjs', limit: 5 }), { file_path: 'a.mjs', limit: 5 });
  assert.equal(summarizeToolArgs('read', { file_path: many }).file_path_count, 12);
  assert.equal(summarizeToolArgs('grep', { pattern: 'x', path: many }).path_count, 12);
  assert.equal(
    classifyToolFailure('Error: goal tasks support at most 20 entries; completed and dropped tasks count', 'goal'),
    'schema/args'
  );
});

test('edit misses stay runtime failures whatever words the quoted file text holds', () => {
  const excerpt =
    '\ncurrent file excerpt lines 15-24 (use exact current text for retry):\n' +
    "import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle.mjs';\n" +
    '// a timeout or permission denied here is retried';
  for (const head of [
    "Error: edit failed (old_string not found; nearest match on line 18: import { probe } from './store/fs-probe.mjs';)",
    'Error: edit failed (old_string found 2 times; pass replace_all:true or extend old_string)',
  ]) {
    assert.equal(classifyToolFailure(`${head}${excerpt}`, 'edit'), 'runtime/failure');
  }
});

test('emitted input errors, upstream HTTP failures and user cancellations have distinct categories', () => {
  const rows = [
    ['goal', 'Error: new Goal tasks must omit ids; use updates for existing tasks', 'schema/args'],
    ['goal', 'Error: goal task exceeds 500 characters', 'schema/args'],
    ['goal', 'Error: goal tasks support at most 20 entries', 'schema/args'],
    ['browser', 'Error: browser action "navigate" does not accept input field(s): mode', 'schema/args'],
    ['github', 'Error: Unsupported field for GitHub run.list.', 'schema/args'],
    ['read', 'The arguments provided to `read` are invalid JSON and could not be parsed: bad JSON', 'schema/args'],
    ['grep', 'Error: regex parse error: unclosed group', 'schema/args'],
    [
      'shell',
      'Error: [shell-tool-failed] shell arg "cwd" is unsupported; use only command and timeout_ms',
      'schema/args',
    ],
    ['web_fetch', 'Error: [https://example.test/]\n(error: HTTP 404)\nerrorCode: HTTP_ERROR', 'upstream/http'],
    [
      'media',
      'Error: {"ok":false,"error":"generation failed on gemini/model: Gemini image failed (503): high demand"}',
      'upstream/http',
    ],
    [
      'browser',
      'Error: Browser command interrupted by local user input. An earlier action may have completed; do not replay it.',
      'expected-cancellation',
    ],
    [
      'computer',
      'Error: computer_user_control_active: Computer Use is paused while the user has control',
      'expected-cancellation',
    ],
    [
      'web_search',
      'Error: Web search failed: native web search failed: grok-oauth/grok/web_search: runtime is closing',
      'lifecycle/closing',
    ],
    [
      'browser',
      'Error: The browser input executed, but its rendering checkpoint failed; input was not replayed. frame topology changed during observation',
      'runtime/failure',
    ],
    ['browser', 'Error: page target crashed; navigate to reload this page or choose another tab', 'runtime/failure'],
    ['browser', 'Error: observation crashed\nQuoted page text: schema is required', 'runtime/failure'],
    [
      'shell',
      '\r\n ⚠️ destructive command warning\r\n eRrOr: Session "sess_cancelled" closed: aborted during call \r\n',
      'expected-cancellation',
    ],
    [
      'shell',
      '⚠️ destructive command warning\nError: [shell-run-failed] exit code: 7\nSession "quoted" closed: aborted during call',
      'command-exit',
    ],
    ['browser', '\r\n ⚠️ warning only \r\n', 'runtime/failure'],
  ];
  for (const [tool, text, category] of rows) assert.equal(classifyToolFailure(text, tool), category, text);
});

test('failure traces redact secrets and preserve structured errors without logging session cancellations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-structured-failure-'));
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
        sessionId: 'structured-failure', iteration: 1, toolName: 'computer', toolKind: 'internal',
        toolMs: 1, resultKind: 'error',
        resultText: { isError: true, content: [
          { type: 'text', text: 'Error: foreground_unavailable\\nAuthorization: Bearer secret-example-token' },
          { type: 'image', mimeType: 'image/png', data: 'image-bytes-must-not-enter-logs' },
        ] },
      });
      traceAgentTool({
        sessionId: 'structured-failure', iteration: 1, toolName: 'shell', toolKind: 'internal',
        toolMs: 1, resultKind: 'error',
        resultText: '\\r\\n ⚠️ destructive command warning\\r\\n Error: Session "sess_cancelled" closed: aborted during call',
      });
      traceAgentTool({
        sessionId: 'structured-failure', iteration: 1, toolName: 'shell', toolKind: 'internal',
        toolMs: 1, resultKind: 'error',
        resultText: 'Error: failed: mysql --password hunter2-flag -p hunter2-short https://user:hunter2-url@host.example/x',
      });
      await drainAgentTrace();
      // No wait for the failure log: the process exit flushes it, which is
      // what keeps a short-lived process's failure rows.
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
    // The cancellation is not a failure row; the structured error and the
    // credential-bearing command are.
    const [row, flags, ...rest] = log.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rest.length, 0);
    assert.equal(row.error_first_line, 'Error: foreground_unavailable');
    assert.match(row.error_preview, /Authorization: Bearer \[redacted\]/);
    assert.match(flags.error_preview, /--password \[redacted\]/);
    assert.doesNotMatch(log, /\[object Object\]|image-bytes-must-not-enter-logs|secret-example-token/);
    const traceText = readFileSync(join(directory, 'trace.jsonl'), 'utf8');
    // --password, -p and URL userinfo values reach neither sink.
    assert.doesNotMatch(log + traceText, /hunter2/);
    const traces = traceText.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(traces.length, 3);
    assert.equal(traces[0].result_error_first_line, row.error_first_line);
    assert.equal(traces[1].result_error_category, 'expected-cancellation');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('historical failure reclassification preserves the original log bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-failure-categories-'));
  try {
    mkdirSync(join(directory, 'history'));
    const path = join(directory, 'history', 'tool-failures.jsonl');
    const original = `${[
      {
        ts: 1,
        tool_name: 'goal',
        category: 'runtime/failure',
        error_preview: 'Error: goal task exceeds 500 characters',
      },
      {
        ts: 2,
        tool_name: 'browser',
        category: 'runtime/failure',
        error_preview: 'Error: browser action "locate" does not accept input field(s): maxChars',
      },
      {
        ts: 3,
        tool_name: 'media',
        category: 'runtime/failure',
        error_preview:
          'Error: {"ok":false,"error":"generation failed on gemini/model: Gemini image failed (503): high demand"}',
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`;
    writeFileSync(path, original);
    const result = spawnSync(process.execPath, ['scripts/tool-failures.mjs', '--data-dir', directory, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.rows.map((row) => row.category),
      ['schema/args', 'schema/args', 'upstream/http']
    );
    assert.ok(report.rows.every((row) => row.stored_category === 'runtime/failure'));
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
