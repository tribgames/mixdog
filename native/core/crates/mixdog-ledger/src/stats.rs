//! The statistics snapshot (`usage-stats-model.mjs`, `usage-stats-api.mjs` `getUsageStats`):
//! token, cost and session totals by provider with a per-model drill-down, a daily series and
//! the previous window's change figure, folded from the ledger's rollup.
//!
//! The ledger is the one store: the raw-event and transcript-history sources the Node model
//! could also fold are never passed by `getUsageStats`, so only the rollup source exists here.

use std::collections::BTreeSet;
use std::collections::HashSet;

use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;

use crate::db::Connection;
use crate::error::Result;
use crate::hours::hourly_series;
use crate::maintenance::cached_rollup;
use crate::measure::FAST_KEY;
use crate::measure::Ordered;
use crate::measure::amount;
use crate::measure::is_true;
use crate::measure::js_number;
use crate::measure::known_cost_turns;
use crate::measure::num;
use crate::measure::round_to;
use crate::measure::sort_fast_beside_model;
use crate::measure::trimmed;
use crate::period::PeriodRequest;
use crate::period::resolve_usage_stats_period;
use crate::rollup::RollupQuery;
use crate::rollup::rollup_usage;
use crate::time::add_local_days;
use crate::time::day_key;
use crate::time::local_fields;
use crate::time::local_midnight_ms;
use mixdog_js::math::round;

const MAX_MODEL_LIMIT: f64 = 50.0;
const MAX_DAYS: f64 = 3650.0;

/// What `getUsageStats` accepts. `days` and `model_limit` stay JSON because the service coerces
/// them with `Number(...)` (`"all"`, numeric text and numbers are all valid spellings).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsOptions {
    #[serde(default)]
    pub days: Value,
    #[serde(default)]
    pub model_limit: Value,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub start_day: Option<String>,
    #[serde(default)]
    pub end_day: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
}

impl UsageStatsOptions {
    /// The period a `view` names; none when the caller used the `days` API.
    pub fn period_request(&self, default_view: Option<&str>) -> Option<PeriodRequest> {
        let view = self
            .view
            .clone()
            .or_else(|| default_view.map(str::to_string))?;
        Some(PeriodRequest {
            view: Some(view),
            anchor: self.anchor.clone(),
            start_day: self.start_day.clone(),
            end_day: self.end_day.clone(),
            start_time: self.start_time.clone(),
            end_time: self.end_time.clone(),
        })
    }
}

/// `null` is all time, `0` is today, anything else a trailing day count.
fn normalize_days(value: &Value) -> Option<i64> {
    if value.is_null() || value.as_str() == Some("all") {
        return None;
    }
    let days = mixdog_js::to_number(value);
    if !days.is_finite() || days < 0.0 {
        return None;
    }
    Some(days.floor().min(MAX_DAYS) as i64)
}

fn normalize_model_limit(value: &Value) -> usize {
    let limit = mixdog_js::to_number(value);
    if !limit.is_finite() || limit <= 0.0 {
        return 0;
    }
    limit.floor().min(MAX_MODEL_LIMIT) as usize
}

#[derive(Clone, Copy)]
struct Window {
    days: Option<i64>,
    from_ms: i64,
    to_ms: i64,
}

fn midnight(ts: i64) -> i64 {
    local_midnight_ms(local_fields(ts).date())
}

/// `days === null` is all time, `0` is today, N is N calendar dates including today.
fn resolve_window(days: Option<i64>, now: i64) -> Window {
    match days {
        Some(0) => Window {
            days: Some(0),
            from_ms: midnight(now),
            to_ms: now,
        },
        Some(span) if span > 0 => Window {
            days: Some(span),
            from_ms: add_local_days(midnight(now), 1 - span),
            to_ms: now,
        },
        _ => Window {
            days: None,
            from_ms: 0,
            to_ms: now,
        },
    }
}

/// The same-length window immediately before this one, for a change figure.
fn previous_window(window: Window) -> Option<Window> {
    let days = window.days.filter(|d| *d != 0)?;
    Some(Window {
        days: Some(days),
        from_ms: add_local_days(window.from_ms, -days),
        to_ms: window.from_ms - 1,
    })
}

#[derive(Clone, Default)]
struct Tally {
    turns: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: f64,
    cost_billed: f64,
    cost_estimated: f64,
    cost_known_turns: f64,
    unmeasured_turns: f64,
    speed_output: f64,
    speed_ms: f64,
}

