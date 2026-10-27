import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCREEN_HOST_CACHE_DIRECTORY,
  createScreenInputHost,
  formatScreenHostCommand,
  screenHostIdentity,
  parseScreenDesktopLine,
  screenInputHostProgram,
  sweepScreenHostFiles,
} from './screen-input-host.ts';

test('orphaned host scripts, other builds and dead staging files are swept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const cache = join(dir, SCREEN_HOST_CACHE_DIRECTORY);
    mkdirSync(cache);
    const build = 'a'.repeat(16);
    const files = {
      [join(dir, 'remote-screen-host-100-abcd.ps1')]: 'dead process',
      [join(dir, 'remote-screen-host-200-abcd.ps1')]: 'live process',
      [join(dir, 'unrelated.txt')]: 'kept',
      [join(cache, `remote-screen-host-${build}.dll`)]: 'this build',
      [join(cache, `remote-screen-host-${'b'.repeat(16)}.dll`)]: 'old build',
      [join(cache, `remote-screen-host-${build}.dll.300.tmp`)]: 'dead staging',
      [join(cache, `remote-screen-host-${build}.dll.200.tmp`)]: 'live staging',
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(path, text);
    sweepScreenHostFiles(dir, build, (pid) => pid === 200);
    assert.deepEqual(readdirSync(dir).sort(), [
      'remote-screen-cache',
      'remote-screen-host-200-abcd.ps1',
      'unrelated.txt',
    ]);
    assert.deepEqual(readdirSync(cache).sort(), [
      `remote-screen-host-${build}.dll`,
      `remote-screen-host-${build}.dll.200.tmp`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A PowerShell stand-in: says `ready`, then answers only when told to. */
function fakeSpawn(greeting = ['ready']) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
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
    const host = createScreenInputHost({ directory: dir, spawn: fake.spawn, commandTimeoutMs: 20 });
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
    const host = createScreenInputHost({ directory: dir, spawn: fake.spawn, commandTimeoutMs: 20 });
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
    const host = createScreenInputHost({ directory: dir, spawn: fake.spawn });
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

test('the helper reports its first desktop before ready and its session in ready', () => {
  const program = screenInputHostProgram();
  assert.match(
    program,
    /Write\("desktop " \+ lastState\);[\s\S]*Write\("ready " \+ Process\.GetCurrentProcess\(\)\.SessionId/
  );
});

test('kill fails pending commands at once and skips the release-on-quit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-screen-host-'));
  try {
    const fake = fakeSpawn();
    const host = createScreenInputHost({ directory: dir, spawn: fake.spawn, commandTimeoutMs: 60_000 });
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

test('tabs and line breaks are typed as keys, not Unicode packets', () => {
  const program = screenInputHostProgram();
  assert.match(program, /ch == '\\t'[\s\S]*Key\(0x09, 0x0F/);
  assert.match(program, /ch == '\\n'[\s\S]*Key\(0x0D, 0x1C/);
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

test('the bootstrap program embeds the injector and never breaks the here-string', () => {
  const program = screenInputHostProgram();
  assert.match(program, /MixdogScreenHost/);
  assert.match(program, /class MixNativeInput/);
  assert.match(program, /Serve\(\$env:MIXDOG_SCREEN_INPUT_MARKER\)/);
  // Exactly one here-string close: a stray `'@` line inside the source would
  // terminate it early and add a second. The generator guards against it.
  const closes = program.split('\n').filter((line) => line === "'@").length;
  assert.equal(closes, 1);
});
