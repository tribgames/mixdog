//! How the ledger answers one rollup query (`usage-ledger-rollup.mjs` `rollupUsage`), in
//! the order the answer is assembled: the query window, the hourly event rows of one day,
//! the daily amounts folded into day / route / conversation buckets, Fast-mode routes,
//! output speed, session attribution, and the legacy whole-day documents.
//!
//! Every step reads the ledger and writes into the day map; nothing here mutates stored
//! rows. Reads run on a reader snapshot.

use std::collections::BTreeMap;

use serde_json::Map;
use serde_json::Value;

use crate::bucket::Amount;
use crate::bucket::Bucket;
use crate::db::Connection;
use crate::db::params;
use crate::error::LedgerError;
use crate::error::Result;
use crate::measure::FAST_KEY;
use crate::measure::NO_USAGE_COST_SOURCE;
use crate::measure::day_text_sql;
use crate::measure::fast_route_sql;
use crate::measure::is_conversation_source;
use crate::measure::is_unmeasuring_provider;
use crate::measure::js_number;
use crate::measure::json_or_zero;
use crate::measure::num;
use crate::measure::route_key;
use crate::time::MAX_SAFE_INTEGER;
use crate::time::local_midnight_ms;
use crate::time::next_midnight_ms;
use crate::time::parse_day;

/// A detail and its terminal summary can overlap on the SAME route; another provider/model
/// on that day is independent and must survive. Takes the day range as its two parameters.
pub const BEST_SQL: &str = "SELECT day,provider,model,MIN(rank) AS rank FROM daily
            WHERE day BETWEEN ? AND ? GROUP BY day,provider,model";

pub const FIRST_DAY: &str = "0000-01-01";
pub const LAST_DAY: &str = "9999-12-31";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollupQuery {
    pub from_day: String,
    pub to_day: String,
    /// A rolling millisecond window instead of whole days.
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub hourly_day: Option<String>,
}

impl Default for RollupQuery {
    fn default() -> Self {
        RollupQuery {
            from_day: FIRST_DAY.to_string(),
            to_day: LAST_DAY.to_string(),
            from_ms: None,
            to_ms: None,
            hourly_day: None,
        }
    }
}

impl RollupQuery {
    pub fn days(from_day: &str, to_day: &str) -> Self {
        RollupQuery {
            from_day: from_day.to_string(),
            to_day: to_day.to_string(),
            ..Self::default()
        }
    }
}

/// `{days, hourly?}`. Day values are the rollup JSON objects.
#[derive(Clone, Debug, PartialEq)]
pub struct Rollup {
    pub days: BTreeMap<String, Value>,
    pub hourly: Option<Value>,
}

impl Rollup {
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "days".to_string(),
            Value::Object(
                self.days
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
        );
        if let Some(hourly) = &self.hourly {
            out.insert("hourly".to_string(), hourly.clone());
        }
        Value::Object(out)
    }
}

/// Calendar-day bounds, or the caller's rolling millisecond window.
fn resolve_window(query: &RollupQuery) -> Result<(i64, i64)> {
    let from = match query.from_ms {
        Some(ms) => ms,
        None if query.from_day == FIRST_DAY => 0,
        None => local_midnight_ms(parse_day(&query.from_day)?),
    };
    let to = match query.to_ms {
        Some(ms) => ms + 1,
        None if query.to_day == LAST_DAY => MAX_SAFE_INTEGER,
        None => next_midnight_ms(parse_day(&query.to_day)?),
    };
    Ok((from, to))
}

/// Stored amounts of one (day, route) from `daily`, from retained events, or from a Fast
/// route's events.
struct AmountRow {
    day: String,
    provider: String,
    model: String,
    kind: String,
    cost_source: String,
    conversation: bool,
    turns: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: Option<f64>,
    duration_ms: f64,
    imported: bool,
}

impl AmountRow {
    fn amount(&self) -> Amount<'_> {
        Amount {
            provider: &self.provider,
            turns: self.turns,
            input: self.input,
            output: self.output,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            cost_usd: self.cost_usd,
            cost_source: &self.cost_source,
            duration_ms: self.duration_ms,
            unmeasured: false,
        }
    }
}

struct Route {
    bucket: Bucket,
    provider: String,
    model: String,
    kind: String,
    conversation: Bucket,
    fast: bool,
    speed: Option<(f64, f64)>,
}

