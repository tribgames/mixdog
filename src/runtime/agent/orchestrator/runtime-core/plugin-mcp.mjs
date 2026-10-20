// Plugin/project MCP server discovery + normalization, and skill-file counting.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { clean } from './session-text.mjs';
import {
  PLUGIN_MANIFEST_FILES,
  pluginManifest,
  pluginSkillsRoots,
  resolveContainedPluginPath,
} from '../../../shared/plugin-manifest.mjs';
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
  'oauthClientId',
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

function isSkillMdFile(name) {
  return /^(SKILL|skill)\.md$/i.test(name);
}

const PLUGIN_MANIFEST_FORMATS = {
  '.codex-plugin/plugin.json': 'codex',
  'plugin.json': 'mixdog',
  '.claude-plugin/plugin.json': 'claude',
};

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

const MCP_STDIO_TYPES = new Set(['stdio']);
const MCP_URL_TYPES = new Set(['http', 'streamable-http', 'sse', 'ws']);

function manifestFormat(root) {
  for (const rel of PLUGIN_MANIFEST_FILES) {
    const path = join(root, ...rel.split('/'));
    if (existsSync(path)) return { path, format: PLUGIN_MANIFEST_FORMATS[rel] };
  }
  return null;
}

/** Transport a declared server asks for, inferred the way the MCP client does
 *  when `type` is absent: `transport: "http"` or a `url` -> http, else stdio.
 *  Null for an unrecognized explicit type. */
export function declaredMcpTransport(config) {
  if (config?.type !== undefined && config?.type !== null && config?.type !== '') {
    if (typeof config.type !== 'string') return null;
    const type = config.type.toLowerCase();
    if (type === 'streamablehttp') return 'streamable-http';
    return MCP_STDIO_TYPES.has(type) || MCP_URL_TYPES.has(type) ? type : null;
  }
  if (config?.transport === 'http') return 'http';
  if (config?.command !== undefined) return 'stdio';
  if (config?.url !== undefined) return 'http';
  return 'stdio';
}

// One server entry -> a message when it cannot be launched, else null. Messages
// name fields and expected types only, never a configured value.
function mcpServerProblem(config) {
  if (!isPlainObject(config)) return 'server entry must be an object';
  const type = declaredMcpTransport(config);
  if (!type) return '"type" must be one of stdio, http, streamable-http, sse, ws';
  if (MCP_STDIO_TYPES.has(type)) {
    return typeof config.command === 'string' && config.command.trim() ? null : 'stdio server requires "command"';
  }
  return typeof config.url === 'string' && config.url.trim() ? null : `${type} server requires "url"`;
}

// A JSON parse failure as a location only: engines may quote the offending
// source text, which can hold credentials.
function jsonErrorMessage(error) {
  const text = String(error?.message || '');
  const lineColumn = /line (\d+) column (\d+)/.exec(text);
  if (lineColumn) return `invalid JSON at line ${lineColumn[1]} column ${lineColumn[2]}`;
  const position = /position (\d+)/.exec(text);
  if (position) return `invalid JSON at position ${position[1]}`;
  return /end of (JSON|data) input/i.test(text) ? 'invalid JSON: unexpected end of input' : 'invalid JSON';
}

function readJsonFile(path, errors) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    errors.push({ source: path, message: `cannot read file${error?.code ? ` (${error.code})` : ''}` });
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    errors.push({ source: path, message: jsonErrorMessage(error) });
    return { ok: false };
  }
}

// A `{ mcpServers: {...} }` wrapper or a bare server map -> the server map.
function mcpServerMap(doc, source, errors, where = '') {
  if (!isPlainObject(doc)) {
    errors.push({ source, message: `${where}MCP declaration must be an object` });
    return null;
  }
  if (!Object.hasOwn(doc, 'mcpServers')) return doc;
  if (!isPlainObject(doc.mcpServers)) {
    errors.push({ source, message: `${where}"mcpServers" must be an object` });
    return null;
  }
  return doc.mcpServers;
}

