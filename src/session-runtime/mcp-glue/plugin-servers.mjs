// MCP servers derived live from enabled plugins. Nothing here is written into
// `config.mcpServers`: every resolve reads the registered plugins' declarations
// and folds in the user's per-server intent (`config.pluginMcp`). Also owns the
// one-time adoption of server copies an older enable action wrote into
// `config.mcpServers`, as a pure plan the caller may persist.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  PLUGIN_MCP_OVERRIDE_MAP_FIELDS,
  PLUGIN_MCP_OVERRIDE_VALUE_FIELDS,
  declaredMcpTransport,
  loadPluginMcpDeclarations,
  normalizePluginMcpIntents,
} from '../../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import {
  pluginServerEnv,
  resolvePluginPlaceholders,
} from '../../runtime/agent/orchestrator/mcp/plugin-placeholders.mjs';
import { clean } from '../../runtime/shared/clean.mjs';
import { isPlainObject } from '../../runtime/shared/object.mjs';

// Tool names are `mcp__<server>__<tool>` and providers cap a tool name at 64
// characters of [A-Za-z0-9_-]; a short hyphenated server name leaves the tool
// its room and can never contain the `__` delimiter.
export const PLUGIN_MCP_NAME_MAX = 32;
const LEGACY_ENV_KEYS = new Set(['MIXDOG_PLUGIN_ROOT', 'MIXDOG_PLUGIN_DATA']);
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortHash(text, length) {
  return createHash('sha1').update(text).digest('hex').slice(0, length);
}

function withSuffix(name, suffix) {
  return `${name.slice(0, PLUGIN_MCP_NAME_MAX - suffix.length - 1).replace(/-+$/, '')}-${suffix}`;
}

/** Name of one plugin server: the registry id (without its source hash) and
 *  the declared key, the key dropped when it repeats the plugin. Never depends
 *  on how many servers the plugin declares. */
export function pluginMcpServerBaseName(pluginId, key) {
  const stem = slug(String(pluginId || '').replace(/-[0-9a-f]{8}$/i, '')) || 'plugin';
  const leaf = slug(key) || 'mcp';
  const name = leaf === stem ? `plugin-${stem}` : `plugin-${stem}-${leaf}`;
  return name.length <= PLUGIN_MCP_NAME_MAX ? name : withSuffix(name, shortHash(`${pluginId}\0${key}`, 8));
}

function disambiguatedName(base, pluginId, key, taken) {
  const suffix = shortHash(`${pluginId}\0${key}`, 6);
  let name = withSuffix(base, suffix);
  for (let n = 2; taken.has(name); n += 1) name = withSuffix(base, `${suffix}${n}`);
  return name;
}

// The name an earlier enable action gave a plugin's server copy.
function legacyServerName(plugin) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}

function comparablePath(path) {
  const text = clean(path);
  if (!text) return '';
  const unified = resolve(text)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '');
  return CASE_INSENSITIVE_PATHS ? unified.toLowerCase() : unified;
}

// How an earlier enable action rewrote a declaration before copying it.
function legacyCopyForm(value, root) {
  if (typeof value === 'string') {
    return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root).replace(/\$\{CODEX_PLUGIN_ROOT\}/g, root);
  }
  if (Array.isArray(value)) return value.map((v) => legacyCopyForm(v, root));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, legacyCopyForm(v, root)]));
  return value;
}

function sameTransport(copy, declared, root) {
  const form = legacyCopyForm(declared, root);
  return ['command', 'args', 'url'].every((field) => isDeepStrictEqual(copy[field], form[field]));
}

const comparableTransport = (config) => {
  const type = declaredMcpTransport(config);
  return type === 'streamable-http' ? 'http' : type;
};

/** What the user changed in a copy relative to the declaration it was made
 *  from: `{ overrides }` when every change is something a plugin server
 *  override applies, else `{ reason }` (the copy is then left as configured,
 *  so nothing is ever dropped). Values the earlier enable action generated
 *  itself (plugin env markers, the forced cwd, enable flags) are not changes. */
