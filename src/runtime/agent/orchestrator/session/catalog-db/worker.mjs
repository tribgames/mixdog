// Worker thread of the session catalog DB (index.mjs is its only client).
//
// It owns `<dataDir>/session-catalog.sqlite` and runs the ordinary catalog
// engine (store-summary-catalog.mjs): the summary index stamps and delta-log
// apply, the sessions-directory name diff, per-file stamps, `.hb` liveness and
// the background verification. An ordinary listing is one `list` request: the
// engine's cheap stamp check runs first (so changes by any writer appear as
// soon as they do on the JSON path), its changes are written to the DB, and
// the answer comes from the DB. When one of the daemon's own writes changed a
// session file, a `hint` request (ids only, tagged with the data dir) arrives
// before any later listing, and that listing re-checks those ids from storage
// (read-your-writes for landed saves and completed deletes).
//
// The DB is fenced: the connection runs in EXCLUSIVE locking mode and holds
// the lock for its whole life, so a second process cannot open it and simply
// stays on JSON. Only proven corruption (quick_check, SQLITE_CORRUPT,
// SQLITE_NOTADB) moves the file aside; busy, locked or access errors never do.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { postWorkerEvent, serveWorkerRequests } from '../../../../shared/worker-requests.mjs';
import {
  agentHeartbeatsByOwner,
  catalogSessionOwnershipLinks,
  createOrdinaryCatalog,
  isLeadVisibleRow,
} from '../store-summary-catalog.mjs';
import { positiveNumber } from '../store-summary-fields.mjs';
import { SQLITE_REQUIREMENT, sqliteVersionSupported } from './sqlite-gate.mjs';
import {
  APPLICATION_ID,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  UPSERT_SQL,
  compareListings,
  rowFromDb,
  rowSignature,
  upsertParams,
} from './schema.mjs';

const DB_FILE = 'session-catalog.sqlite';
const DEFAULTS = Object.freeze({
  backfillBatch: 500,
  shadowIntervalMs: 60_000,
  retryMs: 60_000,
  // How long a second process waits for the fence before staying on JSON.
  fenceTimeoutMs: 250,
  maxRecoveries: 3,
});
// Settings only a test run may change.
const TEST_ONLY = ['sqliteVersion', 'crashAfterBatches'];
// SQLite primary result codes.
const CORRUPT_CODES = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB
const LOCKED_CODES = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED

let state = null;

const log = (line) => postWorkerEvent({ type: 'log', line });
const message = (error) => String(error?.message || error);

function settingsOf(raw) {
  const settings = { ...DEFAULTS, ...(raw || {}) };
  if (!process.env.NODE_TEST_CONTEXT) for (const key of TEST_ONLY) delete settings[key];
  return settings;
}

function runtimeLabel() {
  return `node=${process.version}${process.versions.electron ? ` electron=${process.versions.electron}` : ''}`;
}

function codedError(text, code) {
  return Object.assign(new Error(text), { code });
}

/** Proven corruption and lock contention get stable codes; nothing else is
 *  ever treated as either. */
function classify(error) {
  if (String(error?.code || '').startsWith('ESESSIONCATALOG')) return error;
  const text = message(error);
  const primary = Number(error?.errcode) & 0xff;
  if (CORRUPT_CODES.has(primary) || /file is not a database|disk image is malformed/i.test(text)) {
    return codedError(text, 'ESESSIONCATALOGCORRUPT');
  }
  if (LOCKED_CODES.has(primary) || /database is locked|database table is locked/i.test(text)) {
    return codedError(text, 'ESESSIONCATALOGLOCKED');
  }
  return error;
}

function runtimeSqliteVersion() {
  const db = new DatabaseSync(':memory:');
  try {
    return db.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    db.close();
  }
}

function stampKey(stamp) {
  return stamp ? `${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mtimeNs}:${stamp.ctimeNs}` : null;
}

// ── Connection ──────────────────────────────────────────────────────────────

function meta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    String(value)
  );
}

function transaction(db, body) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the failure already ended it */
    }
    throw error;
  }
}

