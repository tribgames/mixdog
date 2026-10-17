// The server payload: the EXACT runtime this desktop runs (its bundled
// mixdog `src/` and package.json), the desktop service bundle, and the npm
// lockfile scripts/build-daemon.mjs generated for the server's modules.
// Every file is hashed; the manifest digest is the build hash that names the
// immutable version directory on the server.
import { existsSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { packagedRuntimeSourceRoot } from '../runtime-layout';
import { RemoteBootstrapError } from './remote-install-errors';
import { encodePayloadArchive, manifestBuildHash, sha256Hex, type PayloadFile } from './remote-install-manifest';

export const REMOTE_BUNDLE_PATH = 'apps/desktop/out/main/daemon.cjs';
/** out/server/deps file → its name under the payload's server-deps/. The
 *  lockfile is not built as `package-lock.json`: electron-builder drops that
 *  name from the packaged app by default (scripts/remote-server-deps.mjs). */
export const SERVER_DEPS_FILES = [
  { local: 'package.json', remote: 'package.json' },
  { local: 'server-package-lock.json', remote: 'package-lock.json' },
] as const;

export interface RemoteServerPayload {
  /** The runtime's package version. */
  version: string;
  buildHash: string;
  /** `<version>-<buildHash>`: the version directory name. */
  installId: string;
  files: readonly PayloadFile[];
  /** The gzip wire archive (built on demand: only an install uploads it). */
  archive(): Promise<Buffer>;
}

export interface LocalPayloadLayout {
  /** Directory holding the runtime's package.json and src/. */
  runtimePackageDir: string;
  /** Directory holding the generated server package.json / server-package-lock.json. */
  serverDepsDir: string;
}

/** Where this desktop's runtime and generated server lockfile live: inside
 *  the packaged app (resources/…) or the source checkout. */
export function localPayloadLayout(
  moduleDir: string,
  exists: (path: string) => boolean = existsSync
): LocalPayloadLayout {
  const asar = moduleDir.indexOf(`${sep}app.asar`);
  if (asar >= 0) {
    const resourcesPath = moduleDir.slice(0, asar);
    return {
      runtimePackageDir: dirname(packagedRuntimeSourceRoot(resourcesPath, exists)),
      serverDepsDir: join(resourcesPath, 'app.asar', 'out', 'server', 'deps'),
    };
  }
  for (let dir = moduleDir; ; dir = dirname(dir)) {
    if (exists(join(dir, 'src', 'standalone', 'daemon.mjs'))) {
      // The checkout's apps/desktop, or an isolated dev instance's app/desktop
      // (scripts/dev-isolated.mjs), whose out/ holds its own server deps.
      for (const app of [join('apps', 'desktop'), join('app', 'desktop')]) {
        if (exists(join(dir, app, 'package.json'))) {
          return { runtimePackageDir: dir, serverDepsDir: join(dir, app, 'out', 'server', 'deps') };
        }
      }
    }
    if (dirname(dir) === dir) {
      throw new RemoteBootstrapError(
        'install-failed',
        `The Mixdog runtime to install on the server was not found above ${moduleDir}.`
      );
    }
  }
}

/** Shipped runtime files: what `npm pack` keeps of src/ (no tests, no TUI dev tree). */
function isRuntimeFile(relative: string): boolean {
  return (
    !/\.test\.(?:mjs|cjs|js|jsx|ts)$/.test(relative) &&
    !relative.startsWith('src/tui/dev/') &&
    !relative.endsWith('.DS_Store')
  );
}

function listTree(root: string, prefix: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listTree(join(root, entry.name), relative));
    else if (entry.isFile() && isRuntimeFile(relative)) files.push(relative);
  }
  return files;
}

interface PayloadSource {
  path: string;
  /** Local file, or the bytes themselves. */
  source: string | Buffer;
}

async function readSource(source: string | Buffer): Promise<Buffer> {
  return typeof source === 'string' ? readFile(source) : source;
}

