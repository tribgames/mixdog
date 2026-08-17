import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePrompt } from './helpers.mjs';

test('parallel same-name agent prompts and files keep their own payloads', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-agent-prompts-'));
  try {
    await Promise.all([
      writeFile(join(cwd, 'first.md'), 'first file payload'),
      writeFile(join(cwd, 'second.md'), 'second file payload'),
    ]);
    const calls = [
      { agent: 'reviewer', tag: 'first', prompt: 'first string prompt' },
      { agent: 'reviewer', tag: 'second', file: 'second.md' },
      { agent: 'reviewer', tag: 'third', file: 'first.md' },
      { agent: 'reviewer', tag: 'fourth', message: 'fourth string prompt' },
    ];
    assert.deepEqual(await Promise.all(calls.map((args) => resolvePrompt(args, cwd))), [
      'first string prompt',
      'second file payload',
      'first file payload',
      'fourth string prompt',
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('same-tag reuse preserves string messages and rejects object coercion', async () => {
  const first = { type: 'spawn', tag: 'legacy-session', prompt: 'initial brief' };
  const reuse = { type: 'spawn', tag: 'legacy-session', message: 'follow-up brief' };
  assert.equal(await resolvePrompt(first), 'initial brief');
  assert.equal(await resolvePrompt(reuse), 'follow-up brief');
  await assert.rejects(resolvePrompt({ prompt: { text: 'not a string' } }), {
    name: 'TypeError',
    message: 'agent: prompt/message must be a string',
  });
  await assert.rejects(resolvePrompt({ message: ['not', 'a', 'string'] }), {
    name: 'TypeError',
    message: 'agent: prompt/message must be a string',
  });
});
