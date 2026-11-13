//! The recoveries one attempt of the Anthropic routes makes, and the 400s it types for the agent loop, against the
//! Node functions they mirror (no recording of these exists; each test states the function it follows):
//! `adjustMaxTokensForContextOverflow` (anthropic-max-tokens-recovery.mjs) as both routes call it
//! (`withBodyRecovery`, anthropic-api-transport.mjs; `_openResponse`, anthropic-oauth.mjs), `isThinkingReplayRejection`
//! (thinking-replay-recovery.mjs), `rejectedToolSchema` (tool-schema-rejection.mjs) and the non-streaming re-issue of a
//! stream that died (`decideStreamError`, anthropic-midstream-recovery.mjs; `issueNonStreamingFallback`).

use std::sync::Arc;

use serde_json::Value;

use super::*;

const OVERFLOW: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 16384 > 200000, decrease input length or `max_tokens` and try again"}}"#;

const TURN: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

fn request() -> ModelRequest {
    ModelRequest { model: "claude-sonnet-4-6".into(), messages: vec![text_message(Role::User, "hi")], tools: tools(), options: RequestOptions::default() }
}

fn api_adapter(http: Arc<ScriptedHttp>) -> AnthropicAdapter {
    AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk())
}

fn body_of(sent: &mixdog_core_api::domain::provider::WireRequest) -> Value {
    serde_json::from_slice(&sent.body).expect("a JSON body")
}

async fn text_of(mut stream: Box<dyn ModelStream>) -> String {
    let mut text = String::new();
    for item in drain(stream.as_mut()).await {
        match item.expect("no failure") {
            StreamEvent::TextDelta(delta) | StreamEvent::FinalContent(delta) => text.push_str(&delta),
            _ => {}
        }
    }
    text
}

/// Both routes: the overflow 400 shrinks `max_tokens` to `limit - input - 1000` (9000 here) and the same request is
/// replayed once; nothing else of the body changes.
#[tokio::test]
async fn a_context_overflow_400_shrinks_max_tokens_and_replays_once_on_both_routes() {
    for route in ["anthropic", "anthropic-oauth"] {
        let http = ScriptedHttp::new([Scripted::body(400, OVERFLOW), Scripted::body(200, TURN)]);
        // The credential file lives as long as its store.
        let store = MemoryStore::signed_in();
        let adapter = match route {
            "anthropic" => api_adapter(http.clone()),
            _ => oauth_adapter(http.clone(), store.clone()),
        };
        let stream = adapter.attempt(Arc::new(request())).await.unwrap_or_else(|err| panic!("{route}: {err:?}"));
        assert_eq!(text_of(stream).await, "ok", "{route}");
        let sent = http.sent();
        assert_eq!(sent.len(), 2, "{route}: the refused request and its replay");
        let (first, second) = (body_of(&sent[0]), body_of(&sent[1]));
        assert_ne!(first["max_tokens"], 9000, "{route}");
        assert_eq!(second["max_tokens"], 9000, "{route}");
        let mut restored = second.clone();
        restored["max_tokens"] = first["max_tokens"].clone();
        assert_eq!(restored, first, "{route}: only max_tokens changed");
    }
}

/// `tokensAdjusted` / `maxTokensAdjusted`: a second overflow of the same attempt is not adjusted again and surfaces, as
/// does one that leaves less than the floor.
#[tokio::test]
async fn a_second_overflow_and_one_below_the_floor_surface() {
    let http = ScriptedHttp::new([Scripted::body(400, OVERFLOW), Scripted::body(400, OVERFLOW)]);
    let err = api_adapter(http.clone()).attempt(Arc::new(request())).await.err().expect("the second refusal surfaces");
    assert_eq!((err.status, http.sent().len()), (Some(400), 2));

    let tight = OVERFLOW.replace("190000", "198000");
    let http = ScriptedHttp::new([Scripted::body(400, &tight)]);
    let err = api_adapter(http.clone()).attempt(Arc::new(request())).await.err().expect("no room is left");
    assert_eq!((err.status, err.kind, http.sent().len()), (Some(400), ErrorKind::InvalidRequest, 1));
}

