#!/usr/bin/env node
// Integrity of a staged desktop package's resources (electron-builder's `<out>/win-unpacked/resources`,
// `Mixdog.app/Contents/Resources`, `linux-unpacked/resources`): what the Rust core needs is there as real files.
//
//   node apps/desktop/scripts/verify-staged-package.mjs --resources=<dir> [--platform=win32] [--arch=x64] [--deletion-manifest=<file>]
//
//   no file of the K1 deletion list (k1-deleted-files.txt, or the K1 manifest given) is packed: not in the
//   unpacked package, runtime.asar or a server bundle
//
//   core/mixdogd[.exe] and js-runtime.json     the manifest is core-layout's, the app interpreter exists
//   runtime.asar.unpacked/node_modules         package root with everything `mixdogd` reads, the extension host /
//                                              skill launcher dependency closure, the ONNX Runtime library + siblings
//   server-cores/                              each platform's bundle.tgz matches servers.json and holds mixdogd, its
//                                              js-runtime.json and the ONNX Runtime library that manifest names
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listPackage } from '@electron/asar';

import { CORE_READS, desktopMixdogRoot, PACKAGE_DIR,remoteJsRuntimeManifest, UNPACKED_NODE_MODULES, verifyCoreInstall } from './core-layout.mjs';

export const DEFAULT_DELETION_LIST = join(dirname(fileURLToPath(import.meta.url)), 'k1-deleted-files.txt');

/** Paths of a deletion list: this directory's `k1-deleted-files.txt` (bare path lines) or the K1 manifest
 *  itself (`## ` sections; only the ones that delete, not KEEP or MOVE, count). */
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

/** Package-root-relative paths of every file of the Mixdog package that `resources` holds: the real-file copy,
 *  runtime.asar and each server bundle. Keyed by where they were found. */
function packedPackageFiles({ resources, bundles }) {
  const found = new Map();
  const unpacked = join(resources, UNPACKED_NODE_MODULES, PACKAGE_DIR);
  if (existsSync(unpacked)) found.set(unpacked, readdirSync(unpacked, { recursive: true }).map((path) => path.replaceAll('\\', '/')));
  const archive = join(resources, 'runtime.asar');
  if (existsSync(archive)) {
    const prefix = `/node_modules/${PACKAGE_DIR}/`;
    found.set(archive, listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/')).filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)));
  }
  for (const [bundle, entries] of bundles) {
    const prefix = `payload/js/pkg/node_modules/${PACKAGE_DIR}/`;
    found.set(bundle, [...entries].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)));
  }
  return found;
}

/** Throws unless the resources are complete for `platform`/`arch` and pack no file of `deleted` (a Set of
 *  package-root-relative paths, `parseDeletionList`). */
export function verifyStagedResources({ resources, platform, arch, deleted = parseDeletionList(readFileSync(DEFAULT_DELETION_LIST, 'utf8')) }) {
  const exe = join(resources, 'core', platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
  if (!existsSync(exe) || !statSync(exe).isFile()) throw new Error(`the Rust core ${exe} is not in the package`);
  const mixdogRoot = desktopMixdogRoot(resources);
  const archived = existsSync(join(resources, 'runtime.asar'))
    ? new Set(listPackage(join(resources, 'runtime.asar'), { isPack: false }).map((entry) => entry.replaceAll('\\', '/')))
    : new Set();
  const asarOnly = CORE_READS.dirs.filter((dir) => !existsSync(join(mixdogRoot, '..', dir)) && archived.has(`/node_modules/${PACKAGE_DIR}/${dir}`));
  if (asarOnly.length) throw new Error(`the core's resources ${asarOnly.join(', ')} are only inside runtime.asar; MIXDOG_ROOT (${mixdogRoot}) needs real files`);
  verifyCoreInstall({ manifestDir: join(resources, 'core'), kind: 'desktop', platform, arch });

  const serversDir = join(resources, 'server-cores');
  const manifest = JSON.parse(readFileSync(join(serversDir, 'servers.json'), 'utf8'));
  const problems = [];
  const bundles = new Map();
  for (const [key, entry] of Object.entries(manifest.binaries)) {
    const bundle = join(serversDir, key, entry.bundle.file);
    if (!existsSync(bundle)) {
      problems.push(`${key}: ${bundle} is missing`);
      continue;
    }
    const bytes = readFileSync(bundle);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.bundle.sha256) problems.push(`${key}: bundle.tgz does not match servers.json`);
    const [serverPlatform, serverArch] = key.split('-');
    const listing = spawnSync('tar', ['-tzf', bundle], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (listing.status !== 0) {
      problems.push(`${key}: tar could not list the bundle: ${listing.stderr}`);
      continue;
    }
    const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\.\//, '').replace(/\/$/, '')));
    bundles.set(bundle, entries);
    const wanted = remoteJsRuntimeManifest(serverPlatform, serverArch);
    for (const file of ['mixdogd', 'payload/js-runtime.json', `payload/${posix.normalize(wanted.packageRoot)}/package.json`, ...(wanted.ortLibrary ? [`payload/${wanted.ortLibrary}`] : [])]) {
      if (!entries.has(file)) problems.push(`${key}: bundle.tgz holds no ${file}`);
    }
  }
  if (problems.length) throw new Error(`server bundles are incomplete:\n- ${problems.join('\n- ')}`);

  for (const [where, files] of packedPackageFiles({ resources, bundles })) {
    const packed = files.filter((file) => deleted.has(file));
    if (packed.length) problems.push(`${where} packs ${packed.length} file(s) the K1 cut deletes, e.g. ${packed.slice(0, 5).join(', ')}`);
  }
  if (problems.length) throw new Error(`the package holds deleted files:\n- ${problems.join('\n- ')}`);
  return Object.keys(manifest.binaries);
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
    });
    console.log(`[verify-staged-package] ok: core, unpacked resource root, ONNX Runtime, extension host closure; bundles ${keys.join(', ')}`);
  } catch (error) {
    console.error(`[verify-staged-package] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
