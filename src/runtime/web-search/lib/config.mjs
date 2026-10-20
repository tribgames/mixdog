import fs from 'node:fs';
import path from 'node:path';
import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readJsonStateSync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs';

// Unified mode: web search shares the plugin data dir with the rest of mixdog.
const SHARED_DATA_DIR = resolvePluginData();
if (!SHARED_DATA_DIR)
  throw new Error('[web-search-config] resolvePluginData() returned falsy — plugin data dir not configured');
export const DATA_DIR = SHARED_DATA_DIR;
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json');
export const CACHE_PATH = path.join(DATA_DIR, 'cache.local.json');

export const DEFAULT_CONFIG = {
  requestTimeoutMs: 120000,
};

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// usage/cache state: a damaged file (empty, NUL-filled, truncated) is kept as
// <file>.corrupt-<ts> and reads as `fallback`, so search/fetch keep working.
export function readJson(filePath, fallback) {
  return readJsonStateSync(filePath, { fallback });
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomicSync(filePath, value, { lock: true, fsyncDir: true });
}

export function loadConfig() {
  ensureDataDir();
  return { ...DEFAULT_CONFIG };
}

export function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs;
}
