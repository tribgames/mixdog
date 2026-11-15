//! `app/usage-context-panels/context-model.mjs`: the pure derivation of the `/context` panel. The runtime's status answers
//! become one metrics object, and that object renders as the panel rows plus the detail block. No surface or store access
//! happens here.
//!
//! The inputs are JSON as the runtime answers them, read with JavaScript's own coercions (`Number(value || 0)`, `a || b`,
//! `?.`), so a value of an unexpected type gives the figure Node gives. A figure that Node leaves `undefined` is left out of
//! the detail, as `JSON.stringify` leaves it out.

use mixdog_js::math::{ceil, max, min, round, to_fixed};
use mixdog_js::{js_to_lowercase, json_number, number_to_string, to_number, to_number_of, value_to_string};
use mixdog_view_model::display::context_measurement::{
    context_measurement_label, context_measurement_stats, measured_context_usage,
};
use serde_json::{Map, Value, json};

use crate::slash::notices::truthy;

/// The runtime answers the panel is built from (`null` for an answer that failed or that the store does not have).
#[derive(Clone, Copy, Debug)]
pub struct ContextModelInput<'a> {
    pub tools_status: &'a Value,
    pub mcp_status: &'a Value,
    pub skills_status: &'a Value,
    pub plugins_status: &'a Value,
    pub context_status: &'a Value,
    /// `store.getSessionUsage()`.
    pub session_usage: &'a Value,
    /// `state.contextWindow` (`null` for none).
    pub state_context_window: &'a Value,
    /// `state.rawContextWindow` (`null` for none).
    pub state_raw_context_window: &'a Value,
}

/// What the panel shows: the category rows and the detail block.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextPanelModel {
    pub rows: Vec<Value>,
    pub detail: Value,
}

/// A token figure: `None` is `null` or `undefined` (shown as a dash), `Some` a number (possibly `NaN`).
type Tokens = Option<f64>;

fn truthy_of(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |at, key| at.get(*key))
}

/// `Number(value || 0)`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    if truthy_of(value) { to_number_of(value) } else { 0.0 }
}

/// `a || b || ...`: the first truthy value.
fn first_truthy<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates.iter().copied().find(|candidate| truthy_of(*candidate))
}

/// `Number(a || b || ... || 0)`.
fn number_of_first(candidates: &[Option<&Value>]) -> f64 {
    first_truthy(candidates).map_or(0.0, to_number)
}

/// A number written in a `||` chain: `NaN` and `0` fall through.
fn number_truthy(number: f64) -> bool {
    number != 0.0 && !number.is_nan()
}

/// `value || 0` of a figure that is already a number.
fn zero_if_nan(number: f64) -> f64 {
    if number.is_nan() { 0.0 } else { number }
}

/// The figure of a JSON value as `fmt` and `pct` read it: nothing for `null`, else `Number(value || 0)`.
fn tokens_of(value: Option<&Value>) -> Tokens {
    if nullish(value) { None } else { Some(number_or_zero(value)) }
}

/// The figure of a number `fmt` and `pct` get as `value || 0` would pass it.
fn tokens_num(number: f64) -> Tokens {
    Some(zero_if_nan(number))
}

fn fmt_number(number: f64) -> String {
    if !number.is_finite() || number <= 0.0 {
        return "0".to_owned();
    }
    if number >= 1_000_000.0 {
        return format!("{}m", to_fixed(number / 1_000_000.0, 1));
    }
    if number >= 10_000.0 {
        return format!("{}k", number_to_string(round(number / 1000.0)));
    }
    if number >= 1000.0 {
        return format!("{}k", to_fixed(number / 1000.0, 1));
    }
    number_to_string(round(number))
}

/// `fmt(value)`.
fn fmt(value: Tokens) -> String {
    value.map_or_else(|| "\u{2014}".to_owned(), fmt_number)
}