/** Opens `path` as the fenced owner and checks it; throws a classified error. */
function openChecked(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    throw classify(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(settings.fenceTimeoutMs))}`);
    // The fence: an exclusive lock taken now and kept until close.
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const objects = db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n;
    if (applicationId !== APPLICATION_ID && !(applicationId === 0 && objects === 0)) {
      throw codedError(`not a session catalog (application_id=${applicationId})`, 'ESESSIONCATALOGFOREIGN');
    }
    const check = Object.values(db.prepare('PRAGMA quick_check').get())[0];
    if (check !== 'ok') throw codedError(`quick_check: ${check}`, 'ESESSIONCATALOGCORRUPT');
    db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA application_id=${APPLICATION_ID};`
    );
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    let recreated = false;
    if (Number(meta(db, 'schema_version')) !== SCHEMA_VERSION) {
      // A derived cache: another layout is dropped and backfilled again.
      transaction(db, () => {
        db.exec('DROP TABLE IF EXISTS sessions; DELETE FROM meta;');
        db.exec(SCHEMA_SQL);
        setMeta(db, 'schema_version', SCHEMA_VERSION);
      });
      recreated = true;
    }
    return { db, recreated };
  } catch (error) {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    throw classify(error);
  }
}

/** Renames the DB and its WAL/SHM sidecars aside; returns the new path. */
function moveAside(path) {
  const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix);
  }
  return aside;
}

function prepare(db) {
  const lead = 'SELECT * FROM sessions WHERE lead_visible=1';
  const order = 'ORDER BY activity DESC, id ASC';
  return {
    upsert: db.prepare(UPSERT_SQL),
    signature: db.prepare('SELECT row_sig FROM sessions WHERE id=?'),
    remove: db.prepare('DELETE FROM sessions WHERE id=?'),
    ids: db.prepare('SELECT id FROM sessions'),
    count: db.prepare('SELECT count(*) AS n FROM sessions'),
    listAll: db.prepare(`${lead} ${order}`),
    listFirst: db.prepare(`${lead} ${order} LIMIT ?`),
    listAfter: db.prepare(`${lead} AND (activity < ? OR (activity = ? AND id > ?)) ${order} LIMIT ?`),
  };
}

// ── State ───────────────────────────────────────────────────────────────────
// phase: closed → (off | backfilling) → ready; rebuilding/backfilling again
// after a fresh scan or a shadow mismatch. Only `ready` answers listings.

function newState(dataDir) {
  const engine = createOrdinaryCatalog();
  engine.subscribe(() => postWorkerEvent({ type: 'changed' }));
  return {
    dataDir,
    path: join(dataDir, DB_FILE),
    settings: settingsOf(null),
    db: null,
    statements: null,
    phase: 'closed',
    reason: null,
    final: false,
    retryAt: 0,
    recoveries: 0,
    recoverOnOpen: false,
    engine,
    absent: false,
    backfill: null,
    generation: 0,
    shadowTimer: null,
    shadowDueAt: 0,
    shadowAt: 0,
    switchOff: null,
    sqliteVersion: null,
    lastBackfill: null,
    lastShadow: null,
  };
}

function closeConnection(s) {
  try {
    s.db?.close();
  } catch {
    /* closing a broken connection */
  }
  s.db = null;
  s.statements = null;
}

function closeState() {
  if (!state) return;
  const s = state;
  state = null;
  s.generation++;
  if (s.shadowTimer) clearTimeout(s.shadowTimer);
  s.engine.clear();
  closeConnection(s);
}

function ensure(dataDir, raw) {
  if (state && state.dataDir !== dataDir) closeState();
  state ||= newState(dataDir);
  state.settings = settingsOf(raw);
  // The engine resolves every path from MIXDOG_DATA_DIR (this thread's copy).
  process.env.MIXDOG_DATA_DIR = dataDir;
  if (state.phase === 'closed' || (state.phase === 'off' && !state.final && Date.now() >= state.retryAt)) open(state);
  return state;
}

function off(s, reason, final, line) {
  closeConnection(s);
  s.phase = 'off';
  s.reason = reason;
  s.final = final;
  s.retryAt = Date.now() + s.settings.retryMs;
  log(line);
}

