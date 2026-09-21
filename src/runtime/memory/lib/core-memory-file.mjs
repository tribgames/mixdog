import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonAtomic } from '../../shared/atomic-file.mjs';
import { resolveProjectScope } from './project-id-resolver.mjs';
import { indexedCoreRecord, syncCoreMemoryIndexes } from './core-memory-index.mjs';

const CORE_MEMORY_FILE_VERSION = 1;
const CORE_MEMORY_FILE_NAME = 'core-memory.json';

const reservedRevisions = new Map();

function filePath(dataDir) {
  return join(dataDir, CORE_MEMORY_FILE_NAME);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeProjectId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeSummary(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatCuratedCoreMemoryLine(row) {
  const summary = normalizeSummary(row?.summary);
  if (!summary) return '';
  const id = Number(row?.id);
  const scope = row?.project_id ?? row?.projectId ?? 'common';
  const version = row?.index_revision ?? row?.indexRevision;
  return Number.isInteger(id) && id > 0 && version
    ? `[project=${scope} id=${id} index_revision=${version}] ${summary}`
    : summary;
}

function normalizeCuratedEntry(row) {
  const summary = normalizeSummary(row?.summary);
  if (!summary) return null;
  return {
    id: finiteNumber(row?.id),
    indexRevision: row?.indexRevision ?? row?.index_revision ?? null,
    summary,
    projectId: normalizeProjectId(row?.projectId ?? row?.project_id),
    updatedAt: finiteNumber(row?.updatedAt ?? row?.updated_at),
  };
}

function normalizeSnapshot(snapshot = {}) {
  return {
    curated: (Array.isArray(snapshot.curated) ? snapshot.curated : []).map(normalizeCuratedEntry).filter(Boolean),
  };
}

export function readCoreMemoryFile(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(filePath(dataDir), 'utf8'));
    if (parsed?.version !== CORE_MEMORY_FILE_VERSION) return null;
    const snapshot = normalizeSnapshot(parsed);
    return {
      version: CORE_MEMORY_FILE_VERSION,
      revision: Math.max(0, finiteNumber(parsed.revision)),
      updatedAt: Math.max(0, finiteNumber(parsed.updatedAt)),
      ...snapshot,
    };
  } catch {
    return null;
  }
}

function reserveRevision(dataDir) {
  const path = filePath(dataDir);
  const diskRevision = readCoreMemoryFile(dataDir)?.revision || 0;
  const revision = Math.max(diskRevision, reservedRevisions.get(path) || 0) + 1;
  reservedRevisions.set(path, revision);
  return revision;
}

export async function writeCoreMemoryFileSnapshot(
  dataDir,
  snapshot,
  { revision = reserveRevision(dataDir), now = Date.now() } = {}
) {
  const normalized = normalizeSnapshot(snapshot);
  const requestedRevision = Math.max(1, finiteNumber(revision, 1));
  const result = await updateJsonAtomic(
    filePath(dataDir),
    (current) => {
      const currentRevision = Math.max(0, finiteNumber(current?.revision));
      // A slower refresh may finish after a newer one. Never let its older PG
      // snapshot overwrite the newer file.
      if (current?.version === CORE_MEMORY_FILE_VERSION && currentRevision >= requestedRevision) {
        return undefined;
      }
      return {
        version: CORE_MEMORY_FILE_VERSION,
        revision: requestedRevision,
        updatedAt: finiteNumber(now, Date.now()),
        ...normalized,
      };
    },
    { secret: true, compact: true }
  );
  return {
    revision: Math.max(0, finiteNumber(result?.revision)),
    written: finiteNumber(result?.revision) === requestedRevision,
  };
}

export async function refreshCoreMemoryFile(db, dataDir) {
  // Reserve before querying: if concurrent refreshes complete out of order,
  // the atomic revision guard rejects the stale result.
  const revision = reserveRevision(dataDir);
  const directory = await syncCoreMemoryIndexes(db);
  const curatedResult = await db.query(`
      SELECT id, summary, project_id, updated_at
      FROM core_entries
      WHERE status IS NULL OR status = 'active'
      ORDER BY project_id NULLS FIRST, id ASC
    `);
  return await writeCoreMemoryFileSnapshot(
    dataDir,
    {
      curated: (curatedResult?.rows || []).map((row) => indexedCoreRecord(row, directory)),
    },
    { revision }
  );
}

export function readSessionCoreMemoryPayload(dataDir, cwd) {
  const file = readCoreMemoryFile(dataDir);
  if (!file) return null;
  const projectId = resolveProjectScope(typeof cwd === 'string' && cwd ? cwd : null);
  const inScope = (entry) => entry.projectId === null || entry.projectId === projectId;
  const curated = file.curated.filter(inScope).sort((a, b) => {
    if (a.projectId === null && b.projectId !== null) return -1;
    if (a.projectId !== null && b.projectId === null) return 1;
    return a.id - b.id;
  });
  return {
    projectId,
    revision: file.revision,
    userLines: curated.map(formatCuratedCoreMemoryLine).filter(Boolean),
    // Generated records remain searchable; activation is not consent to
    // install a standing instruction in every new session.
    dbLines: [],
  };
}
