// Engine shadowing: a binary carrying an engine's name that tidy does NOT run.
//
// Nothing here changes resolution — resolve.mjs still decides which engine
// runs. This is the report that stops a caller from mistaking a same-named
// command for the engine that produced the findings: with no project-local
// Biome, `biome` on PATH or `npx biome` runs whatever the environment happens
// to provide (on one machine an unrelated package published as `biome`), while
// tidy runs the managed Biome under <pluginData>/tools. Both answer to the same
// name, so both paths and both versions are reported — and a shadow is never an
// error, only something the caller has to see.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineEntry } from './engines.mjs';
import { mapLimit, runProcess, which } from './process.mjs';
import { firstExisting, parseVersionText } from './resolve.mjs';

const VERSION_PROBE_TIMEOUT_MS = 5000;
// The npx cache holds one directory per package npm ever ran through `npx`;
// both the scan and the report stay bounded regardless of how full it is.
const NPX_CACHE_DIRS_MAX = 40;
const SHADOW_CAP = 8;
const PROBE_CONCURRENCY = 4;

function samePath(left, right) {
  const a = String(left || '').replaceAll('\\', '/');
  const b = String(right || '').replaceAll('\\', '/');
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** npm's `_npx` cache: where `npx <name>` finds a package it already fetched. */
function npxCacheRoot(env) {
  const configured = String(env.npm_config_cache || '').trim();
  if (configured) return join(configured, '_npx');
  if (process.platform === 'win32') {
    const local = String(env.LOCALAPPDATA || '').trim();
    return local ? join(local, 'npm-cache', '_npx') : '';
  }
  const home = String(env.HOME || '').trim() || homedir();
  return home ? join(home, '.npm', '_npx') : '';
}

function npxCacheBinDirs(env) {
  const root = npxCacheRoot(env);
  if (!root || !existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .slice(0, NPX_CACHE_DIRS_MAX)
    .map((entry) => join(root, entry.name, 'node_modules', '.bin'));
}

// An engine's accepted host names are interchangeable (PSScriptAnalyzer runs
// under pwsh or powershell), so when one of them IS the binary tidy uses, none
// of them shadows it. Otherwise the name resolves to something else, and the
// hit a caller would reach — the first one, as in resolve.mjs — is the shadow.
function candidatesFor(entry, engine, env, npxDirs) {
  const found = [];
  const hostHits = [entry.bin, ...(entry.altBins || [])].map((name) => which(name, { env })).filter(Boolean);
  const usedOnPath = hostHits.some((hit) => usesPath(engine, hit));
  if (!usedOnPath && hostHits.length > 0) found.push({ via: 'path', path: hostHits[0] });
  for (const dir of npxDirs) {
    const hit = firstExisting(dir, entry.bin);
    if (hit && !usesPath(engine, hit)) found.push({ via: 'npx-cache', path: hit });
  }
  return found;
}

function usesPath(engine, candidate) {
  return samePath(engine.path, candidate) || samePath(engine.command, candidate);
}

/** `<bin> --version`, reported as '' when the binary answers with nothing. */
async function probeBinaryVersion(binPath, signal = null) {
  const result = await runProcess(binPath, ['--version'], { timeoutMs: VERSION_PROBE_TIMEOUT_MS, signal });
  return parseVersionText(`${result.stdout}\n${result.stderr}`);
}

/**
 * Same-named binaries that are not the engine tidy uses.
 * `engines` are resolved rows from resolveEngines; a row whose own path or
 * command is the candidate is the engine itself, never its own shadow. Missing
 * engines still report shadows: "nothing tidy runs" is exactly the case where a
 * stray binary of that name gets mistaken for the engine.
 */
export async function detectEngineShadows({ engines = [], env = process.env, signal = null, probe = null } = {}) {
  const npxDirs = npxCacheBinDirs(env);
  const found = [];
  for (const engine of engines) {
    const entry = engineEntry(engine.id);
    if (!entry?.bin) continue;
    for (const candidate of candidatesFor(entry, engine, env, npxDirs)) {
      if (found.some((row) => row.id === engine.id && samePath(row.path, candidate.path))) continue;
      found.push({ id: engine.id, bin: entry.bin, engine, ...candidate });
    }
  }
  const rows = found.slice(0, SHADOW_CAP);
  const probeVersion = probe || probeBinaryVersion;
  const versions = await mapLimit(rows, PROBE_CONCURRENCY, (row) => probeVersion(row.path, signal).catch(() => ''));
  return rows.map((row, index) => ({
    id: row.id,
    bin: row.bin,
    via: row.via,
    shadow: { path: row.path, version: versions[index] },
    engine: {
      source: row.engine.source,
      ...(row.engine.path ? { path: row.engine.path } : {}),
      ...(row.engine.version ? { version: row.engine.version } : {}),
    },
  }));
}

function describe(path, version) {
  return version ? `${path} (${version})` : `${path} (version unknown)`;
}

/** One note per shadow, so the confusion is visible without reading `shadows`. */
export function shadowNote(row) {
  const route = row.via === 'path' ? 'PATH' : 'npx cache';
  const engine = row.engine.path
    ? `tidy runs ${row.engine.source} ${describe(row.engine.path, row.engine.version)}`
    : `tidy has no ${row.id} (${row.engine.source})`;
  return `${row.bin} on ${route} is ${describe(row.shadow.path, row.shadow.version)}, not the ${row.id} tidy uses: ${engine}; output from that binary says nothing about this report`;
}
