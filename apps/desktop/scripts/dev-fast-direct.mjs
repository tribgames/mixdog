import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPackageWithOptions,
  extractAll,
  extractFile,
  listPackage,
  statFile,
} from '@electron/asar';

const require = createRequire(import.meta.url);
const { readAsarHeader } = require('app-builder-lib/out/asar/asar.js');
const {
  NtExecutable,
  NtExecutableResource,
  Resource,
} = require('resedit');

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

export function changedPlanGroups(planned = {}, current = {}) {
  return Object.keys(current).filter(
    (name) => planned?.[name]?.hash !== current?.[name]?.hash,
  );
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
const ignoredSource = /(?:^|[\\/])(?:node_modules|out|dist|target|\.cache|\.runtime)(?:[\\/]|$)|(?:^|[\\/]).*\.(?:test|spec)\.[^.]+$/i;
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
    join(repoRoot, 'package.json'),
    join(repoRoot, 'package-lock.json'),
    join(desktopDir, 'package-lock.json'),
    join(repoRoot, 'scripts', 'prune-embedding-runtime.mjs'),
    join(repoRoot, 'scripts', 'runtime-dependency-cache-key.mjs'),
    join(desktopDir, 'scripts', 'prepare-runtime.mjs'),
    join(repoRoot, 'native', 'mixdog-browser-import'),
  ],
  package: [
    join(desktopDir, 'package.json'),
    join(desktopDir, 'package-lock.json'),
    join(desktopDir, 'electron-builder.yml'),
    join(desktopDir, 'build'),
    join(desktopDir, 'scripts', 'generate-brand-icons.mjs'),
    join(desktopDir, 'scripts', 'dev-fast-direct.mjs'),
    join(desktopDir, 'scripts', 'dev-update-windows.ps1'),
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
      type = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
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

async function filesForInput(input) {
  let pending = inputFiles.get(input);
  if (!pending) {
    pending = walkFiles(input, []);
    inputFiles.set(input, pending);
  }
  return pending;
}

async function contentsForFile(path) {
  let pending = fileContents.get(path);
  if (!pending) {
    pending = readFile(path);
    fileContents.set(path, pending);
  }
  return pending;
}

async function metadataForFile(path) {
  let pending = fileMetadata.get(path);
  if (!pending) {
    pending = stat(path);
    fileMetadata.set(path, pending);
  }
  return pending;
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
  return Buffer.from(JSON.stringify(
    packagingManifestForFingerprint(JSON.parse(contents.toString('utf8'))),
  ));
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
  const files = [];
  for (const input of inputs) files.push(...await filesForInput(input));
  files.sort((left, right) => left.localeCompare(right));
  const details = new Array(files.length);
  await mapPool(files, 12, async (file, index) => {
    const [metadata, contents] = await Promise.all([
      metadataForFile(file),
      contentsForFingerprint(file),
    ]);
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

export function decidePlan({
  previous,
  groups,
  installedMatches,
  bootstrapFresh,
  forceFull = false,
}) {
  if (forceFull) {
    const changed = Object.fromEntries(
      Object.keys(targetInputs).map((name) => [
        name,
        previous?.schemaVersion !== schemaVersion
          || previous.groups?.[name]?.hash !== groups[name].hash,
      ]),
    );
    changed.package = true;
    return {
      full: true,
      bootstrap: false,
      targets: [],
      daemon: false,
      runtime: false,
      changed,
    };
  }
  if (previous?.schemaVersion === schemaVersion && installedMatches) {
    const changed = Object.fromEntries(
      Object.keys(targetInputs).map((name) => [
        name,
        previous.groups?.[name]?.hash !== groups[name].hash,
      ]),
    );
    const full = changed.package;
    return {
      full,
      bootstrap: false,
      targets: full
        ? []
        : ['main', 'preload', 'renderer'].filter((name) => changed[name]),
      daemon: !full && changed.daemon,
      runtime: !full && changed.runtime,
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
      package: groups.package.newestMtimeMs > bootstrapFresh.package,
    };
    const full = changed.package;
    return {
      full,
      bootstrap: true,
      targets: full
        ? []
        : ['main', 'preload', 'renderer'].filter((name) => changed[name]),
      daemon: !full && changed.daemon,
      runtime: !full,
      changed,
    };
  }

  return {
    full: true,
    bootstrap: false,
    targets: [],
    daemon: false,
    runtime: false,
    changed: Object.fromEntries(Object.keys(targetInputs).map((name) => [name, true])),
  };
}

async function currentGroups() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(targetInputs).map(async ([name, inputs]) => [
        name,
        await fingerprint(inputs),
      ]),
    ),
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

async function currentPrebuilt(groups) {
  const packageMtimeMs = groups.package.newestMtimeMs;
  return {
    renderer: await artifactFresh(
      join(desktopDir, 'out', 'renderer', 'index.html'),
      Math.max(groups.renderer.newestMtimeMs, packageMtimeMs),
    ),
    main: await artifactFresh(
      join(desktopDir, 'out', 'main', 'index.js'),
      Math.max(groups.main.newestMtimeMs, packageMtimeMs),
    ),
    preload: await artifactFresh(
      join(desktopDir, 'out', 'preload', 'index.js'),
      Math.max(groups.preload.newestMtimeMs, packageMtimeMs),
    ),
    daemon: await artifactFresh(
      join(desktopDir, 'out', 'main', 'daemon.cjs'),
      Math.max(groups.daemon.newestMtimeMs, packageMtimeMs),
    ),
  };
}

async function installedHashes(installDir) {
  const resources = join(installDir, 'resources');
  const appAsar = join(resources, 'app.asar');
  const runtimeAsar = join(resources, 'runtime.asar');
  return {
    appAsar: await hashFile(appAsar),
    runtimeAsar: await hashFile(runtimeAsar),
    browserImportNativeTools: await hashBrowserImportNativeTools(
      join(resources, 'native-tools'),
    ),
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
  const renderer = await stat(join(desktopDir, 'out', 'renderer', 'index.html'));
  const main = await stat(join(desktopDir, 'out', 'main', 'index.js'));
  const preload = await stat(join(desktopDir, 'out', 'preload', 'index.js'));
  const daemon = await stat(join(desktopDir, 'out', 'main', 'daemon.cjs'));
  return {
    renderer: renderer.mtimeMs,
    main: main.mtimeMs,
    preload: preload.mtimeMs,
    daemon: daemon.mtimeMs,
    package: installedExe.mtimeMs,
  };
}

async function createPlan({ installDir, statePath, planPath, forceFull = false }) {
  const groups = await currentGroups();
  const prebuilt = await currentPrebuilt(groups);
  const previous = await readState(statePath);
  const hashes = await installedHashes(installDir);
  const installedMatches = Boolean(
    previous
    && previous.installDir === resolve(installDir)
    && previous.installed?.appAsar === hashes.appAsar
    && previous.installed?.runtimeAsar === hashes.runtimeAsar
    && previous.installed?.browserImportNativeTools === hashes.browserImportNativeTools,
  );
  const bootstrap = previous ? null : await bootstrapFreshness(installDir);
  const decision = decidePlan({
    previous,
    groups,
    installedMatches,
    bootstrapFresh: bootstrap,
    forceFull,
  });
  const plan = {
    schemaVersion,
    installDir: resolve(installDir),
    statePath: resolve(statePath),
    groups,
    prebuilt,
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
  resources.entries = resources.entries.filter(
    (entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'),
  );
  resources.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    bin: Buffer.from(JSON.stringify(
      Object.entries(integrity).map(([file, value]) => ({
        file: file.replaceAll('/', '\\'),
        alg: value.algorithm,
        value: value.hash,
      })),
    )),
    lang: languages[0].lang,
    codepage: languages[0].codepage,
  });
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

async function stageShell({ installDir, artifactDir, plan }) {
  const startedAt = performance.now();
  const installedResources = join(installDir, 'resources');
  const installedArchive = join(installedResources, 'app.asar');
  const artifactResources = join(artifactDir, 'resources');
  const artifactArchive = join(artifactResources, 'app.asar');
  const installedIntegrity = await hashAsarHeader(installedArchive);
  const cacheParent = join(desktopDir, '.cache', 'dev-fast-direct-shell');
  const stagingRoot = join(cacheParent, installedIntegrity.hash);
  const cacheMarker = `${stagingRoot}.ready`;
  let cacheHit = await pathExists(cacheMarker) && await pathExists(stagingRoot);

  await mkdir(cacheParent, { recursive: true });
  if (!cacheHit) {
    const temporary = `${stagingRoot}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    extractAll(installedArchive, temporary);
    await rm(join(temporary, 'out'), { recursive: true, force: true });
    await rm(join(temporary, ...ptyPackageSegments), { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    await rename(temporary, stagingRoot);
    await writeFile(cacheMarker, `${installedIntegrity.hash}\n`);
    cacheHit = false;
  }

  for (const entry of await readdir(cacheParent, { withFileTypes: true })) {
    const path = join(cacheParent, entry.name);
    if (path === stagingRoot || path === cacheMarker) continue;
    await rm(path, { recursive: entry.isDirectory(), force: true });
  }

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactResources, { recursive: true });
  await rm(join(stagingRoot, 'out'), { recursive: true, force: true });
  // `dereference` because a snapshot deploy links `out/` back to the real
  // checkout: without it fs.cp tries to RECREATE that junction inside the
  // staging root and Windows refuses the symlink outright (EPERM).
  await cp(join(desktopDir, 'out'), join(stagingRoot, 'out'), {
    recursive: true,
    dereference: true,
  });
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
    throw new Error(
      `FastDirect could not stage the PTY package from ${sourcePtyPackage}: ${error.message}`,
    );
  }
  const ptyBinding = join(stagedPtyPackage, 'build', 'Release', 'pty.node');
  if (!(await stat(ptyBinding).catch(() => null))?.isFile()) {
    throw new Error(`FastDirect artifact is missing the unpacked PTY binding: ${ptyBinding}`);
  }
  const artifactExe = join(artifactDir, 'Mixdog.exe');
  await cp(join(installDir, 'Mixdog.exe'), artifactExe);
  const runtimeArchive = plan.runtime
    ? join(desktopDir, '.runtime', 'runtime.asar')
    : join(installedResources, 'runtime.asar');
  await replaceWinAsarIntegrity(artifactExe, {
    'resources/app.asar': await hashAsarHeader(artifactArchive),
    'resources/runtime.asar': await hashAsarHeader(runtimeArchive),
  });
  process.stdout.write(
    `[fastdirect] staged app shell in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`
    + ` (template cache ${cacheHit ? 'hit' : 'miss'})\n`,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;
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
        `FastDirect inputs changed after planning/build (${changed.join(', ')}); rerun the deploy so stale artifacts are never installed`,
      );
    }
    process.stdout.write('[fastdirect] planned inputs are still current\n');
    return;
  }
  if (action === 'stage-shell') {
    await stageShell({
      installDir,
      artifactDir: resolve(args.artifact || join(desktopDir, '.cache', 'dev-fast-direct-artifact')),
      plan,
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
