import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
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
const schemaVersion = 1;
const ignoredSource = /(?:^|[\\/])(?:node_modules|out|dist|target|\.cache|\.runtime)(?:[\\/]|$)|(?:^|[\\/]).*\.(?:test|spec)\.[^.]+$/i;

const targetInputs = {
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
    join(repoRoot, 'scripts', 'prune-embedding-runtime.mjs'),
    join(repoRoot, 'scripts', 'runtime-dependency-cache-key.mjs'),
    join(desktopDir, 'scripts', 'prepare-runtime.mjs'),
  ],
  package: [
    join(desktopDir, 'package.json'),
    join(desktopDir, 'package-lock.json'),
    join(desktopDir, 'electron-builder.yml'),
    join(desktopDir, 'build'),
    join(desktopDir, 'scripts', 'generate-brand-icons.mjs'),
    join(repoRoot, 'native', 'mixdog-token'),
    join(repoRoot, 'scripts', 'build-token-addon.mjs'),
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

async function walkFiles(input, files = []) {
  if (!(await pathExists(input)) || ignoredSource.test(input)) return files;
  const metadata = await stat(input);
  if (metadata.isFile()) {
    files.push(input);
    return files;
  }
  const entries = await readdir(input, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await walkFiles(join(input, entry.name), files);
  }
  return files;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const contents = await readFile(path);
  hash.update(contents);
  return hash.digest('hex');
}

async function fingerprint(inputs) {
  const files = [];
  for (const input of inputs) await walkFiles(input, files);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  let newestMtimeMs = 0;
  for (const file of files) {
    const metadata = await stat(file);
    newestMtimeMs = Math.max(newestMtimeMs, metadata.mtimeMs);
    hash.update(relative(repoRoot, file).replaceAll(sep, '/'));
    hash.update('\0');
    hash.update(String(metadata.size));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), newestMtimeMs, fileCount: files.length };
}

export function decidePlan({ previous, groups, installedMatches, bootstrapFresh }) {
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

async function installedHashes(installDir) {
  const resources = join(installDir, 'resources');
  const appAsar = join(resources, 'app.asar');
  const runtimeAsar = join(resources, 'runtime.asar');
  return {
    appAsar: await hashFile(appAsar),
    runtimeAsar: await hashFile(runtimeAsar),
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
    const archivePath = relative(desktopDir, file).replaceAll('/', sep);
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

async function createPlan({ installDir, statePath, planPath }) {
  const groups = await currentGroups();
  const previous = await readState(statePath);
  const hashes = await installedHashes(installDir);
  const installedMatches = Boolean(
    previous
    && previous.installDir === resolve(installDir)
    && previous.installed?.appAsar === hashes.appAsar
    && previous.installed?.runtimeAsar === hashes.runtimeAsar,
  );
  const bootstrap = previous ? null : await bootstrapFreshness(installDir);
  const decision = decidePlan({
    previous,
    groups,
    installedMatches,
    bootstrapFresh: bootstrap,
  });
  const plan = {
    schemaVersion,
    installDir: resolve(installDir),
    statePath: resolve(statePath),
    groups,
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
  const installedResources = join(installDir, 'resources');
  const installedArchive = join(installedResources, 'app.asar');
  const stagingRoot = join(artifactDir, 'staging');
  const artifactResources = join(artifactDir, 'resources');
  const artifactArchive = join(artifactResources, 'app.asar');
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactResources, { recursive: true });
  extractAll(installedArchive, stagingRoot);
  await rm(join(stagingRoot, 'out'), { recursive: true, force: true });
  await cp(join(desktopDir, 'out'), join(stagingRoot, 'out'), { recursive: true });
  await rm(join(stagingRoot, 'out', 'main', 'capture-window.js'), { force: true });
  await createPackageWithOptions(stagingRoot, artifactArchive, {
    unpackDir: 'out',
  });
  for (const file of [
    'out/main/daemon.cjs',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
  ]) {
    if (!statFile(artifactArchive, file.replaceAll('/', sep), false).unpacked) {
      throw new Error(`FastDirect artifact did not unpack ${file}`);
    }
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
  await rm(stagingRoot, { recursive: true, force: true });
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
    const plan = await createPlan({ installDir, statePath, planPath });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
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
