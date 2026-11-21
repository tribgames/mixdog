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
        "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" | "IMAGE_PROHIBITED_CONTENT" | "ESCALATION" | "PUP_LIMITED_DISABLED" => {
            FinishKind::Policy
        }
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

const PROMPT: &[&str] = &["promptTokenCount", "prompt_token_count"];
const TOOL_PROMPT: &[&str] = &["toolUsePromptTokenCount", "tool_use_prompt_token_count"];
const CANDIDATES: &[&str] = &["candidatesTokenCount", "candidates_token_count"];
const THOUGHTS: &[&str] = &["thoughtsTokenCount", "thoughts_token_count"];
const TOTAL: &[&str] = &["totalTokenCount", "total_token_count"];
const GATEWAY_CACHE: &[&str] = &["cachedContentTokenCount", "cached_content_token_count"];
const GEMINI_CACHE: &[&str] = &["cachedContentTokenCount", "cached_content_token_count", "totalCachedTokens", "total_cached_tokens"];

fn token_count(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64))
}

fn count(um: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| um.get(*key).and_then(token_count))
}

/// Each count is a cumulative snapshot, not a delta. Drop older spellings of an updated field so a later
/// explicit zero under a different alias wins; a missing or null count does not replace an observation.
fn merge_usage(current: &mut Option<Value>, next: &serde_json::Map<String, Value>, style: UsageStyle) {
    let cache = if style == UsageStyle::ToolUseAdded { GATEWAY_CACHE } else { GEMINI_CACHE };
    let families = [PROMPT, TOOL_PROMPT, CANDIDATES, THOUGHTS, TOTAL, cache];
    let current = current.get_or_insert_with(|| Value::Object(serde_json::Map::new())).as_object_mut().expect("usage is an object");
    // A null count is shown only while the latest snapshot states it (Node's `raw` is the latest snapshot).
    current.retain(|key, value| token_count(value).is_some() || !families.iter().any(|family| family.contains(&key.as_str())));
    for family in families {
        if family.iter().any(|key| next.get(*key).and_then(token_count).is_some()) {
            for key in family {
                current.shift_remove(*key);
            }
        }
    }
    // A null or missing count is still the snapshot's own field (Node's `raw` shows it) when no observation of its family is
    // kept from an earlier snapshot.
    let kept: Vec<bool> = families.iter().map(|family| family.iter().any(|key| current.get(*key).and_then(token_count).is_some())).collect();
    for (key, value) in next {
        let family = families.iter().position(|family| family.contains(&key.as_str()));
        if token_count(value).is_some() || family.is_none_or(|at| !kept[at]) {
            current.insert(key.clone(), value.clone());
        }
    }
}

fn gemini_input_and_cache(um: &Value) -> (u64, u64) {
    let input = if let Some(prompt) = count(um, PROMPT) {
        prompt.saturating_add(count(um, TOOL_PROMPT).unwrap_or(0))
    } else {
        let output = count(um, CANDIDATES).unwrap_or(0).saturating_add(count(um, THOUGHTS).unwrap_or(0));
        count(um, TOTAL).unwrap_or(0).saturating_sub(output)
    };
    let reported = count(um, GEMINI_CACHE).unwrap_or(0);
    (input, clamp(reported, input))
}

