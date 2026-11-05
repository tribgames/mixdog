//! The JSONL lifecycle of `exec --json` (`headless-json-lifecycle.mjs`): one event per line,
//! mirroring the run's progress onto a thread/turn/item stream, closed by a `turn.completed|failed`
//! pair and a `result` line.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::SecondsFormat;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Route;
use super::Sink;
use super::route::clean;
use super::usage::SessionStats;
use super::usage::UsageDelta;
use super::usage::js_number;
use super::usage::non_negative;
use mixdog_js::js_trim;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| chrono::Utc::now().timestamp_millis())
}

/// What the session reports at `thread.started`.
pub struct ThreadInfo {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub fast: bool,
    pub cwd: String,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// The engine's phase marks of one tool call (ms epoch); an absent or zero mark falls back to the
/// previous phase's.
#[derive(Debug, Clone, Default)]
pub struct ToolTiming {
    pub dispatch_started_at: Option<f64>,
    pub execution_started_at: Option<f64>,
    pub execution_completed_at: Option<f64>,
    pub postprocess_started_at: Option<f64>,
    pub result_completed_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Normal,
    Error,
    Skipped,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub call_id: String,
    pub name: Option<String>,
    pub content: Value,
    pub is_error: bool,
    pub kind: ToolKind,
    pub timing: Option<ToolTiming>,
}

/// How the final answer ended.
#[derive(Debug, Clone, Default)]
pub struct ResultInfo {
    pub stop_reason: Option<String>,
    pub termination_reason: Option<String>,
}

struct Request {
    id: String,
    index: u64,
    started_at: i64,
}

struct Batch {
    id: String,
    started_at: i64,
}

struct ToolEntry {
    id: String,
    name: String,
    arguments: Value,
    started_at: i64,
}

pub struct Lifecycle {
    out: Arc<dyn Sink>,
    now: Clock,
    thread_id: String,
    turn_id: &'static str,
    provider: String,
    model: String,
    effort: Option<String>,
    fast: bool,
    cwd: String,
    tool_mode: &'static str,
    web_search: bool,
    started: bool,
    turn_started_at: i64,
    item_sequence: u64,
    tool_call_count: u64,
    provider_request_count: u64,
    provider_duration_ms: f64,
    active_request: Option<Request>,
    active_batch: Option<Batch>,
    reasoning_text: String,
    last_assistant_text: String,
    pending_tools: Vec<ToolEntry>,
    completed_tools: HashSet<String>,
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("a millisecond clock value is a date")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn count(value: u64) -> Value {
    Value::from(value)
}

fn usage_delta_summary(delta: &UsageDelta) -> Value {
    json!({
        "input_tokens": js_number(non_negative(delta.input)),
        "cached_input_tokens": js_number(non_negative(delta.cached_read)),
        "cache_write_input_tokens": js_number(non_negative(delta.cache_write)),
        "output_tokens": js_number(non_negative(delta.output)),
    })
}

fn usage_summary(stats: &SessionStats, tool_calls: u64) -> Value {
    json!({
        "input_tokens": js_number(non_negative(stats.input_tokens)),
        "cached_input_tokens": js_number(non_negative(stats.cached_tokens)),
        "cache_write_input_tokens": js_number(non_negative(stats.cache_write_tokens)),
        "output_tokens": js_number(non_negative(stats.output_tokens)),
        "tool_calls": count(tool_calls),
    })
}

/// `toolCallArguments`: a string is parsed as JSON, else wrapped as `{input}`; a missing value is `{}`.
fn tool_arguments(raw: &Value) -> Value {
    match raw {
        Value::Null => json!({}),
        Value::String(text) => {
            let text = js_trim(text);
            if text.is_empty() {
                return json!({});
            }
            serde_json::from_str(text).unwrap_or_else(|_| json!({ "input": raw }))
        }
        other => other.clone(),
    }
}

/// `a || b` over numbers: a missing, zero or NaN mark falls back.
fn mark(value: Option<f64>, fallback: f64) -> f64 {
    non_negative(match value {
        Some(value) if value != 0.0 && !value.is_nan() => value,
        _ => fallback,
    })
}

fn object(fields: Vec<(&str, Value)>) -> Map<String, Value> {
    fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect()
}

impl Lifecycle {
    pub fn new(out: Arc<dyn Sink>, now: Clock, thread_id: String, route: &Route, cwd: &str, tool_mode: &'static str, web_search: bool) -> Self {
        let Route { provider, model, effort, fast } = route;
        Self {
            tool_mode,
            out,
            now,
            thread_id,
            turn_id: "turn_1",
            provider: clean(Some(provider)).to_owned(),
            model: clean(Some(model)).to_owned(),
            effort: Some(clean(effort.as_deref())).filter(|effort| !effort.is_empty()).map(str::to_owned),
            fast: *fast,
            cwd: clean(Some(cwd)).to_owned(),
            web_search,
            started: false,
            turn_started_at: 0,
            item_sequence: 0,
            tool_call_count: 0,
            provider_request_count: 0,
            provider_duration_ms: 0.0,
            active_request: None,
            active_batch: None,
            reasoning_text: String::new(),
            last_assistant_text: String::new(),
            pending_tools: Vec::new(),
            completed_tools: HashSet::new(),
        }
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn tool_call_count(&self) -> u64 {
        self.tool_call_count
    }

    fn emit(&self, event: Vec<(&str, Value)>, at: i64) {
        let mut line = object(vec![("schema_version", json!(1)), ("timestamp", json!(iso(at)))]);
        line.extend(object(event));
        self.out.out(&format!("{}\n", Value::Object(line)));
    }

    fn turn_event(&self, kind: &str, fields: Vec<(&str, Value)>, at: i64) {
        let mut event = vec![("type", json!(kind)), ("thread_id", json!(self.thread_id)), ("turn_id", json!(self.turn_id))];
        event.extend(fields);
        self.emit(event, at);
    }

    fn item_completed(&self, item: Value, at: i64) {
        self.turn_event("item.completed", vec![("item", item)], at);
    }

    fn next_item_id(&mut self, prefix: &str) -> String {
        self.item_sequence += 1;
        format!("{prefix}_{}", self.item_sequence)
    }

    /// `startThread`: `thread.started` and `turn.started`, once.
    pub fn start(&mut self, info: &ThreadInfo) {
        if self.started {
            return;
        }
        self.thread_id = Some(clean(Some(&info.id))).filter(|id| !id.is_empty()).map_or(self.thread_id.clone(), str::to_owned);
        self.provider = Some(clean(Some(&info.provider))).filter(|v| !v.is_empty()).map_or(self.provider.clone(), str::to_owned);
        self.model = Some(clean(Some(&info.model))).filter(|v| !v.is_empty()).map_or(self.model.clone(), str::to_owned);
        self.effort = Some(clean(info.effort.as_deref())).filter(|v| !v.is_empty()).map(str::to_owned).or(self.effort.clone());
        self.fast = info.fast || self.fast;
        self.cwd = Some(clean(Some(&info.cwd))).filter(|v| !v.is_empty()).map_or(self.cwd.clone(), str::to_owned);
        self.turn_started_at = (self.now)();
        self.started = true;
        self.emit(
            vec![
                ("type", json!("thread.started")),
                ("thread_id", json!(self.thread_id)),
                (
                    "session",
                    json!({
                        "provider": self.provider,
                        "model": self.model,
                        "effort": self.effort,
                        "fast": self.fast,
                        "cwd": self.cwd,
                        "tool_mode": self.tool_mode,
                        "approval_mode": "implicit",
                        "delegation": false,
                        "web_search": self.web_search,
                    }),
                ),
            ],
            self.turn_started_at,
        );
        self.turn_event("turn.started", vec![], self.turn_started_at);
    }

    /// `startThread()` without a runtime: the values the route named.
    fn ensure_started(&mut self) {
        if !self.started {
            let info = ThreadInfo {
                id: self.thread_id.clone(),
                provider: self.provider.clone(),
                model: self.model.clone(),
                effort: self.effort.clone(),
                fast: self.fast,
                cwd: self.cwd.clone(),
            };
            self.start(&info);
        }
    }

    pub fn on_provider_send_started(&mut self) {
        self.ensure_started();
        if self.active_request.is_some() {
            self.complete_request("failed", None, (self.now)());
        }
        let started_at = (self.now)();
        self.provider_request_count += 1;
        let request = Request { id: format!("model_request_{}", self.provider_request_count), index: self.provider_request_count, started_at };
        self.turn_event(
            "model.request.started",
            vec![("request_id", json!(request.id)), ("request_index", count(request.index))],
            started_at,
        );
        self.active_request = Some(request);
    }

    fn complete_request(&mut self, status: &str, delta: Option<&UsageDelta>, at: i64) {
        let Some(request) = self.active_request.take() else { return };
        let duration = (at - request.started_at).max(0) as f64;
        self.provider_duration_ms += duration;
        let mut fields = vec![
            ("request_id", json!(request.id)),
            ("request_index", count(request.index)),
            ("duration_ms", js_number(duration)),
        ];
        if let Some(delta) = delta {
            fields.push(("usage", usage_delta_summary(delta)));
        }
        self.turn_event(&format!("model.request.{status}"), fields, at);
    }

    pub fn on_usage_delta(&mut self, delta: &UsageDelta) {
        let at = (self.now)();
        self.complete_request("completed", Some(delta), at);
    }

    pub fn on_reasoning_delta(&mut self, chunk: &str) {
        self.reasoning_text.push_str(chunk);
    }

    fn flush_reasoning(&mut self, at: i64) {
        let text = std::mem::take(&mut self.reasoning_text);
        if js_trim(&text).is_empty() {
            return;
        }
        let id = self.next_item_id("reasoning");
        self.item_completed(json!({ "id": id, "type": "reasoning", "text": text, "status": "completed" }), at);
    }

    pub fn on_assistant_text(&mut self, text: &str) {
        let at = (self.now)();
        self.emit_assistant(text, at);
    }

    fn emit_assistant(&mut self, text: &str, at: i64) {
        if js_trim(text).is_empty() {
            return;
        }
        self.flush_reasoning(at);
        self.last_assistant_text = text.to_owned();
        let id = self.next_item_id("message");
        self.item_completed(json!({ "id": id, "type": "agent_message", "text": text, "status": "completed" }), at);
    }

    fn tool_item(entry: &ToolEntry, fields: Vec<(&str, Value)>) -> Value {
        let mut item = object(vec![
            ("id", json!(entry.id)),
            ("type", json!("tool_call")),
            ("name", json!(entry.name)),
            ("arguments", entry.arguments.clone()),
        ]);
        item.extend(object(fields));
        Value::Object(item)
    }

    /// A tool call the model issued (`onAssistantToolCallObserved` and `onToolCall`).
    pub fn on_tool_observed(&mut self, call: &ToolCall) {
        self.ensure_started();
        let at = (self.now)();
        self.flush_reasoning(at);
        let call_id = match clean(Some(&call.id)) {
            "" => self.next_item_id("tool"),
            id => id.to_owned(),
        };
        if self.pending_tools.iter().any(|entry| entry.id == call_id) || self.completed_tools.contains(&call_id) {
            return;
        }
        let name = match clean(Some(&call.name)) {
            "" => "tool".to_owned(),
            name => name.to_owned(),
        };
        let entry = ToolEntry { id: call_id, name, arguments: tool_arguments(&call.arguments), started_at: at };
        self.tool_call_count += 1;
        let item = Self::tool_item(&entry, vec![("status", json!("in_progress")), ("started_at", json!(iso(at)))]);
        self.turn_event("item.started", vec![("item", item)], at);
        self.pending_tools.push(entry);
    }

    pub fn on_tool_result(&mut self, result: &ToolResult) {
        let at = (self.now)();
        let call_id = clean(Some(&result.call_id)).to_owned();
        if call_id.is_empty() || self.completed_tools.contains(&call_id) {
            return;
        }
        if !self.pending_tools.iter().any(|entry| entry.id == call_id) {
            let name = result.name.clone().filter(|name| !name.is_empty()).unwrap_or_else(|| "tool".into());
            self.on_tool_observed(&ToolCall { id: call_id.clone(), name, arguments: json!({}) });
        }
        let Some(position) = self.pending_tools.iter().position(|entry| entry.id == call_id) else { return };
        let entry = self.pending_tools.remove(position);
        self.completed_tools.insert(call_id);
        let timing = tool_timing(&entry, result.timing.as_ref(), at);
        let status = match (result.is_error || result.kind == ToolKind::Error, result.kind) {
            (true, _) => "failed",
            (false, ToolKind::Skipped) => "skipped",
            _ => "completed",
        };
        let item = Self::tool_item(
            &entry,
            vec![
                ("output", result.content.clone()),
                ("status", json!(status)),
                ("started_at", json!(iso(entry.started_at))),
                ("completed_at", json!(iso(at))),
                ("duration_ms", timing["total_ms"].clone()),
                ("timing", timing),
            ],
        );
        self.item_completed(item, at);
    }

    pub fn on_tool_batch_started(&mut self) {
        let started_at = (self.now)();
        let id = format!("tool_batch_{}", self.provider_request_count.max(1));
        self.turn_event("tool.batch.started", vec![("batch_id", json!(id))], started_at);
        self.active_batch = Some(Batch { id, started_at });
    }

    pub fn on_tool_batch_completed(&mut self, iteration: f64, calls: f64, elapsed_ms: Option<f64>) {
        let completed_at = (self.now)();
        let batch = self.active_batch.take().unwrap_or_else(|| Batch { id: format!("tool_batch_{}", self.provider_request_count.max(1)), started_at: completed_at });
        self.turn_event(
            "tool.batch.completed",
            vec![
                ("batch_id", json!(batch.id)),
                ("iteration", js_number(non_negative(iteration))),
                ("calls", js_number(non_negative(calls))),
                ("duration_ms", js_number(non_negative(elapsed_ms.unwrap_or((completed_at - batch.started_at) as f64))))
            ],
            completed_at,
        );
    }

    pub fn on_stage_change(&self, stage: &str, detail: Option<&Value>) {
        let stage = match clean(Some(stage)) {
            "" => "unknown",
            stage => stage,
        };
        let mut fields = vec![("stage", json!(stage))];
        if let Some(detail) = detail.filter(|detail| !detail.is_null()) {
            fields.push(("detail", detail.clone()));
        }
        self.turn_event("turn.status", fields, (self.now)());
    }

    /// A runtime notification (`onNotification`).
    pub fn on_notification(&self, content: &str, meta: &Value) {
        let meta = if meta.is_null() { json!({}) } else { meta.clone() };
        self.turn_event("notification", vec![("content", json!(content)), ("meta", meta)], (self.now)());
    }

    /// Flushes and closes every open item, then settles the turn's totals.
    fn settle_turn(&mut self, stats: &SessionStats, status: &str, close_output: Value, completed_at: i64) -> (f64, Value) {
        self.flush_reasoning(completed_at);
        self.complete_request(status, None, completed_at);
        let close_status = if status == "completed" { "incomplete" } else { "failed" };
        for entry in std::mem::take(&mut self.pending_tools) {
            self.completed_tools.insert(entry.id.clone());
            let item = Self::tool_item(
                &entry,
                vec![
                    ("output", close_output.clone()),
                    ("status", json!(close_status)),
                    ("started_at", json!(iso(entry.started_at))),
                    ("completed_at", json!(iso(completed_at))),
                    ("duration_ms", js_number((completed_at - entry.started_at).max(0) as f64)),
                ],
            );
            self.item_completed(item, completed_at);
        }
        ((completed_at - self.turn_started_at).max(0) as f64, usage_summary(stats, self.tool_call_count))
    }

    fn result_event(&self, subtype: &str, is_error: bool, duration_ms: f64, usage: Value, fields: Vec<(&str, Value)>, at: i64) {
        let mut event = vec![
            ("type", json!("result")),
            ("subtype", json!(subtype)),
            ("thread_id", json!(self.thread_id)),
            ("turn_id", json!(self.turn_id)),
            ("session_id", json!(self.thread_id)),
            ("model", json!(self.model)),
            ("is_error", json!(is_error)),
            ("duration_ms", js_number(duration_ms)),
            ("duration_api_ms", js_number(self.provider_duration_ms)),
            ("num_turns", json!(1)),
            ("provider_requests", count(self.provider_request_count)),
            ("tool_calls", count(self.tool_call_count)),
        ];
        event.extend(fields);
        event.push(("usage", usage));
        self.emit(event, at);
    }

    pub fn succeed(&mut self, stats: &SessionStats, text: &str, result: &ResultInfo) {
        self.ensure_started();
        let completed_at = (self.now)();
        let (duration_ms, usage) = self.settle_turn(stats, "completed", Value::Null, completed_at);
        if !js_trim(text).is_empty() && text != self.last_assistant_text {
            self.emit_assistant(text, completed_at);
        }
        let termination = Some(clean(result.termination_reason.as_deref())).filter(|reason| !reason.is_empty());
        self.turn_event(
            "turn.completed",
            vec![
                ("duration_ms", js_number(duration_ms)),
                ("duration_api_ms", js_number(self.provider_duration_ms)),
                ("provider_requests", count(self.provider_request_count)),
                ("tool_calls", count(self.tool_call_count)),
                ("usage", usage.clone()),
            ],
            completed_at,
        );
        self.result_event(
            "success",
            termination == Some("refusal"),
            duration_ms,
            usage,
            vec![
                ("result", json!(text)),
                ("stop_reason", json!(result.stop_reason)),
                ("termination_reason", json!(termination)),
            ],
            completed_at,
        );
    }

    pub fn fail(&mut self, stats: &SessionStats, message: &str) {
        self.ensure_started();
        let completed_at = (self.now)();
        let (duration_ms, usage) = self.settle_turn(stats, "failed", json!(message), completed_at);
        self.turn_event(
            "turn.failed",
            vec![
                ("duration_ms", js_number(duration_ms)),
                ("duration_api_ms", js_number(self.provider_duration_ms)),
                ("error", json!({ "message": message })),
                ("usage", usage.clone()),
            ],
            completed_at,
        );
        self.result_event(
            "error_during_execution",
            true,
            duration_ms,
            usage,
            vec![("stop_reason", Value::Null), ("errors", json!([message]))],
            completed_at,
        );
    }
}

/// Phase durations from the engine's marks, each phase falling back to the previous mark so a
/// partial report still yields monotonic spans.
fn tool_timing(entry: &ToolEntry, marks: Option<&ToolTiming>, at: i64) -> Value {
    let raw = marks.cloned().unwrap_or_default();
    let started = entry.started_at as f64;
    let at = at as f64;
    let dispatch_started = mark(raw.dispatch_started_at, started);
    let execution_started = mark(raw.execution_started_at, dispatch_started);
    let execution_completed = mark(raw.execution_completed_at, at);
    let postprocess_started = mark(raw.postprocess_started_at, execution_completed);
    let result_completed = mark(raw.result_completed_at, at);
    json!({
        "queue_ms": js_number((dispatch_started - started).max(0.0)),
        "dispatch_ms": js_number((execution_started - dispatch_started).max(0.0)),
        "execution_ms": js_number((execution_completed - execution_started).max(0.0)),
        "batch_wait_ms": js_number((postprocess_started - execution_completed).max(0.0)),
        "postprocess_ms": js_number((result_completed - postprocess_started).max(0.0)),
        "total_ms": js_number((result_completed - started).max(0.0)),
    })
}
