#!/usr/bin/env node
// Recording of shared/git-launch.test.mjs (b6f10295a): how Node resolves the git it starts. Real git-launch.mjs (resolveGitLaunch,
// gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync), over directory trees built in a temp folder (the file
// layout of each case is part of the recording; every temp root is written <root-N> (N: creation order, one marker per root) wherever it occurs, with the separators Node
// produced: backslashes on win32, which is the platform recorded). The recording is Windows-only where Node's own test is
// (`skip: process.platform !== 'win32'`): on another platform those cases record {skipped}.
// Nothing here runs the machine's git. The two Node cases that ran a real git (the direct binary's environment; the runner's PATH
// fallback) run Node's real launcher, startGit, runGitOffThread and its worker thread, spawnSync, against a controlled install the
// recorder builds: a stand-in executable (lib/git-standin.cs, compiled with the .NET Framework's csc) that records its argv, cwd and
// environment and answers from a script, as the real binary and as the launcher (cmd, bin). Windows adds a few machine variables to
// every child that lacks them, so the recorder gives them all (BASE_ENV) and every environment is recorded and compared whole.
//
//   node benchmarks/rust-core/recorders/record-git-launch-cases.mjs --tree <export of b6f10295a with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { installStandin, standinStarts } from './lib/git-standin.mjs';

const set = openSet('git-launch-cases', import.meta.url);
const { runGitOffThread } = await set.load('src/runtime/shared/git-runner.mjs');
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
// The controlled install: Git for Windows' layout with the stand-in (lib/git-standin.mjs) as the real binary (mingw64/bin) and as
// the launcher (cmd and bin), whose script is what git-wrapper.c does for this layout: MSYSTEM, PLINK_PROTOCOL, and the PATH prefix
// <root>\mingw64\bin;<root>\usr\bin;<HOME>\bin; for the HOME D:\h the cases give.
function controlledInstall() {
  const root = tree(INSTALL);
  const real = join(root, 'Git', 'mingw64', 'bin', 'git.exe');
  const answers = [['dumpenv', 0, '$ENV', ''], ['--version', 0, 'git version 2.50.0.windows.1\n', '']];
  const wrapper = ['SET MSYSTEM=MINGW64', 'SET PLINK_PROTOCOL=ssh', `PREPEND PATH=${join(root, 'Git')}\\mingw64\\bin;${join(root, 'Git')}\\usr\\bin;D:\\h\\bin;`, `EXEC ${real}`];
  installStandin(real, { answers });
  for (const launcher of ['cmd', 'bin']) installStandin(join(root, 'Git', launcher, 'git.exe'), { wrapper });
  return {
    root,
    description: { files: INSTALL, realBinary: 'Git/mingw64/bin/git.exe: stand-in answering', answers, launchers: 'Git/cmd/git.exe and Git/bin/git.exe: stand-in launcher running', wrapper },
    starts: () => ({ launcher: standinStarts(join(root, 'Git', 'cmd', 'git.exe')), real: standinStarts(real) }),
  };
}
// The complete environment base of every started child. Windows adds these variables to any child that lacks them (HOMEDRIVE, HOMEPATH,
// LOGONSERVER, SYSTEMDRIVE, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR), with the values of the machine's user; giving all of them
// leaves nothing machine-dependent in what the child receives, so the environments are recorded and compared as they are.
const BASE_ENV = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\recorder', USERPROFILE: 'C:\\Users\\recorder', USERNAME: 'recorder', USERDOMAIN: 'RECORDING', LOGONSERVER: '\\\\RECORDING', TEMP: 'C:\\Users\\recorder\\AppData\\Local\\Temp' };
// A spawned child's process id and the spawn timings are measurements of this run: they are recorded as text with a marker and declared
// as normalised (the manifest lists the paths): pid:<n> becomes <pid>, ms:<n> becomes <ms>.
const measured = (result) => ({ ...result, pid: `pid:${result.pid}` });
const timingText = (timing) => Object.fromEntries(Object.entries(timing ?? {}).map(([key, value]) => [key, `ms:${value}`]));
const maskTiming = (value) => ({ ...value, timing: timingText(value.timing) });
const maskErrorTiming = (error) => { if (error?.timing) error.timing = timingText(error.timing); return error; };
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
  // `stale` is an install whose git.exe files are empty (they cannot start) and is removed after the first resolution; `fallback` is
  // the controlled install and stays. The real runGitOffThread and its worker thread run the git child.
  const stale = tree(INSTALL);
  const fallback = controlledInstall();
  const env = { ...BASE_ENV, PATH: `${join(stale, 'Git', 'cmd')}${delimiter}${join(fallback.root, 'Git', 'cmd')}` };
  const options = { cwd: stale, env, timeoutMs: 30_000, maxBytes: 1_000_000 };
  const staleCommand = join(stale, 'Git', 'mingw64', 'bin', 'git.exe');
  const first = await runGitOffThread(['--version'], options).then((value) => ({ resolved: maskTiming(value) }), (error) => ({ rejected: maskErrorTiming(error) }));
  rmSync(join(stale, 'Git'), { recursive: true, force: true });
  const afterRemoval = await runGitOffThread(['--version'], options).then((value) => ({ resolved: maskTiming(value) }), (error) => ({ rejected: maskErrorTiming(error) }));
  return { staleFiles: INSTALL, fallback: fallback.description, env, options, staleCommand, first, afterRemoval, standinStarts: fallback.starts() };
}));
await set.run('without a bypass the command and environment are unchanged', () => {
  const emptyDir = tree(['empty/']);
  const env = { PATH: join(emptyDir, 'empty') };
  const plain = { PATH: 'x' };
  return { env, command: gitCommand(env), gitChildEnvOfEnv: gitChildEnv(env), plain, sameEnvObject: gitChildEnv(plain) === plain };
});
await set.run('the direct binary sees the environment the launcher would give it', () => winOnly(() => {
  const fallback = controlledInstall();
  const env = { ...BASE_ENV, PATH: join(fallback.root, 'Git', 'cmd'), HOME: 'D:\\h' };
  const args = ['-c', 'alias.dumpenv=!env', 'dumpenv'];
  const run = (command, childEnv) => { const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, cwd: fallback.root, env: childEnv, timeout: 30_000 }); if (result.error?.code === 'ETIMEDOUT') throw new Error(`the git child ${command}: no answer within 30000 ms`); return measured(result); };
  const viaLauncher = run('git', env);
  const direct = run(gitCommand(env), gitChildEnv(env));
  const lines = (output) => output.split('\n').filter(Boolean).sort();
  const directLines = lines(direct.stdout);
  const launcherLines = lines(viaLauncher.stdout);
  return {
    fallbackInstall: fallback.description, env, args, command: gitCommand(env), launcherEnvironment: gitChildEnv(env), viaLauncher, direct,
    sameLines: JSON.stringify(directLines) === JSON.stringify(launcherLines), onlyDirect: directLines.filter((l) => !launcherLines.includes(l)), onlyLauncher: launcherLines.filter((l) => !directLines.includes(l)),
    standinStarts: fallback.starts(),
  };
}));

