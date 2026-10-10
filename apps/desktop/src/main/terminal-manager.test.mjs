import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalManager, TerminalReplayBuffer, terminalCursorEpoch } from './terminal-manager.ts';

test('replay buffer cursor and readSince never consume output', () => {
  const buffer = new TerminalReplayBuffer(10);
  buffer.append('abcd');
  assert.equal(buffer.cursor, 4);
  buffer.append('efgh');
  assert.deepEqual(buffer.readSince(4), { text: 'efgh', cursor: 8, reset: false });
  assert.deepEqual(buffer.readSince(8), { text: '', cursor: 8, reset: false });
  assert.equal(buffer.read(), 'abcdefgh');
  buffer.append('ijklmn');
  // 14 chars appended, 10 retained: cursor 2 was trimmed away.
  assert.equal(buffer.cursor, 14);
  assert.equal(buffer.read(), 'efghijklmn');
  assert.deepEqual(buffer.readSince(2), { text: 'efghijklmn', cursor: 14, reset: true });
  assert.deepEqual(buffer.readSince(12), { text: 'mn', cursor: 14, reset: false });
  assert.deepEqual(buffer.readSince(14), { text: '', cursor: 14, reset: false });
});

test('a cursor beyond the buffer end, or from a recreated terminal, resets to the full output', () => {
  const buffer = new TerminalReplayBuffer(10);
  buffer.append('abcd');
  assert.deepEqual(buffer.readSince(99), { text: 'abcd', cursor: 4, reset: true });
  // A successor buffer starts above every cursor the old one issued.
  const successor = new TerminalReplayBuffer(10, buffer.cursor + 1);
  successor.append('xy');
  assert.equal(successor.trimmed, false);
  assert.equal(buffer.trimmed, false);
  buffer.append('efghijk');
  assert.equal(buffer.trimmed, true);
  assert.deepEqual(successor.readSince(4), { text: 'xy', cursor: 7, reset: true });
  assert.deepEqual(successor.readSince(5), { text: 'xy', cursor: 7, reset: false });
});

test('a cursor from before a daemon restart falls below a new terminal epoch', () => {
  const before = new TerminalReplayBuffer(10, terminalCursorEpoch(1_000));
  before.append('x'.repeat(300));
  const after = new TerminalReplayBuffer(10, terminalCursorEpoch(2_000));
  after.append('fresh');
  assert.deepEqual(after.readSince(before.cursor), { text: 'fresh', cursor: after.cursor, reset: true });
});

test('concurrent ensure for one terminal id spawns exactly one PTY', async () => {
  const manager = new TerminalManager();
  let spawns = 0;
  manager.loadPtyBindings = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      spawn: () => {
        spawns += 1;
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      },
    };
  };
  const id = 'session-terminal:abc';
  const results = await Promise.all(Array.from({ length: 7 }, () => manager.ensure(id, null)));
  assert.equal(spawns, 1);
  assert.ok(results.every((r) => r.id === id));
  assert.equal((await manager.ensure(id, null)).id, id);
  assert.equal(spawns, 1);
});

test('sessionTabs lists only one session in tab order and snapshot is read-only', () => {
  const manager = new TerminalManager();
  const entry = (shell, disposed = false, cwd = null) => {
    const buffer = new TerminalReplayBuffer();
    buffer.append(`hello ${shell}`);
    return { pty: {}, buffer, disposed, outputPaused: false, shell, cwd };
  };
  manager.terminals.set('session-terminal:a:2', entry('bash', true));
  manager.terminals.set('session-terminal:a', entry('pwsh', false, 'C:\\w'));
  manager.terminals.set('session-terminal:ab', entry('zsh'));
  manager.terminals.set('session-terminal:b', entry('sh'));
  manager.terminals.set('term_1_1', entry('sh'));
  assert.deepEqual(manager.sessionTabs('a'), [
    { tab: 1, id: 'session-terminal:a', shell: 'pwsh', running: true, cwd: 'C:\\w' },
    { tab: 2, id: 'session-terminal:a:2', shell: 'bash', running: false, cwd: null },
  ]);
  assert.deepEqual(manager.sessionTabs('nope'), []);
  assert.deepEqual(manager.snapshot('session-terminal:a'), { text: 'hello pwsh', cursor: 10, reset: false });
  assert.deepEqual(manager.snapshot('session-terminal:a', 6), { text: 'pwsh', cursor: 10, reset: false });
  assert.equal(manager.snapshot('session-terminal:missing'), null);
  assert.equal(manager.snapshot('session-terminal:a').text, 'hello pwsh');
});
