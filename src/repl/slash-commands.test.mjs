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
