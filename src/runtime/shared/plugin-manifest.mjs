// plugin-manifest.mjs — one reader for a plugin's manifest and the paths it
// points at. Skill discovery (runtime context) and the plugin admin/status
// surfaces (session-runtime, standalone) all resolve the same manifest and
// the same skill roots from here, so what a panel counts is what a session
// loads.

import { isAbsolute, join, relative, resolve } from 'node:path';
import { readJsonSafe } from './json-file.mjs';

/** Manifest files in precedence order: `.codex-plugin/plugin.json`, a
 *  root-level `plugin.json`, then Claude Code's `.claude-plugin/plugin.json`. */
export const PLUGIN_MANIFEST_FILES = ['.codex-plugin/plugin.json', 'plugin.json', '.claude-plugin/plugin.json'];

/** First readable manifest in `PLUGIN_MANIFEST_FILES` order; a plugin without
 *  any is an empty manifest, never an error. A Claude Code manifest's `skills`
 *  is a plugin-relative path (e.g. `./.claude/skills/`). */
export function pluginManifest(root) {
  for (const rel of PLUGIN_MANIFEST_FILES) {
    const manifest = readJsonSafe(join(root, ...rel.split('/')));
    if (manifest) return manifest;
  }
  return {};
}

/** Resolve a manifest-relative path, refusing absolute paths and anything
 *  that escapes the plugin root. Returns null when rejected. */
export function resolveContainedPluginPath(root, rel) {
  const trimmed = String(rel || '').trim();
  if (!trimmed || isAbsolute(trimmed)) return null;
  const base = resolve(root);
  const abs = resolve(base, trimmed);
  const relToBase = relative(base, abs);
  if (relToBase.split(/[\\/]/)[0] === '..' || isAbsolute(relToBase)) return null;
  return abs;
}

/** Skill roots a plugin contributes: the conventional `<root>/skills/` plus the
 *  manifest `skills` field, a path or a list of paths. Deduplicated, absolute,
 *  root-contained. */
export function pluginSkillsRoots(root) {
  const manifest = pluginManifest(root);
  const roots = new Set();
  const add = (rel) => {
    if (typeof rel !== 'string' || !rel.trim()) return;
    const abs = resolveContainedPluginPath(root, rel);
    if (abs) roots.add(abs);
  };
  add('./skills/');
  for (const rel of Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]) add(rel);
  return [...roots];
}
