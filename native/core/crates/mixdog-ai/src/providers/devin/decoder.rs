//! `GetChatMessage` response stream: gzip Connect frames of
//! `GetChatMessageResponse` closed by an end-stream trailer. Tool calls are
//! reported once the trailer arrived, so a dispatched call always has complete
//! arguments; a body that stops without the trailer is a truncated stream.

use std::io::Read;

use flate2::read::GzDecoder;
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

use super::error::protocol_error;
use super::error::trailer_error;
use super::schema::ChatResponse;
use super::schema::stop;
use crate::providers::connect::frame::FrameReader;
use crate::providers::connect::invalid_tool_args_marker;

/// Advertised envelope length cap: the length prefix is peer-controlled.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// What one gzip payload may inflate to.
pub const MAX_DECOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
pub const OPERATION: &str = "GetChatMessage";
/// The replay item type a Devin assistant turn carries.
pub const REPLAY_ITEM_TYPE: &str = "devin_assistant";

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}

pub struct DevinDecoder {
    provider: ProviderId,
    model: String,
    served: Option<String>,
    assigned: Option<String>,
    secrets: Vec<String>,
    frames: FrameReader,
    terminated: bool,
    pending_error: Option<ProviderError>,
    message_id: String,
    thinking: String,
    signatures: Vec<String>,
    signature_type: String,
    in_thinking: bool,
    reasoning_started: bool,
    text_started: bool,
    calls: Vec<Call>,
    active_call: Option<usize>,
    usage: Option<Usage>,
    credits: Option<Value>,
    stop_reason: i32,
    exposure: Exposure,
}

fn inflate(payload: &[u8]) -> Result<Vec<u8>, ProviderError> {
    let mut out = Vec::new();
    let read = GzDecoder::new(payload).take(MAX_DECOMPRESSED_BYTES + 1).read_to_end(&mut out);
    if read.is_err() {
        return Err(protocol_error("invalid gzip payload"));
    }
    if out.len() as u64 > MAX_DECOMPRESSED_BYTES {
        return Err(protocol_error(&format!("decompressed payload exceeds {MAX_DECOMPRESSED_BYTES}-byte cap")));
    }
    Ok(out)
}

