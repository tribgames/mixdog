//! Chat Completions SSE → `StreamEvent`s (`consumeCompatChatCompletionStream`,
//! `chunk-events.mjs`, `tool-call-acc.mjs`, `stream-result.mjs`).
//!
//! The terminal predicate of this wire (SPEC §4.9 case 4): a `finish_reason`
//! arrived. The last chunk may be a usage-only chunk after it, so `Completed`
//! is emitted at `[DONE]` or the end of the body, after `Usage`; a partial
//! frame left at the end is dropped.

use std::collections::HashSet;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::{
    DeliveryState, ErrorKind, Exposure, ProgressKind, ProviderError, StopReason, StreamEvent, ToolCall,
    TransportFault, Usage, UsdTicks, WireDecoder,
};
use mixdog_protocol::{JsonValue, ProviderId};
use serde_json::json;

use super::super::error::classify_parts;
use crate::providers::leak;
use crate::providers::leak::Dedupe;
use crate::providers::leak::LeakGuard;
use crate::providers::leak::Recovered;
use super::super::profile::{CompatProfile, CostField, ReasoningShape};
use super::super::sse::{SseDecoder, SseItem};
use super::reasoning::{self, ContentPiece, Source};

#[derive(Clone, PartialEq, Eq, Debug)]
enum Key {
    Index(i64),
    Id(String),
    Anon(u32),
}

#[derive(Debug)]
struct ToolEntry {
    key: Key,
    id: String,
    kind: String,
    name: String,
    arguments: String,
}

/// Reasons the gateway reports in-band as a failure, never as a completion.
fn failing_finish(reason: &str) -> Option<&'static str> {
    match mixdog_js::js_trim(reason).to_lowercase().as_str() {
        "network_error" => Some("network_error"),
        "error" => Some("error"),
        _ => None,
    }
}

/// A length-truncated or content-filtered turn is a partial result: none of
/// its tool calls may run.
fn is_incomplete_finish(reason: &str) -> bool {
    matches!(reason, "length" | "content_filter")
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        // Node stores the wire's own `finish_reason` (`stopReason: choice.finish_reason`), so a plain stop stays `stop`.
        "stop" => StopReason::Other("stop".to_owned()),
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::ContentFilter,
        other => StopReason::Other(other.to_owned()),
    }
}

/// Arguments of a completed call. A finish signal was seen, so malformed JSON
/// is complete-but-wrong, not truncated: it rides as data so the model can
/// re-issue the call in the same turn.
fn parse_arguments(raw: &str) -> JsonValue {
    let text = if raw.is_empty() { "{}" } else { raw };
    mixdog_js::json_parse(text).unwrap_or_else(|err| {
        json!({
            "__invalidToolArgs": true,
            "__rawArguments": raw,
            "__parseError": mixdog_js::v8_json_parse_error(raw).unwrap_or_else(|| err.to_string()),
        })
    })
}

