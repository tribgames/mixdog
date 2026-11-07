//! Responses stream decoder shared by the HTTP/SSE and WebSocket transports:
//! SSE framing (or one JSON message per WebSocket unit) and the event state
//! machine that turns Responses events into the provider-neutral stream
//! vocabulary. Deltas are hints; the terminal bundle is reconciled so a call
//! or text that only the bundle carries still reaches the consumer once.

// `ProviderError` is the frozen `WireDecoder` error type; the helpers below
// return it unboxed so it reaches the trait methods without conversion.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::Phase;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::config::WireContext;
use super::continuation::ContinuationSpec;
use super::continuation::TurnResult;
use super::continuation::next_slot;
use super::continuation::with_slot;
use super::error::Failure;
use super::error::classify;
use super::tool_flight::Collector;
use super::tool_flight::ToolFlight;

/// How transport units become events.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Framing {
    /// HTTP body chunks of a `text/event-stream`.
    Sse,
    /// One JSON message per WebSocket unit.
    WebSocket,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolFlavor {
    Function,
    Custom,
    Search,
}

struct ToolItem {
    flavor: ToolFlavor,
    call_id: String,
    name: String,
    /// `function_call_arguments.done` arrived before the ids were known.
    deferred_args: Option<Value>,
    done: bool,
}

#[derive(Default)]
struct Refusals {
    parts: Vec<(String, String)>,
}

impl Refusals {
    fn key(item_id: &str, index: u64) -> String {
        format!("{item_id}:{index}")
    }

    fn set(&mut self, key: String, text: String, append: bool) {
        match self.parts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, existing)) if append => existing.push_str(&text),
            Some((_, existing)) => *existing = text,
            None => self.parts.push((key, text)),
        }
    }

    fn seen(&self) -> bool {
        !self.parts.is_empty()
    }

    fn text(&self) -> String {
        self.parts
            .iter()
            .map(|(_, t)| t.as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The accumulated outcome of one response, read by the WebSocket send path
/// to anchor the next request on it.
#[derive(Default, Clone, Debug)]
pub struct ResponseOutcome {
    pub response_id: Option<String>,
    /// Every completed output item, in arrival order.
    pub output_items: Vec<Value>,
}

/// What a stateless-continuation route needs to report its updated slot:
/// the request's own provider state, model and transcript length. The decoder
/// then ends the turn with `StreamEvent::ProviderState`, which the session
/// persists like any provider's state.
#[derive(Clone, Debug)]
pub struct StateReport {
    pub spec: ContinuationSpec,
    pub prior: Option<ProviderState>,
    /// The requested model id, not an alias the server answered with.
    pub model: String,
    pub message_count: usize,
    /// The `previous_response_id` the request resumed from. A socket turn
    /// whose response carries no id keeps this one as the slot's `responseId`.
    pub resumed_response_id: Option<String>,
}

pub struct ResponsesDecoder {
    state: Option<StateReport>,
    framing: Framing,
    context: Arc<dyn WireContext>,
    replay_owner: ProviderId,
    line_buf: Vec<u8>,
    data: Vec<String>,
    terminal: bool,
    exposure: Exposure,
    tools: HashMap<String, ToolItem>,
    texts: HashMap<String, String>,
    done_items: HashSet<String>,
    calls_emitted: HashSet<String>,
    refusals: Refusals,
    outcome: ResponseOutcome,
    /// Some semantic event arrived (`watchdogs.semanticSeen()`): from then on an item boundary is progress.
    semantic_seen: bool,
    /// `toolInFlight` and what it is made of.
    flight: ToolFlight,
    /// The ids of the reasoning items collected with encrypted content (`replayItems.hasReasoning`).
    reasoning_ids: HashSet<String>,
    /// The stream is a compatible route's, folded by Node's compatible events collector.
    compat: bool,
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn phase_of(item: &Value) -> Option<Phase> {
    match str_of(item, "phase") {
        "commentary" => Some(Phase::Commentary),
        "final_answer" => Some(Phase::FinalAnswer),
        _ => None,
    }
}

fn u64_at(value: &Value, path: &[&str]) -> u64 {
    let mut cur = value;
    for key in path {
        match cur.get(*key) {
            Some(next) => cur = next,
            None => return 0,
        }
    }
    cur.as_u64().unwrap_or(0)
}

fn first_nonzero(value: &Value, paths: &[&[&str]]) -> u64 {
    paths
        .iter()
        .map(|p| u64_at(value, p))
        .find(|n| *n > 0)
        .unwrap_or(0)
}

fn usage_from(usage: &Value, service_tier: Option<&str>) -> Usage {
    let mut raw = usage.clone();
    if let (Some(tier), Some(map)) = (service_tier, raw.as_object_mut()) {
        map.insert("service_tier".into(), json!(tier));
    }
    Usage {
        input_tokens: u64_at(usage, &["input_tokens"]),
        output_tokens: u64_at(usage, &["output_tokens"]),
        cache_read_tokens: first_nonzero(
            usage,
            &[
                &["input_tokens_details", "cached_tokens"],
                &["prompt_tokens_details", "cached_tokens"],
                &["cached_tokens"],
            ],
        ),
        cache_write_tokens: first_nonzero(
            usage,
            &[
                &["input_tokens_details", "cache_write_tokens"],
                &["prompt_tokens_details", "cache_write_tokens"],
                &["cache_write_tokens"],
            ],
        ),
        cache_write_1h_tokens: 0,
        reasoning_tokens: usage
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
        reasoning_incomplete: false,
        cost: billed_cost(usage),
        raw: Some(raw),
    }
}

/// The cost the provider reports (xAI ticks, or a USD amount); never priced
/// locally.
fn billed_cost(usage: &Value) -> Option<UsdTicks> {
    if let Some(ticks) = usage.get("cost_in_usd_ticks").and_then(Value::as_u64) {
        return Some(UsdTicks(ticks));
    }
    usage
        .get("cost")
        .and_then(Value::as_f64)
        .and_then(UsdTicks::from_usd)
}

/// Completed-but-malformed arguments ride as data so the model can re-issue
/// the call in the same turn; they never fail the stream.
fn parse_call_arguments(text: &str) -> Value {
    if text.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(text).unwrap_or_else(|err| {
        json!({
            "__invalidToolArgs": true,
            "__rawArguments": text,
            "__parseError": err.to_string(),
        })
    })
}

fn parse_search_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => Value::Object(map),
                Ok(_) => json!({}),
                Err(err) => json!({
                    "__invalidToolArgs": true,
                    "__rawArguments": text,
                    "__parseError": err.to_string(),
                }),
            }
        }
        _ => json!({}),
    }
}

