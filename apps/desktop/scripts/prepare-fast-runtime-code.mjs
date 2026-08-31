import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { copyRuntimePackagePayload } from './runtime-package-payload.mjs';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');
const runtimeDir = join(desktopDir, '.runtime');
const outputDir = join(runtimeDir, 'fast-runtime-code');
const markerName = '.mixdog-fast-runtime.json';

function optionValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

async function resolveRuntimePackageManifest() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('prepare-fast-runtime-code must be run from npm.');
  const { stdout } = await execFileAsync(process.execPath, [
    npmCli,
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
  ], {
    cwd: rootDir,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const [manifest] = JSON.parse(stdout);
  if (!manifest?.files?.length) throw new Error('npm pack returned no Mixdog runtime files.');
  return manifest;
}

export function fastRuntimeMarker({ dependencyHash, runtimeHash }) {
  if (!dependencyHash || !runtimeHash) {
    throw new Error('Fast runtime dependency and source hashes are required.');
  }
  return {
    schemaVersion: 1,
    dependencyHash,
    runtimeHash,
  };
}

export async function prepareFastRuntimeCode({
  manifest,
  dependencyHash,
  runtimeHash,
  sourceRoot = rootDir,
  destination = outputDir,
}) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  await copyRuntimePackagePayload({
    rootDir: sourceRoot,
    manifest,
    destination: join(temporary, 'node_modules', 'mixdog'),
  });
  await writeFile(
    join(temporary, markerName),
    `${JSON.stringify(fastRuntimeMarker({ dependencyHash, runtimeHash }), null, 2)}\n`,
  );
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const startedAt = performance.now();
  const manifest = await resolveRuntimePackageManifest();
  await mkdir(runtimeDir, { recursive: true });
  await prepareFastRuntimeCode({
    manifest,
    dependencyHash: optionValue('dependency-hash'),
    runtimeHash: optionValue('runtime-hash'),
  });
  const marker = JSON.parse(await readFile(join(outputDir, markerName), 'utf8'));
  console.log(
    `[fast-runtime] staged ${manifest.files.length} Mixdog files in `
    + `${Math.round(performance.now() - startedAt)}ms (${marker.runtimeHash.slice(0, 8)})`,
  );
}
