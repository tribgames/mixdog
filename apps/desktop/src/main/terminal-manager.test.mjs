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

test('attach never starts a shell: a never-started or exited one answers null, a live one its replay', async () => {
  const manager = new TerminalManager();
  let spawns = 0;
  let exit = null;
  manager.loadPtyBindings = async () => ({
    spawn: () => {
      spawns += 1;
      return {
        onData() {},
        onExit(listener) {
          exit = listener;
        },
        write() {},
        resize() {},
        kill() {},
      };
    },
  });
  const id = 'session-terminal:warm';
  assert.equal(await manager.attach(id), null, 'never started: not running');
  assert.equal(spawns, 0);
  assert.equal(manager.terminals.has(id), false, 'attach leaves no entry behind');

  await manager.ensure(id, null);
  assert.equal(spawns, 1);
  manager.terminals.get(id).buffer.append('PS C:\\> ');
  assert.deepEqual(await manager.attach(id), { id, replay: 'PS C:\\> ' });
  assert.equal(spawns, 1, 'attaching to a live shell spawns nothing');

  exit({ exitCode: 0 });
  assert.equal(await manager.attach(id), null, 'exited: not running');
  assert.equal(spawns, 1, 'attaching to an exited shell spawns nothing');
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

test('disposeTerminalsUnder kills only terminals inside the removed root', () => {
  const manager = new TerminalManager();
  const killed = [];
  const entry = (cwd) => ({
    pty: { kill: () => killed.push(cwd) },
    buffer: new TerminalReplayBuffer(),
    activity: { exit() {}, dispose() {} },
    disposed: false,
    outputPaused: false,
    shell: 'sh',
    cwd,
  });
  const root = process.platform === 'win32' ? 'C:\\repo\\.wt\\a' : '/repo/.wt/a';
  const sep = process.platform === 'win32' ? '\\' : '/';
  manager.terminals.set('session-terminal:a', entry(root));
  manager.terminals.set('session-terminal:a:2', entry(`${root}${sep}src`));
  manager.terminals.set('session-terminal:a:3', entry(`${root}-sibling`));
  manager.terminals.set('session-terminal:a:4', entry(null));
  assert.deepEqual(manager.disposeTerminalsUnder(`${root}${sep}`).sort(), [
    'session-terminal:a',
    'session-terminal:a:2',
  ]);
  assert.equal(killed.length, 2);
  assert.deepEqual([...manager.terminals.keys()].sort(), ['session-terminal:a:3', 'session-terminal:a:4']);
});

function managerWithPty(sizes) {
  const manager = new TerminalManager();
  manager.loadPtyBindings = async () => ({
    spawn: () => ({
      onData() {},
      onExit() {},
      write() {},
      resize: (cols, rows) => sizes.push([cols, rows]),
      kill() {},
    }),
  });
  const data = [];
  const owners = [];
  manager.subscribe((event) => data.push(event));
  manager.subscribeSizeOwner((change) => owners.push(change));
  return { manager, data, owners };
}

test('a phone owning the PTY size wins over PC resizes and is announced as an event, not output', async () => {
  const sizes = [];
  const { manager, data, owners } = managerWithPty(sizes);
  const id = 'session-terminal:own';
  await manager.ensure(id, null);

  manager.resize(id, 120, 40);
  assert.deepEqual(sizes, [[120, 40]]);

  manager.resize(id, 50, 20, 'phone-a');
  assert.deepEqual(sizes.at(-1), [50, 20]);
  assert.deepEqual(owners, [{ id, cols: 50, rows: 20, owner: 'phone-a' }]);

  // The PC re-fitting its pane must not fight the phone's size.
  manager.resize(id, 120, 40);
  assert.equal(sizes.length, 2);

  // A heartbeat at the same size renews the lease without another event.
  manager.resize(id, 50, 20, 'phone-a');
  assert.equal(owners.length, 1);

  // A view attaching meanwhile learns the owner; its replay stays pure output.
  const attached = await manager.ensure(id, null);
  assert.deepEqual(attached.sizeOwner, { cols: 50, rows: 20, owner: 'phone-a' });
  assert.equal(attached.replay, '');

  manager.resize(id, 0, 0, 'phone-a');
  assert.deepEqual(owners.at(-1), { id, cols: 0, rows: 0, owner: '' });
  const released = await manager.ensure(id, null);
  assert.equal(released.sizeOwner, undefined);
  manager.resize(id, 120, 40);
  assert.deepEqual(sizes.at(-1), [120, 40]);

  assert.deepEqual(data, [], 'ownership never travels in the terminal output stream');
  manager.disposeAll();
});

test('size claims are per client: the newest owns, a release passes it on or back to the PC', async () => {
  const sizes = [];
  const { manager, owners } = managerWithPty(sizes);
  const id = 'session-terminal:two';
  await manager.ensure(id, null);

  manager.resize(id, 50, 20, 'phone-a');
  manager.resize(id, 40, 30, 'phone-b');
  assert.deepEqual(owners.at(-1), { id, cols: 40, rows: 30, owner: 'phone-b' });
  assert.deepEqual(sizes.at(-1), [40, 30]);

  // The older phone renewing (even at a new size) does not take ownership.
  const announced = owners.length;
  manager.resize(id, 55, 22, 'phone-a');
  assert.equal(owners.length, announced);
  assert.deepEqual(sizes.at(-1), [40, 30]);

  // A client that never claimed cannot free anyone's claim.
  manager.resize(id, 0, 0, 'phone-c');
  assert.equal(owners.length, announced);

  // phone-b leaves: ownership passes to phone-a at its latest renewed grid.
  manager.resize(id, 0, 0, 'phone-b');
  assert.deepEqual(owners.at(-1), { id, cols: 55, rows: 22, owner: 'phone-a' });
  assert.deepEqual(sizes.at(-1), [55, 22]);
  manager.resize(id, 120, 40);
  assert.deepEqual(sizes.at(-1), [55, 22], 'the PC still follows phone-a');

  manager.resize(id, 0, 0, 'phone-a');
  assert.deepEqual(owners.at(-1), { id, cols: 0, rows: 0, owner: '' });
  manager.resize(id, 120, 40);
  assert.deepEqual(sizes.at(-1), [120, 40]);
  manager.disposeAll();
});

test('a size claim that stops renewing lapses after 30s and hands over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sizes = [];
  const { manager, owners } = managerWithPty(sizes);
  const id = 'session-terminal:lease';
  await manager.ensure(id, null);
  manager.resize(id, 50, 20, 'phone-a');
  t.mock.timers.tick(20_000);
  manager.resize(id, 40, 30, 'phone-b');
  t.mock.timers.tick(15_000);
  // phone-a's claim lapsed (35s), phone-b (15s) still owns.
  assert.deepEqual(owners.at(-1), { id, cols: 40, rows: 30, owner: 'phone-b' });
  t.mock.timers.tick(16_000);
  assert.deepEqual(owners.at(-1), { id, cols: 0, rows: 0, owner: '' });
  manager.resize(id, 120, 40);
  assert.deepEqual(sizes.at(-1), [120, 40]);
  manager.disposeAll();
});
