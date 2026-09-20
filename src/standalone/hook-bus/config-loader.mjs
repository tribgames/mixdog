/**
 * hook-bus/config-loader.mjs — the merged hooks configuration for a cwd:
 * every hooks file in scope (user data, project, plugins) parsed once per
 * file-stamp set, standard events merged, legacy rules collected, and the
 * parse errors both reported and recorded on the result.
 */
import { readFileSync } from 'node:fs';
import { applyHookRulePatches, hookFileStamp } from './rule-file.mjs';
import {
  hookConfigEntries,
  mergeEvents,
  normalizeRules,
  parseStandardConfig,
  standardConfigReport,
} from './config.mjs';

const EMPTY_CONFIG = Object.freeze({
  key: '',
  standard: false,
  disabled: false,
  events: {},
  legacyRules: [],
  sources: [],
  errors: [],
});

function cacheKeyFor(entries) {
  const parts = [];
  let cacheable = true;
  for (const entry of entries) {
    let stamp;
    try {
      stamp = hookFileStamp(entry.path);
    } catch {
      cacheable = false;
      stamp = 'error';
    }
    parts.push([entry.path, stamp, entry.sourceType, entry.pluginRoot, entry.pluginData, entry.untrusted === true]);
  }
  return { key: JSON.stringify(parts), cacheable };
}

export function createConfigLoader({ dataDir, rulesPath, emit, pendingPatches }) {
  let configCache = { ...EMPTY_CONFIG };

  function loadConfig(cwd) {
    const entries = hookConfigEntries(dataDir, cwd);
    const stamped = cacheKeyFor(entries);
    let { cacheable } = stamped;
    if (cacheable && configCache.key === stamped.key) return configCache;

    const events = {};
    const legacyRules = [];
    const sources = [];
    // Same files with their owner: plugin hooks belong to the plugin's toggle
    // (pluginHookConfigEntries already skips disabled plugins), so a status
    // consumer can group them under the plugin instead of listing them loose.
    const sourceEntries = [];
    const errors = [];
    let disabled = false;
    let disableSeen = false;
    for (const entry of entries) {
      const filePath = entry.path;
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        if (!(error instanceof SyntaxError)) cacheable = false;
        errors.push({ file: filePath, error: error?.message || String(error) });
        continue;
      }
      sources.push(filePath);
      sourceEntries.push({
        path: filePath,
        sourceType: entry.sourceType || 'data',
        pluginRoot: entry.pluginRoot || null,
      });
      if (Object.hasOwn(parsed || {}, 'disableAllHooks')) {
        disabled = parsed.disableAllHooks === true;
        disableSeen = true;
      }
      const report = standardConfigReport(parsed);
      if (report.standard) {
        // A malformed event no longer demotes the whole file to legacy (which
        // silently disabled every standard handler in it): keep the valid
        // events and report the broken ones.
        if (report.invalidEvents.length > 0) {
          errors.push({
            file: filePath,
            error: `ignored malformed hook event(s): ${report.invalidEvents.join(', ')}`,
          });
        }
        mergeEvents(events, parseStandardConfig(parsed, filePath, entry));
      } else {
        let fileRules = normalizeRules(parsed).filter((rule) => rule && typeof rule === 'object');
        if (filePath === rulesPath) {
          fileRules = applyHookRulePatches(fileRules, pendingPatches(), { strict: false });
        }
        if (fileRules.length === 0 && report.invalidEvents.length > 0) {
          errors.push({
            file: filePath,
            error: `no usable hooks: malformed event(s) under "hooks": ${report.invalidEvents.join(', ')}`,
          });
        }
        legacyRules.push(...fileRules);
      }
    }
    configCache = {
      key: cacheable ? stamped.key : '',
      standard: Object.keys(events).length > 0,
      disabled: disableSeen ? disabled : false,
      events,
      legacyRules,
      sources,
      sourceEntries,
      errors,
    };
    for (const err of errors) {
      emit('hook:error', { error: `failed to parse hooks file ${err.file}: ${err.error}` });
    }
    return configCache;
  }

  return {
    loadConfig,
    // A rule-file write makes the stamp key stale: force the next load.
    invalidate() {
      configCache.key = '';
    },
  };
}
