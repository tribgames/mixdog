//! SSE framing and the Messages stream state machine. The terminal predicate
//! is `message_stop` (or the early `tool_use` stop with every tool input
//! complete); a body that ends without it is `TruncatedStream`.

use std::collections::BTreeMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::errors::classify_stream_error;
use super::replay_blocks;
use crate::providers::leak;
use crate::providers::leak::Dedupe;
use crate::providers::leak::LeakGuard;
use crate::providers::leak::Recovered;

pub(super) const NATIVE_CALL_TYPES: [&str; 2] = ["server_tool_use", "mcp_tool_use"];
pub(super) const NATIVE_RESULT_TYPES: [&str; 7] = [
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "mcp_tool_result",
    "tool_search_tool_result",
];

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

struct Frame {
    data: String,
}

/// Splits the byte stream at the last `\n` (a partial line stays buffered),
/// drops `:` comments and blank lines, keeps the `event:` name until the next
/// one, trims `data:` payloads and drops empty ones. CRLF is tolerated.
#[derive(Default)]
struct SseFramer {
    buffer: Vec<u8>,
    event: String,
}

impl SseFramer {
    /// Frames of the complete lines now available, with their event names.
    fn push(&mut self, bytes: &[u8]) -> Vec<(String, Frame)> {
        self.buffer.extend_from_slice(bytes);
        let Some(cut) = self.buffer.iter().rposition(|b| *b == b'\n') else {
            return Vec::new();
        };
        let region: Vec<u8> = self.buffer.drain(..=cut).collect();
        let mut frames = Vec::new();
        for raw in region.split(|b| *b == b'\n') {
            if raw.is_empty() || raw[0] == b':' {
                continue;
            }
            let line = String::from_utf8_lossy(raw);
            if let Some(name) = line.strip_prefix("event:") {
                self.event = name.trim().to_owned();
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    frames.push((self.event.clone(), Frame { data: data.to_owned() }));
                }
            }
        }
        frames
    }
}

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

enum Block {
    Text { text: String, citations: Vec<Value> },
    Thinking { thinking: String, signature: String },
    Redacted { data: String },
    ToolUse { id: String, name: String, opening_input: Option<Value>, json: String, done: Option<Value> },
    NativeCall { block: Value, json: String, done: bool },
    NativeResult(Value),
}

#[derive(Default)]
pub(super) struct UsageAcc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cache_write_1h: u64,
    /// A gateway's reported cost (OpenRouter puts `cost` on the final usage), USD.
    cost: Option<f64>,
    raw: Map<String, Value>,
}

/// `reportedCostUsd`: a finite, non-negative number or numeric text; null, blank, negative is "not reported", never $0.
fn reported_cost_usd(value: &Value) -> Option<f64> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(text) if !text.trim().is_empty() => mixdog_js::string_to_number(text),
        _ => return None,
    };
    (n.is_finite() && n >= 0.0).then_some(n)
}

impl UsageAcc {
    fn has_report(raw: &Value) -> bool {
        ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
            .iter()
            .any(|name| raw.get(*name).and_then(Value::as_u64).is_some())
            || ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].iter().any(|name| {
                raw.get("cache_creation").and_then(|split| split.get(*name)).and_then(Value::as_u64).is_some()
            })
            || raw.get("cost").and_then(reported_cost_usd).is_some()
    }

    /// Omitted fields keep the earlier report; an explicit zero replaces it.
    pub(super) fn update(&mut self, raw: &Value) {
        let Some(map) = raw.as_object() else { return };
        let field = |name: &str| map.get(name).and_then(Value::as_u64);
        if let Some(v) = field("input_tokens") {
            self.input = v;
        }
        if let Some(v) = field("output_tokens") {
            self.output = v;
        }
        if let Some(v) = field("cache_read_input_tokens") {
            self.cache_read = v;
        }
        if let Some(v) = field("cache_creation_input_tokens") {
            self.cache_write = v;
        }
        // Node's turn-state: `cache_creation.ephemeral_1h_input_tokens`, same keep-or-replace rule.
        if let Some(v) = map
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(Value::as_u64)
        {
            self.cache_write_1h = v;
        }
        if let Some(cost) = map.get("cost").and_then(reported_cost_usd) {
            self.cost = Some(cost);
        }
        for (key, value) in map {
            if key == "cache_creation" {
                if let Some(split) = value.as_object() {
                    let held = self.raw.entry(key.clone()).or_insert_with(|| Value::Object(Map::new()));
                    if !held.is_object() {
                        *held = Value::Object(Map::new());
                    }
                    if let Some(held) = held.as_object_mut() {
                        for (ttl, tokens) in split {
                            if tokens.as_u64().is_some() || held.get(ttl).and_then(Value::as_u64).is_none() {
                                held.insert(ttl.clone(), tokens.clone());
                            }
                        }
                    }
                }
                continue;
            }
            if matches!(key.as_str(), "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens")
                && value.as_u64().is_none() && self.raw.get(key).and_then(Value::as_u64).is_some()
            {
                continue;
            }
            self.raw.insert(key.clone(), value.clone());
        }
    }

    /// Anthropic's input leaves the cache out (`inputExcludesCache`, Node's `inputTokens`): the ledger, the session totals and
    /// the context gauge all add the cache back themselves, so the whole prompt (Node's `promptTokens`) is not stored here.
    pub(super) fn usage(&self) -> Usage {
        Usage {
            input_tokens: self.input,
            output_tokens: self.output,
            cache_read_tokens: self.cache_read,
            cache_write_tokens: self.cache_write,
            cache_write_1h_tokens: self.cache_write_1h,
            reasoning_tokens: None,
            reasoning_incomplete: false,
            raw: Some(Value::Object(self.raw.clone())),
            cost: self.cost.map(|usd| UsdTicks((usd * 1e10).round() as u64)),
        }
    }
}

