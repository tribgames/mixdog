import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackageWithOptions, listPackage, statFile } from '@electron/asar';
import {
  embeddingRuntimeTarget,
  pruneEmbeddingRuntime,
} from '../../../scripts/prune-embedding-runtime.mjs';
import { runtimeDependencyCacheIdentity } from '../../../scripts/runtime-dependency-cache-key.mjs';
import { ensureGraphBinary } from '../../../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';
import { ensurePatchBinary } from '../../../src/runtime/agent/orchestrator/tools/patch-binary-fetcher.mjs';
import { ensureSpawnBinary } from '../../../src/runtime/agent/orchestrator/tools/spawn-binary-fetcher.mjs';
import { ensureTokenAddon } from '../../../src/runtime/agent/orchestrator/tools/token-addon-fetcher.mjs';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');
const runtimeDir = join(desktopDir, '.runtime');
const stagingDir = join(runtimeDir, 'staging');
const runtimePackageDir = join(stagingDir, 'node_modules', 'mixdog');
const runtimeArchive = join(runtimeDir, 'runtime.asar');
const runtimeSidecar = `${runtimeArchive}.unpacked`;
const builderNativeModulesDir = join(runtimeDir, 'native-modules');
const desktopPtyPackageDir = join(
  desktopDir,
  'node_modules',
  '@homebridge',
  'node-pty-prebuilt-multiarch',
);
const builderDesktopPtyDir = join(runtimeDir, 'desktop-node-pty');
const desktopNativeToolsDir = join(runtimeDir, 'native-tools');
const runtimeManifestPath = join(runtimeDir, 'manifest.json');
const preparedRuntimeSchema = 1;
const DESKTOP_NATIVE_FILES = Object.freeze({
  graph: process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph',
  patch: process.platform === 'win32' ? 'mixdog-patch.exe' : 'mixdog-patch',
  spawn: process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn',
  token: 'mixdog-token.node',
});
const configuredNpmCacheDir = String(process.env.MIXDOG_RUNTIME_NPM_CACHE ?? '').trim();
const npmCacheDir = configuredNpmCacheDir
  ? resolve(configuredNpmCacheDir)
  : join(runtimeDir, 'npm-cache');
const ownsNpmCache = !configuredNpmCacheDir;
if (!ownsNpmCache && (npmCacheDir === runtimeDir || npmCacheDir.startsWith(`${runtimeDir}${sep}`))) {
  throw new Error('MIXDOG_RUNTIME_NPM_CACHE must point outside the disposable .runtime directory.');
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('prepare-runtime must be run from npm.');
const optionValue = (name) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
};
const embeddingTarget = embeddingRuntimeTarget({
  platform: optionValue('platform') || undefined,
  arch: optionValue('arch') || undefined,
});
const configuredDependencyCacheDir = String(
  process.env.MIXDOG_RUNTIME_DEPENDENCY_CACHE ?? '',
).trim();
const dependencyCacheDir = configuredDependencyCacheDir
  ? resolve(configuredDependencyCacheDir)
  : join(desktopDir, '.cache', 'runtime-dependencies', embeddingTarget.key);
if (
  dependencyCacheDir === runtimeDir
  || dependencyCacheDir.startsWith(`${runtimeDir}${sep}`)
) {
  throw new Error(
    'MIXDOG_RUNTIME_DEPENDENCY_CACHE must point outside the disposable .runtime directory.',
  );
}
const dependencyCacheIdentity = await runtimeDependencyCacheIdentity(rootDir, embeddingTarget);

function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

