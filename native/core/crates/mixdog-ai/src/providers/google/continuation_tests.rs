//! The long decode of the Gemini API (`gemini.mjs` `_doSend`): each hop runs its own attempts, and every finished hop's
//! usage reaches the caller whether the turn completes, fails or is cancelled, on the stream and on the unary recovery.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::{
    Content, Message, ModelRequest, ModelStream, ProviderAdapter, ProviderError, RequestOptions, Role, SendEnd, StreamEvent, TransportFault, WireRequest,
};
use serde_json::{Value, json};

use crate::providers::google::traits::CatalogGoogleTraits;
use crate::transport::{BodyStream, Exchange, HttpResponse, HttpSend};

/// Answers each request with the next scripted reply; `None` is a server that never answers.
#[derive(Default)]
struct Script {
    sent: Mutex<Vec<WireRequest>>,
    replies: Mutex<VecDeque<Option<(u16, Vec<(String, String)>, Chunks)>>>,
    /// Each answered body as it is let go of: whether it was handed on to be read off.
    released: Arc<Mutex<Vec<bool>>>,
}

impl Script {
    fn answer(&self, status: u16, chunks: impl IntoIterator<Item = Result<Bytes, TransportFault>>) {
        self.answer_with(status, vec![], chunks);
    }

    fn answer_with(&self, status: u16, headers: Vec<(String, String)>, chunks: impl IntoIterator<Item = Result<Bytes, TransportFault>>) {
        let body = Chunks { chunks: chunks.into_iter().collect(), marked: false, released: self.released.clone() };
        self.replies.lock().unwrap().push_back(Some((status, headers, body)));
    }

    fn silent(&self) {
        self.replies.lock().unwrap().push_back(None);
    }

    fn tokens(&self) -> Vec<Option<String>> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|wire| {
                let body: Value = serde_json::from_slice(&wire.body).unwrap();
                body.get("continuationToken").and_then(Value::as_str).map(str::to_owned)
            })
            .collect()
    }
}

struct Chunks {
    chunks: VecDeque<Result<Bytes, TransportFault>>,
    marked: bool,
    released: Arc<Mutex<Vec<bool>>>,
}

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.chunks.pop_front()
    }

    fn drain_on_drop(&mut self) {
        self.marked = true;
    }
}

impl Drop for Chunks {
    fn drop(&mut self) {
        self.released.lock().unwrap().push(self.marked);
    }
}

#[async_trait]
impl HttpSend for Script {
    async fn send(&self, wire: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(wire);
        let reply = self.replies.lock().unwrap().pop_front().expect("unexpected send");
        let Some((status, headers, body)) = reply else { return std::future::pending().await };
        Ok(HttpResponse { status, headers, body: Box::new(body) })
    }
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "gemini-3.6-flash".into(),
        messages: vec![Message::new(Role::User, Content::Text("hello".into()))],
        tools: vec![],
        options: RequestOptions::default(),
    }
}

fn adapter(http: Arc<Script>) -> super::GoogleAdapter {
    crate::providers::google::gemini("k", http, Arc::new(CatalogGoogleTraits(Vec::new())))
}

/// One response's candidate and usage: `token` ends it `CONTINUATION`, else `STOP`.
fn hop(text: &str, token: Option<&str>, prompt: u64, output: u64) -> Value {
    let mut candidate = json!({"content": {"parts": [{"text": text}]}, "finishReason": "STOP"});
    if let Some(token) = token {
        candidate["finishReason"] = json!("CONTINUATION");
        candidate["continuationToken"] = json!(token);
    }
    json!({"candidates": [candidate], "usageMetadata": {"promptTokenCount": prompt, "candidatesTokenCount": output}})
}

fn sse(chunk: &Value) -> Result<Bytes, TransportFault> {
    Ok(Bytes::from(format!("data: {chunk}\n\n")))
}

fn unary(chunk: &Value) -> Result<Bytes, TransportFault> {
    Ok(Bytes::from(chunk.to_string()))
}

