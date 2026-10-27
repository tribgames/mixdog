import '../../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, stat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeBuiltinTool } from '../tools/builtin.mjs';
import { executeCursorNativeBuiltin, tryExecuteExternalToolAdapter } from '../tools/builtin/external-tool-adapters.mjs';
import { handleExecMessage, sendToolResult } from './cursor-wire-exec.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { registerCursorNativeCall, cursorNativeCall, releaseCursorNativeCall } from './cursor-native-context.mjs';
import { CursorOAuthProvider } from './cursor.mjs';
import { processServerMessage } from './cursor-wire-stream-messages.mjs';
import { encodeMessage } from './cursor-wire-protobuf.mjs';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
const tools = [{ name: 'read' }, { name: 'edit' }];

async function fixture(t, grants = tools) {
  const root = makeTempDirSync('cursor-conditional');
  const sessionId = randomUUID();
  const executions = new Map();
  const frames = [];
  const bridge = { write: (frame) => frames.push(frame) };
  let id = 0;
  t.after(() => rm(root, { recursive: true, force: true }));
  function request(kind, args) {
    const exec = { id: ++id, execId: `exec-${id}`, [kind]: args };
    let pending;
    handleExecMessage(bridge, exec, grants, '', (value) => {
      pending = value;
    });
    assert.ok(pending);
    executions.set(exec.execId, pending);
    registerCursorNativeCall(sessionId, pending, executions);
    return pending;
  }
  async function execute(pending) {
    const result = await executeCursorNativeBuiltin(
      pending.toolName,
      JSON.parse(pending.decodedArgs),
      root,
      { sessionId, toolCallId: pending.toolCallId },
      executeBuiltinTool
    );
    sendToolResult(bridge, pending, { content: result }, !String(result).startsWith('Error:'));
    return { result, reply: decodeMessage('AgentClientMessage', frames.at(-1).subarray(5)).execClientMessage };
  }
  const read = (path, parent = path, extra = {}) =>
    execute(request('readArgs', { path, toolCallId: parent, ...extra }));
  const write = (path, text, parent = path) =>
    execute(request('writeArgs', { path, fileText: text, toolCallId: parent }));
  return { root, sessionId, executions, frames, bridge, request, execute, read, write };
}

test('native full reads preserve exact UTF-8 bytes and authorize first-attempt conditional replacements', async (t) => {
  const f = await fixture(t);
  for (const [path, content] of [
    ['lf.txt', 'value=73\n'],
    ['crlf.txt', 'value=73\r\n한글\r\n'],
    ['bom.txt', '\uFEFFvalue=73\r\n'],
    ['no-newline.txt', 'value=73'],
  ]) {
    await writeFile(join(f.root, path), content);
    const read = await f.read(path);
    assert.equal(read.reply.readResult.success.content, content);
    const after = content.replace('73', '79');
    const write = await f.write(path, after);
    assert.ok(write.reply.writeResult.success, write.result);
    assert.equal(await readFile(join(f.root, path), 'utf8'), after);
  }
});

test('local native Write over a non-empty file succeeds through its read capability, even with write granted', async (t) => {
  const f = await fixture(t, [{ name: 'read' }, { name: 'edit' }, { name: 'write' }]);
  await writeFile(join(f.root, 'local.txt'), 'KEEP\n');
  const unread = await f.write('local.txt', 'NOPE\n', 'never-read');
  assert.ok(unread.reply.writeResult.error, 'no read capability: the overwrite is refused');
  assert.equal(await readFile(join(f.root, 'local.txt'), 'utf8'), 'KEEP\n');
  await f.read('local.txt');
  const replaced = await f.write('local.txt', 'REPLACED\n');
  assert.ok(replaced.reply.writeResult.success, replaced.result);
  assert.equal(await readFile(join(f.root, 'local.txt'), 'utf8'), 'REPLACED\n');
});

test('native creation gets fileNotFound and cannot overwrite concurrent creation', async (t) => {
  const f = await fixture(t);
  assert.ok((await f.read('new.txt')).reply.readResult.fileNotFound);
  assert.ok((await f.write('new.txt', 'created\n')).reply.writeResult.success);
  await f.read('race.txt');
  await writeFile(join(f.root, 'race.txt'), 'KEEP');
  assert.ok((await f.write('race.txt', 'unsafe')).reply.writeResult.error);
  assert.equal(await readFile(join(f.root, 'race.txt'), 'utf8'), 'KEEP');
});

