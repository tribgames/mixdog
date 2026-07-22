import { __mixdogMemoryLog } from './memory-log.mjs';

import fs from 'node:fs'
import path from 'node:path'
import { mixdogHome } from '../../shared/plugin-paths.mjs'

function normalizeBackfillWindow(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['none', 'off', 'disabled', '0'].includes(normalized)) return 'none'
  if (['1d', '1day', '1-day', '1 day', 'day', 'today'].includes(normalized)) return '1d'
  if (['3d', '3days', '3-day', '3 day'].includes(normalized)) return '3d'
  if (['7d', '7days', '7-day', '7 day', 'week'].includes(normalized)) return '7d'
  if (['30d', '30days', '30-day', '30 day', 'month'].includes(normalized)) return '30d'
  return 'all'
}

function normalizeBackfillScope(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['workspace', 'project', 'current'].includes(normalized)) return 'workspace'
  return 'all'
}

export function resolveBackfillSinceMs(windowValue, now = Date.now()) {
  const normalized = normalizeBackfillWindow(windowValue)
  if (normalized === '1d') return now - (1 * 24 * 60 * 60 * 1000)
  if (normalized === '3d') return now - (3 * 24 * 60 * 60 * 1000)
  if (normalized === '7d') return now - (7 * 24 * 60 * 60 * 1000)
  if (normalized === '30d') return now - (30 * 24 * 60 * 60 * 1000)
  return null
}

export async function countUnclassified(db) {
  if (!db) return 0
  try {
    const row = (await db.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`, [])).rows[0]
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}

export function selectBackfillTranscripts({ sinceMs = null, limit = null, projectsRoot = null } = {}) {
  const root = projectsRoot || path.join(mixdogHome(), 'projects')
  if (!fs.existsSync(root)) return []
  const files = []
  for (const d of fs.readdirSync(root)) {
    if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
    const full = path.join(root, d)
    try {
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
        const fp = path.join(full, f)
        let mtime
        try { mtime = fs.statSync(fp).mtimeMs } catch { continue }
        if (sinceMs != null && mtime < sinceMs) continue
        files.push({ path: fp, mtime })
      }
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const capped = (limit != null && Number(limit) > 0) ? files.slice(0, Number(limit)) : files
  return capped.map(f => f.path).reverse()
}

const FULL_BACKFILL_MAX_ITERS = 30
const BACKFILL_CONCURRENCY = 3

export async function runFullBackfill(db, {
  window = '7d',
  scope = 'all',
  limit = null,
  config = {},
  dataDir = null,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
  runCycle1,
  runCycle2,
  now = Date.now(),
  projectsRoot = null,
} = {}) {
  if (typeof ingestTranscriptFile !== 'function') {
    throw new Error('runFullBackfill: ingestTranscriptFile required')
  }
  if (typeof runCycle1 !== 'function' || typeof runCycle2 !== 'function') {
    throw new Error('runFullBackfill: runCycle1/runCycle2 required')
  }

  const normalizedWindow = normalizeBackfillWindow(window)
  const normalizedScope = normalizeBackfillScope(scope)
  const sinceMs = resolveBackfillSinceMs(normalizedWindow, now)
  const selected = selectBackfillTranscripts({ sinceMs, limit, projectsRoot })

  let ingested = 0
  let cursor = 0
  const workers = Array.from({ length: BACKFILL_CONCURRENCY }, async () => {
    while (cursor < selected.length) {
      const idx = cursor++
      const fp = selected[idx]
      try {
        const cwd = typeof cwdFromTranscriptPath === 'function' ? cwdFromTranscriptPath(fp) : undefined
        const n = Number(await ingestTranscriptFile(fp, { cwd }) ?? 0)
        ingested += n
      } catch (err) {
        __mixdogMemoryLog(`[backfill] ingest failed (${fp}): ${err.message}\n`)
      }
    }
  })
  await Promise.all(workers)

  let cycle1Iters = 0
  let prevUnclassified = await countUnclassified(db)
  while (prevUnclassified > 0 && cycle1Iters < FULL_BACKFILL_MAX_ITERS) {
    let result
    try {
      result = await runCycle1(db, config?.cycle1 || {}, {}, dataDir)
    } catch (err) {
      __mixdogMemoryLog(`[backfill] cycle1 error (iter=${cycle1Iters}): ${err.message}\n`)
      break
    }
    cycle1Iters += 1
    if (Number(result?.processed ?? 0) === 0) break
    const nextUnclassified = await countUnclassified(db)
    if (nextUnclassified >= prevUnclassified) break
    prevUnclassified = nextUnclassified
  }

  let promoted = 0
  try {
    const c2 = await runCycle2(db, config?.cycle2 || {}, {}, dataDir)
    promoted = Number(c2?.promoted ?? 0)
  } catch (err) {
    __mixdogMemoryLog(`[backfill] cycle2 error: ${err.message}\n`)
  }

  const unclassified = await countUnclassified(db)
  return {
    window: normalizedWindow,
    scope: normalizedScope,
    files: selected.length,
    ingested,
    cycle1_iters: cycle1Iters,
    promoted,
    unclassified,
  }
}