/// The text, the last usage and the completion of a stream that does not fail.
async fn drain(stream: &mut dyn ModelStream) -> (String, Option<mixdog_core_api::domain::provider::Usage>, bool) {
    let (mut text, mut usage, mut completed) = (String::new(), None, false);
    while let Some(event) = stream.next().await {
        match event.expect("no failure") {
            StreamEvent::TextDelta(delta) => text.push_str(&delta),
            StreamEvent::Usage(total) => usage = Some(total),
            StreamEvent::Completed { .. } => completed = true,
            _ => {}
        }
    }
    (text, usage, completed)
}

async fn failure(stream: &mut dyn ModelStream) -> ProviderError {
    while let Some(event) = stream.next().await {
        if let Err(error) = event {
            return error;
        }
    }
    panic!("the stream ended without a failure");
}

/// The first hop showed text, so the turn cannot be replayed; its second hop is still the hop's own request, retried with
/// its token on its own ladders: a 503 before the response opened, then a response that ended before any chunk.
#[tokio::test(start_paused = true)]
async fn a_continued_hop_is_retried_with_its_token_after_the_turn_showed_text() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    http.answer(503, [Ok(Bytes::from_static(br#"{"error":{"code":503,"status":"UNAVAILABLE","message":"busy"}}"#))]);
    http.answer(200, []);
    http.answer(200, [sse(&hop("two", None, 12, 3))]);
    let adapter = adapter(http.clone());
    let mut stream = adapter.attempt(Arc::new(request())).await.expect("the first hop answers");
    let (text, usage, completed) = drain(stream.as_mut()).await;
    assert_eq!(text, "one two");
    assert!(completed);
    let usage = usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (22, 5), "the finished hops are billed in sum");
    assert_eq!(http.tokens(), [None, Some("tok-1".into()), Some("tok-1".into()), Some("tok-1".into())]);
}

/// A continued hop that showed text of its own is past its replay boundary: its cut ends the turn, unsafe to retry, with
/// the usage the hops reported.
#[tokio::test(start_paused = true)]
async fn a_continued_hop_that_showed_text_is_not_resent() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    http.answer(200, [sse(&json!({"candidates": [{"content": {"parts": [{"text": "tw"}]}}]})), Err(TransportFault::TruncatedStream)]);
    let adapter = adapter(http.clone());
    let mut stream = adapter.attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert!(err.unsafe_to_retry && err.exposure.text_emitted, "{err:?}");
    let usage = err.partial_usage.clone().expect("the first hop's usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (10, 2));
    assert_eq!(http.sent.lock().unwrap().len(), 2);
}

fn busy() -> Result<Bytes, TransportFault> {
    Ok(Bytes::from_static(br#"{"error":{"code":503,"status":"UNAVAILABLE","message":"busy"}}"#))
}

fn urls(http: &Script) -> Vec<String> {
    http.sent.lock().unwrap().iter().map(|wire| wire.url.rsplit(':').next().unwrap_or_default().to_owned()).collect()
}

/// A recovered answer that ends `CONTINUATION` is the first hop: the next hop goes back to the stream with the token
/// (`_doSend` resends through `_streamViaRest`), and every hop is billed.
#[tokio::test]
async fn a_recovered_answer_that_continues_streams_its_next_hop() {
    let http = Arc::new(Script::default());
    http.answer(200, [unary(&hop("one ", Some("tok-1"), 10, 2))]);
    http.answer(200, [sse(&hop("two", None, 12, 3))]);
    let adapter = adapter(http.clone());
    let mut stream = adapter.recover_spent(Arc::new(request())).await.expect("the unary answer");
    let (text, usage, completed) = drain(stream.as_mut()).await;
    assert_eq!(text, "one two");
    assert!(completed);
    let usage = usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (22, 5));
    let raw = usage.raw.expect("raw usage");
    assert_eq!((raw["initialPromptTokenCount"].clone(), raw["initialCachedContentTokenCount"].clone()), (json!(10), json!(0)));
    assert_eq!(http.tokens(), [None, Some("tok-1".into())]);
    assert_eq!(urls(&http), ["generateContent", "streamGenerateContent?alt=sse"]);
}

/// `GEMINI_MAX_CONTINUATION_HOPS` counts the recovered hop: the 32nd answer that still continues ends the turn, carrying
/// all 32 hops' usage.
#[tokio::test]
async fn a_recovered_long_decode_stops_at_thirty_two_hops() {
    let http = Arc::new(Script::default());
    http.answer(200, [unary(&hop("x", Some("t"), 10, 1))]);
    for _ in 1..32 {
        http.answer(200, [sse(&hop("x", Some("t"), 10, 1))]);
    }
    let adapter = adapter(http.clone());
    let mut stream = adapter.recover_spent(Arc::new(request())).await.expect("the unary answer");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.code.as_deref(), Some("CONTINUATION_LIMIT"));
    let usage = err.partial_usage.clone().expect("the hops' usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (320, 32));
    assert_eq!(http.sent.lock().unwrap().len(), 32);
}

/// A continued hop whose stream ladder is spent on responses that showed nothing is re-issued once as `generateContent`
/// with its token (`_recoverGeminiNonStreaming`), and that answer is the hop's.
#[tokio::test(start_paused = true)]
async fn a_spent_continued_hop_is_recovered_without_streaming_with_its_token() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [Err(TransportFault::TruncatedStream)]);
    }
    http.answer(200, [unary(&hop("two", None, 12, 3))]);
    let adapter = adapter(http.clone());
    let mut stream = adapter.attempt(Arc::new(request())).await.expect("the first hop answers");
    let (text, usage, completed) = drain(stream.as_mut()).await;
    assert_eq!(text, "one two");
    assert!(completed);
    let usage = usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (22, 5));
    assert_eq!(http.tokens(), [None, Some("tok-1".into()), Some("tok-1".into()), Some("tok-1".into()), Some("tok-1".into()), Some("tok-1".into())]);
    assert_eq!(urls(&http).last().map(String::as_str), Some("generateContent"));
}

