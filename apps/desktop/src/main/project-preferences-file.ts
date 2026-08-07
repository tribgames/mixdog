// Desktop-only project preferences (aliases, legacy hidden tombstones)
// on disk. This module owns the file shape and bounds; the service keeps the
// in-memory copy and decides when to persist.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DesktopProjectPreferences } from './desktop-support';

const FILE_NAME = 'desktop-projects.json';
const MAX_PATH_ENTRIES = 50;
const MAX_ALIASES = 200;
const MAX_ALIAS_LENGTH = 120;

/** Read and clamp the stored preferences; a missing file starts empty. */
export async function readProjectPreferences(root: string): Promise<DesktopProjectPreferences> {
  let parsed: Partial<DesktopProjectPreferences> = {};
  try {
    parsed = JSON.parse(await readFile(join(root, FILE_NAME), 'utf8')) as Partial<DesktopProjectPreferences>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Desktop project preferences could not be loaded.');
    }
  }
  const strings = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)).slice(0, MAX_PATH_ENTRIES)
    : []);
  const aliases = parsed.aliases && typeof parsed.aliases === 'object'
    ? Object.fromEntries(Object.entries(parsed.aliases).filter(([path, alias]) =>
      Boolean(path) && typeof alias === 'string' && alias.length <= MAX_ALIAS_LENGTH).slice(0, MAX_ALIASES))
    : {};
  return {
    version: 2,
    aliases,
    hidden: [...new Set(strings(parsed.hidden))],
  };
}

/** Publish the preferences owner-only. */
export async function writeProjectPreferences(
  root: string,
  preferences: DesktopProjectPreferences,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, FILE_NAME),
    `${JSON.stringify(preferences, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
