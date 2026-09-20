/**
 * memory-action-handlers/maintenance-actions.mjs — read-only status and the
 * confirm-gated destructive maintenance actions (prune, purge).
 */
import { pruneOldEntries } from '../memory-maintenance-store.mjs';
import { getMetaValue, isBootstrapComplete } from '../memory.mjs';

async function embeddingDims(db) {
  try {
    const raw = await getMetaValue(db, 'embedding.current_dims', null);
    let dims = raw != null ? Number(JSON.parse(raw)) : 0;
    if (!Number.isFinite(dims)) dims = 0;
    return { dims, dimsErr: null };
  } catch (e) {
    // Surface the error in the status line instead of masquerading a meta
    // read failure as dims=0 (which is indistinguishable from a fresh,
    // pre-bootstrap DB). Keep status callable so other lines still render.
    return { dims: 0, dimsErr: e?.message || String(e) };
  }
}

const agoText = (ts) => (ts ? `${Math.round((Date.now() - ts) / 60000)}m ago` : 'never');

export function createMaintenanceActions({ getDb, entryStats, getCycleLastRun }) {
  async function status() {
    const db = getDb();
    const stats = await entryStats();
    const last = await getCycleLastRun();
    const { dims, dimsErr } = await embeddingDims(db);
    const bootstrapComplete = await isBootstrapComplete(db);
    const lines = [
      `entries: total=${stats.total} roots=${stats.roots} cycle1_raw=${stats.unchunked_leaves} (unchunked leaves) cycle2_pending=${stats.cycle2_pending_roots} (awaiting cycle2 review)`,
      `status: ${stats.byStatus.map((r) => `${r.status ?? '?'}:${r.c}`).join(', ') || 'empty'}`,
      `categories: ${stats.byCategory.map((r) => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `core_memory: user=${stats.core_entries} embed_null=${stats.core_embed_null}`,
      `embedding_index: ready dims=${dims}${dimsErr ? ` (meta_read_error: ${dimsErr})` : ''}`,
      `bootstrap: ${bootstrapComplete ? 'complete' : 'incomplete'}`,
      `last_cycle1: ${agoText(last.cycle1)}`,
      `last_cycle2: ${agoText(last.cycle2)}`,
      ...(last.cycle2_last_error ? [`last_cycle2_error: ${last.cycle2_last_error}`] : []),
    ];
    return { text: lines.join('\n') };
  }

  async function prune(args) {
    const db = getDb();
    if (args.confirm !== 'PRUNE OLD ENTRIES') {
      return {
        text: 'prune requires confirm: "PRUNE OLD ENTRIES" (permanently deletes unclassified entries older than maxDays)',
        isError: true,
      };
    }
    const days = Math.max(1, Number(args.maxDays ?? 30));
    const result = await pruneOldEntries(db, days);
    return { text: `prune: deleted ${result.deleted} unclassified entries older than ${days} days` };
  }

  async function purge(args) {
    const db = getDb();
    if (args.confirm !== 'DELETE ALL MEMORY') {
      return { text: 'purge requires confirm: "DELETE ALL MEMORY"', isError: true };
    }
    const preCount = (await db.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c;
    const coreCount = (await db.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c;
    try {
      await db.query(`DELETE FROM entries`);
    } catch (e) {
      return { text: `purge failed: ${e.message}`, isError: true };
    }
    return {
      text: `purged generated memory entries (count=${preCount}); user core preserved (core_entries=${coreCount})`,
    };
  }

  return { status, prune, purge };
}