impl Tally {
    fn add(&mut self, usage: &Tally) {
        self.turns += usage.turns;
        self.input += usage.input;
        self.output += usage.output;
        self.cache_read += usage.cache_read;
        self.cache_write += usage.cache_write;
        self.cost_usd += usage.cost_usd;
        self.cost_known_turns += usage.cost_known_turns;
        self.cost_billed += usage.cost_billed;
        self.cost_estimated += usage.cost_estimated;
        self.unmeasured_turns += usage.unmeasured_turns;
        self.speed_output += usage.speed_output;
        self.speed_ms += usage.speed_ms;
    }

    fn tokens(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Default)]
struct Route {
    tally: Tally,
    sessions: HashSet<String>,
    complete: bool,
}

impl Route {
    fn new() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }
}

struct ModelBucket {
    model: String,
    fast: bool,
    route: Route,
}

struct ProviderBucket {
    provider: String,
    kind: String,
    route: Route,
    models: Ordered<ModelBucket>,
}

#[derive(Default)]
struct DayBucket {
    day: String,
    tally: Tally,
    providers: Ordered<(String, Tally)>,
}

struct State {
    tally: Tally,
    providers: Ordered<ProviderBucket>,
    sessions: Ordered<f64>,
    sessions_complete: bool,
    anonymous: Vec<f64>,
    sessions_dropped: f64,
    duration_ms: f64,
    duration_turns: f64,
    day_keys: BTreeSet<String>,
    daily: Ordered<DayBucket>,
    rollup_days: u64,
    history_days: u64,
    unclassified_days: u64,
    unclassified_turns: f64,
    partial_days: u64,
}

impl State {
    fn new() -> Self {
        Self {
            tally: Tally::default(),
            providers: Ordered::default(),
            sessions: Ordered::default(),
            sessions_complete: true,
            anonymous: Vec::new(),
            sessions_dropped: 0.0,
            duration_ms: 0.0,
            duration_turns: 0.0,
            day_keys: BTreeSet::new(),
            daily: Ordered::default(),
            rollup_days: 0,
            history_days: 0,
            unclassified_days: 0,
            unclassified_turns: 0.0,
            partial_days: 0,
        }
    }
}

/// One rollup route's usage with the session ids it carries.
struct Usage<'a> {
    tally: Tally,
    sessions: Option<&'a Map<String, Value>>,
    sessions_complete: Option<&'a Value>,
}

fn fold_route(
    state: &mut State,
    provider_id: &str,
    model_id: &str,
    kind: &str,
    usage: &Usage,
    fast: bool,
) {
    let provider = state.providers.entry(provider_id, || ProviderBucket {
        provider: provider_id.to_string(),
        kind: String::new(),
        route: Route::new(),
        models: Ordered::default(),
    });
    if !kind.is_empty() && provider.kind.is_empty() {
        provider.kind = kind.to_string();
    }
    let key = if fast {
        format!("{model_id}{FAST_KEY}")
    } else {
        model_id.to_string()
    };
    let model = provider.models.entry(&key, || ModelBucket {
        model: model_id.to_string(),
        fast,
        route: Route::new(),
    });
    let incomplete =
        usage.tally.turns > 0.0 && (usage.sessions.is_none() || is_false(usage.sessions_complete));
    for route in [&mut provider.route, &mut model.route] {
        route.tally.add(&usage.tally);
        if incomplete {
            route.complete = false;
        }
        for id in usage.sessions.into_iter().flat_map(Map::keys) {
            route.sessions.insert(id.clone());
        }
    }
    state.tally.add(&usage.tally);
}

fn is_false(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(false)))
}

fn add_daily(state: &mut State, key: &str, usage: &Usage, provider_id: &str) {
    let bucket = state.daily.entry(key, || DayBucket {
        day: key.to_string(),
        ..DayBucket::default()
    });
    bucket.tally.add(&usage.tally);
    let id = mixdog_js::js_trim(provider_id);
    if id.is_empty() {
        return;
    }
    bucket
        .providers
        .entry(id, || (id.to_string(), Tally::default()))
        .1
        .add(&usage.tally);
}

