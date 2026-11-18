//! What a cut Messages turn carries into the next request: its valid thinking whether or not an exact replay could be
//! built (`partialThinkingBlocks` beside `partialAssistantBlocks`, turn-outcome.mjs), and where transport is marked.
//! Each case streams the frames, cuts the body with a reset, folds the failure as the agent does (events, then the error's
//! replay, else its thinking) and reads the request that continues the turn.

use serde_json::Value;

use super::*;

fn frame(event: &Value) -> String {
    format!("event: {}\ndata: {event}\n\n", event["type"].as_str().expect("type"))
}

fn start() -> Value {
    json!({ "type": "message_start", "message": { "model": "claude-sonnet-4-6", "usage": { "input_tokens": 1 } } })
}

fn open(index: u64, block: Value) -> Value {
    json!({ "type": "content_block_start", "index": index, "content_block": block })
}

fn delta(index: u64, delta: Value) -> Value {
    json!({ "type": "content_block_delta", "index": index, "delta": delta })
}

fn stop(index: u64) -> Value {
    json!({ "type": "content_block_stop", "index": index })
}

/// A finished thinking block: its text (when any), its signature, its stop.
fn signed(index: u64, thinking: &str, signature: &str) -> Vec<Value> {
    let mut frames = vec![open(index, json!({ "type": "thinking", "thinking": "" }))];
    if !thinking.is_empty() {
        frames.push(delta(index, json!({ "type": "thinking_delta", "thinking": thinking })));
    }
    frames.push(delta(index, json!({ "type": "signature_delta", "signature": signature })));
    frames.push(stop(index));
    frames
}

/// A finished client tool call.
fn tool(index: u64, id: &str, input: &str) -> Vec<Value> {
    vec![
        open(index, json!({ "type": "tool_use", "id": id, "name": "lookup" })),
        delta(index, json!({ "type": "input_json_delta", "partial_json": input })),
        stop(index),
    ]
}

/// The calls the stream dispatched, and the failure that cut it.
async fn cut(frames: Vec<Vec<Value>>) -> (Vec<ToolCall>, ProviderError) {
    let body: String = std::iter::once(vec![start()]).chain(frames).flatten().map(|f| frame(&f)).collect();
    let mut calls = Vec::new();
    let mut failure = None;
    for item in run_chunked(vec![body.into_bytes()], Some(TransportFault::Reset)).await {
        match item {
            Ok(StreamEvent::ToolCallDone(call)) => calls.push(call),
            Ok(_) => {}
            Err(err) => failure = Some(err),
        }
    }
    (calls, failure.expect("the stream was cut"))
}

/// The assistant blocks of the request that continues the cut turn, every completed call answered.
fn continuation(calls: &[ToolCall], failure: &ProviderError) -> Vec<Value> {
    let mut assistant = text_message(Role::Assistant, "");
    assistant.tool_calls = calls.to_vec();
    if let Some(replay) = &failure.partial_replay {
        assistant.push_replay((**replay).clone());
    } else if !failure.partial_thinking_blocks.is_empty() {
        assistant.thinking_blocks = Some(Value::Array(failure.partial_thinking_blocks.clone()));
    }
    let mut messages = base_messages();
    messages.push(assistant);
    for call in calls {
        let mut result = text_message(Role::Tool, "ok");
        result.tool_call_id = Some(call.id.clone());
        messages.push(result);
    }
    lowered(messages)[1]["content"].as_array().expect("assistant blocks").clone()
}

fn types(blocks: &[Value]) -> Vec<&str> {
    blocks.iter().map(|b| b["type"].as_str().expect("type")).collect()
}

fn thinking_hm() -> Value {
    json!({ "type": "thinking", "thinking": "hm", "signature": "sig" })
}

fn tool_use(id: &str, input: Value) -> Value {
    json!({ "type": "tool_use", "id": id, "name": "lookup", "input": input })
}

#[tokio::test]
async fn signed_thinking_survives_a_cut_after_a_text_recovered_tool_call() {
    let leaked = r#"<invoke name="lookup"><parameter name="key">answer</parameter></invoke>"#;
    let (calls, failure) = cut(vec![
        signed(0, "hm", "sig"),
        vec![open(1, json!({ "type": "text", "text": "" })), delta(1, json!({ "type": "text_delta", "text": leaked }))],
    ])
    .await;
    assert_eq!(calls.len(), 1, "the recovered call is dispatched once");
    assert!(failure.partial_replay.is_none(), "a call with no content block leaves no exact replay");
    assert_eq!(failure.partial_thinking_blocks, vec![thinking_hm()]);
    let next = continuation(&calls, &failure);
    assert_eq!(types(&next), ["thinking", "tool_use"]);
    assert_eq!(next[0], thinking_hm(), "the signature is sent back verbatim, ahead of the call");
    assert_eq!(next[1]["name"], "lookup");
    assert_eq!(next[1]["input"], json!({ "key": "answer" }));
}

