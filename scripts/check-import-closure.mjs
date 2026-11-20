#!/usr/bin/env node
// Import-closure check of the package tree. It walks every static import, dynamic import(), require(), createRequire(...)(),
// `new URL('./x', import.meta.url)` target and `<script src>` from the entry points that remain, and
//   1. fails when a reached file imports a path inside the tree that is not there any more (a deleted file still imported);
//   2. fails when a path of --delete / --delete-list is reached (the deletion would break a remaining entry);
//   3. reports which files of src/ nothing reaches (candidates for a later deletion) and which only tests reach.
//
//   node scripts/check-import-closure.mjs [--tree <root>] [--delete <path>]... [--delete-list <file>] [--json]
//
// A delete entry is a path relative to the tree; one ending in `/` names a folder. The entry points are computed, not listed:
//   production : apps/desktop (everything but node_modules and build output), apps/mobile, apps/relay, apps/mixdogd-npm,
//                packages/*, scripts/ (the files package.json scripts and the release lanes run), bin/, the skill launcher
//                src/skill-script-entry.mjs, the pptxgenjs authoring entry, and the skill scripts under src/defaults/skills.
//   tests      : every src/**/*.test.* file (they only add "reached by a test" to the report; they never keep a file alive).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = /\.(?:[cm]?[jt]sx?|html)$/;
const TEST_FILE = /\.test(?:-hook|-helper|-support)?\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'target', 'native', 'coverage', 'release']);
const SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.js',
  '.jsx',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.mjs',
  '/index.js',
  '/index.cjs',
];
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bcreateRequire\([^)]*\)\(\s*|new URL\(\s*)(['"`])([^'"`\n]+)\1|\b(?:src|href)=["']([^"']+)["']/g;

const posix = (p) => p.split(sep).join('/');
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function walk(dir, visit) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every specifier a source text names: { spec, kind } with kind 'relative' (starts with . or /) or 'package'. */
export function specifiersOf(text, file = '') {
  const out = [];
  const html = file.endsWith('.html');
  const source = html ? text : stripComments(text);
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[2] ?? match[3];
    if (!spec || spec.includes('${') || /^(?:node:|https?:|data:|file:|#|\/\/)/.test(spec)) continue;
    if (
      match[0].startsWith('new URL') &&
      !/import\.meta\.url|__dirname/.test(source.slice(match.index, match.index + match[0].length + 80))
    )
      continue;
    if (match[3] !== undefined && !html) continue;
    if (spec.startsWith('.') || (spec.startsWith('/') && html)) out.push({ spec, kind: 'relative' });
    else if (!spec.startsWith('/') && /^(?:@[\w.-]+\/)?[\w.-]+(?:\/|$)/.test(spec) && !/\s/.test(spec))
      out.push({ spec, kind: 'package' });
  }
  return out;
}

function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec);
  const bases = [base];
  if (/\.(?:m?js|cjs|jsx)$/.test(base))
    bases.push(
      base.replace(/\.mjs$/, '.mts'),
      base.replace(/\.cjs$/, '.cts'),
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      base.replace(/\.jsx$/, '.tsx')
    );
  for (const candidate of bases)
    for (const suffix of SUFFIXES) if (isFile(candidate + suffix)) return candidate + suffix;
  return null;
}

export function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function safeDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The entry points of the tree, computed from what is on disk. */
export function entryPoints(tree) {
  const production = new Set();
  const tests = new Set();
  const add = (set, file) => {
    if (SOURCE.test(file)) set.add(file);
  };
  for (const dir of ['apps/desktop', 'apps/mobile', 'apps/relay', 'apps/mixdogd-npm', 'scripts', 'bin'])
    walk(join(tree, dir), (f) => add(production, f));
  for (const pkg of safeDirs(join(tree, 'packages'))) walk(join(tree, 'packages', pkg), (f) => add(production, f));
  for (const rel of ['src/skill-script-entry.mjs', 'src/runtime/office/authoring/pptx-script-entry.mjs'])
    if (existsSync(join(tree, rel))) production.add(join(tree, rel));
  walk(join(tree, 'src/defaults/skills'), (f) => add(production, f));
  walk(join(tree, 'src'), (f) => {
    if (TEST_FILE.test(f)) add(tests, f);
  });
  return { production, tests };
}

/** Walks the imports from `roots`; returns the reached files, the missing in-tree imports and the packages named. */
export function walkImports(tree, roots) {
  const reached = new Set();
  const missing = [];
  const packages = new Map();
  const stack = [...roots];
  const treeRoot = resolve(tree) + sep;
  while (stack.length) {
    const file = stack.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    if (!SOURCE.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { spec, kind } of specifiersOf(text, file)) {
      if (kind === 'package') {
        const name = packageName(spec);
        if (!packages.has(name)) packages.set(name, new Set());
        packages.get(name).add(posix(relative(tree, file)));
        continue;
      }
      const target = resolveRelative(file, spec);
      if (target) {
        if (!reached.has(target)) stack.push(target);
        continue;
      }
      const guess = resolve(dirname(file), spec.replace(/[?#].*$/, ''));
      if (spec.endsWith('/') || isDirectory(guess)) continue;
      // Only a path inside the tree counts; one outside it (a sibling checkout, a generated output) is not this tree's file.
      if ((guess + sep).startsWith(treeRoot) && !SKIP_DIRS.has(posix(relative(tree, guess)).split('/')[0])) {
        missing.push({ from: posix(relative(tree, file)), spec, resolved: posix(relative(tree, guess)) });
      }
    }
  }
  return { reached, missing, packages };
}

const matchesDelete = (rel, entry) =>
  entry.endsWith('/') ? rel.startsWith(entry) : rel === entry || rel.startsWith(`${entry}/`);

export function check(tree, deletes = []) {
  const root = resolve(tree);
  const { production, tests } = entryPoints(root);
  const doomed = (file) => deletes.some((entry) => matchesDelete(posix(relative(root, file)), entry));
  const liveProduction = [...production].filter((f) => !doomed(f));
  const liveTests = [...tests].filter((f) => !doomed(f));
  const prod = walkImports(root, liveProduction);
  const all = walkImports(root, [...liveProduction, ...liveTests]);
  const rel = (set) => [...set].map((f) => posix(relative(root, f))).sort();
  const prodRel = new Set(rel(prod.reached));
  const allRel = new Set(rel(all.reached));
  const srcFiles = [];
  walk(join(root, 'src'), (f) => {
    if (SOURCE.test(f)) srcFiles.push(posix(relative(root, f)));
  });
  const reachedDeletes = [];
  if (deletes.length) {
    // The doomed files that are on disk and reached: walk once without removing them as roots' targets.
    const importersOf = new Map();
    for (const file of [...liveProduction, ...liveTests, ...all.reached]) {
      if (!SOURCE.test(file)) continue;
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const { spec, kind } of specifiersOf(text, file)) {
        if (kind !== 'relative') continue;
        const target = resolveRelative(file, spec);
        if (!target || !doomed(target) || doomed(file)) continue;
        const key = posix(relative(root, target));
        if (!importersOf.has(key)) importersOf.set(key, new Set());
        importersOf.get(key).add(posix(relative(root, file)));
      }
    }
    for (const [file, importers] of [...importersOf].sort())
      reachedDeletes.push({ file, importers: [...importers].sort() });
  }
  const everyMissing = [
    ...prod.missing,
    ...all.missing.filter((m) => !prod.missing.some((p) => p.from === m.from && p.spec === m.spec)),
  ];
  // A remaining non-test file that imports a missing path of src/ is the failure this check exists for; the other unresolved
  // imports (generated outputs, fixture strings of tests, folders outside this checkout) are reported, not failed.
  const isBroken = (m) => m.resolved.startsWith('src/') && !TEST_FILE.test(m.from);
  return {
    productionCount: prodRel.size,
    missing: everyMissing.filter(isBroken),
    unresolved: everyMissing.filter((m) => !isBroken(m)),
    reachedDeletes,
    srcReached: srcFiles.filter((f) => !TEST_FILE.test(f) && prodRel.has(f)).sort(),
    srcTestsOnly: srcFiles.filter((f) => !TEST_FILE.test(f) && !prodRel.has(f) && allRel.has(f)).sort(),
    srcNoImporter: srcFiles.filter((f) => !TEST_FILE.test(f) && !allRel.has(f)).sort(),
    packages: Object.fromEntries([...all.packages].map(([name, files]) => [name, [...files].sort()]).sort()),
    productionPackages: [...prod.packages.keys()].sort(),
  };
}

function main(argv) {
  const value = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  const tree = value('--tree')[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const deletes = value('--delete').map((d) => d.replace(/\\/g, '/'));
  for (const list of value('--delete-list')) {
    for (const line of readFileSync(list, 'utf8').split(/\r?\n/))
      if (line.trim() && !line.startsWith('#')) deletes.push(line.trim().replace(/\\/g, '/'));
  }
  const result = check(tree, deletes);
  // The two shipped pptx skill scripts are kept byte for byte (mixdog-skill-scripts shipped.rs pins their digests) and the
  // core runs their native versions on the Rust Office engine (mixdogd skill-run installs SkillOfficeEngine), so the Node
  // Office engine they import is gone on purpose. They are named, not failed; any other missing import fails.
  const nativeScripts = new Set([
    'src/defaults/skills/pptx/scripts/source-extract.mjs',
    'src/defaults/skills/pptx/scripts/qc-pages.mjs',
  ]);
  const runNatively = result.missing.filter(
    (m) => nativeScripts.has(m.from) && m.resolved.startsWith('src/runtime/office/')
  );
  result.missing = result.missing.filter((m) => !runNatively.includes(m));
  result.runNatively = runNatively;
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `entry points reach ${result.productionCount} files; src/: ${result.srcReached.length} reached by the entries, ${result.srcTestsOnly.length} only by tests, ${result.srcNoImporter.length} by nothing\n`
    );
    for (const m of result.unresolved)
      process.stdout.write(`unresolved ${m.from} imports ${m.spec}
`);
    for (const m of result.missing) process.stdout.write(`MISSING ${m.from} imports ${m.spec} (${m.resolved})\n`);
    for (const m of result.runNatively)
      process.stdout.write(`native ${m.from} imports ${m.spec} (the core runs this script natively)\n`);
    for (const h of result.reachedDeletes)
      process.stdout.write(`REACHED ${h.file} is imported by ${h.importers.join(', ')}\n`);
  }
  process.exitCode = result.missing.length || result.reachedDeletes.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