fn fold_rollup_day(state: &mut State, key: &str, day: &Value, conversation_only: bool) {
    let totals = if conversation_only {
        day.get("conversation")
    } else {
        Some(day)
    };
    let Some(totals) = totals.filter(|t| !t.is_null()) else {
        state.unclassified_days += 1;
        state.unclassified_turns += amount(day.get("turns"));
        return;
    };
    state.day_keys.insert(key.to_string());
    if is_true(day.get("restored")) {
        state.history_days += 1;
    }
    if is_true(day.get("importedPartial")) {
        state.partial_days += 1;
    }
    if conversation_only && is_true(day.get("conversationPartial")) {
        state.partial_days += 1;
    }
    state.duration_ms += amount(totals.get("durationMs"));
    state.duration_turns += amount(totals.get("durationTurns"));
    state.sessions_dropped += amount(day.get("sessionsDropped"));
    if is_false(totals.get("sessionsComplete")) || amount(day.get("sessionsDropped")) > 0.0 {
        state.sessions_complete = false;
    }

    if let Some(models) = day.get("models").and_then(Value::as_object) {
        for (route_key, raw) in models {
            let route = if conversation_only {
                raw.get("conversation")
            } else {
                Some(raw)
            };
            let Some(route) = route.filter(|r| !r.is_null()) else {
                continue;
            };
            if conversation_only && amount(route.get("turns")) <= 0.0 {
                continue;
            }
            let slash = route_key.find('/').filter(|at| *at > 0);
            let provider_id = Some(trimmed(raw.get("provider")))
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| {
                    slash.map_or_else(String::new, |at| route_key[..at].to_string())
                });
            let model_id = Some(trimmed(raw.get("model")))
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| {
                    slash.map_or_else(String::new, |at| route_key[at + 1..].to_string())
                });
            if provider_id.is_empty() || model_id.is_empty() {
                continue;
            }
            let cost_usd = amount(route.get("costUsd"));
            let cost_billed = amount(route.get("costBilled"));
            let tally = Tally {
                turns: amount(route.get("turns")),
                input: amount(route.get("input")),
                output: amount(route.get("output")),
                cache_read: amount(route.get("cacheRead")),
                cache_write: amount(route.get("cacheWrite")),
                cost_usd,
                cost_known_turns: known_cost_turns(route),
                cost_billed,
                cost_estimated: match route.get("costEstimated") {
                    Some(v) if !v.is_null() => amount(Some(v)),
                    _ => (cost_usd - cost_billed).max(0.0),
                },
                unmeasured_turns: amount(route.get("unmeasuredTurns")),
                // Speed is the model's, whoever sent the request: read off the full route.
                speed_output: amount(raw.get("speedOutput")),
                speed_ms: amount(raw.get("speedMs")),
            };
            let usage = Usage {
                tally,
                sessions: route.get("sessions").and_then(Value::as_object),
                sessions_complete: route.get("sessionsComplete"),
            };
            fold_route(
                state,
                &provider_id,
                &model_id,
                &trimmed(raw.get("kind")),
                &usage,
                is_true(raw.get("fast")),
            );
            add_daily(state, key, &usage, &provider_id);
        }
    }

    // Session ids are recorded for conversation turns only, so both views read the same map,
    // except a day whose ids were collected while background cycles still counted.
    let partial = conversation_only
        && is_true(day.get("conversationPartial"))
        && !is_true(day.get("sessionsPurged"));
    if !partial {
        if let Some(sessions) = day.get("sessions").and_then(Value::as_object) {
            for (id, tokens) in sessions {
                // One session can span midnight; its totals are summed across days.
                let held = state.sessions.entry(id, || 0.0);
                *held += amount(Some(tokens));
            }
        }
        if let Some(tokens) = day.get("sessionTokens").and_then(Value::as_array) {
            state
                .anonymous
                .extend(tokens.iter().map(|t| amount(Some(t))));
            if !tokens.is_empty() {
                state.sessions_complete = false;
            }
        }
    }
}

fn collect(rollup_days: &Map<String, Value>, window: Window, conversation_only: bool) -> State {
    let from_key = if window.from_ms > 0 {
        day_key(window.from_ms)
    } else {
        String::new()
    };
    let to_key = day_key(window.to_ms);
    let mut state = State::new();
    for (key, day) in rollup_days {
        if *key < from_key || *key > to_key {
            continue;
        }
        state.rollup_days += 1;
        fold_rollup_day(&mut state, key, day, conversation_only);
    }
    state
}

