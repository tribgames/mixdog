//! Gemini `streamGenerateContent?alt=sse` → [`StreamEvent`]s.
//!
//! One decoder serves the Gemini API, Vertex AI and Antigravity (whose chunks
//! arrive wrapped in a `response` envelope). The wire's terminal predicate is
//! the final candidate's `finishReason`; a stream that ends without one is
//! truncated, except one that delivered whole function calls (the gateway
//! ends a tool-use turn that way). Deltas are hints: the folded events at
//! the end of the body — replay envelope, citations, usage, `Completed` — are
//! the truth.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::error::ErrorDialect;
use super::error::in_band;
use super::json::synthesized_call_id;
use crate::providers::leak;
use crate::providers::leak::LeakGuard;
use crate::providers::leak::Recovered;

/// The JSON payload of one line of a Gemini SSE stream: the text after `data:`, trimmed. A line
/// that is not a `data:` line (an `event:` name, a comment, a blank), an empty payload and the
/// `[DONE]` marker carry none. Shared by every consumer of the dialect: the decoder below and
/// the media adapter that reads a whole Antigravity body.
pub fn sse_data(line: &str) -> Option<&str> {
    let data = line.strip_prefix("data:")?.trim();
    (!data.is_empty() && data != "[DONE]").then_some(data)
}

/// How `usageMetadata` maps onto [`Usage`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageStyle {
    /// `promptTokenCount` already contains the cached tokens.
    Inclusive,
    /// Vertex AI accounts input exclusive of cache reads.
    CacheExclusive,
    /// Antigravity adds the tool-use prompt tokens to the input.
    ToolUseAdded,
}

#[derive(Clone, Debug)]
pub struct DecodeDialect {
    pub owner: ProviderId,
    /// Chunks are `{response: <chunk>}` envelopes.
    pub envelope: bool,
    pub usage: UsageStyle,
    pub errors: ErrorDialect,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FinishKind {
    Unfinished,
    Complete,
    OutputLimit,
    Policy,
    Language,
    Recitation,
    InvalidToolCall,
    ToolCallTerminal,
    Continuation,
    Other,
}

fn normalize_reason(reason: &str) -> &str {
    let reason = reason.strip_prefix("FINISH_REASON_").unwrap_or(reason);
    let reason = reason.strip_prefix("PROMPT_").unwrap_or(reason);
    reason.strip_prefix("BLOCK_REASON_").unwrap_or(reason)
}

fn finish_kind(reason: &str) -> FinishKind {
    match normalize_reason(reason) {
        "" | "UNSPECIFIED" => FinishKind::Unfinished,
        "STOP" => FinishKind::Complete,
        "MAX_TOKENS" => FinishKind::OutputLimit,
        "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" | "IMAGE_PROHIBITED_CONTENT"
        | "ESCALATION" | "PUP_LIMITED_DISABLED" => FinishKind::Policy,
        "LANGUAGE" => FinishKind::Language,
        "RECITATION" | "IMAGE_RECITATION" => FinishKind::Recitation,
        "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL" | "MALFORMED_RESPONSE" => FinishKind::InvalidToolCall,
        "TOO_MANY_TOOL_CALLS" | "MISSING_THOUGHT_SIGNATURE" => FinishKind::ToolCallTerminal,
        "CONTINUATION" => FinishKind::Continuation,
        _ => FinishKind::Other,
    }
}

/// `geminiPolicyFinishCode`: the policy-refusal code of a finish (or block) reason, `None` for any other reason.
pub fn policy_finish_code(reason: &str) -> Option<&'static str> {
    match finish_kind(reason) {
        FinishKind::Policy => Some("safety"),
        FinishKind::Recitation => Some("recitation"),
        FinishKind::Language => Some("content_filter"),
        _ => None,
    }
}

fn count(um: &Value, camel: &str, snake: &str) -> Option<u64> {
    let v = um.get(camel).or_else(|| um.get(snake))?;
    v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64))
}

/// `firstFinite` of `_resolveGeminiCacheUsage`: the first of the two spellings that is a positive number, else 0.
fn first_positive(um: &Value, camel: &str, snake: &str) -> u64 {
    [camel, snake]
        .iter()
        .filter_map(|key| um.get(*key).and_then(Value::as_f64))
        .find(|n| n.is_finite() && *n > 0.0)
        .map_or(0, |n| n as u64)
}