function collectMcpServers(map, source, into, errors) {
  for (const [key, config] of Object.entries(map)) {
    const problem = mcpServerProblem(config);
    if (problem) errors.push({ source, key, message: problem });
    else into.set(key, { key, config, source });
  }
}

function loadMcpJsonFile(path, into, errors) {
  const read = readJsonFile(path, errors);
  if (!read.ok) return;
  const map = mcpServerMap(read.value, path, errors);
  if (map) collectMcpServers(map, path, into, errors);
}

// `where` locates the manifest field (e.g. `mcpServers[1]: `); the declared
// path itself is never echoed.
function loadDeclaredPath(root, rel, manifestPath, into, errors, touched, where) {
  if (typeof rel !== 'string' || !rel.trim()) {
    errors.push({ source: manifestPath, message: `${where}MCP path must be a non-empty string` });
    return;
  }
  const abs = resolveContainedPluginPath(root, rel);
  if (!abs || rel.split(/[\\/]/).includes('..')) {
    errors.push({ source: manifestPath, message: `${where}MCP path must be relative and stay inside the plugin root` });
    return;
  }
  touched.add(abs);
  if (!existsSync(abs)) {
    errors.push({ source: manifestPath, message: `${where}MCP file not found` });
    return;
  }
  loadMcpJsonFile(abs, into, errors);
}

function readPluginMcpDeclarations(root, touched) {
  const errors = [];
  const into = new Map();
  for (const rel of PLUGIN_MANIFEST_FILES) touched.add(join(root, ...rel.split('/')));
  const found = manifestFormat(root);
  const mcpJson = join(root, '.mcp.json');
  touched.add(mcpJson);
  const hasMcpJson = existsSync(mcpJson);
  let format = 'none';
  if (found) format = found.format;
  else if (hasMcpJson) format = 'claude';

  if (hasMcpJson) loadMcpJsonFile(mcpJson, into, errors);

  let declaredRef;
  if (found) {
    const read = readJsonFile(found.path, errors);
    const declared = read.ok && isPlainObject(read.value) ? read.value.mcpServers : undefined;
    declaredRef = declared;
    if (declared === undefined) {
      /* nothing declared */
    } else if (typeof declared === 'string') {
      loadDeclaredPath(root, declared, found.path, into, errors, touched, '"mcpServers": ');
    } else if (Array.isArray(declared)) {
      // Members merge in order: a path to a JSON file, or an inline server
      // map (bare or `{ mcpServers }`-wrapped).
      declared.forEach((entry, index) => {
        const where = `"mcpServers"[${index}]: `;
        if (isPlainObject(entry)) {
          const map = mcpServerMap(entry, found.path, errors, where);
          if (map) collectMcpServers(map, found.path, into, errors);
        } else {
          loadDeclaredPath(root, entry, found.path, into, errors, touched, where);
        }
      });
    } else if (isPlainObject(declared)) {
      const map = mcpServerMap(declared, found.path, errors);
      if (map) collectMcpServers(map, found.path, into, errors);
    } else {
      errors.push({ source: found.path, message: '"mcpServers" must be a path, a list, or an object' });
    }
  }
  const declaredPath = typeof declaredRef === 'string' ? declaredRef : null;
  return { format, servers: [...into.values()], errors, declaredPath };
}

// Parsed declarations per plugin root, valid while every file the parse looked
// at (present or absent) still has the same identity, size and timestamps.
const DECLARATION_CACHE_MAX = 256;
const declarationCache = new Map();
const declarationCacheStats = { hits: 0, misses: 0 };

function fileStamp(path) {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return '-';
  }
}

function copyDeclarations(result) {
  return {
    format: result.format,
    servers: result.servers.map((server) => ({ ...server, config: structuredClone(server.config) })),
    errors: result.errors.map((error) => ({ ...error })),
  };
}

