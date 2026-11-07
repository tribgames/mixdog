// Records Node's gitReview (git-history.ts) on a scripted dirty repository: modified, added, deleted, renamed, untracked, with case and accent name pairs.
// node --experimental-transform-types --import <ts resolver> record-review.mjs > review.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'review-rows-home-'));
writeFileSync(join(home, 'gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home });
const { gitReview } = await import('file:///D:/mixdog-build/cc/tree/apps/desktop/src/main/git-history.ts');
const repo = mkdtempSync(join(tmpdir(), 'review-rows-'));
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
const put = (name, text) => writeFileSync(join(repo, name), text);
put('mod.txt', 'one\ntwo\nthree\n');
put('del.txt', 'gone\nsoon\n');
put('ren.txt', 'alpha\nbeta\ngamma\ndelta\n');
put('same.txt', 'unchanged\n');
mkdirSync(join(repo, 'dir'));
put('dir/inner.txt', 'in\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
put('mod.txt', 'one\nTWO\nthree\nfour\n');
rmSync(join(repo, 'del.txt'));
put('added.txt', 'added\nlines\n');
git('add', 'added.txt');
git('mv', 'ren.txt', 'moved.txt');
put('dir/inner.txt', 'in\nside\n');
const untracked = { 'new.txt': 'untracked\n', 'b.txt': 'b\n', 'Banana.txt': 'Banana\n', 'apple.txt': 'apple\n', 'Zed.txt': 'Zed\n', 'z.txt': 'z\n', 'e.txt': 'e\n', '\u00e9.txt': 'e acute\n', 'eclair.txt': 'eclair\n', '\u00c9clair.txt': 'E acute clair\n', 'resume.txt': 'resume\n', 'r\u00e9sum\u00e9.txt': 'resume acute\n', '\u00e4.txt': 'a umlaut\n', 'a.txt': 'a\n' };
for (const [name, text] of Object.entries(untracked)) put(name, text);

const answer = await gitReview(repo);
const revision = (row) => (row.revision === 'deleted' ? 'deleted' : /^\d+:\d+:\d+:\d+$/.test(row.revision) ? 'size:mtimeNs:ctimeNs:ino' : `UNEXPECTED ${row.revision}`);
const rows = answer.files.map((row) => ({ ...row, revision: revision(row) }));
console.log(JSON.stringify({ node: process.version, locale: Intl.DateTimeFormat().resolvedOptions().locale, untracked, repository: answer.repository, base: answer.base, untrackedOmitted: answer.untrackedOmitted, files: rows }, null, 1));
