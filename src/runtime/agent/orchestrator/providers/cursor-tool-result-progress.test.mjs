import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CursorOAuthProvider } from './cursor.mjs';
import { __cursorWireInternals as wire } from './cursor-wire.mjs';
import { cursorNativeCall, registerCursorNativeCall } from './cursor-native-context.mjs';
import { classifyError, isProviderRecoveryTerminal } from './retry-classifier.mjs';

function fixture(t, ids, { native = false } = {}) {
  let onData = null;
  let onClose = null;
  const key = `cursor-result-progress:${randomUUID()}`;
  const bridge = {
    alive: true,
    writes: [],
    closedWith: null,
    onData(handler) {
      onData = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    write(frame) {
      this.writes.push(frame);
    },
    close(error) {
      if (!this.alive) return;
      this.alive = false;
      this.closedWith = error;
      onClose?.(error);
    },
    emit(message) {
      onData(wire.connectFrame(wire.encodeMessage('AgentServerMessage', message)));
    },
  };
  const pending = ids.map((id, index) => ({
    exec: { id: index + 1, execId: `exec-${index + 1}` },
    toolCallId: id,
    toolName: 'echo_value',
    decodedArgs: '{}',
  }));
  const active = {
    bridge,
    heartbeat: setInterval(() => {}, 10_000),
    conversation: { blobs: new Map(), checkpoint: null },
    tools: [],
    executions: new Map(),
    sessionId: key,
    ownerSessionId: key,
    pending,
  };
  if (native) {
    const call = pending.at(-1);
    call.toolName = 'read';
    call.decodedArgs = JSON.stringify({ file_path: 'fixture.txt', offset: 1, limit: 1 });
    call.native = { resultType: 'readResult', args: { path: 'fixture.txt', offset: 1, limit: 1 } };
    registerCursorNativeCall(key, call, active.executions);
  }
  t.after(() => {
    globalThis.__mixdogCloseProviderConnectionsForSession?.(key, 'test-complete');
    clearInterval(active.heartbeat);
    bridge.close();
  });
  return { key, bridge, active, pending };
}

function transcript(pending, results) {
  return [
    { role: 'user', content: 'Run the requested tools.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: pending.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        arguments: JSON.parse(call.decodedArgs),
      })),
    },
    ...results,
  ];
}

function request(provider, messages, sessionScope) {
  return provider._chatBody(messages, {
    cursorSelection: { modelId: 'grok-4.7', parameters: [] },
    sessionScope,
    openAiTools: [],
  });
}

function replies(bridge) {
  return bridge.writes.map((frame) => wire.decodeMessage('AgentClientMessage', frame.subarray(5)).execClientMessage);
}

function assertTerminal(error) {
  assert.equal(error.code, 'tool_result_no_progress');
  assert.match(error.message, /no matching result/);
  assert.equal(classifyError(error), 'permanent');
  assert.equal(isProviderRecoveryTerminal(error), true);
  return true;
}

test('Cursor preserves long, multiline and native call ids through result conversion and resumption', async (t) => {
  const f = fixture(t, ['short-id', `call-${'a'.repeat(36)}-4\nfc_${'b'.repeat(36)}_1`, 'native'], {
    native: true,
  });
  const nativeCall = f.pending.at(-1);
  const nativeId = nativeCall.toolCallId;
  const messages = transcript(
    f.pending,
    f.pending.map((call) => ({
      role: 'tool',
      toolCallId: call.toolCallId,
      content: call.native ? '[lines 1-1]\nfixture' : `result for ${call.exec.execId}`,
      toolKind: 'normal',
    }))
  );
  const before = structuredClone(messages);
  const body = request(new CursorOAuthProvider(), messages, f.key);
  const parsed = wire.parseMessages(body.messages);
  assert.deepEqual(
    body.messages.find((message) => message.tool_calls).tool_calls.map((call) => call.id),
    f.pending.map((call) => call.toolCallId)
  );
  assert.deepEqual(
    parsed.toolResults.map((result) => result.toolCallId),
    f.pending.map((call) => call.toolCallId)
  );
  assert.deepEqual(messages, before, 'wire conversion must not rewrite persisted history');
  assert.ok(cursorNativeCall(f.key, nativeId, 'read', JSON.parse(nativeCall.decodedArgs)));

  const response = wire.resumeRun(f.active, parsed.toolResults, '', 'grok-4.7', f.key);
  const sent = replies(f.bridge);
  assert.deepEqual(
    sent.map((result) => result.execId),
    ['exec-1', 'exec-2', 'exec-3']
  );
  assert.ok(sent[0].mcpResult.success);
  assert.ok(sent[1].mcpResult.success);
  assert.equal(sent[2].readResult.success.content, 'fixture');
  assert.equal(f.active.pending.length, 0);
  assert.throws(
    () => cursorNativeCall(f.key, nativeId, 'read', JSON.parse(nativeCall.decodedArgs)),
    /authorization is missing/,
    'completed native capabilities are released, not weakened'
  );
  f.bridge.emit({ interactionUpdate: { turnEnded: {} } });
  f.bridge.close();
  const completed = await response.text();
  assert.match(completed, /"finish_reason":"stop"/);
  assert.doesNotMatch(completed, /"tool_calls"/, 'acknowledged tools are never handed out again');
});

