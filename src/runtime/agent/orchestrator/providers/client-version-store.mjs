// Last live client version each provider saw, kept on disk under one key per
// client. A new or offline process starts from the newest version this machine
// has observed instead of a floor that only moves with a release. Skipped
// entirely when MIXDOG_DISABLE_LIVE_CLI_VERSIONS=1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const LAST_KNOWN_FILE_NAME = 'client-versions.json';
const LAST_KNOWN_SCHEMA_VERSION = 1;
const LAST_KNOWN_VALUE = /^[\w.+-]{1,64}$/;

const liveLookupDisabled = () => process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS === '1';
const lastKnownPath = () => join(resolvePluginData(), LAST_KNOWN_FILE_NAME);

/** The last live version remembered under `key`, or null. */
export function readLastKnownVersion(key) {
  if (!key || liveLookupDisabled()) return null;
  try {
    const raw = JSON.parse(readFileSync(lastKnownPath(), 'utf-8'));
    if (raw?.version !== LAST_KNOWN_SCHEMA_VERSION) return null;
    const value = raw.entries?.[key]?.value;
    return typeof value === 'string' && LAST_KNOWN_VALUE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remember a live version; `null` forgets it. Best-effort: never throws. */
export function rememberLastKnownVersion(key, value) {
  if (!key || liveLookupDisabled()) return;
  if (value != null && !LAST_KNOWN_VALUE.test(String(value))) return;
  try {
    updateJsonAtomicSync(
      lastKnownPath(),
      (current) => {
        const entries = current?.version === LAST_KNOWN_SCHEMA_VERSION ? { ...current.entries } : {};
        if ((entries[key]?.value ?? null) === value) return undefined;
        if (value == null) delete entries[key];
        else entries[key] = { value, fetchedAt: Date.now() };
        return { version: LAST_KNOWN_SCHEMA_VERSION, entries };
      },
      { lock: true }
    );
  } catch {
    /* a read-only data directory must not break the lookup */
  }
}
