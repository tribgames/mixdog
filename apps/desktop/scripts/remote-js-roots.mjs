// The production dependencies of the remote JS runtime, derived from what its entry points can load,
// so the list cannot drift from the code: a package some entry reaches is a root, a package nothing
// reaches is not shipped.
//
// Entries: the ext-host worker (office, PDF, OCR, render), the skill script entry and every shipped skill
// script (`remoteJsEntries`). The walk follows
// relative imports and `new URL('./x.mjs', import.meta.url)` workers inside the directories the
// extension host runs (`SCOPE`); a file outside them that those files import is a helper: its own bare
// imports count, its imports are not followed. Following them is not sound: office/index.mjs reaches the
// agent runtime through a barrel whose packages (MCP, mail, providers) are loaded only by code the
// extension host never calls. The ext-host e2e suites, run against the trimmed bundle, confirm the set.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const FIXED_ENTRIES = Object.freeze(['src/ext-host/worker.mjs', 'src/skill-script-entry.mjs']);
const SKILLS_DIR = 'src/defaults/skills';

/** The fixed entries plus every shipped skill script (`src/defaults/skills/<skill>/scripts/**.mjs`, tests
 *  aside): the skill entry loads whichever script it is given, and these run in the full runtime, so each
 *  is walked in full like the skill entry. */
export function remoteJsEntries(packageRootDir) {
  const scripts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(packageRootDir, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs') && /\/scripts\//.test(path) && !NOT_SHIPPED.test(path)) scripts.push(path);
    }
  };
  if (existsSync(join(packageRootDir, SKILLS_DIR))) walk(SKILLS_DIR);
  return [...FIXED_ENTRIES, ...scripts.sort()];
}
const SCOPE = /^src\/(ext-host|runtime\/office|runtime\/attachments)\//;
const NOT_SHIPPED = /\.(test|slow\.test|e2e\.test)\.mjs$|\/test\//;

const BUILTINS = new Set(builtinModules);
const RELATIVE =
  /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*(['"])(\.[^'"]+)\1|(?:^|\n)\s*import\s*(['"])(\.[^'"]+)\3|\bimport\s*\(\s*(['"])(\.[^'"]+)\5\s*\)|\bnew URL\(\s*(['"])(\.[^'"]+)\7\s*,\s*import\.meta\.url/g;
const BARE =
  /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*(['"])([^'".][^'"]*)\1|(?:^|\n)\s*import\s*(['"])([^'".][^'"]*)\3|\b(?:import|require|require\.resolve)\s*\(\s*(['"])([^'".][^'"]*)\5\s*\)/g;
const PACKAGE_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;

const packageName = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const resolveFile = (base) =>
  [base, `${base}.mjs`, join(base, 'index.mjs')].find((file) => existsSync(file) && statSync(file).isFile()) ?? null;

/** `{ roots: Map<package, files that import it>, files, reached }` for the entries under `packageRootDir`:
 *  `files` counts the files the walk reached and `reached` lists them (relative, sorted). */
export function deriveRemoteRoots({ packageRootDir, entries = remoteJsEntries(packageRootDir) }) {
  const relative = (file) => file.slice(packageRootDir.length + 1).replaceAll('\\', '/');
  const roots = new Map();
  const visited = new Set();
  const note = (file) => {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(BARE)) {
      const specifier = match[2] ?? match[4] ?? match[6];
      const bare = specifier.replace(/^node:/, '');
      if (BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0])) continue;
      const name = packageName(specifier);
      if (!PACKAGE_NAME.test(name)) continue;
      roots.set(name, [...(roots.get(name) ?? []), relative(file)]);
    }
    return source;
  };
  // An entry outside SCOPE (the skill entry) is small and followed in full; SCOPE bounds the extension host's.
  const queue = entries.map((entry) => ({ file: join(packageRootDir, entry), all: !SCOPE.test(entry) }));
  while (queue.length) {
    const { file, all } = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = note(file);
    for (const match of source.matchAll(RELATIVE)) {
      const target = resolveFile(resolve(dirname(file), match[2] ?? match[4] ?? match[6] ?? match[8]));
      if (!target || NOT_SHIPPED.test(relative(target))) continue;
      if (all || SCOPE.test(relative(target))) queue.push({ file: target, all });
      else if (!visited.has(target)) {
        visited.add(target);
        note(target);
      }
    }
  }
  return { roots, files: visited.size, reached: [...visited].map(relative).sort() };
}

/**
 * The root manifest and lockfile cut down to `roots`: `dependencies` are exactly the roots (versions from
 * the root manifest, pins from the lockfile) and the lockfile keeps only the packages they reach.
 * Throws when a root is not a dependency of the package or has no lockfile entry.
 */
