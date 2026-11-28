#!/usr/bin/env node
// Signs every Mach-O file of the macOS server bundles (mixdogd and the native files of its JS runtime) with a Developer
// ID, the hardened runtime and a secure timestamp: the bundles are assets of the release that a desktop uploads to a Mac
// over ssh, and the programs run there as the project signed them. Runs once per release on macOS
// (server-cores-build.yml) over the set `stage-core.mjs --servers-only` built (`servers.json` and one asset per server
// platform); the Linux bundles pass through untouched. Signing runs no program of the bundles; `--start` runs the signed
// core apart, where no certificate is.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { manifestBuild, SERVER_MANIFEST_FILE } from '../src/main/ssh/server-manifest.mjs';
import { optionValue } from './cli-args.mjs';
import { JS_RUNTIME_MANIFEST, verifyRemotePayload } from './core-layout.mjs';
import { isMachO, sameUnsignedCode } from './macho-signature.mjs';
import { hostReportedVersion } from './stage-core.mjs';
import { createBundleArchive } from './stage-js-bundle.mjs';

const execFileAsync = promisify(execFile);

/** The one hardened-runtime exception the core uses: its PCRE2 search compiles a pattern to machine code in MAP_JIT
 *  memory (mixdog-workspace localfs, `jit_if_available`). Library validation stays on: the one library it opens is the
 *  ONNX Runtime of its own bundle, which is signed here by the same team. */
const CORE_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key>
	<true/>