function open(s) {
  const version = s.settings.sqliteVersion || runtimeSqliteVersion();
  s.sqliteVersion = version;
  if (!sqliteVersionSupported(version)) {
    off(
      s,
      'sqlite-version',
      true,
      `disabled: SQLite ${version} (${runtimeLabel()}) lacks the WAL-reset fix (needs ${SQLITE_REQUIREMENT}); catalog stays JSON`
    );
    return;
  }
  let opened;
  try {
    opened = openChecked(s.path, s.settings);
  } catch (error) {
    if (error.code !== 'ESESSIONCATALOGCORRUPT') {
      const reason = error.code === 'ESESSIONCATALOGLOCKED' ? 'locked' : 'unopenable';
      off(s, reason, false, `${reason}: ${message(error)}; catalog stays JSON (retried later) path=${s.path}`);
      return;
    }
    try {
      const aside = moveAside(s.path);
      log(`corrupt DB (${message(error)}) moved aside to ${aside}; rebuilding from JSON`);
      opened = openChecked(s.path, s.settings);
    } catch (retry) {
      off(s, 'unopenable', false, `unopenable after moving a corrupt DB aside: ${message(retry)}; catalog stays JSON`);
      return;
    }
  }
  s.db = opened.db;
  s.statements = prepare(opened.db);
  const complete = meta(s.db, 'backfill_complete') === '1';
  log(
    `open sqlite=${version} ${runtimeLabel()} schema=${SCHEMA_VERSION}${opened.recreated ? ' (new)' : ''} rows=${
      s.statements.count.get().n
    } backfill=${complete ? 'complete' : 'pending'} path=${s.path}`
  );
  let kind = complete ? 'resync' : 'resume';
  if (opened.recreated) kind = 'initial';
  else if (s.recoverOnOpen) kind = 'recover';
  s.recoverOnOpen = false;
  startBackfill(s, kind);
}

/** A DB failure: corruption is moved aside and rebuilt (bounded), anything
 *  else closes the DB and is retried later. Listings use JSON meanwhile. */
