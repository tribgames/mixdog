import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { embeddingRuntimeTarget, WINDOWS_DML_PRUNABLE_FILES } from '../../../scripts/prune-embedding-runtime.mjs';
import { pruneDesktopRuntime } from '../../../scripts/prune-desktop-runtime.mjs';
import { nativeBinaryRunsOn } from '../../../scripts/native-binary-arch.mjs';
import { downloadNativeTool, nativeToolInstalledName } from '../../../scripts/native-tool-download.mjs';
import { runtimeDependencyCacheIdentity } from '../../../scripts/runtime-dependency-cache-key.mjs';
import { optionValue } from './cli-args.mjs';
import {
  desktopExtraRoots,
  mirrorCoreRuntime,
  onnxRuntimeSupported,
  ORT_PACKAGE,
  ortBinaryDir,
  PACKAGE_DIR,
  WINDOWS_ONNX_VC_RUNTIME_DLLS,
} from './core-layout.mjs';
import { copyRuntimePackagePayload, runtimePackageSource } from './runtime-package-payload.mjs';
import { copyPptxgenjsData, installProductionModules, launcherRuntimeFiles } from './stage-js-bundle.mjs';

const execFileAsync = promisify(execFile);

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');
const runtimeDir = join(desktopDir, '.runtime');
const stagingDir = join(runtimeDir, 'staging');
const runtimePackageDir = join(stagingDir, 'node_modules', 'mixdog');
// Every file the app ships of the root package is a real file (the Rust core and the script interpreter read
// them with plain fs; built-in skills hand their directory to the model, which runs their bundled scripts with
// plain Node): electron-builder maps this tree to resources/runtime.asar.unpacked/node_modules, and no
// archive of it exists. Its name is the path the core's js-runtime.json and MIXDOG_ROOT already name.
const builderNativeModulesDir = join(runtimeDir, 'native-modules');
// The skill launcher (src/skill-script-entry.mjs, src/runtime/shared/skill-script-runtime.mjs) is
// checked as part of CORE_READS / the core closure. K1 retired the Node skill scripts (validate-skill,
// the pptx scripts) with their Node consumers, so no script is bundled or run here.
// The tools the app executes (native_tools.rs resolves only these): the patch engine and the process
// manager are libraries of the core now, so their standalone binaries are neither downloaded nor packaged.
const DESKTOP_NATIVE_TOOL_KINDS = Object.freeze(['graph']);

