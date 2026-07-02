// Plugin/project MCP server discovery + normalization, and skill-file counting.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { clean } from './session-text.mjs';
import { readJsonSafe } from './fs-utils.mjs';

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

export function countSkillFiles(root) {
  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(SKILL|skill)\.md$/i.test(entry.name) || entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
  };
  try { walk(skillsDir); } catch { return count; }
  return count;
}

export function mcpScriptForPlugin(root) {
  const candidates = [
    '.mcp.json',
    'scripts/run-mcp.mjs',
    'mcp/server.mjs',
    'server.mjs',
  ];
  return candidates.find((rel) => existsSync(join(root, rel))) || null;
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

export function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

export function pluginMcpServerName(plugin = {}) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}
