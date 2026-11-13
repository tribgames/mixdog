//! The non-streaming re-issue of a Chat Completions send whose stream ladder ran out (`recoverCompatNonStreaming`,
//! openai-compat-chat-send.mjs:268): the request body as `{ ...params, stream: false }` without `stream_options`, and the
//! whole response read as the turn. The response's one choice is handed to the wire's own decoder as the single chunk
//! of a stream, so its text, reasoning, tool calls, finish reason and usage are read by the same code a streamed turn
//! is read by.

use mixdog_core_api::domain::provider::StreamEvent;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The streaming body as the non-streaming one: `stream` false in its place, `stream_options` gone. `None` for a body
/// that is not a JSON object.
pub(super) fn body(streaming: &[u8]) -> Option<Vec<u8>> {
    let mut body: Map<String, Value> = serde_json::from_slice(streaming).ok()?;
    body.insert("stream".into(), Value::Bool(false));
    body.shift_remove("stream_options");
    serde_json::to_vec(&body).ok()
}

/// The whole response as the bytes of a one-chunk stream: its first choice's `message` as the chunk's `delta` (each
/// tool call at its position), the choice's `finish_reason`, the response's `model`, `id` and `usage`. `None` for a
/// response without a choice (`if (!choice) return null`).
pub(super) fn as_stream(response: &[u8]) -> Option<Vec<u8>> {
    let response: Value = serde_json::from_slice(response).ok()?;
    let choice = response.get("choices")?.as_array()?.first()?.as_object()?;
    let mut delta = choice.get("message").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for (index, call) in calls.iter_mut().enumerate() {
            if let Some(call) = call.as_object_mut() {
                call.insert("index".into(), json!(index));
            }
        }
    }
    let mut chunk = Map::new();
    for key in ["id", "model"] {
        if let Some(value) = response.get(key) {
            chunk.insert(key.into(), value.clone());
        }
    }
    chunk.insert("object".into(), json!("chat.completion.chunk"));
    chunk.insert(
        "choices".into(),
        json!([{ "index": 0, "delta": delta, "finish_reason": choice.get("finish_reason").cloned().unwrap_or(Value::Null) }]),
    );
    if let Some(usage) = response.get("usage").filter(|usage| !usage.is_null()) {
        chunk.insert("usage".into(), usage.clone());
    }
    let mut sse = b"data: ".to_vec();
    sse.extend(serde_json::to_vec(&chunk).ok()?);
    sse.extend_from_slice(b"\n\ndata: [DONE]\n\n");
    Some(sse)
}

/// The decoded events with the text as one whole content: no text delta streamed (`onTextDelta` is not called by the
/// non-streaming request).
pub(super) fn whole(events: Vec<StreamEvent>) -> Vec<StreamEvent> {
    let mut text = String::new();
    let mut at = None;
    let mut out = Vec::with_capacity(events.len());
    for event in events {
        match event {
            StreamEvent::TextDelta(delta) => {
                at.get_or_insert(out.len());
                text.push_str(&delta);
            }
            other => out.push(other),
        }
    }
    if let Some(at) = at {
        out.insert(at, StreamEvent::FinalContent(text));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `{ ...params, stream: false }; delete nonStreamParams.stream_options`.
    #[test]
    fn the_body_is_the_streaming_one_with_stream_off_and_no_stream_options() {
        let streaming = br#"{"model":"m","messages":[],"stream":true,"stream_options":{"include_usage":true},"temperature":0}"#;
        assert_eq!(body(streaming).unwrap(), br#"{"model":"m","messages":[],"stream":false,"temperature":0}"#);
    }

    /// `response.choices[0]`: its message, finish reason and the response's usage; no choice is no recovery.
    #[test]
    fn a_response_with_a_choice_is_one_chunk_and_one_without_is_nothing() {
        let response = br#"{"id":"r1","model":"served","choices":[{"index":0,"message":{"role":"assistant","content":"hi","tool_calls":[{"id":"c1","type":"function","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#;
        let sse = String::from_utf8(as_stream(response).unwrap()).unwrap();
        let (chunk, done) = sse.strip_prefix("data: ").unwrap().split_once("\n\n").unwrap();
        assert_eq!(done, "data: [DONE]\n\n");
        let chunk: Value = serde_json::from_str(chunk).unwrap();
        assert_eq!(chunk["model"], "served");
        assert_eq!(chunk["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(chunk["choices"][0]["delta"]["content"], "hi");
        assert_eq!(chunk["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
        assert_eq!(chunk["usage"]["prompt_tokens"], 3);
        assert!(as_stream(br#"{"choices":[]}"#).is_none());
        assert!(as_stream(b"not json").is_none());
    }

    #[test]
    fn the_text_arrives_whole() {
        let events = vec![StreamEvent::TextDelta("a".into()), StreamEvent::ProviderKeepalive, StreamEvent::TextDelta("b".into())];
        assert_eq!(whole(events), vec![StreamEvent::FinalContent("ab".into()), StreamEvent::ProviderKeepalive]);
    }
}