/// `pct(value, total)`.
fn pct(value: Tokens, total: f64) -> String {
    let Some(n) = value else { return "\u{2014}".to_owned() };
    let d = zero_if_nan(total);
    if d == 0.0 {
        return "N/A".to_owned();
    }
    let share = max(0.0, min(100.0, n / d * 100.0));
    format!("{}%", number_to_string(round(share * 10.0) / 10.0))
}

/// `compactElapsed(value)`.
fn compact_elapsed(value: Option<&Value>) -> String {
    let n = number_or_zero(value);
    if !n.is_finite() || n <= 0.0 {
        return String::new();
    }
    format!("{}s", number_to_string(max(1.0, ceil(n / 1000.0))))
}

fn compaction_running(compaction: &Value) -> bool {
    field(compaction, "inProgress") == Some(&Value::Bool(true))
        || field(compaction, "lastStage").and_then(Value::as_str) == Some("compacting")
}

fn compaction_state(compaction: &Value) -> String {
    let stage = field(compaction, "lastStage").and_then(Value::as_str);
    let clear_error = field(compaction, "lastClearCompactError");
    let auto_clear_failed = stage == Some("auto_clear_failed") || truthy_of(clear_error);
    let auto_clear_stage = stage == Some("auto_clear") || truthy_of(field(compaction, "lastClearAt"));
    let reactive = field(compaction, "lastTrigger")
        .filter(|trigger| truthy(trigger))
        .map(|trigger| js_to_lowercase(&value_to_string(trigger)))
        .is_some_and(|trigger| trigger == "reactive");
    if compaction_running(compaction) {
        return "Compacting conversation".to_owned();
    }
    if stage == Some("interrupted") {
        return "Compact interrupted".to_owned();
    }
    if auto_clear_failed {
        let error = match clear_error.filter(|error| truthy(error)) {
            Some(error) => format!(": {}", value_to_string(error)),
            None => String::new(),
        };
        return format!("auto-clear skipped{error}");
    }
    if auto_clear_stage {
        return "Auto-clear complete".to_owned();
    }
    if truthy_of(field(compaction, "lastChanged")) {
        return if reactive { "Compact complete (overflow recovery)" } else { "Compact complete" }.to_owned();
    }
    "Compact checked".to_owned()
}

/// `compactBufferTokens(compaction, boundary, trigger)`.
fn compact_buffer_tokens(compaction: &Value, boundary: f64, trigger: f64) -> Option<f64> {
    let raw = to_number_of(field(compaction, "bufferTokens"));
    if raw.is_finite() {
        return Some(max(0.0, raw));
    }
    if number_truthy(boundary) && number_truthy(trigger) {
        return Some(max(0.0, boundary - trigger));
    }
    None
}

/// The figures every row and the detail are written from (`contextMetrics`).
struct Metrics<'a> {
    tools: &'a Value,
    mcp: &'a Value,
    skills: &'a Value,
    plugins: &'a Value,
    context: &'a Value,
    usage: &'a Value,
    messages: &'a Value,
    request: &'a Value,
    compaction: &'a Value,
    window_tokens: f64,
    raw_window_tokens: f64,
    compact_boundary: f64,
    compact_trigger: f64,
    measured: Value,
    used_tokens: Tokens,
    free_tokens: Tokens,
    built_in_tool_schema_tokens: f64,
    mcp_tool_schema_tokens: f64,
    fresh_input: f64,
    cache_write: f64,
    cache_hit_rate: String,
    cache_write_label: String,
    context_source: &'static str,
    last_api_label: &'static str,
    compact_state: String,
    compact_description: String,
    compact_pressure: f64,
    compact_reserve: f64,
}

/// The values the defaults of `contextMetrics` stand for (`EMPTY_TOOLS`, `EMPTY_MCP`, `{ count: 0 }`, `{}`).
struct Defaults {
    tools: Value,
    mcp: Value,
    skills: Value,
    plugins: Value,
    empty: Value,
}

