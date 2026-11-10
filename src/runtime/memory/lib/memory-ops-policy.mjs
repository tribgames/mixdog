import { __mixdogMemoryLog } from './memory-log.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { mixdogHome } from '../../shared/plugin-paths.mjs';
import { throwIfAborted } from './memory-cycle-shared.mjs';
import { flushSearchEmbeddings } from './memory-embed.mjs';
import { isSkippedWatchPath, isTranscriptJsonlName } from './ingest/transcript-discovery.mjs';

function normalizeBackfillWindow(value) {
  const normalized = String(value ?? 'all')
    .trim()
    .toLowerCase();
  if (['none', 'off', 'disabled', '0'].includes(normalized)) return 'none';
  if (['1d', '1day', '1-day', '1 day', 'day', 'today'].includes(normalized)) return '1d';
  if (['3d', '3days', '3-day', '3 day'].includes(normalized)) return '3d';
  if (['7d', '7days', '7-day', '7 day', 'week'].includes(normalized)) return '7d';
  if (['30d', '30days', '30-day', '30 day', 'month'].includes(normalized)) return '30d';
  return 'all';
}

function normalizeBackfillScope(value) {
  const normalized = String(value ?? 'all')
    .trim()
    .toLowerCase();
  if (['workspace', 'project', 'current'].includes(normalized)) return 'workspace';
  return 'all';
}

const BACKFILL_WINDOW_DAYS = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 };

function resolveBackfillSinceMs(windowValue, now = Date.now()) {
  const days = BACKFILL_WINDOW_DAYS[normalizeBackfillWindow(windowValue)];
  return days ? now - days * 24 * 60 * 60 * 1000 : null;
}

async function countUnclassified(db) {
  const row = (await db.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`, [])).rows[0];
  return Number(row?.c ?? 0);
}

function selectBackfillTranscripts({ sinceMs = null, limit = null, projectsRoot = null, accept = null } = {}) {
  const root = projectsRoot || path.join(mixdogHome(), 'projects');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const d of fs.readdirSync(root)) {
    if (isSkippedWatchPath(d)) continue;
    const full = path.join(root, d);
    try {
      for (const f of fs.readdirSync(full)) {
        if (!isTranscriptJsonlName(f)) continue;
        const fp = path.join(full, f);
        let mtime;
        try {
          mtime = fs.statSync(fp).mtimeMs;
        } catch {
          continue;
        }
        if (sinceMs != null && mtime < sinceMs) continue;
        if (accept && !accept(fp)) continue;
        files.push({ path: fp, mtime });
      }
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const capped = limit != null && Number(limit) > 0 ? files.slice(0, Number(limit)) : files;
  return capped.map((f) => f.path).reverse();
}

const FULL_BACKFILL_MAX_ITERS = 30;
const BACKFILL_CONCURRENCY = 3;

export async function runFullBackfill(
  db,
  {
    window = '7d',
    scope = 'all',
    limit = null,
    config = {},
    dataDir = null,
    ingestTranscriptFile,
    cwdFromTranscriptPath,
    runCycle1,
    flushEmbeddings = flushSearchEmbeddings,
    now = Date.now(),
    projectsRoot = null,
    workspaceCwd = null,
    signal,
  } = {}
) {
  throwIfAborted(signal);
  if (typeof ingestTranscriptFile !== 'function') {
    throw new Error('runFullBackfill: ingestTranscriptFile required');
  }
  if (typeof runCycle1 !== 'function') {
    throw new Error('runFullBackfill: runCycle1 required');
  }

  const normalizedWindow = normalizeBackfillWindow(window);
  const normalizedScope = normalizeBackfillScope(scope);
  const sinceMs = resolveBackfillSinceMs(normalizedWindow, now);
  const normPath = (p) => {
    const r = path.resolve(String(p));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const workspaceRoot = normPath(workspaceCwd || process.cwd());
  const accept =
    normalizedScope === 'workspace' && typeof cwdFromTranscriptPath === 'function'
      ? (fp) => {
          const c = cwdFromTranscriptPath(fp);
          if (!c) return false;
          const rel = path.relative(workspaceRoot, normPath(c));
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        }
      : null;
  const selected = selectBackfillTranscripts({ sinceMs, limit, projectsRoot, accept });

  let ingested = 0;
  const errors = [];
  let cursor = 0;
  const workers = Array.from({ length: BACKFILL_CONCURRENCY }, async () => {
    while (cursor < selected.length) {
      throwIfAborted(signal);
      const idx = cursor++;
      const fp = selected[idx];
      try {
        const cwd = typeof cwdFromTranscriptPath === 'function' ? cwdFromTranscriptPath(fp) : undefined;
        const n = Number((await ingestTranscriptFile(fp, { cwd, signal })) ?? 0);
        ingested += n;
      } catch (err) {
        throwIfAborted(signal);
        errors.push({ stage: 'ingest', path: fp, error: err.message });
        __mixdogMemoryLog(`[backfill] ingest failed (${fp}): ${err.message}\n`);
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  throwIfAborted(signal);

  let cycle1Iters = 0;
  let prevUnclassified = await countUnclassified(db);
  while (prevUnclassified > 0 && cycle1Iters < FULL_BACKFILL_MAX_ITERS) {
    throwIfAborted(signal);
    let result;
    try {
      result = await runCycle1(db, config?.cycle1 || {}, { signal }, dataDir);
    } catch (err) {
      throwIfAborted(signal);
      errors.push({ stage: 'cycle1', error: err.message });
      __mixdogMemoryLog(`[backfill] cycle1 error (iter=${cycle1Iters}): ${err.message}\n`);
      break;
    }
    cycle1Iters += 1;
    if (Number(result?.processed ?? 0) === 0) break;
    const nextUnclassified = await countUnclassified(db);
    if (nextUnclassified >= prevUnclassified) break;
    prevUnclassified = nextUnclassified;
  }

  try {
    throwIfAborted(signal);
    await flushEmbeddings(db, { signal });
  } catch (err) {
    throwIfAborted(signal);
    errors.push({ stage: 'embedding', error: err.message });
    __mixdogMemoryLog(`[backfill] embedding error: ${err.message}\n`);
  }

  const unclassified = await countUnclassified(db);
  return {
    ok: errors.length === 0,
    ...(errors.length ? { error: errors.map((item) => `${item.stage}: ${item.error}`).join('; '), errors } : {}),
    window: normalizedWindow,
    scope: normalizedScope,
    files: selected.length,
    ingested,
    cycle1_iters: cycle1Iters,
    unclassified,
  };
}