</dict>
</plist>
`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function runCodesign(args) {
  const run = spawnSync('codesign', args, { encoding: 'utf8' });
  if (run.error) throw run.error;
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** The signature of `file` as notarization judges it, or null when it has no valid one. */
function signatureOf(file, codesign) {
  if (codesign(['--verify', '--strict', file]).status !== 0) return null;
  const shown = codesign(['--display', '--verbose=4', file]);
  if (shown.status !== 0) return null;
  return {
    developerId: /^Authority=Developer ID Application: /m.test(shown.output),
    timestamp: /^Timestamp=/m.test(shown.output),
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(shown.output),
    team: /^TeamIdentifier=(\S+)$/m.exec(shown.output)?.[1] ?? null,
  };
}

const notarizable = (signature) => Boolean(signature?.developerId && signature.timestamp && signature.runtime);

async function filesUnder(dir, relative = '') {
  const files = [];
  for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(dir, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

/**
 * Writes to `out` (a new directory) the server cores of `source` with their macOS bundles signed by `identity`, and
 * their manifest recording the signed binaries. Refuses a bundle in which any Mach-O file is left without a
 * notarizable signature, whose ONNX Runtime library is not signed by the core's team, or whose mixdogd is not the
 * built one with a signature added.
 * @param {object} options
 * @param {(args: string[]) => {status: number, output: string}} [options.codesign]  runs `codesign`
 * @param {typeof verifyRemotePayload} [options.verifyPayload]  integrity check of a payload before it is archived again
 */
export async function signServerCores({
  source,
  out,
  identity,
  keychain,
  codesign = runCodesign,
  verifyPayload = verifyRemotePayload,
}) {
  if (!source || !out || !identity)
    throw new Error('the server cores, the output directory and the signing identity are required');
  const work = `${out}.work`;
  for (const dir of [out, work]) if (existsSync(dir)) throw new Error(`${dir} exists: the signed set is written anew`);
  const manifest = JSON.parse(await readFile(join(source, SERVER_MANIFEST_FILE), 'utf8'));
  await cp(source, out, { recursive: true });
  await mkdir(work);
  try {
    const entitlements = join(work, 'mixdogd.entitlements.plist');
    await writeFile(entitlements, CORE_ENTITLEMENTS);
    for (const [key, entry] of Object.entries(manifest.binaries)) {
      if (!key.startsWith('darwin-')) continue;
      const bundle = join(source, entry.bundle.asset);
      if (sha256(await readFile(bundle)) !== entry.bundle.sha256)
        throw new Error(`${key}: ${bundle} does not match ${SERVER_MANIFEST_FILE}`);
      const dir = join(work, key);
      await mkdir(dir);
      await execFileAsync('tar', ['-xzf', bundle, '-C', dir]);
      const binary = join(dir, 'mixdogd');
      const built = await readFile(binary);
      if (sha256(built) !== entry.sha256)
        throw new Error(`${key}: the bundle's mixdogd does not match ${SERVER_MANIFEST_FILE}`);
      const programs = [];
      for (const file of await filesUnder(dir)) if (await isMachO(join(dir, file))) programs.push(file);
      if (!programs.includes('mixdogd')) throw new Error(`${key}: the bundle's mixdogd is not a Mach-O program`);
      for (const file of programs) {
        const path = join(dir, file);
        // A vendor's notarizable signature (the pinned Node's) is kept: it carries the entitlements its program needs.
        if (notarizable(signatureOf(path, codesign))) continue;
        const signed = codesign([
          '--force',
          '--sign',
          identity,
          ...(keychain ? ['--keychain', keychain] : []),
          '--timestamp',
          '--options',
          'runtime',
          ...(file === 'mixdogd' ? ['--entitlements', entitlements] : []),
          path,
        ]);
        if (signed.status !== 0) throw new Error(`${key}: codesign could not sign ${file}:\n${signed.output}`);
      }
      const problems = programs
        .filter((file) => !notarizable(signatureOf(join(dir, file), codesign)))
        .map((file) => `${file} has no valid Developer ID signature with a secure timestamp and the hardened runtime`);
      // Under the hardened runtime the core opens only a library its own team signed.
      const { ortLibrary } = JSON.parse(await readFile(join(dir, 'payload', JS_RUNTIME_MANIFEST), 'utf8'));
      const team = signatureOf(binary, codesign)?.team;
      if (ortLibrary && signatureOf(join(dir, 'payload', ortLibrary), codesign)?.team !== team)
        problems.push(`${ortLibrary}, which mixdogd loads, is not signed by its team ${team}`);
      const signedBinary = await readFile(binary);
      // Each package takes the bundled core for its own build by this comparison (stage-core.mjs adoptServerCores).
      if (!sameUnsignedCode(built, signedBinary)) problems.push('codesign changed more of mixdogd than its signature');
      if (problems.length) throw new Error(`${key}: the signed bundle is refused:\n- ${problems.join('\n- ')}`);
      await verifyPayload({ key, payloadDir: join(dir, 'payload') });
      const archive = await createBundleArchive({
        binary,
        payloadDir: join(dir, 'payload'),
        out: join(out, entry.bundle.asset),
      });
      manifest.binaries[key] = {
        ...entry,
        sha256: sha256(signedBinary),
        size: signedBinary.length,
        bundle: { ...entry.bundle, ...archive },
      };
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  manifest.build = manifestBuild(manifest.binaries);
  await writeFile(join(out, SERVER_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Starts the core of `host`'s platform from its bundle in `serverCores` (a set `signServerCores` wrote): signed, under
 *  the hardened runtime, it must come up and report the release version. Returns the platform key. */
export async function startSignedCore({
  serverCores,
  host = { platform: process.platform, arch: process.arch },
  reportedVersion = hostReportedVersion,
}) {
  if (!serverCores) throw new Error('the signed server cores are required');
  const manifest = JSON.parse(await readFile(join(serverCores, SERVER_MANIFEST_FILE), 'utf8'));
  const key = `${host.platform}-${host.arch}`;
  const entry = manifest.binaries?.[key];
  if (!entry?.bundle) throw new Error(`${serverCores} holds no ${key} bundle to start`);
  const dir = await mkdtemp(join(tmpdir(), 'signed-core-'));
  try {
    await execFileAsync('tar', ['-xzf', join(serverCores, entry.bundle.asset), '-C', dir, 'mixdogd']);
    const binary = join(dir, 'mixdogd');
    if (sha256(await readFile(binary)) !== entry.sha256)
      throw new Error(`${key}: the bundle's mixdogd does not match ${SERVER_MANIFEST_FILE}`);
    const reported = reportedVersion(binary);
    if (reported !== manifest.version)
      throw new Error(`${key}: the signed mixdogd reports version ${reported}, the release is ${manifest.version}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return key;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const path = (name) => (optionValue(name) ? resolve(optionValue(name)) : '');
  try {
    if (process.argv.includes('--start')) {
      const key = await startSignedCore({ serverCores: path('server-cores') });
      console.log(`[sign-server-cores] the signed ${key} core starts`);
    } else {
      const manifest = await signServerCores({
        source: path('server-cores'),
        out: path('out'),
        identity: optionValue('identity'),
        keychain: path('keychain'),
      });
      console.log(`[sign-server-cores] ${manifest.version} build ${manifest.build}: the macOS bundles are signed`);
    }
  } catch (error) {
    console.error(`[sign-server-cores] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
