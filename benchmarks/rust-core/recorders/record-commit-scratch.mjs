#!/usr/bin/env node
// Golden of the commit scratch sweep (`native/core/fixtures/commit-scratch/golden.json`): real Node
// `gitCommitPaths` (`git-commit-transaction.ts`, `sweepScratchIndexes`) runs a commit in a temp
// repository while the OS temp folder (TMPDIR/TEMP/TMP pointed at an isolated folder) holds seeded
// `mixdog-commit-*` entries. Recorded: the seeded entries (kind, age) and which of them the commit left
// behind. `<self>` stands for the recording process's pid, `<dead>` for a pid no process has.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//     benchmarks/rust-core/recorders/record-commit-scratch.mjs --tree <tree>
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-commit-scratch-rec-'));
const temp = join(home, 'tmp');
mkdirSync(temp, { recursive: true });
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(home, dir), { recursive: true });
  process.env[name] = join(home, dir);
}
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = join(home, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = temp;
const { gitCommitPaths } = await import(pathToFileURL(join(repo, 'apps/desktop/src/main/git-cli.ts')).href);

const DEAD = 2147483646;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// [name template, kind, age in ms (0: just made)]
const SEEDS = [
  [`mixdog-commit-<dead>-orphan`, 'dir', 0],
  [`mixdog-commit-<dead>-file`, 'file', 0],
  [`mixdog-commit-+<dead>-plus`, 'dir', 0],
  [`mixdog-commit-<dead>`, 'dir', 0],
  [`mixdog-commit-<self>-live`, 'dir', 0],
  [`mixdog-commit-<self>-slow`, 'file', 3 * DAY],
  [`mixdog-commit-abc-old`, 'file', 2 * HOUR],
  [`mixdog-commit-abc-fresh`, 'file', 0],
  [`mixdog-commit--old`, 'file', 2 * HOUR],
  [`mixdog-commit-0-old`, 'file', 2 * HOUR],
  [`mixdog-commit-0-fresh`, 'file', 0],
  [`mixdog-other-<dead>-old`, 'file', 3 * DAY],
  [`unrelated`, 'dir', 3 * DAY],
];
const fill = (name) => name.replaceAll('<dead>', String(DEAD)).replaceAll('<self>', String(process.pid));
for (const [template, kind, age] of SEEDS) {
  const path = join(temp, fill(template));
  if (kind === 'dir') {
    mkdirSync(path);
    writeFileSync(join(path, 'commit.index'), 'x\n');
  } else writeFileSync(path, 'x\n');
  if (age) {
    const at = new Date(Date.now() - age);
    utimesSync(path, at, at);
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const work = join(home, 'repo');
mkdirSync(work);
git(work, 'init', '-q', '-b', 'main');
git(work, 'config', 'user.email', 't@example.com');
git(work, 'config', 'user.name', 't');
git(work, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(work, 'seed.txt'), 'seed\n');
git(work, 'add', '.');
git(work, 'commit', '-q', '-m', 'seed');
writeFileSync(join(work, 'file.txt'), 'one\n');
await gitCommitPaths(work, 'Sweeps as it goes', ['file.txt']);

const left = new Set(readdirSync(temp));
const entries = SEEDS.map(([template, kind, age]) => ({ name: template, kind, ageMs: age, kept: left.has(fill(template)) }));
const stray = [...left].filter((name) => !SEEDS.some(([template]) => fill(template) === name));
if (stray.length) throw new Error(`the commit left its own scratch behind: ${stray.join(', ')}`);
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'commit-scratch');
writeJson(join(set, 'golden.json'), { dead: DEAD, entries });
writeSetManifest(set, {
  set: 'commit-scratch',
  recorder: 'benchmarks/rust-core/recorders/record-commit-scratch.mjs',
  command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-commit-scratch.mjs --tree <tree>',
  identityTree: repo,
});
console.log(entries.map((e) => `${e.kept ? 'kept   ' : 'removed'} ${e.name}`).join('\n'));
process.exit(0);
