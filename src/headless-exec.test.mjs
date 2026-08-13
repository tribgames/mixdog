import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifyCliInvocation } from './headless-command.mjs';
import { runHeadlessExec } from './headless-exec.mjs';

test('headless exec runs one implicit-approval session and waits for tracked tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-exec-test-'));
  const usageLogPath = join(root, 'usage.json');
  const output = [];
  const errors = [];
  const runtimeOptions = [];
  const activeScopes = [];
  let activeChecks = 0;
  let boundaryCleaned = false;
  let runtimeClosed = false;
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      usageLogPath,
      idlePollMs: 1,
      write: (text) => output.push(text),
      writeErr: (text) => errors.push(text),
      boundaryFactory: () => ({
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup: () => { boundaryCleaned = true; },
      }),
      runtimeFactory: async (options) => {
        runtimeOptions.push(options);
        return {
          id: 'sess_exec_test',
          model: 'gpt-test',
          clientHostPid: 123,
          ask: async (_prompt, optionsForAsk) => {
            optionsForAsk.onUsageDelta({
              deltaInput: 11,
              deltaCachedRead: 7,
              deltaCacheWrite: 3,
              deltaOutput: 5,
            });
            return { result: { content: 'done' } };
          },
          close: async () => { runtimeClosed = true; },
        };
      },
      hasActiveTasks: (scope) => {
        activeScopes.push(scope);
        activeChecks += 1;
        return activeChecks === 1;
      },
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(output, ['done\n']);
    assert.deepEqual(errors, []);
    assert.equal(runtimeOptions[0].approvalMode, 'implicit');
    assert.equal(runtimeOptions[0].disallowDelegation, true);
    assert.equal(runtimeOptions[0].toolMode, 'full');
    assert.deepEqual(activeScopes[0], {
      callerSessionId: 'sess_exec_test',
      clientHostPid: 123,
    });
    assert.equal(boundaryCleaned, true);
    assert.equal(runtimeClosed, true);
    const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
    assert.deepEqual(usage.totals, {
      inputTokens: 11,
      cacheTokens: 7,
      cacheWriteTokens: 3,
      outputTokens: 5,
      toolCallCountApprox: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless exec emits a timestamped JSONL lifecycle and exact tool count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-json-test-'));
  const usageLogPath = join(root, 'usage.json');
  const output = [];
  const errors = [];
  let notificationListener = null;
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      json: true,
      usageLogPath,
      write: (text) => output.push(text),
      writeErr: (text) => errors.push(text),
      boundaryFactory: () => ({
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup() {},
      }),
      runtimeFactory: async () => ({
        id: 'sess_json_test',
        provider: 'openai-oauth',
        model: 'gpt-test',
        effort: 'high',
        fast: true,
        cwd: '/app',
        clientHostPid: 123,
        onNotification(listener) {
          notificationListener = listener;
          return () => { notificationListener = null; };
        },
        async ask(_prompt, options) {
          options.onProviderSendStarted();
          options.onReasoningDelta('inspect first');
          options.onUsageDelta({
            deltaInput: 11,
            deltaCachedRead: 7,
            deltaCacheWrite: 3,
            deltaOutput: 5,
          });
          await options.onToolCall(1, [{
            id: 'call_1',
            name: 'shell',
            arguments: { command: 'echo ok' },
          }]);
          options.onToolPhaseStarted();
          options.onToolResult({
            role: 'tool',
            toolCallId: 'call_1',
            content: 'ok\n',
            toolKind: 'normal',
          });
          options.onToolPhaseCompleted({ iteration: 1, calls: 1, elapsedMs: 2 });
          notificationListener?.({
            content: 'background task completed',
            meta: { status: 'completed' },
          });
          options.onProviderSendStarted();
          options.onAssistantText('done');
          options.onUsageDelta({
            deltaInput: 5,
            deltaCachedRead: 0,
            deltaCacheWrite: 0,
            deltaOutput: 2,
          });
          return { result: { content: 'done', stopReason: 'end_turn' } };
        },
        async close() {},
      }),
      hasActiveTasks: () => false,
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const events = output.join('').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'thread.started');
    assert.equal(events[1].type, 'turn.started');
    assert.ok(events.every((event) => event.schema_version === 1 && event.timestamp));
    const toolStarted = events.find(
      (event) => event.type === 'item.started' && event.item?.type === 'tool_call',
    );
    const toolCompleted = events.find(
      (event) => event.type === 'item.completed' && event.item?.id === 'call_1',
    );
    assert.equal(toolStarted.item.name, 'shell');
    assert.equal(toolCompleted.item.output, 'ok\n');
    assert.equal(toolCompleted.item.status, 'completed');
    assert.ok(toolCompleted.item.duration_ms >= 0);
    assert.ok(events.some((event) => event.type === 'notification'));
    assert.equal(events.filter((event) => event.type === 'model.request.completed').length, 2);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'result');
    assert.equal(terminal.subtype, 'success');
    assert.equal(terminal.session_id, 'sess_json_test');
    assert.equal(terminal.provider_requests, 2);
    assert.equal(terminal.tool_calls, 1);
    assert.deepEqual(terminal.usage, {
      input_tokens: 16,
      cached_input_tokens: 7,
      cache_write_input_tokens: 3,
      output_tokens: 7,
      tool_calls: 1,
    });
    const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
    assert.equal(usage.totals.toolCallCountApprox, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless exec emits structured JSONL failure before returning exit 1', async () => {
  const output = [];
  const errors = [];
  const code = await runHeadlessExec({
    message: 'fail',
    provider: 'openai-oauth',
    model: 'gpt-test',
    json: true,
    usageLogPath: '',
    write: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
    boundaryFactory: () => ({
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
      cleanup() {},
    }),
    runtimeFactory: async () => ({
      id: 'sess_json_failure',
      model: 'gpt-test',
      clientHostPid: 123,
      async ask() {
        throw new Error('boom');
      },
      async close() {},
    }),
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });

  const events = output.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(code, 1);
  assert.ok(events.some((event) => event.type === 'turn.failed'));
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).subtype, 'error_during_execution');
  assert.deepEqual(events.at(-1).errors, ['boom']);
  assert.deepEqual(errors, ['mixdog: boom\n']);
});

test('--json is accepted for exec and rejected for the interactive command', () => {
  const exec = classifyCliInvocation([
    'exec',
    '--provider', 'openai-oauth',
    '--model', 'gpt-test',
    '--json',
    'fix it',
  ]);
  assert.equal(exec.kind, 'exec');
  assert.equal(exec.options.json, true);

  const interactive = classifyCliInvocation(['--json']);
  assert.equal(interactive.kind, 'error');
  assert.equal(interactive.error, 'option --json is only supported for mixdog exec');
});
