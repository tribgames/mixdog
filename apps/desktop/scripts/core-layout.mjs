// The install layout of the Rust core's JS runtime and ONNX Runtime library, in one place. Everything that
// stages (stage-core, stage-js-bundle, prepare-runtime) or checks (verify-staged-package, the packaging
// tests) a package reads it from here, so the three views of the layout cannot drift:
//
//   desktop   resources/core/mixdogd + js-runtime.json
//             resources/runtime.asar.unpacked/node_modules/mixdog/             package root (real files)
//             resources/runtime.asar.unpacked/node_modules/<closure>/          what the ext host and the skill launchers load
//             resources/runtime.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/<platform>/<arch>/
//   remote    payload/js-runtime.json (beside mixdogd once the bundle is unpacked)
//             payload/js/pkg/node_modules/mixdog/, .../<closure>/, .../onnxruntime-node/bin/napi-v6/<platform>/<arch>/
//
// The core reads `<package root>/src/<dir>` and `<package root>/package.json` with plain fs, so the package
// root is never inside an `.asar`: Electron's archive fs patch exists only in Electron's own processes.
// The ONNX Runtime library rule is decisions.md "ONNX Runtime library": one `ortLibrary` entry in
// js-runtime.json, the file the onnxruntime-node binding loads; its siblings stay next to it; no search.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { deriveRemoteRoots, installedClosure } from './remote-js-roots.mjs';

export const JS_RUNTIME_MANIFEST = 'js-runtime.json';
/** Where the desktop's real-file modules live, relative to `resources/`. */
export const UNPACKED_NODE_MODULES = 'runtime.asar.unpacked/node_modules';
export const PACKAGE_DIR = 'mixdog';
export const ORT_PACKAGE = 'onnxruntime-node';

/** What `mixdogd` reads from the package root as plain files (compose*.rs, run_host/rules*.rs, mixdog-store
 *  paths.rs, mixdog-cli main.rs). Directories must hold at least one file. The k1-assets slice owns the
 *  contents of the shipped directories; this is the one list the packaging checks. */
export const CORE_READS = Object.freeze({
  files: [
    'package.json',
    'src/skill-script-entry.mjs',
    'src/ext-host/worker.mjs',
    'src/runtime/channels/data/voice-runtime-manifest.json',
  ],
  dirs: ['src/rules', 'src/output-styles', 'src/agents', 'src/defaults', 'src/orchestration'],
});

/** The `MIXDOG_ROOT` the packaged desktop must give the core (`resource_root()` in mixdog-store paths.rs):
 *  the unpacked `src/` of the package, real files outside runtime.asar. `resources` is the app's resources dir. */
export const desktopMixdogRoot = (resources) => join(resources, UNPACKED_NODE_MODULES, PACKAGE_DIR, 'src');

/** onnxruntime-node ships no macOS Intel binding (1.23 on), so such an install carries no ONNX Runtime. */
export const onnxRuntimeSupported = (platform, arch) => !(platform === 'darwin' && arch === 'x64');

/** The library file onnxruntime-node's binding loads, per platform. */
const ORT_LIBRARY_FILE = Object.freeze({ win32: 'onnxruntime.dll', linux: 'libonnxruntime.so.1', darwin: 'libonnxruntime.1.dylib' });
/** MSVC runtime the Windows ONNX Runtime imports and Windows does not ship; deployed app-local. */
export const WINDOWS_ONNX_VC_RUNTIME_DLLS = Object.freeze([
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_atomic_wait.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
]);
/** Files that must sit beside the library: the binding and, on Windows, DirectML and the shader compiler. */
const ORT_SIBLINGS = Object.freeze({
  win32: ['onnxruntime_binding.node', 'DirectML.dll', 'dxil.dll', 'dxcompiler.dll', ...WINDOWS_ONNX_VC_RUNTIME_DLLS],
  linux: ['onnxruntime_binding.node'],
  darwin: ['onnxruntime_binding.node'],
});

/** `bin/napi-v6/<platform>/<arch>` of the onnxruntime-node package. */
export const ortBinaryDir = (platform, arch) => `bin/napi-v6/${platform}/${arch}`;

function ortLibraryIn(modulesPrefix, platform, arch) {
  const file = ORT_LIBRARY_FILE[platform];
  if (!file) throw new Error(`no ONNX Runtime library for ${platform}`);
  return `${modulesPrefix}/${ORT_PACKAGE}/${ortBinaryDir(platform, arch)}/${file}`;
}

/** `ortLibrary` of a desktop install, relative to `resources/core/`. */
export const desktopOrtLibraryPath = (platform, arch) => ortLibraryIn(`../${UNPACKED_NODE_MODULES}`, platform, arch);

const APP_EXECUTABLE = Object.freeze({ win32: '../../Mixdog.exe', darwin: '../../MacOS/Mixdog', linux: '../../mixdog-desktop' });

