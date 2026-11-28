#!/usr/bin/env node
// node apps/desktop/scripts/verify-staged-package.mjs --resources=<dir> [--platform=win32] [--arch=x64] [--deletion-manifest=<file>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { nativeBinaryRunsOn } from '../../../scripts/native-binary-arch.mjs';
import { SERVER_PLATFORM_TARGETS } from '../src/main/ssh/server-manifest.mjs';
import {
  desktopMixdogRoot,
  PACKAGE_DIR,
  UNPACKED_NODE_MODULES,
  verifyCoreInstall,
  verifyRemotePayload,
} from './core-layout.mjs';

/** The K1 deletion manifest. This committed file is the single authority for what the cut deletes (see its
 *  header); there is no filtered copy: `parseDeletionList` is the only place that decides which sections delete. */
export const DEFAULT_DELETION_LIST = join(dirname(fileURLToPath(import.meta.url)), 'k1-deletion-manifest.txt');

/** Paths of a deletion manifest (`## ` sections; only the ones that delete, not KEEP or MOVE, count). */
export function parseDeletionList(text) {
  const deleted = new Set();
  let counts = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('## ')) counts = /^## (DELETE|BLOCKED|SCRIPT)/.test(line);
    else if (line && !line.startsWith('#') && counts) deleted.add(line);
  }
  return deleted;
}

/** Package-root-relative paths of every file of the Mixdog package that `resources` holds: the real-file copy
 *  and each server bundle. Keyed by where they were found. */
function packedPackageFiles({ resources, bundles }) {
  const found = new Map();
  const unpacked = join(resources, UNPACKED_NODE_MODULES, PACKAGE_DIR);
  if (existsSync(unpacked))
    found.set(
      unpacked,
      readdirSync(unpacked, { recursive: true }).map((path) => path.replaceAll('\\', '/'))
    );
  for (const [bundle, entries] of bundles) {
    const prefix = `payload/js/pkg/node_modules/${PACKAGE_DIR}/`;
    found.set(
      bundle,
      [...entries].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length))
    );
  }
  return found;
}

