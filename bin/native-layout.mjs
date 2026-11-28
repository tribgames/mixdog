// What the package owes the core beside its programs: `js-runtime.json`. The core reads the script interpreter, the
// package root that holds src/skill-script-entry.mjs and the ONNX Runtime library from that manifest
// (mixdog-app-server-daemon js_runtime.rs), with paths relative to the manifest's folder. The programs are in the
// user's runtime cache (bin/runtime.mjs), which every install of the same version shares, so the launcher writes the
// manifest for the install it starts from, each time it differs, right before it starts the program.
//
// The ONNX Runtime library is the file onnxruntime-node (a dependency of `mixdog`) installed for the program's
// platform; the manifest names it when it is there, and names none when it is not (an install without the models:
// macOS x64, ONNXRUNTIME_NODE_INSTALL=skip), which the core starts with.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { renameWithRetry } from './rename.mjs';

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
 * The manifest beside the programs in `folder`, written when it is missing or differs. Returns whether it was written.
 * Throws when the folder cannot be written. Every install of the version starts its program from that folder, so the
 * manifest is replaced whole: a core reads the one install's or the other's, never a part of one.
 */
export function ensureNativeLayout({ folder, packageRoot, platform, arch, exists = existsSync, write = writeFileSync }) {
  const manifest = jsRuntimeManifest({ folder, packageRoot, platform, arch, exists });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(folder, MANIFEST_FILE);
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current === text) return false;
  const partial = `${path}.${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    write(partial, text);
    renameWithRetry(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
  return true;
}

/** Every platform there is a runtime for (scripts/npm-platforms.mjs PLATFORMS). */
export const SUPPORTED_KEYS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);

/** The platforms whose program runs on `platform`-`arch`, best first: Windows on Arm runs the x64 program. */
export function nativeCandidates(platform = process.platform, arch = process.arch) {
  const keys = [`${platform}-${arch}`];
  if (platform === 'win32' && arch === 'arm64') keys.push('win32-x64');
  return keys;
}
