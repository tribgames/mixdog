#!/usr/bin/env node
// Golden twin of the editor-side files the workspace domain serves
// (`projectFs/workspaceFile/{read,write}`, `projectFs/readEditorSettings`,
// `projectFs/backup/{read,write,delete}`, `project/taskWorkspace`), recorded from
// today's Node `workspace-config.ts`, `editor-backups.ts` and `SessionHost.getTaskWorkspace`.
// Everything runs in a temp directory with fake data. Path- and time-dependent values are
// scrubbed (`<WORK>`, ms timestamps -> 0); the file name of a backup is its path hash, which
// follows the host's case rule, so the corpus records the platform it was taken on.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-editor-config.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, sha256, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-editor-config-'));
const fwd = (p) => p.replace(/\\/g, '/');
const scrub = (value) => {
  let text = JSON.stringify(value ?? null);
  for (const root of [work, fwd(work), JSON.stringify(work).slice(1, -1)]) text = text.replaceAll(root, '<WORK>');
  text = text.replace(/\b1[67]\d{11}\b/g, '0');
  return collapse(JSON.parse(text));
};
// A string over 100 000 units (the 4 MiB backup bodies) is recorded as its length in UTF-16 units.
const collapse = (v) =>
  typeof v === 'string' ? (v.length > 100_000 ? `<LEN:${v.length}>` : v) : Array.isArray(v) ? v.map(collapse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, collapse(x)])) : v;
// A `{ "$repeat": [unit, count] }` input stands for a string too long to keep in the corpus.
const expand = (v) =>
  Array.isArray(v) ? v.map(expand) : v && typeof v === 'object' ? (v.$repeat ? v.$repeat[0].repeat(v.$repeat[1]) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))) : v;

const cfg = await importFrom(tree, 'apps/desktop/src/main/workspace-config.ts');
const backups = await importFrom(tree, 'apps/desktop/src/main/editor-backups.ts');
const host = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');

