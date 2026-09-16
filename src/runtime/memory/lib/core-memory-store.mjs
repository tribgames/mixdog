import { __mixdogMemoryLog } from './memory-log.mjs';
export { __mixdogMemoryLog };

// User-curated core memory store — native PG-backed via core_entries table.
// Per-project entries distinguished by project_id column (NULL = COMMON).
// Explicit add/edit/delete operations affect only the requested entry.
// Generated conversation history never enters this store automatically.

import { getDatabase, embeddingToSql } from './memory.mjs';
import { cachedEmbedTextBatch } from './memory-embed.mjs';
import { checkedConnect } from './pg/adapter.mjs';
import { throwIfAborted } from './memory-cycle2-shared.mjs';
import { findCoreKeyRows } from './core-memory-uniqueness.mjs';

const VALID_CAT = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue']);

const CORE_ELEMENT_DERIVE_LENGTH = 40;

// Op aliases: the surface verbs are add/edit/delete/list/…, and a caller
// naming the same intent differently ("update", "remove") used to get a hard
// rejection. Only unambiguous synonyms map through.
const CORE_OP_ALIASES = {
  update: 'edit',
  modify: 'edit',
  change: 'edit',
  set: 'edit',
  create: 'add',
  new: 'add',
  insert: 'add',
  store: 'add',
  save: 'add',
  remove: 'delete',
  rm: 'delete',
  del: 'delete',
  forget: 'delete',
  show: 'list',
  get: 'list',
  read: 'list',
};
export function normalizeCoreOp(op) {
  const raw = String(op ?? '')
    .trim()
    .toLowerCase();
  return CORE_OP_ALIASES[raw] ?? raw;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function normalizeCoreInput(input = {}, options = {}) {
  // Summary aliases: the field is `summary`, but callers routinely send the
  // synonym they'd use in prose. Accepting them costs nothing and removes a
  // measured class of bounced calls.
  const summary = trimOrNull(input.summary ?? input.content ?? input.text ?? input.value ?? input.note);
  const element = trimOrNull(input.element) ?? (summary ? summary.slice(0, CORE_ELEMENT_DERIVE_LENGTH) : null);
  const suppliedCategory = trimOrNull(input.category);
  const category = (suppliedCategory ?? 'fact').toLowerCase();
  const errors = [];

  if (options.requireElement && !element) errors.push('element required');
  if (options.requireSummary && !summary) errors.push('summary required');
  if (options.requireCategory && !suppliedCategory) errors.push('category required');
  if (suppliedCategory && !VALID_CAT.has(category)) {
    errors.push(`invalid category "${category}". Valid: ${[...VALID_CAT].join(', ')}`);
  }

  return { element, summary, category, suppliedCategory, errors };
}

export function _getDb(dataDir) {
  if (!dataDir) throw new Error('core-memory: dataDir required');
  const db = getDatabase(dataDir);
  if (!db) throw new Error('core-memory: database not open — call openDatabase first');
  return db;
}

async function _embedFor(db, element, summary) {
  const text = `${element}\n${summary || ''}`.trim();
  if (!text) return null;
  const [vec] = await cachedEmbedTextBatch(db, [text]);
  return Array.isArray(vec) ? vec : null;
}

// Lazy repair of NULL embeddings on existing rows. Runs once per boot or
// whenever a NULL slips back in via direct SQL. SELECT WHERE embedding IS NULL
// returns 0 rows on a fully-populated table, so this is a fast no-op.
export { throwIfAborted };

async function _backfillNullEmbeddings(db, options = {}) {
  const signal = options?.signal;
  throwIfAborted(signal);
  // Only refill live cores; legacy archived entries stay inactive.
  const r = await db.query(
    `SELECT id, element, summary FROM core_entries WHERE embedding IS NULL AND (status IS NULL OR status = 'active')`
  );
  if (r.rows.length === 0) return 0;
  let filled = 0;
  for (const row of r.rows) {
    throwIfAborted(signal);
    const vec = await _embedFor(db, row.element, row.summary);
    throwIfAborted(signal);
    if (!vec) continue;
    await db.query(`UPDATE core_entries SET embedding = $1::halfvec WHERE id = $2 AND embedding IS NULL`, [
      embeddingToSql(vec),
      row.id,
    ]);
    filled++;
  }
  if (filled > 0) {
    __mixdogMemoryLog(`[core-memory] backfilled ${filled} NULL embedding(s) on core_entries\n`);
  }
  return filled;
}

export async function backfillCoreEmbeddings(dataDir, options = {}) {
  const db = _getDb(dataDir);
  return await _backfillNullEmbeddings(db, options);
}

// NOTE: boot-time core id compaction was REMOVED. Resequencing core_entries.id
// to 1..N rewrote primary keys that are handed out as stable `core:N`
// references, so after a restart a retained reference pointed at a different
// fact. Gaps left by deletes are the correct, permanent behavior of a surrogate
// key.

export async function listCore(dataDir, projectId = null) {
  const db = _getDb(dataDir);
  const cols = `id, element, summary, category, project_id, created_at, updated_at`;
  // Only live cores enter recall/review — archived (superseded) rows are
  // retired but retained for audit. Legacy NULL status = active.
  const live = `(status IS NULL OR status = 'active')`;
  if (projectId === '*') {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE ${live} ORDER BY project_id NULLS FIRST, id ASC`);
    return r.rows;
  }
  if (projectId === null) {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id IS NULL AND ${live} ORDER BY id ASC`);
    return r.rows;
  }
  const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id = $1 AND ${live} ORDER BY id ASC`, [
    projectId,
  ]);
  return r.rows;
}

// ── In-process mutation serialization ────────────────────────────────────────
// Queue local mutations; pool advisory locks remain the cross-process guard.
let _mutationTail = Promise.resolve();
function serializeCoreMutation(fn) {
  const run = _mutationTail.then(fn, fn);
  _mutationTail = run.catch(() => {});
  return run;
}

export function addCore(dataDir, input, projectId) {
  return serializeCoreMutation(() => _addCoreImpl(dataDir, input, projectId));
}
export function editCore(dataDir, id, patch) {
  return serializeCoreMutation(() => _editCoreImpl(dataDir, id, patch));
}
export function deleteCore(dataDir, id, options = {}) {
  return serializeCoreMutation(() => _deleteCoreImpl(dataDir, id, options));
}

async function _addCoreImpl(dataDir, input, projectId) {
  if (projectId === undefined)
    throw new Error('addCore: projectId required — pass null for COMMON pool, or slug string for scoped pool');
  const {
    element: el,
    summary: sm,
    category: cat,
    errors,
  } = normalizeCoreInput(input, {
    requireElement: true,
    requireSummary: true,
    requireCategory: true,
  });
  if (errors.length) throw new Error(errors.join('; '));
  const db = _getDb(dataDir);
  const now = Date.now();
  await _backfillNullEmbeddings(db);
  const embedding = await _embedFor(db, el, sm);

  const client = await checkedConnect(db._pool, 'memory');
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    const poolKey = `core:${projectId == null ? 'COMMON' : projectId}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey]);
    const collisions = await findCoreKeyRows(client, projectId, el);
    if (collisions.length) {
      if (collisions.length !== 1 || collisions[0].status !== 'archived') {
        throw new Error(
          `core entry already exists: project=${projectId ?? 'COMMON'} element=${JSON.stringify(el.slice(0, 200))}; use an explicit edit/delete`
        );
      }
      const revived = await client.query(
        `UPDATE core_entries SET summary = $1, category = $2, embedding = $3::halfvec,
           status = 'active', archived_at = NULL, updated_at = $4
         WHERE id = $5
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [sm, cat, embedding ? embeddingToSql(embedding) : null, now, collisions[0].id]
      );
      await client.query('COMMIT');
      return { ...revived.rows[0], revived_from_archived: true };
    }
    const r = await client.query(
      `INSERT INTO core_entries(element, summary, category, project_id, embedding, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::halfvec, $6, $7)
       RETURNING id, element, summary, category, project_id, created_at, updated_at`,
      [el, sm, cat, projectId, embedding ? embeddingToSql(embedding) : null, now, now]
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function _editCoreImpl(dataDir, id, patch) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required');
  const db = _getDb(dataDir);
  const cur = (await db.query(`SELECT * FROM core_entries WHERE id = $1`, [numId])).rows[0];
  if (!cur) throw new Error(`no entry with id=${numId}`);
  if (Object.hasOwn(patch, 'expectedProjectId') && (patch.expectedProjectId ?? null) !== (cur.project_id ?? null)) {
    throw new Error(`entry id=${numId} is not in project ${patch.expectedProjectId ?? 'COMMON'}`);
  }
  const incoming = normalizeCoreInput(patch);
  const newElement = incoming.element ?? cur.element;
  const newSummary = incoming.summary ?? cur.summary;
  const newCategory = incoming.suppliedCategory ? incoming.category : cur.category;
  const newProjectId = Object.hasOwn(patch, 'targetProjectId')
    ? (patch.targetProjectId ?? null)
    : (cur.project_id ?? null);
  const { errors } = normalizeCoreInput(
    {
      element: newElement,
      summary: newSummary,
      category: newCategory,
    },
    {
      requireElement: true,
      requireSummary: true,
      requireCategory: true,
    }
  );
  if (errors.length) throw new Error(errors.join('; '));
  if (
    newElement === cur.element &&
    newSummary === cur.summary &&
    newCategory === cur.category &&
    newProjectId === (cur.project_id ?? null)
  ) {
    throw new Error('no change');
  }
  const now = Date.now();
  const textChanged = newElement !== cur.element || newSummary !== cur.summary;
  const projectChanged = newProjectId !== (cur.project_id ?? null);
  if (!textChanged && !projectChanged) {
    // Optimistic guard on the snapshot this patch was computed against: a blind
    // UPDATE by id overwrote whatever a concurrent edit had just written.
    const res = await db.query(
      `UPDATE core_entries SET category = $1, updated_at = $2
       WHERE id = $3 AND element = $4 AND summary = $5
         AND updated_at IS NOT DISTINCT FROM $6::bigint`,
      [newCategory, now, numId, cur.element, cur.summary, cur.updated_at]
    );
    if (Number(res.rowCount ?? 0) === 0) {
      throw new Error(`core entry id=${numId} changed concurrently — re-read and retry`);
    }
    return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now };
  }

  await _backfillNullEmbeddings(db);
  const embedding = await _embedFor(db, newElement, newSummary);
  const client = await checkedConnect(db._pool, 'memory');
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    const poolKeys = [
      `core:${cur.project_id == null ? 'COMMON' : cur.project_id}`,
      `core:${newProjectId == null ? 'COMMON' : newProjectId}`,
    ].sort();
    for (const poolKey of new Set(poolKeys)) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey]);
    }
    // Revalidate under the lock. `cur` (and the embedding derived from it) was
    // read before any locking, so without this check two concurrent edits both
    // computed a patch from the same snapshot and the slower one silently
    // overwrote the newer content.
    const fresh = (await client.query(`SELECT * FROM core_entries WHERE id = $1 FOR UPDATE`, [numId])).rows[0];
    if (!fresh) throw new Error(`no entry with id=${numId}`);
    if (
      fresh.element !== cur.element ||
      fresh.summary !== cur.summary ||
      fresh.category !== cur.category ||
      (fresh.project_id ?? null) !== (cur.project_id ?? null) ||
      Number(fresh.updated_at ?? 0) !== Number(cur.updated_at ?? 0)
    ) {
      throw new Error(`core entry id=${numId} changed concurrently — re-read and retry`);
    }
    if (newElement !== cur.element || projectChanged) {
      if ((await findCoreKeyRows(client, newProjectId, newElement, numId)).length) {
        throw new Error(
          `core entry already exists: project=${newProjectId ?? 'COMMON'} element=${JSON.stringify(newElement.slice(0, 200))}`
        );
      }
    }
    await client.query(
      `UPDATE core_entries
       SET element = $1, summary = $2, category = $3, project_id = $4,
           embedding = $5::halfvec, updated_at = $6
       WHERE id = $7`,
      [newElement, newSummary, newCategory, newProjectId, embedding ? embeddingToSql(embedding) : null, now, numId]
    );
    await client.query('COMMIT');
    return {
      ...cur,
      element: newElement,
      summary: newSummary,
      category: newCategory,
      project_id: newProjectId,
      updated_at: now,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function _deleteCoreImpl(dataDir, id, options = {}) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required');
  const db = _getDb(dataDir);
  const scoped = Object.hasOwn(options, 'expectedProjectId');
  const r = scoped
    ? await db.query(`DELETE FROM core_entries WHERE id = $1 AND project_id IS NOT DISTINCT FROM $2 RETURNING *`, [
        numId,
        options.expectedProjectId,
      ])
    : await db.query(`DELETE FROM core_entries WHERE id = $1 RETURNING *`, [numId]);
  if (r.rows.length === 0) throw new Error(`no entry with id=${numId}`);
  return r.rows[0];
}
