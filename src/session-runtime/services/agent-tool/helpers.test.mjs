import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePrompt, rowMatchesContext, sessionMatchesContext } from './helpers.mjs';

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

test('agent scope is strictly session-owned when the context carries a session id', () => {
  const context = { callerSessionId: 'sess_owner', clientHostPid: 100 };
  // Owner match wins; a pid match alone must NOT leak a sibling session's agent.
  assert.equal(rowMatchesContext({ ownerSessionId: 'sess_owner', clientHostPid: 100 }, context), true);
  assert.equal(rowMatchesContext({ ownerSessionId: 'sess_other', clientHostPid: 100 }, context), false);
  assert.equal(rowMatchesContext({ ownerSessionId: null, clientHostPid: 100 }, context), false);
  assert.equal(sessionMatchesContext({ ownerSessionId: 'sess_owner', clientHostPid: 100 }, context), true);
  assert.equal(sessionMatchesContext({ ownerSessionId: 'sess_other', clientHostPid: 100 }, context), false);
  assert.equal(sessionMatchesContext({ parentSessionId: 'sess_owner', clientHostPid: 200 }, context), true);
  // Without a caller session id, pid scoping is unchanged.
  assert.equal(rowMatchesContext({ ownerSessionId: 'sess_other', clientHostPid: 100 }, { clientHostPid: 100 }), true);
  assert.equal(rowMatchesContext({ clientHostPid: 200 }, { clientHostPid: 100 }), false);
  // Unscoped context (scope:'all') sees everything.
  assert.equal(rowMatchesContext({ ownerSessionId: 'sess_other' }, {}), true);
});
