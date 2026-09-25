// Plugin/project MCP server discovery + normalization, and skill-file counting.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';
import { pluginManifest, pluginSkillsRoots, resolveContainedPluginPath } from '../runtime/shared/plugin-manifest.mjs';
import { isPlainObject } from '../runtime/shared/object.mjs';

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

export function mergeMcpServerConfig(existing, next) {
  const merged = isPlainObject(existing) ? { ...existing } : {};
  for (const field of MCP_TRANSPORT_FIELDS) delete merged[field];
  return { ...merged, ...next };
}

function readProjectMcpDocument(cwd, allowMissing = false) {
  const path = join(cwd || '.', '.mcp.json');
  if (!existsSync(path)) {
    if (allowMissing) return { path, raw: { mcpServers: {} }, usesWrapper: true };
    throw new Error(`MCP config file not found: ${path}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error?.message || String(error)}`);
  }
  if (!isPlainObject(raw)) throw new Error(`unexpected .mcp.json shape at ${path}`);
  if (Object.hasOwn(raw, 'mcpServers') && !isPlainObject(raw.mcpServers)) {
    throw new Error(`unexpected .mcp.json shape at ${path}`);
  }
  const usesWrapper = isPlainObject(raw.mcpServers);
  return { path, raw, usesWrapper };
}

function writeProjectMcpDocument(path, raw) {
  let mode = 0o644;
  try {
    mode = statSync(path).mode;
  } catch {
    /* new file */
  }
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let fd = null;
  try {
    fd = openSync(tempPath, 'w', mode);
    writeFileSync(fd, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

// The stored key for `key`: an exact own key first, else one that trims to it.
function mcpEntryKey(map, key) {
  return Object.hasOwn(map, key) ? key : Object.keys(map).find((candidate) => String(candidate || '').trim() === key);
}

export function readProjectMcpServerConfig(cwd, name) {
  const { raw, usesWrapper } = readProjectMcpDocument(cwd);
  const map = usesWrapper ? raw.mcpServers : raw;
  const entryKey = mcpEntryKey(map, String(name || '').trim());
  return entryKey && isPlainObject(map[entryKey]) ? { name: entryKey, config: { ...map[entryKey] } } : null;
}

export function saveProjectMcpServer(cwd, { originalName = '', name, config }) {
  const { path, raw, usesWrapper } = readProjectMcpDocument(cwd, !originalName);
  const map = usesWrapper ? raw.mcpServers : raw;
  const target = String(name || '').trim();
  const original = String(originalName || '').trim();
  if (!target) throw new Error('MCP server name is required');
  const entryKey = original ? mcpEntryKey(map, original) : null;
  if (original && !entryKey) throw new Error(`MCP server not defined in ${path}: ${original}`);
  if (target !== entryKey && Object.hasOwn(map, target)) {
    throw new Error(`MCP server already exists in ${path}: ${target}`);
  }
  const existing = entryKey ? map[entryKey] : {};
  if (entryKey && entryKey !== target) delete map[entryKey];
  map[target] = mergeMcpServerConfig(existing, config);
  writeProjectMcpDocument(path, raw);
  return { name: target, source: 'project', path, config: { ...map[target] } };
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

export function mcpScriptForPlugin(root) {
  return discoverPluginMcp(root).mcpScript;
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
