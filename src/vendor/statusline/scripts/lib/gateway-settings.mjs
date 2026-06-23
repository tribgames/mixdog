// Shared Claude Code settings.json env writer — the SINGLE source of truth for
// reading/mutating ~/.claude/settings.json gateway env entries, used by
// BOTH scripts/gateway-model.mjs (--enable / --disable) AND scripts/uninstall.mjs
// (restoreGateway). One helper guarantees enable, disable, and uninstall never
// diverge on path resolution or write mechanics.
//
// Node-only (node:fs / node:os / node:path) — no plugin deps — so uninstall.mjs
// keeps its zero-dependency restore contract.
//
// Reuses the exact safe read-merge-write injectStatusLine() uses in
// hooks/session-start.cjs:485-532: read settings.json -> JSON.parse -> mutate
// the object -> write a .mixdog-tmp sibling -> atomic rename. Touches ONLY
// gateway routing env and the paired auto-compact window restore marker.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Location: CLAUDE_CONFIG_DIR || ~/.claude (the doctor.mjs claudeConfigBase
// pattern). SSOT so enable / disable / uninstall all target the same file even
// when CLAUDE_CONFIG_DIR is set.
export function resolveSettingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'settings.json');
}

export function resolveGlobalClaudeConfigPath() {
  return join(homedir(), '.claude.json');
}

const GATEWAY_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
]);
const AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const PREVIOUS_AUTO_COMPACT_WINDOW_ENV = 'MIXDOG_PREVIOUS_CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const PREVIOUS_ABSENT = '__mixdog_absent__';
export const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com';

function normalizeAutoCompactWindow(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null;
}

// Set (string url) or remove (url === null) gateway-owned settings.env entries.
// Returns { ok, changed?, path, error?, missing?, dryRun? }. `dryRun` previews
// without writing. A no-op (already matching / already absent) → ok:true,
// changed:false. Missing settings.json on remove → ok:true (treated clean);
// on add → ok:false (cannot create the file from scratch here).
export function setAnthropicBaseUrl(url, { dryRun = false, autoCompactWindow = null, preserveBaseUrl = false } = {}) {
  const p = resolveSettingsPath();
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return url === null
        ? { ok: true, changed: false, path: p, missing: true }
        : { ok: false, error: `cannot read ${p}: ${e.message}`, path: p };
    }
    return { ok: false, error: `cannot read ${p}: ${e.message}`, path: p };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `cannot parse ${p}: ${e.message}`, path: p };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { ok: false, error: `${p} is not a JSON object`, path: p };
  }
  const envIsObj = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env);
  const compactWindow = normalizeAutoCompactWindow(autoCompactWindow);
  let changed = false;
  if (url === null) {
    // REMOVE: only our keys; leave the rest of env untouched. No-op if absent.
    if (!envIsObj) {
      if (!compactWindow) return { ok: true, changed: false, path: p };
      settings.env = {};
    }
    if (!compactWindow && !GATEWAY_ENV_KEYS.some((key) => key in settings.env) && !(PREVIOUS_AUTO_COMPACT_WINDOW_ENV in settings.env)) {
      return { ok: true, changed: false, path: p };
    }
    if (!preserveBaseUrl && 'ANTHROPIC_BASE_URL' in settings.env) {
      changed = true;
      if (!dryRun) delete settings.env.ANTHROPIC_BASE_URL;
    }
    if (compactWindow) {
      if (!(PREVIOUS_AUTO_COMPACT_WINDOW_ENV in settings.env)) {
        changed = true;
        if (!dryRun) {
          settings.env[PREVIOUS_AUTO_COMPACT_WINDOW_ENV] = AUTO_COMPACT_WINDOW_ENV in settings.env
            ? String(settings.env[AUTO_COMPACT_WINDOW_ENV])
            : PREVIOUS_ABSENT;
        }
      }
      if (settings.env[AUTO_COMPACT_WINDOW_ENV] !== compactWindow) {
        changed = true;
        if (!dryRun) settings.env[AUTO_COMPACT_WINDOW_ENV] = compactWindow;
      }
    } else if (PREVIOUS_AUTO_COMPACT_WINDOW_ENV in settings.env) {
      changed = true;
      if (!dryRun) {
        const prev = settings.env[PREVIOUS_AUTO_COMPACT_WINDOW_ENV];
        if (prev === PREVIOUS_ABSENT) delete settings.env[AUTO_COMPACT_WINDOW_ENV];
        else settings.env[AUTO_COMPACT_WINDOW_ENV] = prev;
        delete settings.env[PREVIOUS_AUTO_COMPACT_WINDOW_ENV];
      }
    }
  } else {
    if (!envIsObj) settings.env = {};
    if (settings.env.ANTHROPIC_BASE_URL !== url) {
      changed = true;
      if (!dryRun) settings.env.ANTHROPIC_BASE_URL = url;
    }
    if (compactWindow) {
      if (!(PREVIOUS_AUTO_COMPACT_WINDOW_ENV in settings.env)) {
        changed = true;
        if (!dryRun) {
          settings.env[PREVIOUS_AUTO_COMPACT_WINDOW_ENV] = AUTO_COMPACT_WINDOW_ENV in settings.env
            ? String(settings.env[AUTO_COMPACT_WINDOW_ENV])
            : PREVIOUS_ABSENT;
        }
      }
      if (settings.env[AUTO_COMPACT_WINDOW_ENV] !== compactWindow) {
        changed = true;
        if (!dryRun) settings.env[AUTO_COMPACT_WINDOW_ENV] = compactWindow;
      }
    }
  }
  if (!changed) return { ok: true, changed: false, path: p };
  if (dryRun) return { ok: true, changed: true, path: p, dryRun: true };
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.mixdog-tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `cannot write ${p}: ${e.message}`, path: p };
  }
  return { ok: true, changed: true, path: p };
}

