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
use crate::providers::leak;
use crate::providers::leak::Dedupe;
use crate::providers::leak::LeakGuard;
use crate::providers::leak::Recovered;
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

/// A call in the turn's returned list.
struct Listed {
    call: ToolCall,
    /// Recovered from text rather than streamed by the provider.
    leaked: bool,
}

struct ToolItem {
    flavor: ToolFlavor,
    call_id: String,
    name: String,
    /// The `namespace` of a tool loaded from a declared namespace (`toolCallNamespace`); empty: top level.
    namespace: String,
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
    /// A failure that followed events decoded from the same unit: those are delivered first, and the next `feed` (an
    /// empty one suffices) returns it, so the outcome does not depend on how the network cut the stream.
    pending_error: Option<ProviderError>,
    failure_param: Option<String>,
    /// A whole protocol record was handled ([`WireDecoder::payload_seen`]).
    payload: bool,
    exposure: Exposure,
    tools: HashMap<String, ToolItem>,
    texts: HashMap<String, String>,
    done_items: HashSet<String>,
    calls_emitted: HashSet<String>,
    refusals: Refusals,
    outcome: ResponseOutcome,
    /// Some semantic event arrived (`watchdogs.semanticSeen()`): from then on an item boundary is progress.
    semantic_seen: bool,
    /// The first output item was added (`state.firstOutputAt`).
    output_started: bool,
    /// `toolInFlight` and what it is made of.
    flight: ToolFlight,
    /// The ids of the reasoning items collected with encrypted content (`replayItems.hasReasoning`).
    reasoning_ids: HashSet<String>,
    /// The stream is a compatible route's, folded by Node's compatible events collector.
    compat: bool,
    /// `state.model`: the model the response named (`response.created`, a terminal frame).
    model: Option<String>,
    /// The runtime label Node prefixes to a stream error (`errLabel`, `httpLabel`, the compatible route's
    /// `<provider>:responses`); empty: no prefix.
    label: String,
    /// The visible text so far (`state.content`): the live deltas, and the terminal bundle's text that the HTTP/SSE and
    /// WebSocket collectors add without relaying.
    content: String,
    /// The calls the turn collected, in occurrence order (`toolCalls`), dispatched or not.
    listed: Vec<Listed>,
    /// The leaked tool-call guard over the output text (`createLeakGuard`, harmony syntax on).
    leak: LeakGuard,
    /// One dispatch per call across the leaked and the native path.
    dedupe: Dedupe,
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
        .map(|p| first_finite(value, &[*p]))
        .find(|n| *n > 0)
        .unwrap_or(0)
}

/// `firstFiniteNumberOrZero`: the first path holding a value `Number()` makes finite (`null` is 0, an absent one is
/// skipped), as a token count.
fn first_finite(value: &Value, paths: &[&[&str]]) -> u64 {
    for path in paths {
        let found = path.iter().try_fold(value, |at, key| at.get(*key));
        let number = match found {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(text)) => Some(mixdog_js::string_to_number(text)),
            Some(Value::Null) => Some(0.0),
            Some(Value::Bool(flag)) => Some(f64::from(u8::from(*flag))),
            _ => None,
        };
        if let Some(n) = number.filter(|n| n.is_finite()) {
            return n.max(0.0) as u64;
        }
    }
    0
}

