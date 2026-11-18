// `--changed` follows relative imports, literal file URLs and explicit
// `// @test-input ./path` declarations for paths assembled at runtime. A
// trailing slash in a declaration covers changed files under that directory.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const RELATIVE_IMPORT =
  /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"()]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const FILE_URL = /\bnew\s+URL\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*,?\s*\)/g;
const TEST_INPUT = /^[ \t]*\/\/[ \t]+@test-input[ \t]+(\.{1,2}\/[^\r\n]+)$/gm;
const SUFFIXES = ['', '.mjs', '.js', '.ts', '.tsx', '.mts', '.cjs', '/index.mjs', '/index.js', '/index.ts'];
const SOURCE = /\.(?:mjs|cjs|js|ts|tsx|mts)$/;

const toPosix = (path) => path.replaceAll('\\', '/');

function gitLines(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/** Repo-wide changes relative to cwd: this package's tests may read sibling packages or repo assets. */
export function changedFiles(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).replace(/\r?\n$/, '');
  const tracked = gitLines(['diff', '--name-only', '--no-relative', '--no-renames', '-z', 'HEAD', '--'], root);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard', '-z'], root);
  return [...new Set([...tracked, ...untracked].map((file) => toPosix(relative(cwd, join(root, file)))))].sort();
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Keep removed candidates before the first live match: a deleted `.mjs` must
// still select the test if extensionless lookup now falls through to `.ts`.
function addImportTargets(targets, cwd, base, changed, isLiveFile) {
  for (const suffix of SUFFIXES) {
    const candidate = `${base}${suffix}`;
    const path = toPosix(relative(cwd, candidate));
    const live = isLiveFile(candidate);
    if (live || changed.has(path)) targets.add(path);
    if (live) break;
  }
}

export function createImportGraph(cwd = process.cwd(), changed = new Set()) {
  const edges = new Map();
  // A shared module is probed by its importers and again when it is read.
  // Reuse the result for this graph only, including failed suffix probes.
  const fileStatus = new Map();
  const isLiveFile = (path) => {
    if (!fileStatus.has(path)) fileStatus.set(path, isFile(path));
    return fileStatus.get(path);
  };
  return (file) => {
    if (edges.has(file)) return edges.get(file);
    const source = join(cwd, file);
    const text = SOURCE.test(file) && isLiveFile(source) ? readFileSync(source, 'utf8') : '';
    const targets = new Set();
    const from = dirname(file);
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      addImportTargets(targets, cwd, join(cwd, from, match[1]), changed, isLiveFile);
    }
    const addFile = (specifier) => {
      const absolute = join(cwd, from, specifier);
      const path = toPosix(relative(cwd, absolute));
      if (changed.has(path) || isLiveFile(absolute)) targets.add(path);
    };
    for (const match of text.matchAll(FILE_URL)) addFile(match[2]);
    for (const match of text.matchAll(TEST_INPUT)) {
      const specifier = match[1].trimEnd();
      if (specifier.endsWith('/')) {
        const directory = join(cwd, from, specifier);
        for (const path of changed) {
          const child = toPosix(relative(directory, join(cwd, path)));
          if (child && child !== '..' && !child.startsWith('../')) targets.add(path);
        }
      } else {
        addFile(specifier);
      }
    }
    const list = [...targets];
    edges.set(file, list);
    return list;
  };
}

/**
 * The test files that reach a changed file through static imports, and the
 * changed files no selected or unselected test reaches.
 */
export function selectChangedTests(testFiles, changed, cwd = process.cwd(), importsOf) {
  const changedSet = new Set(changed.map(toPosix));
  // Nothing changed: no test can be reached, so skip reading the whole graph.
  if (!changedSet.size) return { selected: [], unreached: [] };
  const imports = importsOf ?? createImportGraph(cwd, changedSet);
  // Every module the tests import, with who imports it: reachability then runs
  // backwards from the changed files, which stays exact through import cycles.
  const seen = new Set();
  const importers = new Map();
  const stack = testFiles.map(toPosix);
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of imports(file)) {
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push(file);
      if (!seen.has(target)) stack.push(target);
    }
  }
  const affected = new Set();
  const queue = [...changedSet].filter((file) => seen.has(file));
  while (queue.length) {
    const file = queue.pop();
    if (affected.has(file)) continue;
    affected.add(file);
    queue.push(...(importers.get(file) || []));
  }
  const selected = testFiles.filter((file) => affected.has(toPosix(file)));
  const unreached = [...changedSet].filter((file) => !seen.has(file));
  return { selected, unreached };
}
