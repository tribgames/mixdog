// Behind the model proxy the Cursor provider runs on the client PC while the
// server daemon executes the tools: no process-local native authorization may
// be issued, and every call must run as an ordinary Mixdog tool call.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeBuiltinTool } from '../tools/builtin.mjs';
import { executeCursorNativeBuiltin } from '../tools/builtin/external-tool-adapters.mjs';
import { sendToolResult } from './cursor-wire-exec.mjs';
import { decodeMessage, encodeMessage } from './cursor-wire-protobuf.mjs';
import { isCursorNativeCallId } from './cursor-native-context.mjs';
import { CursorOAuthProvider } from './cursor.mjs';
import { processServerMessage } from './cursor-wire-stream-messages.mjs';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
test('a proxied send (empty tool executor) names no native owner, even through an account-scoped session', async () => {
  const provider = new CursorOAuthProvider();
  const stopped = new Error('stopped before network');
  let observed;
  await assert.rejects(
    provider._dispatchChat(
      {},
      {
        runtime: {
          handleChatCompletion: async (_body, _token, options) => {
            observed = options;
            throw stopped;
          },
        },
        sendOpts: { sessionId: 'account-scoped-wire-id', toolExecutionSessionId: '' },
        openAiTools: [],
      }
    ),
    (error) => error === stopped
  );
  assert.equal(observed.ownerSessionId, '');
});

test('proxied native read/write execs fall back to ordinary tool calls the daemon can execute', async (t) => {
  const root = makeTempDirSync('cursor-proxied');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'existing.txt'), 'value=73\n');
  const state = { pending: [], outputTokens: 0 };
  const frames = [];
  const bridge = { write: (frame) => frames.push(frame) };
  const calls = [];
  const ctx = {
    state,
    tools: [{ name: 'read' }, { name: 'edit' }],
    sessionId: 'pc-transport',
    ownerSessionId: '',
    bridge,
    trace: () => {},
    emit: (delta) => calls.push(delta.tool_calls[0]),
  };
  processServerMessage(
    encodeMessage('AgentServerMessage', {
      execServerMessage: { id: 1, execId: 'read-1', readArgs: { path: 'existing.txt', toolCallId: 'parent-read' } },
    }),
    ctx
  );
  processServerMessage(
    encodeMessage('AgentServerMessage', {
      execServerMessage: {
        id: 2,
        execId: 'write-1',
        writeArgs: { path: 'created.txt', fileText: 'new\n', toolCallId: 'parent-write' },
      },
    }),
    ctx
  );
  assert.equal(calls.length, 2);
  const replies = [];
  for (const [index, call] of calls.entries()) {
    assert.equal(isCursorNativeCallId(call.id), false, `${call.function.name} must not carry a native capability`);
    // The server daemon: another process, another session id, no shared map.
    const result = await executeCursorNativeBuiltin(
      call.function.name,
      JSON.parse(call.function.arguments),
      root,
      { sessionId: 'daemon-session', toolCallId: call.id },
      executeBuiltinTool
    );
    assert.doesNotMatch(String(result), /authorization|^Error:/);
    sendToolResult(bridge, state.pending[index], { content: result }, true);
    replies.push(decodeMessage('AgentClientMessage', frames.at(-1).subarray(5)).execClientMessage);
  }
  assert.match(replies[0].readResult.success.content, /^value=73/);
  assert.ok(replies[1].writeResult.success);
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'new\n');
});