impl DevinDecoder {
    /// `model` is the catalog model id (replay identity); `secrets` are the
    /// credentials of the request, redacted from any server text.
    pub fn new(provider: ProviderId, model: impl Into<String>, secrets: Vec<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            served: None,
            assigned: None,
            secrets,
            frames: FrameReader::new(MAX_FRAME_BYTES),
            terminated: false,
            pending_error: None,
            message_id: String::new(),
            thinking: String::new(),
            signatures: Vec::new(),
            signature_type: String::new(),
            in_thinking: false,
            reasoning_started: false,
            text_started: false,
            calls: Vec::new(),
            active_call: None,
            usage: None,
            credits: None,
            stop_reason: stop::UNSPECIFIED,
            exposure: Exposure::default(),
        }
    }

    pub(crate) fn with_assignment(mut self, model: &str) -> Self {
        self.assigned = (!model.is_empty() && model != self.model).then(|| model.to_owned());
        self
    }

    fn apply(&mut self, msg: ChatResponse, events: &mut Vec<StreamEvent>) {
        let model = (!msg.actual_model_uid.is_empty())
            .then_some(msg.actual_model_uid.as_str())
            .or_else(|| self.served.is_none().then_some(self.assigned.as_deref()).flatten());
        if let Some(model) = model
            && self.served.as_deref() != Some(model)
        {
            self.served = Some(model.to_owned());
            events.push(StreamEvent::ServedModel(model.to_owned()));
        }
        if self.message_id.is_empty() && !msg.message_id.is_empty() {
            self.message_id = msg.message_id;
        }
        if msg.stop_reason != 0 {
            self.stop_reason = msg.stop_reason;
        }
        let reported_usage = msg.usage.is_some();
        if let Some(stats) = msg.usage {
            let read = stats.cache_read_tokens;
            let write = stats.cache_write_tokens;
            self.usage = Some(Usage {
                cost: None,
                // Fresh input only, as the provider reports it.
                input_tokens: stats.input_tokens,
                output_tokens: stats.output_tokens,
                cache_read_tokens: read,
                cache_write_tokens: write,
                cache_write_1h_tokens: 0,
                reasoning_tokens: None,
                reasoning_incomplete: false,
                raw: Some(json!({
                    "inputTokens": stats.input_tokens,
                    "outputTokens": stats.output_tokens,
                    "cacheReadTokens": read,
                    "cacheWriteTokens": write,
                    "modelUid": stats.model_uid,
                    "billingModelUid": stats.billing_model_uid,
                    "requestedModelUid": stats.requested_model_uid,
                })),
            });
        }
        // Each nonzero report replaces its field.
        let (cost, committed, acu) = (msg.credit_cost, msg.committed_credit_cost, msg.committed_acu_cost);
        if cost != 0 || committed != 0 || acu != 0.0 {
            let credits = self.credits.get_or_insert_with(|| json!({}));
            if cost != 0 {
                credits["cost"] = json!(cost);
            }
            if committed != 0 {
                credits["committedCost"] = json!(committed);
            }
            if acu != 0.0 {
                credits["acuCost"] = json!(acu);
            }
        }
        if (reported_usage || cost != 0 || committed != 0 || acu != 0.0)
            && let Some(mut usage) = self.usage.clone()
        {
            if let (Some(raw), Some(credits)) = (usage.raw.as_mut(), self.credits.as_ref()) {
                raw["credits"] = credits.clone();
            }
            events.push(StreamEvent::Usage(usage));
        }
        if !msg.delta_thinking.is_empty() {
            if !self.in_thinking {
                self.signatures.push(String::new());
            }
            self.in_thinking = true;
            if !self.reasoning_started {
                self.reasoning_started = true;
                events.push(StreamEvent::ItemStart { kind: ItemKind::Reasoning, phase: None });
            }
            self.thinking.push_str(&msg.delta_thinking);
            events.push(StreamEvent::ReasoningDelta(msg.delta_thinking));
        }
        // Signatures stream as deltas and may arrive after the thinking they
        // sign: every fragment extends the latest block's signature.
        if !msg.delta_signature.is_empty() {
            if self.signatures.is_empty() {
                self.signatures.push(String::new());
            }
            if let Some(last) = self.signatures.last_mut() {
                last.push_str(&msg.delta_signature);
            }
        }
        if !msg.delta_signature_type.is_empty() {
            self.signature_type = msg.delta_signature_type;
        }
        if !msg.delta_text.is_empty() {
            self.in_thinking = false;
            if !self.text_started {
                self.text_started = true;
                events.push(StreamEvent::ItemStart { kind: ItemKind::Text, phase: None });
            }
            self.exposure.text_emitted = true;
            events.push(StreamEvent::TextDelta(msg.delta_text));
        }
        if !msg.delta_tool_calls.is_empty() {
            self.in_thinking = false;
        }
        let mut reported = false;
        for call in msg.delta_tool_calls {
            let id = if call.id.is_empty() {
                match self.active_call {
                    Some(at) => self.calls[at].id.clone(),
                    None => continue,
                }
            } else {
                call.id
            };
            let known = self.calls.iter().any(|c| c.id == id);
            let at = match self.calls.iter().position(|c| c.id == id) {
                Some(at) => at,
                None => {
                    self.calls.push(Call { id, ..Call::default() });
                    self.calls.len() - 1
                }
            };
            self.active_call = Some(at);
            let entry = &mut self.calls[at];
            let args_before = entry.args.len();
            let renamed = !call.name.is_empty() && call.name != entry.name;
            // The last name a call is given wins.
            if !call.name.is_empty() {
                entry.name = call.name;
            }
            // Arguments the server could not parse arrive as invalid JSON
            // text instead; both take the same repair-or-marker path. A raw
            // value that extends what was seen is a snapshot, else a delta.
            let raw = if call.arguments_json.is_empty() { call.invalid_json_str } else { call.arguments_json };
            if !raw.is_empty() {
                if raw.starts_with(&entry.args) {
                    entry.args = raw;
                } else {
                    entry.args.push_str(&raw);
                }
            }
            // Progress is the normalized call state advancing, whatever shape the provider sent it in.
            reported |= !known || renamed || entry.args.len() != args_before;
        }
        // The chunk carries `tool_calls` for the chat consumer, which reports `tool` once per chunk.
        if reported {
            events.push(StreamEvent::Progress(ProgressKind::Tool));
        }
    }

    /// The events of a clean end: tool calls, replay, `Completed`.
    fn terminal(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let mut events = Vec::new();
        // The terminal chunk names the calls (`devinChunks`): one more `tool_calls` chunk.
        if !self.calls.is_empty() {
            events.push(StreamEvent::Progress(ProgressKind::Tool));
        }
        for call in std::mem::take(&mut self.calls) {
            if call.name.is_empty() {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
                error.code = Some("malformed_stream".to_owned());
                error.message = "Devin tool call arrived without a name".to_owned();
                return Err(error);
            }
            events.push(StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None });
            events.push(StreamEvent::ToolCallStart { id: call.id.clone(), name: call.name.clone() });
            let arguments = parse_call_arguments(&call.args);
            self.exposure.tool_dispatched = true;
            events.push(StreamEvent::ToolCallDone(ToolCall { id: call.id, name: call.name, arguments, native_type: None }));
        }
        let tool_use = self.exposure.tool_dispatched;
        let signature = self.signatures.iter().find(|s| !s.is_empty());
        let mut item = json!({ "type": REPLAY_ITEM_TYPE, "model": self.model });
        if !self.message_id.is_empty() {
            item["messageId"] = json!(self.message_id);
        }
        if !self.thinking.is_empty() {
            item["thinking"] = json!(self.thinking);
        }
        if let Some(signature) = signature {
            item["signature"] = json!(signature);
            if !self.signature_type.is_empty() {
                item["signatureType"] = json!(self.signature_type);
            }
        }
        events.push(StreamEvent::ReasoningReplay(ProviderReplay { owner: self.provider.clone(), items: json!([item]) }));
        events.push(StreamEvent::Completed {
            pricing_model: None,
            request_ms: None,
            stop: Some(if tool_use {
                StopReason::ToolUse
            } else if self.stop_reason == stop::MAX_TOKENS {
                StopReason::MaxTokens
            } else {
                // `devin.mjs` returns the literal `'stop'` for a plain end, as the chat decoders do.
                StopReason::Other("stop".to_owned())
            }),
        });
        Ok(events)
    }

    fn truncated(&self, message: &str) -> ProviderError {
        let mut error = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        error.code = Some("protocol".to_owned());
        error.message = format!("Devin protocol error: {message}");
        error.exposure = self.exposure;
        error
    }

    fn decode_frame(&mut self, frame: crate::providers::connect::frame::Frame, events: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let end_stream = frame.is_end_stream();
        let bytes = if frame.is_compressed() { inflate(&frame.payload)? } else { frame.payload };
        if end_stream {
            self.terminated = true;
            if let Some(error) = trailer_error(&bytes, OPERATION, &self.secrets) {
                return Err(error);
            }
            events.extend(self.terminal()?);
        } else {
            let msg = ChatResponse::decode(&bytes).map_err(|e| protocol_error(&format!("malformed GetChatMessageResponse: {e}")))?;
            self.apply(msg, events);
        }
        Ok(())
    }
}