pub fn usage_of(um: &Value, style: UsageStyle) -> Usage {
    let prompt = count(um, PROMPT).unwrap_or(0);
    let reported_cache = count(um, GATEWAY_CACHE).unwrap_or(0);
    let thoughts = count(um, THOUGHTS);
    let candidates = count(um, CANDIDATES).unwrap_or(0);
    let (input, cached) = match style {
        UsageStyle::Inclusive => gemini_input_and_cache(um),
        // `toVertexExclusiveUsage` (vertex-ai-maas.mjs:33-45) over the same resolution.
        UsageStyle::CacheExclusive => {
            let (input, cached) = gemini_input_and_cache(um);
            (input.saturating_sub(cached), cached)
        }
        UsageStyle::ToolUseAdded => (prompt.saturating_add(count(um, TOOL_PROMPT).unwrap_or(0)), reported_cache),
    };
    Usage {
        input_tokens: input,
        output_tokens: candidates.saturating_add(thoughts.unwrap_or(0)),
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

/// `/\bno longer (?:available|supported)\b/i`.
fn says_retired(text: &str) -> bool {
    let lower = text.to_lowercase();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    ["no longer available", "no longer supported"].iter().any(|phrase| {
        lower
            .match_indices(phrase)
            .any(|(at, _)| !lower[..at].chars().next_back().is_some_and(word) && !lower[at + phrase.len()..].chars().next().is_some_and(word))
    })
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

/// How a continued hop's answer was asked for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HopAsk {
    /// Streamed, with asks left: an unusable answer is asked again.
    Open,
    /// Streamed, the asks spent: an unusable answer fails the turn.
    Spent,
    /// The non-streaming re-issue: never asked again, judged by the merged turn's finish alone.
    Reissued,
}

/// The lengths of the gathered answer text, the relayed text and the dispatched calls when a hop began.
#[derive(Clone, Copy, Default)]
struct HopMark {
    raw: usize,
    shown: usize,
    dispatched: usize,
}

/// Cloned at the start of a long-decode hop, so a retried hop decodes its new answer from where the hop began.
#[derive(Clone)]
pub struct GeminiDecoder {
    dialect: DecodeDialect,
    buf: Vec<u8>,
    parts: Vec<Value>,
    saw_chunk: bool,
    finish: Option<String>,
    /// The token a `CONTINUATION` candidate carried: the long decode's next request resends the body with it.
    continuation: Option<String>,
    /// The usage of each finished long-decode hop; every hop is billed, so the turn's counts are their sum.
    hop_usage: Vec<Value>,
    /// Finished long-decode hops before the stream being read.
    hops: u32,
    /// The usage of discarded attempts of continued hops that no ledger booked apart: billed, so counted in the turn's
    /// sum. Kept across every rollback of a hop.
    discarded: Vec<Value>,
    /// Where the hop being read began in the gathered text and calls.
    hop_mark: HopMark,
    /// A continued hop's own answer is judged before the hops merge (`geminiInvalidStreamReask`); `Some(after_tool_result)`
    /// once the stream asks for it.
    judge_hops: Option<bool>,
    /// How the hop being read is asked.
    hop_ask: HopAsk,
    /// The last conclusion failed on the hop's own answer, not on the merged turn.
    hop_invalid: bool,
    usage: Option<Value>,
    usage_updated: bool,
    sources: Vec<String>,
    citations: Vec<Value>,
    open: Option<ItemKind>,
    calls: usize,
    whole_calls: usize,
    incomplete_call: bool,
    /// The whole calls and the unfinished one of the hop being read (`assertGeminiStreamCompleted` reads one hop's parts).
    hop_whole_calls: usize,
    hop_incomplete_call: bool,
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
            continuation: None,
            hop_usage: Vec::new(),
            hops: 0,
            discarded: Vec::new(),
            hop_mark: HopMark::default(),
            judge_hops: None,
            hop_ask: HopAsk::Open,
            hop_invalid: false,
            usage: None,
            usage_updated: false,
            sources: Vec::new(),
            citations: Vec::new(),
            open: None,
            calls: 0,
            whole_calls: 0,
            incomplete_call: false,
            hop_whole_calls: 0,
            hop_incomplete_call: false,
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
        // The guard filters the natives against what it recovered (`filterNativeToolCalls`); `emitGeminiToolCalls` emits
        // each id once.
        let mut emitted = HashSet::new();
        for call in std::mem::take(&mut self.native_done) {
            let passed = !self.leak.enabled() || self.dispatched.insert(leak::fingerprint(&call.name, &call.arguments));
            if passed && emitted.insert(call.id.clone()) {
                out.push(StreamEvent::ToolCallDone(call));
            }
        }
        let leaked = std::mem::take(&mut self.leaked);
        if self.defer {
            out.extend(leaked.into_iter().map(StreamEvent::ToolCallDone));
        }
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn chunk(&mut self, payload: Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let chunk = if self.dialect.envelope {
            match payload.get("response") {
                Some(inner) => inner.clone(),
                None => payload,
            }
        } else {
            payload
        };
        if let Some(um) = chunk.get("usageMetadata").and_then(Value::as_object) {
            merge_usage(&mut self.usage, um, self.dialect.usage);
            self.usage_updated = true;
        }
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
        let Some(candidate) = chunk.pointer("/candidates/0") else {
            return Ok(());
        };
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str)
            && finish_kind(reason) != FinishKind::Unfinished
        {
            self.finish = Some(reason.to_owned());
        }
        if let Some(token) = candidate.get("continuationToken").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            self.continuation = Some(token.to_owned());
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
                self.hop_incomplete_call = true;
                return;
            }
            self.whole_calls += 1;
            self.hop_whole_calls += 1;
            let name = call["name"].as_str().unwrap_or_default().to_owned();
            let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
            let id =
                call.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()).map(str::to_owned).unwrap_or_else(|| synthesized_call_id(index, &name, &args));
            self.open_item(ItemKind::Tool, out);
            out.push(StreamEvent::ToolCallStart { id: id.clone(), name: name.clone() });
            out.push(StreamEvent::ToolCallArgsDelta { id: id.clone(), delta: args.to_string() });
            // Native calls are emitted only once the turn finished cleanly (`emitGeminiToolCalls` after
            // `geminiIncompleteError`), whether or not the guard runs.
            self.native_done.push(ToolCall { id, name, arguments: args, native_type: None });
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
            self.raw.push_str(text);
            out.push(StreamEvent::TextDelta(text.to_owned()));
        }
    }

    fn collect_sources(&mut self, candidate: &Value) {
        let grounding = candidate.pointer("/groundingMetadata/groundingChunks").and_then(Value::as_array);
        let citations = candidate.pointer("/citationMetadata/citationSources").and_then(Value::as_array);
        for source in grounding.into_iter().chain(citations).flatten() {
            let web = source.get("web").filter(|w| w.is_object()).unwrap_or(source);
            let pick = |keys: &[&str]| {
                keys.iter().find_map(|k| web.get(*k).or_else(|| source.get(*k)).and_then(Value::as_str)).map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
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

    fn retired_model(&self) -> Option<ProviderError> {
        self.dialect.errors.antigravity_endpoint.as_ref()?;
        let text = self.raw.trim();
        if !says_retired(text) {
            return None;
        }
        let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
        err.code = Some("MODEL_RETIRED".into());
        err.status = Some(404);
        err.unsafe_to_retry = true;
        err.should_retry = Some(false);
        err.recovery_terminal = true;
        err.message = format!("Antigravity retired {}: {text}", self.model.as_deref().unwrap_or_default());
        err.exposure = self.exposure;
        Some(err)
    }

    /// `geminiInvalidStreamReason` over the hop being read alone: its calls, its recovered calls, its relayed text and its
    /// answer text. A hop that carried a call or relayed text is usable; else an invalid tool call is unusable, and so is an
    /// empty `STOP` unless it answers a tool result.
    fn hop_unusable(&self, kind: FinishKind, after_tool_result: bool) -> Option<String> {
        let mark = self.hop_mark;
        let relayed = if self.leak.enabled() { self.shown.len() > mark.shown } else { self.raw.len() > mark.raw };
        if self.hop_whole_calls > 0 || self.hop_incomplete_call || self.dispatched.len() > mark.dispatched || relayed {
            return None;
        }
        match kind {
            FinishKind::InvalidToolCall => self.finish.as_deref().map(|reason| normalize_reason(reason).to_owned()),
            FinishKind::Complete if !after_tool_result => {
                let invisible = |c: char| matches!(c, '\u{200B}'..='\u{200D}' | '\u{FEFF}' | '\u{200E}' | '\u{200F}');
                let text: String = self.raw[mark.raw..].chars().filter(|c| !invisible(*c)).collect();
                text.trim().is_empty().then(|| "NO_RESPONSE_TEXT".to_owned())
            }
            _ => None,
        }
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn conclude(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut out = Vec::new();
        // `assertGeminiStreamCompleted` names the consumer's label (`gemini-stream.mjs:237`, `:244`).
        let label = self.dialect.errors.label;
        if !self.saw_chunk {
            return Err(truncated(&format!("{label} truncated: empty stream"), self.exposure));
        }
        let kind = self.finish.as_deref().map_or(FinishKind::Unfinished, finish_kind);
        // Every call is collected before the finish decides: the guard's held tail and the whole-text scan can still
        // recover a call spelled across chunks, and a failed candidate must release none of them.
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
        if let Some(err) = self.judge_hop(kind) {
            return Err(err);
        }
        let stop = self.stop_reason(kind)?;
        self.deliver(stop, &mut out);
        Ok(out)
    }

    fn judge_hop(&mut self, kind: FinishKind) -> Option<ProviderError> {
        if self.hops > 0
            && self.hop_ask != HopAsk::Reissued
            && let Some(after_tool_result) = self.judge_hops
            && let Some(reason) = self.hop_unusable(kind, after_tool_result)
        {
            self.hop_invalid = true;
            let empty = reason == "NO_RESPONSE_TEXT";
            let spent = self.hop_ask == HopAsk::Spent;
            let mut err = if spent && !empty {
                // `geminiIncompleteError` over the merged turn: the hop's finish ends it.
                self.incomplete()
            } else {
                let mut err = self.fail(ErrorKind::Transient, &reason.to_lowercase(), &reason);
                err.message = format!("Gemini stream unusable: {reason}");
                err.finish_reason = self.finish.as_deref().map(Into::into);
                err
            };
            if spent {
                err.recovery_exhausted = true;
                err.recovery_terminal |= empty;
            }
            return Some(err);
        }
        None
    }

    fn stop_reason(&self, kind: FinishKind) -> Result<Option<StopReason>, ProviderError> {
        let label = self.dialect.errors.label;
        let whole_calls = self.whole_calls > 0 && !self.incomplete_call;
        let holds_calls = whole_calls || !self.leaked.is_empty();
        Ok(match kind {
            // A stream that ends without a finish but carried whole calls of its own, none unfinished, is a delivered turn,
            // whichever hop it is; a hop with no calls of its own is truncated, whatever calls an earlier hop gathered.
            FinishKind::Unfinished if self.hop_whole_calls > 0 && !self.hop_incomplete_call => None,
            FinishKind::Unfinished => {
                return Err(self.retired_model().unwrap_or_else(|| truncated(&format!("{label} truncated: no finishReason"), self.exposure)));
            }
            _ if self.incomplete_call => {
                return Err(truncated("stream truncated: unfinished function call", self.exposure));
            }
            FinishKind::Complete => None,
            // A failed candidate's calls are never dispatched: Node's `geminiIncompleteError` runs before
            // `emitGeminiToolCalls`, so a cut-off turn that carries whole calls still fails.
            FinishKind::OutputLimit if holds_calls => {
                let reason = self.finish.clone().unwrap_or_default();
                return Err(self.fail(ErrorKind::Unknown, "PROVIDER_INCOMPLETE", &reason));
            }
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
            // Whether the answer is asked again: text it showed prevents that (`geminiInvalidStreamReason`), so only a
            // malformed answer with none is the re-askable invalid stream.
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
            // Whether a final finish is acceptable: `geminiIncompleteError` accepts only `STOP`, and the session promotes
            // only an output cut that showed text (`isPromotableIncomplete`). A malformed or unmapped finish fails the
            // turn, with or without text, on any hop.
            FinishKind::InvalidToolCall | FinishKind::Other => {
                let reason = self.finish.clone().unwrap_or_default();
                let mut err = self.fail(ErrorKind::Unknown, "PROVIDER_INCOMPLETE", &reason);
                // A malformed non-streaming answer relayed nothing, so it is an invalid stream whose asks the loop must
                // not multiply (`markProviderRecoveryExhausted`).
                err.recovery_exhausted = kind == FinishKind::InvalidToolCall && self.hop_ask == HopAsk::Reissued;
                return Err(err);
            }
        })
    }

    fn deliver(&mut self, stop: Option<StopReason>, out: &mut Vec<StreamEvent>) {
        let recovered = !self.leaked.is_empty();
        self.release_calls(out);
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
        if let Some(um) = &self.usage_total() {
            out.push(StreamEvent::Usage(usage_of(um, self.dialect.usage)));
        }
        out.push(StreamEvent::Completed { stop, pricing_model: None, request_ms: None });
        self.done = true;
    }
}

impl GeminiDecoder {
    pub(super) fn take_usage_update(&mut self) -> Option<(Usage, Option<String>)> {
        if std::mem::take(&mut self.usage_updated) { self.usage_now() } else { None }
    }

    /// The turn's usage: the sum of every finished hop and the one in flight (`sumGeminiHopUsage`).
    fn usage_total(&self) -> Option<Value> {
        if self.hop_usage.is_empty() && self.discarded.is_empty() {
            return self.usage.clone();
        }
        let metas: Vec<&Value> = self.hop_usage.iter().chain(&self.discarded).chain(self.usage.as_ref()).collect();
        let mut summed = metas.last().and_then(|meta| meta.as_object()).cloned().unwrap_or_default();
        for family in [PROMPT, TOOL_PROMPT, CANDIDATES, THOUGHTS, TOTAL, GEMINI_CACHE] {
            if metas.iter().any(|meta| count(meta, family).is_some()) {
                let total = metas.iter().map(|meta| count(meta, family).unwrap_or(0)).fold(0u64, u64::saturating_add);
                for key in family {
                    summed.shift_remove(*key);
                }
                summed.insert(family[0].to_owned(), json!(total));
            }
        }
        // The context holds the first hop's prompt plus what was generated, which the summed prompt overstates: the
        // first hop's prompt and cache counts ride the usage as Node's `initialPromptTokenCount` (`sumGeminiHopUsage`).
        let first = metas[0];
        summed.insert("initialPromptTokenCount".to_owned(), json!(count(first, PROMPT).unwrap_or(0)));
        summed.insert("initialCachedContentTokenCount".to_owned(), json!(count(first, GEMINI_CACHE).unwrap_or(0)));
        Some(Value::Object(summed))
    }

    /// The body ended: a `CONTINUATION` finish that carried a token is a long-decode hop, not the turn's end. The hop's usage
    /// is folded in and its token returned for the next request; the decoder keeps the text, calls and parts it gathered.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value")]
    pub(super) fn end_hop(&mut self) -> Result<(Vec<StreamEvent>, Option<String>), ProviderError> {
        if let Some(err) = self.failed.take() {
            return Err(err);
        }
        let rest = std::mem::take(&mut self.buf);
        let mut out = Vec::new();
        if let Err(mut err) = self.line(&rest, &mut out) {
            self.stamp_failure(&mut err);
            return Err(err);
        }
        Ok((out, self.fold_hop()))
    }

    /// A finished hop that ended `CONTINUATION` with a token: folded in, its token returned.
    fn fold_hop(&mut self) -> Option<String> {
        let continues = self.finish.as_deref().map(finish_kind) == Some(FinishKind::Continuation);
        let token = if continues { self.continuation.take() } else { None };
        if token.is_some() {
            self.finish = None;
            self.hops += 1;
            // The next hop must show its own chunks: an empty one is an empty stream, not a continuation of this one.
            self.saw_chunk = false;
            self.hop_whole_calls = 0;
            self.hop_incomplete_call = false;
            self.hop_ask = HopAsk::Open;
            self.hop_invalid = false;
            self.hop_mark = HopMark { raw: self.raw.len(), shown: self.shown.len(), dispatched: self.dispatched.len() };
            self.hop_usage.extend(self.usage.take());
        }
        token
    }

    /// Judge each continued hop's own answer, `after_tool_result` when the request answers a tool result.
    pub(super) fn judge_hops(&mut self, after_tool_result: bool) {
        self.judge_hops = Some(after_tool_result);
    }

    /// The hop's streamed asks are spent: an unusable answer fails the turn.
    pub(super) fn last_ask(&mut self) {
        self.hop_ask = HopAsk::Spent;
    }

    /// The turn's usage as the decoder now holds it, the pending update consumed: after a rollback it can be less than
    /// what was last observed, or none.
    pub(super) fn settle_usage(&mut self) -> Option<(Usage, Option<String>)> {
        self.usage_updated = false;
        self.usage_now()
    }

    /// `geminiIncompleteError` of the finish the hop being read ended on.
    pub(super) fn incomplete(&self) -> ProviderError {
        let reason = self.finish.clone().unwrap_or_default();
        self.fail(ErrorKind::Unknown, "PROVIDER_INCOMPLETE", &reason)
    }

    /// The last conclusion refused the hop's own answer.
    pub(super) fn hop_invalid(&self) -> bool {
        self.hop_invalid
    }

    /// A failed attempt of a continued hop: decoding starts over from `start`, the decoder as the hop began. What the
    /// attempt reported was billed: `book` books it apart (`noteAbandonedUsage`), and what it does not take is carried in
    /// the turn's sum, across every later rollback.
    pub(super) fn restart_hop(&mut self, start: &GeminiDecoder, book: impl FnOnce(Usage, Option<String>) -> bool) {
        let billed = self.usage.take();
        let mut discarded = std::mem::take(&mut self.discarded);
        if let Some(um) = billed
            && !book(usage_of(&um, self.dialect.usage), self.model.clone())
        {
            discarded.push(um);
        }
        *self = start.clone();
        self.discarded = discarded;
        self.usage_updated = true;
    }

    /// The turn's usage so far, every finished hop included, with the model it is booked to.
    pub(super) fn usage_now(&self) -> Option<(Usage, Option<String>)> {
        self.usage_total().map(|um| (usage_of(&um, self.dialect.usage), self.model.clone()))
    }

    /// A failure that did not come from the decoder still carries the usage every finished hop reported.
    pub(super) fn carry_usage(&self, err: &mut ProviderError) {
        if err.partial_usage.is_none()
            && let Some((usage, model)) = self.usage_now()
        {
            err.partial_usage = Some(Box::new(usage));
            err.partial_model = model.as_deref().map(Into::into);
        }
    }

    /// One unary answer of a long decode: its token when it ended `CONTINUATION` (the answer is not concluded), else the
    /// turn's events.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value")]
    pub(super) fn unary_hop(&mut self, payload: Value) -> Result<(Vec<StreamEvent>, Option<String>), ProviderError> {
        self.hop_ask = HopAsk::Reissued;
        let mut out = Vec::new();
        self.chunk(payload, &mut out).map_err(|mut err| {
            self.stamp_failure(&mut err);
            err
        })?;
        if let Some(token) = self.fold_hop() {
            return Ok((out, Some(token)));
        }
        let end = self.conclude().map_err(|mut err| {
            self.stamp_failure(&mut err);
            err
        })?;
        out.extend(end);
        Ok((out, None))
    }

    pub(super) fn stamp_failure(&self, err: &mut ProviderError) {
        err.exposure.tool_input_cut |= self.incomplete_call;
        if self.finish.as_deref().and_then(policy_finish_code).is_some() {
            err.recovery_terminal = true;
        }
        self.carry_usage(err);
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value")]
    pub(super) fn unary(&mut self, payload: Value) -> Result<Vec<StreamEvent>, ProviderError> {
        self.hop_ask = HopAsk::Reissued;
        let mut out = Vec::new();
        let end = self.chunk(payload, &mut out).and_then(|()| self.conclude()).map_err(|mut err| {
            self.stamp_failure(&mut err);
            err
        })?;
        out.extend(end);
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
            if let Err(mut err) = self.line(&line[..line.len() - 1], &mut out) {
                // Node relays every chunk before the failing one of the same read (`relayChunk` per payload): those
                // events go out first, and the failure ends the stream on the next call.
                self.stamp_failure(&mut err);
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
        let end = self.line(&rest, &mut out).and_then(|()| self.conclude()).map_err(|mut err| {
            self.stamp_failure(&mut err);
            err
        })?;
        out.extend(end);
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

    fn antigravity_decoder() -> GeminiDecoder {
        GeminiDecoder::new(DecodeDialect {
            owner: ProviderId::from("antigravity"),
            envelope: true,
            usage: UsageStyle::Inclusive,
            errors: ErrorDialect::antigravity("https://cloudcode-pa.googleapis.com"),
        })
    }

    /// A stream the gateway ends on a plain-text notice about the model, with no `finishReason`
    /// (`retiredModelError`): on Antigravity alone, a terminal 404 that is never resent; anything else is the truncation.
    #[test]
    fn a_retirement_notice_without_a_finish_reason_is_a_terminal_404_on_antigravity_only() {
        let chunk = |text: &str| format!("data: {{\"response\":{{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"{text}\"}}]}}}}]}}}}\n\n");
        for notice in [("Model X is no lon", "ger available."), ("This model is NO LONGER ", "Supported, pick another")] {
            let err = run(&mut antigravity_decoder(), &(chunk(notice.0) + &chunk(notice.1))).unwrap_err();
            assert_eq!(
                (err.code.as_deref(), err.status, err.recovery_terminal, err.unsafe_to_retry),
                (Some("MODEL_RETIRED"), Some(404), true, true),
                "{notice:?}"
            );
            assert_eq!(err.transport, None, "a verdict about the model, not a cut stream");
        }
        let cut = run(&mut antigravity_decoder(), &chunk("The answer so far")).unwrap_err();
        assert_eq!((cut.transport.clone(), cut.status), (Some(TransportFault::TruncatedStream), None));
        let unrelated = run(&mut antigravity_decoder(), &chunk("a longer-available option")).unwrap_err();
        assert_eq!(unrelated.transport, Some(TransportFault::TruncatedStream));
        let answered = format!(
            "data: {{\"response\":{{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"The old API is no longer supported.\"}}]}},\"finishReason\":\"STOP\"}}]}}}}\n\n"
        );
        assert!(run(&mut antigravity_decoder(), &answered).is_ok(), "a finished answer that mentions it is an answer");
        let gemini = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"it is no longer available\"}]}}]}\n\n";
        assert_eq!(run(&mut decoder(false), gemini).unwrap_err().transport, Some(TransportFault::TruncatedStream));
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
        let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(text, "Hi there");
        assert!(events.contains(&StreamEvent::ReasoningDelta("plan".into())));
        assert!(events.contains(&StreamEvent::ProviderKeepalive));
        let usage = events.iter().find_map(|e| if let StreamEvent::Usage(u) = e { Some(u.clone()) } else { None });
        let usage = usage.unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.reasoning_tokens), (20, 11, 5, Some(3)));
        let Some(StreamEvent::ReasoningReplay(replay)) = events.iter().find(|e| matches!(e, StreamEvent::ReasoningReplay(_))) else {
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
        let calls: Vec<&ToolCall> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(c) } else { None }).collect();
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

    /// `geminiIncompleteError` runs before `emitGeminiToolCalls`: a candidate that ends MAX_TOKENS or OTHER after a whole call
    /// is a failed turn and releases no call.
    #[test]
    fn a_failed_candidate_releases_none_of_its_whole_calls() {
        for reason in ["MAX_TOKENS", "OTHER"] {
            let body = format!(
                "data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"x\"}},{{\"functionCall\":{{\"name\":\"f\",\"args\":{{}}}}}}]}},\"finishReason\":\"{reason}\"}}]}}\n\n"
            );
            let mut decoder = decoder(false).with_known_tools(["f".to_owned()].into());
            let events = decoder.feed(body.as_bytes()).unwrap();
            assert!(!events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(_))), "{reason}");
            let err = decoder.finish().unwrap_err();
            assert_eq!(err.code.as_deref(), Some("PROVIDER_INCOMPLETE"), "{reason}");
        }
    }

    /// A call written as text across chunks is recovered by the guard, and a candidate that then ends MAX_TOKENS or OTHER
    /// releases it no more than a native call.
    #[test]
    fn a_call_recovered_from_text_is_not_released_by_a_failed_candidate() {
        for reason in ["MAX_TOKENS", "OTHER", "MALFORMED_FUNCTION_CALL"] {
            let chunk = |text: &str, finish: &str| {
                let finish = if finish.is_empty() { String::new() } else { format!(",\"finishReason\":\"{finish}\"") };
                format!("data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":{}}}]}}{finish}}}]}}\n\n", serde_json::json!(text))
            };
            let mut decoder = decoder(false).with_known_tools(["f".to_owned()].into());
            let body = chunk("sure <invoke name=\"f\"><param", "") + &chunk("eter name=\"a\">1</parameter></invoke>", reason);
            let mut events = decoder.feed(body.as_bytes()).unwrap();
            let end = decoder.finish();
            assert!(end.is_err(), "{reason}");
            events.extend(end.err().map(|_| Vec::new()).unwrap_or_default());
            assert!(!events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(_))), "{reason}");
        }
    }

    /// A long decode's later hop is judged by its own stream: an empty hop, or one that ends with no finish reason, is a
    /// truncation, never the first hop's whole call released as if it were the finished turn.
    #[test]
    fn a_later_hop_is_finished_by_its_own_stream() {
        let first = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"f\",\"args\":{}}}]},\"finishReason\":\"CONTINUATION\",\"continuationToken\":\"t\"}]}\n\n";
        let silent = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"x\"}]}}]}\n\n";
        for second in ["", silent] {
            let mut decoder = decoder(false).with_known_tools(["f".to_owned()].into());
            decoder.feed(first.as_bytes()).unwrap();
            let (_, token) = decoder.end_hop().unwrap();
            assert_eq!(token.as_deref(), Some("t"));
            decoder.feed(second.as_bytes()).unwrap();
            let err = decoder.finish().unwrap_err();
            assert!(err.message.contains("truncated"), "{}", err.message);
        }
    }

    /// Text the answer showed keeps it from being asked again, but does not make its finish acceptable: a single-hop turn
    /// that showed text and ended malformed or on an unmapped finish fails `PROVIDER_INCOMPLETE` (`geminiIncompleteError`).
    #[test]
    fn a_malformed_or_unmapped_finish_after_text_fails_the_turn() {
        for reason in ["MALFORMED_FUNCTION_CALL", "OTHER"] {
            let body = format!("data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"shown\"}}]}},\"finishReason\":\"{reason}\"}}]}}\n\n");
            let err = run(&mut decoder(false), &body).unwrap_err();
            assert_eq!((err.kind, err.code.as_deref()), (ErrorKind::Unknown, Some("PROVIDER_INCOMPLETE")), "{reason}");
            assert!(err.exposure.text_emitted, "{reason}");
        }
    }

    /// `assertGeminiStreamCompleted` judges each hop by its own parts: a later hop that carried whole calls of its own and no
    /// finish reason is a delivered tool-use turn, whatever the first hop carried.
    #[test]
    fn a_later_hop_with_whole_calls_of_its_own_needs_no_finish_reason() {
        let first =
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"looking \"}]},\"finishReason\":\"CONTINUATION\",\"continuationToken\":\"t\"}]}\n\n";
        let second = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"f\",\"args\":{\"a\":1}}}]}}]}\n\n";
        let mut decoder = decoder(false);
        decoder.feed(first.as_bytes()).unwrap();
        assert_eq!(decoder.end_hop().unwrap().1.as_deref(), Some("t"));
        let mut events = decoder.feed(second.as_bytes()).unwrap();
        events.extend(decoder.finish().expect("a delivered tool-use hop"));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(call) if call.name == "f")));
        assert_eq!(events.last(), Some(&StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }));
    }

    /// Hops are billed in sum while the first hop's prompt and cache counts stay as the context figures.
    #[test]
    fn the_summed_usage_keeps_the_first_hops_context_figures() {
        let hop = |prompt: u64, cached: u64, finish: &str| {
            format!(
                "data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"x\"}}]}},\"finishReason\":\"{finish}\",\"continuationToken\":\"t\"}}],\"usageMetadata\":{{\"promptTokenCount\":{prompt},\"cachedContentTokenCount\":{cached},\"candidatesTokenCount\":2}}}}\n\n"
            )
        };
        let mut decoder = decoder(false);
        decoder.feed(hop(100, 40, "CONTINUATION").as_bytes()).unwrap();
        assert!(decoder.end_hop().unwrap().1.is_some());
        decoder.feed(hop(130, 40, "STOP").as_bytes()).unwrap();
        let events = decoder.finish().unwrap();
        let usage = events.iter().find_map(|e| if let StreamEvent::Usage(u) = e { Some(u.clone()) } else { None }).unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (230, 4));
        let raw = usage.raw.unwrap();
        assert_eq!((raw["initialPromptTokenCount"].clone(), raw["initialCachedContentTokenCount"].clone()), (json!(100), json!(40)));
    }
}
