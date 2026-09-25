import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPackageWithOptions, extractFile, listPackage, statFile } from '@electron/asar';

const require = createRequire(import.meta.url);
const { readAsarHeader } = require('app-builder-lib/out/asar/asar.js');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '../..');
const schemaVersion = 2;
const desktopPackageManifest = join(desktopDir, 'package.json');

export function asarPath(path) {
  return String(path).replace(/[\\/]+/g, sep);
}

export function fastDirectAsarOptions() {
  return {
    unpack: 'daemon.cjs',
    unpackDir: asarPath('out/renderer'),
  };
}

export function fastDirectRuntimeArchive(installedResources) {
  return join(installedResources, 'runtime.asar');
}

export function changedPlanGroups(planned = {}, current = {}) {
  return Object.keys(current).filter((name) => planned?.[name]?.hash !== current?.[name]?.hash);
}

function packagedAsarPosixPath(entry) {
  return String(entry).replaceAll('\\', '/').replace(/^\//, '');
}

function packagedAsarFileSet(archivePath) {
  const files = new Set();
  for (const entry of listPackage(archivePath)) {
    const posix = packagedAsarPosixPath(entry);
    if (posix) files.add(posix);
  }
  return files;
}

function nodeModuleSearchDirs(fromDir) {
  const dirs = [];
  let current = fromDir;
  while (true) {
    dirs.push(current ? `${current}/node_modules` : 'node_modules');
    if (!current) break;
    const slash = current.lastIndexOf('/');
    current = slash === -1 ? '' : current.slice(0, slash);
  }
  return dirs;
}

function productionDependencyEntries(manifest) {
  const objectKeys = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);
  const optional = new Set(objectKeys(manifest?.optionalDependencies));
  return [...new Set([...objectKeys(manifest?.dependencies), ...optional])]
    .sort()
    .map((name) => ({ name, optional: optional.has(name) }));
}

