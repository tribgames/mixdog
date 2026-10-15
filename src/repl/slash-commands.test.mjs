import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSlash } from './slash-commands.mjs';

function compactContext(compactResult) {
  const written = [];
  return {
    written,
    ctx: {
      out: { write: (text) => written.push(text) },
      ensureRuntime: async () => ({ compact: async () => compactResult }),
    },
  };
}

test('/help lists exactly the commands the plain REPL implements, on ctx.out', async () => {
  const written = [];
  assert.equal(await handleSlash('/help', { out: { write: (text) => written.push(text) } }), undefined);
  const listed = new Set(written.join('').match(/\/[a-z][a-z-]*/gi));
  assert.deepEqual(
    [...listed].sort(),
    [
      '/clear',
      '/compact',
      '/exit',
      '/help',
      '/mode',
      '/model',
      '/output-style',
      '/outputstyle',
      '/quit',
      '/style',
    ].sort()
  );
});

function modelContext({ sessionModel = 'gemini-3.8-flash', onModelChange = true, compact } = {}) {
  const calls = [];
  const runtime = {
    provider: 'google',
    model: sessionModel,
    sessionProvider: sessionModel ? 'google' : null,
    sessionModel,
    listPresets: () => [{ id: 'flash', provider: 'google', model: 'gemini-3.8-flash' }],
    getCompactionSettings: () => ({ onModelChange }),
    compact: async () => {
      calls.push('compact');
      if (compact) return compact();
      return { changed: true };
    },
    setRoute: async (next, options) => {
      if (options.validateOnly) {
        if (next.model === 'bogus') throw new Error('Invalid model selector "bogus"');
        return;
      }
      calls.push(['setRoute', next, options]);
      runtime.model = next.model;
    },
  };
  return { calls, ctx: { out: { write() {} }, ensureRuntime: async () => runtime, getRuntime: () => runtime } };
}

test('/model switches the conversation in place, compacting first on the current model', async () => {
  const { calls, ctx } = modelContext();
  await handleSlash('/model gemini-3.5-flash', ctx);
  assert.deepEqual(calls, ['compact', ['setRoute', { model: 'gemini-3.5-flash' }, { switchEstablished: true }]]);
});

test('/model rejects an invalid selector before compacting the conversation', async () => {
  const { calls, ctx } = modelContext();
  await assert.rejects(handleSlash('/model bogus', ctx), /Invalid model selector/);
  assert.deepEqual(calls, []);
});

test('/model skips the pre-compaction when off, for the same model or preset, and for an empty chat', async () => {
  for (const [options, arg] of [
    [{ onModelChange: false }, 'gemini-3.5-flash'],
    [{}, 'gemini-3.8-flash'],
    [{}, 'flash'],
    [{ sessionModel: null }, 'gemini-3.5-flash'],
  ]) {
    const { calls, ctx } = modelContext(options);
    await handleSlash(`/model ${arg}`, ctx);
    assert.deepEqual(calls, [['setRoute', { model: arg }, { switchEstablished: true }]], `${arg}`);
  }
});

test('/model still switches when the pre-compaction fails', async () => {
  const { calls, ctx } = modelContext({
    compact: () => {
      throw new Error('boom');
    },
  });
  await handleSlash('/model gemini-3.5-flash', ctx);
  assert.deepEqual(calls, ['compact', ['setRoute', { model: 'gemini-3.5-flash' }, { switchEstablished: true }]]);
});

test('/compact reports the runtime reason, its default, both failures and a success', async () => {
  for (const [result, expected] of [
    [{ changed: false, reason: 'context is already small' }, /context is already small/],
    [{ changed: false }, /nothing to compact/],
    [{ error: 'boom' }, /compact failed/],
    [null, /compact failed/],
    [
      { changed: true, beforeMessages: 5, afterMessages: 2, beforeTokens: 100, afterTokens: 40 },
      /compacted context: 5→2 messages, context 100→40/,
    ],
  ]) {
    const { written, ctx } = compactContext(result);
    assert.equal(await handleSlash('/compact', ctx), undefined);
    assert.match(written.join(''), expected);
  }
});