pub(crate) struct AnthropicDecoder {
    owner: ProviderId,
    framer: SseFramer,
    blocks: BTreeMap<u64, Block>,
    usage: UsageAcc,
    /// Presence means this stream reported a billable field, even if its value was explicitly zero.
    usage_model: Option<Box<str>>,
    stop: Option<String>,
    saw_message_start: bool,
    terminal: bool,
    exposure: Exposure,
    pending_error: Option<ProviderError>,
    /// The leaked tool-call guard over the text deltas (`anthropic-sse-turn/leak-guard.mjs`).
    leak: LeakGuard,
    /// One dispatch per call across the leaked and the native path.
    dedupe: Dedupe,
    /// Calls recovered from text: they have no content block, so the turn cannot replay its blocks.
    leaked_dispatched: usize,
    /// Native tool_use blocks the dedupe dropped: they stay out of the replay.
    skipped: HashSet<u64>,
    /// The server-side fallbacks the stream reported (`turn.fallbackEvents`), as `parseAnthropicFallbackBlock` records them.
    fallbacks: Vec<Value>,
    /// `turn.hasThinkingContent`: a thinking delta or a redacted thinking block streamed.
    has_thinking: bool,
    /// `turn.contentBlockTypes`: the delta types and `fallback`, first-seen order.
    block_types: Vec<String>,
    /// An output block opened (`turn.firstOutputAt`).
    output_started: bool,
    /// The model the turn is attributed to (Node `turn.model`): the requested one until `message_start` names the model
    /// that answers or a `fallback` block hands the turn to the fallback model.
    model: String,
    /// The request asked for `thinking.display: "updates"` (`relayProgressUpdates`): reasoning streams no text, so thinking
    /// text is a progress update, relayed as [`StreamEvent::ProgressDelta`].
    relays_updates: bool,
    /// The thinking block the last relayed progress update belongs to (`progressIndex`).
    progress_index: Option<u64>,
    /// Text of the turn was relayed (`turn.content` holds some).
    text_relayed: bool,
    /// The last thing relayed was a progress update.
    update_shown_last: bool,
}

/// What a turn's decoder shares with its stream: the stream decodes through it and, when the turn is cut, asks it for
/// the blocks the turn holds at that moment, as Node's `partialFields` reads its store at the failure.
#[derive(Clone)]
pub(super) struct Shared(std::sync::Arc<std::sync::Mutex<AnthropicDecoder>>);

impl Shared {
    pub(super) fn new(decoder: AnthropicDecoder) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(decoder)))
    }

    fn decoder(&self) -> std::sync::MutexGuard<'_, AnthropicDecoder> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether `message_start` has arrived (`state.sawMessageStart`).
    pub(super) fn message_started(&self) -> bool {
        self.decoder().saw_message_start
    }

    pub(super) fn usage_model(&self) -> Option<String> {
        self.decoder().usage_model.as_deref().map(str::to_owned)
    }

    /// What the turn holds at a cut. The thinking blocks (`partialThinkingBlocks`) are the valid ones among the store's
    /// blocks, in provider order, whatever else the turn did. The exact replay (`partialAssistantBlocks`,
    /// `orderedAssistantBlocks`, turn-blocks.mjs) is the same blocks whole, absent when it could not be exact: a turn
    /// that recovered a call from its text has no block for it, so the replay would silently omit the call.
    pub(super) fn partial(&self) -> Cut {
        let decoder = self.decoder();
        let blocks = decoder.replay_blocks(true);
        let thinking = blocks.iter().filter(|b| replay_blocks::is_thinking(b)).cloned().collect();
        let replay = (decoder.leaked_dispatched == 0 && !blocks.is_empty())
            .then(|| ProviderReplay { owner: decoder.owner.clone(), items: Value::Array(blocks) });
        Cut { thinking, replay }
    }
}

/// A cut turn's partial blocks: the thinking it can carry, and its exact ordered replay when one can be built.
pub(super) struct Cut {
    pub(super) thinking: Vec<Value>,
    pub(super) replay: Option<ProviderReplay>,
}

impl WireDecoder for Shared {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        self.decoder().feed(unit)
    }
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        self.decoder().finish()
    }
    fn terminal_seen(&self) -> bool {
        self.decoder().terminal_seen()
    }
    fn exposure(&self) -> Exposure {
        self.decoder().exposure()
    }
}
/// Node `message.stop_reason || null`: an absent reason stays absent.
pub(super) fn stop_reason(raw: Option<&str>) -> Option<StopReason> {
    Some(match raw.filter(|r| !r.is_empty())? {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "refusal" => StopReason::Refusal,
        other => StopReason::Other(other.to_owned()),
    })
}