impl Defaults {
    fn new() -> Self {
        Self {
            tools: json!({ "activeCount": 0, "count": 0, "mcpToolCount": 0, "activeMcpToolCount": 0, "activeTools": [] }),
            mcp: json!({ "connectedCount": 0, "configuredCount": 0, "failedCount": 0 }),
            skills: json!({ "count": 0 }),
            plugins: json!({ "count": 0 }),
            empty: json!({}),
        }
    }
}

/// `value || fallback`.
fn or_default<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    if truthy(value) { value } else { fallback }
}

/// `value.key || fallback`.
fn member_or<'a>(value: &'a Value, key: &str, fallback: &'a Value) -> &'a Value {
    match field(value, key) {
        Some(member) if truthy(member) => member,
        _ => fallback,
    }
}

fn metrics<'a>(input: &ContextModelInput<'a>, defaults: &'a Defaults) -> Metrics<'a> {
    let tools = or_default(input.tools_status, &defaults.tools);
    let mcp = or_default(input.mcp_status, &defaults.mcp);
    let skills = or_default(input.skills_status, &defaults.skills);
    let plugins = or_default(input.plugins_status, &defaults.plugins);
    let context = or_default(input.context_status, &defaults.empty);
    let usage = member_or(context, "usage", &defaults.empty);
    let messages = member_or(context, "messages", &defaults.empty);
    let request = member_or(context, "request", &defaults.empty);
    let schema_breakdown = member_or(request, "toolSchemaBreakdown", &defaults.empty);
    let schema_tokens_for = |buckets: &[&str]| -> f64 {
        buckets.iter().fold(0.0, |sum, bucket| sum + number_or_zero(path(schema_breakdown, &[*bucket, "tokens"])))
    };
    let compaction = member_or(context, "compaction", &defaults.empty);
    let state_window = Some(input.state_context_window);
    let state_raw = Some(input.state_raw_context_window);
    let window_tokens = number_of_first(&[
        field(context, "effectiveContextWindow"),
        field(context, "contextWindow"),
        state_window,
        field(context, "rawContextWindow"),
        state_raw,
    ]);
    let raw_window_tokens = match first_truthy(&[field(context, "rawContextWindow"), state_raw]) {
        Some(raw) => to_number(raw),
        None => zero_if_nan(window_tokens),
    };
    // Compaction boundary/trigger are sourced from the runtime contextStatus. Fall back to the visible window for the
    // boundary and to the boundary for the trigger so /context still renders on a fresh/resumed session before any
    // compaction telemetry exists.
    let compact_boundary = match first_truthy(&[field(compaction, "boundaryTokens")]) {
        Some(boundary) => to_number(boundary),
        None => zero_if_nan(window_tokens),
    };
    let compact_trigger = match first_truthy(&[field(compaction, "triggerTokens")]) {
        Some(trigger) => to_number(trigger),
        None => zero_if_nan(compact_boundary),
    };
    let measured = measured_context_usage(&json!({
        "stats": context_measurement_stats(Some(context)),
        "contextWindow": json_number(window_tokens),
    }));
    let used_tokens: Tokens = measured.get("used").filter(|used| !used.is_null()).map(to_number);
    let free_tokens: Tokens = match used_tokens {
        Some(used) if number_truthy(window_tokens) => Some(max(0.0, window_tokens - used)),
        _ => None,
    };
    let cached_read = number_or_zero(field(usage, "lastCachedReadTokens"));
    let cache_write = number_or_zero(field(usage, "lastCacheWriteTokens"));
    let fresh_input = match field(usage, "lastUncachedInputTokens").filter(|value| !value.is_null()) {
        Some(uncached) => to_number(uncached),
        None => max(number_or_zero(field(usage, "lastInputTokens")) - cached_read - cache_write, 0.0),
    };
    let last_context = number_or_zero(field(usage, "lastContextTokens"));
    let cache_denom = if number_truthy(last_context) { last_context } else { cached_read + fresh_input + cache_write };
    let compact_state = compaction_state(compaction);
    // lastDurationMs belongs to the previous, finished compaction: a running one shows no duration rather than one that
    // reads as its elapsed time.
    let compact_duration =
        if compaction_running(compaction) { String::new() } else { compact_elapsed(field(compaction, "lastDurationMs")) };
    let measured_source = measured.get("source").and_then(Value::as_str).unwrap_or("pending").to_owned();
    Metrics {
        tools,
        mcp,
        skills,
        plugins,
        context,
        usage,
        messages,
        request,
        compaction,
        window_tokens,
        raw_window_tokens,
        compact_boundary,
        compact_trigger,
        measured,
        used_tokens,
        free_tokens,
        built_in_tool_schema_tokens: schema_tokens_for(&["code", "web", "mutation", "channels", "setup", "other"]),
        mcp_tool_schema_tokens: schema_tokens_for(&["mcp"]),
        fresh_input,
        cache_write,
        cache_hit_rate: if cache_denom > 0.0 {
            format!("{}%", to_fixed(cached_read / cache_denom * 100.0, 0))
        } else {
            "N/A".to_owned()
        },
        cache_write_label: if cache_write > 0.0 {
            format!(" \u{b7} {} write", fmt(tokens_num(cache_write)))
        } else {
            String::new()
        },
        context_source: context_measurement_label(&measured_source),
        last_api_label: if truthy_of(field(context, "lastApiRequestStale")) {
            "last API request (pre-compact)"
        } else {
            "last API request"
        },
        compact_description: if compact_duration.is_empty() {
            compact_state.clone()
        } else {
            format!("{compact_state} \u{b7} {compact_duration}")
        },
        compact_state,
        compact_pressure: number_of_first(&[field(compaction, "pressureTokens"), field(compaction, "currentEstimatedTokens")]),
        compact_reserve: number_or_zero(field(compaction, "reserveTokens")),
    }
}

