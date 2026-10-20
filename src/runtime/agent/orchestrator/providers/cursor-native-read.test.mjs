import '../../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceWindow } from '../../../shared/read-row-numbers.mjs';
import { executeBuiltinTool } from '../tools/builtin.mjs';
import { randomUUID } from 'node:crypto';
import { executeCursorNativeBuiltin } from '../tools/builtin/external-tool-adapters.mjs';
import { handleExecMessage, sendToolResult } from './cursor-wire-exec.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { registerCursorNativeCall } from './cursor-native-context.mjs';
import { __cursorModelInternals, CursorOAuthProvider } from './cursor.mjs';
import { _withRegisteredProviderForTestAsync } from './registry.mjs';
import { ModelProxyProvider } from './model-proxy-provider.mjs';
import { parseMessages } from './cursor-wire-request.mjs';
import { finalizeBatchResults } from '../session/tool-batch/finalize.mjs';

function reply(text, args = { path: 'source.txt' }) {
  const frames = [];
  sendToolResult(
    { write: (bytes) => frames.push(bytes) },
    { exec: { id: 1 }, native: { resultType: 'readResult', args } },
    { content: text },
    true
  );
  return decodeMessage('AgentClientMessage', frames[0].subarray(5)).execClientMessage.readResult;
}

test('native read decodes display envelopes without swallowing marker-looking source', () => {
  const text = '[lines 1-3]\n  code\n[lines 9-9]\n[lines 1-3 of 3]\n[lines 1-3 of 3]';
  const out = reply(text).success;
  assert.equal(out.content, '  code\n[lines 9-9]\n[lines 1-3 of 3]');
  assert.equal(out.totalLines, 3);
  assert.equal(out.fileSize, undefined, 'display text cannot establish original byte size');
  assert.equal(out.truncated ?? false, false);
});

test('native read keeps range metadata separate from source and rejects ambiguous views', () => {
  const out = reply('[lines 2-3]\nsecond\nthird\n[lines 2-3 of 5; offset:4 for more]', {
    path: 'source.txt',
    offset: 2,
    limit: 2,
  }).success;
  assert.equal(out.content, 'second\nthird');
  assert.equal(out.totalLines, 5);
  assert.equal(out.rangeApplied, true);
  assert.equal(out.truncated, true);
  for (const text of [
    '[path absent] ENOENT',
    '[file unchanged: source.txt]',
    '[lines 1-3]\nfirst',
    '[lines 1-1]\nfirst\n... omitted ...\n[lines 9-9]\nlast',
    '[lines 1-1]\nfirst\n[lines 1-2 of 2]',
  ]) {
    assert.equal(readSourceWindow(text), null, text);
    assert.ok(reply(text).rejected, text);
  }
  assert.equal(
    reply('<system-reminder>File exists but has empty contents: source.txt</system-reminder>').success.content ?? '',
    ''
  );
  assert.equal(readSourceWindow('(no lines in range; file has 5 lines)').totalLines, 5);
});

