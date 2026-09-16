// Code Tidy's one-click install and the status the desktop card renders.
//
// The CORE set is what "Install" provisions: the managed engines that cover the
// languages tidy is expected to clean up out of the box. Everything else in the
// catalog stays demand-driven (the `tidy` tool installs per project) or belongs
// to a language toolchain the user owns.
//
// Only installCoreEngines touches the network, through install.mjs. Status is a
// pure resolution against the manifest, PATH, and the managed tools dir — it
// never downloads. Install progress lives in ONE module-level in-memory job,
// like the local-provider installation status the desktop already polls; it is
// never persisted and a fresh process starts with no job.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENGINE_CATALOG, ENGINE_IDS } from './engines.mjs';
import {
  installEngines as installEnginesImpl,
  managedEngineDir,
  managedToolsDir,
  manifestAsset,
  readEnginesManifest,
} from './install.mjs';
import { which } from './process.mjs';
import { probeHostManagedModule, resolveEngines as resolveEnginesImpl } from './resolve.mjs';

/** The engines the built-in install provisions. ast-grep/structural is NOT
 *  here: it ships inside the mixdog-graph binary, not as a managed engine. */
export const TIDY_CORE_ENGINE_IDS = Object.freeze(['biome', 'ruff', 'shfmt', 'shellcheck', 'psscriptanalyzer']);

/** Status/install resolution is project-free: no cwd config, no node_modules,
 *  no virtualenv. The managed tools dir is a real directory that holds none of
 *  those, so resolution sees exactly the manifest, PATH, and managed installs. */
function resolutionScope(toolsDir) {
  return toolsDir || join(tmpdir(), 'mixdog-tidy-status');
}

function dirBytes(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirBytes(full);
      continue;
    }
    try {
      total += statSync(full).size;
    } catch {
      /* a file that vanished mid-walk contributes nothing */
    }
  }
  return total;
}

/** On-disk size of one installed managed engine version, 0 when absent. */
export function managedEngineBytes(pluginData, id, version) {
  if (!pluginData || !version) return 0;
  const dir = managedEngineDir(pluginData, id, version);
  return existsSync(dir) ? dirBytes(dir) : 0;
}

/** PSScriptAnalyzer is a PowerShell module: without a host there is nothing to
 *  install it into, so the core install skips it with its host hint. */
function powerShellHost(env) {
  const entry = ENGINE_CATALOG.psscriptanalyzer;
  for (const name of [entry.bin, ...(entry.altBins || [])]) {
    if (which(name, { env })) return true;
  }
  return false;
}

let installJob = null;
let installInFlight = null;
// Bumped on every job mutation and every refreshed host-module probe, so the
// status cache can never serve an inventory older than what changed it.
let statusStamp = 0;

// The card polls status while an install runs. Resolution walks the whole
// catalog, so one short-lived memo keeps a 500ms poll off the filesystem, and
// any install state change invalidates it through statusStamp.
const STATUS_CACHE_TTL_MS = 2_000;
let statusCache = null;

// PSScriptAnalyzer's version needs a PowerShell host (~700ms). A poll must
// never wait for that: serve the cached value (empty until the first probe
// lands) and refresh in the background once it goes stale.
const HOST_MODULE_PROBE_TTL_MS = 60_000;
let hostModuleCache = new Map();

function refreshHostModule(key, engine) {
  const entry = hostModuleCache.get(key) || { version: '', at: 0, refreshing: false };
  if (entry.refreshing) return;
  entry.refreshing = true;
  hostModuleCache.set(key, entry);
  void probeHostManagedModule(engine, null)
    .catch(() => '')
    .then((version) => {
      // The caller's request is long gone; publish for the next poll instead.
      hostModuleCache.set(key, { version: version || '', at: Date.now(), refreshing: false });
      statusStamp += 1;
    });
}

