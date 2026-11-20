#!/usr/bin/env node
// The gate runs on a clean checkout: nothing a tracked file reads or Cargo builds may exist only in one working tree.
//
// What this script guarantees, and what it does not (docs/testing.md, "What each layer guarantees"). The guarantee is behavioural: the
// gate runs every suite on a clean checkout, so a test that reads an absent file FAILS there, and one that skips is caught by
// scripts/ci/check-skips.mjs. That leaves one thing no layer sees: a test that guards its read and returns early without reporting a
// skip. `--readers` is an early pointer for the common case, not a proof: it reads source text, so a path assembled at run time
// (joined from pieces, taken from a variable or the environment) is invisible to it. Two checks:
//
//   --readers  (default) a tracked JavaScript or TypeScript file that imports, requires, spawns or names (a string literal) a
//              tracked file that .gitignore also covers (one waiting to be untracked, so absent from a clean checkout of the
//              change), or a file that does, followed until nothing new is found. Imports are resolved as Node resolves them (the file, `.js`, `.json`, `.node` and the
//              repository's own extensions, a directory's package.json `main`, an index file), a `?query` or `#hash` is dropped, and
//              the source is tokenized, not matched line by line: comments (line and block, shebang included) are dropped without
//              dropping the code beside them, strings are read as strings (template literals with their interpolations), and an
//              import split over several lines is one import. Nothing is exempt, the gate's own scripts included. Rust needs no such
//              check: a `mod`, `include_str!` or `include!` of a missing file fails the build.
//   --build    the checkout the Rust jobs build has no Cargo test target that is not tracked, ignored or not. Cargo builds every
//              `tests/<name>.rs` and `tests/<name>/main.rs` of a package it finds, so a test file left on a runner (or restored
//              with a cache) would be built into the archive the legs run.
//// Usage: node scripts/ci/check-clean-checkout.mjs [--readers | --build]      (from anywhere inside the repository)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
// What a resolver tries for a relative specifier, in Node's order (the file as written, then .js, .json, .node), then the extensions the
// repository's own sources and TypeScript add, then a directory: its package.json main, then an index file.
const EXTENSIONS = ['', '.js', '.json', '.node', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];
const INDEXES = ['index.js', 'index.json', 'index.node', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx'];

const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char);
const isIdentifierPart = (char) => /[\w$]/.test(char);

// Tokens of a JavaScript or TypeScript source: `str` (a string literal's value, or a template literal's static part), `word` and
// `punct`, each with its line. Comments are not tokens. A `/` starts a regular expression unless the token before it ends an
// expression; a regular expression is skipped whole, so a quote inside one does not open a string.
export function tokenize(source) {
  const tokens = [];
  let line = 1;
  let i = 0;
  // Open template literals' `${`: the brace depth at which each interpolation returns to the template.
  const templates = [];
  let depth = 0;
  const last = () => tokens[tokens.length - 1];
  const endsExpression = () => {
    const token = last();
    if (!token) return false;
    if (token.kind === 'str') return true;
    if (token.kind === 'word')
      return !/^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(token.value);
    return token.value === ')' || token.value === ']' || token.value === '}';
  };
  const scanTemplate = () => {
    // `i` is just past a backtick or a closing `}` of an interpolation: read static text up to `${` or the closing backtick.
    let text = '';
    const start = line;
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        text += source.slice(i, i + 2);
        if (source[i + 1] === '\n') line += 1;
        i += 2;
      } else if (char === '`') {
        i += 1;
        tokens.push({ kind: 'str', value: text, line: start });
        return;
      } else if (char === '$' && source[i + 1] === '{') {
        i += 2;
        tokens.push({ kind: 'str', value: text, line: start });
        templates.push(depth);
        depth += 1;
        return;
      } else {
        if (char === '\n') line += 1;
        text += char;
        i += 1;
      }
    }
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '\n') {
      line += 1;
      i += 1;
    } else if (/\s/.test(char)) {
      i += 1;
    } else if (char === '#' && source[i + 1] === '!' && i === 0) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (const c of source.slice(i, stop)) if (c === '\n') line += 1;
      i = stop;
    } else if (char === "'" || char === '"') {
      const start = line;
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== char && source[i] !== '\n') {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          if (source[i + 1] === '\n') line += 1;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'str', value, line: start });
    } else if (char === '`') {
      i += 1;
      scanTemplate();
    } else if (char === '/' && !endsExpression()) {
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < source.length && isIdentifierPart(source[i])) i += 1;
      tokens.push({ kind: 'punct', value: '/regex/', line });
    } else if (isIdentifierStart(char)) {
      let end = i + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      tokens.push({ kind: 'word', value: source.slice(i, end), line });
      i = end;
    } else if (/\d/.test(char)) {
      let end = i + 1;
      while (end < source.length && /[\w.]/.test(source[end])) end += 1;
      tokens.push({ kind: 'word', value: source.slice(i, end), line });
      i = end;
    } else {
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          i += 1;
          scanTemplate();
          continue;
        }
      }
      tokens.push({ kind: 'punct', value: char, line });
      i += 1;
    }
  }
  return tokens;
}

