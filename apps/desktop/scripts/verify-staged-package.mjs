#!/usr/bin/env node
// node apps/desktop/scripts/verify-staged-package.mjs --resources=<dir> [--platform=win32] [--arch=x64] [--deletion-manifest=<file>]
// node apps/desktop/scripts/verify-staged-package.mjs --server-set=<dir> [--deletion-manifest=<file>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { nativeBinaryRunsOn } from '../../../scripts/native-binary-arch.mjs';
import {
  SERVER_MANIFEST_FILE,
  SERVER_PLATFORM_TARGETS,
  serverBundleAsset,
  serverManifestProblems,
} from '../src/main/ssh/server-manifest.mjs';
import {
  desktopMixdogRoot,
  PACKAGE_DIR,
  UNPACKED_NODE_MODULES,
  verifyCoreInstall,
  verifyRemotePayload,
} from './core-layout.mjs';
import { hostReportedVersion } from './stage-core.mjs';

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

const defaultDeleted = () => parseDeletionList(readFileSync(DEFAULT_DELETION_LIST, 'utf8'));

/** The problem of a copy of the Mixdog package at `where` whose package-root-relative `files` include some of `deleted`. */
function packedDeleted(where, files, deleted) {
  const packed = files.filter((file) => deleted.has(file));
  return packed.length
    ? `${where} packs ${packed.length} file(s) the K1 cut deletes, e.g. ${packed.slice(0, 5).join(', ')}`
    : null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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

/** The core this app starts runs here: `mixdogd --version` answers, with the version of the server manifest the package
 *  carries when it carries one. A package for another machine cannot be run, so it is not. */
function verifyHostCore({ resources, platform, version, hostRunnable, reportedVersion }) {
  if (!hostRunnable) return;
  const exe = join(resources, 'core', platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
  let reported;
  try {
    reported = reportedVersion(exe);
  } catch (error) {
    throw new Error(`the Rust core ${exe} does not run: ${error.message}`);
  }
  if (version !== undefined && reported !== version)
    throw new Error(`the Rust core ${exe} reports version ${reported}, the server manifest is ${version}`);
}

/** The package carries the server bundles' manifest and no bundle: `server-cores` holds `servers.json` alone, the manifest
 *  of a release (server-manifest.mjs), and no server bundle is anywhere in the resources. A host-only package (stage-core
 *  --host-only) carries no manifest. Returns the manifest, or null. */
function verifyServerManifest({ resources, hostOnly }) {
  const serversDir = join(resources, 'server-cores');
  const problems = [];
  for (const path of readdirSync(resources, { recursive: true }))
    if (/^mixdog-server-.+\.tgz$|^bundle\.tgz$/.test(basename(path)))
      problems.push(`${join(resources, path)} is a server bundle: those are release assets, the package carries their manifest`);
  if (existsSync(serversDir))
    for (const name of readdirSync(serversDir))
      if (name !== SERVER_MANIFEST_FILE) problems.push(`${join(serversDir, name)} is packed beside ${SERVER_MANIFEST_FILE}`);
  let manifest = null;
  if (!hostOnly) {
    manifest = JSON.parse(readFileSync(join(serversDir, SERVER_MANIFEST_FILE), 'utf8'));
    problems.push(...serverManifestProblems(manifest).map((problem) => `${SERVER_MANIFEST_FILE}: ${problem}`));
  }
  if (problems.length) throw new Error(`the package's server runtimes are not its manifest alone:\n- ${problems.join('\n- ')}`);
  return manifest;
}

/**
 * The release's server set (`stage-core --servers-only`, its macOS bundles signed by sign-server-cores.mjs): `servers.json`
 * and the asset of each server platform, nothing else. Each bundle has the length and sha256 the manifest lists, is unpacked
 * as the ssh install unpacks it and checked as the staging checked its payload, and packs no file of `deleted`. Throws;
 * returns the platform keys.
 */
export function verifyServerSet({ dir, deleted = defaultDeleted() }) {
  const manifest = JSON.parse(readFileSync(join(dir, SERVER_MANIFEST_FILE), 'utf8'));
  const problems = serverManifestProblems(manifest).map((problem) => `${SERVER_MANIFEST_FILE}: ${problem}`);
  const assets = Object.keys(SERVER_PLATFORM_TARGETS).map(serverBundleAsset);
  for (const name of readdirSync(dir))
    if (name !== SERVER_MANIFEST_FILE && !assets.includes(name)) problems.push(`${name} is not part of a server set`);
  for (const [key, entry] of Object.entries(manifest.binaries ?? {})) {
    if (!(key in SERVER_PLATFORM_TARGETS) || entry?.bundle?.asset !== serverBundleAsset(key)) continue;
    const { asset } = entry.bundle;
    const bundle = join(dir, asset);
    if (!existsSync(bundle)) {
      problems.push(`${key}: ${bundle} is missing`);
      continue;
    }
    const archive = readFileSync(bundle);
    if (archive.length !== entry.bundle.size || sha256(archive) !== entry.bundle.sha256) {
      problems.push(`${key}: ${asset} does not match ${SERVER_MANIFEST_FILE}`);
      continue;
    }
    // The bundle is unpacked as the ssh install does and checked as the staging checked the payload before archiving it.
    const unpacked = mkdtempSync(join(tmpdir(), 'verify-server-bundle-'));
    try {
      // No path reaches tar: GNU tar (first on PATH under Git for Windows) cannot open a drive-letter path.
      const extraction = spawnSync('tar', ['-xzf', '-'], { cwd: unpacked, input: archive, encoding: 'utf8' });
      if (extraction.status !== 0) {
        problems.push(`${key}: tar could not unpack ${asset}: ${extraction.stderr}`);
        continue;
      }
      const binary = join(unpacked, 'mixdogd');
      if (!existsSync(binary)) problems.push(`${key}: ${asset} holds no mixdogd`);
      else if (sha256(readFileSync(binary)) !== entry.sha256)
        problems.push(`${key}: the bundle's mixdogd does not match ${SERVER_MANIFEST_FILE}`);
      try {
        verifyRemotePayload({ key, payloadDir: join(unpacked, 'payload') });
      } catch (error) {
        problems.push(`${key}: ${error.message}`);
      }
      const prefix = `payload/js/pkg/node_modules/${PACKAGE_DIR}/`;
      const files = readdirSync(unpacked, { recursive: true })
        .map((path) => path.replaceAll('\\', '/'))
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
      const packed = packedDeleted(asset, files, deleted);
      if (packed) problems.push(packed);
    } finally {
      rmSync(unpacked, { recursive: true, force: true });
    }
  }
  if (problems.length) throw new Error(`the server set is incomplete:\n- ${problems.join('\n- ')}`);
  return Object.keys(manifest.binaries);
}

/** Throws unless the resources are complete for `platform`/`arch`, their core runs here (when this machine can run it),
 *  they carry the server bundles' manifest and no bundle, and they pack no file of `deleted` (a Set of
 *  package-root-relative paths, `parseDeletionList`). Returns the server platforms of the manifest. */
export function verifyStagedResources({
  resources,
  platform,
  arch,
  hostOnly = false,
  deleted = defaultDeleted(),
  hostRunnable = platform === process.platform && arch === process.arch,
  reportedVersion = hostReportedVersion,
}) {
  verifyCoreResources({ resources, platform, arch });
  const manifest = verifyServerManifest({ resources, hostOnly });
  verifyHostCore({ resources, platform, version: manifest?.version, hostRunnable, reportedVersion });
  const unpacked = join(resources, UNPACKED_NODE_MODULES, PACKAGE_DIR);
  if (existsSync(unpacked)) {
    const files = readdirSync(unpacked, { recursive: true }).map((path) => path.replaceAll('\\', '/'));
    const packed = packedDeleted(unpacked, files, deleted);
    if (packed) throw new Error(`the package holds deleted files:\n- ${packed}`);
  }
  return Object.keys(manifest?.binaries ?? {});
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const list = argument('deletion-manifest');
    const deleted = list ? parseDeletionList(readFileSync(resolve(list), 'utf8')) : undefined;
    const set = argument('server-set');
    const resources = argument('resources');
    if (set) {
      const keys = verifyServerSet({ dir: resolve(set), deleted });
      console.log(`[verify-staged-package] ok: server set ${keys.join(', ')}`);
    } else if (resources) {
      const keys = verifyStagedResources({
        deleted,
        resources: resolve(resources),
        platform: argument('platform') ?? process.platform,
        arch: argument('arch') ?? process.arch,
        hostOnly: process.argv.includes('--host-only'),
      });
      console.log(
        `[verify-staged-package] ok: core, unpacked resource root, ONNX Runtime, extension host closure; server manifest ${keys.join(', ') || 'none'}`
      );
    } else {
      throw new Error('usage: --resources=<dir> [--platform=<os>] [--arch=<arch>] [--host-only] | --server-set=<dir>');
    }
  } catch (error) {
    console.error(`[verify-staged-package] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
