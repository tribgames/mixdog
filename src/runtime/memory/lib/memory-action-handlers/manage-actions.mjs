/**
 * memory-action-handlers/manage-actions.mjs — `manage`: manual add / edit /
 * delete of generated-history root entries (the entries table), with the
 * root embedding resynced after a text change.
 */
import { syncRootEmbedding } from '../memory-cycle.mjs';
import { VALID_CATEGORY } from '../memory-categories.mjs';
import { computeEntryScore } from '../memory-score.mjs';
import { resolveProjectScope } from '../project-id-resolver.mjs';

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const numericId = (value) => {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
};

export function createManageActions({ getDb, log }) {
  async function add(args) {
    const db = getDb();
    const element = String(args.element ?? '').trim();
    const summary = String(args.summary ?? args.element ?? '').trim();
    const category = String(args.category ?? 'fact')
      .trim()
      .toLowerCase();
    if (!element || !summary) {
      return { text: 'manage add requires element and summary', isError: true };
    }
    if (!VALID_CATEGORY.has(category)) {
      return {
        text: `manage add: invalid category "${category}". Valid: ${[...VALID_CATEGORY].join(', ')}`,
        isError: true,
      };
    }
    const nowMs = Date.now();
    const sourceRef = `manual:${nowMs}-${process.pid}`;
    const manageProjectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null);
    try {
      let newId;
      await db.transaction(async (tx) => {
        const result = await tx.query(
          `
              INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
              VALUES ($1, 'system', $2, $3, NULL, $4)
              RETURNING id
            `,
          [nowMs, `${element} — ${summary}`, sourceRef, manageProjectId]
        );
        newId = Number(result.rows[0].id);
        const score = computeEntryScore(category, nowMs, nowMs);
        await tx.query(
          `
              UPDATE entries
              SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                  status = 'pending', score = $5, last_seen_at = $6
              WHERE id = $7
            `,
          [newId, element, category, summary, score, nowMs, newId]
        );
      });
      await syncRootEmbedding(db, newId);
      return { text: `added (id=${newId}): [${category}] ${element} — ${summary.slice(0, 200)}` };
    } catch (e) {
      return { text: `manage add failed: ${e.message}`, isError: true };
    }
  }

  async function edit(args) {
    const db = getDb();
    const id = numericId(args.id);
    if (id === null) {
      return { text: 'manage edit requires numeric id', isError: true };
    }
    const existing = (
      await db.query(`SELECT id, element, summary, category, status, ts, is_root FROM entries WHERE id = $1`, [id])
    ).rows[0];
    if (!existing) return { text: `manage edit: no entry with id=${id}`, isError: true };
    if (existing.is_root !== 1) return { text: `manage edit: id=${id} is not a root`, isError: true };

    const newElement = trimOrNull(args.element);
    const newSummary = trimOrNull(args.summary);
    const newCategory = trimOrNull(args.category)?.toLowerCase() ?? null;
    if (!newElement && !newSummary && !newCategory) {
      return { text: 'manage edit requires at least one field: element, summary, category', isError: true };
    }
    if (newCategory && !VALID_CATEGORY.has(newCategory)) {
      return {
        text: `manage edit: invalid category "${newCategory}". Valid: ${[...VALID_CATEGORY].join(', ')}`,
        isError: true,
      };
    }

    const finalElement = newElement ?? existing.element;
    const finalSummary = newSummary ?? existing.summary;
    const finalCategory = newCategory ?? existing.category;
    const nowMs = Date.now();
    const score = computeEntryScore(finalCategory, nowMs, nowMs);
    const textChanged = newElement != null || newSummary != null;
    // Guard null element/summary: a category-only edit on a root whose
    // element or summary is NULL would otherwise persist literal
    // 'null — null' content and explode on finalSummary.slice() below.
    // Empty-string sentinels for the content composition + render keep the
    // row consistent with what's actually stored.
    const elementStr = finalElement == null ? '' : String(finalElement);
    const summaryStr = finalSummary == null ? '' : String(finalSummary);
    const summarySuffix = summaryStr ? ` — ${summaryStr}` : '';
    const composedContent = elementStr || summaryStr ? `${elementStr}${summarySuffix}` : '';

    try {
      await db.transaction(async (tx) => {
        // Editing either side invalidates the duplicate equivalence, not
        // the original chunks or their lineage.
        await tx.query(`UPDATE entries SET duplicate_of = NULL, cycle2_reviewed_at = NULL WHERE duplicate_of = $1`, [
          id,
        ]);
        await tx.query(
          `
              UPDATE entries
              SET element = $1, summary = $2, category = $3, score = $4,
                  last_seen_at = $5, content = $6, cycle2_reviewed_at = NULL, duplicate_of = NULL
              WHERE id = $7
            `,
          [finalElement, finalSummary, finalCategory, score, nowMs, composedContent, id]
        );
      });
    } catch (e) {
      return { text: `manage edit failed: ${e.message}`, isError: true };
    }
    if (textChanged) {
      try {
        await syncRootEmbedding(db, id);
      } catch (e) {
        log(`[memory.manage] embedding resync failed (id=${id}): ${e.message}\n`);
      }
    }
    return {
      text: `edited (id=${id}): [${finalCategory}] ${elementStr}${summaryStr ? ` — ${summaryStr.slice(0, 200)}` : ''}`,
    };
  }

  async function remove(args) {
    const db = getDb();
    const id = numericId(args.id);
    if (id === null) {
      return { text: 'manage delete requires numeric id', isError: true };
    }
    const info = (await db.query(`SELECT id, category, element, is_root FROM entries WHERE id = $1`, [id])).rows[0];
    if (!info) return { text: `manage delete: no entry with id=${id}`, isError: true };
    try {
      const result =
        info.is_root === 1
          ? await db.query(`DELETE FROM entries WHERE id = $1 OR chunk_root = $2`, [id, id])
          : await db.query(`DELETE FROM entries WHERE id = $1`, [id]);
      return {
        text: `deleted (id=${id}, rows=${Number(result.rowCount ?? result.affectedRows ?? 0)}): [${info.category ?? '-'}] ${info.element ?? ''}`,
      };
    } catch (e) {
      return { text: `manage delete failed: ${e.message}`, isError: true };
    }
  }

  const ops = { add, edit, delete: remove };

  return async function manage(args) {
    const op = String(args.op ?? '')
      .trim()
      .toLowerCase();
    if (!Object.hasOwn(ops, op)) {
      return { text: 'manage requires op: "add" | "edit" | "delete"', isError: true };
    }
    if (Object.hasOwn(args, 'status')) {
      return { text: 'manage: history importance classification is no longer supported', isError: true };
    }
    return ops[op](args);
  };
}
