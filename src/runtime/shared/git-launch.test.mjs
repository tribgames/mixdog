import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import {
  gitChildEnv,
  gitCommand,
  gitLaunchEnvironment,
  resolveGitLaunch,
  startGit,
  startGitSync,
} from './git-launch.mjs';
import { runGitOffThread } from './git-runner.mjs';

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(file.endsWith('/') ? path : dirname(path), { recursive: true });
    if (!file.endsWith('/')) writeFileSync(path, '');
  }
  return root;
}

const INSTALL = ['Git/cmd/git.exe', 'Git/bin/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/mingw64/bin/git.exe'];
const win = (pathValue) => resolveGitLaunch({ platform: 'win32', pathValue });

test('Git for Windows launchers resolve to the real binary of their install', { skip: process.platform !== 'win32' }, (t) => {
  const root = tree(t, INSTALL);
  for (const launcher of ['cmd', 'bin']) {
    const launch = win(join(root, 'Git', launcher));
    assert.equal(launch.command, join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    assert.equal(launch.root, join(root, 'Git'));
    assert.equal(launch.msystem, 'MINGW64');
  }
  const arm = tree(t, ['Git/cmd/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/clangarm64/bin/git.exe']);
  assert.equal(win(join(arm, 'Git', 'cmd')).msystem, 'CLANGARM64');
});

test('every other git keeps plain `git`', { skip: process.platform !== 'win32' }, (t) => {
  const root = tree(t, [
    ...INSTALL,
    'scoop/shims/git.exe',
    'MinGit/cmd/git.exe',
    'MinGit/usr/bin/',
    'MinGit/mingw64/bin/git.exe',
    'Both/cmd/git.exe',
    'Both/git-bash.exe',
    'Both/usr/bin/',
    'Both/mingw64/bin/git.exe',
    'Both/clangarm64/bin/git.exe',
    'NoUsr/cmd/git.exe',
    'NoUsr/git-bash.exe',
    'NoUsr/mingw64/bin/git.exe',
    'com/git.com',
  ]);
  const install = join(root, 'Git', 'cmd');
  assert.equal(resolveGitLaunch({ platform: 'linux', pathValue: install }), null);
  assert.equal(resolveGitLaunch({ platform: 'darwin', pathValue: install }), null);
  assert.equal(win(join(root, 'scoop', 'shims')), null, 'a scoop shim');
  assert.equal(win(join(root, 'MinGit', 'cmd')), null, 'MinGit');
  assert.equal(win(join(root, 'Both', 'cmd')), null, 'an ambiguous install');
  assert.equal(win(join(root, 'NoUsr', 'cmd')), null, 'an incomplete install');
  assert.equal(win(join(root, 'Git', 'mingw64', 'bin')), null, 'already the real binary');
  assert.equal(win(''), null, 'no git at all');
  // PATH order decides, as it does for the spawn: an earlier git wins.
  assert.equal(win([join(root, 'com'), install].join(delimiter)), null, 'git.com first');
  assert.equal(win(['relative', install].join(delimiter)), null, 'a cwd-relative entry first');
  assert.equal(win([join(root, 'scoop', 'shims'), install].join(delimiter)), null);
  assert.ok(win([join(root, 'empty'), `"${install}"`].join(delimiter)), 'a quoted entry after a miss');
});

test('the child environment is the one the launcher builds', (t) => {
  const root = tree(t, ['home/']);
  const launch = { command: 'C:\\Git\\mingw64\\bin\\git.exe', root: 'C:\\Git', msystem: 'MINGW64', msysConfig: [] };
  const base = { Path: 'C:\\Windows', MSYSTEM: 'MSYS', USERPROFILE: 'C:\\Users\\u' };

  const env = gitLaunchEnvironment(launch, { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'home') });
  assert.equal(env.MSYSTEM, 'MINGW64', 'MSYSTEM is always set');
  assert.equal(env.PLINK_PROTOCOL, 'ssh');
  assert.equal(env.HOME, join(root, 'home'), 'HOMEDRIVE+HOMEPATH when it is a directory');
  assert.equal(env.Path, `C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;${join(root, 'home')}\\bin;C:\\Windows`);
  assert.equal(env.PATH, undefined, 'PATH is written under the spelling the child receives');
  assert.equal(base.MSYSTEM, 'MSYS', 'the caller environment is not modified');

  const missing = gitLaunchEnvironment(launch, { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'absent') });
  assert.equal(missing.HOME, 'C:\\Users\\u', 'USERPROFILE otherwise');

  const kept = gitLaunchEnvironment(
    { ...launch, msysConfig: ['winsymlinks:nativestrict', 'disable_pcon'] },
    { PATH: 'C:\\bin', HOME: 'D:\\h\\', PLINK_PROTOCOL: 'telnet', MSYS: 'noglob' }
  );
  assert.equal(kept.HOME, 'D:\\h\\', 'an existing HOME is kept');
  assert.equal(kept.PLINK_PROTOCOL, 'telnet', 'an existing PLINK_PROTOCOL is kept');
  assert.equal(kept.PATH, 'C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;D:\\h\\bin;C:\\bin');
  assert.equal(kept.MSYS, 'disable_pcon winsymlinks:nativestrict noglob', 'git-bash.config MSYS= lines are prepended');
});