test('native read judges line clipping from executor metadata, not from file content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-read-clip-'));
  try {
    const literal = 'head ... [line truncated: 9999 chars total] ... tail';
    await writeFile(join(root, 'literal.txt'), `${literal}\nnext\n`);
    await writeFile(join(root, 'long.txt'), `${'x'.repeat(5000)}\nnext\n`);
    const sessionId = randomUUID();
    const executions = new Map();
    const read = async (path, range = {}) => {
      const frames = [];
      const bridge = { write: (bytes) => frames.push(bytes) };
      let pending;
      const exec = { id: 1, execId: `exec-${path}`, readArgs: { path, toolCallId: path, ...range } };
      handleExecMessage(bridge, exec, [{ name: 'read' }], '', (call) => {
        pending = call;
      });
      executions.set(pending.exec.execId, pending);
      registerCursorNativeCall(sessionId, pending, executions);
      const text = await executeCursorNativeBuiltin(
        pending.toolName,
        JSON.parse(pending.decodedArgs),
        root,
        { sessionId, toolCallId: pending.toolCallId },
        executeBuiltinTool
      );
      sendToolResult(bridge, pending, { content: text }, true);
      return decodeMessage('AgentClientMessage', frames[0].subarray(5)).execClientMessage.readResult;
    };
    const literalReply = await read('literal.txt');
    assert.equal(literalReply.success.content, `${literal}\nnext\n`);
    assert.equal(literalReply.rejected, undefined);
    const ranged = await read('literal.txt', { offset: 1, limit: 2 });
    assert.equal(ranged.success.content, `${literal}\nnext`);
    assert.equal(ranged.rejected, undefined);
    assert.ok((await read('long.txt')).rejected, 'a genuinely clipped line is still not file text');
    assert.ok((await read('long.txt', { offset: 1, limit: 2 })).rejected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote/proxied native read carries the executor clip report to the provider, never sniffed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-remote-read-clip-'));
  try {
    const literal = 'head ... [line truncated: 9999 chars total] ... tail';
    await writeFile(join(root, 'literal.txt'), `${literal}\nnext\n`);
    await writeFile(join(root, 'long.txt'), `${'x'.repeat(5000)}\nnext\n`);
    const remoteReply = async (path, provider = 'cursor-oauth') => {
      // The server daemon: an ordinary read, then the batch finalizer.
      const args = { file_path: path, offset: 1, limit: 2 };
      const result = await executeBuiltinTool('read', { ...args }, root);
      const batch = {
        completed: [
          {
            call: { id: 'call-1', name: 'read', arguments: args },
            result,
            executeOk: true,
            resultKind: 'normal',
            toolKind: 'normal',
            executionIntervals: [],
            toolStartedAt: 1,
            toolEndedAt: 2,
          },
        ],
        sessionRef: { provider },
        sessionId: null,
        cwd: root,
        iterations: 1,
        toolBatchId: 'batch',
        resultByCallId: new Map(),
        resultsWithoutId: [],
        crossTurnCalls: new Map(),
        crossTurnCap: 16,
        epoch: { mutation: 0 },
        tools: [],
        throwIfAborted() {},
      };
      await finalizeBatchResults(batch);
      const message = batch.resultByCallId.get('call-1');
      // The provider on the PC: session message → Cursor wire tool result.
      const [toolMessage] = __cursorModelInternals.toCursorMessages([message], provider);
      const [toolResult] = parseMessages([toolMessage]).toolResults;
      const frames = [];
      sendToolResult(
        { write: (bytes) => frames.push(bytes) },
        { exec: { id: 1 }, native: { resultType: 'readResult', args: { path, offset: 1, limit: 2 } } },
        { content: toolResult.content, readWindow: toolResult.readWindow },
        true
      );
      return decodeMessage('AgentClientMessage', frames[0].subarray(5)).execClientMessage.readResult;
    };
    // The registry holds either the real adapter or, on a server, its proxy
    // stand-in; both declare the trait the finalizer selects on.
    const standIn = new ModelProxyProvider('cursor-oauth', { modelProxy: { consumesReadWindows: true } }, {});
    for (const instance of [new CursorOAuthProvider(), standIn]) {
      await _withRegisteredProviderForTestAsync('cursor-oauth', instance, async () => {
        const literalReply = await remoteReply('literal.txt');
        assert.equal(literalReply.success.content, `${literal}\nnext`);
        assert.ok((await remoteReply('long.txt')).rejected, 'a clipped line must not pass as file text');
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real native read returns source text and correct line totals, not display rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-read-'));
  try {
    await writeFile(join(root, 'source.txt'), 'first\r\n  second\r\nthird\r\n');
    const text = await executeBuiltinTool('read', { file_path: 'source.txt', offset: 2, limit: 2 }, root);
    const out = reply(text, { path: 'source.txt', offset: 2, limit: 2 }).success;
    assert.equal(out.content, '  second\nthird');
    assert.equal(out.totalLines, 3);
    assert.equal(out.rangeApplied, true);
    assert.equal(out.fileSize, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
