import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshSessionBp3Environment } from './prompt-utils.mjs';

test('both session environment layouts carry the environment and core memory', () => {
  const cwd = 'C:\\work';
  for (const split of [true, false]) {
    const session = {
      owner: 'cli',
      model: 'test',
      cwd,
      bp3EnvSplit: split,
      bp3CoreContext: '# Core Memory\n- User-authored memory',
      bp3EnvironmentContext: 'Environment',
      messages: [{ role: 'system', cacheTier: split ? 'env' : 'tier3', content: 'old' }],
    };
    refreshSessionBp3Environment(session, cwd);
    const text = session.messages.map((message) => message.content).join('\n');
    assert.match(text, /Environment/);
    if (!split) assert.match(text, /User-authored memory/);
  }
});

test('effort and fast changes leave the session environment block untouched', () => {
  const envMessage = { role: 'system', cacheTier: 'env', content: 'old' };
  const session = {
    owner: 'cli',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: 'C:\\work',
    bp3EnvSplit: true,
    bp3EnvironmentContext: 'Environment',
    messages: [envMessage],
  };
  refreshSessionBp3Environment(session, session.cwd);
  const first = session.messages[0];
  assert.match(first.content, /^# Session\nCwd: C:\\work\nModel: Claude-Opus-5-5\n/);
  assert.doesNotMatch(first.content, /HIGH|FAST/);

  session.effort = 'low';
  session.fast = true;
  refreshSessionBp3Environment(session, session.cwd);
  assert.equal(session.messages[0], first);

  session.model = 'claude-fable-5-1';
  refreshSessionBp3Environment(session, session.cwd);
  assert.notEqual(session.messages[0], first);
  assert.match(session.messages[0].content, /Model: Claude-Fable-5-1/);
});
