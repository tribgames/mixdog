import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'mixdog-cursor-read-body-'));
process.env.MIXDOG_DATA_DIR = join(root, 'state');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');
const { processToolBatch } = await import('../tool-batch.mjs');
const { dispatchToolCall } = await import('../loop/tool-exec/dispatch.mjs');
const { BUILTIN_TOOLS } = await import('../../tools/builtin/builtin-tools.mjs');
const { setReadCached, captureReadCacheState } = await import('./read-cache.mjs');
const { closeNativePatchServerForTests } = await import('../../tools/patch/native-server.mjs');
after(async () => {
  await closeNativePatchServerForTests();
  await rm(root, { recursive: true, force: true });
});
const tools = BUILTIN_TOOLS.filter((tool) => ['read', 'edit'].includes(tool.name));

async function harness(provider, eager) {
  const cwd = await mkdtemp(join(root, 'case-'));
  await writeFile(join(cwd, 'a.txt'), 'ONE\n');
  const sessionId = `sess_cursor_read_${randomUUID().replaceAll('-', '')}`;
  const sessionRef = { provider };
  const crossTurnCalls = new Map();
  let iteration = 0,
    executions = 0;
  const executeToolFn = async (name, args, cwd, sid, ref, executeOpts = {}) => {
    executions++;
    return dispatchToolCall(
      { name, args },
      {
        cwd,
        callerSessionId: sid,
        sessionRef: ref,
        executeOpts,
        toolOpts: {},
        completionToolOpts: { sessionId: sid, readOffsetBase: 1 },
      }
    );
  };
  const run = async (calls) => {
    iteration++;
    const dispatcher = createEagerDispatcher({
      tools,
      cwd,
      sessionId,
      sessionRef,
      signal: null,
      opts: {},
      crossTurnCalls,
      getIterations: () => iteration,
      getNextIteration: () => iteration,
      repeatFailLimit: 3,
      executeToolFn,
    });
    const results = [];
    await processToolBatch({
      calls,
      messages: [],
      tools,
      cwd,
      sessionId,
      sessionRef,
      signal: null,
      opts: {},
      iterations: iteration,
      assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
      pending: dispatcher.pending,
      epoch: dispatcher.epoch,
      startEagerRun: eager ? dispatcher.startEagerRun : () => {},
      crossTurnCalls,
      crossTurnCap: 100,
      sessionAgent: null,
      pushToolResultMessage: (message) => results.push(message),
      throwIfAborted: () => {},
      repeatFailLimit: 3,
      dedupStubTotal: 0,
      editCount: 0,
      executeToolFn,
    });
    return results;
  };
  return { cwd, sessionId, sessionRef, run, executeToolFn, executions: () => executions };
}
const read = (id) => ({ id, name: 'read', arguments: { file_path: 'a.txt' } });
const assertBody = (result, expected) => {
  assert.match(result.content, new RegExp(expected));
  assert.doesNotMatch(result.content, /file unchanged|cross-turn-dedup|intra-turn-dedup/);
};

for (const provider of ['cursor-oauth', 'cursor-api'])
  for (const eager of [false, true]) {
    test(`${provider}: cached, duplicate and post-edit reads keep bodies (eager=${eager})`, async () => {
      const h = await harness(provider, eager);
      const first = await h.run([read('first'), read('duplicate')]);
      first.forEach((result) => {
        assertBody(result, 'ONE');
      });
      const executions = h.executions();
      assertBody((await h.run([read('repeat')]))[0], 'ONE');
      assert.equal(h.executions(), executions, 'valid session cache still avoids execution');
      const changed = await h.run([
        { id: 'edit', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'ONE', new_string: 'TWO' } },
        read('after-edit'),
      ]);
      assertBody(changed[1], 'TWO');
      await writeFile(join(h.cwd, 'a.txt'), 'EXTERNAL\n');
      assertBody((await h.run([read('after-external')]))[0], 'EXTERNAL');
      h.sessionRef.schemaAllowedTools = ['edit'];
      const beforeDenied = h.executions();
      const denied = (await h.run([read('denied')]))[0];
      assert.equal(denied.toolKind, 'error');
      assert.equal(h.executions(), beforeDenied);
    });
  }

test('Cursor does not reuse fresh cached receipts as source content', async () => {
  const h = await harness('cursor-oauth', true);
  await h.run([read('first')]);
  const args = { file_path: 'a.txt' };
  for (const content of [
    '[file unchanged: a.txt]',
    '[cross-turn-dedup] read already ran',
    '[intra-turn-dedup] duplicate',
  ]) {
    setReadCached({
      sessionId: h.sessionId,
      args,
      cwd: h.cwd,
      content,
      toolUseId: 'receipt',
      readState: captureReadCacheState({ args, cwd: h.cwd }),
    });
    assertBody((await h.run([read(`retry-${content}`)]))[0], 'ONE');
  }
});

test('non-Cursor reads retain their normal cross-turn receipt behavior', async () => {
  const h = await harness('gemini', true);
  await h.run([read('first')]);
  const repeat = (await h.run([read('repeat')]))[0];
  assert.match(repeat.content, /cross-turn-dedup/);
});