impl Route {
    fn new(row: &AmountRow, fast: bool) -> Self {
        Route {
            bucket: Bucket::new(),
            provider: row.provider.clone(),
            model: row.model.clone(),
            kind: row.kind.clone(),
            conversation: Bucket::new(),
            fast,
            speed: None,
        }
    }

    fn to_value(&self) -> Value {
        let mut out = self.bucket.to_object();
        out.insert("provider".to_string(), Value::from(self.provider.as_str()));
        out.insert("model".to_string(), Value::from(self.model.as_str()));
        out.insert("kind".to_string(), Value::from(self.kind.as_str()));
        out.insert(
            "conversation".to_string(),
            Value::Object(self.conversation.to_object()),
        );
        if self.fast {
            out.insert("fast".to_string(), Value::Bool(true));
        }
        if let Some((output, ms)) = self.speed {
            out.insert("speedOutput".to_string(), js_number(output));
            out.insert("speedMs".to_string(), js_number(ms));
        }
        Value::Object(out)
    }
}

enum Model {
    Built(Box<Route>),
    /// A historical route restored from a legacy whole-day document.
    Raw(Value),
}

struct Day {
    bucket: Bucket,
    conversation: Bucket,
    models: BTreeMap<String, Model>,
    imported_partial: bool,
    restored: bool,
}

impl Day {
    fn new() -> Self {
        Day {
            bucket: Bucket::new(),
            conversation: Bucket::new(),
            models: BTreeMap::new(),
            imported_partial: false,
            restored: false,
        }
    }

    fn to_value(&self) -> Value {
        let mut out = self.bucket.to_object();
        out.insert(
            "models".to_string(),
            Value::Object(
                self.models
                    .iter()
                    .map(|(key, model)| {
                        let value = match model {
                            Model::Built(route) => route.to_value(),
                            Model::Raw(value) => value.clone(),
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            ),
        );
        out.insert(
            "conversation".to_string(),
            Value::Object(self.conversation.to_object()),
        );
        if self.imported_partial {
            out.insert("importedPartial".to_string(), Value::Bool(true));
        }
        if self.restored {
            out.insert("restored".to_string(), Value::Bool(true));
        }
        Value::Object(out)
    }
}

enum DayEntry {
    Built(Box<Day>),
    /// A day known only from its legacy document.
    Raw(Value),
}

type Days = BTreeMap<String, DayEntry>;

fn built<'a>(days: &'a mut Days, day: &str) -> Result<&'a mut Day> {
    match days.get_mut(day) {
        Some(DayEntry::Built(day)) => Ok(day),
        _ => Err(LedgerError::Inconsistent("a rollup row without its day")),
    }
}

fn built_route<'a>(day: &'a mut Day, key: &str) -> Result<&'a mut Route> {
    match day.models.get_mut(key) {
        Some(Model::Built(route)) => Ok(route),
        _ => Err(LedgerError::Inconsistent("a rollup row without its route")),
    }
}

fn amount_from_daily(row: &rusqlite::Row<'_>) -> rusqlite::Result<AmountRow> {
    Ok(AmountRow {
        day: row.get(0)?,
        provider: row.get(1)?,
        model: row.get(2)?,
        kind: row.get(3)?,
        cost_source: row.get(4)?,
        conversation: row.get::<_, i64>(5)? != 0,
        turns: row.get(6)?,
        input: row.get(7)?,
        output: row.get(8)?,
        cache_read: row.get(9)?,
        cache_write: row.get(10)?,
        cost_usd: row.get(11)?,
        duration_ms: row.get(12)?,
        imported: row.get::<_, i64>(13)? != 0,
    })
}

/// Event sums keyed by source type; `conversation` follows the source.
fn amount_from_events(row: &rusqlite::Row<'_>) -> rusqlite::Result<AmountRow> {
    let source_type: Option<String> = row.get(5)?;
    Ok(AmountRow {
        day: row.get(0)?,
        provider: row.get(1)?,
        model: row.get(2)?,
        kind: row.get(3)?,
        cost_source: row.get(4)?,
        conversation: is_conversation_source(source_type.as_deref()),
        turns: row.get(6)?,
        input: row.get(7)?,
        output: row.get(8)?,
        cache_read: row.get(9)?,
        cache_write: row.get(10)?,
        cost_usd: row.get(11)?,
        duration_ms: row.get(12)?,
        imported: row.get::<_, Option<i64>>(13)?.unwrap_or(0) != 0,
    })
}