const desktopNativeToolsDir = join(runtimeDir, 'native-tools');
const configuredBrowserImportNativeSourceDir = String(process.env.MIXDOG_BROWSER_IMPORT_NATIVE_DIR ?? '').trim();
let browserImportNativeSourceDir = '';
const browserImportNativeFileNames = [
  'mixdog-browser-import.exe',
  'bitwarden_chromium_import_helper.exe',
  'LICENSE_GPL.txt',
  'browser-import-NOTICE.txt',
];
// The Windows secure-desktop helper (UAC / lock / sign-in screens for the
// paired phone). Shipped with every Windows build; installed as a service only
// on the phone's request (apps/desktop/src/main/secure-desktop/).
const configuredSecureDesktopNativeSourceDir = String(process.env.MIXDOG_SECURE_DESKTOP_NATIVE_DIR ?? '').trim();
const secureDesktopNativeFileNames = ['mixdog-secure-desktop.exe', 'secure-desktop-NOTICE.txt'];
let secureDesktopNativeSourceDir = '';
let secureDesktopInputIdentity = null;
// The Windows window library that keeps the Mica frame painted active
// (apps/desktop/src/main/window-mica.ts). Shipped with every Windows build.
const windowLibraryFileNames = ['mixdog_window.node'];
let windowLibrarySourceDir = '';
let windowLibraryInputIdentity = null;
// The Node-API module of the main process on every platform (native/mixdog-main-native; the Browser Use URL and
// redaction rules, loaded by src/main/native-module.ts). Shipped with every build; a build without it fails.
const mainNativeFileName = 'mixdog_main_native.node';
let mainNativeBinary = '';
let mainNativeInputIdentity = null;
const NATIVE_BINARY_NAME = /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i;
// onnxruntime's Windows binaries import the MSVC C++ runtime, which Windows
// does not ship; without the VC++ Redistributable the addon fails to load.
// WINDOWS_ONNX_VC_RUNTIME_DLLS (core-layout.mjs) are deployed app-local beside onnxruntime.dll.
const runtimeManifestPath = join(runtimeDir, 'manifest.json');
const preparedRuntimeSchema = 3;
const configuredNpmCacheDir = String(process.env.MIXDOG_RUNTIME_NPM_CACHE ?? '').trim();
const npmCacheDir = configuredNpmCacheDir ? resolve(configuredNpmCacheDir) : join(runtimeDir, 'npm-cache');
const ownsNpmCache = !configuredNpmCacheDir;
if (!ownsNpmCache && (npmCacheDir === runtimeDir || npmCacheDir.startsWith(`${runtimeDir}${sep}`))) {
  throw new Error('MIXDOG_RUNTIME_NPM_CACHE must point outside the disposable .runtime directory.');
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('prepare-runtime must be run from npm.');
const embeddingTarget = embeddingRuntimeTarget({
  platform: optionValue('platform') || undefined,
  arch: optionValue('arch') || undefined,
});
const dependencyCacheIdentity = await runtimeDependencyCacheIdentity(rootDir, embeddingTarget);
let browserImportInputIdentity = null;

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

/** The Visual Studio redistributable CRT directory for one Windows architecture. */
async function windowsVcRuntimeDir(arch) {
  if (process.platform !== 'win32') {
    throw new Error('Windows runtime packaging requires a Windows host with Visual Studio C++ Build Tools.');
  }
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const { stdout } = await execFileAsync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ]);
  const installation = stdout.trim();
  if (!installation) throw new Error('vswhere found no Visual Studio installation with C++ Build Tools.');
  const version = (
    await readFile(join(installation, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCRedistVersion.default.txt'), 'utf8')
  ).trim();
  const archRoot = join(installation, 'VC', 'Redist', 'MSVC', version, arch);
  const crt = (await readdir(archRoot)).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name));
  if (!crt) throw new Error(`Visual C++ ${arch} redistributable CRT is missing under ${archRoot}`);
  return join(archRoot, crt);
}

async function resolveBrowserImportInputIdentity() {
  if (!browserImportNativeSourceDir) return null;
  if (embeddingTarget.platform !== 'win32') {
    throw new Error('Chrome password importer inputs are supported only for Windows targets.');
  }
  return nativeFilesIdentity(resolve(browserImportNativeSourceDir), browserImportNativeFileNames);
}

/** Content identity of prepared native files, for the runtime fingerprint. */
async function nativeFilesIdentity(sourceDirectory, fileNames) {
  const files = [];
  for (const name of fileNames) {
    files.push({ name, sha256: sha256(await readFile(join(sourceDirectory, name))) });
  }
  return { files };
}

/** One digest over every source file of a native crate, build output excluded. */
async function sourceTreeHash(sourceRoot) {
  const sourceFiles = [];
  async function collectSourceFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['dist', 'target', 'node_modules'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collectSourceFiles(path);
      else if (entry.isFile()) sourceFiles.push(path);
    }
  }
  await collectSourceFiles(sourceRoot);
  sourceFiles.sort((left, right) => left.localeCompare(right));
  const sourceHash = createHash('sha256');
  for (const path of sourceFiles) {
    sourceHash.update(relative(sourceRoot, path).replaceAll(sep, '/'));
    sourceHash.update('\0');
    sourceHash.update(await readFile(path));
    sourceHash.update('\0');
  }
  return sourceHash.digest('hex');
}

// The name cargo writes for the target, which is also the name the core and the
// desktop look for in native-tools (native_tools.rs `file_name`, index.ts).
const computerNativeFileName = `mixdog-computer${embeddingTarget.platform === 'win32' ? '.exe' : ''}`;
const computerRustTargets = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
});
let computerNativeBinary = '';
let computerInputIdentity = null;
// The Rust crates the module is built from: its own package and the rule crates it links by path.
const mainNativeSourceRoots = [
  join('native', 'mixdog-main-native'),
  join('native', 'core', 'crates', 'mixdog-browser-rules'),
  join('native', 'core', 'crates', 'mixdog-js'),
  // [patch.crates-io] of native/mixdog-main-native/Cargo.toml: the collator the module links is this vendored copy.
  join('native', 'core', 'vendor', 'icu_collator'),
];
// The workspace manifest those crates inherit their versions, features and lints from.
const mainNativeSourceFiles = [join('native', 'core', 'Cargo.toml')];
// What cargo names the library of the crate for the target.
const mainNativeBuiltFileName = {
  win32: 'mixdog_main_native.dll',
  darwin: 'libmixdog_main_native.dylib',
  linux: 'libmixdog_main_native.so',
}[embeddingTarget.platform];