impl WireDecoder for DevinDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        let (frames, framing_error) = self.frames.push_prefix(unit);
        let mut events = Vec::new();
        for frame in frames {
            if self.terminated {
                // Nothing after the trailer is part of the response.
                continue;
            }
            if let Err(mut error) = self.decode_frame(frame, &mut events) {
                error.exposure = self.exposure;
                self.terminated = true;
                if events.is_empty() {
                    return Err(error);
                }
                // A refusal sharing a network chunk with billable frames must not discard those frames.
                self.pending_error = Some(error);
                break;
            }
        }
        if !self.terminated
            && let Some(failure) = framing_error
        {
            let mut error = protocol_error(&format!("frame length {} exceeds {}-byte cap", failure.length, failure.max));
            error.exposure = self.exposure;
            self.terminated = true;
            if events.is_empty() {
                return Err(error);
            }
            self.pending_error = Some(error);
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        if self.terminated {
            return Ok(Vec::new());
        }
        if self.frames.buffered() > 0 {
            return Err(self.truncated(&format!("stream ended inside a frame ({} bytes buffered)", self.frames.buffered())));
        }
        Err(self.truncated("stream ended without an end-of-stream trailer"))
    }

    fn terminal_seen(&self) -> bool {
        self.terminated
    }

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}

/// A call's argument text as the call's arguments: an object, or the invalid-arguments marker with V8's parse text.
fn parse_call_arguments(args: &str) -> Value {
    if args.trim().is_empty() {
        return json!({});
    }
    match mixdog_js::json_parse(args) {
        Ok(v) if v.is_object() => v,
        Ok(_) => invalid_tool_args_marker(args, "arguments are not an object"),
        Err(e) => invalid_tool_args_marker(args, &mixdog_js::v8_json_parse_error(args).unwrap_or_else(|| e.to_string())),
    }
}

#[cfg(test)]
mod progress_tests {
    use super::super::schema::ChatToolCall;
    use super::*;

