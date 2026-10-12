#!/usr/bin/env node
// electron-builder writes one latest-mac.yml per macOS build, and each runner
// builds a single architecture, so each feed lists only its own zip and dmg.
// electron-updater on macOS always reads the single latest-mac.yml of the
// latest release and picks the zip whose name matches the machine's
// architecture, so the release needs one feed that lists both builds.
//
// The publish job runs without installing dependencies, so this reads the
// fixed shape electron-builder emits (top-level scalars plus a `files:` list
// of `- url:` items) directly and fails on anything else.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAC_ARCHES = Object.freeze(['arm64', 'x64']);
// Legacy top-level path/sha512 (read only by electron-updater 1.x) point at
// the x64 zip, which also runs on Apple silicon through Rosetta.
const PRIMARY_ARCH = 'x64';
const TOP_LEVEL_KEYS = ['version', 'path', 'sha512', 'releaseDate'];

function zipArch(url) {
  const match = /^mixdog-desktop-mac-([a-z0-9]+)\.zip$/.exec(url);
  return match ? match[1] : null;
}

/** Parse one electron-builder latest-mac.yml. File items keep their raw lines. */
export function parseMacFeed(text, label) {
  const top = {};
  const files = [];
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/.exec(line);
      if (!match) throw new Error(`${label}: unsupported line: ${line}`);
      inFiles = match[1] === 'files';
      if (!inFiles) top[match[1]] = line;
    } else if (inFiles && /^ {2}- url: \S+$/.test(line)) {
      files.push({ url: line.replace(/^ {2}- url:\s+/, ''), lines: [line] });
    } else if (inFiles && files.length > 0 && /^ {4}[A-Za-z][A-Za-z0-9]*: \S.*$/.test(line)) {
      files[files.length - 1].lines.push(line);
    } else {
      throw new Error(`${label}: unsupported line: ${line}`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!top[key]) throw new Error(`${label}: missing ${key}`);
  }
  const value = (key) => top[key].slice(key.length + 1).trim();
  return { version: value('version'), top, files };
}

/** Merge the per-architecture feeds into one feed listing both zips. */
export function mergeMacFeeds(inputs, expectedVersion) {
  const feeds = inputs.map(({ label, text }) => {
    const feed = parseMacFeed(text, label);
    if (expectedVersion && feed.version !== expectedVersion) {
      throw new Error(`${label}: version ${feed.version} is not ${expectedVersion}`);
    }
    const zips = feed.files.filter((file) => zipArch(file.url));
    if (zips.length !== 1) throw new Error(`${label}: expected exactly one mac zip, found ${zips.length}`);
    const [zip] = zips;
    for (const field of ['sha512', 'size']) {
      if (!zip.lines.some((line) => line.startsWith(`    ${field}: `))) {
        throw new Error(`${label}: ${zip.url} has no ${field}`);
      }
    }
    return { ...feed, arch: zipArch(zip.url) };
  });
  const arches = feeds.map((feed) => feed.arch).sort();
  if (JSON.stringify(arches) !== JSON.stringify(MAC_ARCHES)) {
    throw new Error(`Expected one feed per ${MAC_ARCHES.join(' + ')}, found: ${arches.join(', ')}`);
  }
  if (feeds[0].version !== feeds[1].version) {
    throw new Error(`Feed versions differ: ${feeds[0].version} and ${feeds[1].version}`);
  }
  feeds.sort((a, b) => MAC_ARCHES.indexOf(a.arch) - MAC_ARCHES.indexOf(b.arch));
  const entries = feeds.flatMap((feed) => feed.files);
  const urls = entries.map((file) => file.url);
  if (new Set(urls).size !== urls.length) throw new Error(`Duplicate feed files: ${urls.join(', ')}`);
  const primary = feeds.find((feed) => feed.arch === PRIMARY_ARCH);
  return [
    primary.top.version,
    'files:',
    ...entries.flatMap((file) => file.lines),
    primary.top.path,
    primary.top.sha512,
    primary.top.releaseDate,
    '',
  ].join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const out = option('out');
  const inputs = args.filter((arg) => !arg.startsWith('--'));
  if (!out || inputs.length === 0) {
    throw new Error('usage: merge-mac-update-feed.mjs --out=latest-mac.yml [--version=X.Y.Z] <feed.yml>...');
  }
  const merged = mergeMacFeeds(
    inputs.map((path) => ({ label: path, text: readFileSync(path, 'utf8') })),
    option('version')
  );
  writeFileSync(out, merged);
  console.log(`Wrote ${out} from ${inputs.length} feeds.`);
}
