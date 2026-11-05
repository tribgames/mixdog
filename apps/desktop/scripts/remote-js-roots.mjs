// The production dependencies of the remote JS runtime, derived from what its entry points can load,
// so the list cannot drift from the code: a package some entry reaches is a root, a package nothing
// reaches is not shipped.
//
// Entries: the ext-host worker (office, PDF, OCR, render) and the skill script entry. The walk follows
// relative imports and `new URL('./x.mjs', import.meta.url)` workers inside the directories the
// extension host runs (`SCOPE`); a file outside them that those files import is a helper: its own bare
// imports count, its imports are not followed. Following them is not sound: office/index.mjs reaches the
// agent runtime through a barrel whose packages (MCP, mail, providers) are loaded only by code the
// extension host never calls. The ext-host e2e suites, run against the trimmed bundle, confirm the set.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export const REMOTE_JS_ENTRIES = Object.freeze(['src/ext-host/worker.mjs', 'src/skill-script-entry.mjs']);
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

/** `{ roots: Map<package, files that import it>, files }` for the entries under `packageRootDir`. */
export function deriveRemoteRoots({ packageRootDir, entries = REMOTE_JS_ENTRIES }) {
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
  return { roots, files: visited.size };
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
  const visit = (path) => {
    if (keep.has(path)) return;
    keep.add(path);
    const entry = lock.packages[path];
    for (const group of [entry.dependencies, entry.optionalDependencies, entry.peerDependencies]) {
      for (const name of Object.keys(group ?? {})) {
        const found = lookup(path, name);
        if (found && !fitsTarget(name, lock.packages[found], target)) continue;
        if (found) visit(found);
        else if (group !== entry.optionalDependencies && group !== entry.peerDependencies) {
          throw new Error(`${name} (needed by ${path}) is not in package-lock.json`);
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
  return { manifest: JSON.parse(JSON.stringify(trimmed)), lock: { ...lock, packages }, kept: keep.size };
}

const allowed = (list, value) =>
  !list || list.length === 0 || (list.some((item) => item.startsWith('!')) ? !list.includes(`!${value}`) : list.includes(value));

/** Whether the lockfile entry of package `name` installs on `target` ({ os, cpu, libc? }): npm's os/cpu/libc
 *  fields. The trim applies them itself because the lockfile carries no `libc` for the musl variants and no
 *  `cpu` for the wasm one, so npm installs both next to the native build whatever `--libc` says. Those are
 *  recognised by name: `…musl…` on a glibc target, and the `…-wasm32` build, which only Electron on Linux uses. */
export const fitsTarget = (name, entry, target) =>
  !target ||
  (allowed(entry.os, target.os) &&
    allowed(entry.cpu, target.cpu) &&
    (!target.libc || allowed(entry.libc, target.libc)) &&
    !(target.libc === 'glibc' && /musl/.test(name)) &&
    !/-wasm32$/.test(name));

const keepsName =(keep, name) => [...keep].some((path) => path.endsWith(`node_modules/${name}`));
