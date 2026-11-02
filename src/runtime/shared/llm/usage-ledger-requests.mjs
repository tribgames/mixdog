/**
 * The request log: individual requests, newest first, a page at a time. The
 * ledger keeps every record forever, so each page is read through an index
 * ordered by time (all requests, one status, or one route) and stops after
 * the page: a page of "all history" costs what a page of today does.
 *
 * The request facts (requested model, status, attempts) sit in
 * `usage_requests` and the first-output time in `usage_request_first_output`,
 * beside `usage_events` and keyed by the record id, so the record table keeps
 * the exact shape every earlier build writes: an older app still opens and
 * writes a ledger this one touched. A record without a request row is a
 * completed single attempt (every record from before).
 */

export const REQUEST_STATUSES = ['completed', 'substituted', 'retried', 'failed'];
// `cancelled`: usage of a user's cancel, kept under its own record id (and so
// response-deduplicated) but never listed: a cancel is not a request outcome.
export const STORED_REQUEST_STATUSES = [...REQUEST_STATUSES, 'cancelled'];

// Almost every request completes: the status index holds only the others,
// and "completed" is read off the time index, where nearly every row matches.
// The model index lets a model filter find its routes without a scan.
export const REQUEST_LOG_SCHEMA = `
    CREATE TABLE IF NOT EXISTS usage_requests (
        id BLOB PRIMARY KEY, ts INTEGER NOT NULL, requested_model TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL, ttft_ms REAL, elapsed_ms REAL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_request_first_output (
        id BLOB PRIMARY KEY, ttft_ms REAL NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS usage_requests_status_time ON usage_requests(status, ts) WHERE status<>'completed';
    CREATE INDEX IF NOT EXISTS usage_events_route_time ON usage_events(route, ts);
    CREATE INDEX IF NOT EXISTS usage_routes_model ON usage_routes(json_extract(signature,'$[1]'));
`;

// The cost source of a failure that reported no usage: the request log lists
// it, but statistics and quota totals add no turn for it.
export const NO_USAGE_COST_SOURCE = 'none';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
// A provider-local retry's abandoned attempts are stored as
// `<requestId>:abandoned:N` (UTF-8 ids carry tag 0x01). They are part of
// their request, counted in its attempts, never a request of their own.
const NOT_ABANDONED = `NOT (substr(e.id,1,1)=X'01' AND instr(e.id, CAST(':abandoned:' AS BLOB))>0)`;
// The first-output time is read only from usage_request_first_output, which
// only a build that times the answering stream's first output of any kind
// writes. `usage_requests.ttft_ms` is never read: the build that added it
// (e544d62a5) timed visible text only, so a thinking or tool turn read as
// generated in a few milliseconds, and an older process may still write it.
const COLUMNS = `e.id,e.ts,e.route,e.session,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,e.duration_ms,
    r.requested_model,r.status,r.attempts,r.elapsed_ms,
    (SELECT f.ttft_ms FROM usage_request_first_output f WHERE f.id=e.id) AS first_output_ms`;
const COMPLETED = `(r.status IS NULL OR r.status='completed')`;
// Checked on the row the time-ordered read already joined: no other index.
const LISTED = `(r.status IS NULL OR r.status<>'cancelled')`;

function decodeCursor(cursor) {
  const match = typeof cursor === 'string' ? /^(\d+):([0-9a-f]+)$/.exec(cursor) : null;
  return match ? { ts: Number(match[1]), id: Buffer.from(match[2], 'hex') } : null;
}

const encodeCursor = (row) => `${row.ts}:${Buffer.from(row.id).toString('hex')}`;

const newestFirst = (a, b) => b.ts - a.ts || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));

/** The SQL of one page; `source` is the table whose index orders the read. */
export function requestPageQuery({ source, cursor = false, completed = false, routes = 0 }) {
  const alias = source === 'status' ? 'r' : 'e';
  const from =
    source === 'status'
      ? 'usage_requests r INDEXED BY usage_requests_status_time CROSS JOIN usage_events e ON e.id=r.id'
      : `usage_events e INDEXED BY ${source === 'route' ? 'usage_events_route_time' : 'usage_events_time'}
         LEFT JOIN usage_requests r ON r.id=e.id`;
  const where = [
    ...(source === 'status' ? [`r.status=? AND r.status<>'completed'`] : []),
    ...(source === 'route' ? ['e.route=?'] : []),
    `${alias}.ts>=?`,
    `${alias}.ts<=?`,
    ...(cursor ? [`(${alias}.ts<? OR ${alias}.id<?)`] : []),
    NOT_ABANDONED,
    ...(source !== 'status' ? [completed ? COMPLETED : LISTED] : []),
    ...(routes ? [`e.route IN (${Array(routes).fill('?').join(',')})`] : []),
  ];
  return `SELECT ${COLUMNS} FROM ${from} WHERE ${where.join(' AND ')}
          ORDER BY ${alias}.ts DESC, ${alias}.id DESC LIMIT ?`;
}