const entries = [];
// `input` is the request with `<WORK>` where the temp root goes; `fn` gets the request with it filled.
const fill = (v) => expand(JSON.parse(JSON.stringify(v).replaceAll('<WORK>', JSON.stringify(work).slice(1, -1))));
const rec = async (method, input, fn, extra = () => ({})) => {
  let out;
  try {
    out = { result: await fn(fill(input)) };
  } catch (e) {
    out = { error: { name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e) } };
  }
  const setup = pending.splice(0);
  entries.push(scrub({ method, input, ...(setup.length ? { setup } : {}), ...out, ...extra() }));
};
// Files written before the next call; a replay creates the same files first.
const pending = [];
const put = (rel, text) => {
  pending.push({ file: rel, text });
  const path = join(work, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const read = (rel) => {
  try {
    return readFileSync(join(work, rel), 'utf8');
  } catch {
    return null;
  }
};

// ---- workspace files -------------------------------------------------------------------------
const wsRead = (file) => rec('projectFs/workspaceFile/read', { workspaceFile: file }, (p) => cfg.readWorkspaceFile(p.workspaceFile));
const wsWrite = (file, folders, after) =>
  rec('projectFs/workspaceFile/write', { workspaceFile: file, folders }, (p) => cfg.writeWorkspaceFile(p.workspaceFile, p.folders), () => ({ fileAfter: read(after) }));

await wsWrite('<WORK>/proj/team', [
  { path: '<WORK>/proj/a' },
  { path: '<WORK>/proj/b', name: 'B' },
  { path: '<WORK>/other/c' },
  { path: '<WORK>/PROJ/A' },
  { path: '<WORK>/proj/a/../d', name: '' },
  { path: '<WORK>/proj' },
], 'proj/team.code-workspace');
await wsRead('<WORK>/proj/team.code-workspace');
put('proj/commented.code-workspace', '\ufeff{\n // c\n "folders": [ {"path": "sub"}, {"path": "../up", "name": "  Up  "}, {"path": "  "}, {"path": 5}, 7, {"path": "./sub"}, {"path": "x/", "name": "' + 'n'.repeat(250) + '"}, ], /* tail */ "settings": {"a": 1},\n}\n');
await wsRead('<WORK>/proj/commented.code-workspace');
put('proj/commented2.code-workspace', readFileSync(join(work, 'proj/commented.code-workspace'), 'utf8').slice(1));
await wsRead('<WORK>/proj/commented2.code-workspace');
await wsRead('<WORK>/proj/sub/../commented.code-workspace');
await wsWrite('<WORK>/proj/commented.code-workspace', [{ path: '<WORK>/proj/sub', name: 'S' }, { path: '<WORK>/proj' }], 'proj/commented.code-workspace');
put('proj/array.code-workspace', '[1]');
await wsRead('<WORK>/proj/array.code-workspace');
put('proj/empty.code-workspace', '   ');
await wsRead('<WORK>/proj/empty.code-workspace');
put('proj/broken.code-workspace', '{ "folders": [');
await wsWrite('<WORK>/proj/broken.code-workspace', [{ path: '<WORK>/proj/a' }], 'proj/broken.code-workspace');
await wsRead('<WORK>/proj/plain.json');
await wsRead('<WORK>/proj/missing.code-workspace');
put('proj/nul.code-workspace', '\0\0\0');
await wsWrite('<WORK>/proj/nul.code-workspace', [{ path: '<WORK>/proj/z' }], 'proj/nul.code-workspace');
await wsWrite('<WORK>/fresh/dir/ws.CODE-WORKSPACE', [], 'fresh/dir/ws.CODE-WORKSPACE');
await wsWrite('<WORK>/many', Array.from({ length: 70 }, (_, i) => ({ path: `<WORK>/many/f${i}` })), 'many.code-workspace');

// ---- scoped editor settings ------------------------------------------------------------------
const userData = join(work, 'userData');
const settings = (workspaceFile, root, rel) =>
  rec('projectFs/readEditorSettings', { userData: '<WORK>/userData', root, rel, workspaceFile }, (p) => cfg.readScopedEditorSettings(p.userData, p.root, p.rel, p.workspaceFile));
for (const rel of ['a.ts']) await settings(undefined, '<WORK>/folderA', rel);
put('userData/User/settings.json', `{
  // user scope
  "editor.fontSize": 18, "editor.wordWrap": "on", "editor.tabSize": "8", "editor.renderWhitespace": "all",
  "editor.fontFamily": "  Fira Code  ", "mixdog.markdown.defaultView": "rich",
  "[typescript][javascript]": { "editor.tabSize": 2, "editor.formatOnSave": true },
  "[markdown]": { "editor.wordWrap": "bounded", "editor.minimap.enabled": false },
  "editor": { "lineHeight": 30, "guides": { "bracketPairs": "active" }, "inlayHints": { "enabled": "onUnlessPressed" } },
}`);
put('wsconf/w.code-workspace', '{ "folders": [], "settings": { "editor.fontSize": 20, "[python]": { "editor.insertSpaces": false }, "editor.tabSize": 99 } }');
put('folderA/.vscode/settings.json', '{ "editor.fontSize": 5, "editor.lineHeight": 99.5, "editor.formatOnType": "yes", "editor.stickyScroll.enabled": false, "editor.inlayHints.enabled": false, "editor.wordWrapColumn": 120.6 }');
for (const rel of ['a.ts', 'b.md', 'src/c.py', 'Dockerfile', 'x.unknownext', 'docs/README.MD', 'a.test.tsx', 'conf.jsonc', '.gitignore', 'Makefile', 'weird.d.ts']) {
  await settings('<WORK>/wsconf/w.code-workspace', '<WORK>/folderA', rel);
}
await settings(undefined, '<WORK>/folderA', 'a.ts');
await settings(undefined, '<WORK>/folderMissing', 'a.ts');
put('folderBad/.vscode/settings.json', '{ "editor.fontSize": ');
await settings(undefined, '<WORK>/folderBad', 'a.ts');
put('wsconf/bad.code-workspace', '{ nope');
await settings('<WORK>/wsconf/bad.code-workspace', '<WORK>/folderA', 'a.ts');
put('wsconf/arr.code-workspace', '{ "settings": [1] }');
await settings('<WORK>/wsconf/arr.code-workspace', '<WORK>/folderA', 'a.ts');
put('folderNul/.vscode/settings.json', '\0\0');
await settings(undefined, '<WORK>/folderNul', 'a.ts');
put('folderLong/.vscode/settings.json', JSON.stringify({ 'editor.fontFamily': 'f'.repeat(600), 'editor.fontSize': 100.1, 'editor.lineHeight': 8, 'editor.tabSize': 16.4, 'editor.insertSpaces': 'no', 'mixdog.markdown.defaultView': 'bogus' }));
await settings(undefined, '<WORK>/folderLong', 'a.ts');

// ---- editor backups --------------------------------------------------------------------------
const bk = (method, input, fn, extra) => rec(method, { userData: '<WORK>/userData', ...input }, fn, extra);
const listing = () => (() => { try { return readdirSync(join(userData, 'editor-backups')); } catch { return []; } })();
const names = () => ({ files: listing().length, fileNames: listing().filter((n) => !/^[a-f0-9]{64}\.json$/.test(n)) });
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/file.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/write', { sourcePath: '<WORK>/p/file.txt', content: 'mine', expectedContent: 'disk' }, (p) => backups.writeEditorBackup(p.userData, p.sourcePath, p.content, p.expectedContent), names);
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/file.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/read', { sourcePath: '<WORK>/P/FILE.TXT' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/../p/file.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/write', { sourcePath: '<WORK>/p/file.txt', content: { $repeat: ['x', 4_194_305] }, expectedContent: '' }, (p) => backups.writeEditorBackup(p.userData, p.sourcePath, p.content, p.expectedContent), names);
await bk('projectFs/backup/write', { sourcePath: 'relative/file.txt', content: 'a', expectedContent: 'b' }, (p) => backups.writeEditorBackup(p.userData, p.sourcePath, p.content, p.expectedContent), names);
await bk('projectFs/backup/read', { sourcePath: 'relative/file.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/write', { sourcePath: '<WORK>/p/uni.txt', content: { $repeat: ['😀', 2_097_152] }, expectedContent: '' }, (p) => backups.writeEditorBackup(p.userData, p.sourcePath, p.content, p.expectedContent), names);
const hashed = (rel) => join(userData, 'editor-backups', `${sha256(process.platform === 'win32' ? join(work, rel).toLowerCase() : join(work, rel))}.json`);
// A damaged file and an expired one read as no backup, and are removed.
// A backup file seeded by hand: `raw` text, or the fields with `ageMs` before now as `updatedAt`.
const seed = (rel, spec) => {
  pending.push({ backup: rel, ...spec });
  writeFileSync(hashed(rel), spec.raw ?? JSON.stringify({ content: spec.content, expectedContent: spec.expectedContent, updatedAt: Date.now() - spec.ageMs }));
};
seed('p/bad.txt', { raw: '{ not json' });
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/bad.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath), () => ({ fileGone: read(hashed('p/bad.txt')) === null }));
seed('p/old.txt', { content: 'c', expectedContent: 'e', ageMs: 31 * 24 * 3600 * 1000 });
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/old.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
seed('p/shape.txt', { content: 5, expectedContent: 'e', ageMs: 0 });
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/shape.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
await bk('projectFs/backup/delete', { sourcePath: '<WORK>/p/file.txt' }, (p) => backups.deleteEditorBackup(p.userData, p.sourcePath), names);
await bk('projectFs/backup/delete', { sourcePath: '<WORK>/p/file.txt' }, (p) => backups.deleteEditorBackup(p.userData, p.sourcePath), names);
await bk('projectFs/backup/read', { sourcePath: '<WORK>/p/file.txt' }, (p) => backups.readEditorBackup(p.userData, p.sourcePath));
// The file-count cap: 105 sources, each write pruning first.
rmSync(join(userData, 'editor-backups'), { recursive: true, force: true });
for (let i = 0; i < 105; i += 1) {
  const path = join(work, `cap/f${i}.txt`);
  await backups.writeEditorBackup(userData, path, `c${i}`, 'e');
  const when = new Date(Date.now() - (105 - i) * 1000);
  utimesSync(hashed(`cap/f${i}.txt`), when, when);
}
entries.push({ method: 'projectFs/backup/write', input: { note: '105 distinct sources, newest last, mtimes 1 s apart' }, result: { filesAfter: listing().length } });

