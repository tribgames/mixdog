// The Lead pool row shape: normalization of the on-disk index and the status
// test that says a row still claims a running turn.
import { clean } from '../helpers.mjs';
import { leadPoolTag } from '../worker-rows.mjs';

export const ACTIVE_LEAD_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;

// Mirror of the pool reader's freshness window (store-summary-reader): a row is
// only believed to be working while its heartbeat sidecar or its own stamp sits
// inside this window. Recovery applies the SAME rule, so the index can never
// keep claiming work the panel has already stopped believing.
export const LEAD_POOL_FRESH_MS = 2 * 60 * 1000;

export const isActiveLeadRow = (row) => ACTIVE_LEAD_STATUS.test(clean(row?.status || row?.stage));

export function normalizeLeadRows(value) {
  let source = [];
  if (Array.isArray(value?.workers)) source = value.workers;
  else if (value?.workers && typeof value.workers === 'object') source = Object.values(value.workers);
  return source
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const sessionId = clean(row.sessionId);
      if (!sessionId) return null;
      return {
        ...row,
        tag: leadPoolTag(sessionId),
        sessionId,
        ownerSessionId: sessionId,
        agent: 'lead',
        status: clean(row.status) || 'idle',
        stage: clean(row.stage) || clean(row.status) || 'idle',
        updatedAt: clean(row.updatedAt) || null,
        reapAt: clean(row.reapAt) || null,
      };
    })
    .filter(Boolean);
}