/// `${value || 0}` of a template literal.
fn count_text(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => value_to_string(value),
        _ => "0".to_owned(),
    }
}

fn row(value: &str, label: &str, description: String) -> Value {
    json!({ "value": value, "label": label, "description": description, "_action": value })
}

fn context_rows(m: &Metrics) -> Vec<Value> {
    let window = m.window_tokens;
    let messages_tokens = tokens_of(field(m.messages, "estimatedTokens"));
    let reasoning = tokens_num(number_or_zero(path(m.messages, &["semantic", "reasoning", "tokens"])));
    let built_in = tokens_num(m.built_in_tool_schema_tokens);
    let usage = |key: &str| tokens_of(field(m.usage, key));
    let messages = |key: &str| tokens_of(field(m.messages, key));
    let fresh = tokens_num(m.fresh_input);
    vec![
        row(
            "summary",
            "Context Usage",
            format!(
                "{}/{} ({}) \u{b7} {} free \u{b7} {} \u{b7} effective",
                fmt(m.used_tokens),
                fmt(tokens_num(window)),
                pct(m.used_tokens, window),
                fmt(m.free_tokens),
                m.context_source
            ),
        ),
        row(
            "compaction",
            "Compaction",
            format!(
                "{} \u{b7} {} pressure \u{b7} {} reserve",
                m.compact_description,
                fmt(tokens_num(m.compact_pressure)),
                fmt(tokens_num(m.compact_reserve))
            ),
        ),
        row(
            "messages",
            "Messages",
            format!(
                "{} tokens ({}) \u{b7} {} messages",
                fmt(messages_tokens),
                pct(messages_tokens, window),
                count_text(field(m.messages, "count"))
            ),
        ),
        row(
            "tools",
            "Tools",
            format!(
                "{} schema tokens ({}) \u{b7} {}/{} active",
                fmt(built_in),
                pct(built_in, window),
                count_text(field(m.tools, "activeCount")),
                count_text(field(m.tools, "count"))
            ),
        ),
        row(
            "tool-io",
            "Tool calls/results",
            format!(
                "{} calls ({}) \u{b7} {} results ({})",
                count_text(field(m.messages, "toolCallCount")),
                fmt(messages("toolCallTokens")),
                count_text(field(m.messages, "toolResultCount")),
                fmt(messages("toolResultTokens"))
            ),
        ),
        row(
            "request",
            "Request overhead",
            format!(
                "{} framing \u{b7} {} reserve incl. tools",
                fmt(tokens_of(field(m.request, "requestOverheadTokens"))),
                fmt(tokens_of(field(m.request, "reserveTokens")))
            ),
        ),
        row(
            "last-api",
            "Last API usage",
            format!(
                "{} context \u{b7} {} uncached input \u{b7} {} output \u{b7} {}",
                fmt(usage("lastContextTokens")),
                fmt(fresh),
                fmt(usage("lastOutputTokens")),
                m.last_api_label
            ),
        ),
        row(
            "reasoning",
            "Reasoning tokens",
            format!("\u{2248}{} tokens ({}) \u{b7} current context estimate", fmt(reasoning), pct(reasoning, window)),
        ),
        row(
            "cache",
            "Prompt cache",
            format!(
                "{} hit \u{b7} {} read{} \u{b7} {} new (last request)",
                m.cache_hit_rate,
                fmt(usage("lastCachedReadTokens")),
                m.cache_write_label,
                fmt(fresh)
            ),
        ),
        row(
            "free",
            "Free space",
            format!(
                "{} tokens ({}) \u{b7} raw window {}",
                fmt(m.free_tokens),
                pct(m.free_tokens, window),
                fmt(tokens_num(m.raw_window_tokens))
            ),
        ),
        row(
            "extensions",
            "Skills/plugins",
            format!("{} skills \u{b7} {} plugins", count_text(field(m.skills, "count")), count_text(field(m.plugins, "count"))),
        ),
    ]
}