/// `parseAnthropicFallbackBlock` (anthropic-server-fallback.mjs:26-40): a `fallback` block's record
/// (`{ trigger, originalModel, fallbackModel, category? }`) and the model it hands the turn to; `None` for a block
/// that names no source or target model.
pub(super) fn fallback_record(block: &Value) -> Option<(Value, String)> {
    let model_of = |side: &str| match block.get(side) {
        Some(Value::String(id)) => mixdog_js::js_trim(id).to_owned(),
        Some(Value::Object(map)) => map.get("model").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default().to_owned(),
        _ => String::new(),
    };
    let (from, to) = (model_of("from"), model_of("to"));
    if from.is_empty() || to.is_empty() {
        return None;
    }
    let trigger = block.get("trigger").filter(|t| t.is_object());
    let text_of = |key: &str| trigger.and_then(|t| t.get(key)).and_then(Value::as_str).map(mixdog_js::js_trim).filter(|s| !s.is_empty());
    let mut record = json!({ "trigger": text_of("type").unwrap_or("refusal"), "originalModel": from, "fallbackModel": to });
    if let Some(category) = text_of("category") {
        record["category"] = json!(category);
    }
    Some((record, to))
}

impl AnthropicDecoder {
    /// A decoder for a request to `model`: a turn another model answers reports it ([`StreamEvent::ServedModel`]).
    pub(crate) fn for_model(owner: ProviderId, model: &str) -> Self {
        Self {
            model: model.to_owned(),
            owner,
            framer: SseFramer::default(),
            blocks: BTreeMap::new(),
            usage: UsageAcc::default(),
            usage_model: None,
            stop: None,
            saw_message_start: false,
            terminal: false,
            exposure: Exposure::default(),
            pending_error: None,
            leak: LeakGuard::new(HashSet::new(), false),
            dedupe: Dedupe::default(),
            leaked_dispatched: 0,
            skipped: HashSet::new(),
            fallbacks: Vec::new(),
            has_thinking: false,
            block_types: Vec::new(),
            output_started: false,
            relays_updates: false,
            progress_index: None,
            text_relayed: false,
            update_shown_last: false,
        }
    }

    /// The request was sent with `thinking.display: "updates"`: its thinking text is relayed as progress updates.
    pub(crate) fn relaying_updates(mut self, relays: bool) -> Self {
        self.relays_updates = relays;
        self
    }

    /// Recover tool calls leaked into the text, naming only these tools (the request body's).
    pub(crate) fn with_known_tools(mut self, names: HashSet<String>) -> Self {
        self.leak = LeakGuard::new(names, false);
        self
    }

    /// What the guard let through and recovered: visible text first, then the calls.
    fn relay_leak(&mut self, (text, calls): (String, Vec<Recovered>), out: &mut Vec<StreamEvent>) {
        if !text.is_empty() {
            self.exposure.text_emitted = true;
            self.part_from_update(out);
            out.push(StreamEvent::TextDelta(text));
        }
        for recovered in calls {
            let call = leak::anthropic_call(recovered);
            if !self.dedupe.should_dispatch(&call.name, &call.arguments, "") {
                continue;
            }
            self.exposure.tool_dispatched = true;
            self.leaked_dispatched += 1;
            out.push(StreamEvent::ToolCallDone(call));
            out.push(StreamEvent::Progress(ProgressKind::Tool));
        }
    }

    fn tool_input_in_flight(&self) -> bool {
        self.blocks.values().any(|block| match block {
            Block::ToolUse { done, .. } => done.is_none(),
            Block::NativeCall { done, .. } => !*done,
            _ => false,
        })
    }

    fn fail(&self, mut err: ProviderError) -> ProviderError {
        err.exposure = self.exposure;
        if let Some(model) = &self.usage_model {
            err.partial_usage = Some(Box::new(self.usage.usage()));
            err.partial_model = Some(model.clone());
        }
        err
    }

    fn report_usage(&mut self, raw: &Value, out: &mut Vec<StreamEvent>) {
        self.usage.update(raw);
        if UsageAcc::has_report(raw) {
            self.usage_model = Some(self.model.as_str().into());
            out.push(StreamEvent::Usage(self.usage.usage()));
        }
    }

    fn truncated(&self) -> ProviderError {
        let mut err = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        err.message = if self.saw_message_start {
            "Anthropic SSE stream truncated: message_start without message_stop".to_owned()
        } else {
            "Anthropic SSE stream ended before message_start".to_owned()
        };
        err.exposure = self.exposure;
        err.exposure.tool_input_cut = self.tool_input_in_flight();
        err
    }