export function trimManifest({ manifest, lock, roots, target }) {
  const dependencies = {};
  for (const name of [...roots].sort()) {
    const wanted = manifest.dependencies?.[name];
    if (!wanted) throw new Error(`${name} is reached from the remote entry points but is not a dependency in package.json`);
    if (!lock.packages[`node_modules/${name}`]) throw new Error(`${name} is reached from the remote entry points but is not in package-lock.json`);
    dependencies[name] = wanted;
  }
  const lookup = (from, name) => {
    for (let at = from; ; ) {
      const candidate = `${at}${at ? '/' : ''}node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      if (!at) return null;
      const cut = at.lastIndexOf('/node_modules/');
      at = cut < 0 ? '' : at.slice(0, cut);
    }
  };
  const keep = new Set();
  const inapplicable = new Set();
  const visit = (path) => {
    if (keep.has(path)) return;
    keep.add(path);
    const entry = lock.packages[path];
    for (const [kind, group] of [['dependency', entry.dependencies], ['optional dependency', entry.optionalDependencies], ['peer dependency', entry.peerDependencies]]) {
      for (const name of Object.keys(group ?? {})) {
        const found = lookup(path, name);
        if (found) {
          if (fitsTarget(name, lock.packages[found], target)) visit(found);
          else inapplicable.add(name);
        } else if (kind === 'peer dependency' && entry.peerDependenciesMeta?.[name]?.optional) {
          // The package itself says this peer is not required.
        } else {
          // An optional dependency is absent from the lockfile only if something is wrong with it: npm
          // records every platform variant, so "not for this platform" is read from the entry's own fields.
          throw new Error(`${name} (${kind} of ${path}) is reached but missing from package-lock.json`);
        }
      }
    }
  };
  for (const name of Object.keys(dependencies)) visit(`node_modules/${name}`);
  const packages = { '': { ...lock.packages[''], dependencies } };
  delete packages[''].devDependencies;
  delete packages[''].optionalDependencies;
  for (const path of Object.keys(lock.packages)) if (keep.has(path)) packages[path] = lock.packages[path];
  const trimmed = {
    ...manifest,
    dependencies,
    devDependencies: undefined,
    optionalDependencies: undefined,
    scripts: undefined,
    overrides: Object.fromEntries(Object.entries(manifest.overrides ?? {}).filter(([name]) => keepsName(keep, name))),
  };
  return { manifest: JSON.parse(JSON.stringify(trimmed)), lock: { ...lock, packages }, kept: keep.size, inapplicable };
}

const allowed = (list, value) =>
  !list || list.length === 0 || (list.some((item) => item.startsWith('!')) ? !list.includes(`!${value}`) : list.includes(value));

/** Packages that declare no `os`/`cpu`/`libc` yet are not for the remote's plain Node, by exact name. */
export const NOT_FOR_REMOTE = Object.freeze({
  '@img/sharp-wasm32': "sharp's wasm build, which sharp loads only under Electron on Linux; the remote's Node uses the native @img package",
});

/** Whether a package installs on `target` ({ os, cpu, libc? }): its declared os/cpu/libc (npm's rules) and
 *  the exact-name list above. `entry` is a lockfile entry or the package's own package.json; the lockfile
 *  lacks `libc` for the musl variants, so after the install the package.json fields decide too. */
export const fitsTarget = (name, entry, target) =>
  !target ||
  (!(name in NOT_FOR_REMOTE) &&
    allowed(entry.os, target.os) &&
    allowed(entry.cpu, target.cpu) &&
    (!target.libc || allowed(entry.libc, target.libc)));

const keepsName = (keep, name) => [...keep].some((path) => path.endsWith(`node_modules/${name}`));

/** Every package directory of an installed tree: `[name, dir, package.json]`. */
function installedPackages(modulesDir) {
  const found = [];
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) if (scoped.isDirectory()) add(`${entry.name}/${scoped.name}`, join(path, scoped.name));
      } else add(entry.name, path);
    }
  };
  const add = (name, dir) => {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) return;
    found.push([name, dir, JSON.parse(readFileSync(file, 'utf8'))]);
    scan(join(dir, 'node_modules'));
  };
  scan(modulesDir);
  return found;
}

/** Removes the installed packages whose own package.json says they are not for `target`; returns their names. */
export function pruneInapplicable(modulesDir, target) {
  const removed = new Set();
  for (const [name, dir, manifest] of installedPackages(modulesDir)) {
    if (fitsTarget(name, manifest, target)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.add(name);
  }
  return removed;
}

/**
 * Throws unless everything the installed tree needs is installed: for every package (and the root
 * `pkgDir/package.json`), each dependency resolves from its directory upward. A missing optional
 * dependency is fine only if it is in `inapplicable` (not for the target by its own fields); a missing
 * optional peer is fine because the package's own `peerDependenciesMeta` says so.
 */
export function verifyInstalledTree(pkgDir, inapplicable) {
  const modulesDir = join(pkgDir, 'node_modules');
  const resolves = (from, name) => {
    for (let at = from; ; at = dirname(at)) {
      if (existsSync(join(at, 'node_modules', name, 'package.json'))) return true;
      if (at === pkgDir || at === dirname(at)) return false;
    }
  };
  const owners = [['(root)', pkgDir, JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))], ...installedPackages(modulesDir)];
  for (const [owner, dir, manifest] of owners) {
    for (const [kind, group] of [['dependency', manifest.dependencies], ['optional dependency', manifest.optionalDependencies], ['peer dependency', manifest.peerDependencies]]) {
      for (const name of Object.keys(group ?? {})) {
        if (resolves(dir, name)) continue;
        if (kind === 'optional dependency' && inapplicable.has(name)) continue;
        if (kind === 'peer dependency' && manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`${name} (${kind} of ${owner}) is reached but not installed`);
      }
    }
  }
}
