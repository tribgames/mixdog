/**
 * Canonical resolver for CLAUDE_PLUGIN_DATA (plugin data dir).
 *
 * Resolution order:
 *   1. process.env.CLAUDE_PLUGIN_DATA  — set by Claude Code when spawning
 *                                        the MCP server or a hook.
 *   2. Derive from CLAUDE_PLUGIN_ROOT  — supports two real layouts:
 *        cache:        .../cache/{marketplace}/{plugin}/{version}/
 *        marketplace:  .../marketplaces/{marketplace}/   (root *is* the
 *                      marketplace dir; plugin name comes from
 *                      .claude-plugin/plugin.json or DEFAULT_PLUGIN)
 *
 * In standalone mixdog, falls back to MIXDOG_DATA_DIR or
 * <project-root>/.mixdog/data when the host plugin env is absent.
 * Plugin-host runs still prefer the host-provided env vars above.
 *
 * DEFAULT_PLUGIN / DEFAULT_MARKETPLACE are exported so a handful of
 * callers (MCP client spawning sibling plugins, session-manager building
 * PLUGIN_ROOT for rule injection) can reference the canonical names
 * without re-hardcoding the strings. Update both in lockstep with
 * `.claude-plugin/marketplace.json` if the marketplace is ever renamed.
 */

import { homedir } from 'os';
import { join, basename, dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export const DEFAULT_PLUGIN = 'mixdog';
export const DEFAULT_MARKETPLACE = 'trib-plugin';
const STANDALONE_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readPluginManifestName(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
  } catch { /* fall through to default */ }
  return DEFAULT_PLUGIN;
}

export function resolvePluginData() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const dirName = basename(root);
    // Cache layout: .../cache/{marketplace}/{plugin}/{version}/
    if (/^\d+\.\d+\.\d+/.test(dirName)) {
      const pluginName = basename(join(root, '..'));
      const marketplace = basename(join(root, '..', '..'));
      return join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
    }
    // Marketplace layout: .../marketplaces/{marketplace}/
    // The root dir itself is the marketplace. Plugin name lives in the
    // manifest; fall back to DEFAULT_PLUGIN when it's unreadable.
    const marketplace = dirName;
    const pluginName = readPluginManifestName(root);
    return join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
  }
  // Standalone mixdog: own a project-local data dir (override with MIXDOG_DATA_DIR).
  return process.env.MIXDOG_DATA_DIR || join(STANDALONE_PROJECT_ROOT, '.mixdog', 'data');
}