async function timed(label, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    console.log(`[prepare-runtime] ${label}: ${elapsedMs(startedAt)}ms`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runtimePackageSource(entryPath) {
  const relativePath = String(entryPath).replaceAll('/', sep);
  const source = resolve(rootDir, relativePath);
  if (source !== rootDir && !source.startsWith(`${rootDir}${sep}`)) {
    throw new Error(`Refusing to package a path outside the Mixdog root: ${entryPath}`);
  }
  return { relativePath, source };
}

async function resolveRuntimePackageManifest() {
  const { stdout } = await runNpm(
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: rootDir,
      maxBuffer: 16 * 1024 * 1024,
      useRuntimeCache: false,
    },
  );
  const [manifest] = JSON.parse(stdout);
  if (!manifest?.files?.length) throw new Error('npm pack returned no Mixdog runtime files.');
  return manifest;
}

async function runtimeInputFingerprint(manifest) {
  const packageFiles = [];
  const sortedEntries = [...manifest.files].sort((left, right) => (
    String(left.path).localeCompare(String(right.path))
  ));
  for (const entry of sortedEntries) {
    const { source } = runtimePackageSource(entry.path);
    packageFiles.push({
      path: String(entry.path).replaceAll('\\', '/'),
      sha256: sha256(await readFile(source)),
    });
  }
  const [preparationSource, desktopLockfile] = await Promise.all([
    readFile(fileURLToPath(import.meta.url)),
    readFile(join(desktopDir, 'package-lock.json')),
  ]);
  return sha256(JSON.stringify({
    schemaVersion: preparedRuntimeSchema,
    target: embeddingTarget.key,
    dependencies: dependencyCacheIdentity,
    preparationSha256: sha256(preparationSource),
    desktopLockfileSha256: sha256(desktopLockfile),
    packageFiles,
  }));
}

async function canReusePreparedRuntime(fingerprint) {
  try {
    const manifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== preparedRuntimeSchema
      || manifest.target !== embeddingTarget.key
      || manifest.fingerprint !== fingerprint
    ) {
      return false;
    }
    const archive = await stat(runtimeArchive);
    if (!archive.isFile() || archive.size !== manifest.runtimeArchiveBytes) return false;
    await Promise.all([
      access(runtimeSidecar),
      access(builderNativeModulesDir),
      access(join(builderDesktopPtyDir, 'package.json')),
      ...Object.values(DESKTOP_NATIVE_FILES).map((file) => access(join(desktopNativeToolsDir, file))),
    ]);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Ignoring unusable prepared runtime: ${error?.message || error}`);
    }
    return false;
  }
}

async function prepareDesktopNativeTools() {
  if (embeddingTarget.platform !== process.platform || embeddingTarget.arch !== process.arch) {
    throw new Error(
      `Desktop native tools require a matching build runner: target=${embeddingTarget.key}, `
      + `host=${process.platform}-${process.arch}.`,
    );
  }
  const downloadDataDir = join(runtimeDir, 'native-downloads');
  const resolved = await Promise.all([
    ensureGraphBinary(downloadDataDir),
    ensurePatchBinary(downloadDataDir),
    ensureSpawnBinary(downloadDataDir),
    ensureTokenAddon(downloadDataDir),
  ]);
  await rm(desktopNativeToolsDir, { recursive: true, force: true });
  await mkdir(desktopNativeToolsDir, { recursive: true });
  for (const [kind, source] of Object.entries({
    graph: resolved[0],
    patch: resolved[1],
    spawn: resolved[2],
    token: resolved[3],
  })) {
    const destination = join(desktopNativeToolsDir, DESKTOP_NATIVE_FILES[kind]);
    await cp(source, destination);
    if (process.platform !== 'win32' && kind !== 'token') await chmod(destination, 0o755);
  }
  await rm(downloadDataDir, { recursive: true, force: true });
}

async function restoreRuntimeDependencies() {
  if (!dependencyCacheIdentity) return false;
  try {
    const manifest = JSON.parse(
      await readFile(join(dependencyCacheDir, 'manifest.json'), 'utf8'),
    );
    if (
      manifest.schemaVersion !== dependencyCacheIdentity.schemaVersion
      || manifest.target !== dependencyCacheIdentity.target
      || manifest.host !== dependencyCacheIdentity.host
      || manifest.nodeAbi !== dependencyCacheIdentity.nodeAbi
      || manifest.fingerprint !== dependencyCacheIdentity.fingerprint
    ) {
      return false;
    }
    const cachedNodeModules = join(dependencyCacheDir, 'node_modules');
    await access(cachedNodeModules);
    await cp(cachedNodeModules, join(stagingDir, 'node_modules'), { recursive: true });
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Ignoring unusable runtime dependency cache: ${error?.message || error}`);
    }
    return false;
  }
}

