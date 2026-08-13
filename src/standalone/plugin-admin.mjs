import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  withFileLockSync,
  writeJsonAtomicSync,
} from '../runtime/shared/atomic-file.mjs';
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

function loadRegistry(dataDir = resolvePluginData()) {
  const path = registryPath(dataDir);
  if (!existsSync(path)) return { version: REGISTRY_VERSION, plugins: [] };
  const raw = readJsonSafe(path);
  if (raw && Array.isArray(raw.plugins)) return raw;
  throw new Error(`plugin registry is corrupt: ${path}`);
}

function mutateRegistry(dataDir, mutator) {
  const path = registryPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${path}.lock`, () => {
    const registry = loadRegistry(dataDir);
    const result = mutator(registry);
    writeJsonAtomicSync(path, {
      version: REGISTRY_VERSION,
      plugins: Array.isArray(registry.plugins) ? registry.plugins : [],
    }, {
      lock: false,
      secret: true,
      fsyncDir: true,
    });
    return result;
  }, { secret: true });
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
    if (/^http:\/\//i.test(source)) {
      throw new Error('plugin Git URLs must use HTTPS or SSH');
    }
    if (/^(https|ssh):\/\//i.test(source)) {
      let parsed;
      try {
        parsed = new URL(source);
      } catch {
        throw new Error('plugin Git URL is invalid');
      }
      if (parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
        throw new Error('plugin Git URLs must not contain credentials');
      }
    }
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

function pluginIndex(registry, key) {
  return registry.plugins.findIndex((plugin) =>
    plugin.id === key || plugin.name === key || plugin.title === key);
}

function withPluginMutation(dataDir, id, operation) {
  const root = installRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return withFileLockSync(join(root, `.${normalizePluginId(id) || 'plugin'}.mutation.lock`), operation, {
    secret: true,
    timeoutMs: 130_000,
    staleMs: 10 * 60_000,
  });
}

function cleanupManagedPartials(root) {
  const parent = dirname(root);
  const prefix = `${basename(root)}.tmp-`;
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix)) continue;
    try { rmSync(join(parent, entry), { recursive: true, force: true }); } catch {}
  }
}

function recoverManagedPluginRoot(root) {
  const backupRoot = `${root}.backup`;
  if (!existsSync(root) && existsSync(backupRoot)) {
    renameSync(backupRoot, root);
  } else if (existsSync(root) && existsSync(backupRoot)) {
    rmSync(backupRoot, { recursive: true, force: true });
  }
  return backupRoot;
}

export function _publishManagedPluginRoot(root, tempRoot) {
  const backupRoot = recoverManagedPluginRoot(root);
  let previousMoved = false;
  try {
    if (existsSync(root)) {
      renameSync(root, backupRoot);
      previousMoved = true;
    }
    renameSync(tempRoot, root);
  } catch (error) {
    if (!existsSync(root) && previousMoved && existsSync(backupRoot)) {
      try {
        renameSync(backupRoot, root);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `plugin publish and rollback both failed for ${root}`,
        );
      }
    }
    throw error;
  }
  try { rmSync(backupRoot, { recursive: true, force: true }); } catch {}
}

function materializePlugin(normalized, id, dataDir) {
  const root = join(installRoot(dataDir), id);
  if (normalized.type === 'local') {
    return { root: normalized.path, managed: false };
  }
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  recoverManagedPluginRoot(root);
  cleanupManagedPartials(root);
  const tempRoot = `${root}.tmp-${process.pid}-${randomUUID()}`;
  try {
    runGit(['clone', '--depth', '1', normalized.url, tempRoot]);
    _publishManagedPluginRoot(root, tempRoot);
  } catch (error) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    throw error;
  } finally {
    cleanupManagedPartials(root);
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
  const initial = loadRegistry(dataDir);
  const initialExisting = initial.plugins.find((plugin) =>
    plugin.id === id || clean(plugin.source) === clean(normalized.displaySource));
  const lockId = initialExisting?.id || id;
  return withPluginMutation(dataDir, lockId, () => {
    const currentRegistry = loadRegistry(dataDir);
    const existing = currentRegistry.plugins.find((plugin) =>
      plugin.id === id || clean(plugin.source) === clean(normalized.displaySource));
    if (existing) return updatePluginLocked(existing, dataDir);
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
    return mutateRegistry(dataDir, (registry) => {
      const duplicate = registry.plugins.findIndex((plugin) =>
        plugin.id === id || clean(plugin.source) === clean(normalized.displaySource));
      if (duplicate >= 0) {
        entry.installedAt = registry.plugins[duplicate].installedAt || entry.installedAt;
        registry.plugins[duplicate] = entry;
      } else {
        registry.plugins.push(entry);
      }
      return enrichEntry(entry);
    });
  });
}

function updatePluginLocked(current, dataDir) {
  if (current.sourceType === 'local' || current.managed === false) {
    return mutateRegistry(dataDir, (registry) => {
      const index = registry.plugins.findIndex((plugin) => plugin.id === current.id);
      if (index < 0) throw new Error(`plugin not registered: ${current.id}`);
      const next = { ...enrichEntry(registry.plugins[index]), updatedAt: nowIso() };
      registry.plugins[index] = next;
      return next;
    });
  }
  const normalized = normalizeSource(current.url || current.source);
  const materialized = materializePlugin(normalized, current.id, dataDir);
  return mutateRegistry(dataDir, (registry) => {
    const index = registry.plugins.findIndex((plugin) => plugin.id === current.id);
    if (index < 0) throw new Error(`plugin not registered: ${current.id}`);
    const next = enrichEntry({
      ...registry.plugins[index],
      root: materialized.root,
      managed: materialized.managed,
      updatedAt: nowIso(),
    });
    registry.plugins[index] = next;
    return next;
  });
}

export function updatePlugin(idOrName, { dataDir = resolvePluginData() } = {}) {
  const key = clean(idOrName);
  if (!key) throw new Error('plugin id/name is required');
  const initial = loadRegistry(dataDir);
  const index = pluginIndex(initial, key);
  if (index < 0) throw new Error(`plugin not registered: ${key}`);
  const id = initial.plugins[index].id;
  return withPluginMutation(dataDir, id, () => {
    const registry = loadRegistry(dataDir);
    const currentIndex = registry.plugins.findIndex((plugin) => plugin.id === id);
    if (currentIndex < 0) throw new Error(`plugin not registered: ${key}`);
    return updatePluginLocked(registry.plugins[currentIndex], dataDir);
  });
}

export function removePlugin(idOrName, { dataDir = resolvePluginData() } = {}) {
  const key = clean(idOrName);
  if (!key) throw new Error('plugin id/name is required');
  const initial = loadRegistry(dataDir);
  const index = pluginIndex(initial, key);
  if (index < 0) throw new Error(`plugin not registered: ${key}`);
  const id = initial.plugins[index].id;
  return withPluginMutation(dataDir, id, () => {
    const entry = mutateRegistry(dataDir, (registry) => {
      const currentIndex = registry.plugins.findIndex((plugin) => plugin.id === id);
      if (currentIndex < 0) throw new Error(`plugin not registered: ${key}`);
      return registry.plugins.splice(currentIndex, 1)[0];
    });
    if (entry.managed !== false && entry.root) {
      ensureInside(installRoot(dataDir), entry.root);
      rmSync(entry.root, { recursive: true, force: true });
      rmSync(`${entry.root}.backup`, { recursive: true, force: true });
      cleanupManagedPartials(entry.root);
    }
    return { ...entry, removed: true };
  });
}

export function pluginAdminStatus({ dataDir = resolvePluginData() } = {}) {
  return {
    registryPath: registryPath(dataDir),
    installRoot: installRoot(dataDir),
    plugins: listRegisteredPlugins({ dataDir }),
  };
}
