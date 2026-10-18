import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { differentFieldValue } from './file-version-test-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-io-integrity-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { executeBuiltinTool } = await import('../builtin.mjs');
const { closeNativePatchServerForTests } = await import('../patch/native-server.mjs');
const { AntigravityOAuthProvider } = await import('../../providers/antigravity-oauth.mjs');
const { parseToolCalls } = await import('../../providers/gemini-schema.mjs');
const { sliceReadBodyByLines } = await import('./read-batch.mjs');
const { BUILTIN_TOOLS } = await import('./builtin-tools.mjs');
const { getReadSnapshot } = await import('./read-snapshot-runtime.mjs');
const { tryExecuteExternalToolAdapter } = await import('./external-tool-adapters.mjs');
const { readRowsForDisplay } = await import('../../../../shared/read-row-numbers.mjs');
after(async () => {
  await closeNativePatchServerForTests();
});

function fixture(text = `${Array.from({ length: 20 }, (_, i) => `LINE_${i + 1}`).join('\n')}\n`) {
  const dir = mkdtempSync(join(root, 'case-'));
  const file = join(dir, 'working.txt');
  writeFileSync(join(dir, 'original.txt'), text);
  writeFileSync(file, text);
  return { dir, file, sessionId: dir };
}

function nextOffset(output) {
  const match = /offset:(\d+) for more/.exec(output);
  assert.ok(match, `Missing continuation:\n${output}`);
  return Number(match[1]);
}

// Model-facing rows carry no numbers; rebuild them first.
function rows(output) {
  return [...readRowsForDisplay(String(output)).matchAll(/^(\d+)→(.*)$/gm)].map((match) => [
    Number(match[1]),
    match[2],
  ]);
}

function readArgs(file, base, offset, limit, batch = false) {
  const key = base === 1 ? 'file_path' : 'path';
  return batch ? { [key]: [{ [key]: file, offset, limit }] } : { [key]: file, offset, limit };
}

for (const shape of ['buffered', 'streamed', 'batch']) {
  test(`model-facing reads carry bare rows under a range marker (${shape})`, async () => {
    const fx = fixture(
      `${Array.from({ length: 30 }, (_, i) => `${i % 2 ? '\t\t' : '    '}LINE_${i + 1}`).join('\n')}\n`
    );
    const output = String(
      await executeBuiltinTool('read', readArgs(fx.file, 1, 3, 20, shape === 'batch'), fx.dir, {
        sessionId: fx.sessionId,
        forceReadRangeStream: shape === 'streamed',
      })
    );
    const lines = output.split('\n');
    const at = lines.indexOf('[lines 3-22]');
    assert.ok(at >= 0, output);
    assert.deepEqual(
      lines.slice(at + 1, at + 21),
      Array.from({ length: 20 }, (_, i) => `${(i + 2) % 2 ? '\t\t' : '    '}LINE_${i + 3}`)
    );
    assert.doesNotMatch(output, /^\d+[→\t]/m);
  });
}

