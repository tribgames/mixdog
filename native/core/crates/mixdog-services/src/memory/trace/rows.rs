//! Event -> row normalisation of Node's trace store (`trace-store.mjs` `insertTraceEvents`,
//! `trace-store/agent-call-rows.mjs`, `agent-session-summary.mjs`), as pure functions. Columns
//! carry what Node binds, so a test compares them with the recorded parameters.

#[cfg(test)]
use mixdog_js::json_number;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use mixdog_trace::slice_utf16;
use mixdog_trace::stringify;
use mixdog_trace::truthy;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// One event as given: a JSON value, because Node reads properties off whatever the array holds
/// (`null` throws, any other non-object reads as an object with no keys).
pub type Event = Value;

/// A value Postgres would reject (Node's `pg` sends it and the statement fails).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowError(pub String);

const TOOL_ARGS_MAX_BYTES: usize = 65536;
const TRACE_COLS: [&str; 20] = [
    "ts",
    "session_id",
    "iteration",
    "kind",
    "agent",
    "model",
    "tool_name",
    "tool_ms",
    "result_kind",
    "result_error_category",
    "result_error_first_line",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "duration_ms",
    "error_message",
    "payload",
    "parent_span_id",
    "entry_id",
];

/// Rows per `INSERT` (`floor(65535 / columns)`).
pub const TRACE_INSERT_MAX_ROWS: usize = 65_535 / TRACE_COLS.len();

/// `a ?? b ?? ...` over event keys.
fn first<'a>(ev: &'a Event, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| ev.get(*key).filter(|v| !v.is_null()))
}

/// A value bound to a TEXT column.
fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Object(_) | Value::Array(_) => Some(stringify(value?)),
        other => Some(value_to_string(other)),
    }
}

/// `numberOrNull(value)`: `value != null ? Number(value) : null`.
fn number_or_null(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| !v.is_null()).map(to_number)
}

#[cfg(test)]
fn number_json(value: Option<f64>) -> Value {
    value.map_or(Value::Null, json_number)
}

fn int32(value: Option<f64>) -> Result<Option<i32>, RowError> {
    let Some(n) = value else { return Ok(None) };
    if n.is_finite() && n.fract() == 0.0 && n >= f64::from(i32::MIN) && n <= f64::from(i32::MAX) {
        Ok(Some(n as i32))
    } else {
        Err(RowError(format!("invalid input syntax for type integer: \"{}\"", mixdog_js::number_to_string(n))))
    }
}

fn int64(value: Option<f64>) -> Result<Option<i64>, RowError> {
    let Some(n) = value else { return Ok(None) };
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e18 {
        Ok(Some(n as i64))
    } else {
        Err(RowError(format!("invalid input syntax for type bigint: \"{}\"", mixdog_js::number_to_string(n))))
    }
}

/// `eventTimestampMs`: epoch ms; ISO strings parsed; now when absent or invalid.
pub fn event_timestamp_ms(ev: &Event, now_ms: i64) -> f64 {
    let ts = match ev.get("ts") {
        Some(Value::String(s)) => mixdog_js::time::date_parse(s),
        Some(v) => to_number(v),
        None => f64::NAN,
    };
    if ts.is_finite() { ts } else { now_ms as f64 }
}

/// `new Date(ms).toISOString()`.
fn event_timestamp_iso(ev: &Event, now_ms: i64) -> Result<String, RowError> {
    let ms = event_timestamp_ms(ev, now_ms).trunc();
    let stamp = (ms.abs() <= 8.64e15)
        .then(|| chrono::DateTime::from_timestamp_millis(ms as i64))
        .flatten()
        .filter(|t| (0..=9999).contains(&chrono::Datelike::year(t)));
    stamp
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .ok_or_else(|| RowError("Invalid time value".into()))
}

// ---------------------------------------------------------------------------
// trace_events
// ---------------------------------------------------------------------------

/// One `trace_events` row, in column order.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceEventRow {
    pub ts: f64,
    pub session_id: Option<String>,
    pub iteration: Option<f64>,
    pub kind: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub tool_name: Option<String>,
    pub tool_ms: Option<f64>,
    pub result_kind: Option<String>,
    pub result_error_category: Option<String>,
    pub result_error_first_line: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cached_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub duration_ms: Option<f64>,
    pub error_message: Option<String>,
    /// JSON text (a string payload is bound as given).
    pub payload: String,
    pub parent_span_id: Option<f64>,
    pub entry_id: Option<f64>,
}