/// `_resolveGeminiCacheUsage` (gemini-cache.mjs:245-285) as `normalizeGeminiUsage` reads it: the prompt is
/// `promptTokenCount` plus the tool-use prompt when the field is present (an explicit 0 stays 0), else the total less
/// the output; the cached count is the first of `cachedContentTokenCount` and its `totalCachedTokens` alias that is a
/// number (a 0 is a measured miss), at most the prompt. The attached cache's size (`cachedFallbackTokens`) only feeds
/// Node's cache trace: `normalizeGeminiUsage` (gemini-response.mjs:87-95) books the reported count.
fn gemini_input_and_cache(um: &Value) -> (u64, u64) {
    let explicit = ["promptTokenCount", "prompt_token_count"].iter().any(|key| um.get(*key).is_some());
    let input = if explicit {
        first_positive(um, "promptTokenCount", "prompt_token_count")
            + first_positive(um, "toolUsePromptTokenCount", "tool_use_prompt_token_count")
    } else {
        let output = first_positive(um, "candidatesTokenCount", "candidates_token_count")
            + first_positive(um, "thoughtsTokenCount", "thoughts_token_count");
        first_positive(um, "totalTokenCount", "total_token_count").saturating_sub(output)
    };
    let reported = ["cachedContentTokenCount", "cached_content_token_count", "totalCachedTokens", "total_cached_tokens"]
        .iter()
        .filter_map(|key| um.get(*key).and_then(Value::as_f64))
        .find(|n| n.is_finite() && *n >= 0.0)
        .map_or(0, |n| n as u64);
    (input, clamp(reported, input))
}

pub fn usage_of(um: &Value, style: UsageStyle) -> Usage {
    let prompt = count(um, "promptTokenCount", "prompt_token_count").unwrap_or(0);
    let reported_cache = count(um, "cachedContentTokenCount", "cached_content_token_count").unwrap_or(0);
    let thoughts = count(um, "thoughtsTokenCount", "thoughts_token_count");
    let candidates = count(um, "candidatesTokenCount", "candidates_token_count").unwrap_or(0);
    let (input, cached) = match style {
        UsageStyle::Inclusive => gemini_input_and_cache(um),
        // `toVertexExclusiveUsage` (vertex-ai-maas.mjs:33-45) over the same resolution.
        UsageStyle::CacheExclusive => {
            let (input, cached) = gemini_input_and_cache(um);
            (input.saturating_sub(cached), cached)
        }
        UsageStyle::ToolUseAdded => (
            prompt + count(um, "toolUsePromptTokenCount", "tool_use_prompt_token_count").unwrap_or(0),
            reported_cache,
        ),
    };
    Usage {
        input_tokens: input,
        output_tokens: candidates + thoughts.unwrap_or(0),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        cache_write_1h_tokens: 0,
        reasoning_tokens: thoughts,
        reasoning_incomplete: false,
        raw: Some(um.clone()),
        cost: None,
    }
}

fn clamp(cached: u64, input: u64) -> u64 {
    if input > 0 { cached.min(input) } else { cached }
}

fn truncated(message: &str, exposure: Exposure) -> ProviderError {
    let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    err.exposure = exposure;
    err.message = message.to_owned();
    err
}

fn complete_call(call: &Value) -> bool {
    let named = call.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty());
    let streaming = call.get("willContinue") == Some(&json!(true))
        || call.get("will_continue") == Some(&json!(true))
        || call.get("partialArgs").is_some()
        || call.get("partial_args").is_some();
    let args_ok = match call.get("args") {
        None => true,
        Some(a) => a.is_object(),
    };
    named && !streaming && args_ok
}