function copyOverrides(copy, declared, root) {
  const form = legacyCopyForm(declared, root);
  const out = {};
  const kept = [];
  for (const field of new Set([...Object.keys(copy), ...Object.keys(form)])) {
    if (field === 'enabled' || field === '_mixdogPluginDisabled') continue;
    if (field === 'type' || field === 'transport') {
      if (comparableTransport(copy) !== comparableTransport(form)) kept.push(field);
      continue;
    }
    if (field === 'cwd') {
      const declaredCwd = typeof form.cwd === 'string' && form.cwd ? form.cwd : '';
      let generated = root;
      if (declaredCwd) generated = isAbsolute(declaredCwd) ? declaredCwd : join(root, declaredCwd);
      if (copy.cwd !== undefined && comparablePath(copy.cwd) !== comparablePath(generated)) kept.push(field);
      continue;
    }
    if (PLUGIN_MCP_OVERRIDE_MAP_FIELDS.includes(field)) {
      const copyMap = isPlainObject(copy[field]) ? copy[field] : {};
      const declaredMap = isPlainObject(form[field]) ? form[field] : {};
      if (copy[field] !== undefined && !isPlainObject(copy[field])) kept.push(field);
      // A removed declared entry cannot be expressed as an added override.
      else if (Object.keys(declaredMap).some((name) => !Object.hasOwn(copyMap, name))) kept.push(field);
      const added = {};
      for (const [name, value] of Object.entries(copyMap)) {
        if (field === 'env' && LEGACY_ENV_KEYS.has(name)) continue;
        if (!isDeepStrictEqual(value, declaredMap[name])) added[name] = value;
      }
      if (Object.keys(added).length) out[field] = added;
      continue;
    }
    if (isDeepStrictEqual(copy[field], form[field])) continue;
    if (PLUGIN_MCP_OVERRIDE_VALUE_FIELDS.includes(field) && Object.hasOwn(copy, field)) out[field] = copy[field];
    else kept.push(field);
  }
  if (!kept.length) return { overrides: out };
  const fields = [...new Set(kept)].map((field) => `"${field}"`).join(', ');
  return { reason: `its ${fields} differ from the plugin declaration in a way a plugin server override cannot keep` };
}

// Declared key a copy stands for, or a reason it cannot be told apart.
function copyKey(name, copy, plugin, declared) {
  const base = legacyServerName(plugin);
  const keys = declared.servers.map((server) => server.key);
  if (!keys.length) return { reason: 'the plugin declares no MCP servers' };
  if (name === base) {
    if (keys.length === 1) return { key: keys[0] };
    const matches = declared.servers.filter((server) => sameTransport(copy, server.config, plugin.root));
    return matches.length === 1 ? { key: matches[0].key } : { reason: 'it matches none or several declared servers' };
  }
  if (name.startsWith(`${base}--`)) {
    const key = name.slice(base.length + 2);
    return keys.includes(key) ? { key } : { reason: `the plugin no longer declares "${key}"` };
  }
  return { reason: `its name does not follow the plugin's naming (${base})` };
}

/**
 * Adoption of server copies made by the earlier enable action. A copy is
 * adopted only when its `env.MIXDOG_PLUGIN_ROOT` is a registered plugin's root
 * AND its name follows that plugin's earlier naming; it then leaves
 * `mcpServers` and its name, disabled state and user-added connection values
 * become that server's intent. Everything else stays untouched with a warning.
 * Pure and idempotent: an already-adopted config yields an empty plan.
 */
