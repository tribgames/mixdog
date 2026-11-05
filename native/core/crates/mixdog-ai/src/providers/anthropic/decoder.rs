//! SSE framing and the Messages stream state machine. The terminal predicate
//! is `message_stop` (or the early `tool_use` stop with every tool input
//! complete); a body that ends without it is `TruncatedStream`.

use std::collections::BTreeMap;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::errors::classify_stream_error;

const NATIVE_CALL_TYPES: [&str; 2] = ["server_tool_use", "mcp_tool_use"];
const NATIVE_RESULT_TYPES: [&str; 7] = [
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
    ToolUse { id: String, name: String, json: String, done: Option<Value> },
    NativeCall { block: Value, json: String, done: bool },
    NativeResult(Value),
}

#[derive(Default)]
struct UsageAcc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cache_write_1h: u64,
    raw: Map<String, Value>,
}

impl UsageAcc {
    /// Omitted fields keep the earlier report; an explicit zero replaces it.
    fn update(&mut self, raw: &Value) {
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
        for (key, value) in map {
            self.raw.insert(key.clone(), value.clone());
        }
    }

    /// Mixdog input is inclusive: fresh input + cache read + cache write.
    fn usage(&self) -> Usage {
        Usage {
            input_tokens: self.input + self.cache_read + self.cache_write,
            output_tokens: self.output,
            cache_read_tokens: self.cache_read,
            cache_write_tokens: self.cache_write,
            cache_write_1h_tokens: self.cache_write_1h,
            reasoning_tokens: 0,
            raw: Some(Value::Object(self.raw.clone())),
            cost: None,
        }
    }
}

pub(crate) struct AnthropicDecoder {
    owner: ProviderId,
    framer: SseFramer,
    blocks: BTreeMap<u64, Block>,
    usage: UsageAcc,
    stop: Option<String>,
    saw_message_start: bool,
    terminal: bool,
    exposure: Exposure,
    pending_error: Option<ProviderError>,
}

/// Node `message.stop_reason || null`: an absent reason stays absent.
fn stop_reason(raw: Option<&str>) -> Option<StopReason> {
    Some(match raw.filter(|r| !r.is_empty())? {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "refusal" => StopReason::Refusal,
        other => StopReason::Other(other.to_owned()),
    })
}