#[tokio::test]
async fn an_ordinary_tool_call_cut_keeps_its_exact_replay_and_thinking_apart() {
    let (calls, failure) = cut(vec![signed(0, "hm", "sig"), tool(1, "toolu_1", r#"{"key":"a"}"#)]).await;
    assert_eq!(calls.len(), 1);
    let exact = json!([thinking_hm(), tool_use("toolu_1", json!({ "key": "a" }))]);
    assert_eq!(failure.partial_replay.as_ref().expect("an exact replay").items, exact);
    assert_eq!(failure.partial_thinking_blocks, vec![thinking_hm()]);
    let next = continuation(&calls, &failure);
    assert_eq!(Value::Array(next.clone()), exact);
    assert_eq!(next.iter().filter(|b| b["type"] == "tool_use").count(), 1, "the completed call runs once");
}

#[tokio::test]
async fn an_unsigned_thinking_block_still_open_is_not_carried() {
    let open_thinking = vec![open(2, json!({ "type": "thinking", "thinking": "" })), delta(2, json!({ "type": "thinking_delta", "thinking": "open" }))];
    let (calls, failure) = cut(vec![signed(0, "hm", "sig"), tool(1, "toolu_1", "{}"), open_thinking.clone()]).await;
    assert_eq!(failure.partial_thinking_blocks, vec![thinking_hm()]);
    let exact = json!([thinking_hm(), tool_use("toolu_1", json!({}))]);
    assert_eq!(failure.partial_replay.as_ref().expect("the signed blocks").items, exact);
    let next = continuation(&calls, &failure);
    assert_eq!(Value::Array(next), exact);

    let (calls, failure) = cut(vec![open_thinking]).await;
    assert!(calls.is_empty());
    assert!(failure.partial_thinking_blocks.is_empty(), "unsigned thinking alone is nothing to carry");
    assert!(failure.partial_replay.is_none());
}

#[tokio::test]
async fn empty_thinking_with_a_signature_is_carried() {
    let (calls, failure) = cut(vec![signed(0, "", "sig"), tool(1, "toolu_1", "{}")]).await;
    let empty = json!({ "type": "thinking", "thinking": "", "signature": "sig" });
    assert_eq!(failure.partial_thinking_blocks, vec![empty.clone()]);
    let next = continuation(&calls, &failure);
    assert_eq!(next[0], empty);
    assert_eq!(next.iter().filter(|b| b["type"] == "tool_use").count(), 1);
}

#[tokio::test]
async fn redacted_thinking_is_carried_verbatim_in_block_order() {
    let redacted = json!({ "type": "redacted_thinking", "data": "enc" });
    let (calls, failure) = cut(vec![vec![open(0, redacted.clone()), stop(0)], signed(1, "hm", "sig"), tool(2, "toolu_1", "{}")]).await;
    assert_eq!(failure.partial_thinking_blocks, vec![redacted.clone(), thinking_hm()]);
    let next = continuation(&calls, &failure);
    assert_eq!(types(&next), ["redacted_thinking", "thinking", "tool_use"]);
    assert_eq!(next[0], redacted);
    assert_eq!(next.iter().filter(|b| b["type"] == "tool_use").count(), 1);
}

#[tokio::test]
async fn a_tool_input_still_streaming_is_not_replayed_and_the_completed_call_runs_once() {
    let client = vec![open(2, json!({ "type": "tool_use", "id": "toolu_b", "name": "lookup" })), delta(2, json!({ "type": "input_json_delta", "partial_json": "{\"ke" }))];
    let native = vec![
        open(2, json!({ "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {} })),
        delta(2, json!({ "type": "input_json_delta", "partial_json": "{\"qu" })),
    ];
    for (kind, unfinished) in [("client", client), ("native", native)] {
        let (calls, failure) = cut(vec![signed(0, "hm", "sig"), tool(1, "toolu_a", "{}"), unfinished]).await;
        assert_eq!(calls.len(), 1, "{kind}: only the finished call was dispatched");
        let exact = json!([thinking_hm(), tool_use("toolu_a", json!({}))]);
        assert_eq!(failure.partial_replay.as_ref().expect("the finished blocks").items, exact, "{kind}");
        assert_eq!(failure.partial_thinking_blocks, vec![thinking_hm()], "{kind}");
        let next = continuation(&calls, &failure);
        assert_eq!(Value::Array(next.clone()), exact, "{kind}");
        assert_eq!(next.iter().filter(|b| b["type"] == "tool_use").count(), 1, "{kind}: the finished call runs once");
    }
}

/// A body fault (the connection under the stream ended) reports what the stream had exposed as the decoder's own
/// truncation does: the loop reads `tool_input_cut` to replay a half-streamed call with the split-call notice, and
/// `tool_dispatched` to never replay past a call that ran.
#[tokio::test]
async fn a_body_fault_reports_the_tool_input_it_cut_and_the_call_it_dispatched() {
    let unfinished = vec![open(1, json!({ "type": "tool_use", "id": "toolu_b", "name": "lookup" })), delta(1, json!({ "type": "input_json_delta", "partial_json": "{\"ke" }))];

    let (calls, failure) = cut(vec![signed(0, "hm", "sig"), unfinished.clone()]).await;
    assert!(calls.is_empty());
    assert_eq!(failure.transport, Some(TransportFault::Reset));
    assert!(failure.exposure.tool_input_cut, "the input was still streaming");
    assert!(failure.exposure.text_emitted, "thinking shown is an exposure");
    assert!(!failure.exposure.tool_dispatched);

    let (calls, failure) = cut(vec![tool(0, "toolu_a", "{}"), unfinished]).await;
    assert_eq!(calls.len(), 1);
    assert!(failure.exposure.tool_input_cut && failure.exposure.tool_dispatched, "{:?}", failure.exposure);

    let (calls, failure) = cut(vec![tool(0, "toolu_a", "{}")]).await;
    assert_eq!(calls.len(), 1);
    assert!(!failure.exposure.tool_input_cut, "every input finished: nothing was cut");
    assert!(failure.exposure.tool_dispatched);

    let (_, failure) = cut(vec![]).await;
    assert_eq!(failure.exposure, mixdog_core_api::domain::provider::Exposure::default(), "nothing shown: replay-safe");
}

const OVERFLOW: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 16384 > 200000, decrease input length or `max_tokens` and try again"}}"#;

const TURN: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

/// A replay the adapter issues itself (here the `max_tokens` shrink after a context-overflow 400) is a real exchange: it
/// begins an attempt of its own, whose head, first payload and first output are its own, and the refused one has none.
#[tokio::test]
async fn an_internal_retry_is_an_attempt_of_its_own() {
    use mixdog_core_api::domain::provider::Boundary;

    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let options = RequestOptions { send_identity: identity.clone(), ..RequestOptions::default() };
    let http = ScriptedHttp::new([Scripted::body(400, OVERFLOW), Scripted::body(200, TURN)]);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http.clone(), Arc::new(FixedKey), cpu_bulk());
    let mut stream = adapter.attempt(Arc::new(request(base_messages(), options))).await.expect("the replay answers");
    while stream.next().await.is_some() {}
    assert_eq!(http.sent().len(), 2, "the refused request and its replay");
    let log = identity.take_boundaries();
    let started: Vec<u64> = log.iter().filter(|(_, b)| *b == Boundary::AttemptStarted).map(|(id, ..)| *id).collect();
    assert_eq!(started.len(), 2, "one attempt per exchange");
    assert_ne!(started[0], started[1]);
    let seen = |id: u64, boundary: Boundary| log.iter().any(|(i, b)| *i == id && *b == boundary);
    assert!(seen(started[0], Boundary::HeadReceived), "the refusal's head arrived: it was a response, only an unwelcome one");
    for boundary in [Boundary::HeadReceived, Boundary::FirstProtocolPayload, Boundary::FirstSemanticOutput] {
        assert!(seen(started[1], boundary), "{boundary:?} of the replay");
    }
    for boundary in [Boundary::FirstProtocolPayload, Boundary::FirstSemanticOutput] {
        assert!(!seen(started[0], boundary), "{boundary:?} is not inherited by or from the refused one");
    }
}

/// The non-streaming recovery is a model submission like any other: an attempt of the driver (one generation total over head
/// and body), never one that is left to the transport's own liveness.
#[tokio::test]
async fn the_non_streaming_recovery_is_a_driven_attempt_of_its_own() {
    use mixdog_core_api::domain::provider::Boundary;

    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let options = RequestOptions { send_identity: identity.clone(), ..RequestOptions::default() };
    let message = r#"{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#;
    let http = ScriptedHttp::new([Scripted::body(200, message)]);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
    let mut stream = adapter.recover_spent(Arc::new(request(base_messages(), options))).await.expect("recovered");
    while stream.next().await.is_some() {}
    let log = identity.take_boundaries();
    let started = log.iter().filter(|(_, b)| *b == Boundary::AttemptStarted).count();
    assert_eq!(started, 1, "one attempt");
}

/// The head of a response marks nothing; the first body chunk marks transport, though it decodes to no event.
#[tokio::test]
async fn the_response_head_marks_no_transport_and_a_body_chunk_does() {
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let options = RequestOptions { send_identity: identity.clone(), ..RequestOptions::default() };
    let http = ScriptedHttp::new([Scripted { status: 200, headers: Vec::new(), chunks: vec![b": keep\n\n".to_vec()], fault: None }]);
    let store = MemoryStore::signed_in();
    // The credential file lives as long as its store: the test keeps it.
    let mut stream = oauth_adapter(http, store.clone()).attempt(Arc::new(request(base_messages(), options))).await.expect("the head arrived");
    assert!(!identity.take_transport(), "the head alone is not a body read");
    let _ = stream.next().await;
    assert!(identity.take_transport(), "the comment-only chunk was read");
}