    /// The ordered assistant blocks of the turn, in provider block order,
    /// reduced to what the API accepts back ([`replay_blocks::sanitize`]); a
    /// merged thinking run dropped is reported once (turn-blocks.mjs:88-99). `at_cut`: the turn is read mid-stream, and
    /// a thinking block with no signature is not carried (the API refuses it back); an empty one with a signature is.
    fn replay_blocks(&self, at_cut: bool) -> Vec<Value> {
        let mut blocks: Vec<Value> = Vec::new();
        for (index, block) in &self.blocks {
            if self.skipped.contains(index) {
                continue;
            }
            let value = match block {
                Block::Text { text, citations } => {
                    let mut value = json!({ "type": "text", "text": text });
                    if !citations.is_empty() {
                        value["citations"] = Value::Array(citations.clone());
                    }
                    value
                }
                Block::Thinking { signature, .. } if at_cut && signature.is_empty() => continue,
                Block::Thinking { thinking, signature } => {
                    json!({ "type": "thinking", "thinking": thinking, "signature": signature })
                }
                Block::Redacted { data } => json!({ "type": "redacted_thinking", "data": data }),
                Block::ToolUse { id, name, done: Some(input), .. } => {
                    json!({ "type": "tool_use", "id": id, "name": name, "input": input })
                }
                Block::NativeCall { block, done: true, .. } => block.clone(),
                Block::NativeResult(block) => block.clone(),
                _ => continue,
            };
            blocks.push(value);
        }
        let mut merged = 0;
        replay_blocks::sanitize(&blocks, &mut |dropped, block| {
            if dropped == replay_blocks::Dropped::MergedThinking {
                merged += 1;
                if merged == 1 {
                    let kind = block.get("type").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("thinking");
                    tracing::warn!(
                        "[anthropic] dropped a {kind} block separated only by an empty text block; replaying it would merge two thinking runs into one"
                    );
                }
            }
        })
    }