// Local file → digest, revalidated by size and mtime: a packaged runtime is
// hashed once per process, a source checkout again only where it changed.
const fileDigests = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

async function hashSources(sources: readonly PayloadSource[]): Promise<PayloadFile[]> {
  const files: PayloadFile[] = [];
  for (const entry of sources) {
    if (typeof entry.source === 'string') {
      const stats = await stat(entry.source);
      const known = fileDigests.get(entry.source);
      if (known && known.size === stats.size && known.mtimeMs === stats.mtimeMs) {
        files.push({ path: entry.path, size: known.size, sha256: known.sha256 });
        continue;
      }
      const data = await readFile(entry.source);
      const digest = { size: data.length, mtimeMs: stats.mtimeMs, sha256: sha256Hex(data) };
      fileDigests.set(entry.source, digest);
      files.push({ path: entry.path, size: digest.size, sha256: digest.sha256 });
      continue;
    }
    files.push({ path: entry.path, size: entry.source.length, sha256: sha256Hex(entry.source) });
  }
  return files;
}

/** Hash the sources and name the build. */
export async function createServerPayload(
  sources: readonly PayloadSource[],
  version: string
): Promise<RemoteServerPayload> {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) {
    throw new RemoteBootstrapError('install-failed', `The runtime version is not a safe path segment: ${version}`);
  }
  const ordered = [...sources].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = await hashSources(ordered);
  const bySource = new Map(ordered.map((entry) => [entry.path, entry.source]));
  const buildHash = manifestBuildHash(files);
  let archive: Promise<Buffer> | null = null;
  return {
    version,
    buildHash,
    installId: `${version}-${buildHash}`,
    files,
    archive() {
      archive ??= encodePayloadArchive(files, (path) => {
        const source = bySource.get(path);
        if (source === undefined)
          throw new RemoteBootstrapError('install-failed', `No source for payload file ${path}`);
        return readSource(source);
      });
      return archive;
    },
  };
}

export function runtimeSources(layout: LocalPayloadLayout): PayloadSource[] {
  const deps = SERVER_DEPS_FILES.map(({ local }) => join(layout.serverDepsDir, local));
  if (!deps.every((path) => existsSync(path))) {
    throw new RemoteBootstrapError(
      'install-failed',
      `The server module lockfile is missing (${layout.serverDepsDir}); build the desktop (scripts/build-daemon.mjs) first.`
    );
  }
  return [
    { path: 'package.json', source: join(layout.runtimePackageDir, 'package.json') },
    ...SERVER_DEPS_FILES.map(({ local, remote }) => ({
      path: `server-deps/${remote}`,
      source: join(layout.serverDepsDir, local),
    })),
    ...listTree(join(layout.runtimePackageDir, 'src'), 'src').map((path) => ({
      path,
      source: join(layout.runtimePackageDir, ...path.split('/')),
    })),
  ];
}

export type ServerPayloadResolver = (bundle: Buffer) => Promise<RemoteServerPayload>;

/** This desktop's payload: its runtime plus the given desktop service bundle. */
export const resolveLocalServerPayload: ServerPayloadResolver = async (bundle) => {
  const layout = localPayloadLayout(import.meta.dirname);
  const sources = runtimeSources(layout);
  const manifest = JSON.parse(await readFile(join(layout.runtimePackageDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return createServerPayload(
    [...sources, { path: REMOTE_BUNDLE_PATH, source: bundle }],
    String(manifest.version || '')
  );
};

let payloadResolver: ServerPayloadResolver = resolveLocalServerPayload;

/** Tests swap in a fixture payload; null restores the local one. */
export function setServerPayloadResolver(resolver: ServerPayloadResolver | null): void {
  payloadResolver = resolver ?? resolveLocalServerPayload;
}

export function resolveServerPayload(bundle: Buffer): Promise<RemoteServerPayload> {
  return payloadResolver(bundle);
}