// ---- task workspace --------------------------------------------------------------------------
const taskHost = Object.create(host.SessionHost.prototype);
taskHost.taskWorkspacePath = join(userData, 'workspace', 'unclassified');
await rec('project/taskWorkspace', { userData: '<WORK>/userData' }, async () => ({ path: await host.SessionHost.prototype.getTaskWorkspace.call(taskHost) }));

writeJson(join(FIXTURES_ROOT, 'desktop', 'editor-config', 'corpus.json'), {
  domain: 'editor-config',
  recorder: 'record-editor-config.mjs',
  platform: process.platform,
  entries,
});

// Register the new file in the desktop set manifest without touching its product identity.
const manifestPath = join(FIXTURES_ROOT, 'desktop', 'MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const data = readFileSync(join(FIXTURES_ROOT, 'desktop', 'editor-config', 'corpus.json'));
manifest.files = manifest.files.filter((f) => f.path !== 'editor-config/corpus.json');
manifest.files.push({ path: 'editor-config/corpus.json', bytes: data.length, sha256: sha256(data) });
manifest.files.sort((a, b) => a.path.localeCompare(b.path));
manifest.fileCount = manifest.files.length;
manifest.totalBytes = manifest.files.reduce((s, f) => s + f.bytes, 0);
writeJson(manifestPath, manifest);
rmSync(work, { recursive: true, force: true });
console.log(`editor-config/corpus.json: ${entries.length} entries`);
process.exit(0);
