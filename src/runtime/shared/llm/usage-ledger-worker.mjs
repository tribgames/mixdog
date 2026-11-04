// Worker-thread body for UsageLedger.workerRequest. Every operation opens its
// own connection for the request and closes it afterwards, so an idle ledger
// file is never held open by this thread. Reads run inside one transaction so
// multi-query answers see a single committed snapshot; writes use the same
// UsageLedger code (BEGIN IMMEDIATE, busy timeout, insert-or-ignore ids) as
// an in-thread write.
import { DatabaseSync } from 'node:sqlite';
import { serveWorkerRequests } from '../worker-requests.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import {
  buildSessionDaysStep,
  readSessionUsage,
  readUsageToken,
  rollupDelta,
  rollupUsage,
} from './usage-ledger-rollup.mjs';
import { readQuotaHistory, readQuotaWindows } from './usage-ledger-quota.mjs';
import { readUsageRequests } from './usage-ledger-requests.mjs';
import { applyUsageRepairIfUnchanged, selectUsageRepairCandidates } from './usage-ledger-repair.mjs';
import { unpricedCountAfter, unpricedPendingCounts } from './usage-pricing-refresh.mjs';

function read(path, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    try {
      return query(db);
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

function write(path, update) {
  const ledger = new UsageLedger(path, { existing: true });
  try {
    return update(ledger);
  } finally {
    ledger.close();
  }
}

function errorOutcome(error) {
  return { error: { message: String(error?.message || error), code: error?.code ?? null } };
}

// One transaction for the whole batch; if it fails, each row gets its own
// transaction so a failure is reported only for the rows it belongs to.
function recordBatch(ledger, rows) {
  try {
    ledger.record(rows);
    return rows.map(() => ({}));
  } catch {
    return rows.map((row) => {
      try {
        ledger.record([row]);
        return {};
      } catch (error) {
        return errorOutcome(error);
      }
    });
  }
}

// A ledger written before the per-session sums existed has them built here,
// the only place they are: a step of sessions at a time, each its own short
// transaction, with the thread yielding between steps. Other requests, writes
// included, are served between steps; a session read waits for the whole build.
const sessionSums = new Map();
function sessionSumsReady(path) {
  if (!sessionSums.has(path)) {
    const build = (async () => {
      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA busy_timeout=5000');
        while (!buildSessionDaysStep(db)) await new Promise((resolve) => setImmediate(resolve));
      } finally {
        db.close();
      }
    })();
    sessionSums.set(path, build);
    // A failed build is attempted again by the next request.
    build.catch(() => sessionSums.delete(path));
  }
  return sessionSums.get(path);
}

const operations = {
  rollup: ({ path, options }) => read(path, (db) => rollupUsage(db, options)),
  rollupDelta: ({ path, options, known, now }) => read(path, (db) => rollupDelta(db, options, known, now)),
  sessionUsage: async ({ path, sessionIds, ownerIds }) => {
    await sessionSumsReady(path);
    return read(path, (db) => readSessionUsage(db, sessionIds, ownerIds));
  },
  usageTokens: async ({ path, groups }) => {
    await sessionSumsReady(path);
    return read(path, (db) => groups.map(({ owner, ids }) => readUsageToken(db, ids, [owner])));
  },
  requests: ({ path, options }) => read(path, (db) => readUsageRequests(db, options)),
  record: ({ path, rows }) => write(path, (ledger) => recordBatch(ledger, rows)),
  recordQuota: ({ path, samples }) => write(path, (ledger) => ledger.recordQuota(samples)),
  quotaHistory: ({ path, options }) => read(path, (db) => readQuotaHistory(db, options)),
  quotaWindows: ({ path, options }) => read(path, (db) => readQuotaWindows(db, options)),
  unpricedPending: ({ path, now }) => read(path, (db) => unpricedPendingCounts(db, now)),
  unpricedAfter: ({ path, now, latest }) => read(path, (db) => unpricedCountAfter(db, now, latest)),
  repairCandidates: ({ path, ...options }) => read(path, (db) => selectUsageRepairCandidates(db, options)),
  applyRepair: ({ path, ...plan }) => write(path, (ledger) => applyUsageRepairIfUnchanged(ledger, plan)),
};

serveWorkerRequests(({ op, ...payload }) => operations[op](payload));