const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

// `a/b/../c` -> `a/c`; undefined when it climbs out of the repository.
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.pop() === undefined) return undefined;
    } else out.push(part);
  }
  return out.join('/');
}

// Per script: the paths it imports, requires, spawns or names (as written, with the directory of the file or the repository root
// to resolve them against).
export function scan(source) {
  const tokens = tokenize(source);
  const specifiers = [];
  const literals = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'str') return;
    const before = tokens[index - 1];
    const before2 = tokens[index - 2];
    // `from 'x'`, `import 'x'`, `import('x')`, `require('x')`
    const isSpecifier =
      (before?.kind === 'word' && (before.value === 'from' || before.value === 'import')) ||
      (before?.value === '(' &&
        before2?.kind === 'word' &&
        (before2.value === 'import' || before2.value === 'require'));
    if (isSpecifier && /^\.{1,2}\//.test(token.value)) specifiers.push(token.value);
    else if (token.value !== '' && !/[\s$]/.test(token.value)) literals.push(token.value);
  });
  return { specifiers, literals };
}

// What Node would open for the path `base` (already normalized, no query): the file as written or with an extension, else the
// directory's `package.json` `main`, else an index file. `known` holds every tracked path and every tracked-but-ignored one;
// `textOf` reads a package.json. The first match in the developer's tree wins, as it would there; when that file is one a clean
// checkout lacks, the caller reports it.
function resolveOn(base, known, textOf, withExtensions) {
  for (const extension of withExtensions ? EXTENSIONS : [''])
    if (known.has(`${base}${extension}`)) return `${base}${extension}`;
  if (!withExtensions) return undefined;
  const manifest = `${base}/package.json`;
  if (known.has(manifest)) {
    let main;
    try {
      main = JSON.parse(textOf(manifest) ?? '{}').main;
    } catch {}
    if (typeof main === 'string') {
      const target = normalize(`${base}/${main}`);
      const found =
        target === undefined
          ? undefined
          : [...EXTENSIONS, ...INDEXES.map((index) => `/${index}`)]
              .map((suffix) => `${target}${suffix}`)
              .find((file) => known.has(file));
      if (found) return found;
    }
    // the manifest itself is a file the import reads
  }
  for (const index of INDEXES) if (known.has(`${base}/${index}`)) return `${base}/${index}`;
  return known.has(manifest) ? manifest : undefined;
}