pub struct GeminiDecoder {
    dialect: DecodeDialect,
    buf: Vec<u8>,
    parts: Vec<Value>,
    saw_chunk: bool,
    finish: Option<String>,
    usage: Option<Value>,
    sources: Vec<String>,
    citations: Vec<Value>,
    open: Option<ItemKind>,
    calls: usize,
    whole_calls: usize,
    incomplete_call: bool,
    exposure: Exposure,
    done: bool,
    /// The text-leak guard over the answer text (`createGeminiTextLeakGuard`, deferring its calls).
    leak: LeakGuard,
    /// Fingerprints of every call the guard or the native filter let through.
    dispatched: HashSet<String>,
    /// Calls recovered from text (Node's `getLeakedToolCalls()`); with `defer` they are released after a clean finish.
    leaked: Vec<ToolCall>,
    /// The guard holds recovered calls until a clean finish (`deferToolCalls`); off, each is dispatched as it is recovered.
    defer: bool,
    /// Native calls held for the same release, so the turn's list is native first, then leaked.
    native_done: Vec<ToolCall>,
    /// The answer text of the chunk being decoded, when the guard is on.
    chunk_text: String,
    /// The answer text of the whole response (`rawContent`) and what of it was relayed.
    raw: String,
    shown: String,
    /// The model the replay envelope is bound to (`requestContext.model`), when the decoder knows the request.
    model: Option<String>,
    /// `Date.now()` for an in-band error's reset instant.
    clock: std::sync::Arc<dyn Fn() -> std::time::SystemTime + Send + Sync>,
    /// A failure met after other events of the same read: reported by the next call.
    failed: Option<ProviderError>,
    /// A test's view of every call the guard recovered (`getLeakedToolCalls()`), whether or not the turn released it.
    #[cfg(any(test, feature = "test-support"))]
    recovered_view: Option<std::sync::Arc<std::sync::Mutex<Vec<ToolCall>>>>,
}

/// `geminiChunkProgressKind(chunk)`: the one kind a chunk reports for all its parts, `None` for transport only.
pub fn chunk_progress(chunk: &Value) -> Option<ProgressKind> {
    let parts = chunk.pointer("/candidates/0/content/parts").and_then(Value::as_array)?;
    let has_text = |part: &Value| part.get("text").and_then(Value::as_str).is_some_and(|text| !text.is_empty());
    let thought = |part: &Value| part.get("thought") == Some(&Value::Bool(true));
    if parts.iter().any(|part| part.get("functionCall").is_some_and(|call| !call.is_null())) {
        Some(ProgressKind::Tool)
    } else if parts.iter().any(|part| thought(part) && has_text(part)) {
        Some(ProgressKind::Reasoning)
    } else if parts.iter().any(|part| !thought(part) && has_text(part)) {
        Some(ProgressKind::Text)
    } else {
        None
    }
}
impl GeminiDecoder {
    pub fn new(dialect: DecodeDialect) -> Self {
        Self {
            dialect,
            buf: Vec::new(),
            parts: Vec::new(),
            saw_chunk: false,
            finish: None,
            usage: None,
            sources: Vec::new(),
            citations: Vec::new(),
            open: None,
            calls: 0,
            whole_calls: 0,
            incomplete_call: false,
            exposure: Exposure::default(),
            done: false,
            leak: LeakGuard::new(HashSet::new(), false),
            dispatched: HashSet::new(),
            leaked: Vec::new(),
            defer: true,
            native_done: Vec::new(),
            chunk_text: String::new(),
            raw: String::new(),
            shown: String::new(),
            model: None,
            clock: std::sync::Arc::new(std::time::SystemTime::now),
            failed: None,
            #[cfg(any(test, feature = "test-support"))]
            recovered_view: None,
        }
    }

    /// Every call the guard recovers, as `getLeakedToolCalls()` lists them, kept for the test after the stream ends (a
    /// failed stream releases none of them).
    #[cfg(any(test, feature = "test-support"))]
    pub fn recovered_calls(&mut self) -> std::sync::Arc<std::sync::Mutex<Vec<ToolCall>>> {
        self.recovered_view.get_or_insert_with(Default::default).clone()
    }

