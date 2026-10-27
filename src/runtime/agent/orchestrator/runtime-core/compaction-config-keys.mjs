// The fields of `session.compaction` that the saved global config owns, as
// opposed to the per-session state (archive, thresholds, outcome telemetry)
// the session owns. Shared by the config sync and by the compaction commit, so
// a commit that finishes after a reload never writes back a stale config value.
import { RETIRED_COMPACTION_FIELDS } from '../config-storage.mjs';
import { normalizeCompactionConfig } from './config-helpers.mjs';

// Every spelling of the main-context buffer budget; a new representation
// replaces the previous one.
export const MAIN_BUFFER_KEYS = [
  'mainBufferTokens',
  'mainBuffer',
  'mainBufferPercent',
  'mainBufferPct',
  'mainBufferRatio',
  'mainBufferFraction',
];

// Everything the normalizer emits for an empty config, the retired aliases it
// folds away, and every setting a session record is seeded from the config
// (session-record.mjs initialCompactionConfig). A field the config no longer
// sets is cleared so the session falls back to the default.
export const COMPACTION_CONFIG_KEYS = Object.freeze([
  ...Object.keys(normalizeCompactionConfig({})),
  ...RETIRED_COMPACTION_FIELDS,
  'enabled',
  'useMaintainer',
  'model',
  'summaryModel',
  'timeoutMs',
  'memoryTimeoutMs',
  'buffer',
  'bufferTokens',
  'reservedTokens',
  'bufferPercent',
  'bufferPct',
  'bufferRatio',
  'bufferFraction',
  ...MAIN_BUFFER_KEYS,
]);

// The resolved buffer is the plan's own measurement, recorded on every compact
// pass, so for the writers below it is telemetry and not a setting.
const RESOLVED_BUFFER_KEYS = new Set(['bufferTokens', 'bufferRatio']);

/**
 * The `session.compaction` record a compaction writer produces: the live record
 * plus its own outcome telemetry. Config-owned fields always come from the
 * live record, never from the policy or the plan the writer started with: a
 * reload that landed while the compaction was running (auto turned off, a
 * model removed) must not be undone by the write that follows it.
 */
export function withLiveCompactionConfig(live, telemetry) {
  const record = { ...live, auto: live.auto !== false, ...telemetry };
  for (const key of COMPACTION_CONFIG_KEYS) {
    if (key === 'auto' || RESOLVED_BUFFER_KEYS.has(key)) continue;
    if (Object.hasOwn(live, key)) record[key] = live[key];
    else delete record[key];
  }
  record.auto = live.auto !== false;
  return record;
}