fn usage_from(usage: &Value, service_tier: Option<&str>, compat: bool) -> Usage {
    let mut raw = usage.clone();
    if let (Some(tier), Some(map)) = (service_tier, raw.as_object_mut()) {
        map.insert("service_tier".into(), json!(tier));
    }
    let total = |canonical: &str, alias: &str| {
        let key = if compat && usage.get(canonical).is_none_or(Value::is_null) { alias } else { canonical };
        if compat { first_finite(usage, &[&[key]]) } else { u64_at(usage, &[key]) }
    };
    Usage {
        input_tokens: total("input_tokens", "prompt_tokens"),
        output_tokens: total("output_tokens", "completion_tokens"),
        // The Responses collectors read the first finite figure (`extractCachedTokens`, a reported 0 ends the search); the
        // compatible collector the first positive one (`extractCompatCachedTokens`), with a top-level `cached_tokens` too.
        cache_read_tokens: if compat {
            first_nonzero(
                usage,
                &[
                    &["prompt_tokens_details", "cached_tokens"],
                    &["input_tokens_details", "cached_tokens"],
                    &["prompt_cache_hit_tokens"],
                    &["cached_prompt_text_tokens"],
                    &["cached_tokens"],
                ],
            )
        } else {
            first_finite(
                usage,
                &[
                    &["input_tokens_details", "cached_tokens"],
                    &["prompt_tokens_details", "cached_tokens"],
                    &["inputTokensDetails", "cachedTokens"],
                    &["promptTokensDetails", "cachedTokens"],
                ],
            )
        },
        cache_write_tokens: first_finite(
                usage,
                &[
                    &["input_tokens_details", "cache_write_tokens"],
                    &["prompt_tokens_details", "cache_write_tokens"],
                    &["inputTokensDetails", "cacheWriteTokens"],
                    &["promptTokensDetails", "cacheWriteTokens"],
                    &["cache_write_tokens"],
                    &["cacheWriteTokens"],
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
    mixdog_js::json_parse(text).unwrap_or_else(|err| {
        json!({
            "__invalidToolArgs": true,
            "__rawArguments": text,
            "__parseError": mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| err.to_string()),
        })
    })
}

fn parse_search_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            match mixdog_js::json_parse(text) {
                Ok(Value::Object(map)) => Value::Object(map),
                Ok(_) => json!({}),
                Err(err) => json!({
                    "__invalidToolArgs": true,
                    "__rawArguments": text,
                    "__parseError": mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| err.to_string()),
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

/// `responseOutputText`: `output_text` when the response has it, else the message items' output text parts joined.
fn response_output_text(response: &Value) -> String {
    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        return text.to_owned();
    }
    response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| str_of(item, "type") == "message")
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| str_of(part, "type") == "output_text")
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

/// The first of `keys` (a path each, dot-separated) that holds a non-empty string, as JavaScript's `a || b || ''` reads
/// them.
fn js_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| key.split('.').try_fold(value, |at, part| at.get(part)))
        .find_map(|found| match found {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) if number.as_f64() != Some(0.0) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// The sources a turn cites, de-duplicated by URL in the order they are found.
#[derive(Default)]
struct Citations {
    seen: HashSet<String>,
    list: Vec<Value>,
}

impl Citations {
    /// `pushOutputTextAnnotations` (text-relay.mjs:19-31): an output text annotation of the HTTP/SSE collector.
    fn annotation(&mut self, raw: &Value) {
        let url = js_text(raw, &["url", "uri", "href"]);
        if url.is_empty() || !self.seen.insert(url.clone()) {
            return;
        }
        self.list.push(json!({
            "title": js_text(raw, &["title"]),
            "url": url,
            "snippet": js_text(raw, &["snippet", "text", "description"]),
            "source": "openai-oauth",
        }));
    }

    /// `addCitation` of `collectCompatResponseSearchSources` (openai-compat-wire.mjs:337-361): a URL string or a source
    /// object, with the search's query as the fallback title and the place it was found as the fallback source.
    fn compat(&mut self, source: &Value, fallback_title: &str, fallback_source: &str) {
        let fallback_source = if fallback_source.is_empty() { "citation" } else { fallback_source };
        if let Some(text) = source.as_str() {
            let url = mixdog_js::js_trim(text).to_owned();
            if url.is_empty() || !self.seen.insert(url.clone()) {
                return;
            }
            self.list.push(json!({ "title": url, "url": url, "snippet": "", "source": fallback_source, "provider": "xai" }));
            return;
        }
        if !source.is_object() {
            return;
        }
        let url = mixdog_js::js_trim(&js_text(source, &["url", "uri", "href", "source_url", "url_citation.url"])).to_owned();
        if url.is_empty() || !self.seen.insert(url.clone()) {
            return;
        }
        let mut title = js_text(source, &["title", "name", "query", "url_citation.title"]);
        if title.is_empty() {
            title = if fallback_title.is_empty() { url.clone() } else { fallback_title.to_owned() };
        }
        let own_source = js_text(source, &["source"]);
        let provider = js_text(source, &["provider"]);
        self.list.push(json!({
            "title": mixdog_js::js_trim(&title),
            "url": url,
            "snippet": mixdog_js::js_trim(&js_text(source, &["snippet", "text", "description"])),
            "source": if own_source.is_empty() { fallback_source.to_owned() } else { own_source },
            "provider": if provider.is_empty() { "xai".to_owned() } else { provider },
        }));
    }
}

/// An item that is a tool call, by its type alone.
fn is_tool_item(item: &Value) -> bool {
    let kind = str_of(item, "type");
    kind.contains("tool") || kind.contains("function_call")
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
            pending_error: None,
            failure_param: None,
            payload: false,
            exposure: Exposure::default(),
            tools: HashMap::new(),
            texts: HashMap::new(),
            done_items: HashSet::new(),
            calls_emitted: HashSet::new(),
            refusals: Refusals::default(),
            outcome: ResponseOutcome::default(),
            semantic_seen: false,
            output_started: false,
            flight: ToolFlight::default(),
            reasoning_ids: HashSet::new(),
            compat: false,
            model: None,
            label: String::new(),
            content: String::new(),
            listed: Vec::new(),
            leak: LeakGuard::new(HashSet::new(), true),
            dedupe: Dedupe::default(),
        }
    }

    /// Recover tool calls leaked into the output text, naming only these tools (the request body's).
    pub fn with_known_tools(mut self, names: HashSet<String>) -> Self {
        self.leak = LeakGuard::new(names, true);
        self
    }

    /// Visible text joins the content. Live, it is relayed as a delta (`forwardText`, `relayText`) and the stream is
    /// exposed to it; otherwise (`relayFinal`, `absorbCompletedText`: the bundle's text on the HTTP/SSE and WebSocket
    /// collectors) only the content grows, so the turn's returned text is restated and `text` is reported.
    fn add_text(&mut self, text: String, live: bool, out: &mut Vec<StreamEvent>) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(&text);
        if live {
            self.exposure.text_emitted = true;
            out.push(StreamEvent::TextDelta(text));
        } else {
            out.push(StreamEvent::FinalContent(self.content.clone()));
            out.push(StreamEvent::Progress(ProgressKind::Text));
        }
    }

    /// What the guard let through and recovered: visible text first, then the calls.
    fn relay_leak(&mut self, (text, calls): (String, Vec<Recovered>), live: bool, out: &mut Vec<StreamEvent>) {
        self.add_text(text, live, out);
        for recovered in calls {
            let call = leak::openai_call(recovered);
            let fresh = self.dedupe.should_dispatch(&call.name, &call.arguments, &call.id);
            // The WebSocket collector lists a recovered call only when it dispatched it; the others list every one.
            if fresh || self.collector() != Collector::WebSocket {
                self.listed.push(Listed { call: call.clone(), leaked: true });
            }
            if fresh {
                self.exposure.tool_dispatched = true;
                out.push(StreamEvent::ToolCallDone(call));
            }
            // The WebSocket collector reports only a call it dispatched; the other two report every recovery.
            if fresh || self.collector() != Collector::WebSocket {
                out.push(StreamEvent::Progress(ProgressKind::Tool));
            }
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

    pub(super) fn fail(&self, mut err: ProviderError) -> ProviderError {
        let exposure = self.exposure();
        err.exposure.text_emitted |= exposure.text_emitted;
        err.exposure.tool_dispatched |= exposure.tool_dispatched;
        err.exposure.tool_input_cut |= exposure.tool_input_cut;
        if self.collector() != Collector::Compat {
            err.unsafe_to_retry |= err.exposure.tool_dispatched;
        }
        if self.collector() == Collector::HttpSse {
            err.unsafe_to_retry |= err.exposure.text_emitted || err.exposure.tool_dispatched;
            if err.partial_model.is_none() {
                err.partial_model = self.model.as_deref().map(Box::from);
            }
            if err.partial_replay.is_none() && !self.outcome.output_items.is_empty() {
                err.partial_replay = Some(Box::new(ProviderReplay {
                    owner: self.replay_owner.clone(),
                    items: Value::Array(self.outcome.output_items.clone()),
                }));
            }
        }
        err
    }

    pub(super) fn failure_param(&self) -> Option<&str> {
        self.failure_param.as_deref()
    }

    fn wire_error(&mut self, status_event: &Value, error: Option<&Value>, fallback: &str) -> ProviderError {
        self.failure_param = error.and_then(|e| e.get("param")).and_then(Value::as_str).map(str::to_owned);
        let err = classify(&Failure {
            status: None,
            headers: &[],
            error,
            envelope: Some(status_event),
            wire_event: true,
            message_fallback: fallback,
            delivery: DeliveryState::Accepted,
            now_ms: self.context.now_unix_ms(),
        });
        let response = status_event.get("response");
        let terminal_response = matches!(str_of(status_event, "type"), "response.failed" | "response.done");
        if terminal_response && self.collector() == Collector::HttpSse && self.model.is_none() {
            self.model = response.map(|r| str_of(r, "model")).filter(|m| !m.is_empty()).map(str::to_owned);
        }
        let err = match response.filter(|r| terminal_response && r.get("usage").is_some_and(Value::is_object)) {
            Some(response) => self.billed(err, response, true),
            None => err,
        };
        self.fail(err)
    }

    fn in_flight(&self) -> bool {
        self.tools.values().any(|t| !t.done)
    }

    fn hosted_call(kind: &str) -> bool {
        matches!(kind, "web_search_call" | "file_search_call" | "code_interpreter_call" | "image_generation_call" | "mcp_call")
    }

    fn observe_server_effects(&mut self, event: &Value) {
        if self.collector() == Collector::Compat || self.exposure.tool_dispatched {
            return;
        }
        let server_item = |item: &Value| {
            let kind = str_of(item, "type");
            Self::hosted_call(kind)
                || str_of(item, "execution") == "server" && is_tool_item(item)
                || kind == "tool_search_call" && item.get("call_id").is_some_and(Value::is_null)
        };
        // A hosted call can have run without a client dispatch event. Do not
        // emit one; latch the same replay veto seen by the outer retry owners.
        self.exposure.tool_dispatched = str_of(event, "type").strip_prefix("response.")
                .and_then(|name| name.split_once('.')).is_some_and(|(kind, _)| Self::hosted_call(kind))
            || event.get("item").is_some_and(server_item)
            || event.pointer("/response/output").and_then(Value::as_array).is_some_and(|items| items.iter().any(server_item));
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
        self.observe_server_effects(event);
        if str_of(event, "type") != "codex.rate_limits" {
            self.payload = true;
        }
        match str_of(event, "type") {
            "response.created" => {
                if let Some(id) = event.get("response").map(|r| str_of(r, "id")).filter(|i| !i.is_empty()) {
                    self.outcome.response_id = Some(id.to_owned());
                }
                if let Some(model) = event.get("response").map(|r| str_of(r, "model")).filter(|m| !m.is_empty()) {
                    self.model = Some(model.to_owned());
                }
            }
            "codex.rate_limits" => out.push(StreamEvent::ProviderKeepalive),
            "response.output_item.added" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                // The first item starts the generation in the HTTP/SSE and socket collectors (response-events.mjs:49,
                // openai-ws-response-state.mjs:160); the compatible collector keeps no such time.
                if self.collector() != Collector::Compat && !self.output_started {
                    self.output_started = true;
                    out.push(StreamEvent::OutputStarted);
                }
                self.item_added(item, out);
                self.flight.item_added(self.collector(), item);
                // A new item is a lifecycle transition, named by what the item is: a call, else a boundary after earlier
                // output; the first boundary of a response is transport only. A call still in flight is not progress.
                let kind = if is_tool_item(item) {
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
                    if self.leak.enabled() {
                        let scanned = self.leak.push(delta, false);
                        self.relay_leak(scanned, true, out);
                    } else {
                        self.add_text(delta.to_owned(), true, out);
                    }
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
                if event.get("delta").and_then(Value::as_str).is_some_and(|d| !d.is_empty()) {
                    self.semantic_seen = true;
                    out.push(StreamEvent::Progress(ProgressKind::Semantic));
                }
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
                self.flight.input_delta(item_id);
                // Only content advances the response: an empty delta is not progress.
                if !delta.is_empty() {
                    self.semantic_seen = true;
                    out.push(StreamEvent::Progress(ProgressKind::Tool));
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
            "response.incomplete" => return self.incomplete(event, out, "response.incomplete"),
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

    /// The label Node's collector puts in front of every error text of this stream.
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    fn labelled(&self, text: String) -> String {
        if self.label.is_empty() { text } else { format!("{} {text}", self.label) }
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

    /// The kind a finished item reports: by the item's type alone (the compatible collector also counts a web search); a call
    /// still in flight elsewhere in the response does not label it.
    fn done_kind(&self, item: &Value) -> ProgressKind {
        let collector = self.collector();
        let kind = str_of(item, "type");
        if is_incomplete_tool_item(item) && collector != Collector::Compat {
            ProgressKind::Tool
        } else if kind == "reasoning" {
            ProgressKind::Reasoning
        } else if is_tool_item(item) || (collector == Collector::Compat && kind.contains("web_search_call")) {
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
        let relay = self.nothing_streamed();
        if relay {
            for item in output.iter().filter(|item| str_of(item, "type") == "message") {
                self.bundle_text(item, out);
            }
        }
        let mut reported = out[start..]
            .iter()
            .any(|event| matches!(event, StreamEvent::TextDelta(_) | StreamEvent::Progress(ProgressKind::Tool)));
        // The items are collected in the bundle's order: the replay the turn returns keeps it.
        for item in output {
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
        // The bundle relays a message's text only while nothing has streamed (`relayText = !content`).
        if kind == "message" && self.nothing_streamed() {
            self.bundle_text(item, out);
        }
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
                let mut reported = out[start..].iter().any(|event| {
                    matches!(event, StreamEvent::TextDelta(_) | StreamEvent::Progress(ProgressKind::Text | ProgressKind::Tool))
                });
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
                        namespace: str_of(item, "namespace").to_owned(),
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

    fn emit_call(&mut self, id: &str, name: &str, namespace: &str, arguments: Value, out: &mut Vec<StreamEvent>) {
        if id.is_empty() || name.is_empty() || !self.calls_emitted.insert(id.to_owned()) {
            return;
        }
        // A text-leaked call of the same name and arguments already ran: this one is skipped. The WebSocket and
        // HTTP/SSE collectors' identity is the namespace-qualified name (`qualifiedToolCallName`), so a tool of a
        // declared namespace is never conflated with a same-named top-level one.
        let qualified = if self.collector() != Collector::Compat && !namespace.is_empty() {
            format!("{namespace}.{name}")
        } else {
            name.to_owned()
        };
        let call = ToolCall { id: id.to_owned(), name: name.to_owned(), arguments, native_type: None };
        // The call is in the returned list whether or not it is dispatched.
        self.listed.push(Listed { call: call.clone(), leaked: false });
        if !self.dedupe.should_dispatch(&qualified, &call.arguments, id) {
            return;
        }
        self.exposure.tool_dispatched = true;
        out.push(StreamEvent::ToolCallDone(call));
    }

    fn arguments_done(&mut self, event: &Value, out: &mut Vec<StreamEvent>) {
        let item_id = str_of(event, "item_id").to_owned();
        let arguments = parse_call_arguments(str_of(event, "arguments"));
        let (call_id, name, namespace) = match self.tools.get_mut(&item_id) {
            Some(tool) if tool.flavor == ToolFlavor::Search => return,
            Some(tool) => {
                if tool.call_id.is_empty() {
                    tool.call_id = str_of(event, "call_id").to_owned();
                }
                if tool.name.is_empty() {
                    tool.name = str_of(event, "name").to_owned();
                }
                tool.deferred_args = Some(arguments.clone());
                (tool.call_id.clone(), tool.name.clone(), tool.namespace.clone())
            }
            None => (str_of(event, "call_id").to_owned(), str_of(event, "name").to_owned(), String::new()),
        };
        self.emit_call(&call_id, &name, &namespace, arguments, out);
    }

    /// The refusal parts of a finished message (`refusals.absorbMessage`).
    fn absorb_refusals(&mut self, item: &Value, key: &str) {
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
    }

    /// Whether no text has streamed yet (`!content`).
    /// Node's `content` is the visible text: what a leak guard suppressed does not count.
    fn nothing_streamed(&self) -> bool {
        self.content.is_empty()
    }

    /// The text of a message of the terminal bundle, relayed whole (`relayFinalText`, `absorbCompletedText`). The caller
    /// decides whether the bundle may relay at all: only a stream whose deltas carried no text does.
    fn bundle_text(&mut self, item: &Value, out: &mut Vec<StreamEvent>) {
        let text: String = item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| str_of(part, "type") == "output_text")
            .map(|part| str_of(part, "text"))
            .collect();
        if !text.is_empty() {
            self.texts.entry(str_of(item, "id").to_owned()).or_default().push_str(&text);
            // Only the compatible fold relays the bundle's text live.
            let live = self.collector() == Collector::Compat;
            if self.leak.enabled() {
                // The bundle's text goes through the guard whole (`relayFinal`, `absorbCompletedText`).
                let scanned = self.leak.push(&text, true);
                self.relay_leak(scanned, live, out);
            } else {
                self.add_text(text, live, out);
            }
        }
    }
    fn item_done(&mut self, item: &Value, out: &mut Vec<StreamEvent>) {
        let item_id = str_of(item, "id").to_owned();
        // A server-truncated call is held in flight and never collected; the compatible fold has no such case
        // (`reconcileCompatFunctionCallItem` dispatches whatever the finished item carries).
        if is_incomplete_tool_item(item) && self.collector() != Collector::Compat {
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
            "message" => self.absorb_refusals(item, &item_id),
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
        let own = self.tools.get(item_id).map(|tool| tool.namespace.clone()).unwrap_or_default();
        let namespace = if str_of(item, "namespace").is_empty() { own } else { str_of(item, "namespace").to_owned() };
        self.emit_call(&call_id, &name, &namespace, arguments, out);
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
        // The turn is over: nothing is held back any more.
        let tail = self.leak.flush();
        self.relay_leak(tail, true, out);
        // The compatible collector returns `state.content || responseOutputText(response)`: a turn whose text the
        // guard suppressed whole is returned with the response's own output text.
        // A recovered call ran live; the list the turn returns is `dedupeToolCallList` over what was collected, in
        // occurrence order, the compatible collector's native calls ahead of the recovered ones.
        if self.listed.iter().any(|entry| entry.leaked) {
            let mut listed = std::mem::take(&mut self.listed);
            if self.collector() == Collector::Compat {
                listed.sort_by_key(|entry| entry.leaked);
            }
            out.push(StreamEvent::ReturnedCalls(leak::dedupe_list(listed.into_iter().map(|e| e.call).collect())));
        }
        if self.collector() == Collector::Compat && self.nothing_streamed() {
            let output_text = response_output_text(response);
            if !output_text.is_empty() {
                out.push(StreamEvent::FinalContent(output_text));
            }
        }
        // The model that answered (`state.model || useModel`, `response?.model || useModel`): the one the response named.
        if self.model.is_none() {
            self.model = Some(str_of(response, "model").to_owned()).filter(|m| !m.is_empty());
        }
        if let Some(model) = &self.model {
            out.push(StreamEvent::ServedModel(model.clone()));
        }
        self.search_sources(response, out);
        let service_tier = self.reported_tier(response);
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
            out.push(StreamEvent::Usage(usage_from(usage, service_tier, self.collector() == Collector::Compat)));
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
        // The HTTP/SSE collector returns the response's id (`responseId: state.responseId || undefined`,
        // response-outcome.mjs:87), the first one the stream named.
        if self.collector() == Collector::HttpSse
            && let Some(id) = self.outcome.response_id.clone().or_else(|| Some(str_of(response, "id").to_owned())).filter(|id| !id.is_empty())
        {
            out.push(StreamEvent::ResponseId(id));
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

    /// The search calls and cited sources the turn returns (Node `webSearchCalls`, `citations`). The HTTP/SSE collector
    /// keeps every `web_search_call` item (`pushWebSearchCall`, response-items.mjs:52-58) and the URL annotations of the
    /// terminal bundle's messages (`pushOutputTextAnnotations`, text-relay.mjs:19-31); the compatible one reads both
    /// from the final response (`collectCompatResponseSearchSources`, openai-compat-wire.mjs:333-381). The WebSocket
    /// collector returns neither. A search call is reported as a `ServerToolBlock` of type `web_search_call`.
    fn search_sources(&self, response: &Value, out: &mut Vec<StreamEvent>) {
        let collector = self.collector();
        if collector == Collector::WebSocket {
            return;
        }
        let bundle: &[Value] = response.get("output").and_then(Value::as_array).map_or(&[], Vec::as_slice);
        // The compatible collector reads the final response; the HTTP/SSE one collected every finished item.
        let items: &[Value] = if collector == Collector::Compat && !bundle.is_empty() { bundle } else { &self.outcome.output_items };
        let mut citations = Citations::default();
        if collector == Collector::Compat {
            for citation in response.get("citations").and_then(Value::as_array).into_iter().flatten() {
                citations.compat(citation, "", "");
            }
        }
        for item in items {
            if str_of(item, "type") == "web_search_call" {
                out.push(StreamEvent::ServerToolBlock(json!({
                    "type": "web_search_call",
                    "id": str_of(item, "id"),
                    "status": str_of(item, "status"),
                    "action": item.get("action").filter(|a| !a.is_null()).cloned().unwrap_or(Value::Null),
                })));
                if collector == Collector::Compat {
                    let action = item.get("action").filter(|a| a.is_object()).cloned().unwrap_or_else(|| json!({}));
                    let query = js_text(&action, &["query"]);
                    for source in action.get("sources").and_then(Value::as_array).into_iter().flatten() {
                        citations.compat(source, &query, "web_search_call");
                    }
                    let url = js_text(&action, &["url"]);
                    if !url.is_empty() {
                        citations.compat(&json!({ "url": url, "title": query }), "", "web_search_call");
                    }
                    for url in action.get("urls").and_then(Value::as_array).into_iter().flatten() {
                        citations.compat(&json!({ "url": url, "title": query }), "", "web_search_call");
                    }
                }
            }
            if collector == Collector::Compat {
                for citation in item.get("citations").and_then(Value::as_array).into_iter().flatten() {
                    citations.compat(citation, "", "");
                }
                for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                    for annotation in part.get("annotations").and_then(Value::as_array).into_iter().flatten() {
                        citations.compat(annotation, "", "annotation");
                    }
                }
            }
        }
        // `absorbCompletedMessage`: the terminal bundle's messages only.
        if collector == Collector::HttpSse {
            for item in bundle.iter().filter(|item| str_of(item, "type") == "message") {
                for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                    if str_of(part, "type") != "output_text" {
                        continue;
                    }
                    for annotation in part.get("annotations").and_then(Value::as_array).into_iter().flatten() {
                        citations.annotation(annotation);
                    }
                }
            }
        }
        out.extend(citations.list.into_iter().map(StreamEvent::Citation));
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
            "incomplete" => self.incomplete(event, out, "response.done incomplete"),
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

    /// A failure of an incomplete response still carries the usage it was billed and, but for the WebSocket
    /// collector's plain failure, the model that reported it.
    fn reported_tier<'a>(&self, response: &'a Value) -> Option<&'a str> {
        response.get("service_tier").and_then(Value::as_str).or_else(|| {
            (self.collector() != Collector::Compat).then(|| response.get("serviceTier").and_then(Value::as_str)).flatten()
        })
    }

    fn billed(&self, mut err: ProviderError, response: &Value, with_model: bool) -> ProviderError {
        if let Some(usage) = response.get("usage").filter(|u| u.is_object()) {
            err.partial_usage = Some(Box::new(usage_from(usage, self.reported_tier(response), self.collector() == Collector::Compat)));
        }
        if with_model {
            let model = self.model.as_deref().or_else(|| Some(str_of(response, "model")).filter(|m| !m.is_empty()));
            err.partial_model = model.map(Box::from);
        }
        err
    }

    /// `response.incomplete` / an incomplete `response.done` (`settleIncomplete`, `onIncomplete`,
    /// `settleMaxOutputIncomplete`). A max-output cutoff holds the bundle's truncated calls in flight and, with a call
    /// in flight, is a cut stream; otherwise it completes as a length stop. The bundle's items are not collected.
    fn incomplete(&mut self, event: &Value, out: &mut Vec<StreamEvent>, frame: &str) -> Result<(), ProviderError> {
        let reason = incomplete_reason(event);
        let response = event.get("response").unwrap_or(&Value::Null);
        let collector = self.collector();
        if self.model.is_none() {
            self.model = Some(str_of(response, "model")).filter(|m| !m.is_empty()).map(str::to_owned);
        }
        if is_max_output_reason(&reason) {
            // `holdIncompleteBundleItems`: a truncated call of the bundle stays in flight (the compatible fold has no such step).
            if collector != Collector::Compat {
                for item in response.get("output").and_then(Value::as_array).into_iter().flatten().filter(|item| is_incomplete_tool_item(item)) {
                    self.flight.started(item);
                }
            }
            let pending = if collector == Collector::Compat { self.flight.compat_pending() } else { self.flight.pending_tool_use() };
            if pending {
                // The cutoff hit a tool call's input: its arguments are truncated, so this is a cut stream, never a
                // clean length stop.
                self.terminal = true;
                let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
                err.message = self.labelled(if collector == Collector::Compat {
                    format!("SSE stream truncated: incomplete ({reason}) with tool call in flight")
                } else {
                    format!("{frame} (max_output_tokens) with tool call in flight")
                });
                err.code = Some(reason);
                let mut err = self.billed(self.fail(err), response, true);
                err.exposure.tool_input_cut = true;
                // Only the WebSocket collector keeps the replay of what it had finished (`partialState`).
                if collector == Collector::WebSocket && !self.outcome.output_items.is_empty() {
                    err.partial_replay = Some(Box::new(ProviderReplay {
                        owner: self.replay_owner.clone(),
                        items: Value::Array(self.outcome.output_items.clone()),
                    }));
                }
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
        err.message = self.labelled(if collector == Collector::Compat { format!("stream {frame}: {reason}") } else { format!("{frame}: {reason}") });
        err.code = Some(reason.to_ascii_lowercase());
        // The WebSocket collector's plain failure carries the billed usage only.
        let with_model = collector != Collector::WebSocket;
        Err(self.billed(self.fail(err), response, with_model))
    }
}

impl WireDecoder for ResponsesDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.pending_error.take() {
            return Err(err);
        }
        let mut out = Vec::new();
        if self.terminal {
            return Ok(out);
        }
        let decoded = match self.framing {
            Framing::Sse => self.feed_sse(unit, &mut out),
            Framing::WebSocket => match serde_json::from_slice::<Value>(unit) {
                Ok(event) => self.handle(&event, &mut out),
                Err(_) => Ok(()),
            },
        };
        match decoded {
            // What the unit decoded before its failing frame is delivered first (Node handles frames one by one).
            Err(err) if !out.is_empty() => {
                self.pending_error = Some(err);
                Ok(out)
            }
            Err(err) => Err(err),
            Ok(()) => Ok(out),
        }
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.pending_error.take() {
            return Err(err);
        }
        let mut out = Vec::new();
        if !self.terminal && self.framing == Framing::Sse {
            let flushed = (|| {
                if !self.line_buf.is_empty() {
                    let line = std::mem::take(&mut self.line_buf);
                    let line = line.strip_suffix(b"\r").unwrap_or(&line);
                    self.sse_line(line, &mut out)?;
                }
                if !self.terminal {
                    self.sse_dispatch(&mut out)?;
                }
                Ok(())
            })();
            if let Err(err) = flushed {
                if out.is_empty() || self.collector() == Collector::Compat {
                    return Err(err);
                }
                self.pending_error = Some(err);
                return Ok(out);
            }
        }
        if self.terminal {
            return Ok(out);
        }
        let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        if self.collector() == Collector::Compat {
            // `consumeCompatResponsesStream`: a source that ends without `response.completed` throws
            // `truncatedCompatStreamError(label, 'no response.completed')`, carrying the model the stream named.
            err.message = self.labelled("SSE stream truncated: no response.completed".into());
            return Err(self.billed(self.fail(err), &Value::Null, true));
        }
        err.message = "stream ended before the response completed".into();
        let err = self.fail(err);
        if out.is_empty() {
            Err(err)
        } else {
            self.pending_error = Some(err);
            Ok(out)
        }
    }

    /// A whole protocol record was decoded, whether or not it carried output; metadata frames (`codex.rate_limits`) and SSE
    /// comments are not one.
    fn payload_seen(&self) -> bool {
        self.payload
    }

    /// A failing terminal frame is not the end while its failure is still to be returned.
    fn terminal_seen(&self) -> bool {
        self.terminal && self.pending_error.is_none()
    }

    fn exposure(&self) -> Exposure {
        Exposure {
            // The compatible fold's `pendingToolUse` is its latched flag; a call whose item finished cleared it.
            tool_input_cut: if self.collector() == Collector::Compat { self.flight.compat_pending() } else { self.in_flight() },
            ..self.exposure
        }
    }
}

#[cfg(test)]
mod reasoning_tests {
    use super::*;

    /// `firstFiniteNumberOrZero`: a reported 0 ends the search and no top-level `cached_tokens` is read; the compatible
    /// collector keeps its first-positive rule.
    #[test]
    fn the_cached_figure_is_the_first_finite_one() {
        let usage = json!({ "input_tokens": 9, "input_tokens_details": { "cached_tokens": 0 }, "prompt_tokens_details": { "cached_tokens": 500 }, "cached_tokens": 300 });
        assert_eq!(usage_from(&usage, None, false).cache_read_tokens, 0);
        assert_eq!(usage_from(&json!({ "input_tokens": 9, "cached_tokens": 300 }), None, false).cache_read_tokens, 0);
        assert_eq!(usage_from(&json!({ "inputTokensDetails": { "cachedTokens": 40 } }), None, false).cache_read_tokens, 40);
        assert_eq!(usage_from(&usage, None, true).cache_read_tokens, 500);
    }

    #[test]
    fn compatible_responses_keep_reported_token_aliases_without_counting_twice() {
        let mut raw = json!({"input_tokens":null,"prompt_tokens":80.0,"completion_tokens":"5",
            "prompt_cache_hit_tokens":50,"cached_prompt_text_tokens":60});
        let normalized = usage_from(&raw, None, true);
        assert_eq!((normalized.input_tokens, normalized.output_tokens, normalized.cache_read_tokens), (80, 5, 50));
        raw["input_tokens"] = json!(0);
        raw["output_tokens"] = json!(0);
        raw["prompt_cache_hit_tokens"] = json!(0);
        let normalized = usage_from(&raw, None, true);
        assert_eq!((normalized.input_tokens, normalized.output_tokens, normalized.cache_read_tokens), (0, 0, 60));
        raw["cached_prompt_text_tokens"] = json!("55");
        raw["inputTokensDetails"] = json!({"cacheWriteTokens":0});
        raw["cache_write_tokens"] = json!(40);
        let normalized = usage_from(&raw, None, true);
        assert_eq!((normalized.cache_read_tokens, normalized.cache_write_tokens), (55, 0));
    }

    #[test]
    fn a_reported_zero_stays_zero_and_a_missing_figure_stays_missing() {
        let zero = usage_from(&json!({ "input_tokens": 5, "output_tokens": 2, "output_tokens_details": { "reasoning_tokens": 0 } }), None, false);
        assert_eq!(zero.reasoning_tokens, Some(0));
        let missing = usage_from(&json!({ "input_tokens": 5, "output_tokens": 2 }), None, false);
        assert_eq!(missing.reasoning_tokens, None);
        let counted = usage_from(&json!({ "output_tokens_details": { "reasoning_tokens": 7 } }), None, false);
        assert_eq!(counted.reasoning_tokens, Some(7));
    }
}

#[cfg(test)]
mod arguments_tests {

}



#[cfg(test)]
mod progress_tests {
    use super::*;

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

    /// Progress is content that advances the response or a lifecycle transition: an empty argument delta is neither, a
    /// whitespace one is content, and a call still in flight does not label the next item.
    #[test]
    fn an_empty_argument_delta_is_no_progress_and_a_call_in_flight_labels_nothing() {
        let mut decoder = ResponsesDecoder::new(Framing::WebSocket, Arc::new(Ctx), ProviderId::from("openai"));
        let mut feed = |wire: serde_json::Value| decoder.feed(wire.to_string().as_bytes()).expect("a valid frame");
        let progress = |events: &[StreamEvent]| events.iter().filter_map(|e| if let StreamEvent::Progress(kind) = e { Some(*kind) } else { None }).collect::<Vec<_>>();
        let call = serde_json::json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "fc", "call_id": "c", "name": "write" } });
        assert_eq!(progress(&feed(call)), vec![ProgressKind::Tool], "a call opening is a lifecycle transition");
        let delta = |text: &str| serde_json::json!({ "type": "response.function_call_arguments.delta", "item_id": "fc", "delta": text });
        assert!(progress(&feed(delta(""))).is_empty(), "an empty delta advances nothing");
        assert_eq!(progress(&feed(delta(" "))), vec![ProgressKind::Tool], "whitespace is content");
        let message = serde_json::json!({ "type": "response.output_item.added", "item": { "type": "message", "id": "m" } });
        assert_eq!(progress(&feed(message)), vec![ProgressKind::Semantic], "an item is named by its type, not by the call in flight");
    }

}

#[cfg(test)]
mod split_read_tests {
    use super::*;
    use crate::providers::openai::adapter::SessionContext;

    fn frame(event: &Value) -> String {
        format!("data: {event}\n\n")
    }

    /// What the stream makes of `chunks` read in turn: its events, and the failure it ends in. After each read the held
    /// failure is asked for, as `ResponsesStream::next` does.
    fn read(chunks: &[&[u8]]) -> (Vec<StreamEvent>, Option<ProviderError>) {
        let mut decoder = ResponsesDecoder::new(Framing::Sse, Arc::new(SessionContext::default()), ProviderId::from("openai"));
        let mut events = Vec::new();
        for chunk in chunks {
            match decoder.feed(chunk) {
                Ok(more) => events.extend(more),
                Err(error) => return (events, Some(error)),
            }
            if let Err(error) = decoder.feed(&[]) {
                return (events, Some(error));
            }
        }
        (events, decoder.finish().err())
    }

    /// The frames read in one chunk, one frame per chunk, and one byte per chunk: the same events and the same failure.
    fn read_every_way(frames: &[Value]) -> (Vec<StreamEvent>, ProviderError) {
        let text: Vec<String> = frames.iter().map(frame).collect();
        let whole = text.concat();
        let (events, error) = read(&[whole.as_bytes()]);
        let per_frame: Vec<&[u8]> = text.iter().map(|f| f.as_bytes()).collect();
        assert_eq!(read(&per_frame), (events.clone(), error.clone()), "frame by frame");
        let per_byte: Vec<&[u8]> = whole.as_bytes().chunks(1).collect();
        assert_eq!(read(&per_byte), (events.clone(), error.clone()), "byte by byte");
        (events, error.expect("the stream failed"))
    }

    fn failed() -> Value {
        json!({ "type": "response.failed", "response": { "id": "resp_1", "status": "failed", "error": { "code": "server_error", "message": "boom" } } })
    }

    #[test]
    fn only_failed_response_frames_name_a_previously_unknown_serving_model() {
        let mut terminal = failed();
        terminal["response"]["model"] = json!("served");
        let (_, failure) = read_every_way(&[terminal]);
        assert_eq!(failure.partial_model.as_deref(), Some("served"));
        let (_, failure) = read_every_way(&[json!({"type":"error","error":{"message":"boom"},"response":{"model":"not-confirmed"}})]);
        assert!(failure.partial_model.is_none());
    }

    #[test]
    fn text_read_together_with_a_failing_frame_is_delivered_before_the_failure() {
        let (events, error) = read_every_way(&[
            json!({ "type": "response.created", "response": { "id": "resp_1", "model": "m" } }),
            json!({ "type": "response.output_item.added", "output_index": 0, "item": { "type": "message", "id": "msg_1", "role": "assistant", "content": [] } }),
            json!({ "type": "response.output_text.delta", "output_index": 0, "item_id": "msg_1", "delta": "partial" }),
            failed(),
        ]);
        assert!(events.iter().any(|e| matches!(e, StreamEvent::TextDelta(t) if t == "partial")), "{events:?}");
        assert!(error.exposure.text_emitted);
        assert_eq!(error.code.as_deref(), Some("server_error"));
    }

    #[test]
    fn a_tool_completion_read_together_with_a_failing_frame_is_delivered_before_the_failure() {
        let call = json!({ "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read", "arguments": "{}" });
        let (events, error) = read_every_way(&[
            json!({ "type": "response.created", "response": { "id": "resp_1", "model": "m" } }),
            json!({ "type": "response.output_item.added", "output_index": 0, "item": call }),
            json!({ "type": "response.output_item.done", "output_index": 0, "item": call }),
            failed(),
        ]);
        assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(c) if c.id == "call_1")), "{events:?}");
        assert!(error.exposure.tool_dispatched);
    }
}
