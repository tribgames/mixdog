import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCREEN_INPUT_MODE,
  createScreenInputHost,
  formatScreenHostCommand,
  screenHostIdentity,
  parseScreenDesktopLine,
} from './screen-input-host.ts';

/** A mixdog-computer --screen-input stand-in: says `ready`, then answers only when told to. */
function fakeSpawn(greeting = ['ready']) {
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.spawned = { command, args, options };
    child.writes = [];
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (line) => child.writes.push(line),
      end: () => {},
    });
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    };
    child.say = (line) => child.stdout.emit('data', `${line}\n`);
    setImmediate(() => greeting.forEach((line) => child.say(line)));
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test('a command the helper never acknowledges fails at the deadline and the helper is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const fake = fakeSpawn();
    const host = createScreenInputHost({ binary: () => 'C:/mixdog/mixdog-computer.exe', spawn: fake.spawn, commandTimeoutMs: 20 });
    const exits = [];
    host.onExit(() => exits.push('exit'));
    await host.start();
    const first = assert.rejects(
      host.command({ op: 'move', x: 1, y: 1 }),
      (error) => error.code === 'host_unresponsive'
    );
    const second = assert.rejects(
      host.command({ op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true }),
      (error) => error.code === 'host_unresponsive' || error.code === 'host_exited'
    );
    await first;
    await second;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.children[0].killed, true);
    assert.deepEqual(exits, ['exit'], 'an unrequested exit, so the session stops');
    assert.equal(host.alive(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an acknowledged command clears its deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const fake = fakeSpawn();
    const host = createScreenInputHost({ binary: () => 'C:/mixdog/mixdog-computer.exe', spawn: fake.spawn, commandTimeoutMs: 20 });
    await host.start();
    const done = host.command({ op: 'move', x: 1, y: 1 });
    fake.children[0].say('ok 1');
    assert.deepEqual(await done, []);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.children[0].killed, false);
    host.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first desktop and the Windows session are known when start resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const fake = fakeSpawn(['desktop Default 0 0', 'ready 3']);
    const host = createScreenInputHost({ binary: () => 'C:/mixdog/mixdog-computer.exe', spawn: fake.spawn });
    assert.equal(screenHostIdentity(host), null);
    await host.start();
    assert.equal(host.session(), 3);
    assert.deepEqual(screenHostIdentity(host), { session: 3, desktop: 'default' });
    // The secure desktop is up: the input desktop is unreadable, so no identity.
    fake.children[0].say('desktop - 0 1');
    assert.equal(screenHostIdentity(host), null);
    host.kill();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.session(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kill fails pending commands at once and skips the release-on-quit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const fake = fakeSpawn();
    const host = createScreenInputHost({ binary: () => 'C:/mixdog/mixdog-computer.exe', spawn: fake.spawn, commandTimeoutMs: 60_000 });
    await host.start();
    const pending = host.command({ op: 'move', x: 1, y: 1 });
    host.kill();
    await assert.rejects(pending, (error) => error.code === 'host_killed');
    assert.ok(!fake.children[0].writes.includes('q\n'), 'no graceful quit was requested');
    assert.equal(fake.children[0].killed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commands serialize to the one-line wire form', () => {
  assert.equal(formatScreenHostCommand(1, { op: 'move', x: -7, y: 42 }), 'm 1 -7 42');
  assert.equal(formatScreenHostCommand(2, { op: 'button', button: 'left', down: true }), 'b 2 l 1');
  assert.equal(
    formatScreenHostCommand(3, { op: 'button', button: 'right', down: false, at: { x: 1, y: 2 } }),
    'b 3 r 0 1 2'
  );
  assert.equal(formatScreenHostCommand(4, { op: 'wheel', x: 0, y: 0, dx: 0, dy: -120 }), 'w 4 0 0 0 -120');
  assert.equal(
    formatScreenHostCommand(5, { op: 'key', vk: 0x41, scan: 0x1e, extended: true, down: false }),
    'k 5 65 30 1 0'
  );
  assert.equal(formatScreenHostCommand(6, { op: 'cursor' }), 'c 6');
});

test('text is base64 so Unicode and spaces survive the line protocol', () => {
  const line = formatScreenHostCommand(7, { op: 'text', text: 'a b\néllo' });
  const [, id, encoded] = line.split(' ');
  assert.equal(id, '7');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'a b\néllo');
});

test('non-integer coordinates are refused before dispatch', () => {
  assert.throws(() => formatScreenHostCommand(1, { op: 'move', x: 1.5, y: 0 }));
});

test('desktop watcher line parses name and the consent / logon flags', () => {
  assert.deepEqual(parseScreenDesktopLine('Default 0 0'), { inputDesktop: 'Default', consent: false, logonUi: false });
  assert.deepEqual(parseScreenDesktopLine('- 1 0'), { inputDesktop: null, consent: true, logonUi: false });
  assert.deepEqual(parseScreenDesktopLine('Winlogon 0 1'), { inputDesktop: 'Winlogon', consent: false, logonUi: true });
  assert.equal(parseScreenDesktopLine('bad line'), null);
});