/// The two 400s a changed request clears are typed where the refusal is read: a refused reasoning replay as
/// `ReplayRejected`, a refused tool schema as `ToolSchemaRejected` naming the request's tool at the stated position.
#[tokio::test]
async fn the_replay_and_tool_schema_refusals_are_typed_for_the_loop() {
    let refusal = |message: &str| format!(r#"{{"type":"error","error":{{"type":"invalid_request_error","message":"{message}"}}}}"#);
    for route in ["anthropic", "anthropic-oauth"] {
        let store = MemoryStore::signed_in();
        let adapter = |http: Arc<ScriptedHttp>| match route {
            "anthropic" => api_adapter(http),
            _ => oauth_adapter(http, store.clone()),
        };
        let replay = refusal("messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.");
        let err = adapter(ScriptedHttp::new([Scripted::body(400, &replay)])).attempt(Arc::new(request())).await.err().expect("refused");
        assert_eq!((err.kind, err.status), (ErrorKind::ReplayRejected, Some(400)), "{route}");

        let schema = refusal("tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12");
        let err = adapter(ScriptedHttp::new([Scripted::body(400, &schema)])).attempt(Arc::new(request())).await.err().expect("refused");
        assert_eq!((err.kind, err.rejected_tool.as_deref()), (ErrorKind::ToolSchemaRejected, Some("lookup")), "{route}");

        // A position the request has no tool at names nothing: the refusal stays an invalid request.
        let other = refusal("tools.7.custom.input_schema: JSON schema is invalid");
        let err = adapter(ScriptedHttp::new([Scripted::body(400, &other)])).attempt(Arc::new(request())).await.err().expect("refused");
        assert_eq!((err.kind, err.rejected_tool.as_deref()), (ErrorKind::InvalidRequest, None), "{route}");
    }
}

/// `decideStreamError`: shown text or thinking, or a stall that showed nothing, is answered by the non-streaming
/// re-issue; a dispatched tool call and a cut tool input never are, and a truncated stream that showed nothing keeps
/// the streaming ladder.
#[test]
fn a_dead_stream_is_reissued_only_where_node_reissues_it() {
    use mixdog_core_api::domain::provider::StreamTimeoutPhase;
    let adapter = api_adapter(ScriptedHttp::new([]));
    let cut = || ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    assert!(!adapter.recovers_cut("m", &cut()), "nothing shown: the stream is retried");
    let mut shown = cut();
    shown.exposure.text_emitted = true;
    assert!(adapter.recovers_cut("m", &shown));
    let mut stalled = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    stalled.timeout_phase = Some(StreamTimeoutPhase::Idle);
    assert!(adapter.recovers_cut("m", &stalled));
    let mut dispatched = shown.clone();
    dispatched.exposure.tool_dispatched = true;
    assert!(!adapter.recovers_cut("m", &dispatched));
    let mut input_cut = shown;
    input_cut.exposure.tool_input_cut = true;
    assert!(!adapter.recovers_cut("m", &input_cut));
}

/// `issueNonStreamingFallback`: the same request with `stream: false` under the non-streaming timeout, its whole
/// response the turn; a failure of it ends the send's recovery (`markProviderRecoveryExhausted`).
#[tokio::test]
async fn the_reissue_is_the_same_request_without_streaming() {
    let message = r#"{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"whole"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}"#;
    let http = ScriptedHttp::new([Scripted::body(200, TURN), Scripted::body(200, message)]);
    let adapter = api_adapter(http.clone());
    drop(adapter.attempt(Arc::new(request())).await.expect("the stream opens"));
    let stream = adapter.recover_spent(Arc::new(request())).await.expect("the re-issue answers");
    assert_eq!(text_of(stream).await, "whole");
    let sent = http.sent();
    let (streamed, whole) = (body_of(&sent[0]), body_of(&sent[1]));
    assert_eq!((streamed["stream"].clone(), whole["stream"].clone()), (Value::Bool(true), Value::Bool(false)));
    let mut restored = whole.clone();
    restored["stream"] = Value::Bool(true);
    assert_eq!(restored, streamed, "only `stream` changed");
    assert!(sent[1].headers.iter().any(|(name, value)| name == "x-stainless-timeout" && value == "300"));

    let http = ScriptedHttp::new([Scripted::body(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#)]);
    let err = api_adapter(http).recover_spent(Arc::new(request())).await.err().expect("the re-issue is refused");
    assert!(err.recovery_exhausted);
}
