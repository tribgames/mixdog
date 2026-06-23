'use strict';
/**
 * settings-loader.cjs
 * Loads and merges Claude Code settings from three tiers (lowest → highest):
 *   1. User global:   $CLAUDE_CONFIG_DIR/settings.json (or ~/.claude/settings.json)
 *   2. Project:       $CLAUDE_PROJECT_DIR/.claude/settings.json  (or cwd/.claude/settings.json)
 *   3. Project local: $CLAUDE_PROJECT_DIR/.claude/settings.local.json
 *
 * Only `permissions` sub-tree is returned; the rest is ignored.
 * Pure fs/path — no external deps.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── In-process mtime-driven cache ────────────────────────────────────────────
// Keyed by resolved file path. Each entry: { mtime: number|null, data: any }.
// Invalidated per-tier independently when mtime changes.
// TTL: never-expire by default (mtime-driven only).
const _fileCache = new Map();

function readJsonCached(filePath) {
  let entry = _fileCache.get(filePath);
  let mtime = null;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* file absent */ }
  if (entry && entry.mtime === mtime) return entry.data;
  let data = null;
  if (mtime !== null) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { data = null; }
  }
  _fileCache.set(filePath, { mtime, data });
  return data;
}

/** Clear the entire settings cache (for test isolation). */
function clearSettingsCache() {
  _fileCache.clear();
}

/**
 * Merge two permissions objects (base then overlay).
 * Arrays are concatenated and de-duped; scalar fields are overwritten.
 */
function mergePermissions(base, overlay) {
  if (!overlay) return base || {};
  if (!base) return overlay || {};

  const merged = Object.assign({}, base);

  for (const key of ['allow', 'deny', 'ask']) {
    const b = Array.isArray(base[key]) ? base[key] : [];
    const o = Array.isArray(overlay[key]) ? overlay[key] : [];
    const combined = [...b, ...o];
    if (combined.length) merged[key] = [...new Set(combined)];
  }

  // scalar: overlay wins
  if (overlay.defaultMode !== undefined) merged.defaultMode = overlay.defaultMode;

  return merged;
}

/**
 * Load and merge settings from all three tiers.
 * Returns `{ allow: string[], deny: string[], ask: string[], defaultMode: string }`.
 */
function loadPermissions(projectDir) {
  const userConfigDir = process.env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude');
  const projDir = projectDir ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  const userSettings    = readJsonCached(path.join(userConfigDir, 'settings.json'));
  const projectSettings = readJsonCached(path.join(projDir, '.claude', 'settings.json'));
  const localSettings   = readJsonCached(path.join(projDir, '.claude', 'settings.local.json'));

  // Accept permissions from `settings.permissions` (canonical) OR top-level
  // `allow`/`deny`/`ask`/`defaultMode` fields (common user shorthand).
  function extractPerms(s) {
    if (!s) return {};
    const nested = (s.permissions && typeof s.permissions === 'object') ? s.permissions : {};
    const topLevel = {};
    for (const key of ['allow', 'deny', 'ask']) {
      if (Array.isArray(s[key])) topLevel[key] = s[key];
    }
    if (typeof s.defaultMode === 'string') topLevel.defaultMode = s.defaultMode;
    return mergePermissions(nested, topLevel);
  }
  const userPerms    = extractPerms(userSettings);
  const projectPerms = extractPerms(projectSettings);
  const localPerms   = extractPerms(localSettings);

  let merged = mergePermissions({}, userPerms);
  merged = mergePermissions(merged, projectPerms);
  merged = mergePermissions(merged, localPerms);

  const VALID_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto']);
  const rawMode = merged.defaultMode;
  const resolvedMode = (typeof rawMode === 'string' && VALID_MODES.has(rawMode))
    ? rawMode
    : 'default';
  return {
    allow:       Array.isArray(merged.allow)       ? merged.allow       : [],
    deny:        Array.isArray(merged.deny)        ? merged.deny        : [],
    ask:         Array.isArray(merged.ask)         ? merged.ask         : [],
    defaultMode: resolvedMode,
  };
}

module.exports = { loadPermissions, clearSettingsCache };