/// The bound values of one `trace_events` row, typed for the driver.
pub struct TraceEventCells {
    pub ts: i64,
    pub session_id: Option<String>,
    pub iteration: Option<i32>,
    pub kind: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub tool_name: Option<String>,
    pub tool_ms: Option<i32>,
    pub result_kind: Option<String>,
    pub result_error_category: Option<String>,
    pub result_error_first_line: Option<String>,
    pub input_tokens: Option<i32>,
    pub output_tokens: Option<i32>,
    pub cached_tokens: Option<i32>,
    pub cache_write_tokens: Option<i32>,
    pub duration_ms: Option<i32>,
    pub error_message: Option<String>,
    pub payload: String,
    pub parent_span_id: Option<i64>,
    pub entry_id: Option<i64>,
}

impl TraceEventRow {
    pub fn from_event(ev: &Event, now_ms: i64) -> Result<Self, RowError> {
        if ev.is_null() {
            return Err(RowError("Cannot read properties of null (reading 'payload')".into()));
        }
        let payload = match ev.get("payload").filter(|v| !v.is_null()) {
            Some(Value::String(s)) => s.clone(),
            Some(other) => stringify(other),
            None => "{}".to_string(),
        };
        Ok(Self {
            ts: event_timestamp_ms(ev, now_ms),
            session_id: text(ev.get("session_id")),
            iteration: number_or_null(ev.get("iteration")),
            kind: first(ev, &["kind"]).map_or_else(|| "unknown".to_string(), value_to_string),
            agent: text(ev.get("agent")),
            model: text(ev.get("model")),
            tool_name: text(ev.get("tool_name")),
            tool_ms: number_or_null(ev.get("tool_ms")),
            result_kind: text(first(ev, &["result_kind", "resultKind"])),
            result_error_category: text(first(ev, &["result_error_category", "resultErrorCategory"])),
            result_error_first_line: text(first(ev, &["result_error_first_line", "resultErrorFirstLine"])),
            input_tokens: number_or_null(ev.get("input_tokens")),
            output_tokens: number_or_null(ev.get("output_tokens")),
            cached_tokens: number_or_null(ev.get("cached_tokens")),
            cache_write_tokens: number_or_null(ev.get("cache_write_tokens")),
            duration_ms: number_or_null(ev.get("duration_ms")),
            error_message: text(ev.get("error_message")),
            payload,
            parent_span_id: number_or_null(ev.get("parent_span_id")),
            entry_id: number_or_null(ev.get("entry_id")),
        })
    }

    /// The parameters as Node binds them, for the golden comparison.
    #[cfg(test)]
    pub fn params_json(&self) -> Vec<Value> {
        let string = |v: &Option<String>| v.clone().map_or(Value::Null, Value::String);
        vec![
            json_number(self.ts),
            string(&self.session_id),
            number_json(self.iteration),
            Value::String(self.kind.clone()),
            string(&self.agent),
            string(&self.model),
            string(&self.tool_name),
            number_json(self.tool_ms),
            string(&self.result_kind),
            string(&self.result_error_category),
            string(&self.result_error_first_line),
            number_json(self.input_tokens),
            number_json(self.output_tokens),
            number_json(self.cached_tokens),
            number_json(self.cache_write_tokens),
            number_json(self.duration_ms),
            string(&self.error_message),
            Value::String(self.payload.clone()),
            number_json(self.parent_span_id),
            number_json(self.entry_id),
        ]
    }

    /// Checks the numbers fit their columns (a value Postgres would reject fails the batch).
    pub fn cells(&self) -> Result<TraceEventCells, RowError> {
        Ok(TraceEventCells {
            ts: int64(Some(self.ts))?.unwrap_or_default(),
            session_id: self.session_id.clone(),
            iteration: int32(self.iteration)?,
            kind: self.kind.clone(),
            agent: self.agent.clone(),
            model: self.model.clone(),
            tool_name: self.tool_name.clone(),
            tool_ms: int32(self.tool_ms)?,
            result_kind: self.result_kind.clone(),
            result_error_category: self.result_error_category.clone(),
            result_error_first_line: self.result_error_first_line.clone(),
            input_tokens: int32(self.input_tokens)?,
            output_tokens: int32(self.output_tokens)?,
            cached_tokens: int32(self.cached_tokens)?,
            cache_write_tokens: int32(self.cache_write_tokens)?,
            duration_ms: int32(self.duration_ms)?,
            error_message: self.error_message.clone(),
            payload: self.payload.clone(),
            parent_span_id: int64(self.parent_span_id)?,
            entry_id: int64(self.entry_id)?,
        })
    }
}