/** Non-blocking host-module probe for the status path. */
async function cachedHostModuleProbe(engine) {
  const key = String(engine?.command || '');
  if (!key) return '';
  const entry = hostModuleCache.get(key);
  if (!entry || Date.now() - entry.at >= HOST_MODULE_PROBE_TTL_MS) refreshHostModule(key, engine);
  return entry?.version || '';
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function recomputePercent(job) {
  const share = job.engines.length > 0 ? 100 / job.engines.length : 100;
  let percent = 0;
  for (const engine of job.engines) {
    if (engine.status === 'pending') continue;
    if (engine.status === 'downloading') {
      if (engine.totalBytes > 0) percent += share * Math.min(1, engine.receivedBytes / engine.totalBytes);
      continue;
    }
    percent += share;
  }
  const rounded = clampPercent(percent);
  // A running job never claims 100: the marker and the card flip on completion.
  job.percent = job.active ? Math.min(99, rounded) : rounded;
  job.updatedAt = Date.now();
}

function startJob(ids) {
  installJob = {
    active: true,
    percent: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    engines: ids.map((id) => ({ id, status: 'pending', receivedBytes: 0, totalBytes: 0, version: '', bytes: 0 })),
  };
  statusStamp += 1;
  return installJob;
}

function jobEngine(job, id) {
  return job.engines.find((engine) => engine.id === id) || null;
}

function settleEngine(job, id, update) {
  const engine = jobEngine(job, id);
  if (!engine) return;
  Object.assign(engine, update);
  recomputePercent(job);
}

function trackDownload(job, { id, receivedBytes, totalBytes }) {
  const engine = jobEngine(job, id);
  if (!engine || engine.status === 'installed' || engine.status === 'failed') return;
  engine.status = 'downloading';
  engine.receivedBytes = Number(receivedBytes) || 0;
  engine.totalBytes = Number(totalBytes) || 0;
  recomputePercent(job);
}

/** The live (or last) install job, or null when this process never installed.
 *  Poll-friendly: a plain snapshot, no listeners, no persistence. */
export function tidyInstallStatus() {
  if (!installJob) return null;
  return {
    active: installJob.active,
    percent: installJob.percent,
    startedAt: installJob.startedAt,
    updatedAt: installJob.updatedAt,
    engines: installJob.engines.map((engine) => ({ ...engine })),
  };
}

/** Test seam: drop the in-memory job and the status caches so a case starts
 *  from "never installed" with nothing memoized. */
export function resetTidyInstallStatus() {
  installJob = null;
  installInFlight = null;
  statusStamp += 1;
  statusCache = null;
  inventoryRefreshing = false;
  hostModuleCache = new Map();
}

function engineResult(engine) {
  return {
    id: engine.id,
    version: engine.version || '',
    status: engine.status,
    bytes: engine.bytes || 0,
    ...(engine.error ? { error: engine.error } : {}),
    ...(engine.installHint ? { installHint: engine.installHint } : {}),
  };
}

/**
 * Install the CORE managed engine set for the built-in feature.
 *
 * Never throws and never aborts the set for one engine: each engine ends as
 * installed / present (already there, host or managed) / skipped (nothing to
 * download on this host) / failed (with its error). The caller marks the
 * feature installed either way — the tool works, the card shows what failed.
 */
async function runCoreInstall({
  pluginData = '',
  manifest = null,
  env = process.env,
  fetchFn = globalThis.fetch,
  signal = null,
  installEngines = installEnginesImpl,
  resolveEngines = resolveEnginesImpl,
} = {}) {
  const loaded = manifest || readEnginesManifest();
  const toolsDir = pluginData ? managedToolsDir(pluginData) : '';
  const job = startJob(TIDY_CORE_ENGINE_IDS);
  try {
    const resolution = await resolveEngines({
      cwd: resolutionScope(toolsDir),
      engineIds: [...TIDY_CORE_ENGINE_IDS],
      pluginData,
      manifest: loaded,
      env,
      probeVersions: false,
      signal,
    });
    const resolved = new Map((resolution.engines || []).map((engine) => [engine.id, engine]));
    const pending = [];
    for (const id of TIDY_CORE_ENGINE_IDS) {
      const catalog = ENGINE_CATALOG[id];
      const engine = resolved.get(id);
      if (id === 'psscriptanalyzer' && !powerShellHost(env)) {
        settleEngine(job, id, { status: 'skipped', installHint: catalog.hostInstallHint || catalog.installHint });
        continue;
      }
      if (engine && !engine.missing) {
        settleEngine(job, id, {
          status: 'present',
          version: engine.version || '',
          bytes: engine.source === 'managed' ? managedEngineBytes(pluginData, id, engine.version) : 0,
        });
        continue;
      }
      if (!manifestAsset(loaded, id)) {
        settleEngine(job, id, { status: 'skipped', installHint: catalog.installHint });
        continue;
      }
      pending.push(id);
    }
    if (pending.length > 0) {
      // An explicit Install is the approval: policy gating exists for the
      // model-driven tool path, not for a button the user just pressed.
      const outcome = await installEngines({
        ids: pending,
        manifest: loaded,
        pluginData,
        policy: 'auto',
        approveDownloads: true,
        fetchFn,
        signal,
        onProgress: (progress) => trackDownload(job, progress),
      });
      for (const item of outcome.installed || []) {
        settleEngine(job, item.id, {
          status: item.status === 'present' ? 'present' : 'installed',
          version: item.version || '',
          bytes: managedEngineBytes(pluginData, item.id, item.version),
        });
      }
      for (const failure of outcome.errors || []) {
        const error = String(failure.error || 'install failed');
        const hint = failure.installHint ? { installHint: failure.installHint } : {};
        // installEngines reports set-wide problems (no data dir) as id '*'.
        const targets = jobEngine(job, failure.id)
          ? [failure.id]
          : job.engines.filter((engine) => engine.status === 'pending').map((engine) => engine.id);
        for (const id of targets) settleEngine(job, id, { status: 'failed', error, ...hint });
      }
    }
    for (const engine of job.engines) {
      if (engine.status === 'pending' || engine.status === 'downloading') {
        settleEngine(job, engine.id, { status: 'failed', error: 'the installer reported no result for this engine' });
      }
    }
  } catch (error) {
    const message = String(error?.message || error);
    for (const engine of job.engines) {
      if (engine.status === 'pending' || engine.status === 'downloading') {
        settleEngine(job, engine.id, { status: 'failed', error: message });
      }
    }
  } finally {
    // The only place a job stops being active: engine throws, an aborted
    // signal, and the happy path all land here.
    job.active = false;
    recomputePercent(job);
    // Engines moved on disk: the next status poll must rebuild, not serve the
    // inventory from before the install. Byte progress never invalidates it.
    statusStamp += 1;
  }
  return { toolsDir, engines: job.engines.map(engineResult) };
}

/**
 * Single-flight wrapper around the core install. Two overlapping Install
 * presses (or a setup-tool call racing the desktop card) must share ONE job
 * and one download per engine, not fetch the whole set twice; every caller
 * observes the same job through tidyInstallStatus() and the same result.
 */
export function installTidyCoreEngines(options = {}) {
  if (installInFlight) return installInFlight;
  installInFlight = runCoreInstall(options).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

function statusSource(source) {
  if (source === 'managed') return 'managed';
  if (source === 'missing') return 'missing';
  return 'host';
}

/**
 * The Code Tidy card's inventory: every catalog engine with where it resolves
 * from, plus the live install job.
 *
 * This is a POLLED read (the card refreshes while an install runs), so it
 * never downloads and never spawns: no `--version` runs, and the PowerShell
 * module probe is served from its background-refreshed cache. The inventory
 * itself is memoized for STATUS_CACHE_TTL_MS and invalidated by any install
 * state change; `installing` is always the live in-memory job.
 */
export async function tidyEngineStatus({
  pluginData = '',
  manifest = null,
  env = process.env,
  probeVersions = false,
  signal = null,
  resolveEngines = resolveEnginesImpl,
} = {}) {
  const args = { pluginData, manifest, env, probeVersions, signal, resolveEngines };
  const key = `${pluginData}|${probeVersions ? 1 : 0}|${statusStamp}`;
  const entry =
    statusCache && statusCache.key === key && statusCache.manifestArg === manifest && statusCache.env === env
      ? statusCache
      : null;
  if (entry) {
    // Aged out, not invalidated: answer the poll from the memo and rebuild
    // behind it. An install state change moves the key instead, which forces
    // the synchronous rebuild below — a finished install is never served from
    // the inventory that predates it.
    if (Date.now() - entry.at >= STATUS_CACHE_TTL_MS) refreshInventory(key, args);
    return withInstallStatus(entry.inventory);
  }
  const inventory = await buildEngineInventory(args);
  statusCache = { key, manifestArg: manifest, env, at: Date.now(), inventory };
  return withInstallStatus(inventory);
}

let inventoryRefreshing = false;

function refreshInventory(key, args) {
  if (inventoryRefreshing) return;
  inventoryRefreshing = true;
  const stamp = statusStamp;
  // Resolution walks PATH synchronously until its first await, so hand the
  // poll its answer first and rebuild on a later tick.
  const scheduled = new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  });
  void scheduled
    .then(() => buildEngineInventory(args))
    .then((inventory) => {
      // An install that landed mid-rebuild wins: its own poll rebuilds.
      if (statusStamp !== stamp) return;
      statusCache = { key, manifestArg: args.manifest, env: args.env, at: Date.now(), inventory };
    })
    .catch(() => {
      /* the next poll retries */
    })
    .finally(() => {
      inventoryRefreshing = false;
    });
}

