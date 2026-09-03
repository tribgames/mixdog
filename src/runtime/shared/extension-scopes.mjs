// extension-scopes.mjs — project scope for Skills, MCP servers, and Plugins
// (pure normalization + path matching; no runtime dependencies so config.mjs
// can persist the shape and session-runtime/extension-scopes.mjs can add the
// plugin-aware filters on top).
//
// Every extension is installed and connected machine-wide (one registry, one
// MCP process per server, one skills dir). Scope only decides WHICH SESSIONS
// SEE an extension: an entry lists the project roots it is limited to, and a
// session whose cwd sits inside one of them gets the extension in its
// prompt/tool surface. No entry means global — the previous behaviour.
//
// Persisted shape (config.extensionScopes):
//   { skills: { [skillName]: [projectRoot, …] },
//     mcp:    { [serverName]: [projectRoot, …] },
//     plugins:{ [pluginId]:   [projectRoot, …] } }
import { resolve, sep } from 'node:path';

export const EXTENSION_SCOPE_KINDS = Object.freeze(['skills', 'mcp', 'plugins']);

const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeRoot(value) {
  const text = clean(value);
  if (!text) return '';
  let path = resolve(text);
  // Keep a drive root ("C:\") intact; strip any other trailing separator so
  // "C:\p\" and "C:\p" compare equal.
  while (path.length > 3 && (path.endsWith(sep) || path.endsWith('/'))) path = path.slice(0, -1);
  return path;
}

function comparablePath(path) {
  const unified = String(path).replace(/[\\/]+/g, sep);
  return CASE_INSENSITIVE_PATHS ? unified.toLowerCase() : unified;
}

function normalizeRootList(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const root = normalizeRoot(item);
    if (!root) continue;
    const key = comparablePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizeKindMap(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [name, roots] of Object.entries(raw)) {
    const key = clean(name);
    if (!key) continue;
    const list = normalizeRootList(roots);
    // An empty list is the same as no entry: global.
    if (list.length) out[key] = list;
  }
  return out;
}

/** Stable `{ skills, mcp, plugins }` map; unknown kinds and empty lists drop. */
export function normalizeExtensionScopes(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const kind of EXTENSION_SCOPE_KINDS) out[kind] = normalizeKindMap(raw[kind]);
  return out;
}

/** True when the normalized map holds at least one entry (worth persisting). */
export function hasExtensionScopes(scopes) {
  return EXTENSION_SCOPE_KINDS.some((kind) => Object.keys(scopes?.[kind] || {}).length > 0);
}

export function extensionScopesFromConfig(config = null) {
  return normalizeExtensionScopes(config?.extensionScopes);
}

/** Project roots an entry is limited to, or null when it is global. */
export function extensionScopeProjects(scopes, kind, name) {
  const map = scopes?.[kind];
  const key = clean(name);
  if (!map || !key) return null;
  const list = map[key];
  return Array.isArray(list) && list.length ? [...list] : null;
}

/** True when `cwd` is one of the roots or sits below one of them. */
export function cwdWithinProjects(cwd, projects) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return true;
  const here = normalizeRoot(cwd);
  if (!here) return false;
  const target = comparablePath(here);
  return list.some((root) => {
    const base = comparablePath(normalizeRoot(root));
    if (!base) return false;
    if (target === base) return true;
    const prefix = base.endsWith(sep) ? base : base + sep;
    return target.startsWith(prefix);
  });
}

export function extensionAllowedForCwd(scopes, kind, name, cwd) {
  const projects = extensionScopeProjects(scopes, kind, name);
  if (!projects) return true;
  return cwdWithinProjects(cwd, projects);
}

/** A skill is visible when neither its own scope nor its plugin's excludes cwd. */
export function skillAllowedForCwd(scopes, skill, cwd) {
  if (!extensionAllowedForCwd(scopes, 'skills', skill?.name, cwd)) return false;
  const pluginId = clean(skill?.plugin || (skill?.owner?.kind === 'plugin' ? skill.owner.id : ''));
  if (pluginId && !extensionAllowedForCwd(scopes, 'plugins', pluginId, cwd)) return false;
  return true;
}

export function mcpServerNameOfTool(toolName) {
  const match = /^mcp__(.+?)__(.+)$/.exec(clean(toolName));
  return match ? match[1] : '';
}

/** New config with one entry replaced; `projects` null/empty removes it (global). */
export function withExtensionScope(config, kind, name, projects) {
  if (!EXTENSION_SCOPE_KINDS.includes(kind)) throw new Error(`unknown extension scope kind: ${kind}`);
  const key = clean(name);
  if (!key) throw new Error('extension name is required');
  const current = extensionScopesFromConfig(config);
  const next = { ...current, [kind]: { ...current[kind] } };
  const list = normalizeRootList(projects);
  if (list.length) next[kind][key] = list;
  else delete next[kind][key];
  return { ...(config || {}), extensionScopes: normalizeExtensionScopes(next) };
}