/**
 * The main-process Node-API module (native/mixdog-main-native) for the target, on every platform: built by cargo and
 * cached by the digest of its sources. On Linux the glibc 2.28 build of linux-build-native-old-glibc.sh is taken from
 * MIXDOG_NATIVE_TOOLS_OVERRIDE_DIR when that is set, and must be there.
 */
async function prepareMainNative() {
  const sourceHashes = [];
  for (const root of mainNativeSourceRoots) sourceHashes.push(await sourceTreeHash(join(rootDir, root)));
  for (const file of mainNativeSourceFiles) sourceHashes.push(sha256(await readFile(join(rootDir, file))));
  const identity = { schemaVersion: 1, target: embeddingTarget.key, sourceHash: sha256(sourceHashes.join('\n')) };
  const overrideDir = String(process.env.MIXDOG_NATIVE_TOOLS_OVERRIDE_DIR ?? '').trim();
  if (overrideDir && embeddingTarget.platform === 'linux') {
    const override = join(resolve(overrideDir), mainNativeFileName);
    await access(override).catch(() => {
      throw new Error(`The main-process native module is required from ${overrideDir} but ${override} does not exist.`);
    });
    return { binary: override, identity };
  }
  const triple = computerRustTargets[embeddingTarget.key];
  if (!triple) throw new Error(`No main-process native module target exists for ${embeddingTarget.key}.`);
  if (process.platform !== embeddingTarget.platform) {
    throw new Error(
      `Building the ${embeddingTarget.platform} main-process native module requires a ${embeddingTarget.platform} host.`
    );
  }
  const outputDirectory = join(desktopDir, '.cache', 'main-native', embeddingTarget.key);
  const output = join(outputDirectory, mainNativeFileName);
  const cacheMarker = join(outputDirectory, '.mixdog-main-native-cache.json');
  try {
    const cached = JSON.parse(await readFile(cacheMarker, 'utf8'));
    if (cached.sourceHash === identity.sourceHash && cached.target === identity.target) {
      await access(output);
      return { binary: output, identity };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const crateRoot = join(rootDir, 'native', 'mixdog-main-native');
  const { stdout } = await execFileAsync('rustc', ['-vV'], { cwd: rootDir });
  const hostTriple = /^host:\s*(\S+)/m.exec(stdout)?.[1];
  if (hostTriple !== triple) await execFileAsync('rustup', ['target', 'add', triple], { cwd: rootDir });
  // The crate's own folder is the working directory: its .cargo/config.toml sets the Windows linker and static CRT.
  await execFileAsync('cargo', ['build', '--locked', '--release', '--target', triple], {
    cwd: crateRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  await mkdir(outputDirectory, { recursive: true });
  const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(crateRoot, 'target');
  await cp(join(targetRoot, triple, 'release', mainNativeBuiltFileName), output);
  await writeFile(
    cacheMarker,
    `${JSON.stringify(identity, null, 2)}
`
  );
  return { binary: output, identity };
}

/**
 * The Computer Use helper (native/mixdog-computer), built from source for the
 * target and cached by its source digest. The Rust core drives the desktop
 * through it on every platform, Windows included.
 */
async function prepareComputerNative() {
  const sourceRoot = join(rootDir, 'native', 'mixdog-computer');
  const identity = { schemaVersion: 1, target: embeddingTarget.key, sourceHash: await sourceTreeHash(sourceRoot) };
  const configured = String(process.env.MIXDOG_COMPUTER_NATIVE_BIN ?? '').trim();
  if (configured) return { binary: resolve(configured), identity };
  const triple = computerRustTargets[embeddingTarget.key];
  if (!triple) throw new Error(`No Computer Use backend target exists for ${embeddingTarget.key}.`);
  if (process.platform !== embeddingTarget.platform) {
    throw new Error(
      `Building the ${embeddingTarget.platform} Computer Use backend requires a ${embeddingTarget.platform} host.`
    );
  }
  const outputDirectory = join(desktopDir, '.cache', 'computer-native', embeddingTarget.key);
  const output = join(outputDirectory, computerNativeFileName);
  const cacheMarker = join(outputDirectory, '.mixdog-computer-cache.json');
  try {
    const cached = JSON.parse(await readFile(cacheMarker, 'utf8'));
    if (cached.sourceHash === identity.sourceHash && cached.target === identity.target) {
      await access(output);
      return { binary: output, identity };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const { stdout } = await execFileAsync('rustc', ['-vV'], { cwd: rootDir });
  const hostTriple = /^host:\s*(\S+)/m.exec(stdout)?.[1];
  if (hostTriple !== triple) await execFileAsync('rustup', ['target', 'add', triple], { cwd: rootDir });
  await execFileAsync(
    'cargo',
    ['build', '--locked', '--release', '--target', triple, '--manifest-path', join(sourceRoot, 'Cargo.toml')],
    { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 }
  );
  await mkdir(outputDirectory, { recursive: true });
  // CARGO_TARGET_DIR moves the build output off the checkout's drive; cargo (above) already honors it.
  const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(sourceRoot, 'target');
  await cp(join(targetRoot, triple, 'release', computerNativeFileName), output);
  await writeFile(cacheMarker, `${JSON.stringify(identity, null, 2)}\n`);
  return { binary: output, identity };
}

async function prepareBrowserImportNativeSource() {
  if (embeddingTarget.platform !== 'win32') {
    if (configuredBrowserImportNativeSourceDir) {
      throw new Error('Chrome password importer inputs are supported only for Windows targets.');
    }
    return '';
  }
  if (configuredBrowserImportNativeSourceDir) {
    return resolve(configuredBrowserImportNativeSourceDir);
  }
  return buildWindowsNativeCrate({
    crate: 'mixdog-browser-import',
    cacheName: 'browser-import',
    label: 'Chrome password importer',
    schemaVersion: 3,
    fileNames: browserImportNativeFileNames,
  });
}

/** The secure-desktop helper for a Windows target; '' for other targets. */
async function prepareSecureDesktopNativeSource() {
  if (embeddingTarget.platform !== 'win32') {
    if (configuredSecureDesktopNativeSourceDir) {
      throw new Error('The secure-desktop helper is supported only for Windows targets.');
    }
    return '';
  }
  if (configuredSecureDesktopNativeSourceDir) return resolve(configuredSecureDesktopNativeSourceDir);
  return buildWindowsNativeCrate({
    crate: 'mixdog-secure-desktop',
    cacheName: 'secure-desktop',
    label: 'secure-desktop helper',
    schemaVersion: 2,
    fileNames: secureDesktopNativeFileNames,
    // The release signer pin is compiled in (option_env!), so a cached build
    // is reusable only under the same pin; local builds have none.
    buildInputs: {
      signerSubject: process.env.MIXDOG_SECURE_DESKTOP_SIGNER_SUBJECT ?? '',
      signerEku: process.env.MIXDOG_SECURE_DESKTOP_SIGNER_EKU ?? '',
    },
  });
}

/** The Mica window library for a Windows target; '' for other targets. */
async function prepareWindowLibrarySource() {
  if (embeddingTarget.platform !== 'win32') return '';
  return buildWindowsNativeCrate({
    crate: 'mixdog-window',
    cacheName: 'window-library',
    label: 'window library',
    schemaVersion: 2,
    fileNames: windowLibraryFileNames,
  });
}

/**
 * Build an in-repo Windows crate for the target through its build.ps1, into a
 * per-target cache keyed on a digest of the crate source (and any build-time
 * inputs the binary embeds): an unchanged crate (or a CI-restored cache
 * directory) skips cargo entirely.
 */
async function buildWindowsNativeCrate({ crate, cacheName, label, schemaVersion, fileNames, buildInputs = null }) {
  if (process.platform !== 'win32') {
    throw new Error(`Building the Windows ${label} requires a Windows host.`);
  }
  const outputDirectory = join(desktopDir, '.cache', cacheName, embeddingTarget.key);
  const sourceRoot = join(rootDir, 'native', crate);
  const cacheIdentity = {
    schemaVersion,
    target: embeddingTarget.key,
    sourceHash: await sourceTreeHash(sourceRoot),
    buildInputs,
  };
  const cacheMarker = join(outputDirectory, `.${crate}-cache.json`);
  try {
    const cached = JSON.parse(await readFile(cacheMarker, 'utf8'));
    if (
      cached.schemaVersion === cacheIdentity.schemaVersion &&
      cached.target === cacheIdentity.target &&
      cached.sourceHash === cacheIdentity.sourceHash &&
      JSON.stringify(cached.buildInputs ?? null) === JSON.stringify(cacheIdentity.buildInputs)
    ) {
      await Promise.all(fileNames.map((name) => access(join(outputDirectory, name))));
      return outputDirectory;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const buildScript = join(sourceRoot, 'build.ps1');
  await execFileAsync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      buildScript,
      '-Configuration',
      'Release',
      '-OutputDirectory',
      outputDirectory,
      '-TargetArchitecture',
      embeddingTarget.arch,
    ],
    {
      cwd: rootDir,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  await writeFile(cacheMarker, `${JSON.stringify(cacheIdentity, null, 2)}\n`);
  return outputDirectory;
}

/** Object headers sit at the front of the file; native addons reach hundreds of
 *  MiB and never need a full read to name their architecture. */
async function readFileHeader(path, bytes = 4096) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Refuse a compiled artifact that cannot run on the target.
 *
 * This is the guard that makes preparing a runtime for another architecture
 * survivable. A build-host binary inside a foreign-target app packages,
 * uploads, and publishes without a single warning, and only fails when the
 * user launches it — so the archive is inspected here, where the failure is
 * still a build error.
 */
async function assertTargetArchitecture(path, label) {
  if (await nativeBinaryRunsOn(await readFileHeader(path), embeddingTarget.arch)) return;
  throw new Error(
    `${label} cannot run on ${embeddingTarget.key}: its header names another architecture. ` +
      `A runtime prepared on ${process.platform}-${process.arch} must still carry only ` +
      `${embeddingTarget.arch} binaries.`
  );
}

async function resolveRuntimePackageManifest() {
  const { stdout } = await runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: rootDir,
    maxBuffer: 16 * 1024 * 1024,
    useRuntimeCache: false,
  });
  const [manifest] = JSON.parse(stdout);
  if (!manifest?.files?.length) throw new Error('npm pack returned no Mixdog runtime files.');
  return manifest;
}

async function runtimeInputFingerprint(manifest) {
  const packageFiles = [];
  const sortedEntries = [...manifest.files].sort((left, right) => String(left.path).localeCompare(String(right.path)));
  for (const entry of sortedEntries) {
    const { source } = runtimePackageSource(rootDir, entry.path);
    packageFiles.push({
      path: String(entry.path).replaceAll('\\', '/'),
      sha256: sha256(await readFile(source)),
    });
  }
  // Every script that decides what the prepared runtime holds: this one and the modules it imports.
  const helperScripts = [
    'cli-args.mjs',
    'core-layout.mjs',
    'remote-js-roots.mjs',
    'runtime-package-payload.mjs',
    'stage-js-bundle.mjs',
  ];
  const [preparationSource, desktopPruneSource, desktopLockfile, helperSources] = await Promise.all([
    readFile(fileURLToPath(import.meta.url)),
    readFile(join(rootDir, 'scripts', 'prune-desktop-runtime.mjs')),
    readFile(join(desktopDir, 'package-lock.json')),
    Promise.all(helperScripts.map((name) => readFile(join(desktopDir, 'scripts', name)))),
  ]);
  return sha256(
    JSON.stringify({
      schemaVersion: preparedRuntimeSchema,
      target: embeddingTarget.key,
      dependencies: dependencyCacheIdentity,
      preparationSha256: sha256(preparationSource),
      desktopPruneSha256: sha256(desktopPruneSource),
      desktopLockfileSha256: sha256(desktopLockfile),
      helperScripts: helperSources.map((source) => sha256(source)),
      browserImport: browserImportInputIdentity,
      secureDesktop: secureDesktopInputIdentity,
      windowLibrary: windowLibraryInputIdentity,
      computer: computerInputIdentity,
      mainNative: mainNativeInputIdentity,
      packageFiles,
    })
  );
}

async function canReusePreparedRuntime(fingerprint) {
  try {
    const manifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== preparedRuntimeSchema ||
      manifest.target !== embeddingTarget.key ||
      manifest.fingerprint !== fingerprint
    ) {
      return false;
    }
    await Promise.all([
      access(join(builderNativeModulesDir, PACKAGE_DIR, 'package.json')),
      ...DESKTOP_NATIVE_TOOL_KINDS.map((kind) =>
        access(join(desktopNativeToolsDir, nativeToolInstalledName(kind, embeddingTarget)))
      ),
      ...(browserImportInputIdentity
        ? browserImportNativeFileNames.map((name) => access(join(desktopNativeToolsDir, name)))
        : []),
      ...(secureDesktopInputIdentity
        ? secureDesktopNativeFileNames.map((name) => access(join(desktopNativeToolsDir, name)))
        : []),
      ...(windowLibraryInputIdentity
        ? windowLibraryFileNames.map((name) => access(join(desktopNativeToolsDir, name)))
        : []),
      ...(computerNativeBinary ? [access(join(desktopNativeToolsDir, computerNativeFileName))] : []),
      access(join(desktopNativeToolsDir, mainNativeFileName)),
    ]);
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Ignoring unusable prepared runtime: ${error?.message || error}`);
    }
    return false;
  }
}

/**
 * Product-native tools for the TARGET.
 *
 * These are published, immutable release assets rather than anything compiled
 * here, so the build host never has to match the target: the manifest names one
 * verified asset per platform. Each downloaded file is still read back and
 * checked against the target architecture, because a manifest that pointed at
 * the wrong asset would otherwise travel all the way to a user's machine.
 */
async function prepareDesktopNativeTools() {
  const downloadDataDir = join(runtimeDir, 'native-downloads');
  // Linux packaging may supply graph built against an older glibc
  // baseline (see linux-build-native-old-glibc.sh); a tool present in that
  // directory replaces the pinned release download for this build.
  const overrideDir = String(process.env.MIXDOG_NATIVE_TOOLS_OVERRIDE_DIR ?? '').trim();
  // Kinds that must come from the override directory: a missing file is an
  // error instead of a silent fall back to the pinned (newer-glibc) download.
  const requiredOverrides = new Set(
    String(process.env.MIXDOG_NATIVE_TOOLS_REQUIRE_OVERRIDE ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter(Boolean)
  );
  const sources = await Promise.all(
    DESKTOP_NATIVE_TOOL_KINDS.map(async (kind) => {
      if (overrideDir && embeddingTarget.platform === 'linux') {
        const override = join(resolve(overrideDir), nativeToolInstalledName(kind, embeddingTarget));
        if (
          await access(override).then(
            () => true,
            () => false
          )
        )
          return override;
        if (requiredOverrides.has(kind)) {
          throw new Error(`Native tool ${kind} is required from ${overrideDir} but ${override} does not exist.`);
        }
      }
      return downloadNativeTool(kind, embeddingTarget, downloadDataDir);
    })
  );
  await rm(desktopNativeToolsDir, { recursive: true, force: true });
  await mkdir(desktopNativeToolsDir, { recursive: true });
  for (const [index, kind] of DESKTOP_NATIVE_TOOL_KINDS.entries()) {
    const destination = join(desktopNativeToolsDir, nativeToolInstalledName(kind, embeddingTarget));
    await cp(sources[index], destination);
    await assertTargetArchitecture(destination, `Native tool ${kind}`);
    // Executability belongs to the target's OS, not the machine that packed it.
    if (embeddingTarget.platform !== 'win32' && kind !== 'token') {
      await chmod(destination, 0o755);
    }
  }
  if (computerNativeBinary) {
    const destination = join(desktopNativeToolsDir, computerNativeFileName);
    await cp(computerNativeBinary, destination);
    await assertTargetArchitecture(destination, 'Computer Use backend');
    if (embeddingTarget.platform !== 'win32') await chmod(destination, 0o755);
  }
  {
    const destination = join(desktopNativeToolsDir, mainNativeFileName);
    await cp(mainNativeBinary, destination);
    await assertTargetArchitecture(destination, 'Main-process native module');
  }
  if (browserImportInputIdentity) {
    const sourceDirectory = resolve(browserImportNativeSourceDir);
    for (const name of browserImportNativeFileNames) {
      const source = join(sourceDirectory, name);
      const destination = join(desktopNativeToolsDir, name);
      await cp(source, destination);
      if (name.endsWith('.exe')) {
        await assertTargetArchitecture(destination, `Browser import native tool ${name}`);
      }
    }
  }
  if (secureDesktopInputIdentity) {
    for (const name of secureDesktopNativeFileNames) {
      const destination = join(desktopNativeToolsDir, name);
      await cp(join(secureDesktopNativeSourceDir, name), destination);
      if (name.endsWith('.exe')) await assertTargetArchitecture(destination, `Secure-desktop helper ${name}`);
    }
  }
  if (windowLibraryInputIdentity) {
    for (const name of windowLibraryFileNames) {
      const destination = join(desktopNativeToolsDir, name);
      await cp(join(windowLibrarySourceDir, name), destination);
      await assertTargetArchitecture(destination, `Window library ${name}`);
    }
  }
  await rm(downloadDataDir, { recursive: true, force: true });
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
  const previousNpmCache = process.env.npm_config_cache;

  try {
    await timed('native-tools', () => prepareDesktopNativeTools());
    // What the app ships of the root package is exactly what the Rust core and its script interpreter load
    // as real files (core-layout.mjs): the package, the packages the pptxgenjs authoring script and the
    // skill launchers reach (and what those need), and the ONNX Runtime library of the target. The same
    // trimmed lockfile install the server bundles use (stage-js-bundle.mjs installProductionModules):
    // a dependency of the root package that no entry point imports is not installed, and the install runs
    // no package script, so the onnxruntime-node postinstall never downloads provider libraries the core
    // does not register.
    await mkdir(stagingDir, { recursive: true });
    // Local preparation keeps tarballs/logs in a disposable cache (see runNpm); CI supplies its restored cache.
    process.env.npm_config_cache = npmCacheDir;
    await timed('npm-ci', () =>
      installProductionModules(stagingDir, embeddingTarget.key, {
        extraRoots: desktopExtraRoots(embeddingTarget.platform),
      })
    );
    const onnx = onnxRuntimeSupported(embeddingTarget.platform, embeddingTarget.arch);
    const ortBinarySource = onnx
      ? join(stagingDir, 'node_modules', ORT_PACKAGE, ortBinaryDir(embeddingTarget.platform, embeddingTarget.arch))
      : null;
    if (
      onnx &&
      !(await stat(join(ortBinarySource, 'onnxruntime_binding.node')).then(
        (entry) => entry.isFile(),
        () => false
      ))
    ) {
      throw new Error(
        `Embedding runtime is incomplete: missing ${embeddingTarget.key} ONNX binding in ${ortBinarySource}`
      );
    }
    if (onnx && embeddingTarget.platform === 'win32') {
      await timed('vc-runtime-copy', async () => {
        // The fixed production embedding profile uses CPU inference. DirectML.dll stays for explicit device
        // overrides; the optional DXC shader compiler payload was verified unnecessary by packaged-runtime warmup.
        for (const name of WINDOWS_DML_PRUNABLE_FILES)
          await rm(join(ortBinarySource, name), { force: true, maxRetries: 10, retryDelay: 250 });
        const crtDir = await windowsVcRuntimeDir(embeddingTarget.arch);
        for (const name of WINDOWS_ONNX_VC_RUNTIME_DLLS) {
          await cp(join(crtDir, name), join(ortBinarySource, name));
        }
      });
    }

    await timed('runtime-package-copy', () =>
      copyRuntimePackagePayload({
        rootDir,
        manifest,
        destination: runtimePackageDir,
      })
    );

    const desktopPrune = await timed('production-payload-prune', () =>
      pruneDesktopRuntime(stagingDir, embeddingTarget)
    );
    console.log(
      `Removed ${desktopPrune.removedSourceFiles} source-only runtime files` +
        `${desktopPrune.removedSharpWasm ? ' and the Sharp WASM fallback' : ''}.`
    );

    // electron-builder ships the real files below (extraResources .runtime/native-modules to
    // runtime.asar.unpacked/node_modules): nothing in the app opens an archive of them. The core runs the
    // extension host and the skill launchers from this tree, which no archive can serve.
    await timed('core-runtime-mirror', async () => {
      // Fill the data payload before mirrorCoreRuntime verifies the complete tree.
      await copyPptxgenjsData({
        modulesDir: join(stagingDir, 'node_modules'),
        packageDir: runtimePackageDir,
      });
      await mirrorCoreRuntime({
        modulesDir: join(stagingDir, 'node_modules'),
        destination: builderNativeModulesDir,
        platform: embeddingTarget.platform,
        arch: embeddingTarget.arch,
        ortBinarySource,
      });
    });

    // The skill launcher: its entry and the files it imports, nothing from the npm closure.
    for (const file of launcherRuntimeFiles(rootDir)) {
      await access(join(builderNativeModulesDir, PACKAGE_DIR, file)).catch(() => {
        throw new Error(`Runtime is incomplete: the skill launcher file ${file} is missing`);
      });
    }

    // A binary of another architecture inside the app packages and publishes without a warning and only fails
    // on the user's machine: every native file the app ships is read back for the target's architecture.
    const nativeBinaries = await timed('native-architecture-check', async () => {
      const found = [];
      for (const entry of await readdir(builderNativeModulesDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !NATIVE_BINARY_NAME.test(entry.name)) continue;
        const source = join(entry.parentPath, entry.name);
        await assertTargetArchitecture(
          source,
          `Runtime addon ${relative(builderNativeModulesDir, source).replaceAll(sep, '/')}`
        );
        found.push(source);
      }
      return found;
    });
    if (!onnx && nativeBinaries.some((file) => file.endsWith('onnxruntime_binding.node'))) {
      throw new Error(`Runtime contains an onnxruntime binding on ${embeddingTarget.key}`);
    }

    await writeFile(
      runtimeManifestPath,
      `${JSON.stringify({ schemaVersion: preparedRuntimeSchema, target: embeddingTarget.key, fingerprint }, null, 2)}\n`
    );
    prepared = true;
    console.log(
      `Prepared ${embeddingTarget.key} runtime: ${manifest.files.length} Mixdog package files and the ` +
        `core's dependency closure as real files (${nativeBinaries.length} native file(s)).`
    );
  } finally {
    if (previousNpmCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousNpmCache;
    // npm ci or the mirror can fail after creating hundreds of MiB. Always remove transient state; on
    // failure also discard the partial runtime so the next build starts from a clean slate.
    await timed('cleanup', async () => {
      const cleanup = [rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })];
      if (ownsNpmCache) {
        cleanup.push(
          rm(npmCacheDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 250,
          })
        );
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
// second wiped the staging tree the first was mirroring into native-modules, which
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
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            target: embeddingTarget.key,
            startedAt: new Date().toISOString(),
          })
        );
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
        `Runtime preparation is still held by pid ${holder?.pid ?? 'unknown'} ` +
          `after ${Math.round(runtimeLockTimeoutMs / 60000)} minutes: ${runtimeLockPath}`
      );
    }
    if (holder && holder.pid !== announcedHolder) {
      announcedHolder = holder.pid;
      console.log(`Waiting for the runtime preparation held by pid ${holder.pid}.`);
    }
    await new Promise((done) => {
      setTimeout(done, 1000);
    });
  }
}