fn is_max_output_reason(reason: &str) -> bool {
    ["max_output_tokens", "max_tokens", "length", "output_token_limit"]
        .iter()
        .any(|r| reason.trim().eq_ignore_ascii_case(r))
}

fn incomplete_reason(event: &Value) -> String {
    let response = event.get("response");
    let details = response
        .and_then(|r| r.get("incomplete_details"))
        .or_else(|| event.get("incomplete_details"))
        .or_else(|| response.and_then(|r| r.get("status_details")));
    details
        .map(|d| str_of(d, "reason"))
        .filter(|r| !r.is_empty())
        .or_else(|| response.map(|r| str_of(r, "status")).filter(|s| !s.is_empty()))
        .unwrap_or("incomplete")
        .to_owned()
}

fn is_incomplete_tool_item(item: &Value) -> bool {
    str_of(item, "status") == "incomplete"
        && matches!(
            str_of(item, "type"),
            "function_call" | "custom_tool_call" | "tool_search_call"
        )
}

impl ResponsesDecoder {
    pub fn new(framing: Framing, context: Arc<dyn WireContext>, replay_owner: ProviderId) -> Self {
        Self {
            state: None,
            framing,
            context,
            replay_owner,
            line_buf: Vec::new(),
            data: Vec::new(),
            terminal: false,
            exposure: Exposure::default(),
            tools: HashMap::new(),
            texts: HashMap::new(),
            done_items: HashSet::new(),
            calls_emitted: HashSet::new(),
            refusals: Refusals::default(),
            outcome: ResponseOutcome::default(),
            semantic_seen: false,
            flight: ToolFlight::default(),
            reasoning_ids: HashSet::new(),
            compat: false,
        }
    }

    /// Report the route's continuation slot when the turn ends.
    pub fn with_state(mut self, report: StateReport) -> Self {
        self.state = Some(report);
        self
    }

    /// The response id and output items accumulated so far.
    pub fn outcome(&self) -> &ResponseOutcome {
        &self.outcome
    }

    fn fail(&self, mut err: ProviderError) -> ProviderError {
        err.exposure = self.exposure();
        err
    }