    fn message(wire: &Value) -> ChatResponse {
        let text = |key: &str| wire.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        ChatResponse {
            delta_text: text("deltaText"),
            delta_thinking: text("deltaThinking"),
            delta_tool_calls: wire
                .get("deltaToolCalls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|call| ChatToolCall {
                            id: call["id"].as_str().unwrap_or_default().to_owned(),
                            name: call["name"].as_str().unwrap_or_default().to_owned(),
                            arguments_json: call["argumentsJson"].as_str().unwrap_or_default().to_owned(),
                            ..ChatToolCall::default()
                        })
                        .collect()
                })
                .unwrap_or_default(),
            ..ChatResponse::default()
        }
    }

    #[tokio::test]
    async fn devin_makes_billed_usage_visible_before_a_cut_or_failing_trailer() {
        use crate::providers::connect::{frame, pb::Writer, stream::DecodedStream};
        use crate::transport::BodyStream;
        use mixdog_core_api::domain::provider::ModelStream;

        struct Chunks(std::collections::VecDeque<Result<bytes::Bytes, TransportFault>>);
        #[async_trait::async_trait]
        impl BodyStream for Chunks {
            async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
                self.0.pop_front()
            }
        }

        let mut stats = Writer::new();
        stats.varint(2, 12);
        stats.varint(3, 4);
        let mut response = Writer::new();
        response.message(7, stats);
        response.varint(14, 6);
        let billed = frame::encode(&response.finish(), 0);
        let mut with_trailer = billed.clone();
        with_trailer.extend(frame::encode(br#"{"error":{"code":"resource_exhausted"}}"#, frame::END_STREAM));
        let mut with_bad_frame = billed.clone();
        let mut served = Writer::new();
        served.string(23, "actual-served");
        with_bad_frame.extend(frame::encode(&served.finish(), 0));
        with_bad_frame.extend([0, 0xff, 0xff, 0xff, 0xff]);
        for (chunks, kind, model) in [
            (vec![Ok(billed.clone().into()), Err(TransportFault::Reset)], ErrorKind::Transient, "assigned"),
            (vec![Ok(billed.into())], ErrorKind::Transient, "assigned"),
            (vec![Ok(with_trailer.into())], ErrorKind::RateLimited, "assigned"),
            (vec![Ok(with_bad_frame.into())], ErrorKind::Unknown, "actual-served"),
        ] {
            let decoder = DevinDecoder::new(ProviderId::from("devin-oauth"), "m", Vec::new()).with_assignment("assigned");
            let mut stream = DecodedStream::new(Box::new(Chunks(chunks.into())), Box::new(decoder)).with_billed_usage("m".into());
            let Some(Ok(StreamEvent::Usage(usage))) = stream.next().await else { panic!("usage must reach accounting before cancellation or failure") };
            assert_eq!((usage.input_tokens, usage.output_tokens), (12, 4));
            assert_eq!(usage.raw.as_ref().unwrap()["credits"]["cost"], 6);
            let mut served_model = None;
            let error = loop {
                match stream.next().await.expect("stream must end with its fault") {
                    Ok(StreamEvent::ServedModel(model)) => served_model = Some(model),
                    Err(error) => break error,
                    _ => {}
                }
            };
            assert_eq!(error.kind, kind);
            assert_eq!(error.partial_usage.as_deref(), Some(&usage));
            assert_eq!(served_model.as_deref(), Some(model));
            assert_eq!(error.partial_model.as_deref(), Some(model));
        }
    }

    /// Progress is the normalized call advancing: a cumulative snapshot that repeats what was already received is not.
    #[test]
    fn a_repeated_identical_snapshot_is_no_progress() {
        let mut decoder = DevinDecoder::new(ProviderId::from("devin"), "m", Vec::new());
        let chunk = |args: &str| message(&json!({ "deltaToolCalls": [{ "id": "c1", "name": "read", "argumentsJson": args }] }));
        let progressed = |decoder: &mut DevinDecoder, args: &str| {
            let mut events = Vec::new();
            decoder.apply(chunk(args), &mut events);
            events.iter().any(|e| matches!(e, StreamEvent::Progress(ProgressKind::Tool)))
        };
        assert!(progressed(&mut decoder, "{\"a\":"), "the call opening is progress");
        assert!(progressed(&mut decoder, "{\"a\":1"), "a snapshot that grew is progress");
        assert!(!progressed(&mut decoder, "{\"a\":1"), "the same snapshot again is not");
        assert!(!progressed(&mut decoder, "{\"a\":1"), "nor the next repeat");
    }
}
