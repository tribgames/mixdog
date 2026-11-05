#!/usr/bin/env node
// Desktop-service golden-twin corpora (DS §18.1): today's Node implementations
// (apps/desktop/src/main: git-cli, workspace-search, project-files,
// server-ports) run on a deterministic fixture repo/workspace; every request
// and its result (or error text) is stored under
// native/core/fixtures/desktop/<domain>/. Not recordable without Electron
// (see BASELINE.md): terminal, lsp, browser, notifications, remote/relay,
// transfer, settings (they import electron or apps/desktop/node_modules).
//
// Must run under the TS resolve hook:
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-desktop.mjs --tree <dir>
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-ds-golden-'));
const M = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const git = await M('git-cli');
const search = await M('workspace-search');
const files = await M('project-files');
const ports = await M('server-ports');

const fwd = (p) => p.replace(/\\/g, '/');
const scrub = (value, roots) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const root of roots) text = text.replaceAll(root, '<ROOT>').replaceAll(fwd(root), '<ROOT>').replaceAll(JSON.stringify(root).slice(1, -1), '<ROOT>');
  // Hashes and timestamps of commits made at record time are not deterministic.
  text = text.replace(/\b[0-9a-f]{40}\b/g, '<H40>').replace(/\b[0-9a-f]{7,8}\b(?=[^a-z]|$)/g, (m) => (/\d/.test(m) && /[a-f]/.test(m) ? '<H>' : m));
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/g, '<T>');
  return typeof value === 'string' ? text : JSON.parse(text);
};

const corpora = { git: [], search: [], files: [], ports: [] };
async function step(domain, op, args_, fn, roots) {
  let out;
  try {
    out = { result: await fn() };
  } catch (e) {
    out = { error: String(e?.message ?? e) };
  }
  corpora[domain].push(scrub({ op, args: args_, ...out }, roots));
}

const FIXED = new Date('2026-01-02T03:04:05Z');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05+00:00', GIT_COMMITTER_DATE: '2026-01-02T03:04:05+00:00',
};
const g = (cwd, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { cwd, env: gitEnv, stdio: 'pipe' });

