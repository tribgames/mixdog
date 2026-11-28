#!/usr/bin/env node
// Stages already-built binaries; the host binary is run only for `--version`, which must equal the manifest
// version `compat::order` compares.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkReleaseVersion, workspaceVersion } from '../../../scripts/check-release-version.mjs';
import { readTarball } from '../../../scripts/check-npm-packages.mjs';
import {
  CORE_PLATFORM_TARGETS,
  manifestBuild,
  SERVER_MANIFEST_FILE,
  SERVER_PLATFORM_TARGETS,
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

const BUNDLE_FILE = 'bundle.tgz';
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

/** A server payload is complete before it is archived (core-layout.mjs), and the staged package is verified
 *  again with the same check (verify-staged-package.mjs). */
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
 * stages only this (`--binary`, or `--host-only` over a triple build); the server bundles need the other platforms' builds.
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
  serversOnly = false,
  prebuiltServerCores = null,
}) {
  const serversDir = join(runtimeDir, 'server-cores');
  if (!serversOnly) {
    const hostKey = `${host.platform}-${host.arch}`;
    const hostTarget = HOST_TARGETS[hostKey];
    if (!hostTarget) throw new Error(`no mixdogd target for ${hostKey}`);
    await rm(serversDir, { recursive: true, force: true });
    await stageHostCore({
      binary: await builtBinary(targetDir, hostTarget, host.platform),
      askpass: await builtBinary(targetDir, hostTarget, host.platform, askpassName(host.platform)),
      runtimeDir,
      version,
      host,
      hostRunnable,
      reportedVersion,
    });
  } else {
    await rm(serversDir, { recursive: true, force: true });
  }

  if (hostOnly) return null;
  if (prebuiltServerCores) return adoptServerCores({ source: prebuiltServerCores, serversDir, targetDir, version });
  // Every binary is checked, in manifest order, before any payload is built: a missing one is reported the same
  // way on every run, and no platform's build is left running after the staging has failed.
  const sources = [];
  for (const [key, target] of Object.entries(SERVER_PLATFORM_TARGETS)) {
    sources.push([key, await builtBinary(targetDir, target, key.split('-')[0])]);
  }
  // The four platforms share nothing but the read-only pinned downloads, so they build side by side.
  const built = await Promise.all(
    sources.map(async ([key, source]) => {
      const payloadDir = join(runtimeDir, 'server-js', key);
      await buildPayload({ key, payloadDir, cacheDir: join(runtimeDir, 'node-cache') });
      await verifyPayload({ key, payloadDir });
      await mkdir(join(serversDir, key), { recursive: true });
      // One upload per platform: the core and its JS runtime, installed together under one version directory.
      const bundle = await createBundleArchive({ binary: source, payloadDir, out: join(serversDir, key, BUNDLE_FILE) });
      return [
        key,
        { sha256: await sha256Of(source), size: (await readFile(source)).length, bundle: { file: BUNDLE_FILE, ...bundle } },
      ];
    })
  );
  const binaries = Object.fromEntries(built);
  const manifest = { version, build: manifestBuild(binaries), binaries };
  await writeFile(join(serversDir, SERVER_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Takes the server bundles another job built (`--servers-only`) in place of building them: `source` holds
 * `servers.json` and `<key>/bundle.tgz`. Fails closed, never rebuilds: the manifest lists exactly the
 * server platforms and this version, every bundle matches its recorded size and sha256, the recorded
 * build is the one of its binaries, and each recorded mixdogd is the very binary this job holds for that
 * platform, or for macOS that binary with the Developer ID signature sign-server-cores.mjs adds.
 */
export async function adoptServerCores({ source, serversDir, targetDir, version }) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(source, SERVER_MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new Error(
      `the prebuilt server cores in ${source} have no readable ${SERVER_MANIFEST_FILE}: ${error.code ?? error.message}`
    );
  }
  if (manifest.version !== version) problems.push(`they are version ${manifest.version}, the release is ${version}`);
  const keys = Object.keys(manifest.binaries ?? {}).sort();
  const wanted = Object.keys(SERVER_PLATFORM_TARGETS).sort();
  if (keys.join() !== wanted.join())
    problems.push(`they list ${keys.join(', ') || 'no platform'}, not ${wanted.join(', ')}`);
  for (const [key, entry] of Object.entries(manifest.binaries ?? {})) {
    const target = SERVER_PLATFORM_TARGETS[key];
    if (!target) continue;
    if (entry?.bundle?.file !== BUNDLE_FILE) {
      problems.push(`${key}: the bundle file must be ${BUNDLE_FILE}`);
      continue;
    }
    const bundle = join(source, key, BUNDLE_FILE);
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
  if (manifest.binaries && manifestBuild(manifest.binaries) !== manifest.build)
    problems.push('the recorded build is not the build of the listed binaries');
  if (problems.length) throw new Error(`prebuilt server cores ${source} are refused:\n- ${problems.join('\n- ')}`);
  await cp(source, serversDir, { recursive: true });
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
    // bundles). Without it the host core is read from `<target-dir>/<triple>/release`; `--host-only` there also leaves
    // out the server bundles, so the other platforms' binaries are not demanded.
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
          : '[stage-core] host core only (no server bundles)'
      );
    }
  } catch (error) {
    console.error(`[stage-core] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
