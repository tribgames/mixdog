// Raises the shipped client-version floors to the versions published now.
//
// A floor is what a provider reports when its live version lookup fails, and
// the backends gate model access on that version, so a floor that only moves
// by hand hides new models from those users. The release workflow runs this
// before committing the version bump. A floor never moves down, and a failed
// lookup keeps the current floor with a warning instead of blocking a release.
//
// CLI: node scripts/sync-client-version-floors.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CLAUDE_CLI_NPM_PACKAGE } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth-client-version.mjs';
import { CODEX_CLI_NPM_PACKAGE } from '../src/runtime/agent/orchestrator/providers/codex-client-meta.mjs';
import {
  CURSOR_INSTALL_URL,
  cursorBuildNewer,
  parseCursorInstallBuild,
} from '../src/runtime/agent/orchestrator/providers/cursor-client-version.mjs';
import { GROK_CLI_NPM_PACKAGE } from '../src/runtime/agent/orchestrator/providers/grok-client-version.mjs';
import {
  compareSemver,
  fetchRemoteVersion,
  npmLatestUrl,
  parseNpmLatest,
} from '../src/runtime/agent/orchestrator/providers/npm-cli-version.mjs';

const LOOKUP_TIMEOUT_MS = 15_000;

export const semverNewer = (next, current) => compareSemver(next, current) > 0;

const providerFile = (name) => new URL(`../src/runtime/agent/orchestrator/providers/${name}`, import.meta.url);

export const FLOORS = [
  {
    file: providerFile('anthropic-oauth-client-version.mjs'),
    constant: 'DEFAULT_CLI_VERSION',
    url: npmLatestUrl(CLAUDE_CLI_NPM_PACKAGE),
    parse: parseNpmLatest,
    isNewer: semverNewer,
  },
  {
    file: providerFile('codex-client-meta.mjs'),
    constant: 'CODEX_CLIENT_VERSION_FLOOR',
    url: npmLatestUrl(CODEX_CLI_NPM_PACKAGE),
    parse: parseNpmLatest,
    isNewer: semverNewer,
  },
  {
    file: providerFile('grok-client-version.mjs'),
    constant: 'GROK_CLI_VERSION_FLOOR',
    url: npmLatestUrl(GROK_CLI_NPM_PACKAGE),
    parse: parseNpmLatest,
    isNewer: semverNewer,
  },
  {
    file: providerFile('cursor-client-version.mjs'),
    constant: 'CURSOR_CLIENT_VERSION_FLOOR',
    url: CURSOR_INSTALL_URL,
    parse: parseCursorInstallBuild,
    isNewer: cursorBuildNewer,
  },
];

const floorPattern = (constant) => new RegExp(`^((?:export )?const ${constant} = ')([^']*)(')`, 'm');

/** The source with `constant` raised to `latest` when `isNewer` says so. */
export function raiseFloor(source, constant, latest, isNewer) {
  const pattern = floorPattern(constant);
  const match = pattern.exec(source);
  if (!match) throw new Error(`${constant} declaration not found`);
  const current = match[2];
  if (!latest || !isNewer(latest, current)) return { source, current, next: current };
  return {
    source: source.replace(pattern, (_, head, _value, tail) => `${head}${latest}${tail}`),
    current,
    next: latest,
  };
}

export async function syncClientVersionFloors() {
  for (const floor of FLOORS) {
    const latest = await fetchRemoteVersion(floor.url, floor.parse, LOOKUP_TIMEOUT_MS);
    if (!latest) {
      console.warn(`::warning::${floor.constant}: no version from ${floor.url}; floor kept`);
      continue;
    }
    const result = raiseFloor(readFileSync(floor.file, 'utf8'), floor.constant, latest, floor.isNewer);
    if (result.next === result.current) {
      console.log(`${floor.constant} ${result.current} kept (published ${latest})`);
      continue;
    }
    writeFileSync(floor.file, result.source);
    console.log(`${floor.constant} ${result.current} -> ${result.next}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await syncClientVersionFloors();
}