    fn emit_completed(&mut self, out: &mut Vec<StreamEvent>) {
        self.terminal = true;
        // The stream ended: nothing is held back any more.
        let tail = self.leak.flush();
        self.relay_leak(tail, out);
        // A recovered call has no content block, so the exact replay would silently omit it.
        // The turn is stored flattened, content + `thinkingBlocks` + calls (`orderedThinkingBlocks`).
        let blocks = if self.leaked_dispatched > 0 {
            let thinking: Vec<Value> = self
                .replay_blocks(false)
                .into_iter()
                .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking")))
                .collect();
            if !thinking.is_empty() {
                out.push(StreamEvent::ThinkingBlocks(Value::Array(thinking)));
            }
            Vec::new()
        } else {
            self.replay_blocks(false)
        };
        if !blocks.is_empty() {
            out.push(StreamEvent::ReasoningReplay(ProviderReplay {
                owner: self.owner.clone(),
                items: Value::Array(blocks),
            }));
        }
        out.push(StreamEvent::Usage(self.usage.usage()));
        // `anthropicFallbackProviderMetadata(turn.fallbackEvents)` (turn-outcome.mjs:158).
        if !self.fallbacks.is_empty() {
            out.push(StreamEvent::ProviderMetadata(json!({ "anthropicFallbacks": self.fallbacks })));
        }
        // `hasThinkingContent` / `contentBlockTypes` (turn-outcome.mjs:143-144).
        out.push(StreamEvent::ContentSummary { has_thinking: self.has_thinking, block_types: self.block_types.clone() });
        out.push(StreamEvent::Completed {
            pricing_model: None,
            request_ms: None,
            stop: stop_reason(self.stop.as_deref()),
        });
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn on_event(&mut self, event: &Value, name: &str, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if name == "error" || kind == "error" || event.get("error").is_some_and(crate::providers::js_value::truthy) {
            return Err(self.fail(classify_stream_error(event)));
        }
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            "message_start" => {
                let Some(message) = event.get("message").filter(|m| m.is_object()) else {
                    return Ok(());
                };
                self.saw_message_start = true;
                // The semantic message boundary (anthropic-sse.mjs:149-151).
                out.push(StreamEvent::Progress(ProgressKind::Semantic));
                // `onMessageStart`: `if (message.model) turn.model = message.model` (turn-events/message-events.mjs:17).
                if let Some(model) = message.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                    self.serve(model, out);
                }
                if let Some(usage) = message.get("usage") {
                    self.report_usage(usage, out);
                }
            }
            "content_block_start" => self.block_start(index, event.get("content_block"), out),
            "content_block_delta" => self.block_delta(index, event.get("delta"), out),
            "content_block_stop" => self.block_stop(index, out),
            "message_delta" => self.message_delta(event, out)?,
            "ping" => out.push(StreamEvent::ProviderKeepalive),
            "message_stop" => {
                if self.tool_input_in_flight() {
                    self.exposure.tool_input_cut = true;
                    return Err(self.truncated());
                }
                self.emit_completed(out);
            }
            _ => {}
        }
        Ok(())
    }

    /// The first output block opening starts the generation (`turn.firstOutputAt ||= Date.now()`).
    fn output_started(&mut self, out: &mut Vec<StreamEvent>) {
        if !self.output_started {
            self.output_started = true;
            out.push(StreamEvent::OutputStarted);
        }
    }

    /// The turn is now attributed to `model`; a change is reported.
    fn serve(&mut self, model: &str, out: &mut Vec<StreamEvent>) {
        if self.model != model {
            self.model = model.to_owned();
            out.push(StreamEvent::ServedModel(model.to_owned()));
        }
    }

    fn block_start(&mut self, index: u64, block: Option<&Value>, out: &mut Vec<StreamEvent>) {
        let Some(block) = block.filter(|b| b.is_object()) else {
            return;
        };
        // A server-side fallback hands the turn to the fallback model (`parseAnthropicFallbackBlock`,
        // anthropic-server-fallback.mjs:26-40, and content-block-start.mjs:52-58): the block carries no content.
        if block.get("type").and_then(Value::as_str) == Some("fallback") {
            if let Some((record, to)) = fallback_record(block) {
                self.fallbacks.push(record);
                self.note_block_type("fallback");
                self.serve(&to, out);
                out.push(StreamEvent::Progress(ProgressKind::Semantic));
            } else {
                // Not a fallback Node can read: an output block opening like any other (content-block-start.mjs:72).
                self.output_started(out);
            }
            return;
        }
        // Any output block opening starts the generation, a thinking block above all (content-block-start.mjs:69-72):
        // a block with a type.
        if crate::providers::js_value::truthy(block.get("type").unwrap_or(&Value::Null)) {
            self.output_started(out);
        }
        let text_of = |field: &str| block.get(field).and_then(Value::as_str).unwrap_or("").to_owned();
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                out.push(StreamEvent::ItemStart { kind: ItemKind::Text, phase: None });
                let citations = block
                    .get("citations")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.blocks.insert(index, Block::Text { text: String::new(), citations });
                let initial = text_of("text");
                if !initial.is_empty() {
                    self.append_text(index, &initial, out);
                }
            }
            "thinking" => {
                out.push(StreamEvent::ItemStart { kind: ItemKind::Reasoning, phase: None });
                // Omitted-thinking displays stream no thinking_delta until the signature: the opening is the only sign.
                out.push(StreamEvent::Progress(ProgressKind::Reasoning));
                self.blocks.insert(
                    index,
                    Block::Thinking { thinking: text_of("thinking"), signature: text_of("signature") },
                );
            }
            "redacted_thinking" => {
                self.has_thinking = true;
                out.push(StreamEvent::ItemStart { kind: ItemKind::Reasoning, phase: None });
                out.push(StreamEvent::Progress(ProgressKind::Reasoning));
                self.blocks.insert(index, Block::Redacted { data: text_of("data") });
            }
            "tool_use" => {
                let (id, name) = (text_of("id"), text_of("name"));
                out.push(StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None });
                out.push(StreamEvent::ToolCallStart { id: id.clone(), name: name.clone() });
                let opening_input = block.get("input").filter(|input| input.is_object()).cloned();
                self.blocks.insert(index, Block::ToolUse { id, name, opening_input, json: String::new(), done: None });
            }
            kind if NATIVE_CALL_TYPES.contains(&kind) => {
                out.push(StreamEvent::Progress(ProgressKind::Tool));
                self.blocks.insert(
                    index,
                    Block::NativeCall { block: block.clone(), json: String::new(), done: false },
                );
            }
            kind if NATIVE_RESULT_TYPES.contains(&kind) => {
                out.push(StreamEvent::Progress(ProgressKind::Tool));
                self.blocks.insert(index, Block::NativeResult(block.clone()));
            }
            _ => {}
        }
    }

    fn append_text(&mut self, index: u64, delta: &str, out: &mut Vec<StreamEvent>) {
        // A text delta for an index that never opened still counts: its slot is created (`appendText`).
        let Block::Text { text, .. } = self.blocks.entry(index).or_insert_with(|| Block::Text { text: String::new(), citations: Vec::new() }) else {
            return;
        };
        text.push_str(delta);
        if self.leak.enabled() {
            let scanned = self.leak.push(delta, false);
            self.relay_leak(scanned, out);
        } else if !delta.is_empty() {
            self.exposure.text_emitted = true;
            self.part_from_update(out);
            out.push(StreamEvent::TextDelta(delta.to_owned()));
        }
    }

    /// Text is about to be relayed. Text that follows a progress update is shown as a paragraph of its own: the break is
    /// part of what is shown, as an update is, never of the turn's text (Node relayed the two with nothing between them).
    fn part_from_update(&mut self, out: &mut Vec<StreamEvent>) {
        if std::mem::take(&mut self.update_shown_last) {
            out.push(StreamEvent::ProgressDelta("\n\n".to_owned()));
        }
        self.text_relayed = true;
    }

    /// `turn.contentBlockTypes.add(kind)`: first-seen order, each once.
    fn note_block_type(&mut self, kind: &str) {
        if !self.block_types.iter().any(|k| k == kind) {
            self.block_types.push(kind.to_owned());
        }
    }

    fn block_delta(&mut self, index: u64, delta: Option<&Value>, out: &mut Vec<StreamEvent>) {
        let Some(delta) = delta else { return };
        let str_of = |field: &str| delta.get(field).and_then(Value::as_str).unwrap_or("");
        // content-block-delta.mjs:96: every delta's (non-empty) type.
        if let Some(kind) = delta.get("type").and_then(Value::as_str).filter(|k| !k.is_empty()) {
            self.note_block_type(kind);
        }
        if matches!(delta.get("type").and_then(Value::as_str), Some("thinking_delta" | "signature_delta")) {
            self.has_thinking = true;
        }
        match delta.get("type").and_then(Value::as_str).unwrap_or("") {
            "text_delta" => {
                let text = str_of("text").to_owned();
                self.append_text(index, &text, out);
            }
            "thinking_delta" => {
                let piece = str_of("thinking");
                if let Some(Block::Thinking { thinking, .. }) = self.blocks.get_mut(&index) {
                    thinking.push_str(piece);
                } else {
                    // A signature may arrive before any thinking text seeded the slot.
                    self.blocks.insert(
                        index,
                        Block::Thinking { thinking: piece.to_owned(), signature: String::new() },
                    );
                }
                if !piece.is_empty() {
                    // Emitted thinking is an exposure boundary like text: the
                    // consumer has seen output a replay would repeat.
                    self.exposure.text_emitted = true;
                    if self.relays_updates {
                        // `relayProgressUpdate`: an update of another block starts a paragraph of its own after what was shown.
                        let apart = self.progress_index != Some(index) && (self.progress_index.is_some() || self.text_relayed);
                        self.progress_index = Some(index);
                        self.update_shown_last = true;
                        out.push(StreamEvent::ProgressDelta(format!("{}{piece}", if apart { "\n\n" } else { "" })));
                        out.push(StreamEvent::Progress(ProgressKind::Text));
                    } else {
                        out.push(StreamEvent::ReasoningDelta(piece.to_owned()));
                    }
                }
            }
            "signature_delta" => {
                let piece = str_of("signature");
                if let Some(Block::Thinking { signature, .. }) = self.blocks.get_mut(&index) {
                    signature.push_str(piece);
                } else {
                    self.blocks.insert(
                        index,
                        Block::Thinking { thinking: String::new(), signature: piece.to_owned() },
                    );
                }
                if !piece.is_empty() {
                    out.push(StreamEvent::Progress(ProgressKind::Reasoning));
                }
            }
            "input_json_delta" => {
                let piece = str_of("partial_json");
                match self.blocks.get_mut(&index) {
                    Some(Block::ToolUse { id, json, .. }) => {
                        json.push_str(piece);
                        out.push(StreamEvent::ToolCallArgsDelta { id: id.clone(), delta: piece.to_owned() });
                    }
                    Some(Block::NativeCall { json, .. }) => json.push_str(piece),
                    _ => {}
                }
                // Only content advances the response: an empty fragment is not progress.
                if !piece.is_empty() {
                    out.push(StreamEvent::Progress(ProgressKind::Tool));
                }
            }
            // A citation belongs to the text block it cites, replayed with it (turn-blocks.mjs:41-51, :79-81); Node's
            // Anthropic result has no citation list of its own.
            "citations_delta" => {
                let Some(citation) = delta.get("citation").filter(|c| c.is_object()) else {
                    return;
                };
                if let Some(Block::Text { citations, .. }) = self.blocks.get_mut(&index) {
                    citations.push(citation.clone());
                }
            }
            _ => {}
        }
    }

    fn block_stop(&mut self, index: u64, out: &mut Vec<StreamEvent>) {
        match self.blocks.get_mut(&index) {
            Some(Block::ToolUse { id, name, opening_input, json, done }) if done.is_none() => {
                // A malformed input stays a call carrying the parse failure, so
                // the model can re-issue it; a non-object input is `{}`.
                let arguments = if json.is_empty() {
                    opening_input.take().unwrap_or_else(|| Value::Object(Map::new()))
                } else {
                    match mixdog_js::json_parse(json) {
                        Ok(value) if value.is_object() => value,
                        Ok(_) => Value::Object(Map::new()),
                        Err(error) => json!({
                            "__invalidToolArgs": true,
                            "__rawArguments": json,
                            "__parseError": mixdog_js::v8_json_parse_error(json).unwrap_or_else(|| error.to_string()),
                        }),
                    }
                };
                *done = Some(arguments.clone());
                // A text-leaked call of the same name and arguments already ran: this one is skipped whole.
                if self.dedupe.should_dispatch(name, &arguments, id) {
                    self.exposure.tool_dispatched = true;
                    out.push(StreamEvent::ToolCallDone(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments,
                        native_type: None,
                    }));
                } else {
                    self.skipped.insert(index);
                }
                out.push(StreamEvent::Progress(ProgressKind::Tool));
            }
            Some(Block::NativeCall { block, json, done }) => {
                let current = block.get("input").filter(|v| v.is_object()).cloned();
                let input = if json.is_empty() {
                    current.unwrap_or_else(|| Value::Object(Map::new()))
                } else {
                    serde_json::from_str::<Value>(json)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| Value::Object(Map::new()))
                };
                block["input"] = input;
                *done = true;
                out.push(StreamEvent::ServerToolBlock(block.clone()));
            }
            Some(Block::NativeResult(block)) => out.push(StreamEvent::ServerToolBlock(block.clone())),
            _ => {}
        }
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn message_delta(&mut self, event: &Value, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let delta = event.get("delta");
        let stop = delta
            .and_then(|d| d.get("stop_reason"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(stop) = stop {
            self.stop = Some(stop.to_owned());
        }
        if let Some(usage) = event.get("usage") {
            self.report_usage(usage, out);
        }
        // A stop declared while a tool input still streams: the arguments can
        // never complete, so the turn is cut now rather than at message_stop.
        if stop.is_some() && self.tool_input_in_flight() {
            self.exposure.tool_input_cut = true;
            return Err(self.truncated());
        }
        let completed_calls = self
            .blocks
            .values()
            .any(|b| matches!(b, Block::ToolUse { done: Some(_), .. }));
        if self.stop.as_deref() == Some("tool_use") && completed_calls && !self.tool_input_in_flight() {
            self.emit_completed(out);
        }
        Ok(())
    }
}

impl WireDecoder for AnthropicDecoder {
    /// An error that follows events decoded from the same unit is held back
    /// so those events are delivered first; the next call (an empty feed
    /// suffices) returns it. The outcome is thus independent of chunking.
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.pending_error.take() {
            return Err(err);
        }
        if self.terminal {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for (name, frame) in self.framer.push(unit) {
            if self.terminal {
                break;
            }
            // A malformed record is skipped; the well-formed ones beside it run.
            let Ok(event) = serde_json::from_str::<Value>(&frame.data) else {
                continue;
            };
            if let Err(err) = self.on_event(&event, &name, &mut out) {
                if out.is_empty() {
                    return Err(err);
                }
                self.pending_error = Some(err);
                break;
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(err) = self.pending_error.take() {
            return Err(err);
        }
        if self.terminal {
            Ok(Vec::new())
        } else {
            Err(self.truncated())
        }
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    /// What the stream has shown so far. A tool input still streaming is a cut input whenever the stream ends here, by its
    /// own truncation or by a transport fault of the body, so the loop can tell a call that never ran from one that did.
    fn exposure(&self) -> Exposure {
        Exposure { tool_input_cut: self.tool_input_in_flight(), ..self.exposure }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(frames: &[Value]) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut decoder = AnthropicDecoder::for_model(ProviderId::from("anthropic"), "claude-x");
        let mut out = Vec::new();
        for frame in frames {
            let line = format!("data: {frame}\n\n");
            out.extend(decoder.feed(line.as_bytes())?);
        }
        out.extend(decoder.feed(&[])?);
        Ok(out)
    }

    fn message_start() -> Value {
        json!({ "type": "message_start", "message": { "model": "claude-x", "usage": { "input_tokens": 1 } } })
    }

    #[test]
    fn an_opening_tool_input_survives_without_fragments_and_is_dispatched_once() {
        let frames = [
            message_start(),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "call_a", "name": "lookup", "input": { "key": "opening" } } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "call_b", "name": "lookup", "input": { "key": "preview" } } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"key\":" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"streamed\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" } }),
        ];
        let events = decode(&frames).expect("a complete tool turn");
        let calls: Vec<_> = events.iter().filter_map(|event| match event {
            StreamEvent::ToolCallDone(call) => Some((call.id.as_str(), call.arguments.clone())),
            _ => None,
        }).collect();
        assert_eq!(calls, [("call_a", json!({ "key": "opening" })), ("call_b", json!({ "key": "streamed" }))]);
        assert!(events.iter().any(|event| matches!(event, StreamEvent::ReasoningReplay(replay)
            if replay.items[0]["input"] == json!({"key": "opening"}) && replay.items[1]["input"] == json!({"key": "streamed"}))));
    }

    /// `event?.error` is JavaScript truthiness: an explicit `"error": null` on a normal event is not an error frame.
    #[test]
    fn a_null_error_field_on_a_normal_event_is_not_an_error() {
        let events = decode(&[
            message_start(),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" }, "error": null }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "hi" }, "error": null }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 1 }, "error": null }),
            json!({ "type": "message_stop" }),
        ])
        .expect("no error frame");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::TextDelta(t) if t == "hi")));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Completed { .. })));
    }

    /// `appendText` creates the slot: a text delta for an index that never opened is still the turn's text.
    /// What a cut turn carries is read from the decoder's state at the cut, not from its last block end: text that
    /// streamed after the last block stop is in it, and an unsigned thinking block still open is not.
    #[test]
    fn the_partial_blocks_are_read_at_the_cut() {
        let shared = Shared::new(AnthropicDecoder::for_model(ProviderId::from("anthropic"), "claude-x"));
        let mut feeding = shared.clone();
        for frame in [
            message_start(),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hm" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "so far" } }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "thinking_delta", "thinking": "open" } }),
        ] {
            feeding.feed(format!("data: {frame}\n\n").as_bytes()).expect("fed");
        }
        let cut = shared.partial();
        let replay = cut.replay.expect("blocks at the cut");
        assert_eq!(cut.thinking, vec![json!({ "type": "thinking", "thinking": "hm", "signature": "sig" })]);
        assert_eq!(
            replay.items,
            json!([{ "type": "thinking", "thinking": "hm", "signature": "sig" }, { "type": "text", "text": "so far" }])
        );
    }
    /// Text between two thinking blocks, ahead of two tool calls, is in the turn's text and its replay at its place.
    #[test]
    fn text_between_thinking_blocks_before_two_tool_calls_is_kept() {
        let start = |index: u64, block: Value| json!({ "type": "content_block_start", "index": index, "content_block": block });
        let delta = |index: u64, delta: Value| json!({ "type": "content_block_delta", "index": index, "delta": delta });
        let stop = |index: u64| json!({ "type": "content_block_stop", "index": index });
        let events = decode(&[
            message_start(),
            start(0, json!({ "type": "thinking", "thinking": "" })),
            delta(0, json!({ "type": "signature_delta", "signature": "sig-a" })),
            stop(0),
            start(1, json!({ "type": "text", "text": "" })),
            delta(1, json!({ "type": "text_delta", "text": "I will look." })),
            stop(1),
            start(2, json!({ "type": "thinking", "thinking": "" })),
            delta(2, json!({ "type": "thinking_delta", "thinking": "plan" })),
            delta(2, json!({ "type": "signature_delta", "signature": "sig-b" })),
            stop(2),
            start(3, json!({ "type": "tool_use", "id": "t1", "name": "Skill", "input": {} })),
            delta(3, json!({ "type": "input_json_delta", "partial_json": "{\"name\":\"a\"}" })),
            stop(3),
            start(4, json!({ "type": "tool_use", "id": "t2", "name": "shell", "input": {} })),
            delta(4, json!({ "type": "input_json_delta", "partial_json": "{\"command\":\"b\"}" })),
            stop(4),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 1 } }),
            json!({ "type": "message_stop" }),
        ])
        .expect("decoded");
        let text_at = events.iter().position(|e| matches!(e, StreamEvent::TextDelta(t) if t == "I will look.")).expect("text streamed");
        let call_at = events.iter().position(|e| matches!(e, StreamEvent::ToolCallDone(_))).expect("calls dispatched");
        assert!(text_at < call_at);
        let replay = events.iter().find_map(|e| match e {
            StreamEvent::ReasoningReplay(replay) => Some(replay.items.clone()),
            _ => None,
        });
        let kinds: Vec<String> = replay.unwrap().as_array().unwrap().iter().map(|b| b["type"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kinds, ["thinking", "text", "thinking", "tool_use", "tool_use"]);
    }

    /// A request sent asking for progress updates relays its thinking text as progress updates, each block's a paragraph of
    /// its own after what was shown, and the turn's blocks stay what the model wrote; a request that did not ask streams
    /// the same text as reasoning.
    #[test]
    fn thinking_text_of_a_request_for_progress_updates_is_relayed_as_progress_updates() {
        let start = |index: u64, block: Value| json!({ "type": "content_block_start", "index": index, "content_block": block });
        let delta = |index: u64, delta: Value| json!({ "type": "content_block_delta", "index": index, "delta": delta });
        let frames = [
            message_start(),
            start(0, json!({ "type": "thinking", "thinking": "" })),
            delta(0, json!({ "type": "thinking_delta", "thinking": "Reading " })),
            delta(0, json!({ "type": "thinking_delta", "thinking": "the file." })),
            delta(0, json!({ "type": "signature_delta", "signature": "sig-a" })),
            start(1, json!({ "type": "thinking", "thinking": "" })),
            delta(1, json!({ "type": "thinking_delta", "thinking": "Now the tests." })),
            delta(1, json!({ "type": "signature_delta", "signature": "sig-b" })),
            start(2, json!({ "type": "tool_use", "id": "t1", "name": "shell", "input": {} })),
            delta(2, json!({ "type": "input_json_delta", "partial_json": "{}" })),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 1 } }),
            json!({ "type": "message_stop" }),
        ];
        let run = |relays: bool| {
            let mut decoder = AnthropicDecoder::for_model(ProviderId::from("anthropic"), "claude-x").relaying_updates(relays);
            let mut out = Vec::new();
            for frame in &frames {
                out.extend(decoder.feed(format!("data: {frame}\n\n").as_bytes()).expect("decoded"));
            }
            out.extend(decoder.finish().expect("finished"));
            out
        };
        let relayed = run(true);
        let updates: Vec<&str> = relayed.iter().filter_map(|e| if let StreamEvent::ProgressDelta(text) = e { Some(text.as_str()) } else { None }).collect();
        assert_eq!(updates, ["Reading ", "the file.", "\n\nNow the tests."]);
        assert!(!relayed.iter().any(|e| matches!(e, StreamEvent::ReasoningDelta(_) | StreamEvent::TextDelta(_))), "an update is neither reasoning nor the reply's text");
        let replay = relayed.iter().find_map(|e| if let StreamEvent::ReasoningReplay(replay) = e { Some(replay.items.clone()) } else { None }).expect("the blocks");
        assert_eq!(replay[0], json!({ "type": "thinking", "thinking": "Reading the file.", "signature": "sig-a" }));
        let plain = run(false);
        let reasoning: Vec<&str> = plain.iter().filter_map(|e| if let StreamEvent::ReasoningDelta(text) = e { Some(text.as_str()) } else { None }).collect();
        assert_eq!(reasoning, ["Reading ", "the file.", "Now the tests."]);
        assert!(!plain.iter().any(|e| matches!(e, StreamEvent::ProgressDelta(_))));
    }

    #[test]
    fn a_text_delta_with_no_block_start_is_kept() {
        let events = decode(&[
            message_start(),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "hi" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 1 } }),
            json!({ "type": "message_stop" }),
        ])
        .expect("decoded");
        assert!(events.iter().any(|e| matches!(e, StreamEvent::TextDelta(t) if t == "hi")));
        let replay = events.iter().find_map(|e| match e {
            StreamEvent::ReasoningReplay(replay) => Some(replay.items.clone()),
            _ => None,
        });
        assert_eq!(replay, Some(json!([{ "type": "text", "text": "hi" }])));
    }
}
