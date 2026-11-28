#!/usr/bin/env node
// `mixdog-runtime`: the native runtime of this package (bin/runtime.mjs) on request, and the package's postinstall.
//   mixdog-runtime status                    what this machine needs, from where, and whether it is installed
//   mixdog-runtime prefetch                  downloads, verifies and installs the runtime of this machine
//   mixdog-runtime prefetch --out <folder> [--target <key>]... [--all]
//                                            downloads and verifies archives into <folder>, for a machine without the network
//   mixdog-runtime import <archive>          verifies a downloaded archive against the manifest and installs it
// The postinstall provisions when it can and never fails a user's install for want of the network: the launcher fetches
// at first use and says what to import. It fails the install of a staged update, the package 1.4.5's staged-update.mjs
// installs into `<data>/staging/<version>/install`: an update whose runtime is not ready must not replace the version that
// works. The core's updater (update_installer.rs) installs there too, but fetches the runtime itself, and says so.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { download } from './download.mjs';
import {
  RUNTIME_MANIFEST,
  assetUrl,
  dataDir,
  importRuntime,
  missingRuntimeMessage,
  provision,
  readRuntimeManifest,
  resolveRuntime,
  runtimeCacheRoot,
  runtimeFolder,
  selectTarget,
  verifyArchive,
} from './runtime.mjs';
import { renameWithRetry } from './rename.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = 'usage: mixdog-runtime status | prefetch [--out <folder> [--target <key>]... [--all]] | import <archive>\n';

/** Whether the package at `packageRoot` is the staged update of its version: `<data>/staging/<version>/install/node_modules/mixdog`. */
export function isStagedInstall(packageRoot, env = process.env) {
  try {
    const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return realpathSync(join(dataDir(env), 'staging', version, 'install', 'node_modules', 'mixdog')) === realpathSync(packageRoot);
  } catch {
    return false;
  }
}

/**
 * Whether what this process creates in `dir` belongs to the user who runs mixdog: not root installing for another user
 * (`sudo`, SUDO_UID), and the nearest folder of `dir` that exists is this user's (macOS sudo keeps the user's HOME).
 */
export function ownsLocation(dir, { env = process.env, platform = process.platform, uid = platform === 'win32' ? undefined : process.geteuid() } = {}) {
  if (platform === 'win32') return true;
  if (uid === 0 && env.SUDO_UID && env.SUDO_UID !== '0') return false;
  for (let current = resolve(dir); ; current = dirname(current)) {
    try {
      return statSync(current).uid === uid;
    } catch {
      if (dirname(current) === current) return false;
    }
  }
}

function status({ packageRoot, data, platform, arch, stdout }) {
  const found = resolveRuntime({ packageRoot, platform, arch, data });
  if (found.error) throw new Error(found.error);
  if (found.unsupported) throw new Error(`mixdog has no runtime for ${platform}-${arch} (it has ${Object.keys(found.manifest.targets).join(', ')})`);
  const { manifest, cacheRoot, key, entry } = found;
  stdout.write(
    [
      `mixdog ${entry.version} (build ${entry.buildId}) on ${platform}-${arch}: runtime ${key}`,
      `asset   ${entry.asset}, ${entry.length} bytes, SHA-256 ${entry.sha256}`,
      `source  ${assetUrl(manifest, entry)}`,
      `cache   ${runtimeFolder(cacheRoot, key, entry)} (${found.ready ? 'installed' : 'not installed'})`,
      '',
    ].join('\n')
  );
  return found.ready ? 0 : 1;
}

/** Downloads the archive of `key` into `out` under its asset name, verified; one that is already there and verifies is kept. */
async function saveArchive({ manifest, key, out, env, fetchArchive, stderr }) {
  const entry = manifest.targets[key];
  const file = join(out, entry.asset);
  if (existsSync(file)) {
    try {
      await verifyArchive(file, entry);
      return file;
    } catch {
      // Another file by that name: replaced below.
    }
  }
  const partial = `${file}.partial-${process.pid}`;
  stderr.write(`mixdog: downloading ${entry.asset} (${Math.ceil(entry.length / 1e6)} MB) from ${assetUrl(manifest, entry)}\n`);
  try {
    await fetchArchive({ url: assetUrl(manifest, entry), file: partial, length: entry.length, env, userAgent: `mixdog-runtime/${entry.version}` });
    await verifyArchive(partial, entry);
    rmSync(file, { force: true });
    renameWithRetry(partial, file);
  } finally {
    rmSync(partial, { force: true });
  }
  return file;
}