test("each environment's own PATH decides the git it starts", { skip: process.platform !== 'win32' }, (t) => {
  const root = tree(t, [...INSTALL, 'scoop/shims/git.exe']);
  const install = { PATH: join(root, 'Git', 'cmd') };
  assert.equal(gitCommand(install), join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
  assert.ok(gitChildEnv(install).PATH.startsWith(`${join(root, 'Git', 'mingw64', 'bin')};`));
  const shim = { Path: join(root, 'scoop', 'shims') };
  assert.equal(gitCommand(shim), 'git', 'a PATH naming another git keeps plain `git`');
  assert.equal(gitChildEnv(shim), shim, 'and its environment unchanged');
});

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

test('a resolved binary that is gone is resolved again, and that spawn retried once', { skip: process.platform !== 'win32' }, async (t) => {
  const root = tree(t, INSTALL);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = join(root, 'Git', 'mingw64', 'bin', 'git.exe');
  assert.equal(gitCommand(env), binary);
  rmSync(join(root, 'Git'), { recursive: true, force: true }); // uninstalled

  const calls = [];
  const result = await startGit(env, async (command, childEnv) => {
    calls.push({ command, childEnv });
    if (command === binary) throw enoent();
    return 'ran';
  });
  assert.equal(result, 'ran');
  assert.deepEqual(calls.map((call) => call.command), [binary, 'git'], 'the fresh resolution is plain `git`');
  assert.equal(calls[1].childEnv, env, "with the caller's environment, as before");
  assert.equal(gitCommand(env), 'git', 'the stale resolution is gone for later spawns');

  // Settled outcomes (spawnSync, runProcess) name their spawn error instead.
  const synced = [];
  const stale = tree(t, INSTALL);
  const staleEnv = { PATH: join(stale, 'Git', 'cmd') };
  const staleBinary = gitCommand(staleEnv);
  rmSync(join(stale, 'Git'), { recursive: true, force: true });
  const outcome = startGitSync(staleEnv, (command) => {
    synced.push(command);
    return command === staleBinary ? { error: enoent() } : { status: 0 };
  });
  assert.deepEqual(outcome, { status: 0 });
  assert.deepEqual(synced, [staleBinary, 'git']);
});

test('only a missing binary retries, and only once', { skip: process.platform !== 'win32' }, async (t) => {
  const root = tree(t, INSTALL);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = gitCommand(env);

  // ENOENT with the binary in place is a missing cwd: no retry, same error.
  let calls = 0;
  await assert.rejects(
    startGit(env, async () => {
      calls += 1;
      throw enoent();
    }),
    { code: 'ENOENT' }
  );
  assert.equal(calls, 1);
  assert.equal(gitCommand(env), binary, 'the resolution stays');

  // Any other spawn failure: no retry.
  calls = 0;
  await assert.rejects(
    startGit(env, async () => {
      calls += 1;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }),
    { code: 'EACCES' }
  );
  assert.equal(calls, 1);

  // Gone, and the retry fails too: that failure is the answer.
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  calls = 0;
  await assert.rejects(
    startGit(env, async () => {
      calls += 1;
      throw enoent();
    }),
    { code: 'ENOENT' }
  );
  assert.equal(calls, 2);
});

// The real install behind a stale one: the shared runner's worker resolved a
// Git that was then uninstalled, and the next git child runs the one PATH names now.
test('the git runner falls back to the git PATH names once the resolved one is removed', { skip: gitCommand() === 'git' }, async (t) => {
  const real = resolveGitLaunch();
  const root = tree(t, INSTALL);
  const env = { ...process.env, PATH: `${join(root, 'Git', 'cmd')}${delimiter}${join(real.root, 'cmd')}` };
  delete env.Path;
  const options = { cwd: root, env, timeoutMs: 30_000, maxBytes: 1_000_000 };
  // Resolves the stale install (its git.exe is an empty file and cannot start).
  await runGitOffThread(['--version'], options).catch(() => {});
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const result = await runGitOffThread(['--version'], options);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^git version /);
});

test('without a bypass the command and environment are unchanged', { skip: gitCommand() !== 'git' }, () => {
  assert.equal(gitChildEnv(), null);
  const env = { PATH: 'x' };
  assert.equal(gitChildEnv(env), env);
});

// The real install on this machine: the environment a git child sees through
// the launcher and through the direct binary is the same, variable for variable.
test('the direct binary sees the environment the launcher would give it', { skip: gitCommand() === 'git' }, () => {
  const args = ['-c', 'alias.dumpenv=!env', 'dumpenv'];
  const viaLauncher = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  const direct = spawnSync(gitCommand(), args, { encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
  assert.equal(viaLauncher.status, 0, viaLauncher.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  const lines = (output) => output.split('\n').filter(Boolean).sort();
  assert.deepEqual(lines(direct.stdout), lines(viaLauncher.stdout));
});