fn number(value: Option<&JsonValue>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

fn first_positive_else_finite(candidates: &[Option<f64>]) -> f64 {
    candidates
        .iter()
        .flatten()
        .find(|n| **n > 0.0)
        .or_else(|| candidates.iter().flatten().next())
        .copied()
        .unwrap_or(0.0)
}

/// `prompt_tokens` is the whole prompt with the cached part inside it.
pub fn usage_from(raw: &JsonValue, cost: CostField) -> Usage {
    let get = |path: &[&str]| {
        let mut v = Some(raw);
        for key in path {
            v = v.and_then(|v| v.get(key));
        }
        number(v)
    };
    let to_u64 = |n: f64| n.max(0.0) as u64;
    let cached = first_positive_else_finite(&[
        get(&["prompt_tokens_details", "cached_tokens"]),
        get(&["input_tokens_details", "cached_tokens"]),
        get(&["prompt_cache_hit_tokens"]),
        get(&["cached_prompt_text_tokens"]),
        get(&["cached_tokens"]),
    ]);
    let written = [
        get(&["input_tokens_details", "cache_write_tokens"]),
        get(&["prompt_tokens_details", "cache_write_tokens"]),
        get(&["cache_write_tokens"]),
        get(&["cacheWriteTokens"]),
    ]
    .into_iter()
    .flatten()
    .next()
    .unwrap_or(0.0);
    Usage {
        input_tokens: to_u64(get(&["prompt_tokens"]).or(get(&["input_tokens"])).unwrap_or(0.0)),
        output_tokens: to_u64(get(&["completion_tokens"]).or(get(&["output_tokens"])).unwrap_or(0.0)),
        cache_read_tokens: to_u64(cached),
        cache_write_tokens: to_u64(written),
        cache_write_1h_tokens: 0,
        reasoning_tokens: get(&["completion_tokens_details", "reasoning_tokens"])
            .or(get(&["output_tokens_details", "reasoning_tokens"]))
            .map(to_u64),
        reasoning_incomplete: false,
        raw: Some(raw.clone()),
        cost: reported_cost(raw, cost),
    }
}

/// What the provider billed, when it says; `null`, negative or absent is "not
/// reported", never a reported $0.
fn reported_cost(raw: &JsonValue, field: CostField) -> Option<UsdTicks> {
    const TICKS_PER_USD: f64 = 1e10;
    match field {
        CostField::None => None,
        CostField::UsdTicks => number(raw.get("cost_in_usd_ticks"))
            .filter(|n| *n >= 0.0)
            .map(|n| UsdTicks(n.round() as u64)),
        CostField::UsdDecimal => number(raw.get("cost"))
            .filter(|n| *n >= 0.0)
            .map(|usd| UsdTicks((usd * TICKS_PER_USD).round() as u64)),
    }
}

pub struct ChatDecoder {
    profile: CompatProfile,
    owner: ProviderId,
    sse: SseDecoder,
    text_emitted: bool,
    content: String,
    reasoning: String,
    reasoning_source: Option<Source>,
    details: Vec<JsonValue>,
    tools: Vec<ToolEntry>,
    next_anon: u32,
    last_key: Option<Key>,
    finish: Option<String>,
    usage: Option<JsonValue>,
    tool_dispatched: bool,
    tool_input_cut: bool,
    terminal: bool,
    failure: Option<ProviderError>,
    /// Some output was reported (`semanticIdleDeadlineAt > 0`): from then on a role-only delta is progress.
    progressed: bool,
    /// The leaked tool-call guard over the text deltas (`stream-state.mjs` `leakGuard`, harmony syntax on).
    leak: LeakGuard,
    /// Every call recovered from text (`leakedCalls`); dispatched at the end of a normally finished turn only.
    leaked: Vec<ToolCall>,
    /// The streamed calls of a normally finished turn, whether or not they were dispatched.
    natives: Vec<ToolCall>,
    /// A normal `finish_reason` arrived.
    normal_finish: bool,
    /// A normal or a cut/filtered `finish_reason` arrived: the turn returns its list.
    listed_finish: bool,
    /// One dispatch per call across the recovered and the streamed path.
    dedupe: Dedupe,
    /// The model the chunks name (`chunk-events.mjs:56`, the last non-empty one wins), which the turn reports as the one
    /// that answered (Node's result `model: response.model || useModel`, openai-compat-chat-send.mjs:321).
    served: String,
}

impl ChatDecoder {
    pub fn new(profile: CompatProfile, owner: ProviderId) -> Self {
        Self {
            profile,
            owner,
            sse: SseDecoder::default(),
            text_emitted: false,
            content: String::new(),
            reasoning: String::new(),
            reasoning_source: None,
            details: Vec::new(),
            tools: Vec::new(),
            next_anon: 0,
            last_key: None,
            finish: None,
            usage: None,
            tool_dispatched: false,
            tool_input_cut: false,
            terminal: false,
            failure: None,
            progressed: false,
            leak: LeakGuard::new(HashSet::new(), true),
            leaked: Vec::new(),
            natives: Vec::new(),
            normal_finish: false,
            listed_finish: false,
            dedupe: Dedupe::default(),
            served: String::new(),
        }
    }

    /// Recover tool calls leaked into the text, naming only these tools (the request body's).
    pub fn with_known_tools(mut self, names: HashSet<String>) -> Self {
        self.leak = LeakGuard::new(names, true);
        self
    }

    /// What the guard let through and recovered: visible text first, then the calls (each reports `tool`).
    fn relay_leak(&mut self, (text, calls): (String, Vec<Recovered>), out: &mut Vec<StreamEvent>) {
        self.emit_text(&text, out);
        for recovered in calls {
            let call = leak::openai_call(recovered);
            self.leaked.push(call.clone());
            self.progress(out);
            out.push(StreamEvent::Progress(ProgressKind::Tool));
            // Held until a normal finish confirms the turn ended (`drainLeakedCalls`).
            if self.normal_finish {
                self.dispatch(call, out);
            }
        }
    }

    /// Text the model exposed: through the guard when tools were offered.
    fn append_text(&mut self, text: &str, out: &mut Vec<StreamEvent>) {
        if self.leak.enabled() {
            let scanned = self.leak.push(text, false);
            self.relay_leak(scanned, out);
        } else {
            self.emit_text(text, out);
        }
    }

    fn error(&self, mut err: ProviderError) -> ProviderError {
        err.exposure = self.exposure_now();
        err
    }

    fn exposure_now(&self) -> Exposure {
        Exposure {
            text_emitted: self.text_emitted,
            // Node's `toolWorkStarted`: a streamed call being accumulated or a call recovered from text counts as tool
            // work from the moment it starts, dispatched or not (stream-state.mjs:143).
            tool_dispatched: self.tool_dispatched || !self.tools.is_empty() || !self.leaked.is_empty(),
            tool_input_cut: self.tool_input_cut,
        }
    }

    fn truncated(&self, why: &str) -> ProviderError {
        let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        err.message = format!("SSE stream truncated: {why}");
        self.error(err)
    }

    fn malformed(&self, cause: &serde_json::Error) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        err.code = Some("malformed_stream".into());
        err.message = format!("malformed stream frame: {cause}");
        self.error(err)
    }

    /// Visible output (`text`, `reasoning` or `tool`, `isVisibleStreamProgress`): the first starts the generation
    /// (`reportProgress`, stream-state.mjs:72).
    fn progress(&mut self, out: &mut Vec<StreamEvent>) {
        if !self.progressed {
            out.push(StreamEvent::OutputStarted);
        }
        self.progressed = true;
    }

    fn emit_text(&mut self, text: &str, out: &mut Vec<StreamEvent>) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        self.text_emitted = true;
        self.progress(out);
        out.push(StreamEvent::TextDelta(text.to_owned()));
    }

    fn append_reasoning(&mut self, text: &str, source: Source, out: &mut Vec<StreamEvent>) {
        self.reasoning_source = Some(source);
        self.reasoning.push_str(text);
        if !text.is_empty() {
            self.progress(out);
            out.push(StreamEvent::ReasoningDelta(text.to_owned()));
        }
    }

    fn merge_tool_calls(&mut self, calls: &[JsonValue], out: &mut Vec<StreamEvent>) {
        for call in calls {
            let id = call.get("id").and_then(JsonValue::as_str).filter(|s| !s.is_empty());
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(JsonValue::as_str)
                .filter(|s| !s.is_empty());
            let key = if let Some(index) = call.get("index").and_then(JsonValue::as_f64).filter(|n| n.is_finite()) {
                Key::Index(index as i64)
            } else if let Some(id) = id {
                Key::Id(id.to_owned())
            } else if name.is_some() {
                self.next_anon += 1;
                Key::Anon(self.next_anon)
            } else if let Some(last) = self.last_key.clone() {
                last
            } else {
                continue;
            };
            // Bare argument deltas continue the most recently identified call.
            self.last_key = Some(key.clone());
            let at = match self.tools.iter().position(|t| t.key == key) {
                Some(at) => at,
                None => {
                    self.tools.push(ToolEntry {
                        key,
                        id: String::new(),
                        kind: "function".into(),
                        name: String::new(),
                        arguments: String::new(),
                    });
                    self.tools.len() - 1
                }
            };
            let entry = &mut self.tools[at];
            if let Some(id) = id {
                entry.id = id.to_owned();
            }
            if let Some(kind) = call.get("type").and_then(JsonValue::as_str).filter(|s| !s.is_empty()) {
                entry.kind = kind.to_owned();
            }
            if let Some(name) = name
                && entry.name.is_empty()
            {
                entry.name = name.to_owned();
                out.push(StreamEvent::ToolCallStart {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                });
            }
            // Argument fragments are deltas: always appended, never snapshots.
            if let Some(args) = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(JsonValue::as_str)
                .filter(|s| !s.is_empty())
            {
                entry.arguments.push_str(args);
                out.push(StreamEvent::ToolCallArgsDelta {
                    id: entry.id.clone(),
                    delta: args.to_owned(),
                });
            }
        }
    }

    fn apply_chunk(&mut self, chunk: &JsonValue, out: &mut Vec<StreamEvent>) {
        let choice = chunk.get("choices").and_then(|c| c.get(0));
        let delta = choice.and_then(|c| c.get("delta"));
        // `reportLifecycle(state, 'semantic')`: a role-only delta is progress once the model has produced output.
        if self.progressed && delta.and_then(|d| d.get("role")).and_then(JsonValue::as_str).is_some_and(|role| !role.is_empty()) {
            out.push(StreamEvent::Progress(ProgressKind::Semantic));
        }
        if let Some(content) = delta.and_then(|d| d.get("content")) {
            match reasoning::content_pieces(content) {
                Some(pieces) => {
                    for piece in pieces {
                        match piece {
                            ContentPiece::Reasoning(text) => {
                                self.append_reasoning(&text, Source::ContentChunks, out)
                            }
                            ContentPiece::Text(text) => self.append_text(&text, out),
                        }
                    }
                }
                None => {
                    if let Some(text) = content.as_str() {
                        self.append_text(text, out);
                    }
                }
            }
        }
        if let Some(details) = delta
            .and_then(|d| d.get("reasoning_details"))
            .and_then(JsonValue::as_array)
            .filter(|d| !d.is_empty())
        {
            self.details.extend(details.iter().cloned());
            self.progress(out);
            out.push(StreamEvent::Progress(ProgressKind::Reasoning));
        }
        // These provider fields are aliases, never independent segments.
        for (key, source) in [
            ("reasoning_content", Source::ReasoningContent),
            ("reasoning", Source::Reasoning),
            ("thinking", Source::Thinking),
        ] {
            if let Some(text) = delta.and_then(|d| d.get(key)).and_then(JsonValue::as_str) {
                self.append_reasoning(text, source, out);
                break;
            }
        }
        if let Some(calls) = delta.and_then(|d| d.get("tool_calls")).and_then(JsonValue::as_array) {
            if !calls.is_empty() {
                self.progress(out);
                out.push(StreamEvent::Progress(ProgressKind::Tool));
            }
            self.merge_tool_calls(calls, out);
        }
        if let Some(reason) = choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(JsonValue::as_str)
            .filter(|r| !r.is_empty())
        {
            self.finish = Some(reason.to_owned());
            self.on_finish(reason, out);
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(usage.clone());
        }
        if let Some(model) = chunk.get("model").and_then(JsonValue::as_str).filter(|m| !m.is_empty()) {
            model.clone_into(&mut self.served);
        }
    }

    /// Calls are dispatched only once a normal finish confirms the turn ended.
    fn on_finish(&mut self, reason: &str, out: &mut Vec<StreamEvent>) {
        if failing_finish(reason).is_some() {
            return;
        }
        // A cut or filtered turn dispatches nothing live, but the list it returns still holds the streamed calls and
        // the recovered ones (`settleCompatStream`), and the loop runs what the list holds.
        let incomplete = is_incomplete_finish(reason);
        if incomplete {
            self.tool_input_cut = !self.tools.is_empty();
        } else {
            // The turn ended normally: the recovered calls run first (`drainLeakedCalls`), then the streamed ones.
            self.normal_finish = true;
            for call in self.leaked.clone() {
                self.dispatch(call, out);
            }
        }
        self.listed_finish = true;
        let natives: Vec<ToolCall> = self
            .tools
            .iter()
            .filter(|entry| !(entry.id.is_empty() && entry.name.is_empty()) && entry.kind == "function")
            .map(|entry| ToolCall {
                id: entry.id.clone(),
                name: entry.name.clone(),
                arguments: parse_arguments(&entry.arguments),
                native_type: None,
            })
            .collect();
        for call in natives {
            self.natives.push(call.clone());
            if !incomplete {
                self.dispatch(call, out);
            }
        }
    }

    /// One dispatch per call across the recovered and the streamed path (`emitCompatToolCallOnce`).
    fn dispatch(&mut self, call: ToolCall, out: &mut Vec<StreamEvent>) {
        if self.dedupe.should_dispatch(&call.name, &call.arguments, &call.id) {
            self.tool_dispatched = true;
            out.push(StreamEvent::ToolCallDone(call));
        }
    }

    /// The list the turn returns, `dedupeToolCallList([...native, ...leaked])`: a recovered call that already ran
    /// gives way to the streamed call that repeats it.
    fn return_calls(&mut self, out: &mut Vec<StreamEvent>) {
        if !self.listed_finish || self.leaked.is_empty() {
            return;
        }
        let all = self.natives.iter().chain(&self.leaked).cloned().collect();
        out.push(StreamEvent::ReturnedCalls(leak::dedupe_list(all)));
    }

    /// `normalizeCompatChatResponse`: a turn cut by `length` while it holds calls, or stopped by a content filter, is a
    /// `ProviderIncompleteError` that carries the calls (`partialToolCalls`) and is never retried: the turn fails and
    /// none of them runs.
    fn incomplete_failure(&self, finish: &str) -> Option<ProviderError> {
        if !(finish == "content_filter" || finish == "length") {
            return None;
        }
        let calls: Vec<ToolCall> = if self.leaked.is_empty() {
            self.natives.clone()
        } else {
            leak::dedupe_list(self.natives.iter().chain(&self.leaked).cloned().collect())
        };
        if finish == "length" && calls.is_empty() {
            return None;
        }
        let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
        err.code = Some("PROVIDER_INCOMPLETE".into());
        err.message = format!("response incomplete: finish_reason={finish}");
        err.exposure = Exposure { text_emitted: self.text_emitted, ..Exposure::default() };
        err.partial_tool_calls = calls;
        if let Some(raw) = &self.usage {
            err.partial_usage = Some(Box::new(usage_from(raw, self.profile.chat.cost)));
            err.partial_model = Some(self.served.as_str()).filter(|m| !m.is_empty()).map(Box::from);
        }
        Some(err)
    }

    fn in_band_error(&self, chunk: &JsonValue) -> ProviderError {
        let mut err = classify_parts(&self.profile, None, &[], chunk, SystemTime::now());
        if self.profile.chat.in_band_invalid_request_retryable && err.kind == ErrorKind::InvalidRequest {
            err.kind = ErrorKind::Transient;
        }
        self.error(err)
    }

    fn on_data(&mut self, data: &str, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let data = mixdog_js::js_trim(data);
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            return self.finalize(out);
        }
        let chunk: JsonValue = serde_json::from_str(data).map_err(|e| self.malformed(&e))?;
        if chunk.get("error").is_some_and(|e| !e.is_null()) {
            return Err(self.in_band_error(&chunk));
        }
        self.apply_chunk(&chunk, out);
        Ok(())
    }

    fn finalize(&mut self, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        if self.terminal {
            return Ok(());
        }
        let Some(finish) = self.finish.clone() else {
            return Err(self.truncated("no finish_reason"));
        };
        match failing_finish(&finish) {
            Some("network_error") => {
                return Err(self.truncated("finish_reason=network_error"));
            }
            Some(_) => {
                let mut err = self.truncated("finish_reason=error");
                err.status = Some(502);
                err.code = Some("upstream_error".into());
                return Err(err);
            }
            None => {}
        }
        // The stream ended: nothing is held back any more.
        let tail = self.leak.flush();
        self.relay_leak(tail, out);
        if let Some(err) = self.incomplete_failure(&finish) {
            return Err(err);
        }
        self.return_calls(out);
        let saw_reasoning = self.reasoning_source.is_some();
        // An empty completion is a normal `Completed`; the retry policy's
        // `empty_response_reasks` decides whether it is asked again.
        if let Some(raw) = &self.usage {
            out.push(StreamEvent::Usage(usage_from(raw, self.profile.chat.cost)));
        }
        let dialect = &self.profile.chat;
        let source = self.reasoning_source.unwrap_or(Source::ReasoningContent);
        let keeps_details = dialect.reasoning_shape == Some(ReasoningShape::Reasoning) && !self.details.is_empty();
        if (saw_reasoning && reasoning::captures(dialect, source)) || keeps_details {
            let details: &[JsonValue] = if keeps_details { &self.details } else { &[] };
            out.push(StreamEvent::ReasoningReplay(reasoning::envelope(
                &self.owner,
                dialect,
                &self.reasoning,
                source,
                details,
            )));
        }
        if !self.served.is_empty() {
            out.push(StreamEvent::ServedModel(self.served.clone()));
        }
        out.push(StreamEvent::Completed {
            pricing_model: None,
            request_ms: None,
            stop: Some(stop_reason(&finish)),
        });
        self.terminal = true;
        Ok(())
    }
}

impl WireDecoder for ChatDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        let mut out = Vec::new();
        for item in self.sse.feed(unit) {
            if self.terminal {
                break;
            }
            let step = match item {
                SseItem::Comment => {
                    out.push(StreamEvent::ProviderKeepalive);
                    Ok(())
                }
                SseItem::Event { data, .. } => self.on_data(&data, &mut out),
            };
            if let Err(err) = step {
                self.failure = Some(err.clone());
                // The events decoded before the error in this unit reach the caller first (Node relays each chunk
                // before it parses the next); the stored failure ends the stream on the next call.
                return if out.is_empty() { Err(err) } else { Ok(out) };
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        if self.terminal {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        // A body that ends inside an event never reports success, even after
        // `finish_reason`: a cut trailing usage frame is a truncated stream.
        if self.sse.has_pending() {
            let err = self.truncated("stream ended inside an event");
            self.failure = Some(err.clone());
            return Err(err);
        }
        match self.finalize(&mut out) {
            Ok(()) => Ok(out),
            Err(err) => {
                self.failure = Some(err.clone());
                Err(err)
            }
        }
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    fn exposure(&self) -> Exposure {
        self.exposure_now()
    }
}
