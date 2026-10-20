import '../../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleExecMessage, sendToolResult } from './cursor-wire-exec.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { tryExecuteExternalToolAdapter } from '../tools/builtin/external-tool-adapters.mjs';
import { __cursorWireInternals as wire } from './cursor-wire.mjs';

function dispatch(exec, tools) {
  const frames = [];
  const calls = [];
  const bridge = { write: (bytes) => frames.push(bytes) };
  handleExecMessage(bridge, exec, tools, '', (call) => calls.push(call));
  return { bridge, frames, calls };
}
const decode = (frame) => decodeMessage('AgentClientMessage', frame.subarray(5)).execClientMessage;
const write = (fileText = '새 내용') => ({
  id: 7,
  execId: 'write-probe',
  writeArgs: {
    path: 'out/한글.txt',
    fileText,
    toolCallId: 'native-write',
  },
});
const editTool = { name: 'edit', inputSchemaObject: { properties: { file_path: {}, old_string: {}, new_string: {} } } };

test('native Write uses only a granted edit tool, even when an explicit write tool is also granted', () => {
  const denied = dispatch(write(), [{ name: 'read' }]);
  assert.equal(denied.calls.length, 0);
  assert.ok(decode(denied.frames[0]).writeResult.rejected);
  const granted = dispatch(write(), [editTool]);
  assert.equal(granted.frames.length, 0);
  assert.equal(granted.calls[0].toolName, 'edit');
  assert.deepEqual(JSON.parse(granted.calls[0].decodedArgs), {
    file_path: 'out/한글.txt',
    old_string: '',
    new_string: '새 내용',
  });
  const both = dispatch(write(), [editTool, { name: 'write' }]);
  assert.equal(both.calls[0].toolName, 'edit');
  assert.equal(both.calls[0].decodedArgs, granted.calls[0].decodedArgs);
  const writeOnly = dispatch(write(), [{ name: 'write' }]);
  assert.equal(writeOnly.calls.length, 0);
  assert.ok(decode(writeOnly.frames[0]).writeResult.rejected);
});

