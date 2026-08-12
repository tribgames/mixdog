import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateJsonAtomic } from '../../shared/atomic-file.mjs'
import { resolveProjectScope } from './project-id-resolver.mjs'

export const CORE_MEMORY_FILE_VERSION = 1
export const CORE_MEMORY_FILE_NAME = 'core-memory.json'

const reservedRevisions = new Map()

function filePath(dataDir) {
  return join(dataDir, CORE_MEMORY_FILE_NAME)
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeProjectId(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function normalizeCuratedEntry(row) {
  const summary = String(row?.summary || '').replace(/\s+/g, ' ').trim()
  if (!summary) return null
  return {
    id: finiteNumber(row?.id),
    summary,
    projectId: normalizeProjectId(row?.projectId ?? row?.project_id),
    updatedAt: finiteNumber(row?.updatedAt ?? row?.updated_at),
  }
}

function normalizeGeneratedEntry(row) {
  const summary = String(row?.summary ?? row?.core_summary ?? '').replace(/\s+/g, ' ').trim()
  if (!summary) return null
  return {
    summary,
    projectId: normalizeProjectId(row?.projectId ?? row?.project_id),
    score: finiteNumber(row?.score),
    lastSeenAt: finiteNumber(row?.lastSeenAt ?? row?.last_seen_at),
  }
}

function normalizeSnapshot(snapshot = {}) {
  return {
    curated: (Array.isArray(snapshot.curated) ? snapshot.curated : [])
      .map(normalizeCuratedEntry)
      .filter(Boolean),
    generated: (Array.isArray(snapshot.generated) ? snapshot.generated : [])
      .map(normalizeGeneratedEntry)
      .filter(Boolean),
  }
}

export function readCoreMemoryFile(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(filePath(dataDir), 'utf8'))
    if (parsed?.version !== CORE_MEMORY_FILE_VERSION) return null
    const snapshot = normalizeSnapshot(parsed)
    return {
      version: CORE_MEMORY_FILE_VERSION,
      revision: Math.max(0, finiteNumber(parsed.revision)),
      updatedAt: Math.max(0, finiteNumber(parsed.updatedAt)),
      ...snapshot,
    }
  } catch {
    return null
  }
}

function reserveRevision(dataDir) {
  const path = filePath(dataDir)
  const diskRevision = readCoreMemoryFile(dataDir)?.revision || 0
  const revision = Math.max(diskRevision, reservedRevisions.get(path) || 0) + 1
  reservedRevisions.set(path, revision)
  return revision
}

export async function writeCoreMemoryFileSnapshot(dataDir, snapshot, { revision = reserveRevision(dataDir), now = Date.now() } = {}) {
  const normalized = normalizeSnapshot(snapshot)
  const requestedRevision = Math.max(1, finiteNumber(revision, 1))
  const result = await updateJsonAtomic(filePath(dataDir), (current) => {
    const currentRevision = Math.max(0, finiteNumber(current?.revision))
    // A slower refresh may finish after a newer one. Never let its older PG
    // snapshot overwrite the newer file.
    if (current?.version === CORE_MEMORY_FILE_VERSION && currentRevision >= requestedRevision) {
      return undefined
    }
    return {
      version: CORE_MEMORY_FILE_VERSION,
      revision: requestedRevision,
      updatedAt: finiteNumber(now, Date.now()),
      ...normalized,
    }
  }, { secret: true, compact: true })
  return {
    revision: Math.max(0, finiteNumber(result?.revision)),
    written: finiteNumber(result?.revision) === requestedRevision,
  }
}

export async function refreshCoreMemoryFile(db, dataDir) {
  // Reserve before querying: if concurrent refreshes complete out of order,
  // the atomic revision guard rejects the stale result.
  const revision = reserveRevision(dataDir)
  const [curatedResult, generatedResult] = await Promise.all([
    db.query(`
      SELECT id, summary, project_id, updated_at
      FROM core_entries
      WHERE status IS NULL OR status = 'active'
      ORDER BY project_id NULLS FIRST, id ASC
    `),
    db.query(`
      SELECT core_summary, project_id, score, last_seen_at
      FROM (
        SELECT core_summary, project_id, score, last_seen_at,
               ROW_NUMBER() OVER (
                 PARTITION BY project_id
                 ORDER BY score DESC, last_seen_at DESC
               ) AS scope_rank
        FROM entries
        WHERE is_root = 1
          AND status = 'active'
          AND core_summary IS NOT NULL
      ) ranked
      WHERE scope_rank <= 40
      ORDER BY project_id NULLS FIRST, scope_rank ASC
    `),
  ])
  return await writeCoreMemoryFileSnapshot(dataDir, {
    curated: curatedResult?.rows || [],
    generated: generatedResult?.rows || [],
  }, { revision })
}

export function readSessionCoreMemoryPayload(dataDir, cwd) {
  const file = readCoreMemoryFile(dataDir)
  if (!file) return null
  const projectId = resolveProjectScope(typeof cwd === 'string' && cwd ? cwd : null)
  const inScope = (entry) => entry.projectId === null || entry.projectId === projectId
  const curated = file.curated
    .filter(inScope)
    .sort((a, b) => {
      if (a.projectId === null && b.projectId !== null) return -1
      if (a.projectId !== null && b.projectId === null) return 1
      return a.id - b.id
    })
  const generated = file.generated
    .filter(inScope)
    .sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
  return {
    projectId,
    revision: file.revision,
    userLines: curated.map((entry) => entry.summary),
    dbLines: generated.map((entry) => entry.summary),
  }
}
