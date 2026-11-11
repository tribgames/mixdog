#!/usr/bin/env node
// Recording of shared/git-launch.test.mjs (b6f10295a): how Node resolves the git it starts. Real git-launch.mjs (resolveGitLaunch,
// gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync) and git-runner.mjs runGitOffThread, over directory trees
// built in a temp folder (the file layout of each case is part of the recording; every path in the results is relative to the temp
// root, written <root>). The recording is Windows-only where Node's own test is (`skip: process.platform !== 'win32'`): on another
// platform those cases record {skipped}. The two "real install" cases record the outcomes on the recording machine's own git.
//
//   node benchmarks/rust-core/recorders/record-git-launch-cases.mjs --tree <export of b6f10295a with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('git-launch-cases', import.meta.url);
const { gitChildEnv, gitCommand, gitLaunchEnvironment, resolveGitLaunch, startGit, startGitSync } = await set.load('src/runtime/shared/git-launch.mjs');
const { runGitOffThread } = await set.load('src/runtime/shared/git-runner.mjs');
const WIN = process.platform === 'win32';
const roots = [];
const failure = (e) => ({ name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e) });
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
/** A path under `root` as a recording string (`<root>/…`, forward slashes), anything else as is. */
const rel = (root) => (value) => (typeof value === 'string' && value.startsWith(root) ? `<root>/${value.slice(root.length + 1).replaceAll('\\', '/')}`.replace(/\/$/, '') : value);
const launchView = (root, launch) => (launch === null ? null : { command: rel(root)(launch.command), root: rel(root)(launch.root), msystem: launch.msystem, msysConfig: launch.msysConfig ?? null, keys: Object.keys(launch).sort() });
const INSTALL = ['Git/cmd/git.exe', 'Git/bin/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/mingw64/bin/git.exe'];
const win = (pathValue) => resolveGitLaunch({ platform: 'win32', pathValue });
const skipped = (reason) => ({ skipped: reason });
const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const winOnly = (fn) => (WIN ? fn() : skipped('Node test skips: process.platform !== win32'));