    fn wire_error(&self, status_event: &Value, error: Option<&Value>, fallback: &str) -> ProviderError {
        self.fail(classify(&Failure {
            status: None,
            headers: &[],
            error,
            envelope: Some(status_event),
            wire_event: true,
            message_fallback: fallback,
            delivery: DeliveryState::Accepted,
            now_ms: self.context.now_unix_ms(),
        }))
    }

    fn in_flight(&self) -> bool {
        self.tools.values().any(|t| !t.done)
    }

    // -- framing ------------------------------------------------------------

    fn feed_sse(&mut self, unit: &[u8], out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        self.line_buf.extend_from_slice(unit);
        while !self.terminal
            && let Some(pos) = self.line_buf.iter().position(|b| *b == b'\n')
        {
            let mut line: Vec<u8> = self.line_buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.sse_line(&line, out)?;
        }
        if self.terminal {
            // The turn is over: frames buffered behind the terminal one are
            // ignored, as Node's loop does, so the turn finishes exactly once.
            self.line_buf.clear();
            self.data.clear();
        }
        Ok(())
    }

    fn sse_line(&mut self, line: &[u8], out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        if line.is_empty() {
            return self.sse_dispatch(out);
        }
        if line[0] == b':' {
            out.push(StreamEvent::ProviderKeepalive);
            return Ok(());
        }
        let text = String::from_utf8_lossy(line);
        if let Some(rest) = text.strip_prefix("data:") {
            self.data.push(rest.trim_start().to_owned());
        }
        Ok(())
    }

    fn sse_dispatch(&mut self, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        if self.data.is_empty() {
            return Ok(());
        }
        let raw = std::mem::take(&mut self.data).join("\n");
        let raw = raw.trim();
        if raw.is_empty() || raw == "[DONE]" {
            return Ok(());
        }
        match serde_json::from_str::<Value>(raw) {
            Ok(event) => self.handle(&event, out),
            Err(err) => {
                let mut e = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
                e.code = Some("malformed_stream".into());
                e.message = format!("unparsable stream event: {err}");
                Err(self.fail(e))
            }
        }
    }

    // -- events -------------------------------------------------------------