function planCopyAdoption(userServers, intents, declared) {
  // A present declaration wins over a missing one sharing its root, in any order.
  const byRoot = new Map();
  for (const d of declared) {
    const root = comparablePath(d.plugin.root);
    if (!d.missing || !byRoot.has(root)) byRoot.set(root, d);
  }
  const next = structuredClone(intents);
  const removed = [];
  const warnings = [];
  // Copies of a registered plugin that cannot be adopted: left as configured
  // (their own transport is honored) but still bound to the plugin's lifecycle.
  const owned = new Map();
  for (const [name, copy] of Object.entries(userServers)) {
    const marker = isPlainObject(copy) && isPlainObject(copy.env) ? clean(copy.env.MIXDOG_PLUGIN_ROOT) : '';
    if (!marker) continue;
    const owner = byRoot.get(comparablePath(marker));
    const leave = (reason) =>
      warnings.push({ name, message: `"${name}" looks like a plugin MCP copy but was left as configured: ${reason}` });
    if (!owner) {
      leave(`no registered plugin has root ${marker}`);
      continue;
    }
    // A registered plugin whose directory is gone still owns its copies, so
    // its disablement and project scopes keep applying; nothing is adopted.
    if (owner.missing) {
      owned.set(name, { d: owner, key: name });
      leave(`plugin root ${marker} is missing`);
      continue;
    }
    const { key, reason } = copyKey(name, copy, owner.plugin, owner);
    owned.set(name, { d: owner, key: key || name });
    if (!key) {
      leave(reason);
      continue;
    }
    const id = owner.plugin.id;
    const stored = next[id]?.[key];
    if (stored?.alias && stored.alias !== name) {
      leave(`plugin server "${key}" already keeps the name "${stored.alias}"`);
      continue;
    }
    const declaration = owner.servers.find((server) => server.key === key).config;
    const changes = copyOverrides(copy, declaration, owner.plugin.root);
    if (!changes.overrides) {
      leave(changes.reason);
      continue;
    }
    const disabled = copy.enabled === false || (copy._mixdogPluginDisabled === true && owner.plugin.enabled !== false);
    const declaredOn = declaration.enabled !== false;
    next[id] = {
      ...(next[id] || {}),
      [key]: {
        alias: name,
        ...(disabled === declaredOn ? { enabled: !disabled } : {}),
        ...changes.overrides,
        ...(stored || {}),
      },
    };
    removed.push(name);
    owned.delete(name);
  }
  return { removed, intents: next, warnings, owned };
}

function declarationsOf(plugins) {
  return plugins.map((plugin) => {
    const root = clean(plugin.root);
    if (!root || plugin.exists === false) {
      return {
        plugin,
        missing: true,
        format: 'none',
        servers: [],
        errors: [{ message: `plugin root not found: ${root}` }],
      };
    }
    try {
      return { plugin, ...loadPluginMcpDeclarations(root) };
    } catch (error) {
      return {
        plugin,
        format: 'none',
        servers: [],
        errors: [{ source: root, message: `cannot read MCP declarations${error?.code ? ` (${error.code})` : ''}` }],
      };
    }
  });
}

/** Names for every declared server: configured servers keep theirs, then kept
 *  aliases, then generated names in registry order; a later claimant of a taken
 *  name gets a deterministic suffix and a warning. */
function assignNames(userNames, declared, intents) {
  const claimedBy = new Map(userNames.map((name) => [name, null]));
  const names = new Map();
  const warnings = new Map();
  // Slots running under a generated collision name that is not yet kept.
  const unpinned = new Set();
  const slots = declared.flatMap((d) => d.servers.map((server) => ({ d, server, id: d.plugin.id })));
  const claim = (slot, name) => {
    claimedBy.set(name, slot.id);
    names.set(slot, name);
  };
  const conflict = (wanted) => {
    const holder = claimedBy.get(wanted);
    return holder === null ? 'a configured MCP server' : `plugin "${holder}"`;
  };
  for (const slot of slots) {
    const alias = intents[slot.id]?.[slot.server.key]?.alias;
    if (!alias) continue;
    if (claimedBy.has(alias)) warnings.set(slot, [`kept name "${alias}" is taken by ${conflict(alias)}`]);
    else claim(slot, alias);
  }
  for (const slot of slots) {
    if (names.has(slot)) continue;
    const base = pluginMcpServerBaseName(slot.id, slot.server.key);
    if (!claimedBy.has(base)) {
      claim(slot, base);
      continue;
    }
    const name = disambiguatedName(base, slot.id, slot.server.key, claimedBy);
    warnings.set(slot, [
      ...(warnings.get(slot) || []),
      `name "${base}" is taken by ${conflict(base)}; using "${name}"`,
    ]);
    claim(slot, name);
    if (!intents[slot.id]?.[slot.server.key]?.alias) unpinned.add(slot);
  }
  // A kept name standing in for a generated one that someone else holds still
  // reports the conflict.
  for (const slot of slots) {
    const name = names.get(slot);
    const base = pluginMcpServerBaseName(slot.id, slot.server.key);
    if (warnings.has(slot) || name === base || !claimedBy.has(base) || claimedBy.get(base) === slot.id) continue;
    if (name === intents[slot.id]?.[slot.server.key]?.alias) {
      warnings.set(slot, [`name "${base}" is taken by ${conflict(base)}; keeping "${name}"`]);
    }
  }
  return { slots, names, warnings, unpinned };
}

