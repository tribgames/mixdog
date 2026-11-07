// Records Node's gitReview (git-history.ts) over a repository holding a nested repository (and an empty-ish folder) among untracked files.
// node --experimental-transform-types --no-warnings --import <ts resolver> record-review-nested.mjs > review-nested.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'review-nested-home-'));
writeFileSync(join(home, 'gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home });
const { gitReview } = await import('file:///D:/mixdog-build/cc/tree/apps/desktop/src/main/git-history.ts');
const repo = mkdtempSync(join(tmpdir(), 'review-nested-'));
const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const git = (...args) => run(repo, ...args);
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
const put = (name, text) => {
  mkdirSync(dirname(join(repo, name)), { recursive: true });
  writeFileSync(join(repo, name), text);
};
put('mod.txt', 'one\ntwo\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
put('mod.txt', 'one\nTWO\nthree\n');
// A nested repository with a commit and a work tree edit: git lists it as one `inner/` record.
const inner = join(repo, 'inner');
mkdirSync(inner);
run(inner, 'init', '-q', '-b', 'main');
writeFileSync(join(inner, 'a.txt'), 'a\nb\n');
run(inner, 'add', '-A');
run(inner, 'commit', '-q', '-m', 'inner');
writeFileSync(join(inner, 'a.txt'), 'a\nb\nc\n');
// A second, freshly initialised one with no commit, and an ordinary untracked file around them.
const bare = join(repo, 'zz-bare');
mkdirSync(bare);
run(bare, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'plain.txt'), 'plain\n');

const answer = await gitReview(repo);
console.log(JSON.stringify({
  node: process.version,
  repository: answer.repository,
  base: answer.base,
  untrackedOmitted: answer.untrackedOmitted,
  files: answer.files,
}, null, 1));