/**
 * `{ fromMs, toMs, status?, model?, cursor?, limit? }` → `{ requests,
 * nextCursor, models }`. `model` is the model that answered (the route's).
 * `models`, every model that answered within the period, comes with the
 * first page only (no cursor): it is the one read that visits every route.
 */
export function readUsageRequests(db, options = {}) {
  const fromMs = Number(options.fromMs) || 0;
  const toMs = Number.isFinite(Number(options.toMs)) ? Number(options.toMs) : Date.now();
  const requested = Math.floor(Number(options.limit));
  const limit = requested > 0 ? Math.min(requested, MAX_PAGE) : DEFAULT_PAGE;
  const status = REQUEST_STATUSES.includes(options.status) ? options.status : '';
  const cursor = decodeCursor(options.cursor);
  const range = [fromMs, cursor ? Math.min(toMs, cursor.ts) : toMs, ...(cursor ? [cursor.ts, cursor.id] : [])];
  const modelRoutes = options.model
    ? db
        .prepare(`SELECT id FROM usage_routes WHERE json_extract(signature,'$[1]')=?`)
        .all(String(options.model))
        .map((route) => route.id)
    : null;
  const run = (shape, params) =>
    db.prepare(requestPageQuery({ cursor: Boolean(cursor), ...shape })).all(...params, limit + 1);
  let rows;
  if (modelRoutes && !modelRoutes.length) rows = [];
  else if (status && status !== 'completed') {
    // Rare statuses: their own index, the model's routes filtered within it.
    rows = run({ source: 'status', routes: modelRoutes?.length || 0 }, [status, ...range, ...(modelRoutes || [])]);
  } else if (modelRoutes) {
    // One ordered read per route of that model, merged: never every record of it.
    rows = modelRoutes
      .flatMap((route) => run({ source: 'route', completed: Boolean(status) }, [route, ...range]))
      .sort(newestFirst)
      .slice(0, limit + 1);
  } else {
    rows = run({ source: 'time', completed: Boolean(status) }, range);
  }
  const more = rows.length > limit;
  rows = rows.slice(0, limit);

  const routeOf = db.prepare(
    `SELECT json_extract(signature,'$[0]') AS provider,json_extract(signature,'$[1]') AS model,
      json_extract(signature,'$[2]') AS kind,json_extract(signature,'$[4]') AS cost_source
     FROM usage_routes WHERE id=?`
  );
  const sessionOf = db.prepare('SELECT value FROM usage_sessions WHERE id=?');
  const ownerOf = db.prepare(
    'SELECT s.value FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner WHERE o.session=?'
  );
  const routes = new Map();
  const requests = rows.map((row) => {
    if (!routes.has(row.route)) routes.set(row.route, routeOf.get(row.route) || {});
    const route = routes.get(row.route);
    const rowStatus = row.status || 'completed';
    const durationMs = row.duration_ms || row.elapsed_ms || 0;
    const ttftMs = row.first_output_ms;
    return {
      id: Buffer.from(row.id).toString('hex'),
      ts: row.ts,
      provider: route.provider || '',
      model: route.model || '',
      requestedModel: row.requested_model || route.model || '',
      kind: route.kind || '',
      costSource: route.cost_source || '',
      sessionId: sessionOf.get(row.session)?.value || '',
      ownerSessionId: ownerOf.get(row.session)?.value || '',
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      tokens: row.input + row.output + row.cache_read + row.cache_write,
      costUsd: row.cost_usd,
      durationMs,
      ttftMs: ttftMs ?? null,
      attempts: row.attempts || 1,
      status: rowStatus,
    };
  });

  let models = null;
  if (!cursor) {
    // One indexed probe per route: does any request of it fall in the period?
    const probe = db.prepare(
      `SELECT 1 FROM usage_events e INDEXED BY usage_events_route_time LEFT JOIN usage_requests r ON r.id=e.id
       WHERE e.route=? AND e.ts>=? AND e.ts<=? AND ${NOT_ABANDONED} AND ${LISTED} LIMIT 1`
    );
    const found = new Set();
    for (const route of db.prepare(`SELECT id,json_extract(signature,'$[1]') AS model FROM usage_routes`).all()) {
      if (route.model && !found.has(route.model) && probe.get(route.id, fromMs, toMs)) found.add(route.model);
    }
    models = [...found].sort((a, b) => a.localeCompare(b));
  }
  return { requests, nextCursor: more && rows.length ? encodeCursor(rows.at(-1)) : null, models };
}