function withInstallStatus(inventory) {
  return {
    toolsDir: inventory.toolsDir,
    core: [...inventory.core],
    engines: inventory.engines.map((engine) => ({ ...engine })),
    installing: tidyInstallStatus(),
  };
}

async function buildEngineInventory({ pluginData, manifest, env, probeVersions, signal, resolveEngines }) {
  const loaded = manifest || readEnginesManifest();
  const toolsDir = pluginData ? managedToolsDir(pluginData) : '';
  const resolution = await resolveEngines({
    cwd: resolutionScope(toolsDir),
    engineIds: [...ENGINE_IDS],
    pluginData,
    manifest: loaded,
    env,
    probeVersions,
    hostModuleProbe: cachedHostModuleProbe,
    signal,
  });
  const resolved = new Map((resolution.engines || []).map((engine) => [engine.id, engine]));
  const engines = ENGINE_IDS.map((id) => {
    const catalog = ENGINE_CATALOG[id];
    const engine = resolved.get(id) || { source: 'missing', missing: true };
    const source = statusSource(engine.source);
    const version = engine.version || '';
    const installHint = engine.installHint || catalog.installHint || '';
    return {
      id,
      title: catalog.title || id,
      languages: [...catalog.languages],
      kind: [...catalog.kind],
      version,
      source,
      managed: catalog.managed === true,
      core: TIDY_CORE_ENGINE_IDS.includes(id),
      toolchain: catalog.toolchain === true,
      // Managed engines carry their on-disk cost; a host binary is the user's.
      ...(source === 'managed' ? { bytes: managedEngineBytes(pluginData, id, version) } : {}),
      ...(source === 'missing' && installHint ? { installHint } : {}),
    };
  });
  return { toolsDir, core: [...TIDY_CORE_ENGINE_IDS], engines };
}