    fn handle(&mut self, event: &Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        match str_of(event, "type") {
            "response.created" => {
                if let Some(id) = event.get("response").map(|r| str_of(r, "id")).filter(|i| !i.is_empty()) {
                    self.outcome.response_id = Some(id.to_owned());
                }
                // The compatible collector reports the ack as a boundary once the stream has seen output.
                if self.collector() == Collector::Compat && self.semantic_seen {
                    out.push(StreamEvent::Progress(ProgressKind::Semantic));
                }
            }
            "codex.rate_limits" => out.push(StreamEvent::ProviderKeepalive),
            "response.output_item.added" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                self.item_added(item, out);
                self.flight.item_added(self.collector(), item);
                // `onItemAdded` (`openai-ws-stream/event-switch.mjs`, `onOutputItemAdded`): a call in flight, else a
                // boundary after earlier output; the first boundary of a response is transport only.
                let kind = if self.flight.in_flight() {
                    Some(ProgressKind::Tool)
                } else if self.semantic_seen {
                    Some(ProgressKind::Semantic)
                } else {
                    None
                };
                if let Some(kind) = kind {
                    self.semantic_seen = true;
                    out.push(StreamEvent::Progress(kind));
                }
            }
            "response.output_text.delta" => {
                let delta = str_of(event, "delta");
                if !delta.is_empty() {
                    self.semantic_seen = true;
                    self.texts
                        .entry(str_of(event, "item_id").to_owned())
                        .or_default()
                        .push_str(delta);
                    self.exposure.text_emitted = true;
                    out.push(StreamEvent::TextDelta(delta.to_owned()));
                }
            }
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                let delta = str_of(event, "delta");
                if !delta.is_empty() {
                    self.semantic_seen = true;
                    out.push(StreamEvent::ReasoningDelta(delta.to_owned()));
                }
            }
            "response.refusal.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    let key = Refusals::key(str_of(event, "item_id"), event.get("content_index").and_then(Value::as_u64).unwrap_or(0));
                    self.refusals.set(key, delta.to_owned(), true);
                }
                self.semantic_seen = true;
                out.push(StreamEvent::Progress(ProgressKind::Semantic));
            }
            "response.refusal.done" => {
                if let Some(text) = event.get("refusal").and_then(Value::as_str) {
                    let key = Refusals::key(str_of(event, "item_id"), event.get("content_index").and_then(Value::as_u64).unwrap_or(0));
                    self.refusals.set(key, text.to_owned(), false);
                }
                self.semantic_seen = true;
                out.push(StreamEvent::Progress(ProgressKind::Semantic));
            }
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
                let delta = str_of(event, "delta");
                let item_id = str_of(event, "item_id");
                // `onToolInputDelta` reports every delta, an empty one included.
                self.flight.input_delta(item_id);
                self.semantic_seen = true;
                out.push(StreamEvent::Progress(ProgressKind::Tool));
                if !delta.is_empty() {
                    let id = self
                        .tools
                        .get(item_id)
                        .map(|t| t.call_id.clone())
                        .filter(|c| !c.is_empty())
                        .unwrap_or_else(|| item_id.to_owned());
                    out.push(StreamEvent::ToolCallArgsDelta {
                        id,
                        delta: delta.to_owned(),
                    });
                }
            }
            "response.function_call_arguments.done" => {
                self.arguments_done(event, out);
                self.flight.arguments_done(self.collector(), str_of(event, "item_id"));
                self.semantic_seen = true;
                out.push(StreamEvent::Progress(ProgressKind::Tool));
            }
            "response.output_item.done" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                self.item_done(item, out);
                self.settle_flight(item);
                // Any finished item is model output.
                self.semantic_seen = true;
                out.push(StreamEvent::Progress(self.done_kind(item)));
            }
            "response.completed" => return self.completed(event, out, true),
            "response.done" => return self.response_done(event, out),
            "response.incomplete" => return self.incomplete(event, out),
            "response.failed" => {
                self.terminal = true;
                let error = event
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .or_else(|| event.get("error"));
                return Err(self.wire_error(event, error, "response.failed"));
            }
            "error" => {
                self.terminal = true;
                return Err(self.wire_error(event, event.get("error").filter(|e| e.is_object()), "error"));
            }
            _ => {
                if let Some(error) = event.get("error").filter(|e| e.is_object()) {
                    self.terminal = true;
                    return Err(self.wire_error(event, Some(error), "stream error"));
                }
            }
        }
        Ok(())
    }

    /// Which of Node's three Responses collectors this stream is.
    fn collector(&self) -> Collector {
        if self.framing == Framing::WebSocket {
            Collector::WebSocket
        } else if self.compat {
            Collector::Compat
        } else {
            Collector::HttpSse
        }
    }

    /// The stream of a compatible route over HTTP/SSE, which Node folds in `openai-compat-responses-events`.
    pub fn compat_events(mut self) -> Self {
        self.compat = true;
        self
    }

    /// What a finished item does to the tool-in-flight state and the collected reasoning ids.
    fn settle_flight(&mut self, item: &Value) {
        let collector = self.collector();
        // A server-truncated call stays in flight and is never collected; the compatible collector has no such case.
        if is_incomplete_tool_item(item) && collector != Collector::Compat {
            self.flight.started(item);
            return;
        }
        self.flight.item_done(collector, item);
        if str_of(item, "type") == "reasoning" && !str_of(item, "encrypted_content").is_empty() {
            self.reasoning_ids.insert(str_of(item, "id").to_owned());
        }
    }

    /// The kind a finished item reports: the WebSocket collector (`completeOutputItem`) also reads the in-flight
    /// flag, the HTTP/SSE one (`outputItemKind`) only the item type, the compatible one also counts a web search.
    fn done_kind(&self, item: &Value) -> ProgressKind {
        let collector = self.collector();
        let kind = str_of(item, "type");
        if is_incomplete_tool_item(item) && collector != Collector::Compat {
            ProgressKind::Tool
        } else if kind == "reasoning" {
            ProgressKind::Reasoning
        } else if (collector == Collector::WebSocket && self.flight.in_flight())
            || kind.contains("tool")
            || kind.contains("function_call")
            || (collector == Collector::Compat && kind.contains("web_search_call"))
        {
            ProgressKind::Tool
        } else {
            ProgressKind::Semantic
        }
    }

    /// The progress of the terminal output bundle (`noteCompleted`, `absorbCompletedOutput`, `onCompleted` of the
    /// compatible events): every item is collected as `output_item.done` does, and what it amounted to is reported once.
    fn salvage_bundle(&mut self, output: &[Value], out: &mut Vec<StreamEvent>) -> bool {
        if self.collector() != Collector::Compat {
            let mut reported = false;
            for item in output {
                reported |= self.salvage(item, out);
            }
            return reported;
        }
        // The compatible fold adopts the bundle's text first, then sweeps the other items; none is skipped as seen.
        let start = out.len();
        for item in output.iter().filter(|item| str_of(item, "type") == "message") {
            self.item_done(item, out);
        }
        let mut reported = out[start..].iter().any(|event| matches!(event, StreamEvent::TextDelta(_)));
        for item in output.iter().filter(|item| str_of(item, "type") != "message") {
            self.item_done(item, out);
            match str_of(item, "type") {
                "function_call" | "tool_search_call" | "custom_tool_call" | "web_search_call" => {
                    out.push(StreamEvent::Progress(ProgressKind::Tool));
                    reported = true;
                }
                "reasoning" => {
                    out.push(StreamEvent::Progress(ProgressKind::Reasoning));
                    reported = true;
                }
                _ => {}
            }
        }
        reported
    }

    /// One item of the terminal output bundle (`salvageCompletedItem`, `absorbCompletedOutput`) of the WebSocket and
    /// HTTP/SSE collectors. Returns whether it reported.
    fn salvage(&mut self, item: &Value, out: &mut Vec<StreamEvent>) -> bool {
        let kind = str_of(item, "type");
        // The WebSocket collector skips a reasoning item whose copy was already collected; HTTP/SSE reports every one.
        let collected = self.collector() == Collector::WebSocket && self.reasoning_ids.contains(str_of(item, "id"));
        let start = out.len();
        self.item_done(item, out);
        if is_incomplete_tool_item(item) {
            self.flight.started(item);
            out.push(StreamEvent::Progress(ProgressKind::Tool));
            return true;
        }
        if kind == "reasoning" && !str_of(item, "encrypted_content").is_empty() {
            self.reasoning_ids.insert(str_of(item, "id").to_owned());
        }
        match kind {
            "message" => {
                let mut reported = out[start..].iter().any(|event| matches!(event, StreamEvent::TextDelta(_)));
                let refusal = item.get("content").and_then(Value::as_array).is_some_and(|parts| {
                    parts.iter().any(|part| str_of(part, "type") == "refusal" && part.get("refusal").is_some_and(Value::is_string))
                });
                if refusal {
                    out.push(StreamEvent::Progress(ProgressKind::Semantic));
                    reported = true;
                }
                reported
            }
            "web_search_call" | "tool_search_call" | "custom_tool_call" | "function_call" => {
                out.push(StreamEvent::Progress(ProgressKind::Tool));
                true
            }
            "reasoning" if !collected => {
                out.push(StreamEvent::Progress(ProgressKind::Reasoning));
                true
            }
            _ => false,
        }
    }
    fn item_added(&mut self, item: &Value, out: &mut Vec<StreamEvent>) {
        let item_id = str_of(item, "id").to_owned();
        match str_of(item, "type") {
            "message" => {
                if let Some(phase) = phase_of(item) {
                    out.push(StreamEvent::ItemStart {
                        kind: ItemKind::Text,
                        phase: Some(phase),
                    });
                }
            }
            kind @ ("function_call" | "custom_tool_call" | "tool_search_call") => {
                let flavor = match kind {
                    "function_call" => ToolFlavor::Function,
                    "custom_tool_call" => ToolFlavor::Custom,
                    _ => ToolFlavor::Search,
                };
                let call_id = Self::call_id_of(item);
                let name = Self::tool_name_of(flavor, item);
                out.push(StreamEvent::ItemStart {
                    kind: ItemKind::Tool,
                    phase: None,
                });
                if !call_id.is_empty() && !name.is_empty() {
                    out.push(StreamEvent::ToolCallStart {
                        id: call_id.clone(),
                        name: name.clone(),
                    });
                }
                self.tools.insert(
                    item_id,
                    ToolItem {
                        flavor,
                        call_id,
                        name,
                        deferred_args: None,
                        done: false,
                    },
                );
            }
            _ => {}
        }
    }

    fn call_id_of(item: &Value) -> String {
        let call_id = str_of(item, "call_id");
        if call_id.is_empty() {
            str_of(item, "id").to_owned()
        } else {
            call_id.to_owned()
        }
    }

    fn tool_name_of(flavor: ToolFlavor, item: &Value) -> String {
        match flavor {
            ToolFlavor::Search => "load_tool".to_owned(),
            _ => str_of(item, "name").to_owned(),
        }
    }

    fn emit_call(&mut self, id: &str, name: &str, arguments: Value, out: &mut Vec<StreamEvent>) {
        if id.is_empty() || name.is_empty() || !self.calls_emitted.insert(id.to_owned()) {
            return;
        }
        self.exposure.tool_dispatched = true;
        out.push(StreamEvent::ToolCallDone(ToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
            native_type: None,
        }));
    }

    fn arguments_done(&mut self, event: &Value, out: &mut Vec<StreamEvent>) {
        let item_id = str_of(event, "item_id").to_owned();
        let arguments = parse_call_arguments(str_of(event, "arguments"));
        let (call_id, name) = match self.tools.get_mut(&item_id) {
            Some(tool) if tool.flavor == ToolFlavor::Search => return,
            Some(tool) => {
                if tool.call_id.is_empty() {
                    tool.call_id = str_of(event, "call_id").to_owned();
                }
                if tool.name.is_empty() {
                    tool.name = str_of(event, "name").to_owned();
                }
                tool.deferred_args = Some(arguments.clone());
                (tool.call_id.clone(), tool.name.clone())
            }
            None => (str_of(event, "call_id").to_owned(), str_of(event, "name").to_owned()),
        };
        self.emit_call(&call_id, &name, arguments, out);
    }

    /// The text of a finished message that the deltas did not already carry.
    fn relay_final_text(&mut self, item: &Value, key: &str, out: &mut Vec<StreamEvent>) {
        let Some(parts) = item.get("content").and_then(Value::as_array) else {
            return;
        };
        for (index, part) in parts.iter().enumerate() {
            if str_of(part, "type") == "refusal"
                && let Some(text) = part.get("refusal").and_then(Value::as_str)
            {
                // An id-less item cannot be matched to its streamed copy.
                if !(key.is_empty() && self.refusals.seen()) {
                    self.refusals.set(Refusals::key(key, index as u64), text.to_owned(), false);
                }
            }
        }
        let full: String = parts
            .iter()
            .filter(|p| str_of(p, "type") == "output_text")
            .map(|p| str_of(p, "text"))
            .collect();
        let streamed = self.texts.entry(key.to_owned()).or_default();
        let remaining = if streamed.is_empty() {
            full.clone()
        } else if full.len() > streamed.len() && full.starts_with(streamed.as_str()) {
            full[streamed.len()..].to_owned()
        } else {
            String::new()
        };
        if !remaining.is_empty() {
            streamed.push_str(&remaining);
            self.exposure.text_emitted = true;
            out.push(StreamEvent::TextDelta(remaining));
        }
    }

    fn item_done(&mut self, item: &Value, out: &mut Vec<StreamEvent>) {
        let item_id = str_of(item, "id").to_owned();
        if is_incomplete_tool_item(item) {
            return;
        }
        let mut dedupe_key = if item_id.is_empty() {
            Self::call_id_of(item)
        } else {
            item_id.clone()
        };
        if dedupe_key.is_empty() {
            dedupe_key = item.to_string();
        }
        if !self.done_items.insert(dedupe_key) {
            return;
        }
        self.outcome.output_items.push(item.clone());
        match str_of(item, "type") {
            "message" => self.relay_final_text(item, &item_id, out),
            kind @ ("function_call" | "custom_tool_call" | "tool_search_call") => {
                let flavor = match kind {
                    "function_call" => ToolFlavor::Function,
                    "custom_tool_call" => ToolFlavor::Custom,
                    _ => ToolFlavor::Search,
                };
                self.tool_done(flavor, item, &item_id, out);
            }
            _ => {}
        }
    }

    fn tool_done(&mut self, flavor: ToolFlavor, item: &Value, item_id: &str, out: &mut Vec<StreamEvent>) {
        if flavor == ToolFlavor::Search && str_of(item, "execution") == "server" {
            if let Some(tool) = self.tools.get_mut(item_id) {
                tool.done = true;
            }
            return;
        }
        let call_id = Self::call_id_of(item);
        let name = Self::tool_name_of(flavor, item);
        let deferred = self.tools.get(item_id).and_then(|t| t.deferred_args.clone());
        let arguments = match flavor {
            ToolFlavor::Function => {
                let text = str_of(item, "arguments");
                match deferred {
                    Some(args) if args.as_object().is_some_and(|m| !m.is_empty()) => args,
                    _ => parse_call_arguments(text),
                }
            }
            ToolFlavor::Custom => {
                let input = str_of(item, "input");
                if name == "apply_patch" {
                    json!({"patch": input})
                } else {
                    json!({"input": input})
                }
            }
            ToolFlavor::Search => parse_search_arguments(item.get("arguments")),
        };
        self.emit_call(&call_id, &name, arguments, out);
        if let Some(tool) = self.tools.get_mut(item_id) {
            tool.done = true;
        }
    }

    // -- terminal frames ----------------------------------------------------

    fn unresolved_call(&self) -> bool {
        self.tools
            .values()
            .any(|t| t.deferred_args.is_some() && (t.call_id.is_empty() || t.name.is_empty()) && !t.done)
    }

    fn completed(&mut self, event: &Value, out: &mut Vec<StreamEvent>, report: bool) -> Result<(), ProviderError> {
        let response = event.get("response").unwrap_or(&Value::Null);
        // The bundle's progress is reported once; a bundle that reported nothing is a `semantic` boundary.
        let mut reported = false;
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            if report {
                reported = self.salvage_bundle(output, out);
            } else {
                for item in output {
                    self.item_done(item, out);
                }
            }
        }
        if report {
            if !reported {
                out.push(StreamEvent::Progress(ProgressKind::Semantic));
            }
            self.semantic_seen = true;
        }
        if self.unresolved_call() {
            self.terminal = true;
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = "function_call salvage failed: missing call_id or name".into();
            return Err(self.fail(err));
        }
        self.finish_turn(response, None, out);
        Ok(())
    }

    /// `stop` is what the terminal frame named: `None` for a plain completion
    /// (Node `stopReason: null`), `MaxTokens` for `incomplete`; a refusal
    /// overrides either.
    fn finish_turn(&mut self, response: &Value, stop: Option<StopReason>, out: &mut Vec<StreamEvent>) {
        let service_tier = response.get("service_tier").and_then(Value::as_str);
        // The response's own items in arrival order, reasoning included
        // verbatim (ids, summaries, encrypted content): the one envelope the
        // next request replays (Node `createProviderReplay(owner, responseItems)`).
        if !self.outcome.output_items.is_empty() {
            out.push(StreamEvent::ReasoningReplay(ProviderReplay {
                owner: self.replay_owner.clone(),
                items: Value::Array(self.outcome.output_items.clone()),
            }));
        }
        if let Some(usage) = response.get("usage").filter(|u| u.is_object()) {
            out.push(StreamEvent::Usage(usage_from(usage, service_tier)));
        }
        if let Some(report) = &self.state {
            let response_id = response
                .get("id")
                .and_then(Value::as_str)
                .or(self.outcome.response_id.as_deref())
                .or(report.resumed_response_id.as_deref().filter(|_| self.framing == Framing::WebSocket));
            let slot = next_slot(
                &report.spec,
                self.replay_owner.as_str(),
                report.prior.as_ref(),
                &TurnResult {
                    response_id,
                    output: &self.outcome.output_items,
                    model: &report.model,
                    message_count: report.message_count,
                    updated_at_ms: self.context.now_unix_ms(),
                },
            );
            out.push(StreamEvent::ProviderState(with_slot(report.prior.as_ref(), &report.spec, slot)));
        }
        let stop = if self.refusals.seen() {
            out.push(StreamEvent::Refusal(self.refusals.text()));
            Some(StopReason::Refusal)
        } else {
            stop
        };
        self.terminal = true;
        out.push(StreamEvent::Completed { stop, pricing_model: None, request_ms: None });
    }

    fn response_done(&mut self, event: &Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let status = event
            .get("response")
            .map(|r| str_of(r, "status"))
            .unwrap_or("");
        match status {
            "failed" => {
                self.terminal = true;
                let error = event
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .or_else(|| event.get("error"));
                Err(self.wire_error(event, error, "response.done failed"))
            }
            "incomplete" => self.incomplete(event, out),
            // The compatible collector settles a success-shaped `response.done` without folding its bundle's progress.
            "" | "completed" => self.completed(event, out, self.collector() != Collector::Compat),
            other => {
                self.terminal = true;
                let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                err.code = Some(other.to_owned());
                err.message = format!("response.done unexpected status: {other}");
                Err(self.fail(err))
            }
        }
    }

    fn incomplete(&mut self, event: &Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let reason = incomplete_reason(event);
        let response = event.get("response").unwrap_or(&Value::Null);
        if is_max_output_reason(&reason) {
            if let Some(output) = response.get("output").and_then(Value::as_array) {
                for item in output {
                    self.item_done(item, out);
                }
            }
            if self.in_flight() || response_has_incomplete_tool(response) {
                // The cutoff hit a tool call's input: its arguments are
                // truncated, so this is a cut stream, never a clean length stop.
                self.terminal = true;
                let mut err = ProviderError::transport(
                    TransportFault::TruncatedStream,
                    DeliveryState::Accepted,
                );
                err.code = Some(reason);
                err.message = "response incomplete (max_output_tokens) with a tool call in flight".into();
                let mut err = self.fail(err);
                err.exposure.tool_input_cut = true;
                return Err(err);
            }
            self.finish_turn(response, Some(StopReason::MaxTokens), out);
            return Ok(());
        }
        self.terminal = true;
        let kind = if reason.eq_ignore_ascii_case("content_filter") {
            ErrorKind::Policy
        } else {
            ErrorKind::Unknown
        };
        let mut err = ProviderError::new(kind, DeliveryState::Accepted);
        err.message = format!("response incomplete: {reason}");
        err.code = Some(reason.to_ascii_lowercase());
        Err(self.fail(err))
    }
}