function verifyCoreResources({ resources, platform, arch }) {
  const exe = join(resources, 'core', platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
  if (!existsSync(exe) || !statSync(exe).isFile()) throw new Error(`the Rust core ${exe} is not in the package`);
  const askpass = join(resources, 'core', platform === 'win32' ? 'mixdog-askpass.exe' : 'mixdog-askpass');
  if (!existsSync(askpass) || !statSync(askpass).isFile())
    throw new Error(`the ssh askpass helper ${askpass} is not in the package`);
  if (platform === 'win32') {
    const helper = join(resources, 'native-tools', 'mixdog-computer.exe');
    if (!existsSync(helper) || !statSync(helper).isFile())
      throw new Error(`the Computer Use helper ${helper} is not in the package`);
    if (!nativeBinaryRunsOn(readFileSync(helper), arch))
      throw new Error(`the Computer Use helper ${helper} does not run on win32-${arch}`);
  }
  // The Browser Use rules live only in this module: a package without it, or with one built for another architecture,
  // must fail here, at the build, and never reach a user.
  const mainNative = join(resources, 'native-tools', 'mixdog_main_native.node');
  if (!existsSync(mainNative) || !statSync(mainNative).isFile())
    throw new Error(`the main-process native module ${mainNative} is not in the package`);
  if (!nativeBinaryRunsOn(readFileSync(mainNative), arch))
    throw new Error(`the main-process native module ${mainNative} does not run on ${platform}-${arch}`);
  const mixdogRoot = desktopMixdogRoot(resources);
  // The core's resources are real files under MIXDOG_ROOT, and no archive of the runtime is shipped: a package that
  // carries one has the root production tree packed for nothing (and a core resource only inside it would be unreadable).
  if (existsSync(join(resources, 'runtime.asar'))) {
    throw new Error(
      `${join(resources, 'runtime.asar')} is shipped, but nothing opens it: the core reads the real files under ${mixdogRoot}`
    );
  }
  verifyCoreInstall({ manifestDir: join(resources, 'core'), kind: 'desktop', platform, arch });
}

function verifyServerBundles({ resources, hostOnly }) {
  const serversDir = join(resources, 'server-cores');
  // A host-only package (stage-core --host-only) has no server bundles: nothing of them to check or to unpack.
  const manifest = hostOnly ? { binaries: {} } : JSON.parse(readFileSync(join(serversDir, 'servers.json'), 'utf8'));
  const problems = [];
  const bundles = new Map();
  // Exactly the platforms the desktop ships `mixdogd` for: an empty or short manifest is not a package.
  const keys = Object.keys(manifest.binaries ?? {});
  if (!hostOnly)
    for (const key of Object.keys(SERVER_PLATFORM_TARGETS))
      if (!keys.includes(key)) problems.push(`servers.json lists no ${key} bundle`);
  for (const key of keys)
    if (!(key in SERVER_PLATFORM_TARGETS)) problems.push(`servers.json lists ${key}, which is not a server platform`);
  for (const [key, entry] of Object.entries(manifest.binaries ?? {})) {
    if (!(key in SERVER_PLATFORM_TARGETS)) continue;
    const bundle = join(serversDir, key, entry.bundle.file);
    if (!existsSync(bundle)) {
      problems.push(`${key}: ${bundle} is missing`);
      continue;
    }
    const archive = readFileSync(bundle);
    if (createHash('sha256').update(archive).digest('hex') !== entry.bundle.sha256) {
      problems.push(`${key}: bundle.tgz does not match servers.json`);
      continue;
    }
    // The bundle is unpacked as the ssh install does and checked as the staging checked the payload before archiving it.
    const unpacked = mkdtempSync(join(tmpdir(), 'verify-staged-bundle-'));
    try {
      // No path reaches tar: GNU tar (first on PATH under Git for Windows) cannot open a drive-letter path.
      const extraction = spawnSync('tar', ['-xzf', '-'], { cwd: unpacked, input: archive, encoding: 'utf8' });
      if (extraction.status !== 0) {
        problems.push(`${key}: tar could not unpack the bundle: ${extraction.stderr}`);
        continue;
      }
      const binary = join(unpacked, 'mixdogd');
      if (!existsSync(binary)) problems.push(`${key}: bundle.tgz holds no mixdogd`);
      else if (entry.sha256 && createHash('sha256').update(readFileSync(binary)).digest('hex') !== entry.sha256)
        problems.push(`${key}: the bundle's mixdogd does not match servers.json`);
      try {
        verifyRemotePayload({ key, payloadDir: join(unpacked, 'payload') });
      } catch (error) {
        problems.push(`${key}: ${error.message}`);
      }
      bundles.set(
        bundle,
        new Set(readdirSync(unpacked, { recursive: true }).map((path) => path.replaceAll('\\', '/')))
      );
    } finally {
      rmSync(unpacked, { recursive: true, force: true });
    }
  }
  if (problems.length) throw new Error(`server bundles are incomplete:\n- ${problems.join('\n- ')}`);
  return { bundles, platforms: Object.keys(manifest.binaries) };
}

/** Throws unless the resources are complete for `platform`/`arch` and pack no file of `deleted` (a Set of
 *  package-root-relative paths, `parseDeletionList`). */
export function verifyStagedResources({
  resources,
  platform,
  arch,
  hostOnly = false,
  deleted = parseDeletionList(readFileSync(DEFAULT_DELETION_LIST, 'utf8')),
}) {
  verifyCoreResources({ resources, platform, arch });
  const { bundles, platforms } = verifyServerBundles({ resources, hostOnly });
  const problems = [];
  for (const [where, files] of packedPackageFiles({ resources, bundles })) {
    const packed = files.filter((file) => deleted.has(file));
    if (packed.length)
      problems.push(
        `${where} packs ${packed.length} file(s) the K1 cut deletes, e.g. ${packed.slice(0, 5).join(', ')}`
      );
  }
  if (problems.length) throw new Error(`the package holds deleted files:\n- ${problems.join('\n- ')}`);
  return platforms;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const resources = argument('resources');
    if (!resources) throw new Error('usage: --resources=<dir> [--platform=<os>] [--arch=<arch>]');
    const list = argument('deletion-manifest');
    const keys = verifyStagedResources({
      deleted: list ? parseDeletionList(readFileSync(resolve(list), 'utf8')) : undefined,
      resources: resolve(resources),
      platform: argument('platform') ?? process.platform,
      arch: argument('arch') ?? process.arch,
      hostOnly: process.argv.includes('--host-only'),
    });
    console.log(
      `[verify-staged-package] ok: core, unpacked resource root, ONNX Runtime, extension host closure; bundles ${keys.join(', ')}`
    );
  } catch (error) {
    console.error(`[verify-staged-package] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
