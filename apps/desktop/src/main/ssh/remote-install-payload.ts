// The server payload: the `mixdogd` binary built for the server's platform
// with its JS runtime, in one `bundle.tgz`. A desktop ships one bundle per
// supported server platform next to a manifest (`servers.json`, written by
// scripts/stage-core.mjs); the manifest's `build`
// is one value for the whole release, so the version directory name
// `<version>-<build>` is known before the server's platform is.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { RemoteBootstrapError } from './remote-install-errors';
import type { RemotePlatform } from './remote-install-platform';
import { manifestBuild, SERVER_MANIFEST_FILE } from './server-manifest.mjs';

export { manifestBuild, SERVER_MANIFEST_FILE };
const SAFE_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export interface ServerBinaryEntry {
  /** sha256 and size of the `mixdogd` binary. */
  sha256: string;
  size: number;
  /** `bundle.tgz`: that binary and the JS runtime (node, package root, js-runtime.json) it runs with. */
  bundle: { file: string; sha256: string; size: number; content: string };
}

/** `servers.json`: the release version, its build and one entry per `<os>-<arch>`. */
export interface ServerManifest {
  version: string;
  build: string;
  binaries: Record<string, ServerBinaryEntry>;
}

export interface ServerIdentity {
  version: string;
  build: string;
  /** `<version>-<build>`: the version directory name on the server. */
  installId: string;
}

export interface ServerBinary {
  /** sha256 of the `mixdogd` binary inside the bundle; the server checks it again when it installs. */
  sha256: string;
  /** sha256 of the wire form, which the bootstrap checks before it unpacks anything. */
  bundleSha256: string;
  /** The wire form (a gzip tar of `mixdogd` and `payload/`), read on demand: only an install uploads it. */
  archive(): Promise<Buffer>;
}

export interface ServerPayloads {
  identity: ServerIdentity;
  binary(platform: RemotePlatform): Promise<ServerBinary>;
}

const platformKey = (platform: RemotePlatform): string => `${platform.os}-${platform.arch}`;

function validManifest(value: unknown): ServerManifest {
  const manifest = value as Partial<ServerManifest> | null;
  const binaries = manifest?.binaries;
  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    !SAFE_SEGMENT.test(manifest.version) ||
    typeof manifest.build !== 'string' ||
    !SAFE_SEGMENT.test(manifest.build) ||
    !binaries ||
    typeof binaries !== 'object'
  ) {
    throw new RemoteBootstrapError('local-payload', 'The server runtime manifest is malformed.');
  }
  if (manifestBuild(binaries) !== manifest.build) {
    throw new RemoteBootstrapError('local-payload', 'The server runtime manifest does not match its binaries.');
  }
  return manifest as ServerManifest;
}

/** The payloads of the release staged in `dir`. */
export async function loadServerPayloads(dir: string): Promise<ServerPayloads> {
  const manifest = validManifest(JSON.parse(await readFile(join(dir, SERVER_MANIFEST_FILE), 'utf8')));
  const archives = new Map<string, Promise<Buffer>>();
  return {
    identity: {
      version: manifest.version,
      build: manifest.build,
      installId: `${manifest.version}-${manifest.build}`,
    },
    async binary(platform) {
      const key = platformKey(platform);
      const entry = manifest.binaries[key];
      if (!entry) {
        throw new RemoteBootstrapError('local-payload', `This desktop ships no Mixdog server runtime for ${key}.`);
      }
      if (!SAFE_SEGMENT.test(entry.bundle?.file ?? '') || !entry.bundle?.sha256) {
        throw new RemoteBootstrapError('local-payload', `The server runtime manifest has no bundle for ${key}.`);
      }
      const file = join(dir, key, entry.bundle.file);
      const expected = entry.bundle.sha256;
      return {
        sha256: entry.sha256,
        bundleSha256: expected,
        archive() {
          let archive = archives.get(key);
          if (!archive) {
            archive = (async () => {
              const data = await readFile(file);
              if (createHash('sha256').update(data).digest('hex') !== expected) {
                throw new RemoteBootstrapError('local-payload', `${file} does not match the server runtime manifest.`);
              }
              return data;
            })();
            archives.set(key, archive);
          }
          return archive;
        },
      };
    },
  };
}

/** Where the staged server runtimes live: `resources/server-cores` of the
 *  packaged app, `apps/desktop/.runtime/server-cores` of a source checkout. */
export function localServerCoresDir(moduleDir: string, exists: (path: string) => boolean = existsSync): string {
  const asar = moduleDir.indexOf(`${sep}app.asar`);
  if (asar >= 0) return join(moduleDir.slice(0, asar), 'server-cores');
  for (let dir = moduleDir; ; dir = dirname(dir)) {
    const staged = join(dir, 'apps', 'desktop', '.runtime', 'server-cores');
    if (exists(join(staged, SERVER_MANIFEST_FILE))) return staged;
    if (dirname(dir) === dir) {
      throw new RemoteBootstrapError(
        'local-payload',
        `The Mixdog server runtimes to install were not found above ${moduleDir}; stage them (scripts/stage-core.mjs) first.`
      );
    }
  }
}

export type ServerPayloadResolver = () => Promise<ServerPayloads>;

const resolveLocalServerPayloads: ServerPayloadResolver = () =>
  loadServerPayloads(localServerCoresDir(import.meta.dirname));

let payloadResolver: ServerPayloadResolver = resolveLocalServerPayloads;

/** Tests swap in a fixture payload; null restores the local one. */
export function setServerPayloadResolver(resolver: ServerPayloadResolver | null): void {
  payloadResolver = resolver ?? resolveLocalServerPayloads;
}

export function resolveServerPayloads(): Promise<ServerPayloads> {
  return payloadResolver();
}