/** What a plugin declares for MCP, read raw: `<root>/.mcp.json` first, then the
 *  manifest `mcpServers` (a path, an inline object, or a list mixing both).
 *  Later sources override earlier ones by key. Never throws for plugin
 *  content; errors carry locations and field names, never values. Unchanged
 *  declaration files are not parsed again. */
export function loadPluginMcpDeclarations(root) {
  return copyDeclarations(cachedDeclarations(root));
}

function cachedDeclarations(root) {
  const key = String(root || '');
  const cached = declarationCache.get(key);
  if (cached?.signature.every(([path, stamp]) => fileStamp(path) === stamp)) {
    declarationCacheStats.hits += 1;
    return cached.result;
  }
  declarationCacheStats.misses += 1;
  // Stamps are taken before reading, so a write racing the parse invalidates.
  const before = new Map();
  const result = readPluginMcpDeclarations(root, {
    add(path) {
      if (!before.has(path)) before.set(path, fileStamp(path));
    },
  });
  declarationCache.delete(key);
  declarationCache.set(key, { signature: [...before], result });
  if (declarationCache.size > DECLARATION_CACHE_MAX) declarationCache.delete(declarationCache.keys().next().value);
  return result;
}

/** Test seam: cache hit/miss counters. */
export function pluginMcpDeclarationCacheStats() {
  return { ...declarationCacheStats };
}

// Adapter: where the declarations live, in the shape older callers expect.
export function discoverPluginMcp(root) {
  const { servers, declaredPath } = cachedDeclarations(root);
  if (!servers.length) return { mcpScript: null, mcpInline: false };
  const inline = servers.some((s) => PLUGIN_MANIFEST_FILES.some((rel) => s.source === join(root, ...rel.split('/'))));
  if (inline) return { mcpScript: null, mcpInline: true };
  if (declaredPath?.trim()) {
    const abs = resolveContainedPluginPath(root, declaredPath);
    if (servers.some((s) => s.source === abs)) return { mcpScript: declaredPath.trim(), mcpInline: false };
  }
  const mcpJson = join(root, '.mcp.json');
  const declaredFile = servers.find((s) => s.source !== mcpJson) || servers[0];
  return { mcpScript: relative(root, declaredFile.source).split(sep).join('/'), mcpInline: false };
}

// User intent for plugin-declared servers, stored apart from the declarations
// as `pluginMcp[pluginId][declaredKey]`: `enabled: false`, a kept `alias`
// name, and connection overrides layered over the declaration.
export const PLUGIN_MCP_OVERRIDE_MAP_FIELDS = Object.freeze(['env', 'headers', 'env_http_headers']);
export const PLUGIN_MCP_OVERRIDE_VALUE_FIELDS = Object.freeze([
  'command',
  'args',
  'url',
  'bearer_token_env_var',
  'env_vars',
  ...MCP_TIMEOUT_FIELD_GROUPS.flat(),
]);

function normalizePluginMcpIntent(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  // `enabled: true` is kept too: it turns on a server declared `enabled: false`.
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  if (typeof value.alias === 'string' && value.alias.trim()) out.alias = value.alias.trim();
  for (const field of PLUGIN_MCP_OVERRIDE_MAP_FIELDS) {
    if (!isPlainObject(value[field])) continue;
    const map = Object.fromEntries(Object.entries(value[field]).filter(([, v]) => v !== null && v !== undefined));
    if (Object.keys(map).length) out[field] = map;
  }
  for (const field of PLUGIN_MCP_OVERRIDE_VALUE_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) out[field] = value[field];
  }
  return Object.keys(out).length ? out : null;
}

/** `{ [pluginId]: { [declaredKey]: intent } }` with empty records dropped. */
export function normalizePluginMcpIntents(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [pluginId, servers] of Object.entries(value)) {
    const id = clean(pluginId);
    if (!id || !isPlainObject(servers)) continue;
    const kept = {};
    for (const [key, intent] of Object.entries(servers)) {
      const normalized = normalizePluginMcpIntent(intent);
      if (key && normalized) kept[key] = normalized;
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}