/// Every calendar day from `first` to `last`, inclusive.
fn calendar_days(first: &str, last: &str) -> Vec<String> {
    let parse = |text: &str| {
        NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .ok()
            .map(local_midnight_ms)
    };
    let (Some(mut cursor), Some(end)) = (parse(first), parse(last)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // Walking the date itself (not adding 24h) keeps a daylight-saving change from shifting a key.
    while cursor <= end {
        out.push(day_key(cursor));
        cursor = add_local_days(cursor, 1);
        if out.len() > 4000 {
            break;
        }
    }
    out
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

/// `null` while any turn is unmeasured, 0 without a denominator.
fn measured_ratio(unmeasured: f64, numerator: f64, denominator: f64, digits: i32) -> Value {
    if unmeasured > 0.0 {
        return Value::Null;
    }
    js_number(if denominator > 0.0 {
        round_to(numerator / denominator, digits)
    } else {
        0.0
    })
}

fn output_speed(tally: &Tally) -> Value {
    let ms = num(tally.speed_ms);
    if ms > 0.0 {
        js_number(round_to(num(tally.speed_output) * 1000.0 / ms, 1))
    } else {
        Value::Null
    }
}

fn field(bucket: &Value, name: &str) -> f64 {
    bucket.get(name).and_then(Value::as_f64).unwrap_or(0.0)
}

/// One session's lifetime totals (the /context footer), in a statistics route's terms.
pub fn session_usage_snapshot(bucket: &Value) -> Value {
    let tally = Tally {
        turns: field(bucket, "turns"),
        input: field(bucket, "input"),
        output: field(bucket, "output"),
        cache_read: field(bucket, "cacheRead"),
        cache_write: field(bucket, "cacheWrite"),
        cost_usd: field(bucket, "costUsd"),
        cost_known_turns: field(bucket, "costKnownTurns"),
        unmeasured_turns: field(bucket, "unmeasuredTurns"),
        speed_output: field(bucket, "speedOutput"),
        speed_ms: field(bucket, "speedMs"),
        ..Tally::default()
    };
    let mut out = Map::new();
    out.insert("outputTokensPerSecond".into(), output_speed(&tally));
    out.insert("turns".into(), js_number(tally.turns));
    out.insert("input".into(), js_number(tally.input));
    out.insert("output".into(), js_number(tally.output));
    out.insert("cacheRead".into(), js_number(tally.cache_read));
    out.insert("cacheWrite".into(), js_number(tally.cache_write));
    out.insert("tokens".into(), js_number(tally.tokens()));
    out.insert("unmeasuredTurns".into(), js_number(tally.unmeasured_turns));
    out.insert("costUsd".into(), js_number(round_to(tally.cost_usd, 6)));
    out.insert("costKnownTurns".into(), js_number(tally.cost_known_turns));
    out.insert(
        "costUnpricedTurns".into(),
        js_number((tally.turns - tally.cost_known_turns).max(0.0)),
    );
    out.insert(
        "cacheHitRate".into(),
        measured_ratio(
            tally.unmeasured_turns,
            tally.cache_read,
            tally.input + tally.cache_read + tally.cache_write,
            4,
        ),
    );
    Value::Object(out)
}

fn export_route(route: &Route, total_tokens: f64) -> Map<String, Value> {
    let t = &route.tally;
    let tokens = t.tokens();
    let fresh = t.input + t.output;
    let prompt = t.input + t.cache_read + t.cache_write;
    let unmeasured = num(t.unmeasured_turns);
    let unknown = unmeasured > 0.0 && unmeasured == t.turns;
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_string(), value);
    };
    put("turns", js_number(t.turns));
    put("sessions", route.sessions.len().into());
    put("sessionsComplete", route.complete.into());
    put(
        "input",
        if unknown {
            Value::Null
        } else {
            js_number(t.input)
        },
    );
    put("output", js_number(t.output));
    put(
        "cacheRead",
        if unknown {
            Value::Null
        } else {
            js_number(t.cache_read)
        },
    );
    put(
        "cacheWrite",
        if unknown {
            Value::Null
        } else {
            js_number(t.cache_write)
        },
    );
    put("cacheTokens", js_number(t.cache_read + t.cache_write));
    put("tokens", js_number(tokens));
    put("unmeasuredTurns", js_number(unmeasured));
    put("costUsd", js_number(round_to(t.cost_usd, 6)));
    put("costBilled", js_number(round_to(num(t.cost_billed), 6)));
    put(
        "costEstimated",
        js_number(round_to(num(t.cost_estimated), 6)),
    );
    put("costKnownTurns", js_number(num(t.cost_known_turns)));
    put(
        "costUnpricedTurns",
        js_number((t.turns - num(t.cost_known_turns)).max(0.0)),
    );
    put(
        "costCoverage",
        js_number(if t.turns > 0.0 {
            num(t.cost_known_turns) / t.turns
        } else {
            0.0
        }),
    );
    put("share", measured_ratio(unmeasured, tokens, total_tokens, 6));
    put(
        "cacheHitRate",
        measured_ratio(unmeasured, t.cache_read, prompt, 4),
    );
    put(
        "costPerMTokens",
        js_number(if fresh > 0.0 {
            round_to(t.cost_usd / (fresh / 1_000_000.0), 4)
        } else {
            0.0
        }),
    );
    put(
        "outputPerTurn",
        js_number(if t.turns > 0.0 {
            round(t.output / t.turns)
        } else {
            0.0
        }),
    );
    put("outputTokensPerSecond", output_speed(t));
    out
}