await set.finish({
  entry: { runs: 'src/runtime/shared/git-launch.mjs (resolveGitLaunch with an explicit platform and PATH, gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync) over trees of empty files in a temp folder', notRun: 'no real git: the two cases that start processes run against the stand-in install (lib/git-standin.cs); the retry cases pass startGit a scripted start function, as the Node test does', standIn: { source: 'benchmarks/rust-core/recorders/lib/git-standin.cs', sha256: 'listed with the recorder inputs of this manifest (benchmarks/rust-core/recorders/lib/git-standin.cs)', build: 'csc.exe of the .NET Framework 4 (C:/Windows/Microsoft.NET/Framework64/v4.0.30319), one build per run' } },
  replay: { entry: 'mixdog-scm git_launch.rs: rebuild each case\'s tree (files list) in a temp root and compare resolutions, environments, spawned-command sequences and retry counts whole', normalised: { tempRoots: 'every temp root is written <root-N> (N: creation order, one marker per root) wherever it occurs (paths listed in normalised.paths); separators are those Node produced (backslashes, win32)' }, platform: 'recorded on win32 (the Node tests that skip elsewhere ran); the cases that need no Windows layout also run elsewhere' },
  dataFiles: ['benchmarks/rust-core/recorders/lib/git-standin.cs'],
  replaceInText: roots.map((r, i) => [r, `<root-${i + 1}>`]),
  replaceRegex: [[/^pid:\d+$/, '<pid>'], [/^ms:-?[\d.]+(e[+-]?\d+)?$/, '<ms>']],
  normaliseReason: 'every temp root is written <root-N>, N its position in the order the recorder created the roots (each root has its own marker, so the stale and the fallback root stay apart); the process id of a spawned child (spawnSync result.pid) is a measurement of the run, written <pid>; the spawn timings of runChildTimed are written <ms>. Nothing else is normalised: every environment is recorded whole and compared raw.',
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);