// RUNTIME base-url sync for live /model changes.
//
// Claude Code re-applies settings.env into process.env while the session is
// alive, but deleting ANTHROPIC_BASE_URL does not unset the already-present
// process env key. For native Claude choices, write the official Anthropic base
// URL instead. For mixdog choices, write the local gateway URL. This helper is
// deliberately narrower than setAnthropicBaseUrl(): it never creates restore
// markers and, by default, only acts when ANTHROPIC_BASE_URL already exists so
// it cannot enable the gateway for a user who disabled it.
export function syncAnthropicBaseUrl(url, { dryRun = false, requireExisting = true } = {}) {
  const target = typeof url === 'string' && url.trim() ? url.trim() : '';
  const p = resolveSettingsPath();
  if (!target) return { ok: true, changed: false, path: p, skipped: 'missing-url' };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read ${p}: ${e.message}`, path: p };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `cannot parse ${p}: ${e.message}`, path: p };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { ok: false, error: `${p} is not a JSON object`, path: p };
  }
  const envIsObj = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env);
  if (!envIsObj) {
    if (requireExisting) return { ok: true, changed: false, path: p, skipped: 'gateway-inactive' };
    settings.env = {};
  }
  if (requireExisting && !('ANTHROPIC_BASE_URL' in settings.env)) {
    return { ok: true, changed: false, path: p, skipped: 'gateway-inactive' };
  }
  if (settings.env.ANTHROPIC_BASE_URL === target) {
    return { ok: true, changed: false, path: p };
  }
  if (dryRun) return { ok: true, changed: true, path: p, dryRun: true };
  settings.env.ANTHROPIC_BASE_URL = target;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.mixdog-tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `cannot write ${p}: ${e.message}`, path: p };
  }
  return { ok: true, changed: true, path: p };
}

// RUNTIME compact-window sync (Stage 4) — used by the gateway request path when
// the routed model's context window changes at runtime (/model switch). Claude
// Code watches settings.json (chokidar) and re-applies env to process.env
// without restart, and getEffectiveContextWindowSize reads process.env live, so
// rewriting CLAUDE_CODE_AUTO_COMPACT_WINDOW here makes the auto-compact
// threshold track the live model next turn.
//
// Deliberately NARROW vs setAnthropicBaseUrl():
//   - NEVER touches ANTHROPIC_BASE_URL.
//   - NEVER touches the MIXDOG_PREVIOUS_* restore marker (that is enable/disable
//     only — runtime sync must not interfere with the restore contract).
//   - NEVER creates settings.json (missing/unparseable → ok:false).
//   - ONLY acts when ANTHROPIC_BASE_URL is already present (gateway active);
//     otherwise skipped without a write.
// Returns { ok, changed, path, error?, skipped? }.
export function syncAutoCompactWindow(window, { dryRun = false } = {}) {
  const p = resolveSettingsPath();
  const compactWindow = normalizeAutoCompactWindow(window);
  if (!compactWindow) return { ok: true, changed: false, path: p };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read ${p}: ${e.message}`, path: p };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `cannot parse ${p}: ${e.message}`, path: p };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { ok: false, error: `${p} is not a JSON object`, path: p };
  }
  const envIsObj = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env);
  // Gateway must already be pointed at this file (active). Never write otherwise.
  if (!envIsObj || !('ANTHROPIC_BASE_URL' in settings.env)) {
    return { ok: true, changed: false, path: p, skipped: 'gateway-inactive' };
  }
  if (String(settings.env[AUTO_COMPACT_WINDOW_ENV]) === compactWindow) {
    return { ok: true, changed: false, path: p };
  }
  if (dryRun) return { ok: true, changed: true, path: p, dryRun: true };
  settings.env[AUTO_COMPACT_WINDOW_ENV] = compactWindow;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.mixdog-tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `cannot write ${p}: ${e.message}`, path: p };
  }
  return { ok: true, changed: true, path: p };
}

export function syncAdditionalModelOptions(options, { dryRun = false, configPath = null } = {}) {
  const p = configPath || resolveGlobalClaudeConfigPath();
  const nextOptions = Array.isArray(options)
    ? options
      .filter(opt => opt && typeof opt.value === 'string' && typeof opt.label === 'string' && typeof opt.description === 'string')
      .map(opt => ({ value: opt.value, label: opt.label, description: opt.description }))
    : [];
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, changed: false, error: `cannot read ${p}: ${e.message}`, path: p };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    return { ok: false, changed: false, error: `cannot parse ${p}: ${e.message}`, path: p };
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, changed: false, error: `${p} is not a JSON object`, path: p };
  }
  const current = Array.isArray(config.additionalModelOptionsCache) ? config.additionalModelOptionsCache : [];
  const preserved = current.filter(opt => !(opt && typeof opt.value === 'string' && opt.value.startsWith('mixdog/')));
  const merged = [...preserved, ...nextOptions];
  if (JSON.stringify(current) === JSON.stringify(merged)) {
    return { ok: true, changed: false, path: p };
  }
  if (dryRun) return { ok: true, changed: true, path: p, dryRun: true };
  config.additionalModelOptionsCache = merged;
  try {
    const tmp = p + '.mixdog-tmp';
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, changed: false, error: `cannot write ${p}: ${e.message}`, path: p };
  }
  return { ok: true, changed: true, path: p };
}
