// Records Node's gitReview (git-history.ts) over a repository with more untracked files than REVIEW_UNTRACKED_LIMIT (256).
// node --experimental-transform-types --no-warnings --import <ts resolver> record-review-cap.mjs > review-cap.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'review-cap-home-'));
writeFileSync(join(home, 'gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home });
const { gitReview } = await import('file:///D:/mixdog-build/cc/tree/apps/desktop/src/main/git-history.ts');
const repo = mkdtempSync(join(tmpdir(), 'review-cap-'));
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
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
// 295 untracked files. Git lists them by path bytes: `.` < `/` < letters < the bytes of a non-ASCII name.
const created = [];
for (let i = 0; i < 260; i++) created.push(`u${String(i).padStart(3, '0')}.txt`);
for (let i = 0; i < 30; i++) created.push(`sub/s${String(i).padStart(2, '0')}.txt`);
created.push('sub.txt', 'a.b', 'a/b', 'Z-upper.txt', '\u00e9.txt');
for (const name of created) put(name, `${name}\n`);

const answer = await gitReview(repo);
console.log(JSON.stringify({
  node: process.version,
  limit: 256,
  created,
  repository: answer.repository,
  base: answer.base,
  untrackedOmitted: answer.untrackedOmitted,
  files: answer.files.map(({ revision, ...row }) => row),
}, null, 1));