/// A continued hop's response cut by a malformed chunk before its end is given up as it fails: let go of unmarked, so it is
/// reset, never kept until the re-issue's completion marks it to be read off.
#[tokio::test(start_paused = true)]
async fn a_given_up_hop_response_is_let_go_of_unmarked_before_the_recovered_completion() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [Ok(Bytes::from_static(b"data: {not json\n\n")), sse(&hop("two", None, 12, 3))]);
    }
    http.answer(200, [unary(&hop("two", None, 12, 3))]);
    let adapter = adapter(http.clone());
    let mut stream = adapter.attempt(Arc::new(request())).await.expect("the first hop answers");
    while !matches!(stream.next().await.expect("the completion").expect("no failure"), StreamEvent::Completed { .. }) {}
    assert_eq!(urls(&http).last().map(String::as_str), Some("generateContent"), "the spent hop is re-issued");
    assert_eq!(*http.released.lock().unwrap(), [false; 6], "every hop's response and the re-issue's, let go of unmarked");
    drop(stream);
    assert_eq!(*http.released.lock().unwrap(), [false; 6]);
}

/// Each continued hop is judged on its own answer: after a visible first hop, an empty `STOP` or an empty
/// `MALFORMED_FUNCTION_CALL` is re-asked (`geminiInvalidStreamReask`), and the re-asked answer finishes the turn.
#[tokio::test(start_paused = true)]
async fn an_unusable_continued_hop_is_re_asked() {
    let empty_stop = json!({"candidates": [{"content": {"parts": [{"text": ""}]}, "finishReason": "STOP"}]});
    let malformed = json!({"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL"}]});
    for unusable in [empty_stop, malformed] {
        let http = Arc::new(Script::default());
        http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
        http.answer(200, [sse(&unusable)]);
        http.answer(200, [sse(&hop("two", None, 12, 3))]);
        let adapter = adapter(http.clone());
        let mut stream = adapter.attempt(Arc::new(request())).await.expect("the first hop answers");
        let (text, _, completed) = drain(stream.as_mut()).await;
        assert_eq!(text, "one two", "{unusable}");
        assert!(completed);
        assert_eq!(http.tokens(), [None, Some("tok-1".into()), Some("tok-1".into())]);
    }
}