test('partial progress accepts error results, but repeating an answered result stops the unchanged pending call', async (t) => {
  const f = fixture(t, ['first', 'native'], { native: true });
  const nativeCall = f.pending[1];
  const nativeId = nativeCall.toolCallId;
  const first = wire.resumeRun(
    f.active,
    [{ toolCallId: 'first', content: 'The tool failed.', isError: true }],
    '',
    'grok-4.7',
    f.key
  );
  const text = await first.text();
  assert.ok(replies(f.bridge)[0].mcpResult.error, 'an explicit tool error is still a delivered result');
  assert.ok(text.includes(nativeId));
  assert.equal(wire.activeRunPendingCount(f.key), 1);
  assert.ok(cursorNativeCall(f.key, nativeId, 'read', JSON.parse(nativeCall.decodedArgs)));
  let terminal;
  assert.throws(
    () =>
      wire.resumeRun(
        f.active,
        [{ toolCallId: 'first', content: 'The same old result.', isError: true }],
        'Please continue.',
        'grok-4.7',
        f.key
      ),
    (error) => {
      terminal = error;
      return assertTerminal(error);
    }
  );
  assert.equal(f.bridge.writes.length, 1, 'an already answered result is not sent twice');
  assert.equal(f.bridge.alive, false);
  assert.equal(f.bridge.closedWith, terminal);
  assert.equal(wire.activeRunPendingCount(f.key), 0);
  assert.equal(f.active.pending.length, 0);
  assert.throws(
    () => cursorNativeCall(f.key, nativeId, 'read', JSON.parse(nativeCall.decodedArgs)),
    /authorization is missing/,
    'abandoned native capabilities must also be released'
  );
});

test('empty, foreign and renamed results fail without re-emitting a pending call', async (t) => {
  for (const kind of ['empty', 'foreign', 'renamed']) {
    await t.test(kind, (t) => {
      const f = fixture(t, ['pending']);
      const results =
        kind === 'empty' ? [] : [{ toolCallId: kind === 'renamed' ? 'pending-2' : 'foreign', content: 'done' }];
      assert.throws(() => wire.resumeRun(f.active, results, '', 'grok-4.7', f.key), assertTerminal);
      assert.equal(f.bridge.writes.length, 0);
      assert.equal(f.bridge.alive, false);
      assert.equal(f.active.pending.length, 0);
    });
  }
});

test('the Cursor provider surfaces a no-progress handoff once instead of retrying the request', async (t) => {
  const f = fixture(t, ['pending']);
  let sends = 0;
  const provider = new CursorOAuthProvider({
    accessToken: 'local-test-token',
    runtime: {
      async getCursorModels() {
        return [];
      },
      async handleChatCompletion(body) {
        sends += 1;
        return wire.resumeRun(f.active, wire.parseMessages(body.messages).toolResults, '', 'grok-4.7', f.key);
      },
    },
  });
  const messages = transcript(
    [{ ...f.pending[0], toolCallId: 'pending-2' }],
    [{ role: 'tool', toolCallId: 'pending-2', content: 'mismatched result' }]
  );
  await assert.rejects(provider.send(messages, 'grok-4.7', [], { sessionId: f.key }), assertTerminal);
  assert.equal(sends, 1);
  assert.equal(f.bridge.alive, false);
});