/** js-runtime.json of the desktop: the app in node mode runs the JS; the package root is real files. */
export function desktopJsRuntimeManifest(platform, arch) {
  const program = APP_EXECUTABLE[platform];
  if (!program) throw new Error(`no app executable for ${platform}`);
  return {
    program,
    packageRoot: `../${UNPACKED_NODE_MODULES}/${PACKAGE_DIR}`,
    electron: true,
    // A target with no onnxruntime-node binding (macOS x64) names none: the daemon builds no models there.
    ...(onnxRuntimeSupported(platform, arch) ? { ortLibrary: desktopOrtLibraryPath(platform, arch) } : {}),
  };
}

/** js-runtime.json of the remote bundle, relative to the payload directory. */
export function remoteJsRuntimeManifest(platform, arch) {
  return {
    program: 'js/node',
    packageRoot: `js/pkg/node_modules/${PACKAGE_DIR}`,
    electron: false,
    ...(onnxRuntimeSupported(platform, arch) ? { ortLibrary: ortLibraryIn('js/pkg/node_modules', platform, arch) } : {}),
  };
}

/** Removes every platform/arch binary directory of the onnxruntime-node package except `platform`/`arch`
 *  (the trim of the remote bundle); throws when the kept one lacks the library. */
export function trimOrtBinaries(ortPackageDir, platform, arch) {
  const napi = join(ortPackageDir, 'bin', 'napi-v6');
  for (const os of readdirSync(napi)) {
    if (os !== platform) {
      rmSync(join(napi, os), { recursive: true, force: true });
      continue;
    }
    for (const cpu of readdirSync(join(napi, os))) if (cpu !== arch) rmSync(join(napi, os, cpu), { recursive: true, force: true });
  }
  const library = join(napi, platform, arch, ORT_LIBRARY_FILE[platform]);
  if (!existsSync(library)) throw new Error(`onnxruntime-node holds no ${platform}-${arch} library: ${library}`);
}

const isFile = (file) => existsSync(file) && statSync(file).isFile();
const nonEmptyDir = (dir) => existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir, { recursive: true }).length > 0;

/**
 * Integrity of one install of the core's JS runtime: `manifestDir` holds `js-runtime.json`. Throws a message
 * listing everything wrong:
 *  - the manifest is exactly the layout's (`kind` 'desktop' | 'remote') for the target;
 *  - the package root is real files (not in an archive) holding everything `CORE_READS` names;
 *  - every package the extension host and the skill launchers reach, and what those need in turn, is beside
 *    the package; only the optional packages the staging recorded as skipped (`CLOSURE_RECORD`) may be absent;
 *  - the ONNX Runtime library is there with its siblings, and no other platform's binaries are
 *    (an unsupported target carries none).
 * `program` is checked only with `checkProgram` (the desktop's app is not built when its resources are staged).
 */
