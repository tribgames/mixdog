import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

const REGISTRY_VERSION = 1;

function clean(value) {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function pluginBaseDir(dataDir = resolvePluginData()) {
  return join(dataDir, 'plugins');
}

function registryPath(dataDir = resolvePluginData()) {
  return join(pluginBaseDir(dataDir), 'registry.json');
}

function installRoot(dataDir = resolvePluginData()) {
  return join(pluginBaseDir(dataDir), 'installed');
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function loadRegistry(dataDir = resolvePluginData()) {
  const path = registryPath(dataDir);
  const raw = readJsonSafe(path);
  if (raw && Array.isArray(raw.plugins)) return raw;
  return { version: REGISTRY_VERSION, plugins: [] };
}

function saveRegistry(registry, dataDir = resolvePluginData()) {
  const next = {
    version: REGISTRY_VERSION,
    plugins: Array.isArray(registry?.plugins) ? registry.plugins : [],
  };
  writeJson(registryPath(dataDir), next);
  return next;
}

function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

function displayNameFromUrl(url) {
  const value = clean(url).replace(/\\/g, '/').replace(/\/+$/, '');
  const last = value.split('/').filter(Boolean).pop() || 'plugin';
  return last.replace(/\.git$/i, '') || 'plugin';
}

function normalizePluginId(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function stableIdForSource(source) {
  const name = normalizePluginId(displayNameFromUrl(source));
  const hash = createHash('sha1').update(clean(source)).digest('hex').slice(0, 8);
  return `${name || 'plugin'}-${hash}`;
}

function normalizeSource(input) {
  const source = clean(input);
  if (!source) throw new Error('plugin URL/path is required');
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return {
      type: 'git',
      url: `https://github.com/${source}.git`,
      displaySource: source,
    };
  }
  if (/^(https?:\/\/|git@|ssh:\/\/).+\.git(?:#.+)?$/i.test(source) || /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(source)) {
    return {
      type: 'git',
      url: source.replace(/\/$/g, '').replace(/^(https:\/\/github\.com\/[^/]+\/[^/.]+)$/i, '$1.git'),
      displaySource: source,
    };
  }
  const localPath = source.replace(/^~(?=$|[\\/])/, homedir());
  const resolved = resolve(localPath);
  if (existsSync(resolved)) {
    return { type: 'local', path: resolved, displaySource: resolved };
  }
  throw new Error('plugin source must be a Git URL, owner/repo, or existing local path');
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120000,
  });
  if (result.status !== 0) {
    const detail = clean(result.stderr) || clean(result.stdout) || `git ${args.join(' ')} failed`;
    throw new Error(detail);
  }
  return clean(result.stdout);
}

function ensureInside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  if (c !== p && !c.startsWith(`${p}\\`) && !c.startsWith(`${p}/`)) {
    throw new Error(`refusing to modify plugin path outside registry root: ${child}`);
  }
}

function materializePlugin(normalized, id, dataDir) {
  const root = join(installRoot(dataDir), id);
  if (normalized.type === 'local') {
    return { root: normalized.path, managed: false };
  }
  const tempRoot = `${root}.tmp-${Date.now()}`;
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  try {
    runGit(['clone', '--depth', '1', normalized.url, tempRoot]);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    renameSync(tempRoot, root);
  } catch (error) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return { root, managed: true };
}

function enrichEntry(entry) {
  const root = clean(entry.root);
  const manifest = root && existsSync(root) ? pluginManifest(root) : {};
  const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || displayNameFromUrl(entry.source);
  return {
    ...entry,
    name,
    title: clean(manifest.title) || clean(manifest.displayName) || clean(entry.title) || name,
    version: clean(manifest.version) || clean(entry.version) || null,
    description: clean(manifest.description) || clean(entry.description),
    exists: Boolean(root && existsSync(root)),
  };
}

export function listRegisteredPlugins({ dataDir = resolvePluginData() } = {}) {
  const registry = loadRegistry(dataDir);
  return registry.plugins.map(enrichEntry);
}

export function addPlugin(sourceInput, { dataDir = resolvePluginData(), name } = {}) {
  const normalized = normalizeSource(sourceInput);
  const id = stableIdForSource(normalized.displaySource || normalized.url || normalized.path);
  const registry = loadRegistry(dataDir);
  const existing = registry.plugins.find((p) => p.id === id || clean(p.source) === clean(normalized.displaySource));
  if (existing) return updatePlugin(existing.id, { dataDir });
  const materialized = materializePlugin(normalized, id, dataDir);
  const manifest = pluginManifest(materialized.root);
  const entry = {
    id,
    source: normalized.displaySource,
    url: normalized.url || null,
    sourceType: normalized.type,
    root: materialized.root,
    managed: materialized.managed,
    name: clean(name) || clean(manifest.name) || clean(manifest.id) || displayNameFromUrl(normalized.displaySource),
    title: clean(manifest.title) || clean(manifest.displayName) || clean(name) || displayNameFromUrl(normalized.displaySource),
    version: clean(manifest.version) || null,
    description: clean(manifest.description),
    installedAt: nowIso(),
    updatedAt: nowIso(),
  };
  registry.plugins = [...registry.plugins, entry];
  saveRegistry(registry, dataDir);
  return enrichEntry(entry);
}

export function updatePlugin(idOrName, { dataDir = resolvePluginData() } = {}) {
  const key = clean(idOrName);
  if (!key) throw new Error('plugin id/name is required');
  const registry = loadRegistry(dataDir);
  const index = registry.plugins.findIndex((p) => p.id === key || p.name === key || p.title === key);
  if (index < 0) throw new Error(`plugin not registered: ${key}`);
  const current = registry.plugins[index];
  if (current.sourceType === 'local' || current.managed === false) {
    const next = { ...enrichEntry(current), updatedAt: nowIso() };
    registry.plugins[index] = next;
    saveRegistry(registry, dataDir);
    return next;
  }
  const normalized = normalizeSource(current.url || current.source);
  const materialized = materializePlugin(normalized, current.id, dataDir);
  const next = {
    ...current,
    root: materialized.root,
    managed: materialized.managed,
    updatedAt: nowIso(),
  };
  registry.plugins[index] = enrichEntry(next);
  saveRegistry(registry, dataDir);
  return registry.plugins[index];
}

export function removePlugin(idOrName, { dataDir = resolvePluginData() } = {}) {
  const key = clean(idOrName);
  if (!key) throw new Error('plugin id/name is required');
  const registry = loadRegistry(dataDir);
  const index = registry.plugins.findIndex((p) => p.id === key || p.name === key || p.title === key);
  if (index < 0) throw new Error(`plugin not registered: ${key}`);
  const [entry] = registry.plugins.splice(index, 1);
  if (entry.managed !== false && entry.root) {
    ensureInside(installRoot(dataDir), entry.root);
    rmSync(entry.root, { recursive: true, force: true });
  }
  saveRegistry(registry, dataDir);
  return { ...entry, removed: true };
}

export function pluginAdminStatus({ dataDir = resolvePluginData() } = {}) {
  return {
    registryPath: registryPath(dataDir),
    installRoot: installRoot(dataDir),
    plugins: listRegisteredPlugins({ dataDir }),
  };
}