function withIntentOverrides(config, intent) {
  const out = { ...config };
  for (const field of PLUGIN_MCP_OVERRIDE_MAP_FIELDS) {
    if (intent?.[field]) out[field] = { ...(isPlainObject(out[field]) ? out[field] : {}), ...intent[field] };
  }
  for (const field of PLUGIN_MCP_OVERRIDE_VALUE_FIELDS) {
    if (intent && Object.hasOwn(intent, field)) out[field] = intent[field];
  }
  return out;
}

/** Launchable config of one plugin server for a runtime whose session cwd is `cwd`. */
function resolveServerConfig({ plugin, format, server, intent, cwd, dataDir, platform }) {
  const root = clean(plugin.root);
  const data = dataDir ? join(dataDir, 'plugins', 'data', plugin.id) : '';
  const { enabled: _declaredEnabled, ...declared } = server.config;
  const cfg = resolvePluginPlaceholders(withIntentOverrides(declared, intent), { root, data, platform });
  const stdio = declaredMcpTransport(cfg) === 'stdio';
  let cwdDependent = false;
  if (stdio) {
    const declaredCwd = typeof cfg.cwd === 'string' ? cfg.cwd.trim() : '';
    if (declaredCwd) {
      cfg.cwd = isAbsolute(declaredCwd) || declaredCwd.startsWith('${') ? declaredCwd : resolve(root, declaredCwd);
    } else if (format === 'mixdog') {
      cfg.cwd = root;
    } else {
      cwdDependent = true;
      if (cwd) cfg.cwd = cwd;
      else delete cfg.cwd;
    }
    cfg.env = { ...pluginServerEnv({ root, data }), ...(isPlainObject(cfg.env) ? cfg.env : {}) };
  }
  return {
    ...cfg,
    // Unset variables without a default fail a plugin server instead of
    // launching it with empty values; MCP roots follow the session cwd.
    _mixdogStrictEnv: true,
    _mixdogRootsFollowScope: true,
    _mixdogPlugin: { id: plugin.id, key: server.key, format, root, source: server.source, data, cwdDependent },
  };
}

/**
 * The effective MCP server set: the user's configured servers plus the servers
 * every registered plugin declares (disabled ones included, `enabled: false`).
 * `plugins` is the registry list in registration order.
 */