// ---- git -----------------------------------------------------------------
const repo = join(work, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
g(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
writeFileSync(join(repo, 'src', 'b.mjs'), 'export const b = 1;\n');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'first');
writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
g(repo, 'commit', '-q', '-am', 'second: edit a');
g(repo, 'branch', 'feature');
const head = g(repo, 'rev-parse', 'HEAD').toString().trim();
writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n'); // unstaged
writeFileSync(join(repo, 'src', 'b.mjs'), 'export const b = 2;\n');
g(repo, 'add', 'src/b.mjs'); // staged
writeFileSync(join(repo, 'new.txt'), 'untracked\n'); // untracked
const R = [repo];
await step('git', 'gitStatus', [], () => git.gitStatus(repo), R);
await step('git', 'gitBranches', [], () => git.gitBranches(repo), R);
await step('git', 'gitLog', ['', 0, 40], () => git.gitLog(repo, '', 0, 40), R);
await step('git', 'gitLog', ['second', 0, 40], () => git.gitLog(repo, 'second', 0, 40), R);
await step('git', 'gitShow', ['HEAD'], () => git.gitShow(repo, head), R);
await step('git', 'gitDiff', ['a.txt', false], () => git.gitDiff(repo, 'a.txt', false), R);
await step('git', 'gitDiff', ['src/b.mjs', true], () => git.gitDiff(repo, 'src/b.mjs', true), R);
await step('git', 'gitDiff', ['new.txt', false, false, true], () => git.gitDiff(repo, 'new.txt', false, false, true), R);
await step('git', 'gitStashList', [], () => git.gitStashList(repo), R);
await step('git', 'gitStage', [['a.txt']], () => git.gitStage(repo, ['a.txt']), R);
await step('git', 'gitStatus(after stage)', [], () => git.gitStatus(repo), R);
await step('git', 'gitUnstage', [['a.txt']], () => git.gitUnstage(repo, ['a.txt']), R);
await step('git', 'gitCommit(empty message)', [''], () => git.gitCommit(repo, ' '), R);
await step('git', 'gitCreateTag', ['v-fixture', head], () => git.gitCreateTag(repo, 'v-fixture', head), R);
await step('git', 'gitCreateTag(duplicate)', ['v-fixture', head], () => git.gitCreateTag(repo, 'v-fixture', head), R);
await step('git', 'gitRevertFile', ['a.txt', false, 'worktree'], () => git.gitRevertFile(repo, 'a.txt', false, 'worktree'), R);
await step('git', 'gitStatus(after revert)', [], () => git.gitStatus(repo), R);

// ---- workspace search -----------------------------------------------------
const ws = join(work, 'ws');
const put = (rel, data) => {
  const p = join(ws, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  utimesSync(p, FIXED, FIXED);
};
put('a.txt', 'Hello World\nhello world\nHELLO\n');
put('src/x.mjs', 'const hello = "Hello";\nfunction helloWorld() {}\n');
put('node_modules/skip.js', 'hello skipped\n');
put('data.bin', Buffer.from([0, 1, 2, 104, 101, 108, 108, 111]));
const W = [ws];
const S = (o) => step('search', 'searchWorkspaceTextIn', o, () => search.searchWorkspaceTextIn(ws, o), W);
await S({ query: 'hello' });
await S({ query: 'hello', matchCase: true });
await S({ query: 'hello', wholeWord: true });
await S({ query: 'hel+o\\w*', regex: true });
await S({ query: 'hello', include: '*.mjs' });
await S({ query: 'hello', exclude: 'src/**' });
await S({ query: 'hello', maxResults: 2 });
await S({ query: '(' , regex: true });
await step('search', 'replaceWorkspaceTextIn', [{ query: 'hello', matchCase: true }, 'bye'], () => search.replaceWorkspaceTextIn(ws, { query: 'hello', matchCase: true }, 'bye', undefined), W);
await S({ query: 'bye' });

// ---- project files ---------------------------------------------------------
const pf = join(work, 'pf');
const putPf = (rel, data) => {
  const p = join(pf, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  utimesSync(p, FIXED, FIXED);
};
putPf('utf8.txt', 'héllo\nworld\n');
putPf('crlf.txt', 'a\r\nb\r\n');
putPf('bom8.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]));
putPf('utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]));
putPf('bin.dat', Buffer.from([0, 255, 0, 255, 1, 2, 3]));
putPf('dir/inner.txt', 'inner\n');
const F = [pf];
await step('files', 'listProjectDirIn', ['.'], async () => (await files.listProjectDirIn(pf, '.')).map((e) => ({ ...e, mtimeMs: undefined })), F);
await step('files', 'listProjectDirIn', ['dir'], async () => (await files.listProjectDirIn(pf, 'dir')).map((e) => ({ ...e, mtimeMs: undefined })), F);
for (const f of ['utf8.txt', 'crlf.txt', 'bom8.txt', 'utf16le.txt', 'bin.dat', 'missing.txt', '../escape.txt']) {
  await step('files', 'readProjectTextFileIn', [f], async () => ({ ...(await files.readProjectTextFileIn(pf, f)), mtimeMs: undefined }), F);
}
await step('files', 'statProjectFileIn', ['utf8.txt'], async () => ({ ...(await files.statProjectFileIn(pf, 'utf8.txt')), mtimeMs: undefined }), F);
await step('files', 'writeProjectTextFileIn(expected mismatch)', ['utf8.txt'], () => files.writeProjectTextFileIn(pf, 'utf8.txt', 'new', 'WRONG'), F);
await step('files', 'writeProjectTextFileIn', ['utf8.txt'], async () => ({ ...(await files.writeProjectTextFileIn(pf, 'utf8.txt', 'rewritten\n', 'héllo\nworld\n')), mtimeMs: undefined }), F);
await step('files', 'readProjectTextFileIn(after write)', ['utf8.txt'], async () => ({ ...(await files.readProjectTextFileIn(pf, 'utf8.txt')), mtimeMs: undefined }), F);
await step('files', 'createProjectEntryIn', ['dir', 'sub', true], () => files.createProjectEntryIn(pf, 'dir', 'sub', true), F);
await step('files', 'createProjectEntryIn(invalid)', ['dir', 'a/../b', false], () => files.createProjectEntryIn(pf, 'dir', 'a/../b', false), F);
await step('files', 'renameProjectEntryIn', ['dir/inner.txt', 'renamed.txt'], () => files.renameProjectEntryIn(pf, 'dir/inner.txt', 'renamed.txt'), F);
await step('files', 'moveProjectEntryIn', ['dir/renamed.txt', 'dir/sub'], () => files.moveProjectEntryIn(pf, 'dir/renamed.txt', 'dir/sub'), F);
await step('files', 'copyProjectEntryIn', ['crlf.txt', 'dir'], () => files.copyProjectEntryIn(pf, 'crlf.txt', 'dir'), F);
await step('files', 'listProjectDirIn(after)', ['dir'], async () => (await files.listProjectDirIn(pf, 'dir')).map((e) => ({ ...e, mtimeMs: undefined })), F);

// ---- server ports (pure parsers, inline samples) ----------------------------
const lsof = 'p100\ncnode\nn*:3000\nn127.0.0.1:5173\np200\ncpostgres\nn[::1]:5432\n';
const proc4 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n   1: 0100007F:0050 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 999 1\n';
await step('ports', 'parseLsofListen', [lsof], () => ports.parseLsofListen(lsof), []);
await step('ports', 'parseProcNetTcp', [proc4, 4], () => ports.parseProcNetTcp(proc4, 4), []);
await step('ports', 'mergeListeningSockets', ['lsof', 100], () => ports.mergeListeningSockets(ports.parseLsofListen(lsof), 100), []);

const outDir = join(FIXTURES_ROOT, 'desktop');
rmSync(outDir, { recursive: true, force: true });
for (const [domain, cases] of Object.entries(corpora)) writeJson(join(outDir, domain, 'corpus.json'), { domain, cases });
writeSetManifest(outDir, {
  set: 'desktop-golden-twin',
  recorder: 'benchmarks/rust-core/recorders/record-desktop.mjs',
  command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-desktop.mjs --tree <tree>',
  extra: { domains: Object.fromEntries(Object.entries(corpora).map(([k, v]) => [k, v.length])) },
});
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(Object.fromEntries(Object.entries(corpora).map(([k, v]) => [k, v.length]))));
