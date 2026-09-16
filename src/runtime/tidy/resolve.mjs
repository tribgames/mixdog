// Engine resolution. Fixed order, first hit wins:
//   1. project config  .mixdog/tidy.json {engines:{<id>:{command,args,cwd?}}}
//   2. project-local   node_modules/.bin, .venv/{bin,Scripts}, venv/{bin,Scripts}
//   3. PATH
//   4. managed         <pluginData>/tools/<id>/<version>/<binPath>
// Anything still unresolved is reported as source:'missing' with an installHint.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_CATALOG, ENGINE_IDS, engineEntry, enginesForLanguages } from './engines.mjs';
import { mapLimit, runProcess, which } from './process.mjs';
import { managedEngineBinary, manifestAsset, readEnginesManifest } from './install.mjs';

export const DOWNLOAD_POLICIES = Object.freeze(['ask', 'auto', 'never']);
export const DEFAULT_DOWNLOAD_POLICY = 'ask';
export const TIDY_CONFIG_RELATIVE_PATH = '.mixdog/tidy.json';
const VERSION_PROBE_TIMEOUT_MS = 5000;

/** Read `.mixdog/tidy.json`; a malformed file is reported, never thrown. */
export function readTidyConfig(cwd) {
  const path = join(cwd, '.mixdog', 'tidy.json');
  if (!existsSync(path)) return { engines: {}, policy: {}, path, present: false, error: '' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const engines = parsed?.engines && typeof parsed.engines === 'object' ? parsed.engines : {};
    const policy = parsed?.policy && typeof parsed.policy === 'object' ? parsed.policy : {};
    return { engines, policy, path, present: true, error: '' };
  } catch (error) {
    return { engines: {}, policy: {}, path, present: true, error: `cannot read ${TIDY_CONFIG_RELATIVE_PATH}: ${error?.message || error}` };
  }
}

/**
 * Effective download policy. Project config wins over the environment override,
 * an unknown value falls back to the default and is reported.
 */
export function resolveDownloadPolicy(config, env = process.env) {
  const fromEnv = String(env.MIXDOG_TIDY_DOWNLOADS || '').trim().toLowerCase();
  const fromConfig = String(config?.policy?.downloads || '').trim().toLowerCase();
  const chosen = fromConfig || fromEnv;
  if (!chosen) return { downloads: DEFAULT_DOWNLOAD_POLICY, source: 'default' };
  if (!DOWNLOAD_POLICIES.includes(chosen)) {
    return {
      downloads: DEFAULT_DOWNLOAD_POLICY,
      source: 'default',
      warning: `tidy.downloads "${chosen}" is not one of ${DOWNLOAD_POLICIES.join(', ')}; using ${DEFAULT_DOWNLOAD_POLICY}`,
    };
  }
  return { downloads: chosen, source: fromConfig ? 'project-config' : 'env' };
}

const VENV_DIRS = ['.venv', 'venv'];
const VENV_BIN_DIRS = process.platform === 'win32' ? ['Scripts', 'bin'] : ['bin', 'Scripts'];
const WINDOWS_BIN_SUFFIXES = ['.exe', '.cmd', '.bat', ''];

function binNames(name) {
  return process.platform === 'win32' ? WINDOWS_BIN_SUFFIXES.map((suffix) => `${name}${suffix}`) : [name];
}