/// An empty `STOP` that answers a tool result is the model's answer on a continued hop too; one that survives every
/// re-ask otherwise is a terminal failure, not an answer.
#[tokio::test(start_paused = true)]
async fn an_empty_continued_hop_stands_after_a_tool_result_and_fails_once_spent() {
    use mixdog_core_api::domain::provider::ToolCall;
    let empty_stop = || sse(&json!({"candidates": [{"content": {"parts": [{"text": ""}]}, "finishReason": "STOP"}]}));

    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    http.answer(200, [empty_stop()]);
    let mut asked = request();
    let call = ToolCall { id: "c1".into(), name: "lookup".into(), arguments: json!({}), native_type: None };
    let mut assistant = Message::new(Role::Assistant, Content::Text(String::new().into()));
    assistant.tool_calls.push(call);
    let mut result = Message::new(Role::Tool, Content::Text("42".into()));
    result.tool_call_id = Some("c1".into());
    asked.messages.extend([assistant, result]);
    let mut stream = adapter(http.clone()).attempt(Arc::new(asked)).await.expect("the first hop answers");
    let (text, _, completed) = drain(stream.as_mut()).await;
    assert_eq!(text, "one ");
    assert!(completed);
    assert_eq!(http.sent.lock().unwrap().len(), 2);

    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [empty_stop()]);
    }
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.code.as_deref(), Some("no_response_text"));
    assert!(err.recovery_terminal && err.unsafe_to_retry, "{err:?}");
    assert_eq!(http.sent.lock().unwrap().len(), 5);
}

/// Every attempt a continued hop discards was billed, and none is lost to a later rollback: without a ledger each is
/// carried in the turn's sum (10 + 2 + 3 + 4); with one, each is its own row beside the delivered answer's.
#[tokio::test(start_paused = true)]
async fn discarded_hop_attempts_keep_their_usage_across_every_rollback() {
    use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
    use crate::registry::accounting::UsageSink;
    let script = || {
        let http = Arc::new(Script::default());
        http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 0))]);
        for prompt in [2, 3] {
            http.answer(200, [sse(&json!({"usageMetadata": {"promptTokenCount": prompt}})), Err(TransportFault::TruncatedStream)]);
        }
        http.answer(200, [sse(&hop("two", None, 4, 0))]);
        http
    };

    let mut stream = adapter(script()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let (text, usage, _) = drain(stream.as_mut()).await;
    assert_eq!(text, "one two");
    assert_eq!(usage.expect("usage").input_tokens, 19);

    let (tx, mut rows) = tokio::sync::mpsc::unbounded_channel();
    let sink: Arc<dyn UsageSink> = Arc::new(RowSink(tx));
    let deps = AccountingDeps::new(Arc::new(TokenPricing), Arc::new(move || Some(sink.clone())));
    let accounted = AccountedAdapter::wrap(Arc::new(adapter(script())), "gemini", Arc::new(deps));
    let mut asked = request();
    asked.options.send_group = Some("group".into());
    let mut stream = accounted.attempt(Arc::new(asked)).await.expect("the first hop answers");
    let (_, usage, completed) = drain(stream.as_mut()).await;
    assert!(completed);
    assert_eq!(usage.expect("usage").input_tokens, 14, "the delivered answer's own hops");
    drop(stream);
    accounted.settle_send("group", SendEnd::Surfaced).await;
    drop(accounted);
    let mut inputs = Vec::new();
    while let Some(row) = rows.recv().await {
        inputs.push(row.input);
    }
    inputs.sort_by(f64::total_cmp);
    assert_eq!(inputs, [2.0, 3.0, 14.0]);
}