async function storeRuntimeDependencies() {
  if (!dependencyCacheIdentity) return;
  const temporaryCacheDir = `${dependencyCacheDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    await rm(temporaryCacheDir, { recursive: true, force: true });
    await mkdir(temporaryCacheDir, { recursive: true });
    await cp(
      join(stagingDir, 'node_modules'),
      join(temporaryCacheDir, 'node_modules'),
      { recursive: true },
    );
    await writeFile(
      join(temporaryCacheDir, 'manifest.json'),
      `${JSON.stringify(dependencyCacheIdentity, null, 2)}\n`,
    );
    await rm(dependencyCacheDir, { recursive: true, force: true });
    await rename(temporaryCacheDir, dependencyCacheDir);
  } catch (error) {
    await rm(temporaryCacheDir, { recursive: true, force: true });
    console.warn(`Unable to update runtime dependency cache: ${error?.message || error}`);
  }
}

function runNpm(args, options = {}) {
  const { env, useRuntimeCache = true, ...execOptions } = options;
  const mergedEnv = { ...process.env, ...env };
  if (useRuntimeCache) mergedEnv.npm_config_cache = npmCacheDir;
  return execFileAsync(process.execPath, [npmCli, ...args], {
    windowsHide: true,
    ...execOptions,
    // Local preparation keeps tarballs/logs in a disposable cache so repeated
    // packaging cannot grow AppData by gigabytes. CI supplies its restored
    // setup-node cache explicitly, avoiding the same dependency downloads on
    // every platform build while leaving local cleanup behavior unchanged.
    env: mergedEnv,
  });
}

async function prepareRuntime(manifest, fingerprint) {
  // Windows: deleting a large just-written tree races AV/indexer scans, which
  // surfaces as spurious ENOTEMPTY/EPERM rmdir failures. Same bounded-retry
  // policy as the cleanup block below.
  await rm(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await mkdir(runtimeDir, { recursive: true });
  let prepared = false;

  try {
    await timed('native-tools', () => prepareDesktopNativeTools());
    await timed('desktop-node-pty', () => cp(
      desktopPtyPackageDir,
      builderDesktopPtyDir,
      { recursive: true },
    ));
    // The staging install only needs the production dependency tree. The repo's
    // postinstall (embedding prune + native asset fetch) is driven explicitly by
    // this script, and prepare-native-assets.mjs imports from src/, which is not
    // staged until the runtime package copy below — so letting `npm ci` run it
    // fails the install. Stripping scripts leaves the lockfile tree unchanged.
    await mkdir(stagingDir, { recursive: true });
    const stagingPackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
    delete stagingPackage.scripts;
    await writeFile(join(stagingDir, 'package.json'), `${JSON.stringify(stagingPackage, null, 2)}\n`);
    await cp(join(rootDir, 'package-lock.json'), join(stagingDir, 'package-lock.json'));
    await mkdir(join(stagingDir, 'scripts'), { recursive: true });
    await cp(
      join(rootDir, 'scripts', 'prune-embedding-runtime.mjs'),
      join(stagingDir, 'scripts', 'prune-embedding-runtime.mjs'),
    );

    let restoredDependencies = await timed(
      'dependency-cache-restore',
      () => restoreRuntimeDependencies(),
    );
    let prunedEmbedding;
    if (restoredDependencies) {
      try {
        // A restored tree must still pass the same completeness checks and
        // idempotent platform pruning as a fresh npm install.
        prunedEmbedding = await timed(
          'cached-dependency-validation',
          () => pruneEmbeddingRuntime(stagingDir, embeddingTarget),
        );
        console.log(`Reused cached ${embeddingTarget.key} runtime dependencies.`);
      } catch (error) {
        console.warn(`Cached runtime dependencies failed validation: ${error?.message || error}`);
        await rm(join(stagingDir, 'node_modules'), {
          recursive: true, force: true, maxRetries: 10, retryDelay: 250,
        });
        restoredDependencies = false;
      }
    }
    if (!restoredDependencies) {
      await timed('npm-ci', () => runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: stagingDir,
        env: {
          MIXDOG_EMBED_TARGET_PLATFORM: embeddingTarget.platform,
          MIXDOG_EMBED_TARGET_ARCH: embeddingTarget.arch,
        },
      }));
      prunedEmbedding = await timed(
        'dependency-prune',
        () => pruneEmbeddingRuntime(stagingDir, embeddingTarget),
      );
      await timed('dependency-cache-store', () => storeRuntimeDependencies());
    }

    await timed('runtime-package-copy', async () => {
      await mkdir(runtimePackageDir, { recursive: true });
      for (const entry of manifest.files) {
        const { relativePath, source } = runtimePackageSource(entry.path);
        const destination = join(runtimePackageDir, relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, { recursive: true });
      }
    });

    const runtimePackage = JSON.parse(await readFile(join(stagingDir, 'package.json'), 'utf8'));
    runtimePackage.private = true;
    runtimePackage.name = '@mixdog/desktop-runtime';
    delete runtimePackage.scripts;
    delete runtimePackage.devDependencies;
    await writeFile(join(stagingDir, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);

    // NSIS is very slow when it has to create the production dependency tree one
    // file at a time. Electron reads ASARs directly, so install one archive and
    // unpack only native addons that the OS loader must access as real files.
    // @electron/asar crawls the staging tree first and only then lstats every
    // entry it collected. On Windows a real-time AV scan can hold a freshly
    // installed dependency file across that gap, so the lstat reports ENOENT for
    // a path that exists before and after the pack — two consecutive runs died
    // on different random files (hono/dist/types.js, discord-api-types
    // /payloads/v9/oauth2.js.map). Bounded retries absorb the same race the
    // embedding prune already retries around, and only for transient
    // filesystem codes: a missing input the crawl never saw still fails loudly.
    // Each attempt discards the partial archive and sidecar so a retry never
    // packs on top of half-written output.
    await timed('asar-create', async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await createPackageWithOptions(stagingDir, runtimeArchive, {
            dot: true,
            // @electron/asar matches this against absolute Windows paths with
            // matchBase enabled. A basename glob is therefore portable; **/*.node is
            // not, because minimatch treats Windows separators differently.
            unpack: '*.{node,dll,dylib,so,so.*}',
          });
          return;
        } catch (error) {
          const transient = ['ENOENT', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'UNKNOWN']
            .includes(error?.code);
          if (!transient || attempt >= 5) throw error;
          console.warn(
            `ASAR pack attempt ${attempt} failed with ${error.code} at `
            + `${error.path || 'an unreported path'}; retrying from a clean archive.`,
          );
          await rm(runtimeArchive, { force: true, maxRetries: 10, retryDelay: 250 });
          await rm(runtimeSidecar, {
            recursive: true, force: true, maxRetries: 10, retryDelay: 250,
          });
          await new Promise((done) => { setTimeout(done, 500 * attempt); });
        }
      }
    });

    const archiveEntries = new Set(
      listPackage(runtimeArchive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/')),
    );
    const ortArchiveRoot = relative(stagingDir, prunedEmbedding.ortRoot).replaceAll(sep, '/');
    const embeddingNapiRoot = `/${ortArchiveRoot}/bin/napi-v3`;
    const embeddingPlatformRoot = `${embeddingNapiRoot}/${embeddingTarget.platform}`;
    const embeddingBinaryRoot = `/${ortArchiveRoot}/bin/napi-v3/${embeddingTarget.platform}/${embeddingTarget.arch}`;
    for (const required of [
      '/package.json',
      '/node_modules/mixdog/package.json',
      '/node_modules/mixdog/src/tui/session.mjs',
      '/node_modules/@huggingface/transformers/package.json',
      '/node_modules/@huggingface/transformers/dist/transformers.node.cjs',
      '/node_modules/@huggingface/transformers/dist/transformers.node.mjs',
      `/${ortArchiveRoot}/package.json`,
      `${embeddingBinaryRoot}/onnxruntime_binding.node`,
    ]) {
      if (!archiveEntries.has(required)) {
        throw new Error(`Runtime archive is incomplete: missing ${required}`);
      }
    }
    const foreignEmbeddingBinary = [...archiveEntries].find((entry) => (
      entry.startsWith(`${embeddingNapiRoot}/`)
        && entry !== embeddingPlatformRoot
        && entry !== embeddingBinaryRoot
        && !entry.startsWith(`${embeddingBinaryRoot}/`)
    ));
    if (foreignEmbeddingBinary) {
      throw new Error(`Runtime archive contains a foreign embedding binary: ${foreignEmbeddingBinary}`);
    }
    if ([...archiveEntries].some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry))) {
      throw new Error('Runtime archive contains unused onnxruntime-web payloads.');
    }

    const nativeBinaryEntries = [...archiveEntries].filter(
      (entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry),
    );
    await timed('native-module-mirror', async () => {
      for (const entry of nativeBinaryEntries) {
        const archivePath = entry.replace(/^\/+/, '');
        const metadata = statFile(runtimeArchive, archivePath.replaceAll('/', sep));
        if (!metadata.unpacked) {
          throw new Error(`Native addon is not marked unpacked in runtime.asar: ${entry}`);
        }

        const pathParts = archivePath.split('/');
        const source = join(runtimeSidecar, ...pathParts);
        await access(source);

        // electron-builder filters paths containing a source node_modules
        // directory. Stage its contents under a neutral name, then map that neutral
        // root back to the exact runtime.asar.unpacked/node_modules destination.
        if (pathParts.shift() !== 'node_modules') {
          throw new Error(`Native addon is outside the supported runtime node_modules layout: ${entry}`);
        }
        const destination = join(builderNativeModulesDir, ...pathParts);
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination);
      }
    });

    const archive = await stat(runtimeArchive);
    await writeFile(runtimeManifestPath, `${JSON.stringify({
      schemaVersion: preparedRuntimeSchema,
      target: embeddingTarget.key,
      fingerprint,
      runtimeArchiveBytes: archive.size,
    }, null, 2)}\n`);
    prepared = true;
    console.log(
      `Prepared ${embeddingTarget.key} runtime.asar with ${archiveEntries.size} entries, including ` +
        `${manifest.files.length} Mixdog package files and ${nativeBinaryEntries.length} unpacked native binary file(s).`,
    );
  } finally {
    // `npm ci`, ASAR creation, or native mirroring can all fail after creating
    // hundreds of MiB. Always remove transient state; on failure also discard
    // the partial archive/sidecar so the next build starts from a clean slate.
    await timed('cleanup', async () => {
      const cleanup = [
        rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }),
      ];
      if (ownsNpmCache) {
        cleanup.push(rm(npmCacheDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 250,
        }));
      }
      await Promise.all(cleanup);
      if (!prepared) {
        await rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      }
    });
  }
}

// Preparation is exclusive per checkout. Every run starts by deleting and
// rebuilding .runtime, so two overlapping deployments destroyed each other: the
// second wiped the staging tree the first was packing into runtime.asar, which
// surfaced as ENOENT on a different random dependency file every attempt and,
// once the deletion won the race outright, as an archive missing /package.json.
// A later run now waits for the holder instead, and then normally takes the
// fingerprint reuse path rather than repeating the whole preparation.
const runtimeLockPath = join(desktopDir, '.cache', 'prepare-runtime.lock');
const runtimeLockTimeoutMs = 30 * 60 * 1000;

function lockHolderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another account; only ESRCH proves the
    // holder is gone and its lock can be reclaimed.
    return error?.code === 'EPERM';
  }
}

async function acquireRuntimeLock() {
  await mkdir(dirname(runtimeLockPath), { recursive: true });
  const deadline = Date.now() + runtimeLockTimeoutMs;
  let announcedHolder = 0;
  let unreadablePolls = 0;
  for (;;) {
    try {
      const handle = await open(runtimeLockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          target: embeddingTarget.key,
          startedAt: new Date().toISOString(),
        }));
      } finally {
        await handle.close();
      }
      return () => rm(runtimeLockPath, { force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try {
      holder = JSON.parse(await readFile(runtimeLockPath, 'utf8'));
      unreadablePolls = 0;
    } catch {
      // The holder creates the file before writing its payload. An unreadable
      // lock only counts as abandoned once it stays that way across polls.
      unreadablePolls += 1;
    }
    if (holder ? !lockHolderAlive(holder.pid) : unreadablePolls > 3) {
      console.warn(`Reclaiming an abandoned runtime preparation lock: ${runtimeLockPath}`);
      await rm(runtimeLockPath, { force: true, maxRetries: 5, retryDelay: 250 });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Runtime preparation is still held by pid ${holder?.pid ?? 'unknown'} `
        + `after ${Math.round(runtimeLockTimeoutMs / 60000)} minutes: ${runtimeLockPath}`,
      );
    }
    if (holder && holder.pid !== announcedHolder) {
      announcedHolder = holder.pid;
      console.log(`Waiting for the runtime preparation held by pid ${holder.pid}.`);
    }
    await new Promise((done) => { setTimeout(done, 1000); });
  }
}

const preparationStartedAt = performance.now();
const releaseRuntimeLock = await timed('preparation-lock', () => acquireRuntimeLock());
try {
  const manifest = await timed('package-manifest', () => resolveRuntimePackageManifest());
  const fingerprint = await timed(
    'input-fingerprint',
    () => runtimeInputFingerprint(manifest),
  );
  if (await timed('prepared-runtime-check', () => canReusePreparedRuntime(fingerprint))) {
    console.log(`Reused prepared ${embeddingTarget.key} runtime.asar.`);
  } else {
    await prepareRuntime(manifest, fingerprint);
  }
} finally {
  await releaseRuntimeLock();
  console.log(`[prepare-runtime] total: ${elapsedMs(preparationStartedAt)}ms`);
}