function fail(s, error, phase) {
  if (s !== state) return;
  const failure = classify(error);
  s.generation++;
  closeConnection(s);
  if (failure.code === 'ESESSIONCATALOGCORRUPT' && s.recoveries < s.settings.maxRecoveries) {
    s.recoveries++;
    log(`corrupt DB during ${phase}: ${message(failure)}`);
    try {
      log(`moved aside to ${moveAside(s.path)}; rebuilding from JSON`);
    } catch (moveError) {
      off(s, 'unopenable', false, `cannot move the corrupt DB aside: ${message(moveError)}; catalog stays JSON`);
      return;
    }
    s.phase = 'closed';
    open(s);
    return;
  }
  // The reopen rewrites every row (see runBackfill).
  s.recoverOnOpen = true;
  off(s, 'error', false, `${phase} failed: ${message(failure)}; catalog stays JSON (retried later)`);
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** What `id` contributes to the engine's current catalog, or null. */
function resolve(s, id) {
  const catalog = s.engine.current();
  const row = catalog ? s.engine.entryRow(catalog, id) : null;
  if (!row) return null;
  return { row, fingerprint: stampKey(catalog.entries.get(id)?.stamp), leadVisible: isLeadVisibleRow(row) };
}

/** Writes the resolved rows of `ids` whose signature changed; deletes the
 *  ids that resolve to nothing. */
function writeIds(s, ids, force = false) {
  const counts = { written: 0, skipped: 0, removed: 0 };
  for (const id of ids) {
    const entry = resolve(s, id);
    if (!entry) {
      counts.removed += Number(s.statements.remove.run(id).changes);
      continue;
    }
    const signature = rowSignature(entry);
    if (!force && s.statements.signature.get(id)?.row_sig === signature) {
      counts.skipped++;
      continue;
    }
    s.statements.upsert.run(...upsertParams(entry, signature));
    counts.written++;
  }
  return counts;
}

// ── Backfill ────────────────────────────────────────────────────────────────
// A full scan of storage imported in batches (yielding between them, so
// listings get an immediate "use JSON" meanwhile). Membership is the scan's
// own id set: at the end every DB row the scan does not contain is deleted, so an interrupted and resumed import never keeps a
// session deleted in between. Unchanged rows are skipped by signature.

function startBackfill(s, kind) {
  s.phase = kind === 'rebuild' ? 'rebuilding' : 'backfilling';
  const generation = ++s.generation;
  const run = runBackfill(s, kind, generation).catch((error) => fail(s, error, 'backfill'));
  s.backfill = run;
  run.finally(() => {
    if (s.backfill === run) s.backfill = null;
  });
}

async function runBackfill(s, kind, generation) {
  const startedAt = performance.now();
  const current = () => s === state && generation === s.generation;
  // A full rescan: the DB is rebuilt from what storage says now.
  s.engine.clear();
  const result = s.engine.refresh(s.engine.loadIndex(), { assemble: false });
  if (!result.catalog && !result.absent) throw new Error('the sessions directory cannot be enumerated');
  s.absent = result.absent;
  const ids = result.catalog ? [...result.catalog.entries.keys()] : [];
  setMeta(s.db, 'backfill_complete', 0);
  const totals = { written: 0, skipped: 0 };
  const { backfillBatch, crashAfterBatches } = s.settings;
  // A rebuild after a mismatch or an error rewrites every row: a damaged
  // stored row still carries the signature of the row it was written from.
  const force = kind === 'rebuild' || kind === 'recover';
  let batches = 0;
  for (let start = 0; start < ids.length; start += backfillBatch) {
    if (!current()) return;
    const counts = transaction(s.db, () => writeIds(s, ids.slice(start, start + backfillBatch), force));
    totals.written += counts.written;
    totals.skipped += counts.skipped;
    batches++;
    // Test seam: the thread dies mid-backfill.
    if (crashAfterBatches === batches) process.exit(1);
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  if (!current()) return;
  const finished = transaction(s.db, () => {
    const members = new Set();
    for (const id of ids) if (resolve(s, id)) members.add(id);
    let removed = 0;
    for (const { id } of s.statements.ids.all()) {
      if (!members.has(id)) removed += Number(s.statements.remove.run(id).changes);
    }
    setMeta(s.db, 'backfill_complete', 1);
    return { removed, rows: s.statements.count.get().n };
  });
  s.phase = 'ready';
  s.recoveries = 0;
  s.lastBackfill = { kind, ...totals, ...finished, ms: performance.now() - startedAt };
  log(
    `backfill complete (${kind}) rows=${finished.rows} written=${totals.written} skipped=${totals.skipped} removed=${
      finished.removed
    } ms=${Math.round(s.lastBackfill.ms)}`
  );
  // Every completed backfill is verified at once.
  if (s.shadowTimer) clearTimeout(s.shadowTimer);
  s.shadowTimer = null;
  scheduleShadow(s, 0);
}

// ── Shadow verification ─────────────────────────────────────────────────────
// Rate-limited: the engine's JSON listing against the DB listing, every row
// in exact order. A mismatch stops serving from the DB and rebuilds it from
// JSON.

function scheduleShadow(s, delay = null) {
  if (s.shadowTimer || s.phase !== 'ready') return;
  const wait = delay ?? Math.max(0, s.shadowAt + s.settings.shadowIntervalMs - Date.now());
  s.shadowDueAt = Date.now() + wait;
  s.shadowTimer = setTimeout(() => {
    s.shadowTimer = null;
    if (s === state) shadow(s);
  }, wait);
  s.shadowTimer.unref?.();
}

function formatReport(report) {
  const mismatch = report.missing + report.extra + report.order + report.fields > 0;
  const head = `shadow-verify ${mismatch ? 'mismatch' : 'ok'} json=${report.json} db=${report.db}`;
  if (!mismatch) return head;
  const first = Object.entries(report.ids)
    .filter(([, ids]) => ids.length > 0)
    .map(([kind, ids]) => `${kind}:${ids.join(',')}`)
    .join(' ');
  return `${head} missing=${report.missing} extra=${report.extra} order=${report.order} fields=${report.fields} first=${first}`;
}

function shadow(s) {
  if (s.phase !== 'ready') return null;
  try {
    s.shadowAt = Date.now();
    const catalog = s.engine.current();
    const json = catalog ? s.engine.rowsOf(catalog) : [];
    const report = compareListings(json, s.statements.listAll.all().map(rowFromDb));
    s.lastShadow = report;
    log(formatReport(report));
    if (report.missing + report.extra + report.order + report.fields > 0) {
      log('listings use JSON until the DB is rebuilt');
      startBackfill(s, 'rebuild');
    }
    return report;
  } catch (error) {
    fail(s, error, 'shadow-verify');
    return null;
  }
}

// ── Listing ─────────────────────────────────────────────────────────────────

/** The off-switch: `{ "sessionStore": { "sqliteCatalog": false } }` in the
 *  data dir's config (re-read when the file changes). */
function switchedOff(s) {
  if (s.settings.enabled === false) return true;
  if (s.settings.enabled === true) return false;
  const path = join(s.dataDir, 'mixdog-config.json');
  let info;
  try {
    info = statSync(path);
  } catch {
    s.switchOff = null;
    return false;
  }
  if (!s.switchOff || s.switchOff.mtimeMs !== info.mtimeMs || s.switchOff.size !== info.size) {
    let value = s.switchOff?.value ?? false;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))?.sessionStore?.sqliteCatalog === false;
    } catch {
      /* a torn or malformed config keeps the last answer */
    }
    if (value !== (s.switchOff?.value ?? false)) {
      log(value ? 'off-switch set: ordinary listings use JSON' : 'off-switch cleared');
    }
    s.switchOff = { mtimeMs: info.mtimeMs, size: info.size, value };
  }
  return s.switchOff.value;
}