/// A continued hop that fails after the first reported usage still bills the first: on the failure once its ladders and
/// its re-issue are spent, and on the cancelled row when the wait for the second hop is abandoned.
#[tokio::test(start_paused = true)]
async fn a_failed_or_cancelled_hop_after_a_recovered_answer_keeps_the_first_hops_usage() {
    use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
    use crate::registry::accounting::UsageSink;

    let http = Arc::new(Script::default());
    http.answer(200, [unary(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..11 {
        http.answer(503, [busy()]);
    }
    let mut stream = adapter(http.clone()).recover_spent(Arc::new(request())).await.expect("the unary answer");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.status, Some(503));
    let usage = err.partial_usage.clone().expect("the first hop's usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (10, 2));
    assert_eq!(http.sent.lock().unwrap().len(), 12, "the recovered hop, ten streamed attempts and one re-issue");

    let http = Arc::new(Script::default());
    http.answer(200, [unary(&hop("one ", Some("tok-1"), 10, 2))]);
    http.silent();
    let (tx, mut rows) = tokio::sync::mpsc::unbounded_channel();
    let sink: Arc<dyn UsageSink> = Arc::new(RowSink(tx));
    let deps = AccountingDeps::new(Arc::new(TokenPricing), Arc::new(move || Some(sink.clone())));
    let accounted = AccountedAdapter::wrap(Arc::new(adapter(http.clone())), "gemini", Arc::new(deps));
    let mut asked = request();
    asked.options.send_group = Some("group".into());
    let waited = tokio::time::timeout(Duration::from_secs(1), accounted.recover_spent(Arc::new(asked))).await;
    assert!(waited.is_err(), "the second hop never answers");
    assert_eq!(http.sent.lock().unwrap().len(), 2);
    accounted.settle_send("group", SendEnd::Cancelled).await;
    drop(accounted);
    let row = rows.recv().await.expect("the cancelled attempt's row");
    assert_eq!((row.status.as_str(), row.input, row.output), ("cancelled", 10.0, 2.0));
}

/// A continued hop that answers an empty `MALFORMED_FUNCTION_CALL` on every one of its four attempts ends the turn with the
/// incomplete error (`geminiIncompleteError`, its recovery spent), never the first hop's text as a completed answer.
#[tokio::test(start_paused = true)]
async fn a_repeatedly_malformed_continued_hop_fails_the_turn() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [sse(&json!({"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL"}]}))]);
    }
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.code.as_deref(), Some("PROVIDER_INCOMPLETE"));
    assert_eq!(err.finish_reason.as_deref(), Some("MALFORMED_FUNCTION_CALL"));
    assert!(err.recovery_exhausted && err.unsafe_to_retry, "{err:?}");
    assert_eq!(http.sent.lock().unwrap().len(), 5, "four attempts of the hop, no more");
}

/// The last attempt of a spent hop reported usage and ended without a finish reason, and its re-issue failed: that
/// attempt's tokens are its own abandoned row, and the failed turn carries only the finished hop's.
#[tokio::test(start_paused = true)]
async fn a_failed_hop_re_issue_counts_the_last_attempts_usage_once() {
    use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
    use crate::registry::accounting::UsageSink;
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 0))]);
    for prompt in [2, 3, 4, 5] {
        http.answer(200, [sse(&json!({"usageMetadata": {"promptTokenCount": prompt}}))]);
    }
    http.answer(503, [busy()]);
    let (tx, mut rows) = tokio::sync::mpsc::unbounded_channel();
    let sink: Arc<dyn UsageSink> = Arc::new(RowSink(tx));
    let deps = AccountingDeps::new(Arc::new(TokenPricing), Arc::new(move || Some(sink.clone())));
    let accounted = AccountedAdapter::wrap(Arc::new(adapter(http.clone())), "gemini", Arc::new(deps));
    let mut asked = request();
    asked.options.send_group = Some("group".into());
    let mut stream = accounted.attempt(Arc::new(asked)).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.partial_usage.clone().expect("the finished hop's usage").input_tokens, 10);
    assert_eq!(urls(&http).last().map(String::as_str), Some("generateContent"), "the re-issue was tried");
    drop(stream);
    accounted.settle_send("group", SendEnd::Surfaced).await;
    drop(accounted);
    let mut inputs = Vec::new();
    while let Some(row) = rows.recv().await {
        inputs.push(row.input);
    }
    inputs.sort_by(f64::total_cmp);
    assert_eq!(inputs, [2.0, 3.0, 4.0, 5.0, 10.0]);
}

