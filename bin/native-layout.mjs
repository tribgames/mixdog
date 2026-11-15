// What the install of the npm package owes the core beside its programs: `js-runtime.json`. The core reads the script
// interpreter, the package root that holds src/skill-script-entry.mjs and the ONNX Runtime library from that manifest
// (mixdog-app-server-daemon js_runtime.rs), with paths relative to the manifest's folder. The platform package is
// installed either inside the `mixdog` package (global installs) or beside it (hoisted), so the relative paths are
// known only here, at install time; the manifest is written by `npm install` (postinstall) and, for an install whose
// scripts were disabled, by the launcher on its first start.
//
// The ONNX Runtime library is the file onnxruntime-node (a dependency of `mixdog`) installed for the program's
// platform; the manifest names it when it is there, and names none when it is not (an install without the models:
// macOS x64, ONNXRUNTIME_NODE_INSTALL=skip), which the core starts with.
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_FILE = 'js-runtime.json';

/** The library file onnxruntime-node's binding loads, per platform (apps/desktop/scripts/core-layout.mjs ORT_LIBRARY_FILE). */
const ORT_LIBRARY_FILE = { win32: 'onnxruntime.dll', linux: 'libonnxruntime.so.1', darwin: 'libonnxruntime.1.dylib' };

const forward = (path) => path.split('\\').join('/');

/** The onnxruntime-node package of this install: inside `mixdog`, or beside it when npm hoisted it. */
export function ortPackageRoot(packageRoot, exists = existsSync) {
  return [join(packageRoot, 'node_modules', 'onnxruntime-node'), join(dirname(packageRoot), 'onnxruntime-node')].find((root) =>
    exists(join(root, 'package.json'))
  );
}

/** The ONNX Runtime library for programs of `platform`-`arch`, or undefined when the install has none. */
export function ortLibrary(packageRoot, platform, arch, exists = existsSync) {
  const file = ORT_LIBRARY_FILE[platform];
  const root = ortPackageRoot(packageRoot, exists);
  if (!file || !root) return undefined;
  const library = join(root, 'bin', 'napi-v6', platform, arch, file);
  return exists(library) ? library : undefined;
}

/** The manifest of an install whose programs are in `folder`; paths relative to it, as the core reads them. */
export function jsRuntimeManifest({ folder, packageRoot, platform, arch, exists = existsSync }) {
  const manifest = { program: 'node', packageRoot: forward(relative(folder, packageRoot)) };
  const library = ortLibrary(packageRoot, platform, arch, exists);
  if (library) manifest.ortLibrary = forward(relative(folder, library));
  return manifest;
}

/**
 * Makes the programs in `folder` runnable by the core: the manifest written when it is missing or differs, the
 * programs executable. Returns whether the manifest was written. Throws when the folder cannot be written.
 */
export function ensureNativeLayout({ folder, packageRoot, platform, arch, programs = ['mixdog', 'mixdogd', 'mixdog-askpass'], exists = existsSync }) {
  const manifest = jsRuntimeManifest({ folder, packageRoot, platform, arch, exists });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(folder, MANIFEST_FILE);
  let written = false;
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== text) {
    writeFileSync(path, text);
    written = true;
  }
  if (platform !== 'win32') {
    for (const name of programs) {
      try {
        chmodSync(join(folder, name), 0o755);
      } catch {
        // A program the package does not carry is the check's business, not the layout's.
      }
    }
  }
  return written;
}

/** Every platform this package carries a program for (the names of its optional dependencies are `mixdog-<key>`). */
export const SUPPORTED_KEYS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);

export const platformPackageName = (key) => `mixdog-${key}`;

/** The platforms whose program runs on `platform`-`arch`, best first: Windows on Arm runs the x64 program. */
export function nativeCandidates(platform = process.platform, arch = process.arch) {
  const keys = [`${platform}-${arch}`];
  if (platform === 'win32' && arch === 'arm64') keys.push('win32-x64');
  return keys;
}

/**
 * The installed program for this machine: the first candidate whose platform package npm installed, with the folder
 * of its programs (`bin` of that package). Undefined when none is installed.
 */
export function resolveNativeProgram({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  resolvePackageJson = (name) => createRequire(join(packageRoot, 'package.json')).resolve(`${name}/package.json`),
  exists = existsSync,
}) {
  for (const key of nativeCandidates(platform, arch)) {
    let manifest;
    try {
      manifest = resolvePackageJson(platformPackageName(key));
    } catch {
      continue;
    }
    const folder = join(dirname(manifest), 'bin');
    const [platformOfKey, archOfKey] = key.split('-');
    const program = join(folder, platformOfKey === 'win32' ? 'mixdog.exe' : 'mixdog');
    if (exists(program)) return { key, platform: platformOfKey, arch: archOfKey, folder, program };
  }
  return undefined;
}

/** `node bin/native-layout.mjs`: the postinstall of the package. It never fails an install: the launcher says what is missing. */
function main() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const found = resolveNativeProgram({ packageRoot });
  if (!found) return;
  try {
    ensureNativeLayout({ folder: found.folder, packageRoot, platform: found.platform, arch: found.arch });
  } catch (error) {
    process.stderr.write(`mixdog: could not write ${MANIFEST_FILE} in ${found.folder}: ${error.message}\n`);
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
