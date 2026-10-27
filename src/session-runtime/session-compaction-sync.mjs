// Keeps a live session's compaction settings on the saved global ones. One
// helper for every path that can leave a session behind the config: saving the
// settings, a shared-config reload, and adopting a resumed or swapped session.
import { normalizeCompactionConfig } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { COMPACTION_CONFIG_KEYS } from '../runtime/agent/orchestrator/runtime-core/compaction-config-keys.mjs';

/** A headless caller injects its own isolated config: its sessions keep the
 *  compaction they were created with instead of following the profile on disk. */
export function usesInjectedConfig(params) {
  return Boolean(params?.initialConfig) && typeof params.initialConfig === 'object';
}

/** Replace the live session's compaction fields with the saved (normalized) ones. */
export function adoptSessionCompaction(session, saved) {
  if (!session) return;
  const currentSessionCompaction = { ...(session.compaction || {}) };
  // Anything outside the config-owned set (per-session thresholds, archive
  // state, timing) is the session's own and survives.
  for (const key of COMPACTION_CONFIG_KEYS) delete currentSessionCompaction[key];
  session.compaction = { ...currentSessionCompaction, ...saved };
}

/** Follow `config.compaction` on a session; a config without the section leaves it alone. */
export function syncSessionCompaction(session, config) {
  if (!config?.compaction || typeof config.compaction !== 'object') return;
  adoptSessionCompaction(session, normalizeCompactionConfig(config.compaction));
}