/// A server wait over 300 s ends a continued hop's recovery (`hasLongAdvice`): no further attempt, and no non-streaming
/// re-issue either.
#[tokio::test(start_paused = true)]
async fn a_continued_hop_told_to_wait_over_five_minutes_is_not_re_issued() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    http.answer_with(503, vec![("retry-after".into(), "301".into())], [busy()]);
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!((err.status, err.retry_after), (Some(503), Some(Duration::from_secs(301))));
    assert!(err.recovery_terminal && err.recovery_exhausted, "{err:?}");
    assert_eq!(http.sent.lock().unwrap().len(), 2, "no fallback request");
}

/// `hasLongAdvice` on the first hop's opened stream: an in-band 503 advising 301 s before any output ends the provider's
/// recovery, with no `generateContent` re-issue, whichever way the failure carries the advice.
#[tokio::test]
async fn long_advice_on_the_first_hops_opened_stream_ends_recovery() {
    let http = Arc::new(Script::default());
    let in_band = json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "busy",
        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "301s"}]}});
    http.answer(200, [sse(&in_band)]);
    let adapter = adapter(http.clone());
    let asked = request();
    let mut stream = adapter.attempt(Arc::new(asked.clone())).await.expect("the stream opens");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.retry_after, Some(Duration::from_secs(301)));
    assert!(err.recovery_terminal && err.recovery_exhausted, "{err:?}");
    assert!(!adapter.recovers_spent(&asked, &err), "no non-streaming re-issue");
    let mut unmarked = err.clone();
    (unmarked.recovery_terminal, unmarked.recovery_exhausted) = (false, false);
    assert!(!adapter.recovers_spent(&asked, &unmarked), "the advice alone rules the re-issue out");
    assert_eq!(http.sent.lock().unwrap().len(), 1);
}

/// The non-streaming re-issue's answer is judged like any answer of the hop: after a visible first hop, a recovered
/// `MALFORMED_FUNCTION_CALL` with no calls is not re-asked but fails the turn (`geminiIncompleteError`).
#[tokio::test(start_paused = true)]
async fn a_malformed_re_issued_hop_fails_the_turn() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [Err(TransportFault::TruncatedStream)]);
    }
    http.answer(200, [unary(&json!({"candidates": [{"finishReason": "MALFORMED_FUNCTION_CALL"}]}))]);
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.code.as_deref(), Some("PROVIDER_INCOMPLETE"));
    assert_eq!(err.finish_reason.as_deref(), Some("MALFORMED_FUNCTION_CALL"));
    assert!(err.recovery_exhausted && err.unsafe_to_retry, "{err:?}");
    assert_eq!(urls(&http).last().map(String::as_str), Some("generateContent"));
    assert_eq!(http.sent.lock().unwrap().len(), 6, "the re-issued answer is not re-asked");
}