test('the input host is the native helper in its screen-input mode, with its own marker', async () => {
  const fake = fakeSpawn();
  const host = createScreenInputHost({ binary: () => 'C:/mixdog/mixdog-computer.exe', spawn: fake.spawn, marker: 77 });
  await host.start();
  const { command, args, options } = fake.children[0].spawned;
  assert.equal(command, 'C:/mixdog/mixdog-computer.exe');
  assert.deepEqual(args, [SCREEN_INPUT_MODE]);
  assert.equal(args[0], '--screen-input');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.MIXDOG_SCREEN_INPUT_MARKER, '77');
  assert.ok(!/powershell/iu.test(command));
  host.kill();
});

test('without a helper binary the start fails instead of falling back', async () => {
  const fake = fakeSpawn();
  const host = createScreenInputHost({
    binary: () => {
      throw new Error('computer_backend_unavailable');
    },
    spawn: fake.spawn,
  });
  await assert.rejects(host.start(), (error) => error.code === 'start_failed');
  assert.equal(fake.children.length, 0);
});

/** A fake spawn that tells the helper's children from the abort cleanup's. */
function cleanupSpawn() {
  const fake = fakeSpawn();
  const cleanups = [];
  const spawn = (command, args, options) => {
    if (args[0] !== '--abort-cleanup') return fake.spawn(command, args, options);
    const child = new EventEmitter();
    child.spawned = { command, args, options };
    child.kill = () => {
      child.killed = true;
    };
    cleanups.push(child);
    return child;
  };
  return { spawn, children: fake.children, cleanups };
}

test('a killed helper is followed by --abort-cleanup with the same marker, and stop waits for it', async () => {
  const fake = cleanupSpawn();
  const host = createScreenInputHost({ binary: () => 'C:/m/mixdog-computer.exe', spawn: fake.spawn, marker: 91 });
  await host.start();
  host.kill();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1);
  assert.deepEqual(fake.cleanups[0].spawned.args, ['--abort-cleanup']);
  assert.equal(fake.cleanups[0].spawned.options.env.MIXDOG_COMPUTER_INPUT_MARKER, '91');
  let stopped = false;
  const stopping = host.stop().then(() => (stopped = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  fake.cleanups[0].emit('exit', 0);
  await stopping;
});

test('a second kill of the same helper shares its one cleanup, and kill resolves only after it', async () => {
  const fake = cleanupSpawn();
  const host = createScreenInputHost({ binary: () => 'C:/m/mixdog-computer.exe', spawn: fake.spawn, marker: 5 });
  await host.start();
  void host.kill();
  let done = false;
  const second = host.kill().then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1);
  assert.equal(done, false);
  fake.cleanups[0].emit('exit', 0);
  await second;
});

test('an unresponsive helper is cleaned up after its kill, and a hung cleanup is cut at its bound', async () => {
  const fake = cleanupSpawn();
  const host = createScreenInputHost({
    binary: () => 'C:/m/mixdog-computer.exe',
    spawn: fake.spawn,
    commandTimeoutMs: 20,
    abortCleanupTimeoutMs: 30,
  });
  await host.start();
  await assert.rejects(host.command({ op: 'cursor' }), (error) => error.code === 'host_unresponsive');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.cleanups[0].killed, true);
});

test('the retired PowerShell host files are swept once at the first start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-powershell-'));
  try {
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    writeFileSync(join(dir, 'remote-screen-host-1-abcd.ps1'), 'x');
    writeFileSync(join(dir, 'keep.txt'), 'x');
    mkdirSync(join(dir, 'remote-screen-cache'));
    writeFileSync(join(dir, 'remote-screen-cache', 'remote-screen-host-0123456789abcdef.dll'), 'x');
    const fake = fakeSpawn();
    const host = createScreenInputHost({ binary: () => 'b', spawn: fake.spawn, powerShellHostDirectory: dir });
    await host.start();
    assert.equal(existsSync(join(dir, 'remote-screen-host-1-abcd.ps1')), false);
    assert.equal(existsSync(join(dir, 'remote-screen-cache')), false);
    assert.equal(existsSync(join(dir, 'keep.txt')), true);
    host.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a helper that exits without saying it released is cleaned up; one that released is not', async () => {
  const fake = cleanupSpawn();
  const host = createScreenInputHost({ binary: () => 'C:/m/mixdog-computer.exe', spawn: fake.spawn, marker: 7 });
  await host.start();
  fake.children[0].emit('exit', 3, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1, 'a crashed helper gets the abort cleanup');
  assert.equal(fake.cleanups[0].spawned.options.env.MIXDOG_COMPUTER_INPUT_MARKER, '7');
  fake.cleanups[0].emit('exit', 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await host.start();
  fake.children[1].say('released');
  fake.children[1].emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1, 'a helper that released needs no cleanup');
});

test('a restart waits for the cleanup of the helper before it', async () => {
  const fake = cleanupSpawn();
  const host = createScreenInputHost({ binary: () => 'C:/m/mixdog-computer.exe', spawn: fake.spawn, marker: 8 });
  await host.start();
  void host.kill();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.cleanups.length, 1);
  const restarted = host.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.children.length, 1, 'no new helper while the cleanup runs');
  fake.cleanups[0].emit('exit', 0);
  await restarted;
  assert.equal(fake.children.length, 2);
});
