/**
 * usage-ledger-rollup.mjs — how the ledger answers one rollup query, in the
 * order the answer has to be assembled:
 *   - the query window (calendar days, or a rolling ms range),
 *   - the per-bucket measurement algebra (empty bucket + row accumulation),
 *   - the hourly event rows of one day,
 *   - the daily amounts (cached whole days, or rebuilt from retained events
 *     when the window is partial) folded into day / route / conversation
 *     buckets,
 *   - session attribution, which day_sessions cannot express per route,
 *   - the legacy whole-day documents merged for disjoint historical routes.
 *
 * Every step reads the ledger database and writes into the day map; nothing
 * here mutates stored rows. Storage, schema and inserts stay in
 * usage-ledger.mjs.
 */
import {
  FAST_KEY,
  fastRouteSql,
  isConversationUsageSource,
  num,
  rollupRouteKey,
  usageRollupDayKey,
} from './usage-rollup.mjs';
import { normalizeUsageMeasurement, normalizeLegacyUsageDay } from './usage-measurement.mjs';
import { NO_USAGE_COST_SOURCE } from './usage-ledger-requests.mjs';

// A detail and its terminal summary can overlap on the SAME route.
// Another provider/model on that day is independent and must survive.
const best = `SELECT day,provider,model,MIN(rank) AS rank FROM daily
            WHERE day BETWEEN ? AND ? GROUP BY day,provider,model`;

/** Calendar-day bounds, or the caller's rolling millisecond window. */
function resolveWindow({ fromDay, toDay, fromMs, toMs }) {
  const fromTs = fromMs ?? (fromDay === '0000-01-01' ? 0 : new Date(`${fromDay}T00:00:00`).getTime());
  const end = toDay === '9999-12-31' ? null : new Date(`${toDay}T00:00:00`);
  if (end) end.setDate(end.getDate() + 1);
  let toTs = toMs + 1;
  if (toMs == null) toTs = end ? end.getTime() : Number.MAX_SAFE_INTEGER;
  return { fromTs, toTs };
}

const empty = () => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  costBilled: 0,
  costEstimated: 0,
  costKnownTurns: 0,
  durationMs: 0,
  durationTurns: 0,
  unmeasuredTurns: 0,
  sessions: {},
  sessionsComplete: true,
});

// `sign` -1 takes a row back out (a model's Fast calls leave its normal route).
const add = (target, row, sign = 1) => {
  const usage = normalizeUsageMeasurement(row.provider, {
    turns: row.turns,
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    costUsd: row.cost_usd,
    costKnownTurns: row.cost_source !== 'unpriced' ? row.turns : 0,
    costBilled: row.cost_source === 'provider' ? row.cost_usd : 0,
    costEstimated: row.cost_source === 'provider' ? 0 : row.cost_usd,
  });
  // A call recorded without provider usage is unmeasured whatever its provider.
  if (row.unmeasured && !usage.unmeasuredTurns) usage.unmeasuredTurns = usage.turns || 0;
  for (const field of [
    'turns',
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'costUsd',
    'costKnownTurns',
    'costBilled',
    'costEstimated',
    'unmeasuredTurns',
  ]) {
    target[field] += sign * (usage[field] || 0);
  }
  target.durationMs += sign * row.duration_ms;
  if (row.duration_ms > 0) target.durationTurns += sign * row.turns;
};