for (const base of [0, 1]) {
  for (const shape of ['buffered', 'streamed', 'batch']) {
    test(`read pagination returns every row exactly once (base=${base}, ${shape})`, async () => {
      const fx = fixture();
      const found = [];
      let offset = base;
      for (let page = 0; page < 5; page++) {
        const output = String(
          await executeBuiltinTool('read', readArgs(fx.file, base, offset, 4, shape === 'batch'), fx.dir, {
            sessionId: fx.sessionId,
            forceReadRangeStream: shape === 'streamed',
          })
        );
        found.push(...rows(output));
        if (page < 4) {
          offset = nextOffset(output);
          assert.equal(offset, (page + 1) * 4 + base);
        }
      }
      assert.deepEqual(
        found,
        Array.from({ length: 20 }, (_, i) => [i + 1, `LINE_${i + 1}`])
      );
    });
  }

  test(`coalesced batch windows preserve both ranges and continuation coordinates (base=${base})`, async () => {
    const fx = fixture();
    const key = base === 1 ? 'file_path' : 'path';
    const output = String(
      await executeBuiltinTool(
        'read',
        {
          [key]: [
            { [key]: fx.file, offset: base, limit: 2 },
            { [key]: fx.file, offset: 4 + base, limit: 2 },
          ],
        },
        fx.dir,
        { sessionId: fx.sessionId }
      )
    );
    assert.deepEqual(rows(output), [
      [1, 'LINE_1'],
      [2, 'LINE_2'],
      [5, 'LINE_5'],
      [6, 'LINE_6'],
    ]);
    const hints = [...output.matchAll(/offset:(\d+) for more/g)].map((match) => Number(match[1]));
    assert.deepEqual(hints, [2 + base, 6 + base]);
    const withheld = sliceReadBodyByLines('1→LINE_1\n2→LINE_2\n[lines 1-2 of 20]', 4, 2, base);
    assert.match(withheld, /NOT returned/);
    assert.ok(withheld.includes(`offset:${4 + base} limit:2`));
    assert.doesNotMatch(withheld, /\[lines 5-6/);
  });

  for (const streamed of [false, true]) {
    test(`byte-cap continuation resumes at the first incomplete row (base=${base}, streamed=${streamed})`, async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `ROW_${i + 1}_${'x'.repeat(80)}`);
      const fx = fixture(`${lines.join('\n')}\n`);
      const output = String(
        await executeBuiltinTool('read', readArgs(fx.file, base, base, 30), fx.dir, {
          sessionId: fx.sessionId,
          readOutputBudgetBytes: 512,
          forceReadRangeStream: streamed,
        })
      );
      const complete = rows(output).filter(([line, text]) => text === lines[line - 1]);
      assert.ok(complete.length > 0 && complete.length < lines.length);
      const last = complete.at(-1)[0];
      assert.equal(nextOffset(output), last + base);
      const next = String(
        await executeBuiltinTool('read', readArgs(fx.file, base, nextOffset(output), 1), fx.dir, {
          sessionId: fx.sessionId,
        })
      );
      assert.deepEqual(rows(next), [[last + 1, lines[last]]]);
    });
  }
}

test('cached read footers do not cross public and legacy coordinate systems', async () => {
  const fx = fixture();
  for (const [i, base] of [0, 1, 0, 1].entries()) {
    const output = String(
      await executeBuiltinTool('read', readArgs(fx.file, base, base, 4), fx.dir, {
        sessionId: `${fx.sessionId}-${i}`,
      })
    );
    assert.equal(nextOffset(output), 4 + base);
    assert.deepEqual(rows(output), [
      [1, 'LINE_1'],
      [2, 'LINE_2'],
      [3, 'LINE_3'],
      [4, 'LINE_4'],
    ]);
  }
});

for (const budgets of [
  [512, 4096],
  [4096, 512],
]) {
  test(`cached reads respect a changed output budget (${budgets.join(' -> ')})`, async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `ROW_${i + 1}_${'x'.repeat(80)}`);
    const fx = fixture(`${lines.join('\n')}\n`);
    const outputs = [];
    for (const [i, budget] of budgets.entries()) {
      outputs.push(
        String(
          await executeBuiltinTool('read', { file_path: fx.file, offset: 1, limit: 20 }, fx.dir, {
            sessionId: `${fx.sessionId}-${i}`,
            readOutputBudgetBytes: budget,
          })
        )
      );
    }
    for (const [i, budget] of budgets.entries()) {
      if (budget === 4096) {
        assert.deepEqual(
          rows(outputs[i]),
          lines.map((line, j) => [j + 1, line])
        );
        assert.doesNotMatch(outputs[i], /output capped/);
      } else {
        assert.ok(rows(outputs[i]).length < lines.length, outputs[i]);
        assert.match(outputs[i], /output capped/);
      }
    }
  });
}

