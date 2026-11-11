#!/usr/bin/env node
// Recording of shared/git-launch.test.mjs (b6f10295a): how Node resolves the git it starts. Real git-launch.mjs (resolveGitLaunch,
// gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync), over directory trees built in a temp folder (the file
// layout of each case is part of the recording; every temp root is written <root> wherever it occurs, with the separators Node
// produced: backslashes on win32, which is the platform recorded). The recording is Windows-only where Node's own test is
// (`skip: process.platform !== 'win32'`): on another platform those cases record {skipped}.
// Nothing here runs the machine's git. The two Node cases that ran a real git (the direct binary's environment; the runner's PATH
// fallback) are recorded on controlled installs the recorder creates (trees of empty files) with a scripted spawn that records the
// whole launch request (command, args, cwd, environment) and answers as scripted below; git-runner-worker.mjs's body is
// `startGit(request.env, (command, env) => runChildTimed(...))`, which is what these cases call with the scripted spawn.
//
//   node benchmarks/rust-core/recorders/record-git-launch-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('git-launch-cases', import.meta.url);
const { gitChildEnv, gitCommand, gitLaunchEnvironment, resolveGitLaunch, startGit, startGitSync } = await set.load('src/runtime/shared/git-launch.mjs');
const WIN = process.platform === 'win32';
const roots = [];
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-launch-'));
  roots.push(root);
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(file.endsWith('/') ? path : dirname(path), { recursive: true });
    if (!file.endsWith('/')) writeFileSync(path, '');
  }
  return root;
}
const INSTALL = ['Git/cmd/git.exe', 'Git/bin/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/mingw64/bin/git.exe'];
const win = (pathValue) => resolveGitLaunch({ platform: 'win32', pathValue });
const skipped = (reason) => ({ skipped: reason });
const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const winOnly = (fn) => (WIN ? fn() : skipped('Node test skips: process.platform !== win32'));
/** A scripted spawn: records the whole launch request; `answer(command)` is the scripted outcome (a value, or a thrown error). */
const scriptedSpawn = (requests, args, cwd, answer) => (command, childEnv) => { requests.push({ command, args, cwd, childEnv: structuredClone(childEnv) }); return answer(command); };