await set.run('Git for Windows launchers resolve to the real binary of their install', () => winOnly(() => {
  const root = tree(INSTALL);
  const r = rel(root);
  const launchers = ['cmd', 'bin'].map((launcher) => ({ pathValue: `<root>/Git/${launcher}`, launch: launchView(root, win(join(root, 'Git', launcher))) }));
  const armFiles = ['Git/cmd/git.exe', 'Git/git-bash.exe', 'Git/usr/bin/', 'Git/clangarm64/bin/git.exe'];
  const arm = tree(armFiles);
  return { files: INSTALL, launchers, arm: { files: armFiles, launch: launchView(arm, win(join(arm, 'Git', 'cmd'))) }, r: r(root) === '<root>' };
}));
await set.run('every other git keeps plain `git`', () => winOnly(() => {
  const files = [...INSTALL, 'scoop/shims/git.exe', 'MinGit/cmd/git.exe', 'MinGit/usr/bin/', 'MinGit/mingw64/bin/git.exe', 'Both/cmd/git.exe', 'Both/git-bash.exe', 'Both/usr/bin/', 'Both/mingw64/bin/git.exe', 'Both/clangarm64/bin/git.exe', 'NoUsr/cmd/git.exe', 'NoUsr/git-bash.exe', 'NoUsr/mingw64/bin/git.exe', 'com/git.com'];
  const root = tree(files);
  const install = join(root, 'Git', 'cmd');
  const answer = (platform, pathValue) => launchView(root, resolveGitLaunch({ platform, pathValue }));
  const q = (label, pathValue, platform = 'win32') => ({ label, platform, pathValue: pathValue.replaceAll(root, '<root>').replaceAll('\\', '/'), launch: answer(platform, pathValue) });
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
  const norm = (value) => JSON.parse(JSON.stringify(value).replaceAll(root.replaceAll('\\', '\\\\'), '<root>'));
  const env = gitLaunchEnvironment(launch, { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'home') });
  const missing = gitLaunchEnvironment(launch, { ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'absent') });
  const keptIn = { PATH: 'C:\\bin', HOME: 'D:\\h\\', PLINK_PROTOCOL: 'telnet', MSYS: 'noglob' };
  const kept = gitLaunchEnvironment({ ...launch, msysConfig: ['winsymlinks:nativestrict', 'disable_pcon'] }, keptIn);
  return {
    homeDirectoryExists: 'home/', launch,
    withHomeDir: { input: norm({ ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'home') }), env: norm(env), pathUndefined: env.PATH === undefined, callerUnchanged: JSON.stringify(base) === JSON.stringify(baseBefore) },
    homeMissing: { input: norm({ ...base, HOMEDRIVE: '', HOMEPATH: join(root, 'absent') }), env: norm(missing) },
    kept: { launch: { ...launch, msysConfig: ['winsymlinks:nativestrict', 'disable_pcon'] }, input: keptIn, env: kept },
  };
});
await set.run("each environment's own PATH decides the git it starts", () => winOnly(() => {
  const files = [...INSTALL, 'scoop/shims/git.exe'];
  const root = tree(files);
  const r = rel(root);
  const install = { PATH: join(root, 'Git', 'cmd') };
  const shim = { Path: join(root, 'scoop', 'shims') };
  const installEnv = gitChildEnv(install);
  const shimEnv = gitChildEnv(shim);
  return {
    files,
    install: { pathValue: '<root>/Git/cmd', command: r(gitCommand(install)), childPathStartsWithMingwBin: installEnv.PATH.startsWith(`${join(root, 'Git', 'mingw64', 'bin')};`), childPathHead: installEnv.PATH.split(';').slice(0, 3).map(r) },
    shim: { pathValue: '<root>/scoop/shims', command: gitCommand(shim), childEnvIsTheSameObject: shimEnv === shim },
  };
}));
await set.run('a resolved binary that is gone is resolved again, and that spawn retried once', () => winOnly(async () => {
  const root = tree(INSTALL);
  const r = rel(root);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = join(root, 'Git', 'mingw64', 'bin', 'git.exe');
  const resolvedBefore = r(gitCommand(env));
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const calls = [];
  const result = await startGit(env, async (command, childEnv) => { calls.push({ command, childEnv }); if (command === binary) throw enoent(); return 'ran'; });
  const afterRetry = r(gitCommand(env));
  const stale = tree(INSTALL);
  const sr = rel(stale);
  const staleEnv = { PATH: join(stale, 'Git', 'cmd') };
  const staleBinary = gitCommand(staleEnv);
  rmSync(join(stale, 'Git'), { recursive: true, force: true });
  const synced = [];
  const outcome = startGitSync(staleEnv, (command) => { synced.push(command); return command === staleBinary ? { error: enoent() } : { status: 0 }; });
  return {
    files: INSTALL, resolvedBefore, uninstalledAfterResolve: true,
    startGit: { result, spawnedCommands: calls.map((c) => r(c.command)), secondChildEnvIsCallerEnv: calls[1].childEnv === env, resolutionAfterRetry: afterRetry },
    startGitSync: { outcome, spawnedCommands: synced.map(sr) },
  };
}));
await set.run('only a missing binary retries, and only once', () => winOnly(async () => {
  const root = tree(INSTALL);
  const r = rel(root);
  const env = { PATH: join(root, 'Git', 'cmd') };
  const binary = gitCommand(env);
  const run = async (throwing) => { let calls = 0; let outcome; try { await startGit(env, async () => { calls += 1; throw throwing(); }); outcome = { resolved: true }; } catch (e) { outcome = { rejected: failure(e) }; } return { calls, outcome }; };
  const missingCwd = await run(enoent);
  const stays = r(gitCommand(env)) === r(binary);
  const denied = await run(() => Object.assign(new Error('denied'), { code: 'EACCES' }));
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const goneAndRetryFails = await run(enoent);
  return { files: INSTALL, enoentWithBinaryInPlace: missingCwd, resolutionStays: stays, otherSpawnFailure: denied, goneAndRetryFails };
}));
await set.run('the git runner falls back to the git PATH names once the resolved one is removed', async () => {
  const skip = gitCommand() === 'git';
  if (skip) return skipped('Node test skips: gitCommand() === git (no Git for Windows launcher on PATH on the recording machine)');
  const real = resolveGitLaunch();
  const root = tree(INSTALL);
  const env = { ...process.env, PATH: `${join(root, 'Git', 'cmd')}${delimiter}${join(real.root, 'cmd')}` };
  delete env.Path;
  const options = { cwd: root, env, timeoutMs: 30_000, maxBytes: 1_000_000 };
  const first = await runGitOffThread(['--version'], options).then((r) => ({ code: r.code }), (e) => ({ rejected: failure(e) }));
  rmSync(join(root, 'Git'), { recursive: true, force: true });
  const result = await runGitOffThread(['--version'], options);
  return { files: INSTALL, staleInstallResolvedFirst: first, afterRemoval: { code: result.code, stdoutStartsWithGitVersion: /^git version /.test(result.stdout), stderr: result.stderr }, note: 'depends on the recording machine\'s own Git for Windows install (stdout is not recorded)' };
});
await set.run('without a bypass the command and environment are unchanged', () => {
  if (gitCommand() !== 'git') return skipped('Node test skips: gitCommand() !== git (a Git for Windows launcher is on PATH on the recording machine)');
  const env = { PATH: 'x' };
  return { gitChildEnvOfNothing: gitChildEnv(), sameEnvObject: gitChildEnv(env) === env };
});
await set.run('the direct binary sees the environment the launcher would give it', () => {
  if (gitCommand() === 'git') return skipped('Node test skips: gitCommand() === git');
  const args = ['-c', 'alias.dumpenv=!env', 'dumpenv'];
  const viaLauncher = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  const direct = spawnSync(gitCommand(), args, { encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
  const lines = (output) => output.split('\n').filter(Boolean).sort();
  return { args, launcherStatus: viaLauncher.status, directStatus: direct.status, sameVariablesAndValues: JSON.stringify(lines(direct.stdout)) === JSON.stringify(lines(viaLauncher.stdout)), variableCount: lines(direct.stdout).length, note: 'depends on the recording machine\'s own install; the environment lines are not recorded (they hold the machine\'s variables)' };
});

await set.finish({
  entry: { runs: 'src/runtime/shared/git-launch.mjs (resolveGitLaunch with an explicit platform and PATH, gitLaunchEnvironment, gitCommand, gitChildEnv, startGit, startGitSync) and git-runner.mjs runGitOffThread over trees of empty files in a temp folder', notRun: 'startGit/startGitSync get a scripted spawn function; git is run for real only in the two real-install cases' },
  replay: { entry: 'mixdog-scm git_launch.rs: rebuild each case\'s tree (files list) in a temp root and compare resolutions, environments, spawned-command sequences and retry counts whole (paths relative to <root>)', normalised: { tempRoots: 'every temp root is <root>; a scripted-spawn case records commands relative to <root>' }, platform: 'recorded on win32 (the Node tests that skip elsewhere ran); the cases that need no Windows layout also run elsewhere' },
  replaceInText: roots.map((r) => [r, '<root>']),
  replaceRegex: [[/<tmp>/g, '<tmp>']],
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