// The files `path` reaches, one level: an import or require resolved the way Node does it, and any other string that is exactly
// the path of a known file (a spawned script, `new URL('./x.mjs', import.meta.url)`, a path from the root). A query or a hash on a
// specifier (`./helper.mjs?fixture`) is not part of the path.
function targetsOf(path, { specifiers, literals }, known, textOf) {
  const found = new Set();
  const consider = (candidate, withExtensions) => {
    const base = normalize(candidate.replace(/[?#].*$/, ''));
    if (base === undefined) return;
    // A TypeScript source is imported as `./x.js` too.
    for (const stem of withExtensions ? [base, base.replace(/\.js$/, '')] : [base]) {
      const file = resolveOn(stem, known, textOf, withExtensions);
      if (file !== undefined && file !== path) return void found.add(file);
    }
  };
  for (const specifier of specifiers) consider(dirOf(path) + specifier, true);
  for (const literal of literals) consider(literal.startsWith('.') ? dirOf(path) + literal : literal, false);
  return found;
}
// `files` maps a tracked path to its text; `gone` are tracked paths that .gitignore also covers (a file waiting to be untracked: a
// clean checkout of the change does not have it, so a file that reaches one is a reader and it is not scanned itself).
// Returns one line per reader, `path: reaches target, which ...`, for a file that gets to a gone file through imports, requires or
// spawned paths, followed to a fixed point.
export function findReaders(files, gone) {
  const scripts = new Map([...files].filter(([path]) => SCRIPT.test(path) && !gone.has(path)));
  const found = [];
  // path -> the gone file it leads to
  const reads = new Map();
  const scans = new Map([...scripts].map(([path, text]) => [path, scan(text)]));
  for (const path of gone) reads.set(path, `${path} (tracked, and covered by .gitignore: not in a clean checkout)`);
  // Every tracked path, not only the scripts: a require of './recording' may resolve to a .json, a directory to its package.json.
  const known = new Set([...files.keys(), ...gone]);
  const textOf = (path) => files.get(path);
  const edges = new Map([...scans].map(([path, result]) => [path, targetsOf(path, result, known, textOf)]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [path, targets] of edges) {
      if (reads.has(path)) continue;
      const via = [...targets].find((target) => reads.has(target));
      if (!via) continue;
      reads.set(path, reads.get(via));
      found.push(`${path}: reaches ${via}, which leads to ${reads.get(via)}`);
      grew = true;
    }
  }
  return found;
}

// The test targets Cargo discovers in a package directory (`dir`, '' for the root): `tests/<name>.rs` and `tests/<name>/main.rs`
// among `entries` (the files and folders directly in `<dir>/tests`, folders ending in `/`, each with `hasMain` for a folder).
export function testTargetsOf(dir, entries) {
  const base = dir ? `${dir}/tests/` : 'tests/';
  return entries.flatMap(({ name, hasMain }) =>
    name.endsWith('/') ? (hasMain ? [`${base}${name}main.rs`] : []) : name.endsWith('.rs') ? [`${base}${name}`] : []
  );
}

// `targets` are the Cargo test targets on disk, of which every one not in `tracked` is refused.
export const buildViolations = ({ targets, tracked }) =>
  targets
    .filter((path) => !tracked.has(path))
    .map((path) => `${path} is a Cargo test target on disk that is not tracked`);

// NUL-delimited: the newline form quotes a path with non-ASCII bytes (`"tests/caf\303\251.rs"`), which would match no path.
function lsFiles(root, ...args) {
  return execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);
}

// The test targets on disk of the packages whose `manifests` (repository paths) are given. Cargo follows a symlink in `tests/`: a
// linked `.rs` file is a target, and a linked folder is one when it holds `main.rs`; a dangling link counts by its name.
export function testTargetsOnDisk(root, manifests) {
  return manifests.flatMap((manifest) => {
    const dir = posix.dirname(manifest) === '.' ? '' : posix.dirname(manifest);
    const tests = join(root, dir, 'tests');
    if (!existsSync(tests)) return [];
    const entries = readdirSync(tests, { withFileTypes: true }).map((entry) => {
      const path = join(tests, entry.name);
      const folder =
        entry.isDirectory() || (entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory());
      return folder ? { name: `${entry.name}/`, hasMain: existsSync(join(path, 'main.rs')) } : { name: entry.name };
    });
    return testTargetsOf(dir, entries);
  });
}

// `--build` over the checkout at `root`.
export function buildCheck(root) {
  const tracked = new Set(lsFiles(root));
  // Every package of the tree: the directory of each tracked Cargo.toml.
  const targets = testTargetsOnDisk(
    root,
    [...tracked].filter((path) => posix.basename(path) === 'Cargo.toml')
  );
  return buildViolations({ targets, tracked });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const mode = process.argv[2] ?? '--readers';
  let found;
  if (mode === '--readers') {
    // Tracked and ignored at once: waiting to be untracked, so not part of a clean checkout of the change.
    const gone = new Set(lsFiles(root, '-c', '-i', '--exclude-standard'));
    // Scripts and package manifests are read; every other tracked path is only a name a specifier can resolve to.
    const files = new Map(
      lsFiles(root)
        .filter((path) => existsSync(join(root, path)))
        .map((path) => [
          path,
          SCRIPT.test(path) || /(?:^|\/)package\.json$/.test(path) ? readFileSync(join(root, path), 'utf8') : '',
        ])
    );
    found = findReaders(files, gone);
  } else if (mode === '--build') {
    found = buildCheck(root);
  } else {
    throw new Error(`unknown mode ${mode} (--readers | --build)`);
  }
  for (const line of found) {
    console.error(line);
    // The reader scan is advisory in the gate (continue-on-error): in Actions each hit is also a warning annotation.
    if (mode === '--readers' && process.env.GITHUB_ACTIONS) console.log(`::warning::${line}`);
  }
  if (found.length > 0) {
    console.error(
      `${found.length} file(s) a clean checkout would not have or would not build (docs/testing.md, "What each layer guarantees")`
    );
    process.exit(1);
  }
  console.log(`clean checkout (${mode.slice(2)}): ok`);
}
