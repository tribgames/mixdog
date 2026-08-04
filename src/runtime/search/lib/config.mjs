import fs from 'fs'
import path from 'path'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import { renameWithRetrySync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs'
import { readSection, updateSection } from '../../shared/config.mjs'

// Unified mode: search shares the plugin data dir with the rest of mixdog.
const SHARED_DATA_DIR = resolvePluginData()
if (!SHARED_DATA_DIR) throw new Error('[search-config] resolvePluginData() returned falsy — plugin data dir not configured')
export const DATA_DIR = SHARED_DATA_DIR
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json')
export const CACHE_PATH = path.join(DATA_DIR, 'cache.local.json')

export const DEFAULT_CONFIG = {
  requestTimeoutMs: 120000,
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function ensureDataDir() {
  ensureDir(DATA_DIR)
}

export function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    try {
      return JSON.parse(raw)
    } catch (parseErr) {
      try { renameWithRetrySync(filePath, filePath + '.corrupt.' + Date.now()) } catch {}
      process.stderr.write(`[search-config] corrupt JSON backed up: ${filePath}\n`)
      throw parseErr
    }
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  writeJsonAtomicSync(filePath, value, { lock: true, fsyncDir: true })
}

export function loadConfig() {
  ensureDataDir()
  if (Object.keys(readSection('search') || {}).length > 0) {
    updateSection('search', () => undefined)
  }
  return { ...DEFAULT_CONFIG }
}

export function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs
}
