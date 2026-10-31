// dev-fast-snapshot.ps1's sweep of snapshot worktrees an earlier deploy left
// (the app restart kills the script before its own cleanup). It runs here on
// a copy inside a throwaway repository, never against this checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'dev-fast-snapshot.ps1');
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const registered = (repo) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9).replaceAll('/', '\\').toLowerCase());
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const icacls = (...args) => execFileSync('icacls', args, { windowsHide: true, stdio: 'ignore' });
// `npm run update:dev:fast` runs it with Windows PowerShell; pwsh runs it too when that is the shell at hand.
const SHELLS = ['powershell.exe', 'pwsh.exe'].map((exe) => ({
  exe,
  missing:
    process.platform !== 'win32'
      ? 'PowerShell deploy script (Windows only)'
      : spawnSync('where', [exe], { windowsHide: true }).status !== 0 && `${exe} is not installed`,
}));

/** A throwaway repository with a copy of the script and a real dependency tree its snapshots link to. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-snapsweep-'));
  const cleanups = [];
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'apps', 'desktop', 'scripts'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Mixdog Test');
  git(repo, 'config', 'user.email', 'mixdog@example.com');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'initial');
  const copy = join(repo, 'apps', 'desktop', 'scripts', 'dev-fast-snapshot.ps1');
  copyFileSync(script, copy);
  const modules = join(repo, 'node_modules');
  mkdirSync(join(modules, 'dep'), { recursive: true });
  writeFileSync(join(modules, 'dep', 'keep.txt'), 'keep\n');
  // A workspace link inside the real tree: never reached through a snapshot's junction.
  mkdirSync(join(repo, 'packages', 'local'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'local', 'index.js'), 'export {};\n');
  symlinkSync(join(repo, 'packages', 'local'), join(modules, 'local'), 'junction');
  const snapshot = (name) => {
    const path = join(root, 'other-temp', name);
    git(repo, 'worktree', 'add', '-q', '--detach', path);
    symlinkSync(modules, join(path, 'node_modules'), 'junction');
    return path;
  };
  const run = (exe) => {
    const currentTemp = mkdtempSync(join(root, 'current-temp-'));
    return spawnSync(exe, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, '-CleanupOnly'], {
      cwd: repo,
      env: { ...process.env, TEMP: currentTemp, TMP: currentTemp },
      windowsHide: true,
      encoding: 'utf8',
    });
  };
  const realTreeIntact = () =>
    existsSync(join(modules, 'dep', 'keep.txt')) &&
    present(join(modules, 'local')) &&
    existsSync(join(repo, 'packages', 'local', 'index.js'));
  return { root, repo, modules, snapshot, run, realTreeIntact, cleanups };
}

for (const { exe, missing } of SHELLS) {
  test(`${exe}: the cleanup sweeps snapshots outside this TEMP, unlinking live and dangling junctions first`, {
    skip: missing,
  }, (t) => {
    const { root, repo, snapshot, run, realTreeIntact } = fixture(t);
    // Left by a run whose TEMP was another folder (a session scratch dir).
    const left = snapshot('mxsnap-0a1b2c3d');
    // A partly torn-down link: its target is already gone.
    const gone = join(root, 'gone-cache');
    mkdirSync(gone);
    mkdirSync(join(left, 'apps', 'desktop'), { recursive: true });
    symlinkSync(gone, join(left, 'apps', 'desktop', '.cache'), 'junction');
    rmSync(gone, { recursive: true });
    // A snapshot registration whose folder is already gone, and a worktree that is no snapshot.
    const vanished = join(root, 'other-temp', 'mxsnap-deadbeef');
    git(repo, 'worktree', 'add', '-q', '--detach', vanished);
    rmSync(vanished, { recursive: true, force: true });
    const keeper = join(root, 'elsewhere', 'feature');
    git(repo, 'worktree', 'add', '-q', '--detach', keeper);

    const result = run(exe);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(present(left), false, 'the snapshot folder is gone');
    assert.ok(realTreeIntact(), 'the linked dependency tree and its own links are untouched');
    assert.ok(existsSync(keeper), 'a worktree that is not a snapshot stays');
    const rows = registered(repo);
    assert.equal(rows.length, 2, rows.join(', '));
    assert.ok(rows.some((path) => path.endsWith('\\elsewhere\\feature')));
  });

  test(`${exe}: a snapshot whose junction cannot be unlinked is skipped and reported, nothing of it deleted`, {
    skip: missing,
  }, (t) => {
    const { repo, snapshot, run, realTreeIntact, cleanups } = fixture(t);
    const stuck = snapshot('mxsnap-5ca1ab1e');
    const clean = snapshot('mxsnap-c1ea0000');
    const link = join(stuck, 'node_modules');
    // Neither the link itself nor its folder lets it be deleted.
    icacls(link, '/deny', '*S-1-1-0:(DE)', '/L');
    cleanups.push(() => icacls(link, '/remove:d', '*S-1-1-0', '/L'));
    icacls(stuck, '/deny', '*S-1-1-0:(DC)');
    cleanups.push(() => icacls(stuck, '/remove:d', '*S-1-1-0'));

    const result = run(exe);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Skipped .*mxsnap-5ca1ab1e.*could not unlink/s);
    assert.ok(present(link), 'the junction is still there');
    assert.ok(existsSync(join(stuck, 'README.md')), 'no file of the skipped snapshot was deleted');
    assert.ok(realTreeIntact(), 'the dependency tree behind it is untouched');
    assert.ok(
      registered(repo).some((path) => path.endsWith('\\mxsnap-5ca1ab1e')),
      'the skipped snapshot stays registered'
    );
    // The other snapshot of the same sweep still goes.
    assert.equal(present(clean), false);
  });
}
