import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { MACRO_LOCKDOWN_REGISTRY, runSoffice, sharedProfileDir, sofficeConvertArguments } from './portable-soffice.mjs';

const sleeper = (pidFile) =>
  `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(file) {
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text) return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('child never started');
}

test('a cancelled conversion is reported only after its process has exited', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'soffice-life-')), 'pid');
  const controller = new AbortController();
  const run = runSoffice(process.execPath, ['-e', sleeper(pidFile)], {
    signal: controller.signal,
    timeoutMs: 60_000,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  });
  const pid = await pidOf(pidFile);
  controller.abort();
  assert.deepEqual(await run, { ok: false, error: 'cancelled' });
  assert.equal(alive(pid), false);
});

test('a timed-out conversion is reported only after its process has exited', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'soffice-life-')), 'pid');
  const run = runSoffice(process.execPath, ['-e', sleeper(pidFile)], {
    signal: null,
    timeoutMs: 700,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  });
  const result = await run;
  assert.deepEqual(result, { ok: false, error: 'timed out' });
  assert.equal(alive(await pidOf(pidFile)), false);
});

test('conversions launch in a private profile with first-start and recovery prompts off', () => {
  const profile = join(tmpdir(), 'profile-x');
  const args = sofficeConvertArguments(profile, { to: 'xlsx', outDir: 'out', input: 'in.xls' });
  assert.equal(args[0], `-env:UserInstallation=${pathToFileURL(profile).href}`);
  for (const flag of ['--headless', '--norestore', '--nofirststartwizard', '--nologo', '--invisible']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual(args.slice(-5), ['--convert-to', 'xlsx', '--outdir', 'out', 'in.xls']);
});

// Loads the module under test with `spawn` replaced by fakes that never emit on
// their own, so a test decides when (and whether) each process reports back.
async function fakeProcessModule(t, tag, { platform = 'win32', spawnTaskkill } = {}) {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const events = [];
  const spawned = [];
  const fake = (command) => {
    const child = new EventEmitter();
    const label = command === 'taskkill' ? 'taskkill' : 'launcher';
    child.pid = 4242;
    child.stderr = new PassThrough();
    child.kill = t.mock.fn(() => {
      events.push(`${label}.kill`);
    });
    if (command === 'taskkill') {
      events.push('taskkill.spawn');
      spawnTaskkill?.();
    }
    spawned.push({ command, child });
    return child;
  };
  const spawnSync = t.mock.fn(() => {
    throw new Error('synchronous taskkill would block the event loop');
  });
  t.mock.module('node:child_process', { namedExports: { spawn: fake, spawnSync } });
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => Object.defineProperty(process, 'platform', original));
  const { runSoffice } = await import(`./portable-soffice.mjs?${tag}`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const state = { result: null };
  const pending = runSoffice('soffice.com', [], {
    signal: controller.signal,
    timeoutMs: 60_000,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  }).then((value) => {
    state.result = value;
  });
  const launcher = spawned[0].child;
  const killer = () => spawned.find((entry) => entry.command === 'taskkill')?.child;
  return { controller, events, killer, launcher, pending, spawnSync, state };
}

test('Windows cancel kills the launcher only after taskkill has exited', async (t) => {
  const { controller, events, killer, launcher, pending, spawnSync, state } = await fakeProcessModule(t, 'order');
  controller.abort();
  assert.deepEqual(events, ['taskkill.spawn']);
  assert.equal(spawnSync.mock.callCount(), 0);
  killer().emit('close', 0);
  assert.deepEqual(events, ['taskkill.spawn', 'launcher.kill']);
  // The finished taskkill's deadline is cleared: it neither kills the helper nor the launcher again.
  t.mock.timers.tick(5_000);
  assert.deepEqual(events, ['taskkill.spawn', 'launcher.kill']);
  assert.equal(state.result, null);
  launcher.emit('close', null);
  await pending;
  assert.deepEqual(state.result, { ok: false, error: 'cancelled' });
});

test('a taskkill that fails to run still lets the launcher be killed once', async (t) => {
  const { controller, events, killer, pending, state, launcher } = await fakeProcessModule(t, 'taskkill-error');
  controller.abort();
  killer().emit('error', new Error('spawn taskkill ENOENT'));
  assert.deepEqual(events, ['taskkill.spawn', 'launcher.kill']);
  killer().emit('close', 1);
  t.mock.timers.tick(5_000);
  assert.deepEqual(events, ['taskkill.spawn', 'launcher.kill']);
  launcher.emit('close', null);
  await pending;
  assert.deepEqual(state.result, { ok: false, error: 'cancelled' });
});

test('a taskkill that never exits is stopped at its deadline and the launcher killed after it', async (t) => {
  const { controller, events, killer, launcher, pending, state } = await fakeProcessModule(t, 'taskkill-hung');
  controller.abort();
  t.mock.timers.tick(4_999);
  assert.deepEqual(events, ['taskkill.spawn']);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ['taskkill.spawn', 'taskkill.kill', 'launcher.kill']);
  killer().emit('close', null);
  assert.deepEqual(events, ['taskkill.spawn', 'taskkill.kill', 'launcher.kill']);
  launcher.emit('close', null);
  await pending;
  assert.deepEqual(state.result, { ok: false, error: 'cancelled' });
});

test('the grace deadline is armed before the tree kill begins', async (t) => {
  let armed = null;
  let tick = null;
  const harness = await fakeProcessModule(t, 'grace-first', {
    spawnTaskkill: () => {
      // Once taskkill is being launched, a grace timer that exists fires on this tick.
      tick();
      armed = true;
    },
  });
  tick = () => t.mock.timers.tick(10_000);
  harness.controller.abort();
  assert.equal(armed, true);
  await harness.pending;
  assert.deepEqual(harness.state.result, { ok: false, error: 'cancelled' });
});

test('a taskkill that cannot be launched falls back to killing the launcher at once', async (t) => {
  const { controller, events, launcher, pending, state } = await fakeProcessModule(t, 'taskkill-throws', {
    spawnTaskkill: () => {
      throw new Error('spawn failed');
    },
  });
  controller.abort();
  assert.deepEqual(events, ['taskkill.spawn', 'launcher.kill']);
  launcher.emit('close', null);
  await pending;
  assert.deepEqual(state.result, { ok: false, error: 'cancelled' });
});

test('off Windows the launcher is killed directly without taskkill', async (t) => {
  const { controller, events, launcher, pending, state } = await fakeProcessModule(t, 'posix', { platform: 'linux' });
  controller.abort();
  assert.deepEqual(events, ['launcher.kill']);
  launcher.emit('close', null);
  await pending;
  assert.deepEqual(state.result, { ok: false, error: 'cancelled' });
});

// Fails the first matching file operation, naming the profile path as Node's own errors do.
async function profileModule(t, tag, failing) {
  const real = await import('node:fs/promises');
  const created = [];
  let failures = 1;
  const failOnce = (name, path) => {
    if (name !== failing || failures-- <= 0) return;
    throw Object.assign(new Error(`ENOSPC: no space left on device, ${name} '${path}'`), { code: 'ENOSPC' });
  };
  t.mock.module('node:fs/promises', {
    namedExports: {
      ...real,
      mkdtemp: async (prefix) => {
        const directory = await real.mkdtemp(prefix);
        created.push(directory);
        return directory;
      },
      mkdir: async (path, options) => {
        failOnce('mkdir', path);
        return real.mkdir(path, options);
      },
      writeFile: async (path, ...rest) => {
        failOnce('writeFile', path);
        return real.writeFile(path, ...rest);
      },
    },
  });
  const { sharedProfileDir } = await import(`./portable-soffice.mjs?${tag}`);
  return { build: sharedProfileDir, created };
}

for (const failing of ['mkdir', 'writeFile']) {
  test(`a failed profile ${failing} cleans up, hides the path, keeps the code, and the next call retries`, async (t) => {
    const { build, created } = await profileModule(t, `profile-${failing}`, failing);
    await assert.rejects(build(), (error) => {
      assert.ok(!error.message.includes(created[0]), error.message);
      assert.match(error.message, /ENOSPC/);
      assert.equal(error.code, 'ENOSPC');
      return true;
    });
    assert.equal(existsSync(created[0]), false);
    const profile = await build();
    assert.equal(created.length, 2);
    assert.equal(profile, created[1]);
    assert.equal(readFileSync(join(profile, 'user', 'registrymodifications.xcu'), 'utf8'), MACRO_LOCKDOWN_REGISTRY);
  });
}

test('callers sharing one failing profile build all reject, and the next call builds again', async (t) => {
  const { build, created } = await profileModule(t, 'profile-concurrent', 'mkdir');
  const outcomes = await Promise.allSettled([build(), build()]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['rejected', 'rejected']
  );
  for (const outcome of outcomes) assert.ok(!outcome.reason.message.includes(created[0]), outcome.reason.message);
  assert.equal(created.length, 1);
  assert.equal(existsSync(created[0]), false);
  const profile = await build();
  assert.equal(created.length, 2);
  assert.equal(profile, await build());
});

test('the private profile starts with macros locked down', async () => {
  const profile = await sharedProfileDir();
  const registry = readFileSync(join(profile, 'user', 'registrymodifications.xcu'), 'utf8');
  assert.equal(registry, MACRO_LOCKDOWN_REGISTRY);
  assert.match(registry, /oor:name="MacroSecurityLevel" oor:op="fuse"><value>3<\/value>/);
  assert.match(registry, /oor:name="DisableMacrosExecution" oor:op="fuse"><value>true<\/value>/);
  assert.match(registry, /Office\.Common\/Security\/Scripting/);
});