    /// A replay's virtual wall clock in place of the system's.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_clock(mut self, clock: impl Fn() -> std::time::SystemTime + Send + Sync + 'static) -> Self {
        self.clock = std::sync::Arc::new(clock);
        self
    }

    /// The calls recovered from text and not yet released (what Node's guard returns as `getLeakedToolCalls()`).
    #[cfg(test)]
    pub(super) fn held_leaked_calls(&self) -> &[ToolCall] {
        &self.leaked
    }

    /// Binds the replay envelope to the model that produced it (Node's `requestContext.model`): a later turn replays its
    /// signed parts only to the same model.
    pub fn for_model(mut self, model: &str) -> Self {
        self.model = Some(model.to_owned());
        self
    }

    /// Recover tool calls leaked into the answer text, naming only these tools (the request's).
    pub fn with_known_tools(mut self, names: HashSet<String>) -> Self {
        self.leak = LeakGuard::new(names, false);
        self
    }

    /// `deferToolCalls: false`: a recovered call is dispatched the moment it is recovered, so a failure after it is a
    /// replay boundary (`emittedToolCall`). Every adapter of the product defers.
    pub fn with_deferred_calls(mut self, defer: bool) -> Self {
        self.defer = defer;
        self
    }

    /// What the guard let through and recovered: visible text, then the calls (`tool` each, held for release).
    fn relay_leak(&mut self, (text, calls): (String, Vec<Recovered>), out: &mut Vec<StreamEvent>) {
        if !text.is_empty() {
            self.open_item(ItemKind::Text, out);
            self.exposure.text_emitted = true;
            self.shown.push_str(&text);
            out.push(StreamEvent::TextDelta(text));
        }
        self.recover_calls(calls, out);
    }

    /// A call the guard recovered: held for the release unless an identical one already passed (`tool` reported).
    fn recover_calls(&mut self, calls: Vec<Recovered>, out: &mut Vec<StreamEvent>) {
        for recovered in calls {
            let call = leak::gemini_call(recovered);
            if !self.dispatched.insert(leak::fingerprint(&call.name, &call.arguments)) {
                continue;
            }
            #[cfg(any(test, feature = "test-support"))]
            if let Some(view) = &self.recovered_view {
                view.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(call.clone());
            }
            if !self.defer {
                self.exposure.tool_dispatched = true;
                out.push(StreamEvent::ToolCallDone(call.clone()));
            }
            self.leaked.push(call);
            out.push(StreamEvent::Progress(ProgressKind::Tool));
        }
    }

    /// `filterNativeToolCalls` + the release of the deferred calls after a clean finish.
    fn release_calls(&mut self, out: &mut Vec<StreamEvent>) {
        for call in std::mem::take(&mut self.native_done) {
            if self.dispatched.insert(leak::fingerprint(&call.name, &call.arguments)) {
                out.push(StreamEvent::ToolCallDone(call));
            }
        }
        let leaked = std::mem::take(&mut self.leaked);
        if self.defer {
            out.extend(leaked.into_iter().map(StreamEvent::ToolCallDone));
        }
    }

    fn line(&mut self, raw: &[u8], out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim_end_matches('\r');
        if line.starts_with(':') {
            out.push(StreamEvent::ProviderKeepalive);
            return Ok(());
        }
        let Some(data) = sse_data(line) else {
            return Ok(());
        };
        let payload: Value = serde_json::from_str(data).map_err(|_| {
            let mut err = truncated("malformed stream chunk", self.exposure);
            err.code = Some("malformed_stream".into());
            err
        })?;
        self.chunk(payload, out)
    }

    fn open_item(&mut self, kind: ItemKind, out: &mut Vec<StreamEvent>) {
        if self.open != Some(kind) {
            self.open = Some(kind);
            out.push(StreamEvent::ItemStart { kind, phase: None });
        }
    }

    fn chunk(&mut self, payload: Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let chunk = if self.dialect.envelope {
            match payload.get("response") {
                Some(inner) => inner.clone(),
                None => payload,
            }
        } else {
            payload
        };
        if let Some(mut err) = in_band(&chunk, &self.dialect.errors, (self.clock)()) {
            err.exposure = self.exposure;
            return Err(err);
        }
        self.saw_chunk = true;
        out.push(StreamEvent::ChunkProgress(chunk_progress(&chunk)));
        // A blocked prompt ends the turn as `PROMPT_<blockReason>`; a candidate's own finish reason outranks it.
        if let Some(reason) = chunk.pointer("/promptFeedback/blockReason").and_then(Value::as_str)
            && finish_kind(reason) != FinishKind::Unfinished
        {
            self.finish.get_or_insert_with(|| format!("PROMPT_{reason}"));
        }
        if let Some(um) = chunk.get("usageMetadata").filter(|v| v.is_object()) {
            self.usage = Some(um.clone());
        }
        let Some(candidate) = chunk.pointer("/candidates/0") else {
            return Ok(());
        };
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str)
            && finish_kind(reason) != FinishKind::Unfinished
        {
            self.finish = Some(reason.to_owned());
        }
        self.collect_sources(candidate);
        for part in candidate.pointer("/content/parts").and_then(Value::as_array).into_iter().flatten() {
            self.part(part, out);
        }
        if !self.chunk_text.is_empty() {
            let text = std::mem::take(&mut self.chunk_text);
            let scanned = self.leak.push(&text, false);
            self.relay_leak(scanned, out);
        }
        Ok(())
    }

    fn part(&mut self, part: &Value, out: &mut Vec<StreamEvent>) {
        let stored = match part {
            Value::Object(map) if map.is_empty() => json!({ "text": "" }),
            other => other.clone(),
        };
        self.parts.push(stored);
        if let Some(call) = part.get("functionCall").filter(|c| !c.is_null()) {
            let index = self.calls;
            self.calls += 1;
            if !complete_call(call) {
                self.incomplete_call = true;
                return;
            }
            self.whole_calls += 1;
            let name = call["name"].as_str().unwrap_or_default().to_owned();
            let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|i| !i.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| synthesized_call_id(index, &name, &args));
            self.open_item(ItemKind::Tool, out);
            out.push(StreamEvent::ToolCallStart { id: id.clone(), name: name.clone() });
            out.push(StreamEvent::ToolCallArgsDelta { id: id.clone(), delta: args.to_string() });
            let call = ToolCall { id, name, arguments: args, native_type: None };
            if self.leak.enabled() {
                self.native_done.push(call);
            } else {
                out.push(StreamEvent::ToolCallDone(call));
            }
            self.open = None;
            return;
        }
        let Some(text) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) else {
            return;
        };
        if part.get("thought") == Some(&json!(true)) {
            self.open_item(ItemKind::Reasoning, out);
            out.push(StreamEvent::ReasoningDelta(text.to_owned()));
        } else if self.leak.enabled() {
            // The chunk's answer text goes through the guard as one piece (`geminiChunkText`).
            self.chunk_text.push_str(text);
            self.raw.push_str(text);
        } else {
            self.open_item(ItemKind::Text, out);
            self.exposure.text_emitted = true;
            out.push(StreamEvent::TextDelta(text.to_owned()));
        }
    }

    fn collect_sources(&mut self, candidate: &Value) {
        let grounding = candidate.pointer("/groundingMetadata/groundingChunks").and_then(Value::as_array);
        let citations = candidate.pointer("/citationMetadata/citationSources").and_then(Value::as_array);
        for source in grounding.into_iter().chain(citations).flatten() {
            let web = source.get("web").filter(|w| w.is_object()).unwrap_or(source);
            let pick = |keys: &[&str]| {
                keys.iter()
                    .find_map(|k| web.get(*k).or_else(|| source.get(*k)).and_then(Value::as_str))
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
            };
            let Some(url) = pick(&["uri", "url"]) else {
                continue;
            };
            if self.sources.contains(&url) {
                continue;
            }
            let title = pick(&["title"]).unwrap_or_else(|| url.clone());
            self.citations.push(json!({
                "title": title, "url": url, "snippet": "", "source": "gemini-grounding", "provider": "gemini"
            }));
            self.sources.push(url);
        }
    }

    /// `geminiIncompleteError` (Gemini API, Vertex AI) / Antigravity's `ProviderIncompleteError`: the turn ended on
    /// `reason`.
    fn fail(&self, kind: ErrorKind, code: &str, reason: &str) -> ProviderError {
        let mut err = ProviderError::new(kind, DeliveryState::Accepted);
        err.code = Some(code.to_owned());
        let route = if self.dialect.errors.antigravity_endpoint.is_some() { "Antigravity" } else { "Gemini" };
        err.message = format!("{route} response incomplete: finishReason={reason}");
        err.finish_reason = Some(reason.into());
        err.exposure = self.exposure;
        err
    }

    fn conclude(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut out = Vec::new();
        // `assertGeminiStreamCompleted` names the consumer's label (`gemini-stream.mjs:237`, `:244`).
        let label = self.dialect.errors.label;
        if !self.saw_chunk {
            return Err(truncated(&format!("{label} truncated: empty stream"), self.exposure));
        }
        let kind = self.finish.as_deref().map_or(FinishKind::Unfinished, finish_kind);
        let whole_calls = self.whole_calls > 0 && !self.incomplete_call;
        // A delivered turn carries no stop reason (Node's Gemini results have
        // none); only an output cutoff or an unmapped finish is named.
        let stop = match kind {
            FinishKind::Unfinished if whole_calls => None,
            FinishKind::Unfinished => return Err(truncated(&format!("{label} truncated: no finishReason"), self.exposure)),
            _ if self.incomplete_call => {
                return Err(truncated("stream truncated: unfinished function call", self.exposure));
            }
            FinishKind::Complete => None,
            FinishKind::OutputLimit if whole_calls => None,
            // An output cut that showed text is the truncated answer the session keeps (Node throws
            // `PROVIDER_INCOMPLETE` and `send-with-recovery.mjs` `isPromotableIncomplete` promotes it); with no text
            // there is nothing to keep, and the turn fails.
            FinishKind::OutputLimit if !self.exposure.text_emitted => {
                let reason = self.finish.clone().unwrap_or_default();
                return Err(self.fail(ErrorKind::Unknown, "PROVIDER_INCOMPLETE", &reason));
            }
            FinishKind::OutputLimit => Some(StopReason::MaxTokens),
            FinishKind::Policy | FinishKind::Language | FinishKind::Recitation => {
                let reason = self.finish.clone().unwrap_or_default();
                let code = policy_finish_code(&reason).unwrap_or_default();
                return Err(self.fail(ErrorKind::Policy, code, &reason));
            }
            FinishKind::InvalidToolCall if !self.exposure.text_emitted => {
                let reason = self.finish.clone().unwrap_or_default();
                let code = normalize_reason(&reason).to_lowercase();
                return Err(self.fail(ErrorKind::Transient, &code, &reason));
            }
            FinishKind::ToolCallTerminal => {
                let reason = self.finish.clone().unwrap_or_default();
                let code = normalize_reason(&reason).to_lowercase();
                return Err(self.fail(ErrorKind::InvalidRequest, &code, &reason));
            }
            FinishKind::Continuation => {
                let reason = self.finish.clone().unwrap_or_default();
                return Err(self.fail(ErrorKind::Unknown, "continuation_unsupported", &reason));
            }
            FinishKind::InvalidToolCall | FinishKind::Other => {
                Some(StopReason::Other(self.finish.clone().unwrap_or_default()))
            }
        };
        // The stream ended cleanly: nothing is held back, and the held calls are released.
        let tail = self.leak.flush();
        // The guard's flush forwards its text but reports no progress (`createGeminiTextLeakGuard` calls
        // `onStreamDelta` only for a recovered call): the tail is transport only.
        if !tail.0.is_empty() {
            out.push(StreamEvent::ChunkProgress(None));
        }
        self.relay_leak(tail, &mut out);
        // The returned content is the whole text scanned once more (`scrubAssistantText`); a call only that scan
        // finds is recovered too.
        if self.leak.enabled() {
            let (content, calls) = self.leak.scrub(&self.raw);
            self.recover_calls(calls, &mut out);
            if content != self.shown {
                out.push(StreamEvent::FinalContent(content));
            }
        }
        let recovered = !self.leaked.is_empty();
        self.release_calls(&mut out);
        // A recovered call has no part in the response, so the parts cannot be replayed.
        if recovered {
            self.parts.clear();
        }
        if !self.parts.is_empty() {
            let mut items = json!({ "parts": std::mem::take(&mut self.parts) });
            if let Some(model) = &self.model {
                items["model"] = json!(model);
            }
            out.push(StreamEvent::ReasoningReplay(ProviderReplay { owner: self.dialect.owner.clone(), items }));
        }
        out.extend(self.citations.drain(..).map(StreamEvent::Citation));
        if let Some(um) = &self.usage {
            out.push(StreamEvent::Usage(usage_of(um, self.dialect.usage)));
        }
        out.push(StreamEvent::Completed { stop, pricing_model: None, request_ms: None });
        self.done = true;
        Ok(out)
    }
}

