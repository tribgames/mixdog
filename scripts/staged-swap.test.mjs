// The swap half of the staged update of an npm install (bin/staged-swap.mjs) and the launcher's use of it (bin/mixdog.mjs,
// bin/invocation.mjs), against 1.4.5's cli.mjs and staged-update.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { skipsHostPrelude } from '../bin/invocation.mjs';
import { launchPlan, startPlan, swapBeforeLaunch } from '../bin/mixdog.mjs';
import { READY_FILE } from '../bin/runtime.mjs';
import {
  compareSemver,
  dataDir,
  nextRenameDelayMs,
  packageComplete,
  performPendingSwap,
  renameWithRetry,
} from '../bin/staged-swap.mjs';
import { programContents, runtimeEntry, writePackage as writeLauncherPackage, writeReadyRuntime } from './npm-test-fixture.mjs';

const KEY = 'linux-x64';
const contents = (version) => programContents('linux', `program ${version}`);
const entryOf = (version) =>
  runtimeEntry({ key: KEY, version, contents: contents(version), sha256: createHash('sha256').update(version).digest('hex') });

/** A package of `version` in `dir` whose runtime for the test host (linux-x64) is ready in the cache of `data`; its folder. */
const install = (dir, version, data) => {
  writeLauncherPackage(dir, { version, targets: { [KEY]: entryOf(version) } });
  return writeReadyRuntime({ data, key: KEY, entry: entryOf(version), contents: contents(version) });
};

const rig = ({ installed = '1.5.0', staged = [], layout = ['node_modules', 'mixdog'], damage } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-swap-test-'));
  const packageRoot = join(root, ...layout);
  const data = join(root, 'data');
  const HOST = { platform: 'linux', arch: 'x64', data };
  install(packageRoot, installed, data);
  for (const version of staged) {
    const verDir = join(data, 'staging', version);
    const pkgDir = join(verDir, 'mixdog');
    const folder = install(pkgDir, version, data);
    damage?.(version, pkgDir, folder);
    writeFileSync(join(verDir, '.staged-complete.json'), JSON.stringify({ version, pkgDir, stagedAt: 1 }));
  }
  const live = (pid) => {
    mkdirSync(join(data, 'live-sessions'), { recursive: true });
    writeFileSync(join(data, 'live-sessions', `${pid}.pid`), `${pid} 1\n`);
  };
  const swap = (options = {}) =>
    performPendingSwap({ packageRoot, data, env: {}, pid: 100, alive: () => true, ...HOST, ...options });
  const version = () => JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  return {
    root,
    packageRoot,
    data,
    host: HOST,
    live,
    swap,
    version,
    staging: () => (existsSync(join(data, 'staging')) ? readdirSync(join(data, 'staging')) : []),
  };
};

const cleanup = (t, ...rigs) =>
  t.after(() => {
    for (const r of rigs) rmSync(r.root, { recursive: true, force: true });
  });

test('a completed staged version newer than the installed one replaces the package, and the replaced version and its runtime are cleaned away', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  assert.equal(r.swap(), true);
  assert.equal(r.version(), '1.5.1');
  assert.deepEqual(readdirSync(join(r.packageRoot, '..')), ['mixdog'], 'no backup is left beside the package');
  assert.deepEqual(r.staging(), [], 'the staged folder moved into place and the lock is gone');
  assert.deepEqual(readdirSync(join(r.data, 'runtime')), ['1.5.1'], 'the runtime of 1.5.0 is gone, the one of 1.5.1 runs');
  assert.equal(packageComplete(r.packageRoot, r.host), true);
});

test('the highest staged version wins and an older or equal one is only cleaned away', (t) => {
  const r = rig({ staged: ['1.5.1', '1.6.0', '1.4.0', '1.5.0'] });
  cleanup(t, r);
  assert.equal(r.swap(), true);
  assert.equal(r.version(), '1.6.0');
  assert.deepEqual(r.staging(), [], 'what is not newer than the swapped-in version is removed');
});

test('another running session defers the swap and keeps the staged version for the next start', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  r.live(4242);
  assert.equal(r.swap(), false);
  assert.equal(r.version(), '1.5.0');
  assert.deepEqual(r.staging(), ['1.5.1']);
  // The pid file of a process that is gone does not defer it, and is removed.
  assert.equal(r.swap({ alive: () => false }), true);
  assert.equal(r.version(), '1.5.1');
});