function firstExisting(dir, name) {
  for (const candidate of binNames(name)) {
    const full = join(dir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Project-local lookup for one engine (node_modules/.bin and virtualenvs). */
export function projectLocalBinary(cwd, entry) {
  const roots = entry.projectLocal || [];
  for (const root of roots) {
    if (root === 'node') {
      const found = firstExisting(join(cwd, 'node_modules', '.bin'), entry.bin);
      if (found) return found;
    }
    if (root === 'venv') {
      for (const venv of VENV_DIRS) {
        for (const binDir of VENV_BIN_DIRS) {
          const found = firstExisting(join(cwd, venv, binDir), entry.bin);
          if (found) return found;
        }
      }
    }
  }
  return null;
}

/** Which of an engine's marker config files the project already has. */
export function projectConfigFileFor(cwd, entry) {
  for (const file of entry.configFiles || []) {
    if (existsSync(join(cwd, file))) return file;
  }
  const toml = entry.tomlConfig;
  if (toml) {
    const path = join(cwd, toml.file);
    try {
      if (existsSync(path) && readFileSync(path, 'utf8').includes(toml.section)) return toml.file;
    } catch { /* unreadable config is treated as absent */ }
  }
  return null;
}

function pathBinary(entry, env) {
  for (const name of [entry.bin, ...(entry.altBins || [])]) {
    const found = which(name, { env });
    if (found) return { path: found, bin: name };
  }
  return null;
}

function commandFor(entry, path) {
  // `zig fmt` / `dart format` / `mix format` / `dotnet format` are one engine
  // reached through a subcommand; the catalog carries the argv prefix.
  const extra = Array.isArray(entry.command) ? entry.command.slice(1) : [];
  return { command: path, args: extra };
}

function resolveOne({ cwd, entry, config, env, manifest, pluginData }) {
  const base = {
    id: entry.id,
    kind: entry.kind,
    languages: entry.languages,
    installHint: entry.installHint,
  };
  const configured = config.engines?.[entry.id];
  if (configured && typeof configured === 'object' && typeof configured.command === 'string' && configured.command) {
    return {
      ...base,
      source: 'project-config',
      path: configured.command,
      command: configured.command,
      args: Array.isArray(configured.args) ? configured.args.map(String) : [],
      ...(typeof configured.cwd === 'string' && configured.cwd ? { cwd: configured.cwd } : {}),
    };
  }
  const local = projectLocalBinary(cwd, entry);
  if (local) return { ...base, source: 'project-local', path: local, ...commandFor(entry, local) };
  if (entry.projectLocalOnly) {
    return { ...base, source: 'missing', path: '', missing: true };
  }
  const onPath = pathBinary(entry, env);
  if (onPath) return { ...base, source: 'path', path: onPath.path, ...commandFor(entry, onPath.path) };
  if (entry.managed && pluginData) {
    const managed = managedEngineBinary({ id: entry.id, manifest, pluginData });
    if (managed) {
      return { ...base, source: 'managed', path: managed.path, command: managed.path, args: [], version: managed.version };
    }
  }
  // Installable means "this platform has an asset", not merely "the manifest
  // knows this engine": clang-format ships no linux-arm64 build, and promising
  // a download there would turn into a failed install instead of an installHint.
  const installable = Boolean(entry.managed) && Boolean(manifestAsset(manifest, entry.id));
  return { ...base, source: 'missing', path: '', missing: true, ...(installable ? { installable: true } : {}) };
}

async function probeVersion(engine, signal) {
  const entry = engineEntry(engine.id);
  const args = [...(engine.args || []), ...(entry?.versionArgs || ['--version'])];
  const result = await runProcess(engine.command, args, {
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    signal,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const match = text.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-zA-Z.]+)?/);
  return match ? match[0] : '';
}

/**
 * Resolve every engine that can touch the requested languages.
 * Returns the resolved list (including `missing` entries with hints), the
 * effective download policy, and the project config that produced them.
 *
 * With neither `languages` nor `engineIds` there is nothing to resolve: a scope
 * that holds no tracked file of a known language must not probe the whole
 * catalog just to report engines nothing can use.
 */
export async function resolveEngines({
  cwd,
  languages = [],
  engineIds = [],
  pluginData = '',
  manifest = null,
  env = process.env,
  probeVersions = true,
  signal = null,
} = {}) {
  const config = readTidyConfig(cwd);
  const policy = resolveDownloadPolicy(config, env);
  const loadedManifest = manifest || readEnginesManifest();
  const requested = engineIds.length > 0
    ? engineIds.filter((id) => ENGINE_IDS.includes(id))
    : (languages.length > 0 ? enginesForLanguages(languages) : []);
  const unknown = engineIds.filter((id) => !ENGINE_IDS.includes(id));

  const resolved = requested.map((id) => {
    const entry = ENGINE_CATALOG[id];
    const result = resolveOne({ cwd, entry, config, env, manifest: loadedManifest, pluginData });
    const configFile = projectConfigFileFor(cwd, entry);
    if (configFile) result.configFile = configFile;
    if (entry.requiresConfig && !configFile && result.source !== 'project-config') {
      result.skipped = 'no project config for this engine';
    }
    if (entry.toolchain) result.toolchain = true;
    return result;
  });

  // A project driving Prettier/ESLint from node_modules/.bin keeps them: Biome
  // stands down rather than reformatting against the project's own config.
  const byId = new Map(resolved.map((engine) => [engine.id, engine]));
  for (const engine of resolved) {
    const suppressors = (ENGINE_CATALOG[engine.id].suppressedBy || [])
      .filter((id) => byId.get(id)?.source === 'project-local' || byId.get(id)?.source === 'project-config');
    if (suppressors.length > 0 && !engine.missing) {
      engine.suppressedBy = suppressors;
      engine.skipped = `project uses ${suppressors.join(' + ')}`;
    }
  }

  if (probeVersions) {
    const runnable = resolved.filter((engine) => !engine.missing && engine.command);
    const versions = await mapLimit(runnable, 4, (engine) => (
      engine.version ? engine.version : probeVersion(engine, signal).catch(() => '')
    ));
    runnable.forEach((engine, index) => {
      const version = versions[index];
      if (version) engine.version = version;
    });
  }

  return {
    engines: resolved,
    policy: {
      downloads: policy.downloads,
      source: policy.source,
      ...(policy.warning ? { warning: policy.warning } : {}),
    },
    config: {
      path: TIDY_CONFIG_RELATIVE_PATH,
      present: config.present,
      ...(config.error ? { error: config.error } : {}),
    },
    ...(unknown.length ? { unknownEngines: unknown } : {}),
  };
}

/** Engines that can actually run: resolved, not suppressed, not config-gated. */
export function runnableEngines(engines) {
  return (engines || []).filter((engine) => !engine.missing && !engine.skipped);
}
