// Plugin/project MCP server discovery + normalization, and skill-file counting.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';
import { pluginManifest, pluginSkillsRoots, resolveContainedPluginPath } from '../../../shared/plugin-manifest.mjs';
import { isPlainObject } from '../../../shared/object.mjs';

const MCP_TRANSPORT_FIELDS = new Set([
  'type',
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'bearer_token_env_var',
  'env_http_headers',
  'env_vars',
  'autoDetect',
]);

// Every spelling resolveMcpStartupTimeoutMs / resolveMcpCallTimeoutMs reads.
// A newly supplied value must replace the whole group, or a stale alias that
// the resolver prefers would keep winning.
export const MCP_TIMEOUT_FIELD_GROUPS = [
  ['startupTimeoutMs', 'startup_timeout_ms', 'startupTimeoutSec', 'startup_timeout_sec'],
  ['timeoutMs', 'timeout_ms', 'callTimeoutMs', 'call_timeout_ms'],
];

export function mergeMcpServerConfig(existing, next) {
  const merged = isPlainObject(existing) ? { ...existing } : {};
  for (const field of MCP_TRANSPORT_FIELDS) delete merged[field];
  for (const group of MCP_TIMEOUT_FIELD_GROUPS) {
    if (group.some((field) => Object.hasOwn(next, field))) for (const field of group) delete merged[field];
  }
  return { ...merged, ...next };
}

// Manifest + contained-path resolution live in the shared module so skill
// discovery and this status surface read the same roots.
export { pluginManifest, resolveContainedPluginPath };

function mcpServersMapFromJson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (isPlainObject(raw.mcpServers)) return raw.mcpServers;
  return raw;
}

function isSkillMdFile(name) {
  return /^(SKILL|skill)\.md$/i.test(name);
}

const PLUGIN_INLINE_MCP_SCRIPT = 'plugin.json';

export function countSkillFiles(root) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isSkillMdFile(entry.name)) count += 1;
    }
  };
  const countAt = (skillsRoot) => {
    if (!existsSync(skillsRoot)) return;
    try {
      const st = statSync(skillsRoot);
      if (st.isFile()) {
        const base = skillsRoot.split(/[\\/]/).pop() || '';
        if (isSkillMdFile(base)) count += 1;
        return;
      }
      if (st.isDirectory()) walk(skillsRoot);
    } catch {
      /* ignore */
    }
  };
  for (const skillsRoot of pluginSkillsRoots(root)) countAt(skillsRoot);
  return count;
}

export function discoverPluginMcp(root) {
  const manifest = pluginManifest(root);
  const mcp = manifest.mcpServers;
  if (typeof mcp === 'string' && mcp.trim()) {
    const rel = mcp.trim();
    const abs = resolveContainedPluginPath(root, rel);
    if (abs && existsSync(abs)) return { mcpScript: rel, mcpInline: false };
  } else if (isPlainObject(mcp)) {
    const keys = Object.keys(mcp).filter((k) => isPlainObject(mcp[k]));
    if (keys.length) return { mcpScript: null, mcpInline: true };
  }
  const candidates = ['.mcp.json', 'scripts/run-mcp.mjs', 'mcp/server.mjs', 'server.mjs'];
  for (const rel of candidates) {
    const abs = resolveContainedPluginPath(root, rel);
    if (abs && existsSync(abs)) return { mcpScript: rel, mcpInline: false };
  }
  return { mcpScript: null, mcpInline: false };
}

export function pluginMcpEnableScript(root, plugin = {}) {
  if (plugin.mcpInline) return PLUGIN_INLINE_MCP_SCRIPT;
  const fromPlugin = clean(plugin.mcpScript);
  if (fromPlugin) return fromPlugin;
  const discovered = discoverPluginMcp(root);
  if (discovered.mcpInline) return PLUGIN_INLINE_MCP_SCRIPT;
  return discovered.mcpScript || null;
}

function substitutePluginRootTokens(value, root) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root).replace(/\$\{CODEX_PLUGIN_ROOT\}/g, root);
}

function substitutePluginRootTokensDeep(value, root) {
  if (typeof value === 'string') return substitutePluginRootTokens(value, root);
  if (Array.isArray(value)) return value.map((v) => substitutePluginRootTokensDeep(v, root));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePluginRootTokensDeep(v, root);
    return out;
  }
  return value;
}

export function normalizePluginMcpServerConfig(cfg, root) {
  const substituted = substitutePluginRootTokensDeep(cfg, root) || {};
  const out = { ...substituted };
  if (typeof out.cwd === 'string' && out.cwd) {
    out.cwd = isAbsolute(out.cwd) ? out.cwd : join(root, out.cwd);
  } else {
    out.cwd = root;
  }
  return out;
}

export function pluginRawMcpServers(root, script) {
  const rel = clean(script);
  if (!rel) return null;
  if (rel === PLUGIN_INLINE_MCP_SCRIPT) {
    const manifest = pluginManifest(root);
    const rawServers = manifest.mcpServers;
    if (!isPlainObject(rawServers)) {
      throw new Error('plugin.json missing inline mcpServers object');
    }
    const keys = Object.keys(rawServers).filter((k) => isPlainObject(rawServers[k]));
    if (!keys.length) throw new Error('plugin.json has no mcpServers');
    return { rawServers, mcpRoot: root };
  }
  if (!/\.json$/i.test(rel)) return null;
  const mcpJsonPath = resolveContainedPluginPath(root, rel);
  if (!mcpJsonPath || !existsSync(mcpJsonPath)) {
    throw new Error(`plugin MCP manifest not found: ${join(root, rel)}`);
  }
  const rawServers = mcpServersMapFromJson(readJsonSafe(mcpJsonPath) || {});
  if (!isPlainObject(rawServers)) {
    throw new Error(`plugin MCP manifest missing mcpServers object: ${mcpJsonPath}`);
  }
  const keys = Object.keys(rawServers).filter((k) => isPlainObject(rawServers[k]));
  if (!keys.length) throw new Error(`plugin MCP manifest has no mcpServers: ${mcpJsonPath}`);
  return { rawServers, mcpRoot: root };
}

/** Every MCP entry a plugin owns: `<serverName>` and `<serverName>--<key>`. */
export function pluginServerMatcher(serverName) {
  const prefix = `${serverName}--`;
  return (name) => name === serverName || name.startsWith(prefix);
}

export function pluginMcpServerName(plugin = {}) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}