async function readPackagedPackageJson(archivePath, asarFiles, unpackedRoot, packageDir) {
  const posixPath = packageDir ? `${packageDir}/package.json` : 'package.json';
  if (asarFiles.has(posixPath)) {
    const filename = asarPath(posixPath);
    const meta = statFile(archivePath, filename, false);
    if (!meta.unpacked) {
      return JSON.parse(extractFile(archivePath, filename).toString('utf8'));
    }
  }
  if (!unpackedRoot) return null;
  try {
    return JSON.parse(await readFile(join(unpackedRoot, ...posixPath.split('/')), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

export class MissingProductionDependencyError extends Error {
  constructor(chain) {
    super(`Packaged app.asar is missing production dependency ${chain.join(' > ')}`);
    this.name = 'MissingProductionDependencyError';
    this.chain = chain;
  }
}

export function planForceFullForMissingProductionDependency(error) {
  if (!(error instanceof MissingProductionDependencyError)) throw error;
  return true;
}

/**
 * Verify that `archivePath` contains the recursive production dependency
 * closure of its packaged package.json (`dependencies` + `optionalDependencies`).
 * Packages listed in asarUnpack are satisfied from the sibling
 * `app.asar.unpacked` tree, or from `unpackedPackages` when the caller will
 * stage them there. Missing optional deps are allowed.
 */
export async function assertPackagedProductionDependencyClosure(archivePath, options = {}) {
  const asarFiles = packagedAsarFileSet(archivePath);
  const unpackedRoot = Object.hasOwn(options, 'unpackedDir') ? options.unpackedDir : `${archivePath}.unpacked`;
  const unpackedPackages = new Set(options.unpackedPackages || []);
  const unpackedAllowlist = Symbol('unpacked-allowlist');
  const manifests = new Map();
  const visited = new Set();

  const readManifest = async (packageDir) => {
    const key = packageDir || '.';
    if (manifests.has(key)) return manifests.get(key);
    const manifest = await readPackagedPackageJson(archivePath, asarFiles, unpackedRoot, packageDir);
    manifests.set(key, manifest);
    return manifest;
  };

  const resolvePackage = async (fromDir, name) => {
    for (const modulesDir of nodeModuleSearchDirs(fromDir)) {
      const candidate = `${modulesDir}/${name}`;
      if (await readManifest(candidate)) return candidate;
    }
    if (unpackedPackages.has(name)) return unpackedAllowlist;
    return null;
  };

  const walk = async (packageDir, chain) => {
    const key = packageDir || '.';
    if (visited.has(key)) return;
    visited.add(key);
    const manifest = await readManifest(packageDir);
    if (!manifest) {
      if (chain.length === 0) throw new Error('Packaged app.asar is missing package.json');
      throw new MissingProductionDependencyError(chain);
    }
    for (const { name, optional } of productionDependencyEntries(manifest)) {
      const resolved = await resolvePackage(packageDir, name);
      if (resolved === unpackedAllowlist) continue;
      if (resolved == null) {
        if (optional) continue;
        throw new MissingProductionDependencyError([...chain, name]);
      }
      await walk(resolved, [...chain, name]);
    }
  };

  await walk('', []);
}

const repoPackageManifest = join(repoRoot, 'package.json');
// electron-builder keeps this package unpacked (asarUnpack). The daemon runs
// from app.asar.unpacked and resolves it through the real file system, and a
// native binding cannot be dlopen'd from inside the archive, so an incremental
// artifact that repacks it leaves the installed app with no terminals at all.
const ptyPackageSegments = ['node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'];
const browserImportNativeFileNames = [
  'mixdog-browser-import.exe',
  'bitwarden_chromium_import_helper.exe',
  'LICENSE_GPL.txt',
  'browser-import-NOTICE.txt',
];
const runtimeDependencyInputs = [
  join(repoRoot, 'package.json'),
  join(repoRoot, 'package-lock.json'),
  join(desktopDir, 'package-lock.json'),
  join(repoRoot, 'scripts', 'prune-embedding-runtime.mjs'),
  join(repoRoot, 'scripts', 'prune-desktop-runtime.mjs'),
  join(repoRoot, 'scripts', 'native-binary-arch.mjs'),
  join(repoRoot, 'scripts', 'native-tool-download.mjs'),
  join(repoRoot, 'scripts', 'runtime-dependency-cache-key.mjs'),
  join(desktopDir, 'scripts', 'prepare-runtime.mjs'),
  join(desktopDir, 'scripts', 'prepare-fast-runtime-code.mjs'),
  join(desktopDir, 'scripts', 'cli-args.mjs'),
  join(desktopDir, 'scripts', 'runtime-package-payload.mjs'),
  join(repoRoot, 'native', 'mixdog-browser-import'),
];
const ignoredSource =
  /(?:^|[\\/])(?:node_modules|out|dist|target|\.cache|\.runtime)(?:[\\/]|$)|(?:^|[\\/]).*\.(?:test|spec)\.[^.]+$/i;
const fileContents = new Map();
const fileMetadata = new Map();
const inputFiles = new Map();

export const targetInputs = {
  renderer: [
    join(desktopDir, 'src', 'renderer'),
    join(desktopDir, 'src', 'shared'),
    join(desktopDir, 'vendor'),
    join(desktopDir, 'electron.vite.config.ts'),
  ],
  main: [
    join(desktopDir, 'src', 'main'),
    join(desktopDir, 'src', 'shared'),
    join(desktopDir, 'electron.vite.config.ts'),
  ],
  preload: [
    join(desktopDir, 'src', 'preload'),
    join(desktopDir, 'src', 'shared'),
    join(desktopDir, 'electron.vite.config.ts'),
  ],
  daemon: [
    join(repoRoot, 'src'),
    join(repoRoot, 'package.json'),
    join(repoRoot, 'package-lock.json'),
    join(desktopDir, 'src', 'main'),
    join(desktopDir, 'src', 'shared'),
    join(desktopDir, 'scripts', 'build-daemon.mjs'),
  ],
  runtime: [
    join(repoRoot, 'src'),
    join(repoRoot, 'scripts'),
    join(repoRoot, 'vendor'),
    join(repoRoot, 'LICENSES'),
    join(repoRoot, 'README.md'),
    join(repoRoot, 'NOTICE.md'),
    join(repoRoot, 'package.json'),
    ...runtimeDependencyInputs,
  ],
  runtimeDependencies: runtimeDependencyInputs,
  package: [
    join(desktopDir, 'package.json'),
    join(desktopDir, 'package-lock.json'),
    join(desktopDir, 'electron-builder.yml'),
    join(desktopDir, 'build'),
    join(desktopDir, 'scripts', 'generate-brand-icons.mjs'),
  ],
};

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    const match = /^--([^=]+)=(.*)$/s.exec(entry);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function walkFiles(input, files = [], knownType = '') {
  if (ignoredSource.test(input)) return files;
  let type = knownType;
  if (!type) {
    try {
      const metadata = await stat(input);
      if (metadata.isDirectory()) type = 'directory';
      else type = metadata.isFile() ? 'file' : 'other';
    } catch (error) {
      if (error?.code === 'ENOENT') return files;
      throw error;
    }
  }
  if (type === 'file') {
    files.push(input);
    return files;
  }
  if (type !== 'directory') return files;
  const entries = await readdir(input, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(input, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) await walkFiles(path, files, 'directory');
    else await walkFiles(path, files);
  }
  return files;
}

function memoized(cache, key, start) {
  let pending = cache.get(key);
  if (!pending) {
    pending = start();
    cache.set(key, pending);
  }
  return pending;
}

async function filesForInput(input) {
  return memoized(inputFiles, input, () => walkFiles(input, []));
}

async function contentsForFile(path) {
  return memoized(fileContents, path, () => readFile(path));
}

async function metadataForFile(path) {
  return memoized(fileMetadata, path, () => stat(path));
}

async function mapPool(items, limit, run) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index], index);
    }
  });
  await Promise.all(lanes);
}

