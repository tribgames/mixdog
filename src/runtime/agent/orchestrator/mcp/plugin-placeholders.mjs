/**
 * mcp/plugin-placeholders.mjs — plugin root/data placeholders in an MCP server
 * config. Pure: no filesystem access; the caller supplies the directories.
 */

const ROOT_NAMES = ['CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'PLUGIN_ROOT', 'MIXDOG_PLUGIN_ROOT'];
const DATA_NAMES = ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA', 'MIXDOG_PLUGIN_DATA'];
const PLACEHOLDER_RE = new RegExp(`\\$\\{(${[...ROOT_NAMES, ...DATA_NAMES].join('|')})\\}`, 'g');
const CONFIG_FIELDS = ['command', 'args', 'env', 'url', 'headers', 'cwd'];

// Substituted paths use forward slashes on Windows so a path that lands in a
// command line or argument is not read as backslash escapes; Windows accepts
// them everywhere.
function normalizePath(path, platform) {
  return platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

function substitute(value, replacements) {
  if (typeof value === 'string') {
    // Function replacement: `$` sequences in paths are inserted literally.
    return value.replace(PLACEHOLDER_RE, (match, name) => replacements.get(name) ?? match);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, replacements));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, replacements);
    return out;
  }
  return value;
}

/**
 * Returns a copy of `config` with plugin root/data placeholders replaced in
 * command, args, env, url, headers and cwd. A placeholder whose directory is
 * not supplied is left as written. Run before ordinary env expansion.
 */
export function resolvePluginPlaceholders(config, { root, data, platform = process.platform } = {}) {
  const replacements = new Map();
  if (root) for (const name of ROOT_NAMES) replacements.set(name, normalizePath(String(root), platform));
  if (data) for (const name of DATA_NAMES) replacements.set(name, normalizePath(String(data), platform));
  const out = { ...config };
  for (const field of CONFIG_FIELDS) {
    if (out[field] !== undefined) out[field] = substitute(out[field], replacements);
  }
  return out;
}

/** Environment variables a plugin-owned server process receives (raw paths). */
export function pluginServerEnv({ root, data } = {}) {
  const env = {};
  if (root) for (const name of ['CLAUDE_PLUGIN_ROOT', 'MIXDOG_PLUGIN_ROOT', 'PLUGIN_ROOT']) env[name] = String(root);
  if (data) for (const name of ['CLAUDE_PLUGIN_DATA', 'MIXDOG_PLUGIN_DATA', 'PLUGIN_DATA']) env[name] = String(data);
  return env;
}