impl AnthropicDecoder {
    pub(crate) fn new(owner: ProviderId) -> Self {
        Self {
            owner,
            framer: SseFramer::default(),
            blocks: BTreeMap::new(),
            usage: UsageAcc::default(),
            stop: None,
            saw_message_start: false,
            terminal: false,
            exposure: Exposure::default(),
            pending_error: None,
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
        err
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
    /// reduced to what the API accepts back: empty text is dropped, and a
    /// thinking block that only became adjacent to the previous one through
    /// that removal is dropped too (it would fuse two runs into one).
    fn replay_blocks(&self) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        let mut separator_removed = false;
        let mut last_kept_thinking = false;
        for block in self.blocks.values() {
            let value = match block {
                Block::Text { text, citations } => {
                    if text.is_empty() {
                        separator_removed = true;
                        continue;
                    }
                    let mut value = json!({ "type": "text", "text": text });
                    if !citations.is_empty() {
                        value["citations"] = Value::Array(citations.clone());
                    }
                    value
                }
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
            let is_thinking = matches!(block, Block::Thinking { .. } | Block::Redacted { .. });
            if is_thinking && last_kept_thinking && separator_removed {
                continue;
            }
            out.push(value);
            last_kept_thinking = is_thinking;
            separator_removed = false;
        }
        out
    }

    fn emit_completed(&mut self, out: &mut Vec<StreamEvent>) {
        self.terminal = true;
        let blocks = self.replay_blocks();
        if !blocks.is_empty() {
            out.push(StreamEvent::ReasoningReplay(ProviderReplay {
                owner: self.owner.clone(),
                items: Value::Array(blocks),
            }));
        }
        out.push(StreamEvent::Usage(self.usage.usage()));
        out.push(StreamEvent::Completed {
            stop: stop_reason(self.stop.as_deref()),
        });
    }

    fn on_event(&mut self, event: &Value, name: &str, out: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if name == "error" || kind == "error" || event.get("error").is_some() {
            return Err(self.fail(classify_stream_error(event)));
        }
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            "message_start" => {
                let Some(message) = event.get("message").filter(|m| m.is_object()) else {
                    return Ok(());
                };
                self.saw_message_start = true;
                if let Some(usage) = message.get("usage") {
                    self.usage.update(usage);
                    out.push(StreamEvent::Usage(self.usage.usage()));
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

    fn block_start(&mut self, index: u64, block: Option<&Value>, out: &mut Vec<StreamEvent>) {
        let Some(block) = block.filter(|b| b.is_object()) else {
            return;
        };
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
                self.blocks.insert(
                    index,
                    Block::Thinking { thinking: text_of("thinking"), signature: text_of("signature") },
                );
            }
            "redacted_thinking" => {
                out.push(StreamEvent::ItemStart { kind: ItemKind::Reasoning, phase: None });
                self.blocks.insert(index, Block::Redacted { data: text_of("data") });
            }
            "tool_use" => {
                let (id, name) = (text_of("id"), text_of("name"));
                out.push(StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None });
                out.push(StreamEvent::ToolCallStart { id: id.clone(), name: name.clone() });
                self.blocks.insert(index, Block::ToolUse { id, name, json: String::new(), done: None });
            }
            kind if NATIVE_CALL_TYPES.contains(&kind) => {
                self.blocks.insert(
                    index,
                    Block::NativeCall { block: block.clone(), json: String::new(), done: false },
                );
            }
            kind if NATIVE_RESULT_TYPES.contains(&kind) => {
                self.blocks.insert(index, Block::NativeResult(block.clone()));
            }
            _ => {}
        }
    }

    fn append_text(&mut self, index: u64, delta: &str, out: &mut Vec<StreamEvent>) {
        let Some(Block::Text { text, .. }) = self.blocks.get_mut(&index) else {
            return;
        };
        text.push_str(delta);
        if !delta.is_empty() {
            self.exposure.text_emitted = true;
            out.push(StreamEvent::TextDelta(delta.to_owned()));
        }
    }

    fn block_delta(&mut self, index: u64, delta: Option<&Value>, out: &mut Vec<StreamEvent>) {
        let Some(delta) = delta else { return };
        let str_of = |field: &str| delta.get(field).and_then(Value::as_str).unwrap_or("");
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
                    out.push(StreamEvent::ReasoningDelta(piece.to_owned()));
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
            }
            "citations_delta" => {
                let Some(citation) = delta.get("citation").filter(|c| c.is_object()) else {
                    return;
                };
                if let Some(Block::Text { citations, .. }) = self.blocks.get_mut(&index) {
                    citations.push(citation.clone());
                    out.push(StreamEvent::Citation(citation.clone()));
                }
            }
            _ => {}
        }
    }

    fn block_stop(&mut self, index: u64, out: &mut Vec<StreamEvent>) {
        match self.blocks.get_mut(&index) {
            Some(Block::ToolUse { id, name, json, done }) => {
                // A malformed input stays a call carrying the parse failure, so
                // the model can re-issue it; a non-object input is `{}`.
                let arguments = if json.is_empty() {
                    Value::Object(Map::new())
                } else {
                    match serde_json::from_str::<Value>(json) {
                        Ok(value) if value.is_object() => value,
                        Ok(_) => Value::Object(Map::new()),
                        Err(error) => json!({
                            "__invalidToolArgs": true,
                            "__rawArguments": json,
                            "__parseError": error.to_string(),
                        }),
                    }
                };
                *done = Some(arguments.clone());
                self.exposure.tool_dispatched = true;
                out.push(StreamEvent::ToolCallDone(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments,
                    native_type: None,
                }));
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
            self.usage.update(usage);
            out.push(StreamEvent::Usage(self.usage.usage()));
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

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}