/** Commands and test-list edits do not change the packaged application.
 * Keep runtime/package metadata while excluding the scripts object that made
 * harmless developer workflow edits trigger a complete win-unpacked build. */
export function packagingManifestForFingerprint(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.scripts;
  return normalized;
}

async function contentsForFingerprint(path) {
  const contents = await contentsForFile(path);
  const resolvedPath = resolve(path);
  if (resolvedPath !== desktopPackageManifest && resolvedPath !== repoPackageManifest) {
    return contents;
  }
  return Buffer.from(JSON.stringify(packagingManifestForFingerprint(JSON.parse(contents.toString('utf8')))));
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const contents = await contentsForFile(path);
  hash.update(contents);
  return hash.digest('hex');
}

export async function hashBrowserImportNativeTools(nativeToolsDir) {
  const hash = createHash('sha256');
  for (const fileName of browserImportNativeFileNames) {
    hash.update(fileName);
    hash.update('\0');
    try {
      const contents = await readFile(join(nativeToolsDir, fileName));
      hash.update('present');
      hash.update('\0');
      hash.update(contents);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('missing');
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

async function fingerprint(inputs) {
  const fileSet = new Set();
  for (const input of inputs) {
    for (const file of await filesForInput(input)) fileSet.add(file);
  }
  const files = [...fileSet];
  files.sort((left, right) => left.localeCompare(right));
  const details = new Array(files.length);
  await mapPool(files, 12, async (file, index) => {
    const [metadata, contents] = await Promise.all([metadataForFile(file), contentsForFingerprint(file)]);
    details[index] = { file, metadata, contents };
  });
  const hash = createHash('sha256');
  let newestMtimeMs = 0;
  for (const { file, metadata, contents } of details) {
    newestMtimeMs = Math.max(newestMtimeMs, metadata.mtimeMs);
    hash.update(relative(repoRoot, file).replaceAll(sep, '/'));
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), newestMtimeMs, fileCount: files.length };
}

export function runtimePackageFileForFingerprint(file) {
  const resolvedFile = resolve(file);
  if (
    runtimeDependencyInputs.some(
      (input) => resolvedFile === resolve(input) || resolvedFile.startsWith(`${resolve(input)}${sep}`)
    )
  ) {
    return true;
  }
  const path = relative(repoRoot, resolvedFile).replaceAll(sep, '/');
  if (path === 'src/tui/dev' || path.startsWith('src/tui/dev/')) return false;
  if (!path.startsWith('scripts/')) return true;
  const script = path.slice('scripts/'.length);
  if (script.startsWith('bench/')) return false;
  // package.json's scripts/* exclusions apply only to direct children. Nested
  // build helpers such as scripts/lib/stage-postgres-runtime-windows.ps1 are
  // published and must invalidate the runtime payload.
  if (script.includes('/')) return true;
  return !(
    /^recall-bench-.*\.txt$/i.test(script) ||
    /(?:-test|\.test|-smoke|-bench)\.mjs$/i.test(script) ||
    /^smoke-loop.*\.mjs$/i.test(script) ||
    /bench-.*\.mjs$/i.test(script) ||
    script === 'verify-embedding-runtime.mjs' ||
    /\.(?:ps1|jsx)$/i.test(script)
  );
}

async function runtimeFingerprint(inputs) {
  const files = new Set();
  for (const input of inputs) {
    for (const file of await filesForInput(input)) {
      if (runtimePackageFileForFingerprint(file)) files.add(file);
    }
  }
  return fingerprint([...files]);
}

const changedByGroup = (changed) => Object.fromEntries(Object.keys(targetInputs).map((name) => [name, changed(name)]));

function fullPlan(changed) {
  return { full: true, bootstrap: false, targets: [], daemon: false, runtime: false, runtimeMode: 'none', changed };
}

const buildTargets = (changed) => ['main', 'preload', 'renderer'].filter((name) => changed[name]);

// Schema 2 states created before runtimeDependencies existed used the
// developer deploy scripts as package inputs. Migrate that one state by
// comparing only real package inputs against the successful deploy time;
// a package file changed afterward still takes the complete fallback.
function migratePackageChange(previous, groups, changed) {
  if (previous.groups?.runtimeDependencies || !previous.deployedAt) return;
  const deployedAtMs = Date.parse(previous.deployedAt);
  if (Number.isFinite(deployedAtMs)) changed.package = groups.package.newestMtimeMs > deployedAtMs;
}

export function decidePlan({
  previous,
  groups,
  installedMatches,
  bootstrapFresh,
  devRuntimeReady = false,
  forceFull = false,
}) {
  if (forceFull) {
    const changed = changedByGroup(
      (name) => previous?.schemaVersion !== schemaVersion || previous.groups?.[name]?.hash !== groups[name].hash
    );
    changed.package = true;
    return fullPlan(changed);
  }
  if (previous?.schemaVersion === schemaVersion && installedMatches) {
    const changed = changedByGroup((name) => previous.groups?.[name]?.hash !== groups[name].hash);
    migratePackageChange(previous, groups, changed);
    const full = changed.package;
    const runtime = !full && changed.runtime;
    return {
      full,
      bootstrap: false,
      targets: full ? [] : buildTargets(changed),
      daemon: !full && changed.daemon,
      runtime,
      runtimeMode: runtimeMode(runtime, changed.runtimeDependencies || !devRuntimeReady),
      changed,
    };
  }

  if (bootstrapFresh) {
    const changed = {
      renderer: groups.renderer.newestMtimeMs > bootstrapFresh.renderer,
      main: groups.main.newestMtimeMs > bootstrapFresh.main,
      preload: groups.preload.newestMtimeMs > bootstrapFresh.preload,
      daemon: groups.daemon.newestMtimeMs > bootstrapFresh.daemon,
      runtime: true,
      runtimeDependencies: true,
      package: groups.package.newestMtimeMs > bootstrapFresh.package,
    };
    const full = changed.package;
    return {
      full,
      bootstrap: true,
      targets: full ? [] : buildTargets(changed),
      daemon: !full && changed.daemon,
      runtime: !full,
      runtimeMode: full ? 'none' : 'full',
      changed,
    };
  }

  return fullPlan(changedByGroup(() => true));
}

export async function installedFastRuntimeReady(installDir, dependencyHash) {
  try {
    const root = join(installDir, 'resources', 'fast-runtime');
    const marker = JSON.parse(await readFile(join(root, '.mixdog-fast-runtime.json'), 'utf8'));
    if (marker.schemaVersion !== 1 || marker.dependencyHash !== dependencyHash) return false;
    await stat(join(root, 'node_modules', 'mixdog', 'src', 'standalone', 'session-client.mjs'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function currentGroups() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(targetInputs).map(async ([name, inputs]) => [
        name,
        name === 'runtime' ? await runtimeFingerprint(inputs) : await fingerprint(inputs),
      ])
    )
  );
}

async function artifactFresh(path, newestInputMtimeMs) {
  try {
    return (await stat(path)).mtimeMs >= newestInputMtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// The build output that stands for each prebuilt target group.
const builtTargetArtifacts = {
  renderer: join(desktopDir, 'out', 'renderer', 'index.html'),
  main: join(desktopDir, 'out', 'main', 'index.js'),
  preload: join(desktopDir, 'out', 'preload', 'index.js'),
  daemon: join(desktopDir, 'out', 'main', 'daemon.cjs'),
};

async function currentPrebuilt(groups) {
  const packageMtimeMs = groups.package.newestMtimeMs;
  const prebuilt = {};
  for (const [name, artifact] of Object.entries(builtTargetArtifacts)) {
    prebuilt[name] = await artifactFresh(artifact, Math.max(groups[name].newestMtimeMs, packageMtimeMs));
  }
  return prebuilt;
}

async function installedHashes(installDir) {
  const resources = join(installDir, 'resources');
  const appAsar = join(resources, 'app.asar');
  const runtimeAsar = join(resources, 'runtime.asar');
  return {
    appAsar: await hashFile(appAsar),
    runtimeAsar: await hashFile(runtimeAsar),
    browserImportNativeTools: await hashBrowserImportNativeTools(join(resources, 'native-tools')),
  };
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function outputMatchesInstalled(installDir) {
  const archive = join(installDir, 'resources', 'app.asar');
  const unpacked = `${archive}.unpacked`;
  const outputFiles = [];
  await walkFiles(join(desktopDir, 'out'), outputFiles);
  for (const file of outputFiles) {
    const archivePath = asarPath(relative(desktopDir, file));
    if (archivePath.endsWith(`${sep}capture-window.js`) || archivePath.endsWith('.map')) continue;
    let installed;
    const metadata = statFile(archive, archivePath, false);
    if (metadata.unpacked) {
      installed = await readFile(join(unpacked, archivePath));
    } else {
      installed = extractFile(archive, archivePath);
    }
    const local = await readFile(file);
    if (!local.equals(installed)) return false;
  }
  return true;
}

async function bootstrapFreshness(installDir) {
  if (!(await outputMatchesInstalled(installDir))) return null;
  const installedExe = await stat(join(installDir, 'Mixdog.exe'));
  const freshness = {};
  for (const [name, artifact] of Object.entries(builtTargetArtifacts)) {
    freshness[name] = (await stat(artifact)).mtimeMs;
  }
  freshness.package = installedExe.mtimeMs;
  return freshness;
}

async function createPlan({ installDir, statePath, planPath, forceFull = false }) {
  const groups = await currentGroups();
  const prebuilt = await currentPrebuilt(groups);
  const previous = await readState(statePath);
  const hashes = await installedHashes(installDir);
  const installedMatches = Boolean(
    previous &&
      previous.installDir === resolve(installDir) &&
      previous.installed?.appAsar === hashes.appAsar &&
      previous.installed?.runtimeAsar === hashes.runtimeAsar &&
      previous.installed?.browserImportNativeTools === hashes.browserImportNativeTools
  );
  const bootstrap = previous ? null : await bootstrapFreshness(installDir);
  const devRuntimeReady = await installedFastRuntimeReady(installDir, groups.runtimeDependencies.hash);
  let forceFullPlan = forceFull;
  try {
    await assertPackagedProductionDependencyClosure(join(installDir, 'resources', 'app.asar'));
  } catch (error) {
    planForceFullForMissingProductionDependency(error);
    forceFullPlan = true;
    process.stderr.write(`[fastdirect] ${error.message}; forcing complete win-unpacked fallback\n`);
  }
  const decision = decidePlan({
    previous,
    groups,
    installedMatches,
    bootstrapFresh: bootstrap,
    devRuntimeReady,
    forceFull: forceFullPlan,
  });
  const plan = {
    schemaVersion,
    installDir: resolve(installDir),
    statePath: resolve(statePath),
    groups,
    prebuilt,
    devRuntimeReady,
    ...decision,
  };
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

async function hashAsarHeader(path) {
  const { header } = await readAsarHeader(path);
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(header).digest('hex'),
  };
}

async function replaceWinAsarIntegrity(executablePath, integrity) {
  const executable = NtExecutable.from(await readFile(executablePath));
  const resources = NtExecutableResource.from(executable);
  const versionInfo = Resource.VersionInfo.fromEntries(resources.entries);
  if (versionInfo.length !== 1) throw new Error(`Failed to parse version info in ${executablePath}`);
  const languages = versionInfo[0].getAllLanguagesForStringValues();
  if (languages.length !== 1) throw new Error(`Failed to locate language in ${executablePath}`);
  resources.entries = resources.entries.filter((entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'));
  resources.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    bin: Buffer.from(
      JSON.stringify(
        Object.entries(integrity).map(([file, value]) => ({
          file: file.replaceAll('/', '\\'),
          alg: value.algorithm,
          value: value.hash,
        }))
      )
    ),
    lang: languages[0].lang,
    codepage: languages[0].codepage,
  });
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

// The staging template replaces `out/` with the current build and re-stages the
// PTY package from the checkout, so neither is worth extracting from the
// installed archive.
export const stagedShellDiscardedPaths = ['out', join(...ptyPackageSegments)];

function isDiscardedStagedShellPath(relativePath) {
  return stagedShellDiscardedPaths.some(
    (discarded) => relativePath === discarded || relativePath.startsWith(`${discarded}${sep}`)
  );
}

// `extractAll` reads every entry, including the ones stageShell deletes again,
// so a single unreadable file under `out/` aborted a deploy that was about to
// overwrite that file anyway - as happened when Windows Defender quarantined one
// renderer locale asset out of app.asar.unpacked. This extracts only the entries
// the staging keeps, with extractAll's directory, symlink and executable-bit
// handling; a kept entry that cannot be read still fails the deploy.
export async function extractStagedShell(archivePath, destination) {
  // Creating symlinks on Windows needs elevation, so asar extracts links there
  // as plain files. Mirror that per-platform choice instead of inventing one.
  const followLinks = process.platform === 'win32';
  await mkdir(destination, { recursive: true });
  const failures = [];
  for (const entry of listPackage(archivePath)) {
    const relativePath = entry.replace(/^[\\/]+/, '');
    if (isDiscardedStagedShellPath(relativePath)) continue;
    const destinationPath = join(destination, relativePath);
    if (relative(destination, destinationPath).startsWith('..')) {
      throw new Error(`${entry}: file "${destinationPath}" writes out of the package`);
    }
    const node = statFile(archivePath, relativePath, followLinks);
    if ('files' in node) {
      await mkdir(destinationPath, { recursive: true });
      continue;
    }
    if ('link' in node) {
      const linkSource = dirname(join(destination, node.link));
      if (relative(destination, linkSource).startsWith('..')) {
        throw new Error(`${entry}: file "${node.link}" links out of the package to "${linkSource}"`);
      }
      // A link cannot be overwritten in place.
      await rm(destinationPath, { force: true });
      await symlink(join(relative(dirname(destinationPath), linkSource), basename(node.link)), destinationPath);
      continue;
    }
    try {
      await writeFile(destinationPath, extractFile(archivePath, relativePath, followLinks));
      if (node.executable) await chmod(destinationPath, '755');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new Error(
      `Unable to extract the installed app shell from ${archivePath}:\n\n` +
        failures.map((error) => error.stack).join('\n\n')
    );
  }
}

// One file of the staged tree. Windows file-system filters — search indexers and
// security products — can fail a CopyFileW with a status libuv cannot translate,
// and the deploy then dies on that same file every run. Moving the bytes through
// read/write never issues that call, and a bounded retry absorbs a lock that is
// still clearing rather than failing the whole deploy over one handle.
async function stageFile(source, destination, mode) {
  let failure;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await writeFile(destination, await readFile(source));
      await chmod(destination, mode);
      return;
    } catch (error) {
      failure = error;
      await new Promise((settle) => setTimeout(settle, 100 * (attempt + 1)));
    }
  }
  throw new Error(`FastDirect could not stage ${source}: ${failure?.message ?? failure}`);
}

async function stageTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    // stat, not the directory entry's own kind: a snapshot deploy links parts of
    // the tree back to the real checkout, and those links are followed here
    // rather than recreated inside the staging root, which Windows refuses.
    const info = await stat(from);
    if (info.isDirectory()) {
      await stageTree(from, to);
      continue;
    }
    await stageFile(from, to, info.mode);
  }
}

async function stageShell({ installDir, artifactDir }) {
  const startedAt = performance.now();
  const installedResources = join(installDir, 'resources');
  const installedArchive = join(installedResources, 'app.asar');
  const artifactResources = join(artifactDir, 'resources');
  const artifactArchive = join(artifactResources, 'app.asar');
  const installedIntegrity = await hashAsarHeader(installedArchive);
  const cacheParent = join(desktopDir, '.cache', 'dev-fast-direct-shell');
  const stagingRoot = join(cacheParent, installedIntegrity.hash);
  const cacheMarker = `${stagingRoot}.ready`;
  const cacheHit = (await pathExists(cacheMarker)) && (await pathExists(stagingRoot));

  await mkdir(cacheParent, { recursive: true });
  if (!cacheHit) {
    const temporary = `${stagingRoot}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await extractStagedShell(installedArchive, temporary);
    await rm(stagingRoot, { recursive: true, force: true });
    // Antivirus scans hold the just-extracted files open for a moment, and a
    // directory with any open handle inside cannot be renamed on Windows.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, stagingRoot);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await writeFile(cacheMarker, `${installedIntegrity.hash}\n`);
  }

  for (const entry of await readdir(cacheParent, { withFileTypes: true })) {
    const path = join(cacheParent, entry.name);
    if (path === stagingRoot || path === cacheMarker) continue;
    await rm(path, { recursive: entry.isDirectory(), force: true });
  }

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactResources, { recursive: true });
  await rm(join(stagingRoot, 'out'), { recursive: true, force: true });
  await stageTree(join(desktopDir, 'out'), join(stagingRoot, 'out'));
  await rm(join(stagingRoot, 'out', 'main', 'capture-window.js'), { force: true });
  await rm(join(stagingRoot, ...ptyPackageSegments), { recursive: true, force: true });
  try {
    await createPackageWithOptions(stagingRoot, artifactArchive, fastDirectAsarOptions());
  } finally {
    // The cache keeps only the immutable installed shell. Current build output
    // is short-lived so a failed stage cannot be mistaken for a clean template.
    await rm(join(stagingRoot, 'out'), { recursive: true, force: true });
  }
  for (const file of ['out/main/daemon.cjs', 'out/renderer/index.html']) {
    if (!statFile(artifactArchive, asarPath(file), false).unpacked) {
      throw new Error(`FastDirect artifact did not unpack ${file}`);
    }
  }
  for (const file of ['out/main/index.js', 'out/preload/index.js']) {
    if (statFile(artifactArchive, asarPath(file), false).unpacked) {
      throw new Error(`FastDirect artifact unexpectedly unpacked ${file}`);
    }
  }
  const sourcePtyPackage = join(desktopDir, ...ptyPackageSegments);
  const stagedPtyPackage = join(artifactResources, 'app.asar.unpacked', ...ptyPackageSegments);
  try {
    await cp(sourcePtyPackage, stagedPtyPackage, { recursive: true });
  } catch (error) {
    throw new Error(`FastDirect could not stage the PTY package from ${sourcePtyPackage}: ${error.message}`);
  }
  const ptyBinding = join(stagedPtyPackage, 'build', 'Release', 'pty.node');
  if (!(await stat(ptyBinding).catch(() => null))?.isFile()) {
    throw new Error(`FastDirect artifact is missing the unpacked PTY binding: ${ptyBinding}`);
  }
  await assertPackagedProductionDependencyClosure(artifactArchive);
  const artifactExe = join(artifactDir, 'Mixdog.exe');
  await cp(join(installDir, 'Mixdog.exe'), artifactExe);
  // Incremental FastDirect runtime updates live in resources/fast-runtime.
  // The signed shell still carries the production runtime.asar fallback, so
  // its integrity entry always names the installed archive.
  const runtimeArchive = fastDirectRuntimeArchive(installedResources);
  await replaceWinAsarIntegrity(artifactExe, {
    'resources/app.asar': await hashAsarHeader(artifactArchive),
    'resources/runtime.asar': await hashAsarHeader(runtimeArchive),
  });
  process.stdout.write(
    `[fastdirect] staged app shell in ${((performance.now() - startedAt) / 1000).toFixed(2)}s` +
      ` (template cache ${cacheHit ? 'hit' : 'miss'})\n`
  );
}

async function commitState({ installDir, statePath, plan }) {
  const state = {
    schemaVersion,
    installDir: resolve(installDir),
    groups: plan.groups,
    installed: await installedHashes(installDir),
    deployedAt: new Date().toISOString(),
  };
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await cp(temporary, statePath);
  await rm(temporary, { force: true });
}

/** How much of the runtime a refresh rebuilds: nothing, its code, or the
 *  dependency closure as well. */
function runtimeMode(runtime, dependenciesChanged) {
  if (!runtime) return 'none';
  return dependenciesChanged ? 'full' : 'code';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;
  if (action === 'assert-prod-deps') {
    let archivePath = '';
    if (args.asar) archivePath = resolve(args.asar);
    else if (args['install-dir']) archivePath = join(resolve(args['install-dir']), 'resources', 'app.asar');
    if (!archivePath) {
      throw new Error('--action=assert-prod-deps requires --asar=<path> or --install-dir=<dir>');
    }
    await assertPackagedProductionDependencyClosure(archivePath);
    return;
  }
  const installDir = resolve(args['install-dir'] || '');
  const statePath = resolve(args.state || join(desktopDir, '.cache', 'dev-fast-direct-state.json'));
  const planPath = resolve(args.plan || join(desktopDir, '.cache', 'dev-fast-direct-plan.json'));
  if (!action || !installDir) throw new Error('--action and --install-dir are required');
  if (action === 'plan') {
    const plan = await createPlan({
      installDir,
      statePath,
      planPath,
      forceFull: String(args['force-full']).toLowerCase() === 'true',
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  if (action === 'prebuilt') {
    const groups = await currentGroups();
    process.stdout.write(`${JSON.stringify(await currentPrebuilt(groups))}\n`);
    return;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (action === 'assert-current') {
    const changed = changedPlanGroups(plan.groups, await currentGroups());
    if (changed.length) {
      throw new Error(
        `FastDirect inputs changed after planning/build (${changed.join(', ')}); rerun the deploy so stale artifacts are never installed`
      );
    }
    process.stdout.write('[fastdirect] planned inputs are still current\n');
    return;
  }
  if (action === 'stage-shell') {
    await stageShell({
      installDir,
      artifactDir: resolve(args.artifact || join(desktopDir, '.cache', 'dev-fast-direct-artifact')),
    });
    return;
  }
  if (action === 'commit') {
    await commitState({ installDir, statePath, plan });
    return;
  }
  throw new Error(`Unknown action: ${action}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