/// An object whose members are the ones the source has: `JSON.stringify` leaves an `undefined` member out.
fn object<const N: usize>(members: [(&str, Option<Value>); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in members {
        if let Some(value) = value {
            map.insert(key.to_owned(), value);
        }
    }
    Value::Object(map)
}

fn some(value: Option<&Value>) -> Option<Value> {
    value.cloned()
}

fn number_member(number: f64) -> Option<Value> {
    Some(json_number(number))
}

/// `Number(...) || null`.
fn number_or_null(number: f64) -> Option<Value> {
    Some(if number_truthy(number) { json_number(number) } else { Value::Null })
}

fn tokens_member(tokens: Tokens) -> Option<Value> {
    Some(tokens.map_or(Value::Null, json_number))
}

fn context_detail(m: &Metrics) -> Value {
    let compaction = m.compaction;
    let stage = match field(compaction, "lastStage") {
        Some(stage) if truthy(stage) => stage.clone(),
        _ => Value::String("pending".to_owned()),
    };
    let pressure = number_of_first(&[
        field(compaction, "lastPressureTokens"),
        field(compaction, "pressureTokens"),
        field(compaction, "currentEstimatedTokens"),
    ]);
    let measured_at = m.measured.get("updatedAt").cloned().unwrap_or(Value::Null);
    let measurement_source = m.measured.get("source").cloned().unwrap_or(Value::Null);
    let buffer = compact_buffer_tokens(compaction, m.compact_boundary, m.compact_trigger);
    object([
        ("type", Some(json!("context"))),
        ("inspection", some(field(m.context, "inspection"))),
        (
            "usage",
            Some(object([
                ("usedTokens", tokens_member(m.used_tokens)),
                ("windowTokens", number_member(m.window_tokens)),
                ("freeTokens", tokens_member(m.free_tokens)),
                ("rawWindowTokens", number_member(m.raw_window_tokens)),
                ("source", Some(json!(m.context_source))),
                ("measurementSource", Some(measurement_source)),
                ("measuredAt", Some(measured_at)),
                ("effective", Some(json!(true))),
            ])),
        ),
        (
            "compaction",
            Some(object([
                ("stage", Some(stage)),
                ("state", Some(json!(m.compact_state))),
                ("triggerTokens", number_member(m.compact_trigger)),
                ("boundaryTokens", number_member(m.compact_boundary)),
                ("bufferTokens", Some(buffer.map_or(Value::Null, json_number))),
                ("pressureTokens", number_or_null(pressure)),
                ("reserveTokens", number_or_null(number_or_zero(field(compaction, "reserveTokens")))),
                ("lastChanged", Some(json!(field(compaction, "lastChanged") == Some(&Value::Bool(true))))),
            ])),
        ),
        (
            "messages",
            Some(object([
                ("tokens", some(field(m.messages, "estimatedTokens"))),
                ("count", some(field(m.messages, "count"))),
                ("semantic", some(field(m.messages, "semantic"))),
            ])),
        ),
        (
            "tools",
            Some(object([
                ("schemaTokens", number_member(m.built_in_tool_schema_tokens)),
                ("active", some(field(m.tools, "activeCount"))),
                ("count", some(field(m.tools, "count"))),
            ])),
        ),
        (
            "toolIo",
            Some(object([
                ("calls", some(field(m.messages, "toolCallCount"))),
                ("results", some(field(m.messages, "toolResultCount"))),
            ])),
        ),
        (
            "request",
            Some(object([
                ("toolSchemaBreakdown", some(field(m.request, "toolSchemaBreakdown"))),
                ("overheadTokens", some(field(m.request, "requestOverheadTokens"))),
                ("reserveTokens", some(field(m.request, "reserveTokens"))),
            ])),
        ),
        (
            "lastApi",
            Some(object([
                ("contextTokens", some(field(m.usage, "lastContextTokens"))),
                ("inputTokens", number_member(m.fresh_input)),
                ("rawInputTokens", some(field(m.usage, "lastInputTokens"))),
                ("outputTokens", some(field(m.usage, "lastOutputTokens"))),
            ])),
        ),
        (
            "cache",
            Some(object([
                ("hitRate", Some(json!(m.cache_hit_rate))),
                ("readTokens", some(field(m.usage, "lastCachedReadTokens"))),
                ("writeTokens", number_member(m.cache_write)),
            ])),
        ),
        (
            "extensions",
            Some(object([("skills", some(field(m.skills, "count"))), ("plugins", some(field(m.plugins, "count")))])),
        ),
        (
            "mcp",
            Some(object([
                ("connected", some(field(m.mcp, "connectedCount"))),
                ("configured", some(field(m.mcp, "configuredCount"))),
                ("failed", some(field(m.mcp, "failedCount"))),
                ("tools", some(field(m.tools, "mcpToolCount"))),
                ("activeTools", some(field(m.tools, "activeMcpToolCount"))),
                ("schemaTokens", number_member(m.mcp_tool_schema_tokens)),
            ])),
        ),
    ])
}

/// `buildContextPanelModel(input)`.
pub fn build_context_panel_model(input: &ContextModelInput) -> ContextPanelModel {
    let defaults = Defaults::new();
    let metrics = metrics(input, &defaults);
    let mut detail = context_detail(&metrics);
    // The session's output speed from the usage ledger; null until a timed request produced output.
    let speed = match field(input.session_usage, "outputTokensPerSecond") {
        Some(rate) if !rate.is_null() => rate.clone(),
        _ => Value::Null,
    };
    if let Value::Object(map) = &mut detail {
        map.insert("speed".to_owned(), json!({ "outputTokensPerSecond": speed }));
    }
    ContextPanelModel { rows: context_rows(&metrics), detail }
}
