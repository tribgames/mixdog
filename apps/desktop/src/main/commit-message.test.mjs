import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommitMessageGenerator } from './commit-message.ts';

const conventional = {
  commitPreset: 'conventional',
  commitExample: '',
  commitInstructions: '',
  autoCommitMessage: true,
};

test('conventional AI output is validated and corrected once', async () => {
  const calls = [];
  const messages = ['Update settings', 'fix(settings)!: recover interrupted saves'];
  const generate = createCommitMessageGenerator({
    diffFor: async () => 'diff --git a/a b/a',
    loadModule: async () => ({
      async generateCommitMessage(source, options) {
        calls.push({ source, options });
        return messages.shift();
      },
    }),
  });
  const message = await generate('C:/repo', [{ path: 'a' }], conventional);
  assert.equal(message, 'fix(settings)!: recover interrupted saves');
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.style, /previous message did not match/i);
});

test('conventional AI output fails after one unsuccessful correction', async () => {
  const generate = createCommitMessageGenerator({
    diffFor: async () => 'diff --git a/a b/a',
    loadModule: async () => ({
      async generateCommitMessage() { return 'Still not conventional'; },
    }),
  });
  await assert.rejects(
    () => generate('C:/repo', [{ path: 'a' }], conventional),
    /did not match Conventional Commits/,
  );
});