const preparationStartedAt = performance.now();
const releaseRuntimeLock = await timed('preparation-lock', () => acquireRuntimeLock());
try {
  browserImportNativeSourceDir = await timed('browser-import-native', () => prepareBrowserImportNativeSource());
  browserImportInputIdentity = await timed('browser-import-identity', () => resolveBrowserImportInputIdentity());
  secureDesktopNativeSourceDir = await timed('secure-desktop-native', () => prepareSecureDesktopNativeSource());
  secureDesktopInputIdentity = secureDesktopNativeSourceDir
    ? await nativeFilesIdentity(secureDesktopNativeSourceDir, secureDesktopNativeFileNames)
    : null;
  windowLibrarySourceDir = await timed('window-library-native', () => prepareWindowLibrarySource());
  windowLibraryInputIdentity = windowLibrarySourceDir
    ? await nativeFilesIdentity(windowLibrarySourceDir, windowLibraryFileNames)
    : null;
  ({ binary: computerNativeBinary, identity: computerInputIdentity } = await timed('computer-native', () =>
    prepareComputerNative()
  ));
  ({ binary: mainNativeBinary, identity: mainNativeInputIdentity } = await timed('main-native', () =>
    prepareMainNative()
  ));
  const manifest = await timed('package-manifest', () => resolveRuntimePackageManifest());
  const fingerprint = await timed('input-fingerprint', () => runtimeInputFingerprint(manifest));
  if (await timed('prepared-runtime-check', () => canReusePreparedRuntime(fingerprint))) {
    console.log(`Reused prepared ${embeddingTarget.key} runtime.`);
  } else {
    await prepareRuntime(manifest, fingerprint);
  }
} finally {
  await releaseRuntimeLock();
  console.log(`[prepare-runtime] total: ${elapsedMs(preparationStartedAt)}ms`);
}