/// `INSERT INTO trace_events (...) VALUES ($1, ...), (...)` for `rows` rows.
pub fn insert_trace_events_sql(rows: usize) -> String {
    let width = TRACE_COLS.len();
    let groups: Vec<String> = (0..rows)
        .map(|row| {
            let cells: Vec<String> = (1..=width).map(|col| format!("${}", row * width + col)).collect();
            format!("({})", cells.join(", "))
        })
        .collect();
    format!("INSERT INTO trace_events ({}) VALUES {}", TRACE_COLS.join(", "), groups.join(", "))
}

// ---------------------------------------------------------------------------
// agent_calls / agent_llm / agent_sessions
// ---------------------------------------------------------------------------

/// One bound array parameter.
#[derive(Debug, Clone, PartialEq)]
pub enum Column {
    Text(Vec<Option<String>>),
    Int(Vec<Option<i32>>),
}

impl Column {
    #[cfg(test)]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(v) => Value::Array(v.iter().map(|s| s.clone().map_or(Value::Null, Value::String)).collect()),
            Self::Int(v) => Value::Array(v.iter().map(|n| n.map_or(Value::Null, Value::from)).collect()),
        }
    }
}

struct Common {
    sid: String,
    ts: String,
    iteration: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolRow {
    pub session_id: String,
    pub iteration: Option<f64>,
    pub ts: String,
    pub tool_name: Option<String>,
    pub tool_kind: Option<String>,
    pub tool_ms: Option<f64>,
    pub tool_args: Option<Value>,
    pub result_kind: Option<String>,
    pub result_error_category: Option<String>,
    pub result_error_first_line: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LlmRow {
    pub session_id: String,
    pub iteration: Option<f64>,
    pub ts: String,
    pub model: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cached_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub prompt_tokens: Option<f64>,
    pub response_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionSummary {
    pub tool_calls: i32,
    pub llm_calls: i32,
    pub max_iteration: f64,
    pub total_input: i128,
    pub total_output: i128,
    pub ts0: String,
    pub ts1: String,
    pub agent: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Default)]
pub struct AgentRows {
    pub tool_rows: Vec<ToolRow>,
    pub llm_rows: Vec<LlmRow>,
    /// In first-touched order (a JavaScript `Map`).
    pub sessions: Vec<(String, SessionSummary)>,
}

/// `capToolArgs`: a 64 KB cap; oversized -> sha256 + a 512-unit preview.
fn cap_tool_args(args: Option<&Value>) -> Option<Value> {
    let args = args.filter(|v| !v.is_null())?;
    let raw = match args {
        Value::String(s) => s.clone(),
        other => stringify(other),
    };
    if raw.len() <= TOOL_ARGS_MAX_BYTES {
        return Some(match args {
            Value::String(_) => mixdog_js::json_parse(&raw).unwrap_or(Value::String(raw)),
            other => other.clone(),
        });
    }
    let digest: String = Sha256::digest(raw.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let mut object = Map::new();
    object.insert("_oversized".into(), Value::Bool(true));
    object.insert("sha256".into(), Value::String(digest));
    object.insert("preview".into(), Value::String(slice_utf16(&raw, 512)));
    Some(Value::Object(object))
}

fn tool_row(ev: &Event, c: Common) -> ToolRow {
    ToolRow {
        session_id: c.sid,
        iteration: c.iteration,
        ts: c.ts,
        tool_name: text(first(ev, &["tool_name", "toolName"])),
        tool_kind: text(first(ev, &["tool_kind", "toolKind"])),
        tool_ms: number_or_null(first(ev, &["tool_ms", "toolMs"])),
        tool_args: cap_tool_args(first(ev, &["tool_args", "toolArgs"])),
        result_kind: text(first(ev, &["result_kind", "resultKind"])),
        result_error_category: text(first(ev, &["result_error_category", "resultErrorCategory"])),
        result_error_first_line: text(first(ev, &["result_error_first_line", "resultErrorFirstLine"])),
    }
}

fn llm_row(ev: &Event, c: Common) -> LlmRow {
    LlmRow {
        session_id: c.sid,
        iteration: c.iteration,
        ts: c.ts,
        model: text(ev.get("model")),
        input_tokens: number_or_null(first(ev, &["input_tokens", "inputTokens"])),
        output_tokens: number_or_null(first(ev, &["output_tokens", "outputTokens"])),
        cached_tokens: number_or_null(first(ev, &["cached_tokens", "cachedTokens"])),
        cache_write_tokens: number_or_null(first(ev, &["cache_write_tokens", "cacheWriteTokens"])),
        prompt_tokens: number_or_null(first(ev, &["prompt_tokens", "promptTokens"])),
        response_id: text(first(ev, &["response_id", "responseId"])),
    }
}

/// `eventSessionId`: `ev.session_id ?? ev.sessionId`; an event without a truthy id is dropped.
fn event_session_id(ev: &Event) -> Option<&Value> {
    first(ev, &["session_id", "sessionId"]).filter(|v| truthy(v))
}

/// `collectAgentCallRows` + `summarizeAgentSessions`.
pub fn collect_agent_rows(events: &[Event], now_ms: i64) -> Result<AgentRows, RowError> {
    let mut rows = AgentRows::default();
    for ev in events {
        if ev.is_null() {
            return Err(RowError("Cannot read properties of null (reading 'session_id')".into()));
        }
        let Some(sid) = event_session_id(ev) else { continue };
        let common = || -> Result<Common, RowError> {
            Ok(Common {
                sid: text(Some(sid)).unwrap_or_default(),
                ts: event_timestamp_iso(ev, now_ms)?,
                iteration: number_or_null(ev.get("iteration")),
            })
        };
        let kind = ev.get("kind").and_then(Value::as_str);
        if kind == Some("tool") {
            rows.tool_rows.push(tool_row(ev, common()?));
        } else if kind == Some("usage_raw")
            || (ev.get("input_tokens").is_some_and(|v| !v.is_null()) && ev.get("output_tokens").is_some_and(|v| !v.is_null()))
        {
            rows.llm_rows.push(llm_row(ev, common()?));
        }
    }
    summarize(&mut rows, events, now_ms)?;
    Ok(rows)
}

fn session_slot<'a>(
    sessions: &'a mut Vec<(String, SessionSummary)>,
    sid: &str,
    ts: &str,
) -> &'a mut SessionSummary {
    if let Some(at) = sessions.iter().position(|(key, _)| key == sid) {
        return &mut sessions[at].1;
    }
    sessions.push((sid.to_string(), empty_summary(ts)));
    &mut sessions.last_mut().expect("just pushed").1
}

fn empty_summary(ts: &str) -> SessionSummary {
    SessionSummary {
        tool_calls: 0,
        llm_calls: 0,
        max_iteration: 0.0,
        total_input: 0,
        total_output: 0,
        ts0: ts.to_string(),
        ts1: ts.to_string(),
        agent: None,
        model: None,
    }
}

fn touch(s: &mut SessionSummary, iteration: Option<f64>, ts: &str) {
    if let Some(i) = iteration.filter(|i| *i > s.max_iteration) {
        s.max_iteration = i;
    }
    if ts < s.ts0.as_str() {
        s.ts0 = ts.to_string();
    }
    if ts > s.ts1.as_str() {
        s.ts1 = ts.to_string();
    }
}

fn big_int(value: Option<f64>) -> Result<i128, RowError> {
    match value {
        None => Ok(0),
        Some(n) if n.is_finite() && n.fract() == 0.0 => Ok(n as i128),
        Some(n) => Err(RowError(format!("The number {} cannot be converted to a BigInt", mixdog_js::number_to_string(n)))),
    }
}

fn summarize(rows: &mut AgentRows, events: &[Event], now_ms: i64) -> Result<(), RowError> {
    let mut sessions = Vec::new();
    for r in &rows.tool_rows {
        let s = session_slot(&mut sessions, &r.session_id, &r.ts);
        s.tool_calls += 1;
        touch(s, r.iteration, &r.ts);
    }
    for r in &rows.llm_rows {
        let s = session_slot(&mut sessions, &r.session_id, &r.ts);
        s.llm_calls += 1;
        s.total_input += big_int(r.input_tokens)?;
        s.total_output += big_int(r.output_tokens)?;
        if let Some(model) = r.model.as_ref().filter(|m| !m.is_empty()) {
            s.model = Some(model.clone());
        }
        touch(s, r.iteration, &r.ts);
    }
    let presets: Vec<(&Event, String)> = events
        .iter()
        .filter(|ev| ev.get("kind").and_then(Value::as_str) == Some("preset_assign"))
        .filter_map(|ev| event_session_id(ev).map(|sid| (ev, text(Some(sid)).unwrap_or_default())))
        .collect();
    for (ev, sid) in &presets {
        let agent = ev.get("agent").filter(|v| truthy(v));
        if let (Some(at), Some(agent)) = (sessions.iter().position(|(k, _)| k == sid), agent) {
            sessions[at].1.agent = text(Some(agent));
        }
    }
    for (ev, sid) in &presets {
        if sessions.iter().any(|(k, _)| k == sid) {
            continue;
        }
        let mut s = empty_summary(&event_timestamp_iso(ev, now_ms)?);
        s.agent = text(ev.get("agent"));
        s.model = text(ev.get("model"));
        sessions.push((sid.clone(), s));
    }
    rows.sessions = sessions;
    Ok(())
}

fn text_col(values: impl Iterator<Item = Option<String>>) -> Column {
    Column::Text(values.collect())
}

fn int_col(values: impl Iterator<Item = Option<f64>>) -> Result<Column, RowError> {
    Ok(Column::Int(values.map(int32).collect::<Result<_, _>>()?))
}

/// The ten parameters of `insertToolRows`.
pub fn tool_columns(rows: &[ToolRow]) -> Result<Vec<Column>, RowError> {
    Ok(vec![
        text_col(rows.iter().map(|r| Some(r.session_id.clone()))),
        int_col(rows.iter().map(|r| r.iteration))?,
        text_col(rows.iter().map(|r| Some(r.ts.clone()))),
        text_col(rows.iter().map(|r| r.tool_name.clone())),
        text_col(rows.iter().map(|r| r.tool_kind.clone())),
        int_col(rows.iter().map(|r| r.tool_ms))?,
        text_col(rows.iter().map(|r| r.tool_args.as_ref().filter(|v| !v.is_null()).map(stringify))),
        text_col(rows.iter().map(|r| r.result_kind.clone())),
        text_col(rows.iter().map(|r| r.result_error_category.clone())),
        text_col(rows.iter().map(|r| r.result_error_first_line.clone())),
    ])
}

/// The ten parameters of `insertLlmRows`.
pub fn llm_columns(rows: &[LlmRow]) -> Result<Vec<Column>, RowError> {
    Ok(vec![
        text_col(rows.iter().map(|r| Some(r.session_id.clone()))),
        int_col(rows.iter().map(|r| r.iteration))?,
        text_col(rows.iter().map(|r| Some(r.ts.clone()))),
        text_col(rows.iter().map(|r| r.model.clone())),
        int_col(rows.iter().map(|r| r.input_tokens))?,
        int_col(rows.iter().map(|r| r.output_tokens))?,
        int_col(rows.iter().map(|r| r.cached_tokens))?,
        int_col(rows.iter().map(|r| r.cache_write_tokens))?,
        int_col(rows.iter().map(|r| r.prompt_tokens))?,
        text_col(rows.iter().map(|r| r.response_id.clone())),
    ])
}

/// The ten parameters of `upsertAgentSessions`.
pub fn session_columns(sessions: &[(String, SessionSummary)]) -> Result<Vec<Column>, RowError> {
    let ints = |pick: fn(&SessionSummary) -> f64| int_col(sessions.iter().map(|(_, s)| Some(pick(s))));
    Ok(vec![
        text_col(sessions.iter().map(|(k, _)| Some(k.clone()))),
        text_col(sessions.iter().map(|(_, s)| s.agent.clone())),
        text_col(sessions.iter().map(|(_, s)| s.model.clone())),
        text_col(sessions.iter().map(|(_, s)| Some(s.ts0.clone()))),
        text_col(sessions.iter().map(|(_, s)| Some(s.ts1.clone()))),
        ints(|s| f64::from(s.tool_calls))?,
        ints(|s| f64::from(s.llm_calls))?,
        ints(|s| s.max_iteration)?,
        text_col(sessions.iter().map(|(_, s)| Some(s.total_input.to_string()))),
        text_col(sessions.iter().map(|(_, s)| Some(s.total_output.to_string()))),
    ])
}
