import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackageWithOptions, listPackage, statFile } from '@electron/asar';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');
const runtimeDir = join(desktopDir, '.runtime');
const stagingDir = join(runtimeDir, 'staging');
const runtimePackageDir = join(stagingDir, 'node_modules', 'mixdog');
const runtimeArchive = join(runtimeDir, 'runtime.asar');
const runtimeSidecar = `${runtimeArchive}.unpacked`;
const builderNativeModulesDir = join(runtimeDir, 'native-modules');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('prepare-runtime must be run from npm.');

function runNpm(args, options) {
  return execFileAsync(process.execPath, [npmCli, ...args], {
    windowsHide: true,
    ...options,
  });
}

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

for (const fileName of ['package.json', 'package-lock.json']) {
  await cp(join(rootDir, fileName), join(stagingDir, fileName));
}

await runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stagingDir });

// Local transformer inference contributes roughly 340 MiB of browser/WASM
// assets. It is an optional memory-embedding acceleration path (its caller
// already degrades when the package is unavailable), not part of the desktop
// project/chat/approval runtime.
await Promise.all([
  rm(join(stagingDir, 'node_modules', '@huggingface'), { recursive: true, force: true }),
  rm(join(stagingDir, 'node_modules', 'onnxruntime-web'), { recursive: true, force: true }),
  rm(join(stagingDir, 'node_modules', '@discordjs'), { recursive: true, force: true }),
  rm(join(stagingDir, 'node_modules', 'discord.js'), { recursive: true, force: true }),
  rm(join(stagingDir, 'node_modules', 'discord-api-types'), { recursive: true, force: true }),
]);

const { stdout } = await runNpm(
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: rootDir, maxBuffer: 16 * 1024 * 1024 },
);
const [manifest] = JSON.parse(stdout);
if (!manifest?.files?.length) throw new Error('npm pack returned no Mixdog runtime files.');

await mkdir(runtimePackageDir, { recursive: true });
for (const entry of manifest.files) {
  const relativePath = String(entry.path).replaceAll('/', sep);
  const source = resolve(rootDir, relativePath);
  if (source !== rootDir && !source.startsWith(`${rootDir}${sep}`)) {
    throw new Error(`Refusing to package a path outside the Mixdog root: ${entry.path}`);
  }
  const destination = join(runtimePackageDir, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

const runtimePackage = JSON.parse(await readFile(join(stagingDir, 'package.json'), 'utf8'));
runtimePackage.private = true;
runtimePackage.name = '@mixdog/desktop-runtime';
delete runtimePackage.scripts;
delete runtimePackage.devDependencies;
await writeFile(join(stagingDir, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);

// NSIS is very slow when it has to create the production dependency tree one
// file at a time. Electron reads ASARs directly, so install one archive and
// unpack only native addons that the OS loader must access as real files.
await createPackageWithOptions(stagingDir, runtimeArchive, {
  dot: true,
  // @electron/asar matches this against absolute Windows paths with
  // matchBase enabled. A basename glob is therefore portable; **/*.node is
  // not, because minimatch treats Windows separators differently.
  unpack: '*.{node,dll}',
});

const archiveEntries = new Set(
  listPackage(runtimeArchive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/')),
);
for (const required of [
  '/package.json',
  '/node_modules/mixdog/package.json',
  '/node_modules/mixdog/src/tui/engine.mjs',
]) {
  if (!archiveEntries.has(required)) {
    throw new Error(`Runtime archive is incomplete: missing ${required}`);
  }
}

const nativeBinaryEntries = [...archiveEntries].filter((entry) => /\.(?:node|dll)$/i.test(entry));
for (const entry of nativeBinaryEntries) {
  const archivePath = entry.replace(/^\/+/, '');
  const metadata = statFile(runtimeArchive, archivePath.replaceAll('/', sep));
  if (!metadata.unpacked) {
    throw new Error(`Native addon is not marked unpacked in runtime.asar: ${entry}`);
  }

  const pathParts = archivePath.split('/');
  const source = join(runtimeSidecar, ...pathParts);
  await access(source);

  // electron-builder filters paths containing a source node_modules
  // directory. Stage its contents under a neutral name, then map that neutral
  // root back to the exact runtime.asar.unpacked/node_modules destination.
  if (pathParts.shift() !== 'node_modules') {
    throw new Error(`Native addon is outside the supported runtime node_modules layout: ${entry}`);
  }
  const destination = join(builderNativeModulesDir, ...pathParts);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

await rm(stagingDir, { recursive: true, force: true });
console.log(
  `Prepared runtime.asar with ${archiveEntries.size} entries, including ` +
    `${manifest.files.length} Mixdog package files and ${nativeBinaryEntries.length} unpacked native binary file(s).`,
);
