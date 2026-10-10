// Deploy-time maintenance of the side-by-side renderer registry (see
// lib/renderer-releases.mjs). Runs against the STAGED install tree
// (`$NEXT_DIR`), never the live one, so a failure here is a failure before the
// swap and the release transaction's rollback guarantees apply unchanged.
//
//   node renderer-releases.mjs --action=prepare \
//     --releases=<NEXT>/renderer-releases   registry dir (pre-populated with hardlinks of the installed one)
//     --renderer=<NEXT>/renderer            the renderer this deploy installs
//     --desktop-version=1.2.3               desktop build the renderer belongs to ('' = relay-only deploy)
//     [--legacy=<installed>/renderer]       adopted as the `legacy` release when no registry exists yet
//     [--devices=<DATA_DIR>/devices.json]   devices whose reported version pins a release against GC
//
// Prints one JSON line: { releaseId, added, legacy, kept, dropped }.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DESKTOP_VERSION,
  LEGACY_RELEASE_ID,
  RELEASE_INDEX_FILE,
  SHELL_VERSION,
  parseReleaseIndex,
  planRetention,
  readReleaseIndex,
  withRelease,
} from '../lib/renderer-releases.mjs';

/** Hardlink a whole tree (copy across filesystems), so a retained release costs
 *  no extra disk and the installed tree it came from is never touched. */
export function linkTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) linkTree(from, to);
    else if (entry.isFile()) {
      try {
        linkSync(from, to);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        copyFileSync(from, to);
      }
    } else throw new Error(`Renderer tree contains an unsupported entry: ${from}`);
  }
}

/** The `mixdog-shell-version` a staged renderer's index.html declares. */
export function rendererShellVersion(rendererDir) {
  const document = readFileSync(join(rendererDir, 'index.html'), 'utf8');
  const version = /<meta name="mixdog-shell-version" content="([a-f0-9]{64})">/.exec(document)?.[1];
  if (!version) throw new Error('renderer release metadata missing');
  return version;
}

/** `<desktop version>-<first 12 hex of the shell version>`: unique per renderer
 *  build, yet readable and stable for a redeploy of the same build. */
export function releaseIdFor(desktopVersion, shellVersion) {
  return `${desktopVersion}-${shellVersion.slice(0, 12)}`;
}

/** Devices that reported a build, as retention input. */
export function readReportingDevices(devicesPath) {
  if (!devicesPath || !existsSync(devicesPath)) return [];
  const rows = JSON.parse(readFileSync(devicesPath, 'utf8'));
  return Object.values(rows ?? {})
    .filter((row) => row && typeof row.appVersion === 'string' && Number.isFinite(row.versionSeenAt))
    .map((row) => ({
      appVersion: row.appVersion,
      rendererRelease: typeof row.rendererRelease === 'string' ? row.rendererRelease : '',
      seenAt: row.versionSeenAt,
    }));
}

function writeIndexAtomic(releasesDir, index) {
  const path = join(releasesDir, RELEASE_INDEX_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

/** Register / adopt / collect inside `releasesDir`; see the header. */
export function prepareReleases({
  releasesDir,
  rendererDir,
  desktopVersion = '',
  legacyDir = '',
  devices = [],
  now = Date.now(),
}) {
  releasesDir = resolve(releasesDir);
  mkdirSync(releasesDir, { recursive: true });
  let index = readReleaseIndex(releasesDir) ?? parseReleaseIndex({ schemaVersion: 1, releases: [] });
  // First run on a relay that predates side-by-side releases: the renderer it
  // is serving right now becomes the fallback for every desktop that never
  // reports a version.
  if (!index.releases.length && legacyDir && existsSync(join(legacyDir, 'index.html'))) {
    linkTree(legacyDir, join(releasesDir, LEGACY_RELEASE_ID));
    index = withRelease(index, {
      id: LEGACY_RELEASE_ID,
      desktopVersion: '',
      shellVersion: rendererShellVersion(legacyDir),
      addedAt: now,
      legacy: true,
    });
  }
  let releaseId = '';
  let added = false;
  if (desktopVersion) {
    if (!DESKTOP_VERSION.test(desktopVersion)) throw new Error('desktop version is invalid');
    const shellVersion = rendererShellVersion(rendererDir);
    if (!SHELL_VERSION.test(shellVersion)) throw new Error('renderer shell version is invalid');
    releaseId = releaseIdFor(desktopVersion, shellVersion);
    const target = join(releasesDir, releaseId);
    if (!index.releases.some((entry) => entry.id === releaseId)) {
      rmSync(target, { recursive: true, force: true });
      linkTree(rendererDir, target);
      index = withRelease(index, { id: releaseId, desktopVersion, shellVersion, addedAt: now, legacy: false });
      added = true;
    }
  }
  const plan = planRetention(index, devices, { now });
  for (const id of plan.drop) rmSync(join(releasesDir, id), { recursive: true, force: true });
  index = parseReleaseIndex({ schemaVersion: 1, releases: index.releases.filter((entry) => plan.keep.includes(entry.id)) });
  // Anything on disk the registry does not name (an interrupted earlier run)
  // is not servable and not verifiable: collect it with the rest.
  for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !index.releases.some((release) => release.id === entry.name)) {
      rmSync(join(releasesDir, entry.name), { recursive: true, force: true });
    }
  }
  writeIndexAtomic(releasesDir, index);
  return {
    releaseId,
    added,
    legacy: index.releases.find((entry) => entry.legacy)?.id ?? '',
    kept: plan.keep,
    dropped: plan.drop,
  };
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const match = /^--([^=]+)=(.*)$/s.exec(arg);
      if (!match) throw new Error(`Invalid argument: ${arg}`);
      return [match[1], match[2]];
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.action !== 'prepare') throw new Error(`Unknown renderer-releases action: ${args.action || '(missing)'}`);
    const result = prepareReleases({
      releasesDir: args.releases,
      rendererDir: resolve(args.renderer),
      desktopVersion: args['desktop-version'] || '',
      legacyDir: args.legacy ? resolve(args.legacy) : '',
      devices: readReportingDevices(args.devices),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`[deploy] renderer releases failed: ${error.message}`);
    process.exitCode = 1;
  }
}
