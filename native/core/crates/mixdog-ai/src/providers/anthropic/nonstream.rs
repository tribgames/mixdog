//! The non-streaming re-issue of an API-key send (`issueNonStreamingFallback`, anthropic-api-recovery.mjs:41-64):
//! the request body as `{ ...params, stream: false }` capped for a non-streaming request (`capForNonStreaming`,
//! anthropic-max-tokens-recovery.mjs), and the whole Messages response as the turn's events
//! (`normalizeAnthropicNonStreamingResponse`, lib/anthropic-request-utils.mjs).

use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::decoder::NATIVE_CALL_TYPES;
use super::decoder::NATIVE_RESULT_TYPES;
use super::decoder::UsageAcc;
use super::decoder::fallback_record;
use super::decoder::stop_reason;
use super::replay_blocks;

/// `MAX_NON_STREAMING_TOKENS`: the largest `max_tokens` the API takes without streaming.
const MAX_NON_STREAMING_TOKENS: u64 = 64_000;

/// `PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS` in seconds, as the SDK writes it into `X-Stainless-Timeout`.
pub(super) const TIMEOUT_SECONDS: &str = "300";

/// The streaming body as the non-streaming one: `stream` false in its place, `max_tokens` (and a thinking budget)
/// capped. `None` for a body that is not a JSON object.
pub(super) fn body(streaming: &[u8]) -> Option<Vec<u8>> {
    let mut body: serde_json::Map<String, Value> = serde_json::from_slice(streaming).ok()?;
    body.insert("stream".into(), Value::Bool(false));
    if body.get("max_tokens").and_then(Value::as_f64).is_some_and(|max| max > MAX_NON_STREAMING_TOKENS as f64) {
        body.insert("max_tokens".into(), json!(MAX_NON_STREAMING_TOKENS));
        if let Some(thinking) = body.get_mut("thinking").and_then(Value::as_object_mut)
            && let Some(budget) = thinking.get("budget_tokens").and_then(Value::as_f64).filter(|b| *b > 0.0)
        {
            thinking.insert("budget_tokens".into(), json!(budget.min((MAX_NON_STREAMING_TOKENS - 1) as f64) as u64));
        }
    }
    serde_json::to_vec(&body).ok()
}

/// The whole response `message` to a request for `requested` as the events of one turn: the text, the calls, the
/// model that answered (a fallback block's target first), the replay blocks (fallback blocks kept, as Node's
/// `sanitizeAnthropicReplayBlocks` keeps them), the native server-tool blocks, usage, the fallback metadata, the block
/// summary and the stop. No output start: Node measures no generation window for it.
pub(super) fn events(owner: &ProviderId, requested: &str, message: &Value) -> Vec<StreamEvent> {
    let blocks: Vec<Value> = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let kind = |block: &Value| block.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
    let fallbacks: Vec<(Value, String)> = blocks.iter().filter_map(fallback_record).collect();
    let mut out = Vec::new();
    let model = fallbacks
        .last()
        .map(|(_, to)| to.clone())
        .or_else(|| message.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned))
        .unwrap_or_else(|| requested.to_owned());
    if model != requested {
        out.push(StreamEvent::ServedModel(model));
    }
    let text: String = blocks.iter().filter(|b| kind(b) == "text").map(|b| b.get("text").and_then(Value::as_str).unwrap_or("")).collect();
    if !text.is_empty() {
        // The whole text at once: no text delta streamed (`onTextDelta` is not called).
        out.push(StreamEvent::FinalContent(text));
    }
    for block in blocks.iter().filter(|b| kind(b) == "tool_use") {
        out.push(StreamEvent::ToolCallDone(ToolCall {
            id: block.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
            name: block.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
            arguments: block.get("input").filter(|i| i.is_object()).cloned().unwrap_or_else(|| json!({})),
            native_type: None,
        }));
    }
    let replayable = replay_blocks::sanitize(&blocks, &mut |_, _| {});
    let thinking: Vec<Value> = replayable.iter().filter(|b| replay_blocks::is_thinking(b)).cloned().collect();
    if !thinking.is_empty() {
        out.push(StreamEvent::ThinkingBlocks(Value::Array(thinking)));
    }
    // The native server-tool blocks, as the streamed turn reports them (`ServerToolBlock`).
    for block in replayable.iter().filter(|b| NATIVE_CALL_TYPES.contains(&kind(b).as_str()) || NATIVE_RESULT_TYPES.contains(&kind(b).as_str())) {
        out.push(StreamEvent::ServerToolBlock(block.clone()));
    }
    out.push(StreamEvent::ReasoningReplay(ProviderReplay { owner: owner.clone(), items: Value::Array(replayable) }));
    let mut usage = UsageAcc::default();
    usage.update(message.get("usage").unwrap_or(&Value::Null));
    out.push(StreamEvent::Usage(usage.usage()));
    if !fallbacks.is_empty() {
        let records: Vec<Value> = fallbacks.into_iter().map(|(record, _)| record).collect();
        out.push(StreamEvent::ProviderMetadata(json!({ "anthropicFallbacks": records })));
    }
    out.push(StreamEvent::ContentSummary {
        has_thinking: blocks.iter().any(replay_blocks::is_thinking),
        block_types: blocks.iter().map(kind).filter(|k| !k.is_empty()).collect(),
    });
    out.push(StreamEvent::Completed { pricing_model: None, request_ms: None, stop: stop_reason(message.get("stop_reason").and_then(Value::as_str)) });
    out
}