test('nothing is swapped without a completion marker, for a version that is not what the marker says, or for a version not newer', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  rmSync(join(r.data, 'staging', '1.5.1', '.staged-complete.json'));
  assert.equal(r.swap(), false);
  writeFileSync(
    join(r.data, 'staging', '1.5.1', '.staged-complete.json'),
    JSON.stringify({ version: '1.5.2', pkgDir: join(r.data, 'staging', '1.5.1', 'mixdog') })
  );
  assert.equal(r.swap(), false, 'the package inside says 1.5.1');
  assert.equal(r.version(), '1.5.0');
});

test('a staged package whose verified runtime is not ready never replaces the install, which keeps running with its own', (t) => {
  const damages = {
    'no runtime in the cache': (_v, _pkg, folder) => rmSync(folder, { recursive: true }),
    'a runtime of other bytes': (_v, _pkg, folder) =>
      writeFileSync(join(folder, READY_FILE), readFileSync(join(folder, READY_FILE), 'utf8').replace(/"sha256":"[0-9a-f]+"/, `"sha256":"${'f'.repeat(64)}"`)),
    'a program of the runtime missing': (_v, _pkg, folder) => rmSync(join(folder, 'mixdogd')),
    'a program of the runtime of another size': (_v, _pkg, folder) => writeFileSync(join(folder, 'mixdog-askpass'), 'x'),
    'a manifest with no runtime for this host': (version, pkg) =>
      writeFileSync(
        join(pkg, 'bin', 'runtime-manifest.json'),
        JSON.stringify({ schema: 1, repository: 'o/r', tag: `v${version}`, targets: { 'darwin-arm64': { ...entryOf(version), asset: 'mixdog-runtime-darwin-arm64.tar.gz' } } })
      ),
    'no launcher': (_v, pkg) => rmSync(join(pkg, 'bin', 'mixdog.mjs')),
    'no runtime module': (_v, pkg) => rmSync(join(pkg, 'bin', 'runtime.mjs')),
    'no command for an install made by 1.4.5': (_v, pkg) => rmSync(join(pkg, 'src', 'cli.mjs')),
  };
  for (const [what, damage] of Object.entries(damages)) {
    const r = rig({ staged: ['1.5.1'], damage });
    cleanup(t, r);
    assert.equal(r.swap(), false, what);
    assert.equal(r.version(), '1.5.0', what);
    assert.deepEqual(readdirSync(join(r.packageRoot, '..')), ['mixdog'], what);
    assert.equal(packageComplete(r.packageRoot, r.host), true, `${what}: the installed package and its runtime are untouched`);
  }
});

test('a package that is incomplete once in place is swapped back out and the working backup is kept until then', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  let asked = 0;
  const swapped = r.swap({
    verify: (root) => {
      asked += 1;
      assert.equal(
        readFileSync(join(root, 'package.json'), 'utf8').includes('1.5.1'),
        true,
        'the new package is what is verified'
      );
      assert.ok(
        readdirSync(join(root, '..')).some((name) => name.startsWith('mixdog.old-')),
        'the backup is still there while it is verified'
      );
      return false;
    },
  });
  assert.equal(swapped, false);
  assert.equal(asked, 1);
  assert.equal(r.version(), '1.5.0', 'the working install is back');
  assert.deepEqual(readdirSync(join(r.packageRoot, '..')), ['mixdog'], 'neither the backup nor the rejected package is left');
  assert.deepEqual(readdirSync(join(r.data, 'runtime')).sort(), ['1.5.0', '1.5.1'], 'the runtime of the working version stays');
});

test('a swap that cannot restore a usable install ends the start with the backup named', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  let said = '';
  let code;
  // The new package fails verification and the backup is gone when the swap goes to put it back.
  r.swap({
    verify: (root) => {
      for (const name of readdirSync(join(root, '..')))
        if (name.startsWith('mixdog.old-')) rmSync(join(root, '..', name), { recursive: true });
      return false;
    },
    exit: (c) => {
      code = c;
    },
    stderr: { write: (text) => (said += text) },
  });
  assert.equal(code, 1);
  assert.match(said, /update swap failed and could not be rolled back - backup preserved at .*mixdog\.old-/);
});