test('native Write never overwrites a non-empty file when an explicit write tool is also granted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-write-both-'));
  try {
    const path = join(root, 'out/한글.txt');
    await mkdir(join(root, 'out'));
    await writeFile(path, 'KEEP');
    const { calls } = dispatch(write('REPLACED'), [editTool, { name: 'write' }]);
    const result = await tryExecuteExternalToolAdapter(calls[0].toolName, JSON.parse(calls[0].decodedArgs), root, {
      sessionId: root,
    });
    assert.match(String(result), /^Error:/);
    assert.equal(await readFile(path, 'utf8'), 'KEEP');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Write through edit creates/fills files but never overwrites existing content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-write-'));
  try {
    const path = join(root, 'out/한글.txt');
    for (const state of ['missing', 'empty', 'nonempty']) {
      if (state !== 'missing') await writeFile(path, state === 'empty' ? '' : 'KEEP ORIGINAL');
      const { bridge, frames, calls } = dispatch(write(), [editTool]);
      const call = calls[0];
      const result = await tryExecuteExternalToolAdapter(call.toolName, JSON.parse(call.decodedArgs), root, {
        sessionId: root,
      });
      const ok = !String(result).startsWith('Error:');
      sendToolResult(bridge, call, { content: result }, ok);
      const reply = decode(frames[0]).writeResult;
      if (state === 'nonempty') {
        assert.equal(ok, false);
        assert.match(reply.error.error, /file exists/);
        assert.equal(reply.rejected, undefined, 'execution failure is not an approval rejection');
        assert.equal(reply.success, undefined);
        assert.equal(await readFile(path, 'utf8'), 'KEEP ORIGINAL');
      } else {
        assert.equal(ok, true);
        assert.ok(reply.success);
        assert.equal(await readFile(path, 'utf8'), '새 내용');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native UTF-8 Write preserves bytes when translated to edit text', () => {
  for (const text of ['문자열\\경로\n', '\uFEFF문자열\r\n']) {
    const exec = write('');
    exec.writeArgs.fileBytes = new TextEncoder().encode(text);
    const { calls } = dispatch(exec, [editTool]);
    assert.equal(JSON.parse(calls[0].decodedArgs).new_string, text);
  }
});

test('native binary Write rejects undecodable bytes without executing an edit', () => {
  const exec = write('');
  exec.writeArgs.fileBytes = Uint8Array.of(0xff, 0xfe, 0x80);
  const { calls, frames } = dispatch(exec, [editTool]);
  assert.equal(calls.length, 0);
  const result = decode(frames[0]).writeResult;
  assert.match(result.error.error, /valid UTF-8/);
  assert.equal(result.success, undefined);
});

test('native Write execution errors use the protocol error variant, field five', () => {
  const bytes = wire.encodeMessage('WriteResult', { error: { path: 'a.txt', error: 'Write failed' } });
  assert.equal(bytes[0], (5 << 3) | 2);
});

test('unsupported native background shell returns the real shell/task recovery contract', () => {
  const { calls, frames } = dispatch(
    {
      id: 9,
      backgroundShellSpawnArgs: { command: 'node worker.mjs', workingDirectory: '/workspace' },
    },
    [{ name: 'shell' }]
  );
  assert.equal(calls.length, 0);
  const rejection = decode(frames[0]).backgroundShellSpawnResult.rejected;
  assert.equal(rejection.command, 'node worker.mjs');
  assert.equal(rejection.workingDirectory, '/workspace');
  assert.match(rejection.reason, /mixdog MCP shell/);
  assert.match(rejection.reason, /"action":"wait"/);
  assert.match(rejection.reason, /"names":"task"/);
});

test('native Write hands off a complete exec frame without waiting for stepCompleted', async (t) => {
  let onData;
  const onClose = [];
  const bridge = {
    alive: true,
    onData(listener) {
      onData = listener;
    },
    onClose(listener) {
      onClose.push(listener);
    },
    write() {},
    close(error) {
      if (!this.alive) return;
      this.alive = false;
      for (const listener of onClose) listener(error);
    },
  };
  const heartbeat = setInterval(() => {}, 10000);
  const key = 'native-write-handoff';
  t.after(() => {
    clearInterval(heartbeat);
    bridge.close();
  });
  const response = wire.createStreamResponse({
    bridge,
    heartbeat,
    conversation: { blobs: new Map(), checkpoint: null },
    tools: [editTool],
    model: 'composer-2.5',
    key,
  });
  const frame = wire.connectFrame(wire.encodeMessage('AgentServerMessage', { execServerMessage: write() }));
  onData(frame.subarray(0, frame.length - 1));
  assert.equal(wire.activeRunPendingCount(key), 0, 'partial frames must not be dispatched');
  onData(frame.subarray(frame.length - 1));
  assert.equal(wire.activeRunPendingCount(key), 1, 'server awaits writeResult before the step can end');
  const text = await response.text();
  assert.match(text, /"name":"edit"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
});

test('parallel native Write frames arriving while parked survive split chunks and resume exactly once', async (t) => {
  let dataHandler, closeHandler;
  const bridge = {
    alive: true,
    writes: [],
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    write(bytes) {
      this.writes.push(bytes);
    },
    emit(bytes) {
      dataHandler(bytes);
    },
    close(error) {
      if (this.alive) {
        this.alive = false;
        closeHandler?.(error);
      }
    },
  };
  const heartbeat = setInterval(() => {}, 10000);
  t.after(() => {
    clearInterval(heartbeat);
    bridge.close();
  });
  const key = 'native-write-queued-parallel';
  const base = {
    bridge,
    heartbeat,
    conversation: { blobs: new Map(), checkpoint: null },
    tools: [editTool],
    model: 'composer-2.5',
    key,
  };
  const first = write('first');
  const second = {
    id: 8,
    execId: 'write-second',
    writeArgs: {
      path: 'out/second.txt',
      fileText: 'second',
      toolCallId: 'native-second',
    },
  };
  const frame = (exec) => wire.connectFrame(wire.encodeMessage('AgentServerMessage', { execServerMessage: exec }));
  const response = wire.createStreamResponse(base);
  bridge.emit(frame(first));
  assert.match(await response.text(), /native-write/);
  const secondFrame = frame(second);
  bridge.emit(secondFrame.subarray(0, 9));
  bridge.emit(secondFrame.subarray(9));
  const active = { ...base, pending: dispatch(first, [editTool]).calls };
  const resumed = wire.resumeRun(active, [{ toolCallId: 'native-write', content: 'created' }], '', base.model, key);
  const resumedText = await resumed.text();
  assert.equal((resumedText.match(/native-second/g) || []).length, 1);
  assert.doesNotMatch(resumedText, /native-write/);
  assert.equal(bridge.writes.length, 1);
  assert.equal(decode(bridge.writes[0]).id, 7);
  assert.equal(wire.activeRunPendingCount(key), 1);
});