async function prefetch({ args, packageRoot, data, env, platform, arch, stdout, stderr, fetchArchive }) {
  const value = (name) => args.flatMap((arg, at) => (arg === name && args[at + 1] !== undefined ? [args[at + 1]] : []));
  const out = value('--out')[0];
  if (!out) {
    const found = resolveRuntime({ packageRoot, platform, arch, data });
    if (found.error) throw new Error(found.error);
    if (found.unsupported) throw new Error(`mixdog has no runtime for ${platform}-${arch}`);
    if (found.missing) {
      try {
        await provision(found, { env, stderr, fetchArchive });
      } catch (error) {
        stderr.write(missingRuntimeMessage({ ...found, packageRoot, reason: error.message }));
        return 1;
      }
    }
    stdout.write(`${runtimeFolder(found.cacheRoot, found.key, found.entry)}\n`);
    return 0;
  }
  const manifest = readRuntimeManifest(packageRoot);
  const known = Object.keys(manifest.targets);
  const keys = args.includes('--all') ? known : value('--target').length > 0 ? value('--target') : [selectTarget(manifest, platform, arch)?.key];
  for (const key of keys) if (!known.includes(key)) throw new Error(`mixdog ${manifest.targets[known[0]].version} has no runtime for ${key ?? `${platform}-${arch}`} (it has ${known.join(', ')})`);
  mkdirSync(out, { recursive: true });
  for (const key of keys) stdout.write(`${await saveArchive({ manifest, key, out: resolve(out), env, fetchArchive, stderr })}\n`);
  return 0;
}

async function postinstall({ packageRoot, data, env, platform, arch, stderr, fetchArchive }) {
  // A source checkout has no manifest: there is nothing to provision.
  if (!existsSync(join(packageRoot, 'bin', RUNTIME_MANIFEST))) return 0;
  // The core's updater (update_installer.rs) fetches it once npm is done, through GitHub's proxy route; npm's is the registry's.
  if (env.MIXDOG_RUNTIME_PROVISION === 'updater') return 0;
  const staged = isStagedInstall(packageRoot, env);
  const failed = (text) => {
    stderr.write(text);
    stderr.write(staged ? 'mixdog: this staged update is incomplete; the installed version keeps running.\n' : 'mixdog: the install goes on; mixdog fetches the runtime when it first starts.\n');
    return staged ? 1 : 0;
  };
  const found = resolveRuntime({ packageRoot, platform, arch, data });
  if (found.error) return failed(`mixdog: ${found.error}\n`);
  if (found.unsupported) return failed(`mixdog: there is no runtime for ${platform}-${arch}\n`);
  if (found.ready) return 0;
  if (!ownsLocation(runtimeCacheRoot(data), { env })) {
    return failed(`mixdog: not fetching the runtime into ${runtimeCacheRoot(data)}, which is not this user's: the user who runs mixdog fetches it\n`);
  }
  try {
    await provision(found, { env, stderr, fetchArchive });
    return 0;
  } catch (error) {
    return failed(missingRuntimeMessage({ ...found, packageRoot, reason: error.message }));
  }
}

/** The command; its exit code. */
export async function runCli(
  argv,
  {
    packageRoot = PACKAGE_ROOT,
    env = process.env,
    data = dataDir(env),
    platform = process.platform,
    arch = process.arch,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchArchive = download,
  } = {}
) {
  const [command, ...args] = argv;
  const context = { args, packageRoot, data, env, platform, arch, stdout, stderr, fetchArchive };
  try {
    if (command === 'status') return status(context);
    if (command === 'prefetch') return await prefetch(context);
    if (command === 'postinstall') return await postinstall(context);
    if (command === 'import' && args.length === 1) {
      const folder = await importRuntime({ file: resolve(args[0]), manifest: readRuntimeManifest(packageRoot), cacheRoot: runtimeCacheRoot(data), platform, arch });
      stdout.write(`${folder}\n`);
      return 0;
    }
  } catch (error) {
    stderr.write(`mixdog-runtime: ${error.message}\n`);
    return 1;
  }
  stderr.write(USAGE);
  return 2;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await runCli(process.argv.slice(2));