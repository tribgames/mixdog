'use strict';

/**
 * Canonical resolver for CLAUDE_PLUGIN_DATA (plugin data dir).
 *
 * Resolution order:
 *   1. process.env.CLAUDE_PLUGIN_DATA  — set by Claude Code when spawning
 *                                        the MCP server or a hook.
 *   2. Derive from CLAUDE_PLUGIN_ROOT  — works both for cache layout
 *                                        (.../cache/{marketplace}/{plugin}/{version}/)
 *                                        and marketplace layout
 *                                        (.../marketplaces/{marketplace}/).
 *
 * In standalone mixdog, falls back to MIXDOG_DATA_DIR or ~/.mixdog/data
 * when the host plugin env is absent.
 * Plugin-host runs still prefer the host-provided env vars above.
 *
 * DEFAULT_PLUGIN / DEFAULT_MARKETPLACE are exported so a handful of
 * callers (MCP client spawning sibling plugins, session-manager building
 * PLUGIN_ROOT for rule injection) can reference the canonical names
 * without re-hardcoding the strings. Update both in lockstep with
 * `.claude-plugin/marketplace.json` if the marketplace is ever renamed.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_PLUGIN = 'mixdog';
const DEFAULT_MARKETPLACE = 'trib-plugin';

// Claude config base — honours CLAUDE_CONFIG_DIR when set, otherwise the
// real Claude Code default of ~/.claude (matches settings-loader.cjs,
// statusline, doctor, install). Only ADDS the env override; never relocates
// the default base.
function claudeConfigBase() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readPluginManifestName(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
  } catch { /* fall through to default */ }
  return DEFAULT_PLUGIN;
}

function resolvePluginData() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const dirName = path.basename(root);
    // Cache layout schema: <plugin>/mixdog/<semver>/ — regex matches the semver dir prefix in the path.
    if (/^\d+\.\d+\.\d+/.test(dirName)) {
      const pluginName = path.basename(path.join(root, '..'));
      const marketplace = path.basename(path.join(root, '..', '..'));
      return path.join(claudeConfigBase(), 'plugins', 'data', `${pluginName}-${marketplace}`);
    }
    // Marketplace layout: .../marketplaces/{marketplace}/
    // The root dir itself is the marketplace. Plugin name lives in the
    // manifest; fall back to DEFAULT_PLUGIN when it's unreadable.
    const marketplace = dirName;
    const pluginName = readPluginManifestName(root);
    return path.join(claudeConfigBase(), 'plugins', 'data', `${pluginName}-${marketplace}`);
  }
  // Standalone mixdog: own user-global data like Claude Code's ~/.claude.
  return process.env.MIXDOG_DATA_DIR || path.join(os.homedir(), '.mixdog', 'data');
}

module.exports = { resolvePluginData, DEFAULT_PLUGIN, DEFAULT_MARKETPLACE };
