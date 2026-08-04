// Plugin/project MCP server discovery + normalization, and skill-file counting.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';

// Config keys must compare the same cwd spelling on read and write. Windows
// paths are case-insensitive, so canonicalize their resolved form to lowercase.
export function normalizeMcpProjectPathKey(cwd) {
  const path = resolve(cwd || '.');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

// Project-local MCP ingress: read `.mcp.json` from the project root and return
// a cleaned { name: cfg } map. Best-effort — never throws. Accepts either the
// standard `{ mcpServers: {...} }` shape or a bare name->cfg map. Self-ref
// servers (`mixdog` / `trib-plugin`) are stripped for parity with loadConfig.
// Inputs are not mutated.
export function readProjectMcpServers(cwd) {
  const path = join(cwd || '.', '.mcp.json');
  if (!existsSync(path)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(`[mcp-client] Ignoring unparseable .mcp.json at ${path}: ${error?.message || String(error)}\n`);
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
    ? raw.mcpServers
    : raw;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const out = {};
  for (const [name, cfg] of Object.entries(map)) {
    const key = clean(name);
    if (!key) continue;
    const lower = key.toLowerCase();
    if (lower === 'mixdog' || lower === 'trib-plugin') continue;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    // stdio entries (command + no url) spawn relative to the process launch
    // dir, but mixdog tracks the project dir in memory (no process.chdir).
    // Anchor their cwd to the .mcp.json directory: default when absent, resolve
    // relative values against it, keep absolute values as-is.
    const isStdio = typeof cfg.command === 'string' && cfg.command !== '' && !cfg.url;
    if (isStdio) {
      out[key] = { ...cfg, cwd: typeof cfg.cwd === 'string' && cfg.cwd ? resolve(cwd, cfg.cwd) : resolve(cwd) };
    } else {
      out[key] = cfg;
    }
  }
  return out;
}

// Persist an enable/disable flag for a project-local `.mcp.json` server, in
// place, preserving the file's shape. Accepts both the standard
// `{ mcpServers: {...} }` wrapper and a bare name->cfg map. Writes pretty JSON
// (2-space indent + trailing newline) so the file stays valid + diff-friendly.
// Throws if the file is missing/unparseable or the server isn't defined there.
export function setProjectMcpServerEnabled(cwd, name, enabled) {
  const path = join(cwd || '.', '.mcp.json');
  const key = clean(name);
  if (!key) throw new Error('MCP server name is required');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot update ${path}: ${error?.message || String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`unexpected .mcp.json shape at ${path}`);
  }
  const usesWrapper = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers);
  const map = usesWrapper ? raw.mcpServers : raw;
  const entryKey = Object.prototype.hasOwnProperty.call(map, key)
    ? key
    : Object.keys(map).reverse().find((candidate) => clean(candidate) === key);
  if (!map || typeof map !== 'object' || Array.isArray(map) || !entryKey) {
    throw new Error(`MCP server not defined in ${path}: ${key}`);
  }
  const entry = map[entryKey];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`MCP server is not an object in ${path}: ${key}`);
  }
  map[entryKey] = { ...entry, enabled: enabled !== false };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return raw;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

export function resolveContainedPluginPath(root, rel) {
  const trimmed = String(rel || '').trim();
  if (!trimmed || isAbsolute(trimmed)) return null;
  const base = resolve(root);
  const abs = resolve(base, trimmed);
  const relToBase = relative(base, abs);
  if (relToBase.startsWith('..') || isAbsolute(relToBase)) return null;
  return abs;
}

function pluginSkillsRoots(root) {
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
    } catch { /* ignore */ }
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
  const candidates = [
    '.mcp.json',
    'scripts/run-mcp.mjs',
    'mcp/server.mjs',
    'server.mjs',
  ];
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
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    .replace(/\$\{CODEX_PLUGIN_ROOT\}/g, root);
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

export function pluginMcpServerName(plugin = {}) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}