function readHourlyRows(db, { hourlyDay, fromDay, toDay, fromMs, toMs, fromTs, toTs }) {
  const start = new Date(`${hourlyDay}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return db
    .prepare(`
                SELECT e.ts,e.provider,e.source_type,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd
                FROM events e JOIN (${best}) b USING(day,provider,model,rank)
                WHERE e.ts>=? AND e.ts<? AND e.cost_source<>'${NO_USAGE_COST_SOURCE}' ORDER BY e.ts
            `)
    .all(fromDay, toDay, fromMs == null ? start.getTime() : fromTs, toMs == null ? end.getTime() : toTs)
    .map((row) => {
      const usage = normalizeUsageMeasurement(row.provider, {
        turns: 1,
        input: row.input,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        costUsd: row.cost_usd,
      });
      return {
        ...row,
        input: usage.input,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        cost_usd: usage.costUsd,
        unmeasuredTurns: usage.unmeasuredTurns || 0,
      };
    });
}

// Partial calendar days must be rebuilt from retained timestamps;
// cached whole-day totals would include usage outside a rolling window.
function readDailyAmounts(db, { fromDay, toDay, fromMs, fromTs, toTs }) {
  return fromMs == null
    ? db.prepare(`SELECT d.* FROM daily d JOIN (${best}) b USING(day,provider,model,rank)`).all(fromDay, toDay)
    : db
        .prepare(`
                SELECT e.day,e.rank,e.provider,e.model,e.kind,e.cost_source,e.source_type,
                    COUNT(*) AS turns,SUM(e.input) AS input,SUM(e.output) AS output,
                    SUM(e.cache_read) AS cache_read,SUM(e.cache_write) AS cache_write,
                    SUM(e.cost_usd) AS cost_usd,SUM(e.duration_ms) AS duration_ms,
                    MAX(e.origin!='live') AS imported
                FROM events e JOIN (${best}) b USING(day,provider,model,rank)
                WHERE e.ts>=? AND e.ts<? AND e.cost_source<>'${NO_USAGE_COST_SOURCE}'
                GROUP BY e.day,e.rank,e.provider,e.model,e.kind,e.cost_source,e.source_type
            `)
        .all(fromDay, toDay, fromTs, toTs)
        .map((row) => ({
          ...row,
          conversation: isConversationUsageSource(row.source_type),
        }));
}

function foldDailyAmounts(days, amounts) {
  for (const row of amounts) {
    days[row.day] ||= { ...empty(), models: {}, sessions: {}, conversation: empty() };
    const day = days[row.day];
    const key = rollupRouteKey(row.provider, row.model, false);
    day.models[key] ||= {
      ...empty(),
      provider: row.provider,
      model: row.model,
      kind: row.kind,
      conversation: empty(),
    };
    const route = day.models[key];
    add(day, row);
    add(route, row);
    if (row.conversation) {
      add(day.conversation, row);
      add(route.conversation, row);
    }
    if (row.imported) day.importedPartial = true;
  }
}

// Fast-mode calls (the tier is on the route signature, not in the daily
// totals) read from the retained originals, to become a route of their own.
function readFastAmounts(db, { fromDay, toDay, fromTs, toTs }) {
  const ts = fromTs > 0 || toTs < Number.MAX_SAFE_INTEGER ? 'e.ts' : '+e.ts';
  // Routes are few and events many: a ledger with no Fast route (nearly all of
  // them) skips the event scan, and the tier is read once per route, not per event.
  const fastRoutes = `SELECT r.id,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[2]') AS kind,
                    json_extract(r.signature,'$[3]') AS source_type,
                    json_extract(r.signature,'$[4]') AS cost_source,
                    json_extract(r.signature,'$[7]') AS rank
                FROM usage_routes r WHERE ${fastRouteSql('r.signature')}
                    AND json_extract(r.signature,'$[4]')<>'${NO_USAGE_COST_SOURCE}'`;
  if (!db.prepare(`${fastRoutes} LIMIT 1`).get()) return [];
  return db
    .prepare(`
            WITH fast_routes AS MATERIALIZED (${fastRoutes}), fast AS (
                SELECT printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
                    r.provider,r.model,r.kind,r.source_type,r.cost_source,r.rank,
                    e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,e.duration_ms
                FROM usage_events e JOIN fast_routes r ON r.id=e.route
                WHERE ${ts}>=? AND ${ts}<?
            )
            SELECT f.day,f.rank,f.provider,f.model,f.kind,f.cost_source,f.source_type,
                COUNT(*) AS turns,SUM(f.input) AS input,SUM(f.output) AS output,
                SUM(f.cache_read) AS cache_read,SUM(f.cache_write) AS cache_write,
                SUM(f.cost_usd) AS cost_usd,SUM(f.duration_ms) AS duration_ms
            FROM fast f JOIN (${best}) b USING(day,provider,model,rank)
            GROUP BY f.day,f.rank,f.provider,f.model,f.kind,f.cost_source,f.source_type
        `)
    .all(fromTs, toTs, fromDay, toDay);
}

function foldFastAmounts(days, rows) {
  for (const row of rows) {
    const normal = days[row.day]?.models[rollupRouteKey(row.provider, row.model, false)];
    if (!normal) continue;
    const models = days[row.day].models;
    const key = rollupRouteKey(row.provider, row.model, true);
    models[key] ||= {
      ...empty(),
      provider: row.provider,
      model: row.model,
      kind: row.kind,
      conversation: empty(),
      fast: true,
    };
    const conversation = isConversationUsageSource(row.source_type);
    for (const [target, sign] of [
      [models[key], 1],
      [normal, -1],
    ]) {
      add(target, row, sign);
      if (conversation) add(target.conversation, row, sign);
    }
  }
  // A model used only in Fast mode keeps just its Fast row.
  for (const day of Object.values(days)) {
    for (const [key, route] of Object.entries(day.models)) {
      if (!route.fast && route.turns <= 0 && day.models[key + FAST_KEY]) delete day.models[key];
    }
  }
}

// day_sessions cannot attribute an id to a route. Use the retained
// originals, without modifying them or guessing from account/pool ids.
// Aggregate compact integer keys BEFORE decoding attribution. The old
// view decoded JSON and joined every historical request on each open.
// An unbounded window matches every row: `+ts` then scans the table instead of
// paying one primary-key search per usage_events_time entry in this WITHOUT
// ROWID table (~90 ms vs ~330 ms over 120k real rows). A bounded window keeps
// the index.
function readSessionAttribution(db, { fromDay, toDay, fromTs, toTs }) {
  const ts = fromTs > 0 || toTs < Number.MAX_SAFE_INTEGER ? 'ts' : '+ts';
  return db
    .prepare(`
            WITH grouped AS (
                SELECT day,route,session,SUM(input) AS input,SUM(output) AS output,
                    SUM(cache_read) AS cacheRead,SUM(cache_write) AS cacheWrite
                FROM usage_events WHERE ${ts}>=? AND ${ts}<?
                GROUP BY day,route,session
            ), attributed AS (
                SELECT printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[3]') AS source_type,
                    json_extract(r.signature,'$[6]') AS origin,
                    json_extract(r.signature,'$[7]') AS rank,
                    ${fastRouteSql('r.signature')} AS fast,
                    s.value AS session_id,e.input,e.output,e.cacheRead,e.cacheWrite
                FROM grouped e JOIN usage_routes r ON r.id=e.route
                JOIN usage_sessions s ON s.id=e.session
                WHERE json_extract(r.signature,'$[4]')<>'${NO_USAGE_COST_SOURCE}'
            )
            SELECT e.* FROM attributed e JOIN (${best}) b USING(day,provider,model,rank)
        `)
    .all(fromTs, toTs, fromDay, toDay);
}

// Output speed: output tokens over the wall time of the requests that produced
// them. Only timed requests with output count — imported history carries no
// duration — so untimed output never dilutes a route's figure.
function readOutputSpeed(db, { fromDay, toDay, fromTs, toTs }) {
  const ts = fromTs > 0 || toTs < Number.MAX_SAFE_INTEGER ? 'ts' : '+ts';
  return db
    .prepare(`
            WITH timed AS (
                SELECT day,route,SUM(output) AS output,SUM(duration_ms) AS duration_ms
                FROM usage_events WHERE ${ts}>=? AND ${ts}<? AND duration_ms>0 AND output>0
                GROUP BY day,route
            ), attributed AS (
                SELECT printf('%04d-%02d-%02d',t.day/10000,(t.day/100)%100,t.day%100) AS day,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[7]') AS rank,
                    ${fastRouteSql('r.signature')} AS fast,
                    t.output,t.duration_ms
                FROM timed t JOIN usage_routes r ON r.id=t.route
            )
            SELECT a.* FROM attributed a JOIN (${best}) b USING(day,provider,model,rank)
        `)
    .all(fromTs, toTs, fromDay, toDay);
}

function foldOutputSpeed(days, rows) {
  for (const row of rows) {
    const route = days[row.day]?.models[rollupRouteKey(row.provider, row.model, row.fast)];
    if (!route) continue;
    route.speedOutput = (route.speedOutput || 0) + row.output;
    route.speedMs = (route.speedMs || 0) + row.duration_ms;
  }
}

function foldSessionAttribution(days, sessions) {
  for (const row of sessions) {
    const classified = row.origin !== 'trace' || Boolean(row.source_type);
    if (classified && !isConversationUsageSource(row.source_type)) continue;
    const day = days[row.day];
    const route = day.models[rollupRouteKey(row.provider, row.model, row.fast)];
    for (const target of [day, route, day.conversation, route.conversation]) {
      // Old raw traces used session_id for account/socket scopes too.
      // Without source attribution they cannot establish a session count.
      if (!classified || !row.session_id || ['no-session', '(none)'].includes(row.session_id)) {
        target.sessionsComplete = false;
      } else {
        const usage = normalizeUsageMeasurement(row.provider, row);
        const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        target.sessions[row.session_id] = (target.sessions[row.session_id] || 0) + tokens;
      }
    }
  }
}

function mergeLegacyDays(db, { days, hourly, hourlyDay, fromDay, toDay }) {
  for (const row of db.prepare('SELECT day,document FROM legacy_days WHERE day BETWEEN ? AND ?').all(fromDay, toDay)) {
    const legacy = normalizeLegacyUsageDay(JSON.parse(row.document));
    const day = days[row.day];
    if (!day) {
      days[row.day] = { ...legacy, importedPartial: true };
      if (row.day === hourlyDay) hourly.unallocated.push(...Object.values(legacy.models || {}));
      continue;
    }
    for (const [key, route] of Object.entries(legacy.models || {})) {
      if (day.models[key]) continue;
      // Preserve a disjoint historical route, not an inferred balance
      // of an overlapping one. Whole-day session ids cannot be assigned
      // to just this route, so its session count remains unknown.
      day.models[key] = { ...route, sessionsComplete: false };
      if (row.day === hourlyDay) hourly.unallocated.push(route);
      const merge = (target, source) => {
        if (!source) return;
        for (const field of [
          'turns',
          'input',
          'output',
          'cacheRead',
          'cacheWrite',
          'costUsd',
          'durationMs',
          'durationTurns',
          'unmeasuredTurns',
        ])
          target[field] += num(source[field]);
        if (source.costKnownTurns != null) target.costKnownTurns += num(source.costKnownTurns);
        else if (num(source.costUsd) > 0 || route.kind === 'local') target.costKnownTurns += num(source.turns);
        target.costBilled += num(source.costBilled);
        target.costEstimated += num(source.costEstimated ?? source.costUsd);
        target.sessionsComplete = false;
      };
      merge(day, route);
      merge(day.conversation, route.conversation);
      day.importedPartial = true;
      if (legacy.restored) day.restored = true;
    }
  }
}

/**
 * One session's lifetime totals over every id its spend was recorded under.
 * Compaction requests run under their own provider session id but are
 * recorded under the source session, so this is the whole conversation
 * across compactions. The same route choice as a rollup applies: a gateway
 * summary never doubles a detail record. `ownerIds` adds every session
 * recorded as run for one of them (a Lead's agents, theirs in turn).
 */
export function readSessionUsage(db, sessionIds, ownerIds = []) {
  // The sums answer only once they hold every stored record.
  if (!sessionDaysComplete(db)) throw new Error('The usage ledger is still building its session sums');
  const total = empty();
  const rows = db
    .prepare(`
            WITH RECURSIVE owned(id) AS (
                SELECT o.session FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner
                WHERE s.value IN (SELECT value FROM json_each(?))
                UNION
                SELECT o.session FROM usage_session_owners o JOIN owned ON o.owner=owned.id
            ), mine AS (
                SELECT day,route,SUM(turns) AS turns,SUM(input) AS input,SUM(output) AS output,
                    SUM(cache_read) AS cache_read,SUM(cache_write) AS cache_write,
                    SUM(cost_usd) AS cost_usd,SUM(duration_ms) AS duration_ms,
                    SUM(speed_output) AS speed_output,SUM(speed_ms) AS speed_ms
                FROM usage_session_days WHERE session IN (
                    SELECT id FROM usage_sessions WHERE value IN (SELECT value FROM json_each(?))
                    UNION SELECT id FROM owned)
                GROUP BY day,route
            ), attributed AS (
                SELECT printf('%04d-%02d-%02d',m.day/10000,(m.day/100)%100,m.day%100) AS day,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[4]') AS cost_source,
                    json_extract(r.signature,'$[7]') AS rank,
                    COALESCE(json_extract(json_extract(r.signature,'$[5]'),'$.inputTokensKnown'),1)=0 AS unmeasured,
                    m.turns,m.input,m.output,m.cache_read,m.cache_write,m.cost_usd,m.duration_ms,
                    m.speed_output,m.speed_ms
                FROM mine m JOIN usage_routes r ON r.id=m.route
                WHERE json_extract(r.signature,'$[4]')<>'${NO_USAGE_COST_SOURCE}'
            )
            SELECT a.* FROM attributed a JOIN (${best}) b USING(day,provider,model,rank)
        `)
    .all(JSON.stringify(ownerIds), JSON.stringify(sessionIds), '0000-01-01', '9999-12-31');
  let speedOutput = 0;
  let speedMs = 0;
  for (const row of rows) {
    add(total, row);
    speedOutput += row.speed_output;
    speedMs += row.speed_ms;
  }
  const { sessions, sessionsComplete, ...usage } = total;
  return { ...usage, speedOutput, speedMs };
}

const DAY_KEY = (alias) => `printf('%04d-%02d-%02d',${alias}.day/10000,(${alias}.day/100)%100,${alias}.day%100)`;
const BUMP = (day) => `INSERT INTO day_revisions(day,rev) VALUES(${day},1) ON CONFLICT(day) DO UPDATE SET rev=rev+1;`;
const TRIGGER_ROWS = { INSERT: ['NEW'], DELETE: ['OLD'], UPDATE: ['OLD', 'NEW'] };
const triggers = (name, table, events, days) =>
  events
    .map(
      (event) => `CREATE TRIGGER IF NOT EXISTS ${name}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN ${TRIGGER_ROWS[event].map((row) => BUMP(days(row))).join(' ')} END;`
    )
    .join('\n');
const ALL = ['INSERT', 'UPDATE', 'DELETE'];
// Rows that change what a route/session means (price repairs rewrite route
// signatures) can touch any day, so they bump the global revision ('').
const GLOBAL_BUMP = BUMP("''");

/**
 * What a completed day's rollup is a function of is written only through
 * these tables, so SQLite triggers (in the writer's own transaction, for
 * every connection and process) bump that day's revision on any insert,
 * update or delete. A route or session row changing bumps the global
 * revision instead, invalidating every held day.
 */
export const DAY_REVISION_SCHEMA = `
    CREATE TABLE IF NOT EXISTS day_revisions (day TEXT PRIMARY KEY, rev INTEGER NOT NULL) WITHOUT ROWID;
    ${triggers('day_rev_events', 'usage_events', ALL, DAY_KEY)}
    ${triggers('day_rev_daily', 'daily', ALL, (row) => `${row}.day`)}
    ${triggers('day_rev_sessions', 'day_sessions', ALL, (row) => `${row}.day`)}
    ${triggers('day_rev_legacy', 'legacy_days', ALL, (row) => `${row}.day`)}
    CREATE TRIGGER IF NOT EXISTS day_rev_routes_update AFTER UPDATE ON usage_routes BEGIN ${GLOBAL_BUMP} END;
    CREATE TRIGGER IF NOT EXISTS day_rev_routes_delete AFTER DELETE ON usage_routes BEGIN ${GLOBAL_BUMP} END;
    CREATE TRIGGER IF NOT EXISTS day_rev_session_names_update AFTER UPDATE ON usage_sessions BEGIN ${GLOBAL_BUMP} END;
    CREATE TRIGGER IF NOT EXISTS day_rev_session_names_delete AFTER DELETE ON usage_sessions BEGIN ${GLOBAL_BUMP} END;
`;

// A session's records summed per day and route, so a session read adds up
// that many rows instead of scanning every record. Route is the grain the
// route selection works on (`best`, the minimum-rank rule, stays in the read
// query and is applied to these sums exactly as it was to the records), so
// nothing about which record counts is decided here. Triggers keep the sums
// equal to usage_events for every writer and process, whatever the statement
// (insert, update, delete, or either with OR REPLACE / OR IGNORE).
const SESSION_DAY_SUMS = (row, sign) => {
  const speed = `${row}.duration_ms>0 AND ${row}.output>0`;
  return `${sign}1,${sign}${row}.input,${sign}${row}.output,${sign}${row}.cache_read,${sign}${row}.cache_write,
        ${sign}COALESCE(${row}.cost_usd,0),${sign}${row}.duration_ms,
        ${sign}CASE WHEN ${speed} THEN ${row}.output ELSE 0 END,${sign}CASE WHEN ${speed} THEN ${row}.duration_ms ELSE 0 END`;
};
// A session whose range the build has not reached is left to it: the build
// recomputes the whole range from the records, so a delta applied beforehand
// (a delete of its last record, say, subtracting from sums not yet built)
// would only corrupt what it then replaces.
const SESSION_BUILT = (row) => `(SELECT complete=1 OR ${row}.session<next FROM usage_session_days_state)`;
const SESSION_DAY_UPSERT = (row, sign) => `INSERT INTO usage_session_days
        SELECT ${row}.session,${row}.day,${row}.route,${SESSION_DAY_SUMS(row, sign)},
        ${ROUTE_FIELD(`${row}.route`, 0)},${ROUTE_FIELD(`${row}.route`, 1)} WHERE ${SESSION_BUILT(row)}
        ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
        output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
        cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
        duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
        speed_ms=speed_ms+excluded.speed_ms;`;

// Revisions, three kinds, all moved by triggers so every connection and
// process moves them. What a session's numbers are a function of:
//  - its own records: a revision per session;
//  - the rank selection of each day/provider/model route its records sit on,
//    which another session's record can change (a detail supersedes a gateway
//    summary): a revision per route key, bumped when the minimum rank stored
//    for the key changes, and for both keys when a record moves routes;
//  - who ran for whom (moved or removed links), session names and the route
//    definitions: one membership revision.
// A group's token (readUsageToken) combines the ones its sessions depend on.
const BUMP_SESSION = (session) =>
  `INSERT INTO usage_session_revisions VALUES (${session},1) ON CONFLICT(session) DO UPDATE SET rev=rev+1;`;
const BUMP_KEY = (day, provider, model) =>
  `INSERT INTO usage_key_revisions VALUES (${day},${provider},${model},1)
        ON CONFLICT(day,provider,model) DO UPDATE SET rev=rev+1;`;
const BUMP_MEMBERSHIP = 'UPDATE usage_membership_revision SET rev=rev+1;';
const ROUTE_FIELD = (route, index) => `(SELECT json_extract(signature,'$[${index}]') FROM usage_routes WHERE id=${route})`;
const BUMP_EVENT_KEY = (row) =>
  BUMP_KEY(`${row}.day`, ROUTE_FIELD(`${row}.route`, 0), ROUTE_FIELD(`${row}.route`, 1));
const BUMP_DAILY_KEY = (row) =>
  BUMP_KEY(`CAST(REPLACE(${row}.day,'-','') AS INTEGER)`, `${row}.provider`, `${row}.model`);
const DAILY_OTHERS = (row) => `day=${row}.day AND provider=${row}.provider AND model=${row}.model`;
const MEMBERSHIP_TRIGGERS = [
  ['usage_routes', ['UPDATE', 'DELETE']],
  ['usage_sessions', ['UPDATE', 'DELETE']],
  // A new link only adds a member, which the token counts; moving or removing one can net out.
  ['usage_session_owners', ['UPDATE', 'DELETE']],
]
  .flatMap(([table, events]) =>
    events.map(
      (event) => `CREATE TRIGGER IF NOT EXISTS membership_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN ${BUMP_MEMBERSHIP} END;`
    )
  )
  .join('\n');
const SESSION_DAYS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS usage_session_days (
        session INTEGER NOT NULL, day INTEGER NOT NULL, route INTEGER NOT NULL,
        turns INTEGER NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
        cache_read REAL NOT NULL, cache_write REAL NOT NULL, cost_usd REAL NOT NULL,
        duration_ms REAL NOT NULL, speed_output REAL NOT NULL, speed_ms REAL NOT NULL,
        -- The route's provider and model, kept beside it for the route-key revisions.
        provider TEXT, model TEXT,
        PRIMARY KEY(session,day,route)
    ) WITHOUT ROWID;
    -- Where the build of the sums from the records already stored has got to:
    -- sessions below \`next\` are built. The sums are read only once complete.
    CREATE TABLE IF NOT EXISTS usage_session_days_state (
        id INTEGER PRIMARY KEY CHECK(id=1), complete INTEGER NOT NULL, next INTEGER NOT NULL);
    INSERT OR IGNORE INTO usage_session_days_state
        SELECT 1,NOT EXISTS(SELECT 1 FROM usage_events),0;
    CREATE TABLE IF NOT EXISTS usage_session_revisions (session INTEGER PRIMARY KEY, rev INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_key_revisions (
        day INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, rev INTEGER NOT NULL,
        PRIMARY KEY(day,provider,model)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_membership_revision (id INTEGER PRIMARY KEY CHECK(id=1), rev INTEGER NOT NULL);
    INSERT OR IGNORE INTO usage_membership_revision VALUES (1,0);
    -- A record id is stored once. Say so for every statement form: an OR REPLACE
    -- deletes the old row without firing delete triggers (unless a connection
    -- sets recursive_triggers), which would leave its sums behind.
    CREATE TRIGGER IF NOT EXISTS session_days_duplicate BEFORE INSERT ON usage_events
        WHEN EXISTS (SELECT 1 FROM usage_events WHERE id=NEW.id) BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER IF NOT EXISTS session_days_id BEFORE UPDATE OF id ON usage_events
        WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'a usage record id does not change'); END;
    CREATE TRIGGER IF NOT EXISTS session_days_insert AFTER INSERT ON usage_events
        BEGIN ${SESSION_DAY_UPSERT('NEW', '')} ${BUMP_SESSION('NEW.session')} END;
    CREATE TRIGGER IF NOT EXISTS session_days_delete AFTER DELETE ON usage_events
        BEGIN ${SESSION_DAY_UPSERT('OLD', '-')} ${BUMP_SESSION('OLD.session')} END;
    CREATE TRIGGER IF NOT EXISTS session_days_update AFTER UPDATE ON usage_events
        BEGIN ${SESSION_DAY_UPSERT('OLD', '-')} ${SESSION_DAY_UPSERT('NEW', '')}
        ${BUMP_SESSION('OLD.session')} ${BUMP_SESSION('NEW.session')} END;
    CREATE TRIGGER IF NOT EXISTS key_revision_event_route AFTER UPDATE OF route,day ON usage_events
        WHEN OLD.route IS NOT NEW.route OR OLD.day IS NOT NEW.day
        BEGIN ${BUMP_EVENT_KEY('OLD')} ${BUMP_EVENT_KEY('NEW')} END;
    -- The rank a key is read at is the lowest stored for it (\`best\`).
    CREATE TRIGGER IF NOT EXISTS key_revision_daily_insert AFTER INSERT ON daily
        WHEN NEW.rank < COALESCE((SELECT MIN(rank) FROM daily WHERE ${DAILY_OTHERS('NEW')}
            AND NOT (rank=NEW.rank AND kind=NEW.kind AND cost_source=NEW.cost_source
                AND conversation=NEW.conversation)),1000000)
        BEGIN ${BUMP_DAILY_KEY('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS key_revision_daily_delete AFTER DELETE ON daily
        WHEN OLD.rank <= COALESCE((SELECT MIN(rank) FROM daily WHERE ${DAILY_OTHERS('OLD')}),1000000)
        BEGIN ${BUMP_DAILY_KEY('OLD')} END;
    CREATE TRIGGER IF NOT EXISTS key_revision_daily_update AFTER UPDATE ON daily
        WHEN OLD.rank IS NOT NEW.rank OR OLD.day IS NOT NEW.day OR OLD.provider IS NOT NEW.provider
            OR OLD.model IS NOT NEW.model
        BEGIN ${BUMP_DAILY_KEY('OLD')} ${BUMP_DAILY_KEY('NEW')} END;
    -- A route rewritten to another provider or model carries its sums with it.
    CREATE TRIGGER IF NOT EXISTS session_days_route AFTER UPDATE OF signature ON usage_routes
        WHEN json_extract(OLD.signature,'$[0]') IS NOT json_extract(NEW.signature,'$[0]')
            OR json_extract(OLD.signature,'$[1]') IS NOT json_extract(NEW.signature,'$[1]')
        BEGIN
            UPDATE usage_session_days SET provider=json_extract(NEW.signature,'$[0]'),
                model=json_extract(NEW.signature,'$[1]') WHERE route=NEW.id;
        END;
    ${MEMBERSHIP_TRIGGERS}
`;
/**
 * Creates the sums, their triggers and the ledger revision, in one short
 * transaction. Cheap whatever the ledger's size: it never builds the sums from
 * stored records (see buildSessionDaysStep), so the thread that opens the
 * ledger is never held up by it.
 */
export function prepareSessionDays(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SESSION_DAYS_SCHEMA);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function sessionDaysComplete(db) {
  return db.prepare('SELECT complete FROM usage_session_days_state').get()?.complete === 1;
}

/** Records one build step covers, at most (a single session may exceed it). */
export const SESSION_DAYS_STEP_EVENTS = 40_000;

/**
 * Builds the sums from the stored records a step of sessions at a time, each
 * step its own short transaction that also commits how far it got, so a
 * ledger of any size can be built without holding the write lock for long,
 * be interrupted at any point, and be resumed by this or another process. A
 * step recomputes its sessions from the records, and the triggers apply
 * deltas only to sessions already built, so a write that lands between steps
 * is counted once whichever side of the build it falls. Returns true when the
 * sums are complete.
 */
export function buildSessionDaysStep(db, budget = SESSION_DAYS_STEP_EVENTS) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const { complete, next } = db.prepare('SELECT complete,next FROM usage_session_days_state').get();
    if (complete) {
      db.exec('COMMIT');
      return true;
    }
    let last = null;
    let events = 0;
    let exhausted = true;
    const sessions = db.prepare(
      'SELECT session,COUNT(*) AS n FROM usage_events WHERE session>=? GROUP BY session ORDER BY session'
    );
    for (const row of sessions.iterate(next)) {
      if (last !== null && events + row.n > budget) {
        exhausted = false;
        break;
      }
      last = row.session;
      events += row.n;
    }
    // The last step also clears whatever lies beyond the sessions that still have records.
    if (exhausted) db.prepare('DELETE FROM usage_session_days WHERE session>=?').run(next);
    else db.prepare('DELETE FROM usage_session_days WHERE session BETWEEN ? AND ?').run(next, last);
    if (last !== null) {
      db.prepare(`INSERT INTO usage_session_days
        SELECT e.session,e.day,e.route,COUNT(*),SUM(e.input),SUM(e.output),SUM(e.cache_read),SUM(e.cache_write),
            SUM(COALESCE(e.cost_usd,0)),SUM(e.duration_ms),
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END),
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END),
            json_extract(r.signature,'$[0]'),json_extract(r.signature,'$[1]')
        FROM usage_events e JOIN usage_routes r ON r.id=e.route
        WHERE e.session BETWEEN ? AND ? GROUP BY e.session,e.day,e.route`).run(next, last);
    }
    db.prepare('UPDATE usage_session_days_state SET complete=?,next=? WHERE id=1').run(
      exhausted ? 1 : 0,
      last === null ? next : last + 1
    );
    db.exec('COMMIT');
    return exhausted;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Builds the sums to completion in this thread (small ledgers and tests; the ledger worker steps through it). */
export function buildSessionDays(db, budget) {
  while (!buildSessionDaysStep(db, budget));
}

/**
 * The token of a group of sessions: it changes whenever a number readSessionUsage
 * would return for the group can have changed, and not otherwise. A group is
 * the sessions named (`sessionIds`, owners and listed agents) and every
 * session recorded as run for one of `ownerIds`, transitively, as in the read.
 * It combines the revisions of those sessions, of the route keys their
 * records sit on, and the membership revision (see the schema above).
 */
export function readUsageToken(db, sessionIds, ownerIds = []) {
  const row = db
    .prepare(`
        WITH RECURSIVE owned(id) AS (
            SELECT o.session FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner
            WHERE s.value IN (SELECT value FROM json_each(?))
            UNION
            SELECT o.session FROM usage_session_owners o JOIN owned ON o.owner=owned.id
        ), members AS (
            SELECT id FROM usage_sessions WHERE value IN (SELECT value FROM json_each(?))
            UNION SELECT id FROM owned
        )
        SELECT (SELECT rev FROM usage_membership_revision) AS membership,
            (SELECT COUNT(*) FROM members) AS members,
            (SELECT COALESCE(SUM(rev),0) FROM usage_session_revisions WHERE session IN (SELECT id FROM members)) AS sessions,
            -- Route keys are revised rarely (only when a rank selection or a record's route changes),
            -- so the few revised keys are looked up in the group's sums, not the group's rows listed.
            (SELECT COALESCE(SUM(k.rev),0) FROM usage_key_revisions k WHERE EXISTS (
                SELECT 1 FROM usage_session_days d WHERE d.session IN (SELECT id FROM members)
                    AND d.day=k.day AND d.provider=k.provider AND d.model=k.model)) AS keys
    `)
    .get(JSON.stringify(ownerIds), JSON.stringify(sessionIds));
  return `${row.membership}.${row.members}.${row.sessions}.${row.keys}`;
}

// In-window days (those with any stored rollup input) with their revisions.
function readDayFingerprints(db, fromDay, toDay) {
  const global = db.prepare("SELECT rev FROM day_revisions WHERE day=''").get()?.rev ?? 0;
  const revisions = new Map(
    db
      .prepare("SELECT day,rev FROM day_revisions WHERE day<>'' AND day BETWEEN ? AND ?")
      .all(fromDay, toDay)
      .map((row) => [row.day, row.rev])
  );
  const days = db
    .prepare(
      `SELECT day FROM daily WHERE day BETWEEN ?1 AND ?2 UNION SELECT day FROM day_sessions WHERE day BETWEEN ?1 AND ?2
       UNION SELECT day FROM legacy_days WHERE day BETWEEN ?1 AND ?2`
    )
    .all(fromDay, toDay);
  return Object.fromEntries(days.map(({ day }) => [day, `${global}:${revisions.get(day) ?? 0}`]));
}

const DELTA_DAY_QUERIES = 8;

/**
 * The part of a whole-day rollup that `known` (day -> fingerprint of the
 * result the caller already holds) cannot answer: every day that is today or
 * later, the hourly day, and any day whose fingerprint moved. Returns every
 * in-window fingerprint plus the recomputed days; assembleRollup() merges
 * them with the caller's held days into exactly rollupUsage()'s answer. A
 * rolling (`fromMs`) window has no reusable day totals and is not served here.
 */
export function rollupDelta(db, options = {}, known = {}, now = Date.now()) {
  const { hourlyDay = null, fromDay = '0000-01-01', toDay = '9999-12-31' } = options;
  const fingerprints = readDayFingerprints(db, fromDay, toDay);
  const today = usageRollupDayKey(now);
  const stale = Object.keys(fingerprints).filter(
    (day) => day === hourlyDay || day >= today || known[day] !== fingerprints[day]
  );
  if (stale.length > DELTA_DAY_QUERIES) {
    const full = rollupUsage(db, { hourlyDay, fromDay, toDay });
    const fresh = Object.fromEntries(Object.keys(fingerprints).map((day) => [day, full.days[day] ?? null]));
    return { fingerprints, fresh, ...(full.hourly ? { hourly: full.hourly } : {}) };
  }
  const fresh = {};
  let hourly = hourlyDay ? { rows: [], unallocated: [] } : null;
  for (const day of stale) {
    const part = rollupUsage(db, { fromDay: day, toDay: day, hourlyDay: day === hourlyDay ? day : null });
    fresh[day] = part.days[day] ?? null;
    if (part.hourly) hourly = part.hourly;
  }
  return { fingerprints, fresh, ...(hourly ? { hourly } : {}) };
}

/** `known` argument for rollupDelta from the caller's completed-day store. */
export function knownRollupDays(store) {
  return Object.fromEntries([...store].map(([day, entry]) => [day, entry.fingerprint]));
}

/** Merge a rollupDelta() answer with the held completed days (day -> {fingerprint,value}). */
export function assembleRollup(store, delta, now = Date.now()) {
  const today = usageRollupDayKey(now);
  const days = {};
  for (const day of Object.keys(delta.fingerprints).sort()) {
    let value;
    if (day in delta.fresh) {
      value = delta.fresh[day];
      if (day < today) store.set(day, { fingerprint: delta.fingerprints[day], value });
    } else value = store.get(day).value;
    if (value) days[day] = value;
  }
  return delta.hourly ? { days, hourly: delta.hourly } : { days };
}

/** Read cached amounts; group retained attribution separately for distinct sessions. */
export function rollupUsage(
  db,
  { hourlyDay = null, fromDay = '0000-01-01', toDay = '9999-12-31', fromMs = null, toMs = null } = {}
) {
  const days = {};
  const hourly = hourlyDay ? { rows: [], unallocated: [] } : null;
  const { fromTs, toTs } = resolveWindow({ fromDay, toDay, fromMs, toMs });
  if (hourly) {
    hourly.rows = readHourlyRows(db, { hourlyDay, fromDay, toDay, fromMs, toMs, fromTs, toTs });
  }
  foldDailyAmounts(days, readDailyAmounts(db, { fromDay, toDay, fromMs, fromTs, toTs }));
  foldFastAmounts(days, readFastAmounts(db, { fromDay, toDay, fromTs, toTs }));
  foldOutputSpeed(days, readOutputSpeed(db, { fromDay, toDay, fromTs, toTs }));
  foldSessionAttribution(days, readSessionAttribution(db, { fromDay, toDay, fromTs, toTs }));
  // Timeless legacy totals cannot establish membership in a 24-hour window.
  // They remain available in the calendar/history views.
  if (fromMs != null) return hourly ? { days, hourly } : { days };
  mergeLegacyDays(db, { days, hourly, hourlyDay, fromDay, toDay });
  return hourly ? { days, hourly } : { days };
}
