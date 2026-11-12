#!/usr/bin/env node
// Stages the `mixdogd` binaries a desktop build ships (electron-builder.yml
// extraResources):
//   .runtime/core/mixdogd[.exe]        the core this app starts, for its own platform
//   .runtime/server-cores/<os>-<arch>/bundle.tgz + servers.json
//                                      what the SSH install uploads (LR §8.1): mixdogd and its
//                                      JS runtime (scripts/stage-js-bundle.mjs)
// It stages already-built binaries (`cargo build --release --target <triple>
// -p mixdog-cli`, one per target, in CI); it never builds and never runs a
// binary except `--version` of the host one, to prove the manifest's version is
// the version the core reports — the version `compat::order` compares.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkReleaseVersion, workspaceVersion } from '../../../scripts/check-release-version.mjs';
import {
  CORE_PLATFORM_TARGETS,
  manifestBuild,
  SERVER_MANIFEST_FILE,
  SERVER_PLATFORM_TARGETS,
} from '../src/main/ssh/server-manifest.mjs';

import { desktopJsRuntimeManifest, desktopOrtLibraryPath, JS_RUNTIME_MANIFEST, verifyRemotePayload } from './core-layout.mjs';
import { buildJsPayload, createBundleArchive } from './stage-js-bundle.mjs';

const BUNDLE_FILE = 'bundle.tgz';
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = resolve(desktopDir, '../../native/core');

/** Rust targets of the desktop's own platforms. */
export const HOST_TARGETS = CORE_PLATFORM_TARGETS;

const binaryName = (platform) => (platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');

/** `js-runtime.json`, read by `mixdogd` (mixdog-app-server-daemon `js_runtime`) beside the binary. The layout it
 *  names (the app in node mode as interpreter, the real-file package root in `runtime.asar.unpacked`, the ONNX
 *  Runtime library) is core-layout.mjs; prepare-runtime fills `runtime.asar.unpacked/node_modules`. */
export { JS_RUNTIME_MANIFEST };
export const jsRuntimeManifest = desktopJsRuntimeManifest;
export const ortLibraryPath = desktopOrtLibraryPath;

/** A server payload is complete before it is archived (core-layout.mjs), and the staged package is verified
 *  again with the same check (verify-staged-package.mjs). */
export { verifyRemotePayload };

async function builtBinary(targetDir, target, platform) {
  const file = join(targetDir, target, 'release', binaryName(platform));
  try {
    await access(file);
  } catch (error) {
    throw new Error(`mixdogd for ${target} is not built: ${file} (${error.code ?? error.message})`);
  }
  return file;
}

async function sha256Of(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export { workspaceVersion };

/**
 * @param {object} options
 * @param {string} options.targetDir   cargo target directory holding `<triple>/release/mixdogd`
 * @param {string} options.runtimeDir  `.runtime` of the desktop build
 * @param {string} options.version     the version every binary reports
 * @param {{platform: string, arch: string}} options.host  the app's own platform
 * @param {boolean} [options.hostRunnable]  this machine can run the host binary (default: it is this machine's platform)
 * @param {(file: string) => string} [options.reportedVersion]  `mixdogd --version` of the host binary
 * @param {typeof buildJsPayload} [options.buildPayload]  builds one server platform's JS runtime payload
 * @param {typeof verifyRemotePayload} [options.verifyPayload]  integrity check of that payload before it is archived
 * @param {boolean} [options.hostOnly]  stage only this app's own core: no server bundles for the ssh install, so no other
 *   platform's binary is needed (an app built for the machine it is built on, not a release)
 */
export async function stageCore({
  targetDir,
  runtimeDir,
  version,
  host,
  hostRunnable = host.platform === process.platform && host.arch === process.arch,
  reportedVersion = hostReportedVersion,
  buildPayload = buildJsPayload,
  verifyPayload = verifyRemotePayload,
  hostOnly = false,
}) {
  const hostKey = `${host.platform}-${host.arch}`;
  const hostTarget = HOST_TARGETS[hostKey];
  if (!hostTarget) throw new Error(`no mixdogd target for ${hostKey}`);

  const coreDir = join(runtimeDir, 'core');
  const serversDir = join(runtimeDir, 'server-cores');
  await rm(coreDir, { recursive: true, force: true });
  await rm(serversDir, { recursive: true, force: true });

  const hostSource = await builtBinary(targetDir, hostTarget, host.platform);
  if (hostRunnable) {
    const reported = reportedVersion(hostSource);
    if (reported !== version) {
      throw new Error(`mixdogd reports version ${reported}, but the release is ${version}`);
    }
  }
  await mkdir(coreDir, { recursive: true });
  await copyFile(hostSource, join(coreDir, binaryName(host.platform)));
  await writeFile(join(coreDir, JS_RUNTIME_MANIFEST), `${JSON.stringify(jsRuntimeManifest(host.platform, host.arch), null, 2)}\n`);

  if (hostOnly) return null;
  const binaries = {};
  for (const [key, target] of Object.entries(SERVER_PLATFORM_TARGETS)) {
    const source = await builtBinary(targetDir, target, key.split('-')[0]);
    const payloadDir = join(runtimeDir, 'server-js', key);
    await buildPayload({ key, payloadDir, cacheDir: join(runtimeDir, 'node-cache') });
    await verifyPayload({ key, payloadDir });
    await mkdir(join(serversDir, key), { recursive: true });
    // One upload per platform: the core and its JS runtime, installed together under one version directory.
    const bundle = await createBundleArchive({ binary: source, payloadDir, out: join(serversDir, key, BUNDLE_FILE) });
    binaries[key] = { sha256: await sha256Of(source), size: (await readFile(source)).length, bundle: { file: BUNDLE_FILE, ...bundle } };
  }
  const manifest = { version, build: manifestBuild(binaries), binaries };
  await writeFile(join(serversDir, SERVER_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function hostReportedVersion(file) {
  const run = spawnSync(file, ['--version'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${file} --version exited with ${run.status}: ${run.stderr}`);
  return String(run.stdout).trim().split(/\s+/).at(-1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    await checkReleaseVersion();
    const manifest = await stageCore({
      targetDir: resolve(argument('target-dir') ?? join(coreRoot, 'target')),
      runtimeDir: join(desktopDir, '.runtime'),
      version: argument('version') ?? (await workspaceVersion()),
      host: { platform: argument('platform') ?? process.platform, arch: argument('arch') ?? process.arch },
      hostOnly: process.argv.includes('--host-only'),
    });
    console.log(
      manifest
        ? `[stage-core] ${manifest.version} build ${manifest.build}: ${Object.keys(manifest.binaries).join(', ')}`
        : '[stage-core] host core only (no server bundles)'
    );
  } catch (error) {
    console.error(`[stage-core] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