test('parsed Gemini arguments are a deep working copy, not signed native state', () => {
  const parts = [
    {
      functionCall: { name: 'read', args: { file_path: [{ file_path: 'a.txt', offset: 1, limit: 2 }] } },
      thoughtSignature: 'signed-native-state',
    },
  ];
  const original = structuredClone(parts);
  const first = parseToolCalls(parts)[0];
  first.arguments.file_path[0].offset = 99;
  first.arguments.file_path.push('b.txt');
  assert.deepEqual(parts, original);
  const again = parseToolCalls(parts)[0];
  assert.equal(again.id, first.id);
  assert.deepEqual(again.arguments, original[0].functionCall.args);
});

test('builtin execution preserves nested caller arguments and repeated execution semantics', async () => {
  const fx = fixture();
  const args = { path: [{ path: fx.file }], offset: 1, limit: 2 };
  const original = structuredClone(args);
  for (let i = 0; i < 2; i++) {
    const output = String(await executeBuiltinTool('read', args, fx.dir, { sessionId: fx.sessionId }));
    assert.deepEqual(args, original);
    assert.deepEqual(rows(output), [
      [2, 'LINE_2'],
      [3, 'LINE_3'],
    ]);
  }
});

for (const forceReadRangeStream of [false, true]) {
  test(`cached deep ranges invalidate on a controlled ctime change (streamed=${forceReadRangeStream})`, async (t) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `ROW_${i + 1}_${'x'.repeat(80)}`);
    const fx = fixture(`${lines.join('\n')}\n`);
    const time = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(fx.file, time, time);
    const args = { file_path: fx.file, offset: 1800, limit: 1 };
    const options = { sessionId: fx.sessionId, forceReadRangeStream };
    const first = String(await executeBuiltinTool('read', args, fx.dir, options));
    assert.deepEqual(rows(first), [[1800, lines[1799]]]);
    const before = statSync(fx.file);
    lines[1799] = lines[1799].replace(/x$/, 'y');
    writeFileSync(fx.file, `${lines.join('\n')}\n`);
    utimesSync(fx.file, time, time);
    const after = statSync(fx.file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    const ctimeMs = differentFieldValue(before.ctimeMs, 'ctimeMs');
    const originalStat = fsPromises.stat;
    const mock = t.mock.method(fsPromises, 'stat', async (path, ...options) => {
      const st = await originalStat(path, ...options);
      if (path === fx.file) st.ctimeMs = ctimeMs;
      return st;
    });
    syncBuiltinESMExports();
    try {
      assert.notEqual((await fsPromises.stat(fx.file)).ctimeMs, before.ctimeMs);
      const reread = String(await executeBuiltinTool('read', args, fx.dir, options));
      assert.deepEqual(rows(reread), [[1800, lines[1799]]]);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('a partial read of an external rewrite cannot inherit full-body delivery', async () => {
  const fx = fixture('alpha\nOLD_TAIL\n');
  await executeBuiltinTool('read', { file_path: fx.file }, fx.dir, { sessionId: fx.sessionId });
  assert.equal(getReadSnapshot(fx.file, fx.sessionId).bodyDelivered, true);
  writeFileSync(fx.file, 'alpha\nNEW_UNDELIVERED_TAIL\n');
  const firstLine = String(
    await executeBuiltinTool('read', { file_path: fx.file, offset: 1, limit: 1 }, fx.dir, { sessionId: fx.sessionId })
  );
  assert.deepEqual(rows(firstLine), [[1, 'alpha']]);
  assert.notEqual(getReadSnapshot(fx.file, fx.sessionId).bodyDelivered, true);
  const edit = String(
    await tryExecuteExternalToolAdapter(
      'edit',
      {
        file_path: fx.file,
        old_string: 'alpha',
        new_string: 'omega',
      },
      fx.dir,
      { sessionId: fx.sessionId }
    )
  );
  assert.match(edit, /^Updated /);
  const tail = String(
    await executeBuiltinTool('read', { file_path: fx.file, offset: 2, limit: 1 }, fx.dir, { sessionId: fx.sessionId })
  );
  assert.deepEqual(rows(tail), [[2, 'NEW_UNDELIVERED_TAIL']]);
});

test('array reads deliver the requested body after an edit instead of an unchanged stub', async () => {
  const fx = fixture('alpha\nTAIL\n');
  await executeBuiltinTool('read', { file_path: fx.file }, fx.dir, { sessionId: fx.sessionId });
  const edit = String(
    await tryExecuteExternalToolAdapter(
      'edit',
      {
        file_path: fx.file,
        old_string: 'alpha',
        new_string: 'omega',
      },
      fx.dir,
      { sessionId: fx.sessionId }
    )
  );
  assert.match(edit, /^Updated /);
  const output = String(
    await executeBuiltinTool('read', { file_path: [fx.file] }, fx.dir, { sessionId: fx.sessionId })
  );
  assert.deepEqual(rows(output), [
    [1, 'omega'],
    [2, 'TAIL'],
  ]);
  assert.doesNotMatch(output, /file unchanged/);
});

for (const explicitIds of [false, true]) {
  test(`deferred read execution preserves replay and dispatches each call once after a clean finish (server IDs=${explicitIds})`, async () => {
    const fx = fixture('FIRST_LINE\nSECOND_LINE\nTHIRD_LINE\n');
    const parts = [1, 2].map((offset, i) => ({
      functionCall: {
        ...(explicitIds ? { id: `server-${i}` } : {}),
        name: 'read',
        args: { file_path: fx.file, offset, limit: 1 },
      },
      ...(i === 0 ? { thoughtSignature: 'native-read-signature' } : {}),
    }));
    const encoder = new TextEncoder();
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
      },
    });
    const push = (chunkParts, finishReason) =>
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: { role: 'model', parts: chunkParts },
                  ...(finishReason ? { finishReason } : {}),
                },
              ],
            },
          })}\n\n`
        )
      );
    const provider = new AntigravityOAuthProvider({
      fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      preconnectFn: () => {},
      ensureVersionFn: async () => {},
      ensureAuthFn: async () => ({ accessToken: 'test-token', projectId: 'test-project', email: '' }),
    });
    const seen = [];
    const executions = [];
    const firstDone = Promise.withResolvers();
    const secondDone = Promise.withResolvers();
    const pending = provider.send(
      [{ role: 'user', content: 'Read two lines.' }],
      'gemini-3.8-flash-high',
      [BUILTIN_TOOLS.find((tool) => tool.name === 'read')],
      {
        onToolCall(call) {
          seen.push(structuredClone(call));
          const execution = executeBuiltinTool(call.name, call.arguments, fx.dir, { sessionId: fx.sessionId });
          executions.push(execution);
          if (seen.length === 1) execution.then(firstDone.resolve, firstDone.reject);
          if (seen.length === 2) execution.then(secondDone.resolve, secondDone.reject);
        },
      }
    );
    pending.catch((error) => {
      firstDone.reject(error);
      secondDone.reject(error);
    });
    push([parts[0]]);
    push([parts[1]]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, 0, 'No call may execute before the clean finish');
    push([], 'STOP');
    controller.close();
    const result = await pending;
    await firstDone.promise;
    await secondDone.promise;
    const outputs = await Promise.all(executions);
    assert.equal(seen.length, 2);
    assert.deepEqual(
      outputs.map((output) => rows(output)),
      [[[1, 'FIRST_LINE']], [[2, 'SECOND_LINE']]]
    );
    assert.deepEqual(
      result.toolCalls.map((call) => call.id),
      seen.map((call) => call.id)
    );
    assert.deepEqual(result.providerReplay.items, parts);
    assert.deepEqual(
      result.toolCalls.map((call) => call.arguments),
      parts.map((part) => part.functionCall.args)
    );
    writeFileSync(join(fx.dir, 'observed.json'), JSON.stringify({ parts, seen, result, outputs }, null, 2));
  });
}