test('server-normalized materialization preserves original uniform line endings and reports actual size', async (t) => {
  const f = await fixture(t);
  for (const [path, before, materialized, expected] of [
    ['crlf', '\uFEFFvalue=73\r\n한글\r\n', 'value=79\n한글\n', '\uFEFFvalue=79\r\n한글\r\n'],
    ['lf', 'value=73\nkeep\n', 'value=79\r\nkeep\r\n', 'value=79\nkeep\n'],
  ]) {
    await writeFile(join(f.root, path), before);
    await f.read(path);
    const result = await f.write(path, materialized);
    assert.ok(result.reply.writeResult.success, result.result);
    assert.equal(await readFile(join(f.root, path), 'utf8'), expected);
    assert.equal(result.reply.writeResult.success.fileSize, Buffer.byteLength(expected));
  }
  await writeFile(join(f.root, 'mixed'), 'a\r\nb\n');
  await f.read('mixed');
  assert.match((await f.write('mixed', 'changed\nb\n')).result, /mixed line endings/);
  assert.equal(await readFile(join(f.root, 'mixed'), 'utf8'), 'a\r\nb\n');
});

test('stale snapshots and partial reads cannot authorize full replacement', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'stale.txt'), 'before\n');
  await f.read('stale.txt');
  await executeBuiltinTool('edit', { file_path: 'stale.txt', old_string: 'before', new_string: 'concurrent' }, f.root);
  assert.match((await f.write('stale.txt', 'overwrite\n')).result, /changed since its read/);
  assert.equal(await readFile(join(f.root, 'stale.txt'), 'utf8'), 'concurrent\n');
  await writeFile(join(f.root, 'range.txt'), 'one\ntwo\n');
  await f.read('range.txt', 'range', { offset: 1, limit: 1 });
  assert.ok((await f.write('range.txt', 'overwrite', 'range')).reply.writeResult.error);
  assert.equal(await readFile(join(f.root, 'range.txt'), 'utf8'), 'one\ntwo\n');
});

test('independent native edits stay parallel; ambiguous read generations fail closed', async (t) => {
  const f = await fixture(t);
  await Promise.all(['a', 'b'].map((path) => writeFile(join(f.root, path), 'old\n')));
  await Promise.all(['a', 'b'].map((path) => f.read(path)));
  const replies = await Promise.all(['a', 'b'].map((path) => f.write(path, `new-${path}\n`)));
  assert.ok(replies.every((result) => !String(result.result).startsWith('Error:')));
  for (const path of ['a', 'b']) assert.equal(await readFile(join(f.root, path), 'utf8'), `new-${path}\n`);
  await f.read('a', 'ambiguous');
  await f.read('a', 'ambiguous');
  assert.match((await f.write('a', 'unsafe', 'ambiguous')).result, /unambiguous/);
});

test('concurrent native writes based on the same version commit at most once', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'shared'), 'original\n');
  await Promise.all([f.read('shared', 'parent-a'), f.read('shared', 'parent-b')]);
  const results = await Promise.all([
    f.write('shared', 'winner-a\n', 'parent-a'),
    f.write('shared', 'winner-b\n', 'parent-b'),
  ]);
  assert.equal(results.filter((result) => !String(result.result).startsWith('Error:')).length, 1);
  assert.equal(results.filter((result) => /changed since its read/.test(result.result)).length, 1);
  assert.ok(['winner-a\n', 'winner-b\n'].includes(await readFile(join(f.root, 'shared'), 'utf8')));
});

test('directory aliases share the target lock and a retargeted alias cannot reuse an old snapshot', async (t) => {
  const f = await fixture(t);
  const real = join(f.root, 'real');
  const other = join(f.root, 'other');
  await mkdir(real);
  await mkdir(other);
  await writeFile(join(real, 'target.txt'), 'original\n');
  await writeFile(join(other, 'target.txt'), 'OTHER\n');
  try {
    await symlink(real, join(f.root, 'alias-a'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(real, join(f.root, 'alias-b'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`directory alias creation unavailable: ${error.code}`);
    return;
  }
  await Promise.all([f.read('alias-a/target.txt', 'a'), f.read('alias-b/target.txt', 'b')]);
  const results = await Promise.all([
    f.write('alias-a/target.txt', 'winner-a\n', 'a'),
    f.write('alias-b/target.txt', 'winner-b\n', 'b'),
  ]);
  assert.equal(results.filter((result) => !!result.reply.writeResult.success).length, 1);
  assert.equal(results.filter((result) => /changed since its read/.test(result.result)).length, 1);
  await f.read('alias-a/target.txt', 'retarget');
  await rm(join(f.root, 'alias-a'), { recursive: true });
  await symlink(other, join(f.root, 'alias-a'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.write('alias-a/target.txt', 'unsafe', 'retarget')).result, /changed since its read/);
  assert.equal(await readFile(join(other, 'target.txt'), 'utf8'), 'OTHER\n');
});

test('runtime authorization cannot be supplied by model arguments or another session', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'keep'), 'KEEP');
  const pending = f.request('writeArgs', { path: 'keep', fileText: 'unsafe', toolCallId: 'parent' });
  await assert.rejects(
    executeCursorNativeBuiltin(
      'edit',
      JSON.parse(pending.decodedArgs),
      f.root,
      { sessionId: 'other-session', toolCallId: pending.toolCallId },
      executeBuiltinTool
    ),
    /authorization/
  );
  const ordinary = await executeBuiltinTool(
    'edit',
    { file_path: 'keep', old_string: '', new_string: 'unsafe', nativeSnapshot: { content: 'KEEP' } },
    f.root
  );
  assert.match(String(ordinary), /Error:/);
  assert.equal(await readFile(join(f.root, 'keep'), 'utf8'), 'KEEP');
});

