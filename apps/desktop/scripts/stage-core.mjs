#!/usr/bin/env node
// Stages already-built binaries; the host binary is run only for `--version`, which must equal the manifest
// version `compat::order` compares.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkReleaseVersion, workspaceVersion } from '../../../scripts/check-release-version.mjs';
import { readTarball } from '../../../scripts/check-npm-packages.mjs';
import {
  CORE_PLATFORM_TARGETS,
  manifestBuild,
  SERVER_MANIFEST_FILE,
  SERVER_PLATFORM_TARGETS,
  serverBundleAsset,
  serverManifestProblems,
} from '../src/main/ssh/server-manifest.mjs';

import {
  desktopJsRuntimeManifest,
  desktopOrtLibraryPath,
  JS_RUNTIME_MANIFEST,
  stageOfficeTemplates,
  verifyRemotePayload,
} from './core-layout.mjs';
import { sameUnsignedCode } from './macho-signature.mjs';
import { buildJsPayload, createBundleArchive } from './stage-js-bundle.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = resolve(desktopDir, '../../native/core');

/** Rust targets of the desktop's own platforms. */
export const HOST_TARGETS = CORE_PLATFORM_TARGETS;

const exeName = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);
const binaryName = (platform) => exeName('mixdogd', platform);
const askpassName = (platform) => exeName('mixdog-askpass', platform);

/** `js-runtime.json`, read by `mixdogd` (mixdog-app-server-daemon `js_runtime`) beside the binary. The layout it
 *  names (the app in node mode as interpreter, the real-file package root in `runtime.asar.unpacked`, the ONNX
 *  Runtime library) is core-layout.mjs; prepare-runtime fills `runtime.asar.unpacked/node_modules`. */
export { JS_RUNTIME_MANIFEST };
export const jsRuntimeManifest = desktopJsRuntimeManifest;
export const ortLibraryPath = desktopOrtLibraryPath;

/** A server payload is complete before it is archived (core-layout.mjs), and the release's server set is verified
 *  again with the same check before its assets are uploaded (verify-staged-package.mjs `verifyServerSet`). */
export { verifyRemotePayload };