test('a start that loses the swap lock to a live owner goes on only when the install is present and settled, else it fails before anything resolves', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  mkdirSync(join(r.data, 'staging'), { recursive: true });
  writeFileSync(join(r.data, 'staging', '.swap.lock'), `999 ${Date.now()}`);
  const options = { lockWaitMs: 30, stableWaitMs: 200 };
  let code;
  let said = '';
  const exit = (c) => {
    code = c;
  };
  const stderr = { write: (text) => (said += text) };
  // The owner has the install renamed aside right now.
  const aside = `${r.packageRoot}.old-1`;
  renameSync(r.packageRoot, aside);
  assert.equal(r.swap({ ...options, exit, stderr }), false);
  assert.equal(code, 1);
  assert.match(said, /update in progress/);
  // The owner restored it: this start goes on.
  renameSync(aside, r.packageRoot);
  code = undefined;
  assert.equal(r.swap({ ...options, exit, stderr }), false);
  assert.equal(code, undefined, 'a settled install is run');
  assert.equal(r.version(), '1.5.0', 'and nothing was swapped under the owner');
  // A lock whose owner is gone is taken over: the swap goes on.
  assert.equal(r.swap({ ...options, alive: () => false }), true);
});

test('a source checkout, a package outside node_modules, the swap switches and the run a swap started never swap', (t) => {
  const checkout = rig({ staged: ['1.5.1'], layout: ['src', 'mixdog'] });
  const installed = rig({ staged: ['1.5.1'] });
  cleanup(t, checkout, installed);
  assert.equal(checkout.swap(), false);
  assert.equal(installed.swap({ env: { MIXDOG_SWAP_REEXEC: '1' } }), false);
  assert.equal(installed.swap({ env: { MIXDOG_DISABLE_STAGED_SWAP: '1' } }), false);
  assert.equal(installed.version(), '1.5.0');
  assert.equal(installed.swap(), true);
});

test('mixdog exec and the refusals before the host never swap; the other invocations do (1.4.5 cli.mjs skipHostPrelude)', () => {
  const swaps = [];
  const swap = (options) => swaps.push(options) && true;
  assert.equal(swapBeforeLaunch(['exec', 'hi'], { packageRoot: 'p' }, swap), false);
  assert.equal(swapBeforeLaunch(['--json'], { packageRoot: 'p' }, swap), false);
  assert.equal(swapBeforeLaunch(['--provider'], { packageRoot: 'p' }, swap), false);
  assert.deepEqual(swaps, []);
  assert.equal(swapBeforeLaunch([], { packageRoot: 'p' }, swap), true);
  assert.equal(swapBeforeLaunch(['--help'], { packageRoot: 'p' }, swap), true);
  assert.equal(swapBeforeLaunch(['--plain'], { packageRoot: 'p' }, swap), true);
  assert.equal(swaps.length, 3);
});

test('the launcher reads a command line as the native entry does: one table, tested here and by mixdog-entry', () => {
  const cases = JSON.parse(
    readFileSync(new URL('../native/core/crates/mixdog-entry/tests/prelude-cases.json', import.meta.url), 'utf8')
  );
  assert.ok(cases.length > 20);
  for (const { argv, skip } of cases) assert.equal(skipsHostPrelude(argv), skip, JSON.stringify(argv));
});

const refuse = (code) => Object.assign(new Error(code), { code });

const refusedPauses = (code, random) => {
  const pauses = [];
  assert.throws(
    () =>
      renameWithRetry('a', 'b', {
        rename: () => {
          throw refuse(code);
        },
        sleep: (ms) => pauses.push(ms),
        random,
      }),
    { code }
  );
  return pauses;
};

test('a rename that is refused every time is retried after 23 pauses of about 4.2 s, then the refusal is thrown', () => {
  const pauses = refusedPauses('EBUSY', () => 0);
  assert.equal(pauses.length, 23);
  assert.equal(
    pauses.reduce((sum, ms) => sum + ms, 0),
    4175
  );
  assert.deepEqual(pauses.slice(0, 4), [25, 50, 100, 200]);
});

test('each pause of a retried rename carries jitter below min(50, pause)', () => {
  const plain = refusedPauses('EBUSY', () => 0);
  const jittered = refusedPauses('EPERM', () => 0.999);
  assert.deepEqual(jittered.slice(0, 3), [25 + 24, 50 + 49, 100 + 49]);
  assert.ok(jittered.every((ms, i) => ms >= plain[i] && ms < plain[i] + 50));
});

