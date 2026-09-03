// plugin-manifest.mjs — one reader for a plugin's manifest and the paths it
// points at. Skill discovery (runtime context) and the plugin admin/status
// surfaces (session-runtime, standalone) all resolve the same manifest and
// the same skill roots from here, so what a panel counts is what a session
// loads.

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** `.codex-plugin/plugin.json` wins over a root-level `plugin.json`; a plugin
 *  without either is an empty manifest, never an error. */
export function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

/** Resolve a manifest-relative path, refusing absolute paths and anything
 *  that escapes the plugin root. Returns null when rejected. */
export function resolveContainedPluginPath(root, rel) {
  const trimmed = String(rel || '').trim();
  if (!trimmed || isAbsolute(trimmed)) return null;
  const base = resolve(root);
  const abs = resolve(base, trimmed);
  const relToBase = relative(base, abs);
  if (relToBase.startsWith('..') || isAbsolute(relToBase)) return null;
  return abs;
}

/** Skill roots a plugin contributes: the conventional `<root>/skills/` plus an
 *  optional manifest `skills` path. Deduplicated, absolute, root-contained. */
export function pluginSkillsRoots(root) {
  const manifest = pluginManifest(root);
  const roots = new Set();
  const add = (rel) => {
    const abs = resolveContainedPluginPath(root, rel);
    if (abs) roots.add(abs);
  };
  add('./skills/');
  if (typeof manifest.skills === 'string' && manifest.skills.trim()) {
    add(manifest.skills.trim());
  }
  return [...roots];
}
