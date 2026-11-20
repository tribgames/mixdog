// The swap half of the staged update of an npm install (bin/staged-swap.mjs) and the launcher's use of it (bin/mixdog.mjs,
// bin/invocation.mjs), against 1.4.5's cli.mjs and staged-update.mjs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { skipsHostPrelude } from '../bin/invocation.mjs';
import { launchPlan, startPlan, swapBeforeLaunch } from '../bin/mixdog.mjs';
import {
  compareSemver,
  dataDir,
  nextRenameDelayMs,
  packageComplete,
  performPendingSwap,
  renameWithRetry,
} from '../bin/staged-swap.mjs';

const HOST = { platform: 'linux', arch: 'x64' };
const PROGRAMS = ['mixdog', 'mixdogd', 'mixdog-askpass'];

/** The platform package of the test host in `folder` (a `node_modules/mixdog-linux-x64`). */
const writePlatform = (folder, text, programs = PROGRAMS) => {
  mkdirSync(join(folder, 'bin'), { recursive: true });
  writeFileSync(join(folder, 'package.json'), '{}');
  for (const program of programs) writeFileSync(join(folder, 'bin', program), text);
};

const writePackage = (dir, version) => {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mixdog', version }));
  writeFileSync(join(dir, 'bin', 'mixdog.mjs'), `// ${version}\n`);
  writeFileSync(join(dir, 'bin', 'native-layout.mjs'), '');
};

/**
 * An npm global prefix with mixdog at `installed` (its platform package hoisted beside it), a data folder, and the staging of
 * the versions in `staged`, each self-contained with its platform package nested; `damage(version, pkgDir)` spoils one.
 */
const rig = ({ installed = '1.5.0', staged = [], layout = ['node_modules', 'mixdog'], damage } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-swap-test-'));
  const packageRoot = join(root, ...layout);
  writePackage(packageRoot, installed);
  writePlatform(join(packageRoot, '..', 'mixdog-linux-x64'), `program ${installed}`);
  const data = join(root, 'data');
  for (const version of staged) {
    const verDir = join(data, 'staging', version);
    const pkgDir = join(verDir, 'mixdog');
    writePackage(pkgDir, version);
    writePlatform(join(pkgDir, 'node_modules', 'mixdog-linux-x64'), `program ${version}`);
    damage?.(version, pkgDir);
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

test('a completed staged version newer than the installed one replaces the package, dependencies with it, and is cleaned away', (t) => {
  const r = rig({ staged: ['1.5.1'] });
  cleanup(t, r);
  assert.equal(r.swap(), true);
  assert.equal(r.version(), '1.5.1');
  assert.equal(
    readFileSync(join(r.packageRoot, 'node_modules', 'mixdog-linux-x64', 'bin', 'mixdog'), 'utf8'),
    'program 1.5.1'
  );
  assert.deepEqual(
    readdirSync(join(r.packageRoot, '..')).sort(),
    ['mixdog', 'mixdog-linux-x64'],
    'no backup is left beside the package'
  );
  assert.deepEqual(r.staging(), [], 'the staged folder moved into place and the lock is gone');
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

test('a staged package that cannot run on this host never replaces the install, and the working install and its backup stay', (t) => {
  const damages = {
    'no platform package': (_v, pkg) => rmSync(join(pkg, 'node_modules'), { recursive: true }),
    'a program missing from it': (_v, pkg) => rmSync(join(pkg, 'node_modules', 'mixdog-linux-x64', 'bin', 'mixdogd')),
    'the core missing from it': (_v, pkg) =>
      rmSync(join(pkg, 'node_modules', 'mixdog-linux-x64', 'bin', 'mixdog-askpass')),
    'only the platform package of another host': (_v, pkg) => {
      rmSync(join(pkg, 'node_modules'), { recursive: true });
      writePlatform(join(pkg, 'node_modules', 'mixdog-darwin-arm64'), 'x');
    },
    'no launcher': (_v, pkg) => rmSync(join(pkg, 'bin', 'mixdog.mjs')),
    'no layout module': (_v, pkg) => rmSync(join(pkg, 'bin', 'native-layout.mjs')),
  };
  for (const [what, damage] of Object.entries(damages)) {
    const r = rig({ staged: ['1.5.1'], damage });
    cleanup(t, r);
    assert.equal(r.swap(), false, what);
    assert.equal(r.version(), '1.5.0', what);
    assert.equal(
      readFileSync(join(r.packageRoot, '..', 'mixdog-linux-x64', 'bin', 'mixdog'), 'utf8'),
      'program 1.5.0',
      what
    );
    assert.deepEqual(readdirSync(join(r.packageRoot, '..')).sort(), ['mixdog', 'mixdog-linux-x64'], what);
  }
  assert.equal(
    packageComplete(join(rig({ staged: [] }).packageRoot), HOST),
    true,
    'the installed package, platform package beside it, is complete'
  );
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
  assert.deepEqual(
    readdirSync(join(r.packageRoot, '..')).sort(),
    ['mixdog', 'mixdog-linux-x64'],
    'neither the backup nor the rejected package is left'
  );
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

test('a rename is retried as 1.4.5 retried it: about 4.2 s of pauses with jitter, and only for the transient refusals', () => {
  const refuse = (code) => Object.assign(new Error(code), { code });
  // Every attempt refused: 23 pauses, 25 + 50 + 100 + 20 x 200 ms with no jitter, then the refusal itself.
  const pauses = [];
  assert.throws(
    () =>
      renameWithRetry('a', 'b', {
        rename: () => {
          throw refuse('EBUSY');
        },
        sleep: (ms) => pauses.push(ms),
        random: () => 0,
      }),
    { code: 'EBUSY' }
  );
  assert.equal(pauses.length, 23);
  assert.equal(
    pauses.reduce((sum, ms) => sum + ms, 0),
    4175
  );
  assert.deepEqual(pauses.slice(0, 4), [25, 50, 100, 200]);
  // Jitter is under min(50, pause) on top of the pause.
  const jittered = [];
  assert.throws(() =>
    renameWithRetry('a', 'b', {
      rename: () => {
        throw refuse('EPERM');
      },
      sleep: (ms) => jittered.push(ms),
      random: () => 0.999,
    })
  );
  assert.deepEqual(jittered.slice(0, 3), [25 + 24, 50 + 49, 100 + 49]);
  assert.ok(jittered.every((ms, i) => ms >= pauses[i] && ms < pauses[i] + 50));
  // Anything else is not waited for.
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
  // A transient refusal that clears lands the rename.
  let calls = 0;
  renameWithRetry('a', 'b', {
    rename: () => {
      if (++calls < 3) throw refuse('EACCES');
    },
    sleep: () => {},
  });
  assert.equal(calls, 3);
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
    /no program to start/
  );
});

test('a re-run that cannot start falls back to the program in place, as 1.4.5 did; any other start failure is an error', () => {
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
  startPlan({ plan: reexec, fallback: () => inPlace, ...common });
  children[0].child.emit('error', new Error('spawn node ENOENT'));
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
