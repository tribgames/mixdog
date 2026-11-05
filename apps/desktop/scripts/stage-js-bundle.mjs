#!/usr/bin/env node
// The JavaScript runtime a server install carries (skill launchers, the extension host):
//   payload/js-runtime.json                       what `mixdogd`'s js_runtime resolver reads
//   payload/js/node                               the pinned Node (scripts/node-pin.json), nothing else of its tree
//   payload/js/LICENSE-node                       Node's license, which travels with its binary
//   payload/js/pkg/node_modules/mixdog/           the package root: src/ and package.json (as the desktop's runtime.asar)
//   payload/js/pkg/node_modules/<dependencies>    the root lockfile's production tree for that platform
// The desktop ships the same package root and lockfile pins inside runtime.asar; only the interpreter
// differs (there: the app in node mode, here: this Node), which js-runtime.json says.
// Network and npm steps are injected so the layout is testable offline; the defaults are the release ones.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { deriveRemoteRoots, trimManifest } from './remote-js-roots.mjs';

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(desktopDir, '../..');

export const NODE_PIN_FILE = join(desktopDir, 'scripts', 'node-pin.json');
export const REMOTE_JS_MANIFEST = Object.freeze({
  program: 'js/node',
  packageRoot: 'js/pkg/node_modules/mixdog',
  electron: false,
});

/** `<os>-<arch>` of a server key. */
const splitKey = (key) => {
  const [platform, arch] = key.split('-');
  return { platform, arch };
};

const sha256File = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/** The pinned Node of `key`: downloads its release tarball (checked against the pinned sha256), keeps only
 *  `bin/node` and `LICENSE`. Cached under `cacheDir`. */
export async function fetchPinnedNode(key, cacheDir, { pin, fetchImpl = fetch } = {}) {
  const wanted = pin ?? JSON.parse(await readFile(NODE_PIN_FILE, 'utf8'));
  const sha256 = wanted.sha256[key];
  if (!sha256) throw new Error(`node-pin.json pins no Node for ${key}`);
  const name = `node-v${wanted.version}-${key}`;
  const dir = join(cacheDir, name);
  const node = join(dir, 'node');
  const license = join(dir, 'LICENSE');
  try {
    if ((await sha256File(node)) && (await sha256File(license))) return { node, license, version: wanted.version };
  } catch {
    // not cached
  }
  const archive = join(cacheDir, `${name}.tar.gz`);
  await mkdir(cacheDir, { recursive: true });
  const response = await fetchImpl(`https://nodejs.org/dist/v${wanted.version}/${name}.tar.gz`);
  if (!response.ok) throw new Error(`Node ${wanted.version} for ${key}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`Node ${wanted.version} for ${key} does not match its pin (got ${actual})`);
  await writeFile(archive, bytes);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', dir, '--strip-components=1', `${name}/bin/node`, `${name}/LICENSE`]);
  await cp(join(dir, 'bin', 'node'), node);
  await rm(join(dir, 'bin'), { recursive: true, force: true });
  return { node, license, version: wanted.version };
}

const npm = (args, cwd) =>
  execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });

/** The tree of the root lockfile that the remote entry points reach, for `key`, into `pkgDir/node_modules`.
 *  The dependencies are the roots `deriveRemoteRoots` finds in the package; a reached package that is
 *  not a dependency, not locked or not installed stops the stage. */
export async function installProductionModules(pkgDir, key, { packageRootDir = rootDir } = {}) {
  const { platform, arch } = splitKey(key);
  const { roots } = deriveRemoteRoots({ packageRootDir });
  const trimmed = trimManifest({
    manifest: JSON.parse(await readFile(join(packageRootDir, 'package.json'), 'utf8')),
    lock: JSON.parse(await readFile(join(packageRootDir, 'package-lock.json'), 'utf8')),
    roots: roots.keys(),
    target: { os: platform, cpu: arch, libc: platform === 'linux' ? 'glibc' : undefined },
  });
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(trimmed.manifest, null, 2)}\n`);
  await writeFile(join(pkgDir, 'package-lock.json'), `${JSON.stringify(trimmed.lock, null, 2)}\n`);
  await npm(
    [
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--os=${platform}`,
      `--cpu=${arch}`,
      ...(platform === 'linux' ? ['--libc=glibc'] : []),
    ],
    pkgDir
  );
  for (const name of roots.keys()) {
    if (!existsSync(join(pkgDir, 'node_modules', name, 'package.json'))) throw new Error(`${name} is reached from the remote entry points but was not installed`);
  }
  await rm(join(pkgDir, 'node_modules', '.bin'), { recursive: true, force: true });
  await rm(join(pkgDir, 'package-lock.json'), { force: true });
}

/** The files `npm pack` would publish (src/ and package.json, as the desktop's runtime package). */
export async function packedFiles() {
  const { stdout } = await npm(['pack', '--dry-run', '--json', '--ignore-scripts'], rootDir);
  return JSON.parse(stdout)[0].files.map((file) => file.path).filter((path) => path === 'package.json' || path.startsWith('src/'));
}

/** Builds `payloadDir` for the server `key`. */
export async function buildJsPayload({
  key,
  payloadDir,
  cacheDir,
  fetchNode = fetchPinnedNode,
  installModules = installProductionModules,
  listPackageFiles = packedFiles,
  packageRootDir = rootDir,
}) {
  await rm(payloadDir, { recursive: true, force: true });
  const js = join(payloadDir, 'js');
  const pkgDir = join(js, 'pkg');
  await mkdir(js, { recursive: true });
  const node = await fetchNode(key, cacheDir);
  await cp(node.node, join(js, 'node'));
  await chmod(join(js, 'node'), 0o755);
  await cp(node.license, join(js, 'LICENSE-node'));
  await installModules(pkgDir, key);
  const packageDir = join(pkgDir, 'node_modules', 'mixdog');
  for (const file of await listPackageFiles()) {
    await mkdir(dirname(join(packageDir, file)), { recursive: true });
    await cp(join(packageRootDir, file), join(packageDir, file));
  }
  await writeFile(join(payloadDir, 'js-runtime.json'), `${JSON.stringify(REMOTE_JS_MANIFEST, null, 2)}\n`);
  return { nodeVersion: node.version };
}

/** A digest of a tree's relative paths and file bytes: the same inputs give the same digest, which the
 *  archive's own (timestamped) sha256 does not. */
export async function treeDigest(dir) {
  const hash = createHash('sha256');
  const walk = async (relative) => {
    const entries = (await readdir(join(dir, relative), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else hash.update(`${path}\0${await sha256File(join(dir, path))}\n`);
    }
  };
  await walk('');
  return hash.digest('hex');
}

/** `bundle.tgz`: `mixdogd` and `payload/` — what the bootstrap unpacks on the server. `content` identifies
 *  what is inside (the binary and the payload tree), whatever the archive's timestamps. */
export async function createBundleArchive({ binary, payloadDir, out }) {
  const assembly = `${out}.assembly`;
  await rm(assembly, { recursive: true, force: true });
  await mkdir(assembly, { recursive: true });
  await cp(binary, join(assembly, 'mixdogd'));
  await cp(payloadDir, join(assembly, 'payload'), { recursive: true });
  try {
    await execFileAsync('tar', ['-czf', out, '-C', assembly, 'mixdogd', 'payload'], { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await rm(assembly, { recursive: true, force: true });
  }
  const bytes = await readFile(out);
  const content = createHash('sha256')
    .update(`${await sha256File(binary)}\n${await treeDigest(payloadDir)}`)
    .digest('hex');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, content };
}
