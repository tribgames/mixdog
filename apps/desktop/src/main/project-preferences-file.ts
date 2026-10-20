// Desktop-only project preferences (aliases, legacy hidden tombstones)
// on disk. This module owns the file shape and bounds; the service keeps the
// in-memory copy and decides when to persist.
import { join } from 'node:path';

import { readJsonState, writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import type { DesktopProjectPreferences } from './desktop-support';

const FILE_NAME = 'desktop-projects.json';
const MAX_PATH_ENTRIES = 50;
const MAX_ALIASES = 200;
const MAX_ALIAS_LENGTH = 120;

function preferencesObject(value: unknown): Partial<DesktopProjectPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Desktop project preferences are not an object.');
  }
  return value as Partial<DesktopProjectPreferences>;
}

/** Read and clamp the stored preferences; a missing file starts empty, and a
 *  damaged one (NUL-filled, truncated) is kept aside, the last good copy
 *  restored, so projects keep listing. Only an I/O error fails the load. */
export async function readProjectPreferences(root: string): Promise<DesktopProjectPreferences> {
  let parsed: Partial<DesktopProjectPreferences>;
  try {
    parsed = await readJsonState(join(root, FILE_NAME), { validate: preferencesObject, fallback: {} });
  } catch {
    throw new Error('Desktop project preferences could not be loaded.');
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)).slice(0, MAX_PATH_ENTRIES)
      : [];
  const aliases =
    parsed.aliases && typeof parsed.aliases === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.aliases)
            .filter(([path, alias]) => Boolean(path) && typeof alias === 'string' && alias.length <= MAX_ALIAS_LENGTH)
            .slice(0, MAX_ALIASES)
        )
      : {};
  return {
    version: 2,
    aliases,
    hidden: [...new Set(strings(parsed.hidden))],
  };
}

/** Publish the preferences owner-only and atomically, keeping the replaced
 *  version as the backup a damaged file is restored from. */
export async function writeProjectPreferences(root: string, preferences: DesktopProjectPreferences): Promise<void> {
  await writeJsonAtomicAsync(join(root, FILE_NAME), preferences, { backup: true });
}
