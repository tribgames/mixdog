#!/usr/bin/env node
// Records, from Node's product at b6f10295a, how the paths of the repository facts and the worktree rows are spelled:
// the REAL `canonicalPath` (src/runtime/shared/worktrees/paths.mjs), `inspectRepo` and `listWorktrees`
// (src/runtime/shared/worktrees/git.mjs) over one sandbox with a repository `repo` (folder `sub` inside), a linked worktree
// `linked`, and a junction `junc` -> `repo`, all below a folder with a long name (so it has an 8.3 short name).
// Each input is a spelling of a folder: relative (the process runs in <BASE>), `..`, mixed separators, other casing,
// through the junction (also with `..` after it, which `resolve` settles lexically), the short name, a trailing separator,
// and a tail that does not exist. Tokens: <BASE> the sandbox, <BASE_SHORT> its 8.3 spelling, <BASE_UPPER> its upper-cased
// spelling. Recorded per input: `canonicalPath`, `inspectRepo` (facts or the refusal's code and projectPath) and
// `listWorktrees` paths (null when the folder is gone); the sandbox is written <BASE>.
//   node benchmarks/rust-core/recorders/record-canonical-paths.mjs --tree <git archive of b6f10295a>
// Output: native/core/fixtures/canonical-paths/golden.json (Windows spellings; the replay runs on Windows).
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const recorder = 'benchmarks/rust-core/recorders/record-canonical-paths.mjs';
const finalDir = join(FIXTURES_ROOT, 'canonical-paths');
const stage = stageSet(finalDir);
const { canonicalPath } = await importFrom(tree, 'src/runtime/shared/worktrees/paths.mjs');
const { inspectRepo, listWorktrees } = await importFrom(tree, 'src/runtime/shared/worktrees/git.mjs');

const base = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'canonical-paths-'))), 'Long Folder Name');
const repo = join(base, 'repo');
mkdirSync(join(repo, 'sub'), { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
git(repo, 'worktree', 'add', '-q', '-b', 'side', join(base, 'linked'));
symlinkSync(repo, join(base, 'junc'), 'junction');
const short = execSync(`for %I in ("${base}") do @echo %~sI`, { encoding: 'utf8' }).trim();
if (short === base || short.includes('"') || short.includes(' ')) throw new Error('the sandbox has no 8.3 short name');

const inputs = [
  '<BASE>\\repo',
  'repo',
  'linked\\..\\repo',
  '.\\repo\\.',
  '<BASE>/repo/sub/..',
  '<BASE>/repo\\sub\\..',
  '<BASE_UPPER>\\REPO',
  '<BASE>\\junc',
  '<BASE>\\junc\\..\\repo',
  '<BASE>\\junc\\sub\\..\\..\\linked',
  '<BASE_SHORT>\\repo',
  '<BASE>\\linked',
  '<BASE>\\repo\\',
  '<BASE>\\repo\\sub',
  '<BASE>\\repo\\nope\\deeper\\..\\x',
  '<BASE>\\junc\\nope',
];
const spell = (text) => text.split('<BASE_SHORT>').join(short).split('<BASE_UPPER>').join(base.toUpperCase()).split('<BASE>').join(base);
const mask = (text) => (text === null ? null : text.split(base).join('<BASE>'));
process.chdir(base);
const cases = [];
for (const input of inputs) {
  const spelled = spell(input);
  let facts;
  try {
    const r = await inspectRepo(spelled);
    facts = { projectPath: mask(r.projectPath), topLevel: mask(r.topLevel), repoCommonDir: mask(r.repoCommonDir), currentBranch: r.currentBranch };
  } catch (error) {
    facts = { error: error.code, projectPath: mask(error.details?.projectPath ?? null) };
  }
  let rows = null;
  if (!facts.error) rows = (await listWorktrees(spelled)).map((row) => mask(row.path));
  cases.push({ input, canonical: mask(canonicalPath(spelled)), facts, rows });
}
if (new Set(cases.map((c) => c.canonical)).size < 5) throw new Error('the spellings must reach several distinct folders');
writeJson(join(stage, 'golden.json'), { domain: 'canonical-paths', recorder, cases });
writeSetManifest(stage, {
  set: 'canonical-paths',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} spellings`);
