// Records Node's gitReviewDiffs (git-history.ts) on a scripted repository: node --experimental-transform-types --import <ts resolver> record.mjs > corpus.json
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated git: no user or system configuration (autocrlf would rewrite the patches).
const home = mkdtempSync(join(tmpdir(), 'review-batch-home-'));
writeFileSync(join(home, 'gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home });
const { gitReviewDiff, gitReviewDiffs } = await import('../../../../../apps/desktop/src/main/git-history.ts');
const repo = mkdtempSync(join(tmpdir(), 'review-batch-'));
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${'x'.repeat(40)}`).join('\n') + '\n';
writeFileSync(join(repo, 'same.txt'), 'unchanged\n');
writeFileSync(join(repo, 'edit.txt'), 'one\ntwo\n');
writeFileSync(join(repo, 'big1.txt'), 'a\n');
writeFileSync(join(repo, 'big2.txt'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
writeFileSync(join(repo, 'edit.txt'), 'one\nTWO\nthree\n');
writeFileSync(join(repo, 'big1.txt'), lines(100000, 'first'));
writeFileSync(join(repo, 'big2.txt'), lines(100000, 'second'));
writeFileSync(join(repo, 'new.txt'), 'brand new\n');

const cases = [];
// patches are what Node read per file (gitReviewDiff): the body when short, else its length.
const lengths = {};
const record = async (label, files) => {
  const answer = await gitReviewDiffs(repo, files, 'uncommitted');
  for (const file of files) {
    if (file.path in lengths || /["\\\u0000-\u001f]/.test(file.path)) continue;
    const patch = await gitReviewDiff(repo, file.path, file.untracked, 'uncommitted').catch(() => '');
    lengths[file.path] = patch.length <= 4000 ? { patch } : { length: patch.length };
  }
  const served = answer.patches.map((entry) => ({ path: entry.path, length: entry.patch.length }));
  cases.push({ label, files, answer: { patches: answer.patches.map((entry) => (entry.patch.length <= 4000 ? entry : { path: entry.path, length: entry.patch.length })), omitted: answer.omitted }, served });
};
await record('no files', []);
await record('an unchanged and a changed tracked file', [
  { path: 'same.txt', untracked: false },
  { path: 'edit.txt', untracked: false },
]);
await record('a tracked name with a double quote', [
  { path: 'we"ird.txt', untracked: false },
  { path: 'edit.txt', untracked: false },
]);
await record('a tracked name with a backslash and one with a control character', [
  { path: 'back\\slash.txt', untracked: false },
  { path: 'ctl\u0001.txt', untracked: false },
]);
await record('a path listed twice, the later entry wins', [
  { path: 'edit.txt', untracked: true },
  { path: 'same.txt', untracked: false },
  { path: 'edit.txt', untracked: false },
]);
await record('an untracked file', [{ path: 'new.txt', untracked: true }]);
await record('a path that no longer exists', [{ path: 'gone.txt', untracked: false }]);
await record(
  'tracked names past the command-line budget',
  Array.from({ length: 120 }, (_, i) => ({ path: `dir/${String(i).padStart(3, '0')}-${'n'.repeat(190)}.txt`, untracked: false }))
);
await record('patches past the patch budget', [
  { path: 'big1.txt', untracked: false },
  { path: 'big2.txt', untracked: false },
  { path: 'edit.txt', untracked: false },
]);
console.log(JSON.stringify({ node: process.version, patchOf: lengths, cases }, null, 1));