/// The re-issued answer's own text keeps it from being re-asked, not from failing: with text of its own and a malformed
/// finish it is `PROVIDER_INCOMPLETE`, never a completed turn.
#[tokio::test(start_paused = true)]
async fn a_re_issued_hop_with_text_and_a_malformed_finish_fails_the_turn() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [Err(TransportFault::TruncatedStream)]);
    }
    http.answer(200, [unary(&json!({"candidates": [{"content": {"parts": [{"text": "two"}]}, "finishReason": "MALFORMED_FUNCTION_CALL"}]}))]);
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let err = failure(stream.as_mut()).await;
    assert_eq!(err.code.as_deref(), Some("PROVIDER_INCOMPLETE"));
    assert_eq!(err.finish_reason.as_deref(), Some("MALFORMED_FUNCTION_CALL"));
    assert_eq!(http.sent.lock().unwrap().len(), 6, "the re-issued answer is not re-asked");
}

/// The re-issued answer is judged by the merged turn's finish alone (`geminiIncompleteError`): an empty `STOP` after the
/// first hop's text completes the turn with that text.
#[tokio::test(start_paused = true)]
async fn an_empty_re_issued_stop_completes_with_the_earlier_text() {
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&hop("one ", Some("tok-1"), 10, 2))]);
    for _ in 0..4 {
        http.answer(200, [Err(TransportFault::TruncatedStream)]);
    }
    http.answer(200, [unary(&json!({"candidates": [{"content": {"parts": [{"text": ""}]}, "finishReason": "STOP"}]}))]);
    let mut stream = adapter(http.clone()).attempt(Arc::new(request())).await.expect("the first hop answers");
    let (text, _, completed) = drain(stream.as_mut()).await;
    assert_eq!(text, "one ");
    assert!(completed);
    assert_eq!(http.sent.lock().unwrap().len(), 6);
}

/// A rollback leaves the attempt's observation equal to the restored decoding, empty included: the first hop reported
/// no usage, the discarded attempt's five tokens are its abandoned row, and the cancelled turn books none of them again.
#[tokio::test(start_paused = true)]
async fn a_rollback_to_no_usage_clears_the_observation() {
    use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
    use crate::registry::accounting::UsageSink;
    let http = Arc::new(Script::default());
    http.answer(200, [sse(&json!({"candidates": [{"content": {"parts": [{"text": "one "}]}, "finishReason": "CONTINUATION", "continuationToken": "tok-1"}]}))]);
    http.answer(200, [sse(&json!({"usageMetadata": {"promptTokenCount": 5}})), Err(TransportFault::TruncatedStream)]);
    http.silent();
    let (tx, mut rows) = tokio::sync::mpsc::unbounded_channel();
    let sink: Arc<dyn UsageSink> = Arc::new(RowSink(tx));
    let deps = AccountingDeps::new(Arc::new(TokenPricing), Arc::new(move || Some(sink.clone())));
    let accounted = AccountedAdapter::wrap(Arc::new(adapter(http.clone())), "gemini", Arc::new(deps));
    let mut asked = request();
    asked.options.send_group = Some("group".into());
    let mut stream = accounted.attempt(Arc::new(asked)).await.expect("the first hop answers");
    let waited = tokio::time::timeout(Duration::from_secs(30), drain(stream.as_mut())).await;
    assert!(waited.is_err(), "the retried hop never answers");
    assert_eq!(http.sent.lock().unwrap().len(), 3);
    drop(stream);
    accounted.settle_send("group", SendEnd::Cancelled).await;
    drop(accounted);
    let mut inputs = Vec::new();
    while let Some(row) = rows.recv().await {
        inputs.push(row.input);
    }
    assert_eq!(inputs, [5.0], "the abandoned attempt alone");
}

struct RowSink(tokio::sync::mpsc::UnboundedSender<crate::registry::accounting::UsageRow>);

#[async_trait]
impl crate::registry::accounting::UsageSink for RowSink {
    async fn record_queued(&self, row: crate::registry::accounting::UsageRow) -> Result<(), String> {
        self.0.send(row).map_err(|error| error.to_string())
    }
}

struct TokenPricing;

impl crate::registry::accounting::UsagePricing for TokenPricing {
    fn price_usage(&self, args: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
        crate::catalog::PricedUsage { input: args.input_tokens, cost_usd: Some(0.0), rates: Default::default() }
    }
}