async function builtBinary(targetDir, target, platform, name = binaryName(platform)) {
  const file = join(targetDir, target, 'release', name);
  try {
    await access(file);
  } catch (error) {
    throw new Error(`${name} for ${target} is not built: ${file} (${error.code ?? error.message})`);
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
 * Stages the core this app starts: `.runtime/core/mixdogd[.exe]`, the `mixdog-askpass[.exe]` beside it and its
 * `js-runtime.json`. A local deploy
 * stages only this (`--binary`, or `--host-only` over a triple build); the server set needs the other platforms' builds.
 * @param {object} options
 * @param {string} options.binary      the built `mixdogd` of the host platform
 * @param {string} [options.askpass]   the built `mixdog-askpass` (default: the one beside `binary`, where one cargo build puts both)
 */
export async function stageHostCore({
  binary,
  runtimeDir,
  version,
  host,
  askpass = join(dirname(binary), askpassName(host.platform)),
  hostRunnable = host.platform === process.platform && host.arch === process.arch,
  reportedVersion = hostReportedVersion,
}) {
  if (hostRunnable) {
    const reported = reportedVersion(binary);
    if (reported !== version) {
      throw new Error(`mixdogd reports version ${reported}, but the release is ${version}`);
    }
  }
  try {
    await access(askpass);
  } catch (error) {
    throw new Error(`mixdog-askpass is not built: ${askpass} (${error.code ?? error.message})`);
  }
  const coreDir = join(runtimeDir, 'core');
  await rm(coreDir, { recursive: true, force: true });
  await mkdir(coreDir, { recursive: true });
  await copyFile(binary, join(coreDir, binaryName(host.platform)));
  await copyFile(askpass, join(coreDir, askpassName(host.platform)));
  await writeFile(
    join(coreDir, JS_RUNTIME_MANIFEST),
    `${JSON.stringify(jsRuntimeManifest(host.platform, host.arch), null, 2)}\n`
  );
  await stageOfficeTemplates(coreDir);
}

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
 * @param {boolean} [options.hostOnly]  stage only this app's own core: no server manifest for the ssh install, so no other
 *   platform's binary is needed (an app built for the machine it is built on, not a release)
 * @param {boolean} [options.serversOnly]  build only the server set, no host core
 * @param {string} [options.prebuiltServerCores]  a server set another job built, taken in place of building one
 *
 * `.runtime/server-cores` is the server set: `servers.json` and, when this machine built the set, each server platform's
 * asset beside it, which the core of a development tree uploads from there. A package carries `servers.json` alone
 * (electron-builder.yml); the release uploads the assets.
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
  serversOnly = false,
  prebuiltServerCores = null,
}) {
  const serversDir = join(runtimeDir, 'server-cores');
  await rm(serversDir, { recursive: true, force: true });
  if (!serversOnly) {
    const hostKey = `${host.platform}-${host.arch}`;
    const hostTarget = HOST_TARGETS[hostKey];
    if (!hostTarget) throw new Error(`no mixdogd target for ${hostKey}`);
    await stageHostCore({
      binary: await builtBinary(targetDir, hostTarget, host.platform),
      askpass: await builtBinary(targetDir, hostTarget, host.platform, askpassName(host.platform)),
      runtimeDir,
      version,
      host,
      hostRunnable,
      reportedVersion,
    });
  }

  if (hostOnly) return null;
  if (prebuiltServerCores) return adoptServerCores({ source: prebuiltServerCores, serversDir, targetDir, version });
  // Every binary is checked, in manifest order, before any payload is built: a missing one is reported the same
  // way on every run, and no platform's build is left running after the staging has failed.
  const sources = [];
  for (const [key, target] of Object.entries(SERVER_PLATFORM_TARGETS)) {
    sources.push([key, target, await builtBinary(targetDir, target, key.split('-')[0])]);
  }
  await mkdir(serversDir, { recursive: true });
  // The four platforms share nothing but the read-only pinned downloads, so they build side by side.
  const built = await Promise.all(
    sources.map(async ([key, target, source]) => {
      const payloadDir = join(runtimeDir, 'server-js', key);
      await buildPayload({ key, payloadDir, cacheDir: join(runtimeDir, 'node-cache') });
      await verifyPayload({ key, payloadDir });
      // One upload per platform: the core and its JS runtime, installed together under one version directory.
      const asset = serverBundleAsset(key);
      const bundle = await createBundleArchive({ binary: source, payloadDir, out: join(serversDir, asset) });
      return [
        key,
        { target, sha256: await sha256Of(source), size: (await readFile(source)).length, bundle: { asset, ...bundle } },
      ];
    })
  );
  const binaries = Object.fromEntries(built);
  const manifest = { version, build: manifestBuild(binaries), binaries };
  await writeFile(join(serversDir, SERVER_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Takes the server set another job built (`--servers-only`, its macOS bundles signed by sign-server-cores.mjs) in place
 * of building one: `source` holds `servers.json` and each platform's asset. Fails closed, never rebuilds: the manifest is
 * the one of a release of this version (server-manifest.mjs), every bundle matches its recorded size and sha256, and each
 * recorded mixdogd is the very binary this job holds for that platform, or for macOS that binary with the Developer ID
 * signature added. Only the manifest is staged for the app: the bundles are release assets.
 */
export async function adoptServerCores({ source, serversDir, targetDir, version }) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(source, SERVER_MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new Error(
      `the prebuilt server cores in ${source} have no readable ${SERVER_MANIFEST_FILE}: ${error.code ?? error.message}`
    );
  }
  const problems = serverManifestProblems(manifest, { version });
  for (const [key, entry] of Object.entries(manifest.binaries ?? {})) {
    const target = SERVER_PLATFORM_TARGETS[key];
    if (!target || entry?.bundle?.asset !== serverBundleAsset(key)) continue;
    const bundle = join(source, entry.bundle.asset);
    try {
      const bytes = await readFile(bundle);
      if (bytes.length !== entry.bundle.size)
        problems.push(`${key}: ${bundle} is ${bytes.length} bytes, the manifest says ${entry.bundle.size}`);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.bundle.sha256)
        problems.push(`${key}: ${bundle} does not match the manifest`);
    } catch (error) {
      problems.push(`${key}: ${bundle} is not readable (${error.code ?? error.message})`);
    }
    try {
      const platform = key.split('-')[0];
      const built = await readFile(await builtBinary(targetDir, target, platform));
      if (createHash('sha256').update(built).digest('hex') !== entry.sha256) {
        const problem =
          platform === 'darwin'
            ? signedCoreProblem({ bundle, entry, built, target })
            : `the bundled mixdogd is not the mixdogd built for ${target}`;
        if (problem) problems.push(`${key}: ${problem}`);
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length) throw new Error(`prebuilt server cores ${source} are refused:\n- ${problems.join('\n- ')}`);
  await mkdir(serversDir, { recursive: true });
  await copyFile(join(source, SERVER_MANIFEST_FILE), join(serversDir, SERVER_MANIFEST_FILE));
  return manifest;
}

/** Why the signed macOS core in `bundle` is not `built`, or null when it is that program: the bundled binary is the one
 *  the manifest records, and with its code signature set aside the same bytes as the build. */
function signedCoreProblem({ bundle, entry, built, target }) {
  let bundled;
  try {
    bundled = readTarball(bundle).find((file) => file.path === 'mixdogd')?.data;
  } catch (error) {
    return `${bundle} could not be unpacked (${error.message})`;
  }
  if (!bundled || createHash('sha256').update(bundled).digest('hex') !== entry.sha256)
    return "the bundle's mixdogd does not match the manifest";
  const notBuilt = `the bundled mixdogd is not the mixdogd built for ${target}`;
  try {
    return sameUnsignedCode(bundled, built) ? null : notBuilt;
  } catch (error) {
    return `${notBuilt} (${error.message})`;
  }
}

export function hostReportedVersion(file) {
  const run = spawnSync(file, ['--version'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${file} --version exited with ${run.status}: ${run.stderr}`);
  return String(run.stdout).trim().split(/\s+/).at(-1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    await checkReleaseVersion();
    // `--binary=<exe>`: the host core from any cargo build (the local deploy: no `<triple>` directory, no server
    // manifest). Without it the host core is read from `<target-dir>/<triple>/release`; `--host-only` there also leaves
    // out the server set, so the other platforms' binaries are not demanded. `--servers-only` builds the server set
    // alone; `--server-cores=<set>` takes one another job built and stages its manifest.
    const binary = argument('binary');
    if (binary) {
      // Local deploy: the host core only, from `cargo build --release -p mixdog-cli -p mixdog-askpass` (no `<triple>` directory).
      await stageHostCore({
        binary: resolve(binary),
        runtimeDir: join(desktopDir, '.runtime'),
        version: argument('version') ?? (await workspaceVersion()),
        host: { platform: argument('platform') ?? process.platform, arch: argument('arch') ?? process.arch },
      });
      console.log(`[stage-core] host core only: ${binary}`);
    } else {
      const manifest = await stageCore({
        targetDir: resolve(argument('target-dir') ?? join(coreRoot, 'target')),
        runtimeDir: join(desktopDir, '.runtime'),
        version: argument('version') ?? (await workspaceVersion()),
        host: { platform: argument('platform') ?? process.platform, arch: argument('arch') ?? process.arch },
        hostOnly: process.argv.includes('--host-only'),
        serversOnly: process.argv.includes('--servers-only'),
        prebuiltServerCores: argument('server-cores') ? resolve(argument('server-cores')) : null,
      });
      console.log(
        manifest
          ? `[stage-core] ${manifest.version} build ${manifest.build}: ${Object.keys(manifest.binaries).join(', ')}`
          : '[stage-core] host core only (no server manifest)'
      );
    }
  } catch (error) {
    console.error(`[stage-core] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