export function verifyCoreInstall({ manifestDir, kind, platform, arch, checkProgram = true }) {
  const problems = [];
  const manifestFile = join(manifestDir, JS_RUNTIME_MANIFEST);
  if (!isFile(manifestFile)) throw new Error(`${manifestFile} does not exist`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const expected = (kind === 'desktop' ? desktopJsRuntimeManifest : remoteJsRuntimeManifest)(platform, arch);
  if (!isDeepStrictEqual(manifest, expected)) {
    problems.push(`${manifestFile} is ${JSON.stringify(manifest)}, expected ${JSON.stringify(expected)}`);
  }
  const at = (relative) => resolve(manifestDir, relative);
  const packageRoot = at(expected.packageRoot);
  if (checkProgram && !isFile(at(expected.program))) problems.push(`interpreter ${at(expected.program)} does not exist`);
  problems.push(...coreTreeProblems({ modulesDir: dirname(packageRoot), platform, arch }));
  if (problems.length) throw new Error(`${kind} core install ${manifestDir} is incomplete:\n- ${problems.join('\n- ')}`);
  return { manifest, packageRoot };
}

/**
 * Copies what the core needs as real files from an installed production tree (`modulesDir`, whose `mixdog`
 * package holds the pack manifest's files) into `destination`: the package, every package its extension host
 * and skill launchers reach (and what those need), and the ONNX Runtime binary directory (`ortBinarySource`,
 * null where the target has none). The result is checked as `verifyCoreTree` checks an install.
 */
export async function mirrorCoreRuntime({ modulesDir, destination, platform, arch, ortBinarySource }) {
  const { dirs, skipped } = closureOf(modulesDir);
  const mirrored = [join(modulesDir, PACKAGE_DIR), ...dirs].sort();
  for (const dir of mirrored) {
    // A nested package comes with the package that holds it.
    if (mirrored.some((other) => other !== dir && dir.startsWith(`${other}${sep}`))) continue;
    // The ONNX Runtime package comes without its binaries (all platforms in the npm tarball): only the target's
    // directory is mirrored, below.
    const filter = dir === join(modulesDir, ORT_PACKAGE) ? (source) => relative(dir, source) !== 'bin' : undefined;
    await cp(dir, join(destination, relative(modulesDir, dir)), { recursive: true, filter });
  }
  // The library with its siblings (and the app-local VC runtime on Windows).
  if (ortBinarySource) await cp(ortBinarySource, join(destination, ORT_PACKAGE, ortBinaryDir(platform, arch)), { recursive: true });
  await mkdir(destination, { recursive: true });
  writeClosureRecord(destination, skipped);
  verifyCoreTree({ modulesDir: destination, platform, arch });
}

/** The closure the extension host and the skill launchers need in the installed tree `modulesDir` (its `mixdog`
 *  package holds the entry points). Throws on a required package that is not installed; an optional one
 *  the installer left out is `skipped`. */
function closureOf(modulesDir) {
  const { roots } = deriveRemoteRoots({ packageRootDir: join(modulesDir, PACKAGE_DIR) });
  const { dirs, missing, skipped } = installedClosure(modulesDir, roots.keys(), (_name, kind) => kind === 'optional dependency');
  if (missing.length) throw new Error(`The extension host closure is incomplete:\n- ${missing.join('\n- ')}`);
  return { dirs, skipped };
}

/** What the staging found installed: the optional packages of the closure that were not (npm skips those
 *  that are not for the platform). The check of the staged tree accepts exactly these as absent. */
export const CLOSURE_RECORD = 'mixdog-core-closure.json';
const writeClosureRecord = (modulesDir, skipped) =>
  writeFileSync(join(modulesDir, CLOSURE_RECORD), `${JSON.stringify({ skippedOptional: [...skipped].sort() }, null, 2)}\n`);

/** Writes `CLOSURE_RECORD` into the installed tree `modulesDir` (the remote bundle's `node_modules`). */
export function recordCoreClosure(modulesDir) {
  writeClosureRecord(modulesDir, closureOf(modulesDir).skipped);
}

/** Throws unless `modulesDir` (a `node_modules` holding the `mixdog` package) is a complete core tree. */
export function verifyCoreTree(options) {
  const problems = coreTreeProblems(options);
  if (problems.length) throw new Error(`core tree ${options.modulesDir} is incomplete:\n- ${problems.join('\n- ')}`);
}

/** What `verifyCoreInstall` checks of the files: everything under `modulesDir`, whichever layout holds it. */
function coreTreeProblems({ modulesDir, platform, arch }) {
  const problems = [];
  const packageRoot = join(modulesDir, PACKAGE_DIR);
  for (const file of CORE_READS.files) if (!isFile(join(packageRoot, file))) problems.push(`missing file ${file} in the package root`);
  for (const dir of CORE_READS.dirs) if (!nonEmptyDir(join(packageRoot, dir))) problems.push(`missing or empty ${dir} in the package root`);

  if (isFile(join(packageRoot, 'src', 'ext-host', 'worker.mjs')) && isFile(join(packageRoot, 'src', 'skill-script-entry.mjs'))) {
    const { roots } = deriveRemoteRoots({ packageRootDir: packageRoot });
    const record = join(modulesDir, CLOSURE_RECORD);
    if (isFile(record)) {
      const skipped = new Set(JSON.parse(readFileSync(record, 'utf8')).skippedOptional);
      problems.push(...installedClosure(modulesDir, roots.keys(), (name) => skipped.has(name)).missing);
    } else {
      problems.push(`${CLOSURE_RECORD} is missing: the dependency closure was not recorded by the staging`);
    }
  }

  const ortPackage = join(modulesDir, ORT_PACKAGE);
  if (onnxRuntimeSupported(platform, arch)) {
    const binaryDir = join(ortPackage, ortBinaryDir(platform, arch));
    if (!isFile(join(binaryDir, ORT_LIBRARY_FILE[platform]))) problems.push(`ONNX Runtime library ${join(binaryDir, ORT_LIBRARY_FILE[platform])} does not exist`);
    for (const sibling of ORT_SIBLINGS[platform]) if (!isFile(join(binaryDir, sibling))) problems.push(`${sibling} is missing beside the ONNX Runtime library`);
    const napi = join(ortPackage, 'bin', 'napi-v6');
    for (const os of existsSync(napi) ? readdirSync(napi) : []) {
      const foreign = os === platform ? readdirSync(join(napi, os)).filter((cpu) => cpu !== arch) : [os];
      if (foreign.length) problems.push(`foreign ONNX Runtime binaries in ${join(napi, os)}`);
    }
  } else if (existsSync(join(ortPackage, 'bin'))) {
    problems.push(`${platform}-${arch} has no ONNX Runtime binding, but ${join(ortPackage, 'bin')} exists`);
  }
  return problems;
}