/// `ts` keeps the time index for a bounded window; an unbounded one matches every row, so
/// `+ts` scans the table instead of paying one primary-key search per index entry.
fn ts_expr(alias: &str, from_ts: i64, to_ts: i64) -> String {
    if from_ts > 0 || to_ts < MAX_SAFE_INTEGER {
        format!("{alias}ts")
    } else {
        format!("+{alias}ts")
    }
}

fn read_hourly_rows(
    conn: &Connection,
    query: &RollupQuery,
    hourly_day: &str,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<Value>> {
    let date = parse_day(hourly_day)?;
    let (lo, hi) = (
        if query.from_ms.is_none() {
            local_midnight_ms(date)
        } else {
            from_ts
        },
        if query.to_ms.is_none() {
            next_midnight_ms(date)
        } else {
            to_ts
        },
    );
    let mut stmt = conn.prepare(&format!(
        "SELECT e.ts,e.provider,e.source_type,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd
         FROM events e JOIN ({BEST_SQL}) b USING(day,provider,model,rank)
         WHERE e.ts>=? AND e.ts<? AND e.cost_source<>'{NO_USAGE_COST_SOURCE}' ORDER BY e.ts"
    ))?;
    let rows = stmt.query_map(params![query.from_day, query.to_day, lo, hi], |row| {
        let provider: String = row.get(1)?;
        let unmeasuring = is_unmeasuring_provider(&provider);
        let number = |i: usize| -> rusqlite::Result<Value> {
            Ok(if unmeasuring {
                js_number(0.0)
            } else {
                js_number(row.get(i)?)
            })
        };
        let mut out = Map::new();
        out.insert("ts".to_string(), Value::from(row.get::<_, i64>(0)?));
        out.insert("provider".to_string(), Value::from(provider.as_str()));
        out.insert(
            "source_type".to_string(),
            row.get::<_, Option<String>>(2)?
                .map_or(Value::Null, Value::from),
        );
        out.insert("input".to_string(), number(3)?);
        out.insert("output".to_string(), js_number(row.get(4)?));
        out.insert("cache_read".to_string(), number(5)?);
        out.insert("cache_write".to_string(), number(6)?);
        let cost: Option<f64> = row.get(7)?;
        out.insert(
            "cost_usd".to_string(),
            if unmeasuring {
                js_number(0.0)
            } else {
                cost.map_or(Value::Null, js_number)
            },
        );
        out.insert(
            "unmeasuredTurns".to_string(),
            js_number(if unmeasuring { 1.0 } else { 0.0 }),
        );
        Ok(Value::Object(out))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Partial calendar days must be rebuilt from retained timestamps; cached whole-day totals
/// would include usage outside a rolling window.
fn read_daily_amounts(
    conn: &Connection,
    query: &RollupQuery,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<AmountRow>> {
    if query.from_ms.is_none() {
        let mut stmt = conn.prepare(&format!(
            "SELECT d.day,d.provider,d.model,d.kind,d.cost_source,d.conversation,d.turns,d.input,d.output,
                d.cache_read,d.cache_write,d.cost_usd,d.duration_ms,d.imported
             FROM daily d JOIN ({BEST_SQL}) b USING(day,provider,model,rank)"
        ))?;
        let rows = stmt.query_map(params![query.from_day, query.to_day], amount_from_daily)?;
        return Ok(rows.collect::<std::result::Result<_, _>>()?);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT e.day,e.provider,e.model,e.kind,e.cost_source,e.source_type,
            COUNT(*),SUM(e.input),SUM(e.output),SUM(e.cache_read),SUM(e.cache_write),
            SUM(e.cost_usd),SUM(e.duration_ms),MAX(e.origin!='live')
         FROM events e JOIN ({BEST_SQL}) b USING(day,provider,model,rank)
         WHERE e.ts>=? AND e.ts<? AND e.cost_source<>'{NO_USAGE_COST_SOURCE}'
         GROUP BY e.day,e.rank,e.provider,e.model,e.kind,e.cost_source,e.source_type"
    ))?;
    let rows = stmt.query_map(
        params![query.from_day, query.to_day, from_ts, to_ts],
        amount_from_events,
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn fold_daily_amounts(days: &mut Days, amounts: &[AmountRow]) -> Result<()> {
    for row in amounts {
        let entry = days
            .entry(row.day.clone())
            .or_insert_with(|| DayEntry::Built(Box::new(Day::new())));
        let DayEntry::Built(day) = entry else {
            return Err(LedgerError::Inconsistent("a rollup day built twice"));
        };
        let route = match day
            .models
            .entry(route_key(&row.provider, &row.model, false))
            .or_insert_with(|| Model::Built(Box::new(Route::new(row, false))))
        {
            Model::Built(route) => route,
            Model::Raw(_) => {
                return Err(LedgerError::Inconsistent(
                    "a raw route before the legacy merge",
                ));
            }
        };
        let amount = row.amount();
        day.bucket.add(&amount, 1.0);
        route.bucket.add(&amount, 1.0);
        if row.conversation {
            day.conversation.add(&amount, 1.0);
            route.conversation.add(&amount, 1.0);
        }
        if row.imported {
            day.imported_partial = true;
        }
    }
    Ok(())
}

/// Fast-mode calls (the tier is on the route signature, not in the daily totals) read from
/// the retained originals, to become a route of their own.
fn read_fast_amounts(
    conn: &Connection,
    query: &RollupQuery,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<AmountRow>> {
    let ts = ts_expr("e.", from_ts, to_ts);
    // Routes are few and events many: a ledger with no Fast route (nearly all of them)
    // skips the event scan, and the tier is read once per route, not per event.
    let fast_routes = format!(
        "SELECT r.id,
            json_extract(r.signature,'$[0]') AS provider,
            json_extract(r.signature,'$[1]') AS model,
            json_extract(r.signature,'$[2]') AS kind,
            json_extract(r.signature,'$[3]') AS source_type,
            json_extract(r.signature,'$[4]') AS cost_source,
            json_extract(r.signature,'$[7]') AS rank
         FROM usage_routes r WHERE {fast} AND json_extract(r.signature,'$[4]')<>'{NO_USAGE_COST_SOURCE}'",
        fast = fast_route_sql("r.signature")
    );
    let any: Option<i64> = conn
        .prepare(&format!("{fast_routes} LIMIT 1"))?
        .query_row([], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })?;
    if any.is_none() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(&format!(
        "WITH fast_routes AS MATERIALIZED ({fast_routes}), fast AS (
            SELECT {day} AS day,
                r.provider,r.model,r.kind,r.source_type,r.cost_source,r.rank,
                e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,e.duration_ms
            FROM usage_events e JOIN fast_routes r ON r.id=e.route
            WHERE {ts}>=? AND {ts}<?
        )
        SELECT f.day,f.provider,f.model,f.kind,f.cost_source,f.source_type,
            COUNT(*),SUM(f.input),SUM(f.output),SUM(f.cache_read),SUM(f.cache_write),
            SUM(f.cost_usd),SUM(f.duration_ms),0
        FROM fast f JOIN ({BEST_SQL}) b USING(day,provider,model,rank)
        GROUP BY f.day,f.rank,f.provider,f.model,f.kind,f.cost_source,f.source_type",
        day = day_text_sql("e"),
    ))?;
    let rows = stmt.query_map(
        params![from_ts, to_ts, query.from_day, query.to_day],
        amount_from_events,
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn fold_fast_amounts(days: &mut Days, rows: &[AmountRow]) -> Result<()> {
    for row in rows {
        let Some(DayEntry::Built(day)) = days.get_mut(&row.day) else {
            continue;
        };
        let normal_key = route_key(&row.provider, &row.model, false);
        if !matches!(day.models.get(&normal_key), Some(Model::Built(_))) {
            continue;
        }
        let key = route_key(&row.provider, &row.model, true);
        day.models
            .entry(key.clone())
            .or_insert_with(|| Model::Built(Box::new(Route::new(row, true))));
        let amount = row.amount();
        for (target_key, sign) in [(key, 1.0), (normal_key, -1.0)] {
            let route = built_route(day, &target_key)?;
            route.bucket.add(&amount, sign);
            if row.conversation {
                route.conversation.add(&amount, sign);
            }
        }
    }
    // A model used only in Fast mode keeps just its Fast row.
    for entry in days.values_mut() {
        let DayEntry::Built(day) = entry else {
            continue;
        };
        let dropped: Vec<String> = day
            .models
            .iter()
            .filter(|(key, model)| {
                matches!(model, Model::Built(route) if !route.fast && route.bucket.turns <= 0.0)
                    && day.models.contains_key(&format!("{key}{FAST_KEY}"))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in dropped {
            day.models.remove(&key);
        }
    }
    Ok(())
}

struct SessionRow {
    day: String,
    provider: String,
    model: String,
    source_type: Option<String>,
    origin: String,
    fast: bool,
    session_id: String,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

/// `day_sessions` cannot attribute an id to a route. Use the retained originals, without
/// modifying them or guessing from account/pool ids. Compact integer keys are aggregated
/// BEFORE the attribution is decoded.
fn read_session_attribution(
    conn: &Connection,
    query: &RollupQuery,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<SessionRow>> {
    let ts = ts_expr("", from_ts, to_ts);
    let mut stmt = conn.prepare(&format!(
        "WITH grouped AS (
            SELECT day,route,session,SUM(input) AS input,SUM(output) AS output,
                SUM(cache_read) AS cacheRead,SUM(cache_write) AS cacheWrite
            FROM usage_events WHERE {ts}>=? AND {ts}<?
            GROUP BY day,route,session
        ), attributed AS (
            SELECT {day} AS day,
                json_extract(r.signature,'$[0]') AS provider,
                json_extract(r.signature,'$[1]') AS model,
                json_extract(r.signature,'$[3]') AS source_type,
                json_extract(r.signature,'$[6]') AS origin,
                json_extract(r.signature,'$[7]') AS rank,
                {fast} AS fast,
                s.value AS session_id,e.input,e.output,e.cacheRead,e.cacheWrite
            FROM grouped e JOIN usage_routes r ON r.id=e.route
            JOIN usage_sessions s ON s.id=e.session
            WHERE json_extract(r.signature,'$[4]')<>'{NO_USAGE_COST_SOURCE}'
        )
        SELECT e.day,e.provider,e.model,e.source_type,e.origin,e.fast,e.session_id,
            e.input,e.output,e.cacheRead,e.cacheWrite
        FROM attributed e JOIN ({BEST_SQL}) b USING(day,provider,model,rank)",
        day = day_text_sql("e"),
        fast = fast_route_sql("r.signature"),
    ))?;
    let rows = stmt.query_map(
        params![from_ts, to_ts, query.from_day, query.to_day],
        |row| {
            Ok(SessionRow {
                day: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                source_type: row.get(3)?,
                origin: row.get(4)?,
                fast: row.get::<_, i64>(5)? != 0,
                session_id: row.get(6)?,
                input: row.get(7)?,
                output: row.get(8)?,
                cache_read: row.get(9)?,
                cache_write: row.get(10)?,
            })
        },
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn fold_session_attribution(days: &mut Days, rows: &[SessionRow]) -> Result<()> {
    for row in rows {
        let classified =
            row.origin != "trace" || row.source_type.as_deref().is_some_and(|s| !s.is_empty());
        if classified && !is_conversation_source(row.source_type.as_deref()) {
            continue;
        }
        let day = built(days, &row.day)?;
        let key = route_key(&row.provider, &row.model, row.fast);
        let named = classified
            && !row.session_id.is_empty()
            && !["no-session", "(none)"].contains(&row.session_id.as_str());
        let tokens = if is_unmeasuring_provider(&row.provider) {
            row.output
        } else {
            row.input + row.output + row.cache_read + row.cache_write
        };
        let route = built_route(day, &key)?;
        for target in [&mut route.bucket, &mut route.conversation] {
            attribute(target, &row.session_id, named, tokens);
        }
        for target in [&mut day.bucket, &mut day.conversation] {
            attribute(target, &row.session_id, named, tokens);
        }
    }
    Ok(())
}

fn attribute(target: &mut Bucket, session_id: &str, named: bool, tokens: f64) {
    if named {
        *target.sessions.entry(session_id.to_string()).or_insert(0.0) += tokens;
    } else {
        target.sessions_complete = false;
    }
}

/// Output speed: output tokens over the wall time of the requests that produced them. Only
/// timed requests with output count, so untimed output never dilutes a route's figure.
fn read_output_speed(
    conn: &Connection,
    query: &RollupQuery,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<SpeedRow>> {
    let ts = ts_expr("", from_ts, to_ts);
    let mut stmt = conn.prepare(&format!(
        "WITH timed AS (
            SELECT day,route,SUM(output) AS output,SUM(duration_ms) AS duration_ms
            FROM usage_events WHERE {ts}>=? AND {ts}<? AND duration_ms>0 AND output>0
            GROUP BY day,route
        ), attributed AS (
            SELECT {day} AS day,
                json_extract(r.signature,'$[0]') AS provider,
                json_extract(r.signature,'$[1]') AS model,
                json_extract(r.signature,'$[7]') AS rank,
                {fast} AS fast,
                t.output,t.duration_ms
            FROM timed t JOIN usage_routes r ON r.id=t.route
        )
        SELECT a.day,a.provider,a.model,a.fast,a.output,a.duration_ms
        FROM attributed a JOIN ({BEST_SQL}) b USING(day,provider,model,rank)",
        day = day_text_sql("t"),
        fast = fast_route_sql("r.signature"),
    ))?;
    let rows = stmt.query_map(
        params![from_ts, to_ts, query.from_day, query.to_day],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// `(day, provider, model, fast, output tokens, wall ms)` of the timed requests of one route.
type SpeedRow = (String, String, String, bool, f64, f64);

fn fold_output_speed(days: &mut Days, rows: &[SpeedRow]) {
    for (day, provider, model, fast, output, ms) in rows {
        let Some(DayEntry::Built(day)) = days.get_mut(day) else {
            continue;
        };
        if let Some(Model::Built(route)) = day.models.get_mut(&route_key(provider, model, *fast)) {
            let (o, m) = route.speed.unwrap_or((0.0, 0.0));
            route.speed = Some((o + output, m + ms));
        }
    }
}

fn field(value: &Value, name: &str) -> f64 {
    json_or_zero(value.get(name))
}

/// The same measurement rule as [`Bucket::add`] for a legacy document: Cursor's routes were
/// never measured spend.
fn unmeasure(provider: &str, source: &Value) -> Value {
    if !is_unmeasuring_provider(provider) {
        return source.clone();
    }
    let mut out = source.as_object().cloned().unwrap_or_default();
    for name in [
        "input",
        "cacheRead",
        "cacheWrite",
        "costUsd",
        "costBilled",
        "costEstimated",
        "costKnownTurns",
    ] {
        out.insert(name.to_string(), js_number(0.0));
    }
    out.insert(
        "unmeasuredTurns".to_string(),
        js_number(field(source, "turns")),
    );
    Value::Object(out)
}

/// `normalizeLegacyUsageDay`: a stored whole-day document with its Cursor routes taken
/// back out of the day totals.
fn normalize_legacy_day(mut day: Value) -> Value {
    let Some(models) = day.get("models").and_then(Value::as_object).cloned() else {
        return day;
    };
    for (key, route) in models {
        let provider = match route
            .get("provider")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        {
            Some(provider) => provider.to_string(),
            None => match key.find('/') {
                Some(i) => key[..i].to_string(),
                None => key
                    .chars()
                    .take(key.chars().count().saturating_sub(1))
                    .collect(),
            },
        };
        if !is_unmeasuring_provider(&provider) {
            continue;
        }
        for (target_at, source) in [
            (None, Some(&route)),
            (Some("conversation"), route.get("conversation")),
        ] {
            let target = match target_at {
                None => Some(&mut day),
                Some(name) => day.get_mut(name),
            };
            let (Some(target), Some(source)) = (target, source) else {
                continue;
            };
            let (Some(target), true) = (target.as_object_mut(), source.is_object()) else {
                continue;
            };
            for name in [
                "input",
                "cacheRead",
                "cacheWrite",
                "costUsd",
                "costBilled",
                "costEstimated",
                "costKnownTurns",
            ] {
                let left = json_or_zero(target.get(name)) - field(source, name);
                target.insert(name.to_string(), js_number(left.max(0.0)));
            }
            let added = json_or_zero(target.get("unmeasuredTurns")) + field(source, "turns");
            target.insert("unmeasuredTurns".to_string(), js_number(added));
        }
        let mut measured = unmeasure(&provider, &route);
        if let Some(conversation) = route.get("conversation").filter(|c| !c.is_null()) {
            measured["conversation"] = unmeasure(&provider, conversation);
        }
        day["models"][&key] = measured;
    }
    day
}

fn merge_legacy_bucket(target: &mut Bucket, source: &Value, kind: &str) {
    target.turns += num(field(source, "turns"));
    target.input += num(field(source, "input"));
    target.output += num(field(source, "output"));
    target.cache_read += num(field(source, "cacheRead"));
    target.cache_write += num(field(source, "cacheWrite"));
    target.cost_usd += num(field(source, "costUsd"));
    target.duration_ms += num(field(source, "durationMs"));
    target.duration_turns += num(field(source, "durationTurns"));
    target.unmeasured_turns += num(field(source, "unmeasuredTurns"));
    if source.get("costKnownTurns").is_some_and(|v| !v.is_null()) {
        target.cost_known_turns += num(field(source, "costKnownTurns"));
    } else if num(field(source, "costUsd")) > 0.0 || kind == "local" {
        target.cost_known_turns += num(field(source, "turns"));
    }
    target.cost_billed += num(field(source, "costBilled"));
    let estimated = match source.get("costEstimated") {
        Some(v) if !v.is_null() => field(source, "costEstimated"),
        _ => field(source, "costUsd"),
    };
    target.cost_estimated += num(estimated);
    target.sessions_complete = false;
}

fn merge_legacy_days(
    conn: &Connection,
    days: &mut Days,
    hourly: &mut Option<Value>,
    query: &RollupQuery,
) -> Result<()> {
    let mut stmt =
        conn.prepare("SELECT day, document FROM legacy_days WHERE day BETWEEN ?1 AND ?2")?;
    let documents: Vec<(String, String)> = stmt
        .query_map(params![query.from_day, query.to_day], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut unallocated: Vec<Value> = Vec::new();
    for (name, document) in documents {
        let legacy = normalize_legacy_day(serde_json::from_str(&document)?);
        let is_hourly = query.hourly_day.as_deref() == Some(name.as_str());
        let legacy_models: Vec<(String, Value)> = legacy
            .get("models")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let Some(entry) = days.get_mut(&name) else {
            let mut raw = legacy;
            raw["importedPartial"] = Value::Bool(true);
            days.insert(name, DayEntry::Raw(raw));
            if is_hourly {
                unallocated.extend(legacy_models.into_iter().map(|(_, route)| route));
            }
            continue;
        };
        let DayEntry::Built(day) = entry else {
            continue;
        };
        for (key, route) in legacy_models {
            if day.models.contains_key(&key) {
                continue;
            }
            // A disjoint historical route is preserved, not an inferred balance of an
            // overlapping one; its session count stays unknown.
            let mut kept = route.clone();
            kept["sessionsComplete"] = Value::Bool(false);
            day.models.insert(key, Model::Raw(kept));
            if is_hourly {
                unallocated.push(route.clone());
            }
            let kind = route.get("kind").and_then(Value::as_str).unwrap_or("");
            merge_legacy_bucket(&mut day.bucket, &route, kind);
            if let Some(conversation) = route.get("conversation").filter(|c| !c.is_null()) {
                merge_legacy_bucket(&mut day.conversation, conversation, kind);
            }
            day.imported_partial = true;
            if legacy
                .get("restored")
                .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
            {
                day.restored = true;
            }
        }
    }
    if let Some(Value::Object(hourly)) = hourly
        && let Some(Value::Array(list)) = hourly.get_mut("unallocated")
    {
        list.extend(unallocated);
    }
    Ok(())
}

/// Reads cached amounts; groups retained attribution separately for distinct sessions.
pub fn rollup_usage(conn: &Connection, query: &RollupQuery) -> Result<Rollup> {
    let (from_ts, to_ts) = resolve_window(query)?;
    let mut days = Days::new();
    let mut hourly = match &query.hourly_day {
        Some(hourly_day) => Some(serde_json::json!({
            "rows": read_hourly_rows(conn, query, hourly_day, from_ts, to_ts)?,
            "unallocated": [],
        })),
        None => None,
    };
    fold_daily_amounts(&mut days, &read_daily_amounts(conn, query, from_ts, to_ts)?)?;
    fold_fast_amounts(&mut days, &read_fast_amounts(conn, query, from_ts, to_ts)?)?;
    fold_output_speed(&mut days, &read_output_speed(conn, query, from_ts, to_ts)?);
    fold_session_attribution(
        &mut days,
        &read_session_attribution(conn, query, from_ts, to_ts)?,
    )?;
    // Timeless legacy totals cannot establish membership in a rolling window; they remain
    // available in the calendar and history views.
    if query.from_ms.is_none() {
        merge_legacy_days(conn, &mut days, &mut hourly, query)?;
    }
    let days = days
        .into_iter()
        .map(|(name, entry)| {
            let value = match entry {
                DayEntry::Built(day) => day.to_value(),
                DayEntry::Raw(value) => value,
            };
            (name, value)
        })
        .collect();
    Ok(Rollup { days, hourly })
}