fn response_has_incomplete_tool(response: &Value) -> bool {
    response
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(is_incomplete_tool_item))
}

impl WireDecoder for ResponsesDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut out = Vec::new();
        if self.terminal {
            return Ok(out);
        }
        match self.framing {
            Framing::Sse => self.feed_sse(unit, &mut out)?,
            Framing::WebSocket => {
                if let Ok(event) = serde_json::from_slice::<Value>(unit) {
                    self.handle(&event, &mut out)?;
                }
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut out = Vec::new();
        if !self.terminal && self.framing == Framing::Sse {
            if !self.line_buf.is_empty() {
                let line = std::mem::take(&mut self.line_buf);
                let line = line.strip_suffix(b"\r").unwrap_or(&line);
                self.sse_line(line, &mut out)?;
            }
            if !self.terminal {
                self.sse_dispatch(&mut out)?;
            }
        }
        if self.terminal {
            return Ok(out);
        }
        let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        err.message = "stream ended before the response completed".into();
        Err(self.fail(err))
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    fn exposure(&self) -> Exposure {
        Exposure {
            tool_input_cut: self.in_flight(),
            ..self.exposure
        }
    }
}

#[cfg(test)]
mod reasoning_tests {
    use super::*;

    #[test]
    fn a_reported_zero_stays_zero_and_a_missing_figure_stays_missing() {
        let zero = usage_from(&json!({ "input_tokens": 5, "output_tokens": 2, "output_tokens_details": { "reasoning_tokens": 0 } }), None);
        assert_eq!(zero.reasoning_tokens, Some(0));
        let missing = usage_from(&json!({ "input_tokens": 5, "output_tokens": 2 }), None);
        assert_eq!(missing.reasoning_tokens, None);
        let counted = usage_from(&json!({ "output_tokens_details": { "reasoning_tokens": 7 } }), None);
        assert_eq!(counted.reasoning_tokens, Some(7));
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use crate::providers::progress_golden::{golden, node_names, rust_names};

    struct Ctx;

    impl WireContext for Ctx {
        fn request_id(&self) -> String {
            "0".repeat(32)
        }
        fn now_unix_ms(&self) -> u64 {
            0
        }
        fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
            None
        }
    }

    /// Node's three Responses collectors reported these kinds for each event of each scenario
    /// (`golden/stream_progress.json`): item boundaries after earlier output are `semantic`, a call's item, arguments and
    /// end are `tool`, the tool-in-flight flag is latched, and the terminal bundle reports what it salvaged.
    #[test]
    fn the_decoder_reports_the_progress_kinds_node_s_collectors_do() {
        for scenario in golden()["decoders"]["responses"].as_array().expect("responses") {
            let framing = match scenario["framing"].as_str().expect("framing") {
                "ws" => Framing::WebSocket,
                _ => Framing::Sse,
            };
            let mut decoder = ResponsesDecoder::new(framing, Arc::new(Ctx), ProviderId::from("openai"));
            if scenario["framing"] == "compat" {
                decoder = decoder.compat_events();
            }
            for step in scenario["steps"].as_array().expect("steps") {
                let unit = match framing {
                    Framing::WebSocket => step["wire"].to_string(),
                    Framing::Sse => format!("data: {}\n\n", step["wire"]),
                };
                let events = decoder.feed(unit.as_bytes()).expect("feed");
                assert_eq!(rust_names(&events), node_names(&step["kinds"]), "{} / {}: {}", scenario["framing"], scenario["name"], step["wire"]);
            }
        }
    }
}