export function resolveMcpServerCatalog({ config, plugins = [], cwd = '', dataDir = '', platform = process.platform }) {
  const configured = isPlainObject(config?.mcpServers) ? config.mcpServers : {};
  const declared = declarationsOf(plugins.filter((plugin) => clean(plugin?.id)));
  const adoption = planCopyAdoption(configured, normalizePluginMcpIntents(config?.pluginMcp), declared);
  const removed = new Set(adoption.removed);
  const servers = {};
  const sources = {};
  const entries = {};
  const warnings = [...adoption.warnings];
  for (const [name, cfg] of Object.entries(configured)) {
    if (removed.has(name)) continue;
    const ownedBy = adoption.owned.get(name);
    const entryWarnings = adoption.warnings.filter((w) => w.name === name).map((w) => w.message);
    sources[name] = 'config';
    if (!ownedBy) {
      servers[name] = { ...cfg, ...(cfg?._mixdogPluginDisabled === true ? { enabled: false } : {}) };
      entries[name] = { owner: null, warnings: entryWarnings };
      continue;
    }
    const { plugin, format } = ownedBy.d;
    const pluginEnabled = plugin.enabled !== false;
    const serverEnabled = !(cfg.enabled === false || (cfg._mixdogPluginDisabled === true && pluginEnabled));
    const marker = {
      id: plugin.id,
      key: ownedBy.key,
      format,
      root: clean(plugin.root),
      source: 'config',
      data: '',
      cwdDependent: false,
    };
    servers[name] = { ...cfg, enabled: pluginEnabled && serverEnabled, _mixdogPlugin: marker };
    entries[name] = {
      owner: { kind: 'plugin', ...marker, name: clean(plugin.name) || plugin.id },
      pluginEnabled,
      serverEnabled,
      declaredEnabled: true,
      warnings: entryWarnings,
    };
  }
  const {
    slots,
    names,
    warnings: nameWarnings,
    unpinned,
  } = assignNames(Object.keys(servers), declared, adoption.intents);
  const pluginRows = {};
  for (const d of declared) {
    pluginRows[d.plugin.id] = {
      id: d.plugin.id,
      name: clean(d.plugin.name) || d.plugin.id,
      enabled: d.plugin.enabled !== false,
      format: d.format,
      errors: d.errors,
      servers: [],
      ...(d.missing ? { missing: true } : {}),
    };
  }
  for (const slot of slots) {
    const { d, server, id } = slot;
    const name = names.get(slot);
    const intent = adoption.intents[id]?.[server.key];
    const pluginEnabled = d.plugin.enabled !== false;
    // A declaration may ship a server off by default; the user's intent wins.
    const declaredEnabled = server.config.enabled !== false;
    const serverEnabled = typeof intent?.enabled === 'boolean' ? intent.enabled : declaredEnabled;
    const cfg = resolveServerConfig({ plugin: d.plugin, format: d.format, server, intent, cwd, dataDir, platform });
    cfg.enabled = pluginEnabled && serverEnabled;
    servers[name] = cfg;
    sources[name] = 'plugin';
    entries[name] = {
      owner: { kind: 'plugin', ...cfg._mixdogPlugin, name: pluginRows[id].name },
      pluginEnabled,
      serverEnabled,
      declaredEnabled,
      ...(unpinned.has(slot) ? { unpinned: true } : {}),
      warnings: nameWarnings.get(slot) || [],
    };
    for (const message of entries[name].warnings) warnings.push({ name, plugin: id, message });
    pluginRows[id].servers.push(name);
  }
  return {
    servers,
    sources,
    entries,
    plugins: pluginRows,
    warnings,
    adoption: adoption.removed.length ? { removed: adoption.removed, intents: adoption.intents } : null,
  };
}

/** `config` with adopted copies removed from `mcpServers` and their intent recorded. */
export function withAdoptedCopies(config, adoption) {
  if (!adoption) return config;
  const mcpServers = { ...(config.mcpServers || {}) };
  for (const name of adoption.removed) delete mcpServers[name];
  return { ...config, mcpServers, pluginMcp: adoption.intents };
}

/** `config` (already carrying `catalog`'s adoption) with every plugin server
 *  that runs under a generated collision name keeping that name, so it does
 *  not flip back (changing its tool names and name-keyed scopes) once the
 *  conflicting server goes away. Returns `config` itself when nothing changes. */
export function withPinnedCollisionNames(config, catalog) {
  let next = config;
  for (const [name, entry] of Object.entries(catalog?.entries || {})) {
    if (!entry?.unpinned || !entry.owner) continue;
    next = withPluginServerIntent(next, entry.owner.id, entry.owner.key, (intent) => ({ ...intent, alias: name }));
  }
  return next;
}

/** `config` with one plugin server's intent replaced by `update(intent)`. */
export function withPluginServerIntent(config, pluginId, key, update) {
  const intents = normalizePluginMcpIntents(config.pluginMcp);
  const servers = { ...(intents[pluginId] || {}) };
  const next = normalizePluginMcpIntents({ [pluginId]: { [key]: update({ ...(servers[key] || {}) }) } })[pluginId]?.[
    key
  ];
  if (next) servers[key] = next;
  else delete servers[key];
  if (Object.keys(servers).length) intents[pluginId] = servers;
  else delete intents[pluginId];
  return { ...config, pluginMcp: intents };
}

/** `config` without any intent recorded for `pluginId`. */
export function withoutPluginIntents(config, pluginId) {
  const intents = normalizePluginMcpIntents(config.pluginMcp);
  if (!intents[pluginId]) return config;
  delete intents[pluginId];
  return { ...config, pluginMcp: intents };
}

/** Create a plugin server's data directory; runs just before it connects. */
export function ensurePluginServerData(cfg) {
  const data = cfg?._mixdogPlugin?.data;
  if (data) mkdirSync(data, { recursive: true });
}
