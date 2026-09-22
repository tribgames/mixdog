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
import { isConversationUsageSource } from './usage-rollup.mjs';
import { normalizeUsageMeasurement, normalizeLegacyUsageDay } from './usage-measurement.mjs';

// The same non-negative coercion the ledger applies on write: legacy day
// documents are arbitrary retained JSON and can carry anything.
const number = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

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

const add = (target, row) => {
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
    target[field] += usage[field] || 0;
  }
  target.durationMs += row.duration_ms;
  if (row.duration_ms > 0) target.durationTurns += row.turns;
};

function readHourlyRows(db, { hourlyDay, fromDay, toDay, fromMs, toMs, fromTs, toTs }) {
  const start = new Date(`${hourlyDay}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return db
    .prepare(`
                SELECT e.ts,e.provider,e.source_type,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd
                FROM events e JOIN (${best}) b USING(day,provider,model,rank)
                WHERE e.ts>=? AND e.ts<? ORDER BY e.ts
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
                WHERE e.ts>=? AND e.ts<?
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
    const key = `${row.provider}/${row.model}`;
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

// day_sessions cannot attribute an id to a route. Use the retained
// originals, without modifying them or guessing from account/pool ids.
// Aggregate compact integer keys BEFORE decoding attribution. The old
// view decoded JSON and joined every historical request on each open.
function readSessionAttribution(db, { fromDay, toDay, fromTs, toTs }) {
  return db
    .prepare(`
            WITH grouped AS (
                SELECT day,route,session,SUM(input) AS input,SUM(output) AS output,
                    SUM(cache_read) AS cacheRead,SUM(cache_write) AS cacheWrite
                FROM usage_events WHERE ts>=? AND ts<?
                GROUP BY day,route,session
            ), attributed AS (
                SELECT printf('%04d-%02d-%02d',e.day/10000,(e.day/100)%100,e.day%100) AS day,
                    json_extract(r.signature,'$[0]') AS provider,
                    json_extract(r.signature,'$[1]') AS model,
                    json_extract(r.signature,'$[3]') AS source_type,
                    json_extract(r.signature,'$[6]') AS origin,
                    json_extract(r.signature,'$[7]') AS rank,
                    s.value AS session_id,e.input,e.output,e.cacheRead,e.cacheWrite
                FROM grouped e JOIN usage_routes r ON r.id=e.route
                JOIN usage_sessions s ON s.id=e.session
            )
            SELECT e.* FROM attributed e JOIN (${best}) b USING(day,provider,model,rank)
        `)
    .all(fromTs, toTs, fromDay, toDay);
}

function foldSessionAttribution(days, sessions) {
  for (const row of sessions) {
    const classified = row.origin !== 'trace' || Boolean(row.source_type);
    if (classified && !isConversationUsageSource(row.source_type)) continue;
    const day = days[row.day];
    const route = day.models[`${row.provider}/${row.model}`];
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
          target[field] += number(source[field]);
        if (source.costKnownTurns != null) target.costKnownTurns += number(source.costKnownTurns);
        else if (number(source.costUsd) > 0 || route.kind === 'local') target.costKnownTurns += number(source.turns);
        target.costBilled += number(source.costBilled);
        target.costEstimated += number(source.costEstimated ?? source.costUsd);
        target.sessionsComplete = false;
      };
      merge(day, route);
      merge(day.conversation, route.conversation);
      day.importedPartial = true;
      if (legacy.restored) day.restored = true;
    }
  }
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
  foldSessionAttribution(days, readSessionAttribution(db, { fromDay, toDay, fromTs, toTs }));
  // Timeless legacy totals cannot establish membership in a 24-hour window.
  // They remain available in the calendar/history views.
  if (fromMs != null) return hourly ? { days, hourly } : { days };
  mergeLegacyDays(db, { days, hourly, hourlyDay, fromDay, toDay });
  return hourly ? { days, hourly } : { days };
}