impl WireDecoder for GeminiDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.failed.take() {
            return Err(err);
        }
        self.buf.extend_from_slice(unit);
        let mut out = Vec::new();
        while let Some(end) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=end).collect();
            if let Err(err) = self.line(&line[..line.len() - 1], &mut out) {
                // Node relays every chunk before the failing one of the same read (`relayChunk` per payload): those
                // events go out first, and the failure ends the stream on the next call.
                if out.is_empty() {
                    return Err(err);
                }
                self.failed = Some(err);
                break;
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.failed.take() {
            return Err(err);
        }
        let rest = std::mem::take(&mut self.buf);
        let mut out = Vec::new();
        self.line(&rest, &mut out)?;
        out.extend(self.conclude()?);
        Ok(out)
    }

    fn terminal_seen(&self) -> bool {
        self.done || self.finish.is_some()
    }

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoder(envelope: bool) -> GeminiDecoder {
        GeminiDecoder::new(DecodeDialect {
            owner: ProviderId::from("gemini"),
            envelope,
            usage: UsageStyle::Inclusive,
            errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
        })
    }

    fn run(d: &mut GeminiDecoder, wire: &str) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut events = d.feed(wire.as_bytes())?;
        events.extend(d.finish()?);
        Ok(events)
    }

    #[test]
    fn text_thoughts_usage_and_replay_fold_at_the_end() {
        let wire = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true}]}}]}\n\n",
            ": ping\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi \"}]}}]}\r\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"there\"}]},\"finishReason\":\"STOP\"}],",
            "\"usageMetadata\":{\"promptTokenCount\":20,\"cachedContentTokenCount\":5,",
            "\"candidatesTokenCount\":8,\"thoughtsTokenCount\":3}}\n\n",
            "data: [DONE]\n"
        );
        let events = run(&mut decoder(false), wire).unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None })
            .collect();
        assert_eq!(text, "Hi there");
        assert!(events.contains(&StreamEvent::ReasoningDelta("plan".into())));
        assert!(events.contains(&StreamEvent::ProviderKeepalive));
        let usage = events.iter().find_map(|e| if let StreamEvent::Usage(u) = e { Some(u.clone()) } else { None });
        let usage = usage.unwrap();
        assert_eq!(
            (usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.reasoning_tokens),
            (20, 11, 5, Some(3))
        );
        let Some(StreamEvent::ReasoningReplay(replay)) =
            events.iter().find(|e| matches!(e, StreamEvent::ReasoningReplay(_)))
        else {
            panic!("no replay");
        };
        assert_eq!(replay.items["parts"].as_array().unwrap().len(), 3);
        assert_eq!(events.last(), Some(&StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }));
    }

    #[test]
    fn whole_function_calls_without_finish_reason_are_a_tool_use_turn() {
        let wire = "data: {\"candidates\":[{\"content\":{\"parts\":[\
            {\"functionCall\":{\"name\":\"lookup\",\"args\":{\"key\":\"answer\"}}},\
            {\"functionCall\":{\"name\":\"lookup\",\"args\":{},\"id\":\"srv-1\"}}]}}]}\n\n";
        let events = run(&mut decoder(false), wire).unwrap();
        let calls: Vec<&ToolCall> =
            events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(c) } else { None }).collect();
        assert_eq!(calls[0].id, "gemini_366b187da650ce24");
        assert_eq!(calls[1].id, "srv-1");
        assert_eq!(events.last(), Some(&StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }));
    }

    #[test]
    fn antigravity_envelope_unwraps() {
        let wire = "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\
            \"finishReason\":\"STOP\"}]},\"traceId\":\"t\"}\n\n";
        let events = run(&mut decoder(true), wire).unwrap();
        assert!(events.contains(&StreamEvent::TextDelta("ok".into())));
    }

    #[test]
    fn truncation_policy_and_in_band_errors_are_typed() {
        let partial = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"The result \"}]}}]}\n\n";
        let mut d = decoder(false);
        let err = run(&mut d, partial).unwrap_err();
        assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
        assert!(err.exposure.text_emitted && !d.terminal_seen());
        let empty = run(&mut decoder(false), "").unwrap_err();
        assert_eq!(empty.transport, Some(TransportFault::TruncatedStream));
        let safety = "data: {\"candidates\":[{\"finishReason\":\"SAFETY\"}]}\n\n";
        assert_eq!(run(&mut decoder(false), safety).unwrap_err().kind, ErrorKind::Policy);
        let malformed = "data: {\"candidates\":[{\"finishReason\":\"MALFORMED_FUNCTION_CALL\"}]}\n\n";
        let err = run(&mut decoder(false), malformed).unwrap_err();
        assert_eq!((err.kind, err.code.as_deref()), (ErrorKind::Transient, Some("malformed_function_call")));
        let band = "data: {\"error\":{\"code\":503,\"status\":\"UNAVAILABLE\",\"message\":\"x\"}}\n\n";
        assert_eq!(run(&mut decoder(false), band).unwrap_err().status, Some(503));
        let max = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"cut\"}]},\"finishReason\":\"MAX_TOKENS\"}]}\n";
        let events = run(&mut decoder(false), max).unwrap();
        assert_eq!(events.last(), Some(&StreamEvent::Completed { stop: Some(StopReason::MaxTokens), pricing_model: None, request_ms: None }));
    }
}