test('missing or empty parent IDs never authorize replacement from an unrelated read', async (t) => {
  const f = await fixture(t);
  for (const parent of [undefined, '']) {
    const path = parent === undefined ? 'missing-parent' : 'empty-parent';
    await writeFile(join(f.root, path), 'KEEP');
    await f.execute(f.request('readArgs', { path, toolCallId: parent }));
    const result = await f.execute(f.request('writeArgs', { path, fileText: 'REPLACED', toolCallId: parent }));
    assert.ok(result.reply.writeResult.error);
    assert.match(result.result, /file exists/);
    assert.equal(await readFile(join(f.root, path), 'utf8'), 'KEEP');
  }
});

test('interrupted native reads do not deliver or authorize their snapshot', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'keep'), 'KEEP');
  const pending = f.request('readArgs', { path: 'keep', toolCallId: 'interrupted' });
  pending.nativeUserMessage = 'Do not edit';
  assert.ok((await f.execute(pending)).reply.readResult.rejected);
  assert.match((await f.write('keep', 'unsafe', 'interrupted')).result, /delivered/);
  assert.equal(await readFile(join(f.root, 'keep'), 'utf8'), 'KEEP');
});

test('account-scoped transports retain the actual tool executor identity', async () => {
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
        sendOpts: { sessionId: 'account-scoped-wire-id', toolExecutionSessionId: 'actual-session' },
        openAiTools: [],
      }
    ),
    (error) => error === stopped
  );
  assert.equal(observed.ownerSessionId, 'actual-session');
});

test('invalid, missing-source and already-cancelled edits do not create parent directories for locks', async (t) => {
  const f = await fixture(t);
  for (const [directory, old_string, new_string, options] of [
    ['invalid', 42, 'new', {}],
    ['unchanged', 'same', 'same', {}],
    ['missing', 'old', 'new', {}],
    ['cancelled', '', 'new', { signal: AbortSignal.abort(new Error('test cancellation')) }],
  ]) {
    const result = await tryExecuteExternalToolAdapter(
      'edit',
      { file_path: `${directory}/target.txt`, old_string, new_string },
      f.root,
      options
    );
    assert.match(String(result), /^Error:/);
    await assert.rejects(stat(join(f.root, directory)), { code: 'ENOENT' });
  }
});

test('native authorization exists before eager announcement and uses owner rather than transport scope', () => {
  const state = { pending: [], outputTokens: 0 };
  let emitted = 0;
  processServerMessage(
    encodeMessage('AgentServerMessage', {
      execServerMessage: { id: 1, execId: 'eager', readArgs: { path: 'a.txt', toolCallId: 'parent' } },
    }),
    {
      state,
      tools,
      sessionId: 'forked-transport',
      ownerSessionId: 'actual-session',
      bridge: { write: () => assert.fail('no result yet') },
      trace: () => {},
      emit: (delta) => {
        const call = delta.tool_calls[0];
        const context = cursorNativeCall(
          'actual-session',
          call.id,
          call.function.name,
          JSON.parse(call.function.arguments)
        );
        assert.equal(context.pending.exec.execId, 'eager');
        assert.throws(
          () => cursorNativeCall('forked-transport', call.id, call.function.name, JSON.parse(call.function.arguments)),
          /owner mismatch/
        );
        releaseCursorNativeCall(context.pending);
        emitted++;
      },
    }
  );
  assert.equal(emitted, 1);
});