/** Rows from the DB with the liveness of the current scan overlaid. */
function answer(s, page) {
  const heartbeatMtimes = s.engine.current()?.heartbeatMtimes ?? new Map();
  const live = [];
  for (const [id, heartbeatAt] of heartbeatMtimes) {
    const entry = resolve(s, id);
    if (entry) live.push({ ...entry.row, heartbeatAt });
  }
  const agentHeartbeatByOwner = agentHeartbeatsByOwner(live);
  const overlay = (row) => {
    const agentHeartbeatAt = agentHeartbeatByOwner.get(row.id) || 0;
    return {
      ...row,
      heartbeatAt: positiveNumber(heartbeatMtimes.get(row.id), 0),
      ...(agentHeartbeatAt > 0 ? { agentHeartbeatAt } : {}),
    };
  };
  const { statements } = s;
  if (!page) return { rows: statements.listAll.all().map((record) => overlay(rowFromDb(record))), more: false };
  const { limit, after } = page;
  const records = after
    ? statements.listAfter.all(after.activity, after.activity, after.id, limit + 1)
    : statements.listFirst.all(limit + 1);
  return { rows: records.slice(0, limit).map((record) => overlay(rowFromDb(record))), more: records.length > limit };
}

const unavailable = (reason, final = false) => ({ status: 'unavailable', reason, final });

function list({ dataDir, page, settings, ownershipLinks = false }) {
  const s = ensure(dataDir, settings);
  if (s.phase === 'off') return unavailable(s.reason, s.final);
  if (switchedOff(s)) return unavailable('switch-off');
  if (s.phase !== 'ready') return unavailable(s.phase);
  try {
    const result = s.engine.refresh(s.engine.loadIndex(), { assemble: false });
    if (!result.catalog && !result.absent) return unavailable('storage');
    if (result.fresh || result.absent !== s.absent) {
      startBackfill(s, 'rescan');
      return unavailable(s.phase);
    }
    const ids = result.changedIds || new Set();
    if (ids.size > 0) {
      transaction(s.db, () => writeIds(s, ids));
      scheduleShadow(s);
    }
    if (ownershipLinks) {
      const rows = catalogSessionOwnershipLinks(result);
      return rows === null ? unavailable('ownership') : { status: 'ok', rows, more: false };
    }
    return { status: 'ok', ...answer(s, page) };
  } catch (error) {
    fail(s, error, 'listing');
    return unavailable('error');
  }
}

/** Storage hints: the daemon's own writes changed these ids' files. They
 *  carry no row data; the next listing re-checks the ids from storage. A hint
 *  for another data dir than the open one is ignored. */
function hint({ dataDir, ids }) {
  if (state?.dataDir !== dataDir) return { hinted: 0 };
  state.engine.hint(ids);
  return { hinted: ids.length };
}

function status() {
  if (!state) return { phase: 'closed' };
  return {
    phase: state.phase,
    reason: state.reason,
    final: state.final,
    sqliteVersion: state.sqliteVersion,
    rows: state.statements ? state.statements.count.get().n : null,
    lastBackfill: state.lastBackfill,
    lastShadow: state.lastShadow,
  };
}

const operations = {
  list,
  hint,
  status,
  /** Run the engine's background verification now. */
  verifyFiles: async ({ dataDir }) => {
    if (state?.dataDir === dataDir) await state.engine.verify();
    return true;
  },
  /** Run a shadow verification now (tests, benchmarks). */
  shadow: ({ dataDir, settings }) => {
    if (state?.dataDir !== dataDir) return null;
    state.settings = settingsOf(settings);
    const report = shadow(state);
    return report && { ...report, phase: state.phase };
  },
  /** Resolves once no backfill or due shadow check is outstanding. */
  settle: async ({ dataDir, settings }) => {
    ensure(dataDir, settings);
    for (;;) {
      if (state?.backfill) await state.backfill;
      else if (state?.shadowTimer && state.shadowDueAt <= Date.now()) {
        await new Promise((resolveTurn) => setTimeout(resolveTurn, 1));
      } else return status();
    }
  },
  close: () => {
    closeState();
    return true;
  },
  /** Test seam: run SQL on the owner connection (the fence keeps others out). */
  testExec: ({ sql, params = [] }) => {
    if (!process.env.NODE_TEST_CONTEXT) throw new Error('testExec is a test seam');
    return Number(state.db.prepare(sql).run(...params).changes);
  },
};

serveWorkerRequests(({ op, ...payload }) => operations[op](payload));
