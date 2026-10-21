// Context lifecycle settings: compaction budgets and the idle auto-clear.
import {
  refreshLiveSessionsProviderCacheOpts,
  refreshSessionProviderCacheOpts,
} from '../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs';
import { isAutoClearUnlimited } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { COMPACTION_SUMMARY_MODES } from '../runtime/agent/orchestrator/session/compact/summary-mode.mjs';

// Every spelling of the main-context buffer budget; a new representation
// replaces the previous one.
const MAIN_BUFFER_KEYS = [
  'mainBufferTokens',
  'mainBuffer',
  'mainBufferPercent',
  'mainBufferPct',
  'mainBufferRatio',
  'mainBufferFraction',
];
// Session-level compaction fields that the saved config owns from now on.
const SESSION_COMPACTION_KEYS = [
  'type',
  'compactType',
  'compact_type',
  'semantic',
  'semanticModel',
  'prune',
  'tailTurns',
  'recallMemoryTimeoutMs',
  'recallIngestLimit',
  'recallChunkLimit',
  'recallLimit',
  'recallCycle1BatchSize',
  'recallRowsPerSession',
  'recallWindowSize',
  'recallConcurrency',
  'recallCycle1DeadlineMs',
  // Replaced by summaryMode.
  'useMaintainer',
  ...MAIN_BUFFER_KEYS,
];

// Unlimited (never auto-clear) typed as a duration.
const UNLIMITED_DURATION = /^(?:unlimited|never)$/i;

/** Fold the recognised compaction input fields into `next` (mutated and returned). */
function applyCompactionInput(next, input, hasOwn) {
  if (hasOwn(input, 'auto')) next.auto = input.auto !== false;
  if (hasOwn(input, 'enabled')) next.auto = input.enabled !== false;
  if (hasOwn(input, 'onModelChange')) next.onModelChange = input.onModelChange !== false;
  if (hasOwn(input, 'summaryMode')) {
    if (!COMPACTION_SUMMARY_MODES.includes(input.summaryMode)) {
      throw new Error(`usage: summaryMode ${COMPACTION_SUMMARY_MODES.join(' | ')}`);
    }
    next.summaryMode = input.summaryMode;
  }
  // Legacy Compact type fields are intentionally ignored. There is one
  // fresh-context Compact contract for every session.
  // A new budget representation replaces the previous one. Otherwise a
  // saved token override silently outranks a later percentage edit.
  if (MAIN_BUFFER_KEYS.some((key) => hasOwn(input, key))) {
    for (const old of MAIN_BUFFER_KEYS) delete next[old];
  }
  for (const key of MAIN_BUFFER_KEYS) {
    if (hasOwn(input, key)) next[key] = input[key];
  }
  return next;
}

/** Replace the live session's compaction fields with the saved config's. */
function adoptSessionCompaction(session, saved) {
  if (!session) return;
  const currentSessionCompaction = { ...(session.compaction || {}) };
  for (const key of SESSION_COMPACTION_KEYS) delete currentSessionCompaction[key];
  session.compaction = { ...currentSessionCompaction, ...saved };
}

// Advanced picker shows only providers the user actually has enabled
// (config.providers[*].enabled), plus the active route provider, any
// provider with a custom override, and the 'default' fallback row —
// not the full built-in table.
function enabledProviderKeys(config, provider) {
  const enabledProviders = new Set(
    Object.entries(config?.providers || {})
      .filter(([, v]) => v && typeof v === 'object' && v.enabled !== false)
      .map(([k]) => String(k).toLowerCase())
  );
  if (provider) enabledProviders.add(String(provider).toLowerCase());
  return enabledProviders;
}