fn export_providers(state: &State, total_tokens: f64, model_limit: usize) -> Vec<Value> {
    let mut rows: Vec<(f64, f64, Value)> = state
        .providers
        .values()
        .map(|bucket| {
            let mut models: Vec<Value> = bucket
                .models
                .values()
                .map(|model| {
                    let mut out = Map::new();
                    out.insert("model".into(), model.model.clone().into());
                    if model.fast {
                        out.insert("fast".into(), true.into());
                    }
                    out.extend(export_route(&model.route, total_tokens));
                    Value::Object(out)
                })
                .collect();
            sort_fast_beside_model(
                &mut models,
                |row| {
                    row.get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                },
                &["tokens", "costUsd"],
            );
            let mut out = Map::new();
            out.insert("provider".into(), bucket.provider.clone().into());
            out.insert("providerKind".into(), bucket.kind.clone().into());
            let route = export_route(&bucket.route, total_tokens);
            let (tokens, cost) = (field_of(&route, "tokens"), field_of(&route, "costUsd"));
            out.extend(route);
            out.insert("modelCount".into(), models.len().into());
            if model_limit > 0 {
                models.truncate(model_limit);
            }
            out.insert("models".into(), Value::Array(models));
            (tokens, cost, Value::Object(out))
        })
        .collect();
    rows.sort_by(|a, b| {
        let lead = b.0 - a.0;
        let diff = if lead != 0.0 && !lead.is_nan() {
            lead
        } else {
            b.1 - a.1
        };
        diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.into_iter().map(|(_, _, row)| row).collect()
}

fn field_of(map: &Map<String, Value>, name: &str) -> f64 {
    map.get(name).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Routes used in the window with at least one request lacking a real cost.
fn export_unpriced(state: &State) -> Vec<Value> {
    let mut rows: Vec<(String, String)> = Vec::new();
    for provider in state.providers.values() {
        for model in provider.models.values() {
            let t = &model.route.tally;
            if t.turns > 0.0
                && t.cost_known_turns < t.turns
                && !rows
                    .iter()
                    .any(|(p, m)| *p == provider.provider && *m == model.model)
            {
                rows.push((provider.provider.clone(), model.model.clone()));
            }
        }
    }
    rows.sort_by(|a, b| {
        mixdog_js::locale_compare(&a.0, &b.0).then_with(|| mixdog_js::locale_compare(&a.1, &b.1))
    });
    rows.into_iter()
        .map(|(provider, model)| {
            let mut out = Map::new();
            out.insert("provider".into(), provider.into());
            out.insert("model".into(), model.into());
            Value::Object(out)
        })
        .collect()
}

/// One row per calendar day in the window, a day without traffic included.
fn export_daily(
    state: &State,
    window: Window,
    has_period: bool,
    period_end_day: Option<&str>,
    first_day: &str,
    end_day: &str,
) -> Vec<Value> {
    let first = if window.days.is_none() {
        first_day.to_string()
    } else {
        day_key(window.from_ms)
    };
    let last = period_end_day.filter(|d| !d.is_empty()).unwrap_or(end_day);
    calendar_days(&first, last)
        .into_iter()
        .map(|day| {
            let mut out = Map::new();
            let future = day.as_str() > end_day;
            let Some(bucket) = state.daily.get(&day) else {
                out.insert("day".into(), day.into());
                for key in [
                    "turns",
                    "tokens",
                    "cacheTokens",
                    "costUsd",
                    "costKnownTurns",
                ] {
                    out.insert(key.into(), 0.into());
                }
                out.insert("providers".into(), Value::Array(Vec::new()));
                if has_period {
                    out.insert("future".into(), future.into());
                }
                return Value::Object(out);
            };
            let t = &bucket.tally;
            out.insert("day".into(), bucket.day.clone().into());
            out.insert("turns".into(), js_number(t.turns));
            out.insert("tokens".into(), js_number(t.tokens()));
            out.insert(
                "cacheTokens".into(),
                js_number(t.cache_read + t.cache_write),
            );
            out.insert("costUsd".into(), js_number(round_to(t.cost_usd, 6)));
            out.insert("costKnownTurns".into(), js_number(num(t.cost_known_turns)));
            out.insert("unmeasuredTurns".into(), js_number(num(t.unmeasured_turns)));
            if has_period {
                out.insert("future".into(), future.into());
            }
            let mut slices: Vec<&(String, Tally)> = bucket.providers.values().collect();
            slices.sort_by(|a, b| {
                (b.1.tokens() - a.1.tokens())
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let providers = slices
                .into_iter()
                .map(|(provider, t)| {
                    let mut slice = Map::new();
                    slice.insert("provider".into(), provider.clone().into());
                    slice.insert("turns".into(), js_number(t.turns));
                    slice.insert("tokens".into(), js_number(t.tokens()));
                    slice.insert("costUsd".into(), js_number(round_to(t.cost_usd, 6)));
                    slice.insert("costKnownTurns".into(), js_number(num(t.cost_known_turns)));
                    slice.insert("unmeasuredTurns".into(), js_number(num(t.unmeasured_turns)));
                    Value::Object(slice)
                })
                .collect();
            out.insert("providers".into(), Value::Array(providers));
            Value::Object(out)
        })
        .collect()
}

/// The rollup query a period needs. A range cut below whole days is rebuilt from retained
/// timestamps; cached day totals would spill past the selected clock.
pub fn rollup_query_for(period: Option<&Value>) -> RollupQuery {
    let mut query = RollupQuery::default();
    let Some(period) = period else {
        return query;
    };
    let view = period.get("view").and_then(Value::as_str);
    let timed = view == Some("hour")
        || period.get("startTime").is_some_and(|v| !v.is_null())
        || period.get("endTime").is_some_and(|v| !v.is_null());
    if view == Some("hour") {
        query.hourly_day = period
            .get("startDay")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    if timed {
        query.from_ms = period.get("fromMs").and_then(Value::as_i64);
        query.to_ms = period.get("toMs").and_then(Value::as_i64);
    }
    if let Some(start) = period
        .get("startDay")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
    {
        query.from_day = start.to_string();
    }
    query.to_day = day_key(period.get("toMs").and_then(Value::as_i64).unwrap_or(0));
    query
}

/// The snapshot for a rollup document (`{days, hourly?}`).
pub fn usage_stats_snapshot(
    rollup: &Value,
    options: &UsageStatsOptions,
    period: Option<&Value>,
    now: i64,
) -> Value {
    let conversation_only = options.source.as_deref() == Some("conversation");
    let days = normalize_days(&options.days);
    let model_limit = normalize_model_limit(&options.model_limit);
    let window = match period {
        Some(p) => Window {
            days: p.get("days").and_then(Value::as_i64),
            from_ms: p.get("fromMs").and_then(Value::as_i64).unwrap_or(0),
            to_ms: p.get("toMs").and_then(Value::as_i64).unwrap_or(0),
        },
        None => resolve_window(days, now),
    };
    let empty = Map::new();
    let rollup_days = rollup
        .get("days")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let state = collect(rollup_days, window, conversation_only);

    let cache_tokens = state.tally.cache_read + state.tally.cache_write;
    let total_tokens = state.tally.input + state.tally.output + cache_tokens;
    let mut session_totals: Vec<f64> = state.sessions.values().copied().collect();
    session_totals.extend(&state.anonymous);
    let first_day = state.day_keys.iter().next().cloned().unwrap_or_default();
    let last_day = state
        .day_keys
        .iter()
        .next_back()
        .cloned()
        .unwrap_or_default();
    let end_day = day_key(window.to_ms);
    let span_days = if first_day.is_empty() {
        0
    } else {
        calendar_days(&first_day, &end_day).len()
    };
    let effective_days = match window.days {
        None => span_days as f64,
        Some(d) => (d.max(1)) as f64,
    };
    let period_end = period.and_then(|p| p.get("endDay")).and_then(Value::as_str);
    let providers = export_providers(&state, total_tokens, model_limit);
    let daily = export_daily(
        &state,
        window,
        period.is_some(),
        period_end,
        &first_day,
        &end_day,
    );
    let prior = if period.is_some() {
        None
    } else {
        previous_window(window).map(|w| collect(rollup_days, w, conversation_only))
    };

    let t = &state.tally;
    let mut out = Map::new();
    out.insert("generatedAt".into(), now.into());
    if let Some(p) = period {
        out.insert("period".into(), p.clone());
        if p.get("view").and_then(Value::as_str) == Some("hour") {
            out.insert(
                "hourly".into(),
                hourly_series(
                    rollup.get("hourly"),
                    window.from_ms,
                    window.to_ms,
                    p.get("endMs")
                        .and_then(Value::as_i64)
                        .unwrap_or(window.to_ms),
                    conversation_only,
                ),
            );
        }
    }
    out.insert(
        "source".into(),
        if conversation_only {
            "conversation"
        } else {
            "all"
        }
        .into(),
    );
    let mut range = Map::new();
    range.insert("days".into(), window.days.map_or(Value::Null, Value::from));
    range.insert("fromMs".into(), window.from_ms.into());
    range.insert("toMs".into(), window.to_ms.into());
    range.insert("firstDay".into(), first_day.into());
    range.insert("lastDay".into(), last_day.into());
    range.insert("activeDays".into(), state.day_keys.len().into());
    out.insert("range".into(), Value::Object(range));

    let mut totals = Map::new();
    let mut put = |key: &str, value: Value| {
        totals.insert(key.to_string(), value);
    };
    put("sessions", session_totals.len().into());
    put("sessionsComplete", state.sessions_complete.into());
    put("turns", js_number(t.turns));
    put("days", js_number(effective_days));
    put("input", js_number(t.input));
    put("output", js_number(t.output));
    put("tokens", js_number(total_tokens));
    put("unmeasuredTurns", js_number(t.unmeasured_turns));
    put("cacheRead", js_number(t.cache_read));
    put("cacheWrite", js_number(t.cache_write));
    put("cacheTokens", js_number(cache_tokens));
    put("totalTokens", js_number(total_tokens));
    put(
        "cacheHitRate",
        measured_ratio(
            t.unmeasured_turns,
            t.cache_read,
            t.input + t.cache_read + t.cache_write,
            4,
        ),
    );
    put("costUsd", js_number(round_to(t.cost_usd, 6)));
    put("costKnownTurns", js_number(t.cost_known_turns));
    put(
        "costUnpricedTurns",
        js_number((t.turns - t.cost_known_turns).max(0.0)),
    );
    put("costBilled", js_number(round_to(t.cost_billed, 6)));
    put("costEstimated", js_number(round_to(t.cost_estimated, 6)));
    put(
        "costPerDay",
        js_number(if effective_days > 0.0 {
            round_to(t.cost_usd / effective_days, 6)
        } else {
            0.0
        }),
    );
    put(
        "tokensPerSession",
        js_number(if session_totals.is_empty() {
            0.0
        } else {
            round(total_tokens / session_totals.len() as f64)
        }),
    );
    put(
        "medianTokensPerSession",
        js_number(round(median(&session_totals))),
    );
    put(
        "avgDurationMs",
        js_number(if state.duration_turns > 0.0 {
            round(state.duration_ms / state.duration_turns)
        } else {
            0.0
        }),
    );
    put(
        "costCoverage",
        js_number(if t.turns > 0.0 {
            round_to(t.cost_known_turns / t.turns, 4)
        } else {
            0.0
        }),
    );
    out.insert("totals".into(), Value::Object(totals));

    out.insert(
        "previous".into(),
        prior.map_or(Value::Null, |p| {
            let mut previous = Map::new();
            previous.insert("turns".into(), js_number(p.tally.turns));
            previous.insert("tokens".into(), js_number(p.tally.tokens()));
            previous.insert("costUsd".into(), js_number(round_to(p.tally.cost_usd, 6)));
            Value::Object(previous)
        }),
    );
    out.insert("daily".into(), Value::Array(daily));
    out.insert("providers".into(), Value::Array(providers));
    out.insert(
        "unpricedModels".into(),
        Value::Array(export_unpriced(&state)),
    );
    let mut coverage = Map::new();
    coverage.insert("rollupDays".into(), state.rollup_days.into());
    coverage.insert("eventDays".into(), 0.into());
    coverage.insert("historyDays".into(), state.history_days.into());
    coverage.insert("historyPending".into(), false.into());
    coverage.insert("sessionsDropped".into(), js_number(state.sessions_dropped));
    coverage.insert("unclassifiedDays".into(), state.unclassified_days.into());
    coverage.insert(
        "unclassifiedTurns".into(),
        js_number(state.unclassified_turns),
    );
    coverage.insert("partialDays".into(), state.partial_days.into());
    out.insert("coverage".into(), Value::Object(coverage));
    Value::Object(out)
}

/// What `getUsageRequests` accepts.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRequestsOptions {
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub start_day: Option<String>,
    #[serde(default)]
    pub end_day: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    /// The first page's `generatedAt`: later pages resolve the same period bounds.
    #[serde(default)]
    pub as_of: Option<f64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<f64>,
}

/// `getUsageRequests`: one page of requests in a statistics period (the 24-hour view by
/// default), newest first, optionally of one status and one answering model, with the models
/// that answered in the period. Each request still carries `ownerSessionId` and `sourceType`;
/// the caller names its sessions (it owns session titles) and drops those two fields.
pub(crate) fn requests_plan(options: &UsageRequestsOptions, real_now: i64) -> Result<RequestsPlan> {
    let as_of = options.as_of.map(|a| if a.is_nan() { f64::NAN } else { a });
    if let Some(as_of) = as_of
        && !(as_of > 0.0 && as_of <= real_now as f64)
    {
        return Err(crate::error::LedgerError::Period {
            range: true,
            message: "asOf must be a past timestamp",
        });
    }
    let generated_at = as_of.filter(|a| *a > 0.0).unwrap_or(real_now as f64);
    let now = generated_at as i64;
    let period = resolve_usage_stats_period(
        &PeriodRequest {
            view: Some(options.view.clone().unwrap_or_else(|| "hour".to_string())),
            anchor: options.anchor.clone(),
            start_day: options.start_day.clone(),
            end_day: options.end_day.clone(),
            start_time: options.start_time.clone(),
            end_time: options.end_time.clone(),
        },
        now,
    )?;
    let text = |value: &Option<String>| mixdog_js::slice_utf16(value.as_deref().unwrap_or(""), 200);
    let model = text(&options.model);
    let cursor = text(&options.cursor);
    let query = crate::requests::RequestQuery {
        from_ms: period["fromMs"].as_i64().unwrap_or(0),
        to_ms: period["toMs"].as_i64().unwrap_or(now),
        status: text(&options.status),
        model: (!model.is_empty()).then_some(model),
        cursor: (!cursor.is_empty()).then_some(cursor),
        limit: options
            .limit
            .map_or(0, |l| if l.is_finite() { l.floor() as i64 } else { 0 }),
    };
    Ok(RequestsPlan {
        generated_at,
        period,
        query,
    })
}

/// A `getUsageRequests` call resolved to its period and its page query.
pub(crate) struct RequestsPlan {
    generated_at: f64,
    period: Value,
    pub(crate) query: crate::requests::RequestQuery,
}

impl RequestsPlan {
    /// The answer around a page (`{requests, nextCursor, models}`).
    pub(crate) fn envelope(self, page: &Value) -> Value {
        let mut out = Map::new();
        out.insert("generatedAt".into(), js_number(self.generated_at));
        out.insert("period".into(), self.period);
        out.insert("requests".into(), page["requests"].clone());
        out.insert("nextCursor".into(), page["nextCursor"].clone());
        out.insert("models".into(), page["models"].clone());
        Value::Object(out)
    }
}

/// The `liveSince` the writer stored, or none.
fn live_since(conn: &Connection) -> Result<Option<f64>> {
    use rusqlite::types::Value as Sql;
    let stored: Option<Sql> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key='liveSince'",
            [],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let number = match stored {
        Some(Sql::Text(text)) => mixdog_js::string_to_number(&text),
        Some(Sql::Integer(n)) => n as f64,
        Some(Sql::Real(n)) => n,
        _ => 0.0,
    };
    Ok((number != 0.0 && !number.is_nan()).then_some(number))
}

/// `getUsageStats` over the ledger: resolve the period, roll up, fold. The caller settles its
/// pending appends first and owns history import and price refresh (both writes).
pub(crate) fn usage_stats(
    conn: &Connection,
    options: &UsageStatsOptions,
    now: i64,
) -> Result<Value> {
    let period = match options.period_request(None) {
        Some(request) => Some(resolve_usage_stats_period(&request, now)?),
        None => None,
    };
    let query = rollup_query_for(period.as_ref());
    let rollup = if query.from_ms.is_some() {
        rollup_usage(conn, &query)?.to_value()
    } else {
        cached_rollup(conn, &query, now)?
    };
    let mut snapshot = usage_stats_snapshot(&rollup, options, period.as_ref(), now);
    let live = live_since(conn)?;
    if let Some(Value::Object(coverage)) = snapshot.get_mut("coverage") {
        coverage.insert("ledger".into(), true.into());
        coverage.insert("liveSince".into(), live.map_or(Value::Null, js_number));
    }
    Ok(snapshot)
}