await set.run('Git for Windows launchers resolve to the real binary of their install', () => winOnly(() => {
  const root = tree(INSTALL);
  const launchers = ['cmd', 'bin'].map((launcher) => ({ pathValue: join(root, 'Git', launcher), launch: win(join(root, 'Git', launcher)) }));
  const armFiles = ['Git/cmd/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/clangarm64/bin/git.exe'];
  const arm = tree(armFiles);
  return { files: INSTALL, launchers, arm: { files: armFiles, pathValue: join(arm, 'Git', 'cmd'), launch: win(join(arm, 'Git', 'cmd')) } };
}));
await set.run('every other git keeps plain `git`', () => winOnly(() => {
  const files = [...INSTALL, 'scoop/shims/git.exe', 'MinGit/cmd/git.exe', 'MinGit/usr/bin/', 'MinGit/mingw64/bin/git.exe', 'Both/cmd/git.exe', 'Both/git-bash.exe', 'Both/usr/bin/', 'Both/mingw64/bin/git.exe', 'Both/clangarm64/bin/git.exe', 'NoUsr/cmd/git.exe', 'NoUsr/git-bash.exe', 'NoUsr/mingw64/bin/git.exe', 'com/git.com'];
  const root = tree(files);
  const install = join(root, 'Git', 'cmd');
  const q = (label, pathValue, platform = 'win32') => ({ label, platform, pathValue, launch: resolveGitLaunch({ platform, pathValue }) });
  return {
    files,
    cases: [
      q('linux', install, 'linux'), q('darwin', install, 'darwin'), q('a scoop shim', join(root, 'scoop', 'shims')), q('MinGit', join(root, 'MinGit', 'cmd')), q('an ambiguous install', join(root, 'Both', 'cmd')),
      q('an incomplete install', join(root, 'NoUsr', 'cmd')), q('already the real binary', join(root, 'Git', 'mingw64', 'bin')), q('no git at all', ''),
      q('git.com first', [join(root, 'com'), install].join(delimiter)), q('a cwd-relative entry first', ['relative', install].join(delimiter)), q('a scoop shim first', [join(root, 'scoop', 'shims'), install].join(delimiter)),
      q('a quoted entry after a miss', [join(root, 'empty'), `"${install}"`].join(delimiter)),
    ],
  };
}));
await set.run('the child environment is the one the launcher builds', () => {
  const root = tree(['home/']);
  const launch = { command: 'C:\\Git\\mingw64\\bin\\git.exe', root: 'C:\\Git', msystem: 'MINGW64', msysConfig: [] };
  const base = { Path: 'C:\\Windows', MSYSTEM: 'MSYS', USERPROFILE: 'C:\\Users\\u' };
  const baseBefore = structuredClone(base);
  const withHomeInput = { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'home') };
  const missingInput = { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'absent') };
  const env = gitLaunchEnvironment(launch, withHomeInput);
  const missing = gitLaunchEnvironment(launch, missingInput);
  const keptIn = { PATH: 'C:\\bin', HOME: 'D:\\h\\', PLINK_PROTOCOL: 'telnet', MSYS: 'noglob' };
  const keptLaunch = { ...launch, msysConfig: ['winsymlinks:nativestrict', 'disable_pcon'] };
  const kept = gitLaunchEnvironment(keptLaunch, keptIn);
  return {
    homeDirectoryExists: 'home/', launch,
    withHomeDir: { input: withHomeInput, env, pathIsUndefined: env.PATH === undefined, callerAfter: base, callerBefore: baseBefore },
    homeMissing: { input: missingInput, env: missing },
    kept: { launch: keptLaunch, input: keptIn, env: kept },
  };
});
await set.run("each environment's own PATH decides the git it starts", () => winOnly(() => {
  const files = [...INSTALL, 'scoop/shims/git.exe'];
  const root = tree(files);
  const install = { PATH: join(root, 'Git', 'cmd') };
  const shim = { Path: join(root, 'scoop', 'shims') };
  const installEnv = gitChildEnv(install);
  const shimEnv = gitChildEnv(shim);
  return {
    files,
    install: { input: install, command: gitCommand(install), childEnv: installEnv },
    shim: { input: shim, command: gitCommand(shim), childEnv: shimEnv, childEnvIsTheSameObject: shimEnv === shim },
  };
}));
await set.run('a resolved binary that is gone is resolved again, and that spawn retried once', () => winOnly(async () => {
  const root = tree(INSTALL);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = join(root, 'Git', 'mingw64', 'bin', 'git.exe');
  const resolvedBefore = gitCommand(env);
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const calls = [];
  const childEnvs = [];
  const result = await startGit(env, async (command, childEnv) => { calls.push({ command, childEnv: structuredClone(childEnv) }); childEnvs.push(childEnv); if (command === binary) throw enoent(); return 'ran'; });
  const afterRetry = gitCommand(env);
  const stale = tree(INSTALL);
  const staleEnv = { PATH: join(stale, 'Git', 'cmd') };
  const staleBinary = gitCommand(staleEnv);
  rmSync(join(stale, 'Git'), { recursive: true, force: true });
  const synced = [];
  const outcome = startGitSync(staleEnv, (command) => { synced.push(command); return command === staleBinary ? { error: enoent() } : { status: 0 }; });
  return {
    files: INSTALL, env, resolvedBefore, uninstalledAfterResolve: true,
    startGit: { result, spawnedCommands: calls, secondChildEnvIsCallerEnv: childEnvs[1] === env, resolutionAfterRetry: afterRetry },
    startGitSync: { staleEnv, outcome, spawnedCommands: synced },
  };
}));
await set.run('only a missing binary retries, and only once', () => winOnly(async () => {
  const root = tree(INSTALL);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = gitCommand(env);
  const run = async (throwing) => { let calls = 0; let outcome; try { await startGit(env, async () => { calls += 1; throw throwing(); }); outcome = { resolved: true }; } catch (e) { outcome = { rejected: e }; } return { calls, outcome }; };
  const missingCwd = await run(enoent);
  const stays = gitCommand(env);
  const denied = await run(() => Object.assign(new Error('denied'), { code: 'EACCES' }));
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const goneAndRetryFails = await run(enoent);
  return { files: INSTALL, env, binary, enoentWithBinaryInPlace: missingCwd, resolutionAfter: stays, otherSpawnFailure: denied, goneAndRetryFails };
}));
await set.run('the git runner falls back to the git PATH names once the resolved one is removed', () => winOnly(async () => {
  // Controlled installs: `stale` is removed after the first resolution; `fallback` stays and answers `git --version` as scripted.
  const stale = tree(INSTALL);
  const fallback = tree(INSTALL);
  const env = { PATH: `${join(stale, 'Git', 'cmd')}${delimiter}${join(fallback, 'Git', 'cmd')}` };
  const staleBinary = gitCommand(env);
  const scripted = { code: 0, stdout: 'git version 2.50.0.windows.1\n', stderr: '' };
  const args = ['--version'];
  const requests = [];
  const first = await startGit(env, scriptedSpawn(requests, args, stale, () => scripted));
  rmSync(join(stale, 'Git'), { recursive: true, force: true });
  const second = await startGit(env, scriptedSpawn(requests, args, stale, (command) => { if (command === staleBinary) throw enoent(); return scripted; }));
  return { files: INSTALL, env, scriptedAnswer: scripted, firstCommand: staleBinary, first, afterRemoval: second, afterRemovalCommand: gitCommand(env), requests };
}));
await set.run('without a bypass the command and environment are unchanged', () => {
  const emptyDir = tree(['empty/']);
  const env = { PATH: join(emptyDir, 'empty') };
  const plain = { PATH: 'x' };
  return { env, command: gitCommand(env), gitChildEnvOfEnv: gitChildEnv(env), plain, sameEnvObject: gitChildEnv(plain) === plain };
});
await set.run('the direct binary sees the environment the launcher would give it', () => winOnly(async () => {
  // The Node test dumped the environment of a real git through the launcher and directly; here the launch request of startGit is recorded.
  const root = tree(INSTALL);
  const env = { PATH: join(root, 'Git', 'cmd'), HOME: 'D:\\h', MSYS: 'noglob' };
  const args = ['-c', 'alias.dumpenv=!env', 'dumpenv'];
  const requests = [];
  const result = await startGit(env, scriptedSpawn(requests, args, root, () => ({ code: 0, stdout: '', stderr: '' })));
  return { files: INSTALL, env, args, command: gitCommand(env), launcherEnvironment: gitChildEnv(env), result, requests };
}));

await set.finish({
  entry: { runs: 'src/runtime/shared/git-launch.mjs (resolveGitLaunch with an explicit platform and PATH, gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync) over trees of empty files in a temp folder', notRun: 'no git is run: startGit/startGitSync get a scripted spawn function that records the launch request; git-runner.mjs runGitOffThread and its worker thread are not run (the worker body is startGit with the real spawn)' },
  replay: { entry: 'mixdog-scm git_launch.rs: rebuild each case\'s tree (files list) in a temp root and compare resolutions, environments, spawned-command sequences and retry counts whole', normalised: { tempRoots: 'every temp root is written <root> wherever it occurs (paths listed in normalised.paths); separators are those Node produced (backslashes, win32)' }, platform: 'recorded on win32 (the Node tests that skip elsewhere ran); the cases that need no Windows layout also run elsewhere' },
  replaceInText: roots.map((r) => [r, '<root>']),
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);