test('only the transient refusals of a rename are waited for', () => {
  for (const code of ['ENOENT', 'ENOTEMPTY', 'EXDEV', undefined]) {
    const slept = [];
    assert.throws(() =>
      renameWithRetry('a', 'b', {
        rename: () => {
          throw refuse(code);
        },
        sleep: (ms) => slept.push(ms),
      })
    );
    assert.deepEqual(slept, [], String(code));
  }
});

test('a transient refusal of a rename that clears lands the rename', () => {
  let calls = 0;
  renameWithRetry('a', 'b', {
    rename: () => {
      if (++calls < 3) throw refuse('EACCES');
    },
    sleep: () => {},
  });
  assert.equal(calls, 3);
});

test('the last pause of a rename is the 23rd, and no 24th follows', () => {
  assert.equal(
    nextRenameDelayMs(refuse('EEXIST'), 22, 'b', () => 0),
    200
  );
  assert.equal(
    nextRenameDelayMs(refuse('EEXIST'), 23, 'b', () => 0),
    null
  );
});

test('renaming over a read-only file is not retried: it never clears', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-swap-ro-'));
  t.after(() => {
    chmodSync(join(dir, 'ro'), 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'ro'), 'x');
  chmodSync(join(dir, 'ro'), 0o400);
  const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  assert.equal(
    nextRenameDelayMs(eperm, 0, join(dir, 'ro'), () => 0),
    null
  );
  assert.equal(
    nextRenameDelayMs(eperm, 0, dir, () => 0),
    25,
    'a folder is waited for'
  );
});

test('the data folder is the one the core uses and versions compare as semver', () => {
  assert.equal(dataDir({ MIXDOG_DATA_DIR: '/d' }, '/h'), '/d');
  assert.equal(dataDir({ MIXDOG_HOME: '/m' }, '/h'), join('/m', 'data'));
  assert.equal(dataDir({}, '/h'), join('/h', '.mixdog', 'data'));
  assert.ok(
    compareSemver('1.5.1', '1.5.0') > 0 &&
      compareSemver('1.5.0', '1.5.0-rc.1') > 0 &&
      compareSemver('1.10.0', '1.9.0') > 0
  );
  assert.equal(compareSemver('v1.5.0', '1.5.0'), 0);
});

test("after a swap the launcher starts the new package's launcher with the guard set; otherwise the native program", () => {
  const plan = launchPlan({
    packageRoot: join('/p', 'node_modules', 'mixdog'),
    swapped: true,
    argv: ['--plain'],
    env: { A: '1' },
    execPath: '/usr/bin/node',
  });
  assert.equal(plan.program, '/usr/bin/node');
  assert.deepEqual(plan.args, [join('/p', 'node_modules', 'mixdog', 'bin', 'mixdog.mjs'), '--plain']);
  assert.deepEqual(plan.env, { A: '1', MIXDOG_SWAP_REEXEC: '1' });
  assert.equal(plan.reexec, true);
  assert.match(
    launchPlan({ packageRoot: join('/nowhere', 'node_modules', 'mixdog'), swapped: false, argv: [] }).error,
    /^mixdog: .*package\.json/
  );
});

test('a re-run that cannot start falls back to the program in place, as 1.4.5 did; any other start failure is an error', async () => {
  const children = [];
  const spawnProcess = (program, args) => {
    const child = new EventEmitter();
    children.push({ program, args, child });
    return child;
  };
  const exits = [];
  let said = '';
  const common = { spawnProcess, exit: (code) => exits.push(code), stderr: { write: (text) => (said += text) } };
  const reexec = { program: 'node', args: ['new/bin/mixdog.mjs'], env: {}, reexec: true };
  const inPlace = { program: '/native/mixdog', args: ['--plain'], env: {}, windowsHide: false };
  startPlan({ plan: reexec, fallback: async () => inPlace, ...common });
  children[0].child.emit('error', new Error('spawn node ENOENT'));
  // The fallback plan settles before the next turn of the event loop.
  await new Promise(setImmediate);
  assert.equal(children.length, 2);
  assert.equal(children[1].program, '/native/mixdog');
  assert.deepEqual(exits, [], 'nothing ended: the run went on in place');
  children[1].child.emit('exit', 7, null);
  assert.deepEqual(exits, [7]);
  // The program in place failing to start is the error, never another fallback.
  startPlan({ plan: inPlace, fallback: () => assert.fail('no fallback'), ...common });
  children[2].child.emit('error', new Error('boom'));
  assert.deepEqual(exits, [7, 1]);
  assert.match(said, /cannot start \/native\/mixdog: boom/);
});