export function createCompactionSettings({
  getConfig,
  getRoute,
  getSession,
  saveConfigAndAdopt,
  hasOwn,
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  resolveAutoClearIdleMs,
  normalizeCompactionConfig,
  autoClearProviderDefaults,
  parseDurationMs,
  formatDurationMs,
  invalidateContextStatusCache,
}) {
  // The Lead messages-tail TTL derives from the auto-clear idle window.
  const refreshLeadCacheOpts = () => {
    const config = getConfig();
    refreshSessionProviderCacheOpts(getSession(), config);
    refreshLiveSessionsProviderCacheOpts(config);
  };

  /** Apply a per-provider idle override (or its reset) and return the resolved view. */
  const saveProviderIdle = (config, next, providerKey, input) => {
    const providerIdleMs = { ...(next.providerIdleMs || {}) };
    if (input.resetProvider === true || (hasOwn(input, 'idleMs') && input.idleMs == null)) {
      delete providerIdleMs[providerKey];
    } else {
      // Unlimited (never auto-clear) is stored as 0: `unlimited: true`, a
      // duration of 'unlimited'/'never', or idleMs 0.
      const unlimited =
        input.unlimited === true ||
        (hasOwn(input, 'duration') && UNLIMITED_DURATION.test(String(input.duration ?? '').trim())) ||
        (!hasOwn(input, 'duration') && hasOwn(input, 'idleMs') && input.idleMs === 0);
      if (unlimited) {
        providerIdleMs[providerKey] = 0;
      } else {
        const idleMs = hasOwn(input, 'duration') ? parseDurationMs(input.duration) : Number(input.idleMs);
        if (!idleMs || !Number.isFinite(idleMs) || idleMs <= 0) {
          throw new Error('usage: duration like 10m, 1h, 24h, or unlimited');
        }
        providerIdleMs[providerKey] = Math.max(60_000, Math.round(idleMs));
      }
    }
    saveConfigAndAdopt({ ...config, autoClear: { ...next, providerIdleMs } });
    refreshLeadCacheOpts();
  };

  return {
    getCompactionSettings() {
      const config = getConfig();
      return normalizeCompactionConfig(config.compaction);
    },
    setCompactionSettings(input = {}) {
      const config = getConfig();
      const current = normalizeCompactionConfig(config.compaction);
      const next = applyCompactionInput({ ...current }, input, hasOwn);
      saveConfigAndAdopt({ ...config, compaction: normalizeCompactionConfig(next) });
      const saved = normalizeCompactionConfig(getConfig().compaction);
      adoptSessionCompaction(getSession(), saved);
      invalidateContextStatusCache();
      return saved;
    },
    getAutoClear() {
      const config = getConfig();
      const route = getRoute();
      const normalized = normalizeAutoClearConfig(config.autoClear);
      const provider = route?.provider || null;
      const providerDefault = autoClearIdleMsForProvider(provider, normalized.providerIdleMs);
      const idleMs = resolveAutoClearIdleMs(config, provider);
      const key = String(provider || '').toLowerCase();
      const providerCustom = Boolean(key && key !== 'default' && normalized.providerIdleMs?.[key]);
      const enabledProviders = enabledProviderKeys(config, provider);
      // Every enabled provider gets its row, including ones without a
      // built-in window (they resolve through the 'default' row).
      const providerDefaults = autoClearProviderDefaults(normalized.providerIdleMs, [...enabledProviders]).filter(
        (entry) => entry.provider === 'default' || entry.custom === true || enabledProviders.has(entry.provider)
      );
      return {
        enabled: normalized.enabled,
        idleMs,
        unlimited: isAutoClearUnlimited(idleMs),
        label: isAutoClearUnlimited(idleMs) ? 'unlimited' : formatDurationMs(idleMs),
        custom: normalized.custom,
        providerCustom,
        providerDefault,
        provider,
        providerDefaults,
        minContextPercent: normalized.minContextPercent,
      };
    },
    setAutoClear(input = {}) {
      const config = getConfig();
      const current = normalizeAutoClearConfig(config.autoClear);
      const next = { ...current };
      if (hasOwn(input, 'enabled')) next.enabled = input.enabled !== false;
      if (hasOwn(input, 'minContextPercent')) {
        const rawMinPct = Number(input.minContextPercent);
        if (!Number.isFinite(rawMinPct))
          throw new Error('autoclear minContextPercent must be a number between 0 and 100');
        next.minContextPercent = Math.min(100, Math.max(0, Math.round(rawMinPct)));
      }
      // `/autoclear unlimited` names no provider: it means the current route's.
      const wantsUnlimited = hasOwn(input, 'duration') && UNLIMITED_DURATION.test(String(input.duration ?? '').trim());
      const providerKey = String(input.provider || (wantsUnlimited ? getRoute()?.provider : '') || '')
        .trim()
        .toLowerCase();
      const editsProviderDefault =
        providerKey &&
        (input.resetProvider === true ||
          input.unlimited === true ||
          hasOwn(input, 'duration') ||
          hasOwn(input, 'idleMs'));
      if (editsProviderDefault) {
        saveProviderIdle(config, next, providerKey, input);
      } else {
        if (input.reset === true || (hasOwn(input, 'idleMs') && input.idleMs == null)) {
          next.idleMs = null;
        } else if (hasOwn(input, 'idleMs')) {
          const idleMs = Number(input.idleMs);
          if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('autoclear idleMs must be a positive number');
          next.idleMs = Math.max(60_000, Math.round(idleMs));
        }
        if (hasOwn(input, 'duration')) {
          const idleMs = parseDurationMs(input.duration);
          if (!idleMs) throw new Error('usage: /autoclear [on|off|status|<minutes|1h|90m>|unlimited]');
          next.idleMs = idleMs;
          if (!hasOwn(input, 'enabled')) next.enabled = true;
        }
        saveConfigAndAdopt({ ...config, autoClear: next });
        refreshLeadCacheOpts();
      }
      return this.getAutoClear();
    },
  };
}
