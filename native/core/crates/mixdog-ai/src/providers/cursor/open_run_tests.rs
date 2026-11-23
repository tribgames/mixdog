//! The run that stays open across a tool batch, against a scripted service: the result goes back on the run that asked
//! for it, and a stop or a cut connection ends the run with nothing left behind.
#![cfg(test)]

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::json;
use tokio::sync::mpsc;

use super::Access;
use super::AccessToken;
use super::CLIENT_VERSION_FLOOR;
use super::CursorAdapter;
use crate::providers::connect::frame;
use crate::providers::connect::pb::Reader;
use crate::providers::connect::pb::Writer;
use crate::transport::Exchange;
use crate::transport::http::BidiOpen;
use crate::transport::http::BodyStream;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

type Chunk = Result<Bytes, TransportFault>;

struct Body(mpsc::UnboundedReceiver<Chunk>);
#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Chunk> {
        self.0.recv().await
    }
}

struct Sink(Arc<Mutex<Vec<Vec<u8>>>>);
impl FrameSink for Sink {
    fn send(&self, frame: Vec<u8>) -> Result<(), TransportFault> {
        self.0.lock().unwrap().push(frame);
        Ok(())
    }
}

/// One run the service opened: the request it was opened with, the frames the client wrote on it, and the service's
/// side of its response.
struct Run {
    first: Vec<u8>,
    written: Arc<Mutex<Vec<Vec<u8>>>>,
    response: mpsc::UnboundedSender<Chunk>,
}

/// The service: each run it opens answers with the next script at once; later frames go out on `send`.
#[derive(Default)]
struct Service {
    scripts: Mutex<VecDeque<Vec<Vec<u8>>>>,
    runs: Mutex<Vec<Run>>,
    /// The catalog requests it was sent.
    listed: AtomicUsize,
}

impl Service {
    fn with(scripts: Vec<Vec<Vec<u8>>>) -> Arc<Self> {
        Arc::new(Self { scripts: Mutex::new(scripts.into()), ..Self::default() })
    }
    fn listed(&self) -> usize {
        self.listed.load(Ordering::SeqCst)
    }
    fn opened(&self) -> usize {
        self.runs.lock().unwrap().len()
    }
    fn send(&self, run: usize, chunk: Chunk) {
        let _ = self.runs.lock().unwrap()[run].response.send(chunk);
    }
    /// The client let go of the run's response: the exchange is reset.
    fn closed(&self, run: usize) -> bool {
        self.runs.lock().unwrap()[run].response.is_closed()
    }
    fn written(&self, run: usize) -> Vec<Vec<u8>> {
        self.runs.lock().unwrap()[run].written.lock().unwrap().clone()
    }
    fn first(&self, run: usize) -> Vec<u8> {
        self.runs.lock().unwrap()[run].first.clone()
    }
}

#[async_trait]
impl BidiOpen for Service {
    async fn open(&self, _request: WireRequest, first: Vec<u8>, _exchange: Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        let (response, body) = mpsc::unbounded_channel();
        for frame in self.scripts.lock().unwrap().pop_front().unwrap_or_default() {
            let _ = response.send(Ok(Bytes::from(frame)));
        }
        let written = Arc::new(Mutex::new(Vec::new()));
        self.runs.lock().unwrap().push(Run { first, written: written.clone(), response });
        Ok((HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Body(body)) }, Arc::new(Sink(written))))
    }
}

#[async_trait]
impl HttpSend for Service {
    async fn send(&self, _request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.listed.fetch_add(1, Ordering::SeqCst);
        let (_, body) = mpsc::unbounded_channel();
        Ok(HttpResponse { status: 500, headers: Vec::new(), body: Box::new(Body(body)) })
    }
}

struct Token;
#[async_trait]
impl AccessToken for Token {
    async fn access_token(&self) -> Result<Access, ProviderError> {
        Ok(Access::plain("t".into()))
    }
    async fn after_rejection(&self, _: &Access) -> Result<Access, ProviderError> {
        Ok(Access::plain("t".into()))
    }
    async fn renewed(&self) -> Result<Access, ProviderError> {
        Ok(Access::plain("t".into()))
    }
}

fn message(build: impl FnOnce(&mut Writer)) -> Vec<u8> {
    let mut m = Writer::new();
    build(&mut m);
    frame::encode(&m.finish(), 0)
}

/// Exec `n` whose case `field` holds `args`.
fn exec(n: u64, field: u32, args: Writer) -> Vec<u8> {
    message(|m| {
        let mut exec = Writer::new();
        exec.varint(1, n);
        exec.message(field, args);
        exec.string(15, &format!("exec-{n}"));
        m.message(2, exec);
    })
}

fn lookup_exec(n: u64, call: &str, key: &str) -> Vec<u8> {
    let mut entry = Writer::new();
    entry.string(1, "key");
    entry.bytes(2, &super::schema::encode_json_value(&json!(key)));
    let mut mcp = Writer::new();
    mcp.string(1, "lookup");
    mcp.message(2, entry);
    mcp.string(3, call);
    mcp.string(5, "lookup");
    exec(n, 11, mcp)
}

fn lookup_call() -> Vec<u8> {
    lookup_exec(1, "call-1", "alpha")
}

/// A native exec of each kind a Mixdog tool serves, as `(the tool that serves it, the exec)`, each under `call-1`.
fn native_execs() -> Vec<(&'static str, Vec<u8>)> {
    let strings = |fields: &[(u32, &str)]| {
        let mut args = Writer::new();
        for (field, value) in fields {
            args.string(*field, value);
        }
        args
    };
    vec![
        ("read", exec(1, 7, strings(&[(1, "C:\\work\\a.txt"), (2, "call-1")]))),
        ("edit", exec(1, 3, strings(&[(1, "C:\\work\\a.txt"), (2, "new text"), (3, "call-1")]))),
        ("glob", exec(1, 8, strings(&[(1, "C:\\work"), (3, "call-1")]))),
        ("grep", exec(1, 5, strings(&[(1, "fox"), (14, "call-1")]))),
        ("web_fetch", exec(1, 20, strings(&[(1, "https://example.com/"), (2, "call-1")]))),
        ("shell", exec(1, 2, strings(&[(1, "dir"), (4, "call-1")]))),
        ("shell", exec(1, 14, strings(&[(1, "dir"), (4, "call-1")]))),
        ("lookup", lookup_call()),
    ]
}

fn update(field: u32, body: Writer) -> Vec<u8> {
    message(|m| {
        let mut update = Writer::new();
        update.message(field, body);
        m.message(1, update);
    })
}

/// The answer and the end of the turn.
fn answer_frames() -> Vec<Vec<u8>> {
    let mut text = Writer::new();
    text.string(1, "42 it is");
    vec![update(1, text), update(14, Writer::new()), frame::encode(b"{}", frame::END_STREAM)]
}

fn tool(name: &str, input_schema: serde_json::Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: format!("The {name} tool."), input_schema, defer_loading: false, freeform: None }
}

fn lookup_tool() -> ToolDefinition {
    tool("lookup", json!({"type": "object", "properties": {"key": {"type": "string"}}}))
}

fn request_of(messages: Vec<Message>, tools: Vec<ToolDefinition>, options: RequestOptions) -> Arc<ModelRequest> {
    Arc::new(ModelRequest { model: "lookup-model".into(), messages, tools, options: RequestOptions { session_id: Some("s1".into()), ..options } })
}

fn request(messages: Vec<Message>) -> Arc<ModelRequest> {
    request_of(messages, vec![lookup_tool()], RequestOptions::default())
}

fn asked() -> Message {
    Message::new(Role::User, Content::Text("Look up alpha.".into()))
}

/// The assistant turn that made `call`, and the call's result.
fn exchange(call: &ToolCall, result: &str) -> [Message; 2] {
    let mut made = Message::new(Role::Assistant, Content::Text(String::new().into()));
    made.tool_calls = vec![call.clone()];
    let mut returned = Message::new(Role::Tool, Content::Text(result.to_owned().into()));
    returned.tool_call_id = Some(call.id.clone());
    [made, returned]
}

fn transcript_with_result() -> Vec<Message> {
    let call = ToolCall { id: "call-1".into(), name: "lookup".into(), arguments: json!({"key": "alpha"}), native_type: None };
    std::iter::once(asked()).chain(exchange(&call, "42")).collect()
}

fn calls_of(events: &[StreamEvent]) -> Vec<ToolCall> {
    events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(call) = e { Some(call.clone()) } else { None }).collect()
}

/// The transcript entries of the request run `run` was opened with, and the text of its user message.
fn asked_of(service: &Service, run: usize) -> (usize, Option<String>) {
    let sent = service.first(run);
    let entries = at(&sent[5..], &[1, 1]).map_or(0, |state| {
        let mut reader = Reader::new(&state);
        std::iter::from_fn(|| reader.next_field().ok().flatten()).count()
    });
    (entries, at(&sent[5..], &[1, 2, 1, 1, 1]).map(|text| String::from_utf8_lossy(&text).into_owned()))
}

async fn drain(stream: &mut Box<dyn ModelStream>) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.expect("no failure"));
    }
    events
}

fn stop_of(events: &[StreamEvent]) -> Option<StopReason> {
    events.iter().find_map(|e| match e {
        StreamEvent::Completed { stop, .. } => stop.clone(),
        _ => None,
    })
}

/// The bytes at `path` of field numbers inside `bytes`, each the first such field.
fn at(bytes: &[u8], path: &[u32]) -> Option<Vec<u8>> {
    let mut current = bytes.to_vec();
    for wanted in path {
        let mut reader = Reader::new(&current);
        let found = std::iter::from_fn(|| reader.next_field().ok().flatten()).find(|(n, _)| n == wanted).map(|(_, v)| v.bytes().to_vec())?;
        current = found;
    }
    Some(current)
}

/// Lets the runtime run what was woken (an aborted task, a task that read a fault).
async fn settle() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

fn adapter(service: &Arc<Service>) -> CursorAdapter {
    mixdog_rt::testing::tokens();
    CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), service.clone(), service.clone(), Arc::new(Token))
}

/// The batch's first step parks the run; its result is written back on that run, which goes on to answer: two steps,
/// one request.
#[tokio::test(start_paused = true)]
async fn a_tool_result_is_answered_on_the_run_that_asked_for_it() {
    let service = Service::with(vec![vec![lookup_call()]]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    let events = drain(&mut first).await;
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(call) if call.id == "call-1")), "{events:?}");
    assert_eq!(stop_of(&events), Some(StopReason::ToolUse));
    assert_eq!(adapter.runs.waiting(), 1, "the run waits for the result");
    assert!(!service.closed(0));

    for frame in answer_frames() {
        service.send(0, Ok(Bytes::from(frame)));
    }
    let mut second = adapter.attempt(request(transcript_with_result())).await.expect("the run goes on");
    let events = drain(&mut second).await;
    let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
    assert_eq!(text, "42 it is");
    assert_eq!(stop_of(&events), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 1, "both steps on one run");
    let answered = service.written(0).iter().find_map(|written| at(&written[5..], &[2, 11, 1, 1, 1, 1]));
    assert_eq!(answered.as_deref(), Some(b"42".as_slice()), "the result goes back as the call's MCP result");
    drop((first, second));
}

/// A stop while the tools run drops the turn's hold on the stream: the run is closed and nothing of it stays.
#[tokio::test(start_paused = true)]
async fn a_stop_ends_the_waiting_run() {
    let service = Service::with(vec![vec![lookup_call()]]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    drain(&mut first).await;
    assert_eq!(adapter.runs.waiting(), 1);
    drop(first);
    settle().await;
    assert!(service.closed(0), "the run's response is let go");
    assert_eq!(adapter.runs.waiting(), 0);
}

/// A connection cut while the tools run ends the waiting run at once; the next step continues by a new run whose
/// transcript carries the result.
#[tokio::test(start_paused = true)]
async fn a_cut_connection_ends_the_waiting_run_and_the_next_step_opens_a_new_one() {
    let service = Service::with(vec![vec![lookup_call()], answer_frames()]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    drain(&mut first).await;
    service.send(0, Err(TransportFault::Reset));
    settle().await;
    assert!(service.closed(0), "the cut run is let go while the turn still holds its stream");
    let mut second = adapter.attempt(request(transcript_with_result())).await.expect("a new run");
    let events = drain(&mut second).await;
    assert_eq!(stop_of(&events), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 2);
    let sent = service.first(1);
    let entries = at(&sent[5..], &[1, 1]).map(|state| {
        let mut reader = Reader::new(&state);
        std::iter::from_fn(|| reader.next_field().ok().flatten()).map(|(n, _)| n).collect::<Vec<_>>()
    });
    assert_eq!(entries, Some(vec![1, 1, 1, 8]), "the transcript's three entries, the result among them, and its open turn");
    assert!(at(&sent[5..], &[1, 2, 1]).is_none() && at(&sent[5..], &[1, 2, 2]).is_some(), "the open turn is resumed, with no user message");
    drop((first, second));
}

/// Text the user sends after the results is a turn of its own on both sides, whatever kind of call the batch held: the
/// waiting run is closed with nothing written on it, and a new run carries the transcript with the text as its user
/// message. No result is rewritten to carry it, so a native read keeps its content and a native write its outcome.
#[tokio::test(start_paused = true)]
async fn text_of_the_user_after_the_results_is_the_user_message_of_a_new_run() {
    let tools = || {
        let path = json!({"type": "object", "properties": {"file_path": {"type": "string"}}});
        let mut all: Vec<ToolDefinition> = ["read", "edit", "glob", "grep", "web_fetch", "shell"].iter().map(|name| tool(name, path.clone())).collect();
        all.push(lookup_tool());
        all
    };
    for (serves, exec) in native_execs() {
        let service = Service::with(vec![vec![exec], answer_frames()]);
        let adapter = adapter(&service);
        let mut first = adapter.attempt(request_of(vec![asked()], tools(), RequestOptions::default())).await.expect("the run opens");
        let calls = calls_of(&drain(&mut first).await);
        assert_eq!(calls.iter().map(|call| call.name.as_str()).collect::<Vec<_>>(), [serves]);
        assert_eq!(adapter.runs.waiting(), 1, "{serves}: the run waits for the result");

        let mut transcript = vec![asked()];
        transcript.extend(exchange(&calls[0], "[lines 1-1]\nthe quick brown fox\n[lines 1-1 of 1]"));
        transcript.push(Message::new(Role::User, Content::Text("Stop there and say hello.".into())));
        let mut second = adapter.attempt(request_of(transcript, tools(), RequestOptions::default())).await.expect("a new run");
        assert_eq!(stop_of(&drain(&mut second).await), Some(StopReason::Other("stop".into())), "{serves}");
        assert_eq!(service.opened(), 2, "{serves}");
        assert!(service.closed(0), "{serves}: the run that waited is closed");
        assert!(service.written(0).iter().all(|written| at(&written[5..], &[2]).is_none()), "{serves}: no result is written on the run that is left");
        assert_eq!(asked_of(&service, 1), (3, Some("Stop there and say hello.".into())), "{serves}: the call, its result and the user's text");
        drop((first, second));
    }
}

/// The tool requests the service lists for a step.
fn listing(count: u64) -> Vec<u8> {
    let mut listed = Writer::new();
    listed.varint(1, count);
    update(27, listed)
}

/// The assistant turn that made `calls`, then a result per call in `order` (positions in `calls`).
fn batch_exchange(calls: &[ToolCall], order: &[usize]) -> Vec<Message> {
    let mut made = Message::new(Role::Assistant, Content::Text(String::new().into()));
    made.tool_calls = calls.to_vec();
    let results = order.iter().map(|at| exchange(&calls[*at], &format!("result of {}", calls[*at].id))[1].clone());
    std::iter::once(made).chain(results).collect()
}

/// The exec each result written on `run` answers, in the order they were written.
fn answered_on(service: &Service, run: usize) -> Vec<String> {
    let exec = |written: &Vec<u8>| at(&written[5..], &[2, 15]).map(|id| String::from_utf8_lossy(&id).into_owned());
    service.written(run).iter().filter_map(exec).collect()
}

/// A step of three parallel calls, listed after the second exec as the service lists it: the three are one batch,
/// handed over with the third exec and no wait, and their results go back on the one run, each on its call in the
/// batch's order whatever order the transcript holds them in.
#[tokio::test(start_paused = true)]
async fn a_listed_step_of_three_calls_is_one_batch_on_one_run() {
    let step = vec![lookup_exec(1, "call-1", "a"), lookup_exec(2, "call-2", "b"), listing(3), lookup_exec(3, "call-3", "c")];
    let service = Service::with(vec![step]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    let started = tokio::time::Instant::now();
    let events = drain(&mut first).await;
    let calls = calls_of(&events);
    assert_eq!(calls.iter().map(|call| call.id.as_str()).collect::<Vec<_>>(), ["call-1", "call-2", "call-3"]);
    assert_eq!(stop_of(&events), Some(StopReason::ToolUse));
    assert_eq!(started.elapsed(), std::time::Duration::ZERO, "a listed step waits for nothing");

    for frame in answer_frames() {
        service.send(0, Ok(Bytes::from(frame)));
    }
    let transcript: Vec<Message> = std::iter::once(asked()).chain(batch_exchange(&calls, &[2, 0, 1])).collect();
    let mut second = adapter.attempt(request(transcript)).await.expect("the run goes on");
    assert_eq!(stop_of(&drain(&mut second).await), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 1, "both steps on one run");
    assert_eq!(answered_on(&service, 0), ["exec-1", "exec-2", "exec-3"]);
    drop((first, second));
}

/// A step the service does not list is handed over one second after the last frame that was no heartbeat, and an exec
/// of that step which arrives while its first call runs is the next batch, on the same run.
#[tokio::test(start_paused = true)]
async fn an_unlisted_step_is_handed_over_after_a_quiet_second_and_a_later_exec_is_the_next_batch() {
    let service = Service::with(vec![vec![lookup_call()]]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    let started = tokio::time::Instant::now();
    let calls = calls_of(&drain(&mut first).await);
    assert_eq!(calls.iter().map(|call| call.id.as_str()).collect::<Vec<_>>(), ["call-1"]);
    let waited = started.elapsed();
    assert!(waited <= super::decoder::QUIET && waited + std::time::Duration::from_millis(50) > super::decoder::QUIET, "{waited:?}");

    service.send(0, Ok(Bytes::from(lookup_exec(2, "call-2", "beta"))));
    let mut transcript = transcript_with_result();
    let mut second = adapter.attempt(request(transcript.clone())).await.expect("the run goes on");
    let events = drain(&mut second).await;
    let next = calls_of(&events);
    assert_eq!(next.iter().map(|call| call.id.as_str()).collect::<Vec<_>>(), ["call-2"]);
    assert_eq!(stop_of(&events), Some(StopReason::ToolUse));

    for frame in answer_frames() {
        service.send(0, Ok(Bytes::from(frame)));
    }
    transcript.extend(exchange(&next[0], "43"));
    let mut third = adapter.attempt(request(transcript)).await.expect("the run goes on");
    assert_eq!(stop_of(&drain(&mut third).await), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 1, "three steps on one run");
    assert_eq!(answered_on(&service, 0), ["exec-1", "exec-2"]);
    drop((first, second, third));
}

/// A catalog that describes `lookup-model` by an effort parameter, its one variant listed as `lookup-model-high`.
fn parameterized() -> Vec<super::models::CursorModel> {
    use super::models::CursorModel;
    use super::models::ParameterDefinition;
    use super::models::ParameterValue;
    use super::models::Variant;
    vec![CursorModel {
        id: "lookup-model".into(),
        name: "Lookup".into(),
        description: String::new(),
        context_window: 0,
        max_context_window: 0,
        supports_max_mode: false,
        supports_non_max_mode: true,
        supports_vision: false,
        supports_reasoning: true,
        definitions: vec![ParameterDefinition {
            id: "effort".into(),
            name: "Effort".into(),
            boolean: false,
            values: vec![ParameterValue { value: "high".into(), label: "High".into() }],
        }],
        variants: vec![Variant {
            parameters: vec![("effort".into(), "high".into())],
            max_mode: false,
            default_max: false,
            default_non_max: true,
            legacy_slug: "lookup-model-high".into(),
        }],
        aliases: Vec::new(),
    }]
}

/// A model id the service answers as not found, before any output, is asked once more under the id the listing gave
/// that variant, and under that id from then on. When the listed id is not found either, the failure is the attempt's.
#[tokio::test(start_paused = true)]
async fn a_model_id_the_service_does_not_know_is_asked_once_under_its_listed_id() {
    let not_found = || vec![frame::encode(br#"{"error":{"code":"not_found","message":"no such model"}}"#, frame::END_STREAM)];
    let names_listed = |service: &Service, run: usize| service.first(run).windows(17).any(|bytes| bytes == b"lookup-model-high");

    let service = Service::with(vec![not_found(), answer_frames(), answer_frames()]);
    let adapter = adapter(&service);
    adapter.catalog.store(Some(Arc::new(parameterized())));
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("asked again under the listed id");
    assert_eq!(stop_of(&drain(&mut first).await), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 2, "one more request");
    assert_eq!((names_listed(&service, 0), names_listed(&service, 1)), (false, true));
    drop(first);
    let mut later = adapter.attempt(request(vec![asked()])).await.expect("the next turn");
    drain(&mut later).await;
    assert_eq!(service.opened(), 3, "the id that was not found is not asked again");
    assert!(names_listed(&service, 2));

    let service = Service::with(vec![not_found(), not_found(), answer_frames()]);
    let adapter = self::adapter(&service);
    adapter.catalog.store(Some(Arc::new(parameterized())));
    let error = adapter.attempt(request(vec![asked()])).await.err().expect("not found under either id");
    assert_eq!(error.status, Some(404), "{error:?}");
    assert_eq!(service.opened(), 2, "asked once more, not again");
    let mut back = adapter.attempt(request(vec![asked()])).await.expect("the next turn");
    drain(&mut back).await;
    assert!(!names_listed(&service, 2), "the switch to an id the service does not know either is undone");

    // A not-found of something other than the model is the failure it is.
    let other = vec![frame::encode(br#"{"error":{"code":"not_found","message":"Conversation not found"}}"#, frame::END_STREAM)];
    let service = Service::with(vec![other, answer_frames()]);
    let adapter = self::adapter(&service);
    adapter.catalog.store(Some(Arc::new(parameterized())));
    let error = adapter.attempt(request(vec![asked()])).await.err().expect("the failure");
    assert_eq!((error.status, service.opened()), (Some(404), 1), "{error:?}");
}

/// The provider behind the service fails a run, before anything was shown, on a conversation a run completed on: the
/// next request carries a fresh conversation id. A limit of the account, worded as one, keeps the conversation.
#[tokio::test(start_paused = true)]
async fn a_providers_failure_of_a_held_conversation_gives_the_next_request_a_fresh_id() {
    let conversation = |service: &Service, run: usize| at(&service.first(run)[5..], &[1, 5]).expect("the conversation id");
    let ended = |body: &str| vec![frame::encode(body.as_bytes(), frame::END_STREAM)];
    let provider = r#"{"error":{"code":"unavailable","message":"Error","details":[{"type":"aiserver.v1.ErrorDetails","debug":{"error":"ERROR_PROVIDER_ERROR"}}]}}"#;
    let quota = r#"{"error":{"code":"resource_exhausted","message":"You have hit your usage limit","details":[{"type":"aiserver.v1.ErrorDetails","debug":{"error":"ERROR_PRO_USER_USAGE_LIMIT"}}]}}"#;
    for (failure, rotates) in [(provider, true), (quota, false)] {
        let service = Service::with(vec![answer_frames(), ended(failure), answer_frames()]);
        let adapter = adapter(&service);
        let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
        drain(&mut first).await;
        drop(first);
        adapter.attempt(request(vec![asked()])).await.err().expect("the run fails");
        let mut third = adapter.attempt(request(vec![asked()])).await.expect("the retry");
        drain(&mut third).await;
        assert_eq!(conversation(&service, 0), conversation(&service, 1));
        assert_eq!(conversation(&service, 1) != conversation(&service, 2), rotates, "{failure}");
    }
}

/// A frame that arrives over more than the quiet stretch is the service still sending: the call before it is not
/// handed over alone, and the two are one batch, a quiet second after the frame's last bytes.
#[tokio::test(start_paused = true)]
async fn a_frame_still_arriving_is_no_quiet_stretch() {
    let service = Service::with(vec![vec![lookup_call()]]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    let slow = lookup_exec(2, "call-2", &"x".repeat(6_000));
    let pieces: Vec<Bytes> = slow.chunks(2_000).map(Bytes::copy_from_slice).collect();
    let apart = std::time::Duration::from_millis(600);
    let arrived = apart * pieces.len() as u32;
    let started = tokio::time::Instant::now();
    let (events, ()) = tokio::join!(drain(&mut first), async {
        for piece in pieces {
            tokio::time::sleep(apart).await;
            service.send(0, Ok(piece));
        }
    });
    assert_eq!(calls_of(&events).iter().map(|call| call.id.as_str()).collect::<Vec<_>>(), ["call-1", "call-2"]);
    let waited = started.elapsed();
    assert!(waited >= arrived + super::decoder::QUIET && waited < arrived + super::decoder::QUIET + apart, "{waited:?}");
    drop(first);
}

/// A call the run announced behind the batch it waits on was never handed over. When the run is left, on any path,
/// the call goes with it: it is never handed over by a later step, so text the user sent is never followed by a call
/// the model issued before it, and nothing is written on the run that is left.
#[tokio::test(start_paused = true)]
async fn a_call_not_handed_over_goes_with_the_run_that_is_left() {
    let with = |more: Vec<Message>| transcript_with_result().into_iter().chain(more).collect::<Vec<_>>();
    let said = |text: &str| Message::new(Role::User, Content::Text(text.to_owned().into()));
    let other_model = |messages: Vec<Message>| Arc::new(ModelRequest { model: "another-model".into(), ..(*request(messages)).clone() });
    let more_tools = |messages: Vec<Message>| request_of(messages, vec![lookup_tool(), tool("extra", json!({"type": "object"}))], RequestOptions::default());
    let mut elsewhere = Message::new(Role::Assistant, Content::Text("Answered by another provider.".into()));
    elsewhere.tool_calls = Vec::new();
    // Another provider took a step in between: it made a call of its own, whose result the transcript ends in.
    let others = ToolCall { id: "other-1".into(), name: "lookup".into(), arguments: json!({"key": "beta"}), native_type: None };
    let no_such_effort = RequestOptions { effort: Some("no-such-effort".into()), ..RequestOptions::default() };
    // `(the path, the run is cut first, the request that follows; none: the turn ends)`
    let paths: Vec<(&str, bool, Option<Arc<ModelRequest>>)> = vec![
        ("text of the user after the results", false, Some(request(with(vec![said("Stop there.")])))),
        ("a transcript that does not continue the batch", false, Some(request(with(vec![elsewhere, said("Go on.")])))),
        ("other rules", false, Some(request(std::iter::once(Message::new(Role::System, Content::Text("Answer in one word.".into()))).chain(with(Vec::new())).collect()))),
        ("other tools", false, Some(more_tools(with(Vec::new())))),
        ("another model", false, Some(other_model(with(Vec::new())))),
        ("a cut", true, Some(request(with(Vec::new())))),
        ("a request that cannot be asked", false, Some(request(Vec::new()))),
        ("another provider in between", false, Some(request(with(exchange(&others, "7").to_vec())))),
        ("a failed selection", false, Some(request_of(with(Vec::new()), vec![lookup_tool()], no_such_effort))),
        ("the turn's end", false, None),
    ];
    for (path, cut, next) in paths {
        let service = Service::with(vec![vec![listing(1), lookup_call()], answer_frames()]);
        let adapter = adapter(&service);
        if path == "a failed selection" {
            adapter.catalog.store(Some(Arc::new(parameterized())));
        }
        let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
        assert_eq!(calls_of(&drain(&mut first).await).len(), 1, "{path}");
        service.send(0, Ok(Bytes::from(lookup_exec(2, "call-2", "beta"))));
        if cut {
            service.send(0, Err(TransportFault::Reset));
        }
        settle().await;

        let second = match next {
            Some(next) => adapter.attempt(next).await.ok(),
            None => None,
        };
        drop(first);
        settle().await;
        if let Some(mut second) = second {
            let events = drain(&mut second).await;
            assert!(calls_of(&events).is_empty(), "{path}: {events:?}");
            assert_eq!(stop_of(&events), Some(StopReason::Other("stop".into())), "{path}");
            assert_eq!(service.opened(), 2, "{path}: the step is a new run's");
        } else {
            assert_eq!(service.opened(), 1, "{path}");
        }
        assert!(service.closed(0), "{path}: the run that is left is closed");
        assert_eq!(adapter.runs.waiting(), 0, "{path}");
        assert!(answered_on(&service, 0).is_empty(), "{path}: nothing is written on the run that is left");
    }
}

/// The reminder the agent puts last on every request is no new text of the user: a transcript that ends in the batch's
/// results and that reminder goes on the waiting run. Text the user sent before it still leaves the run.
#[tokio::test(start_paused = true)]
async fn the_standing_tail_reminder_does_not_leave_the_waiting_run() {
    use mixdog_core_api::domain::provider::MessageSource;

    let reminder = || {
        let mut reminder = Message::new(Role::User, Content::Text("Answer in Korean.".into()));
        reminder.source = Some(MessageSource::TailReminder);
        reminder
    };
    for said in [false, true] {
        let service = Service::with(vec![vec![listing(1), lookup_call()], answer_frames()]);
        let adapter = adapter(&service);
        let mut first = adapter.attempt(request(vec![asked(), reminder()])).await.expect("the run opens");
        drain(&mut first).await;
        for frame in answer_frames() {
            service.send(0, Ok(Bytes::from(frame)));
        }
        let mut transcript = transcript_with_result();
        if said {
            transcript.push(Message::new(Role::User, Content::Text("Stop there.".into())));
        }
        transcript.push(reminder());
        let mut second = adapter.attempt(request(transcript)).await.expect("the next step");
        assert_eq!(stop_of(&drain(&mut second).await), Some(StopReason::Other("stop".into())));
        assert_eq!(service.opened(), if said { 2 } else { 1 }, "the user said something: {said}");
        assert_eq!(answered_on(&service, 0), if said { Vec::<&str>::new() } else { vec!["exec-1"] });
        drop((first, second));
    }
}

/// The run was given its results and answers with a failure (here a throttle): the failure is the attempt's, for the
/// send's own retry rule to act on. No new run is opened behind it; the retry finds no run waiting and opens one.
#[tokio::test(start_paused = true)]
async fn a_failure_of_the_run_that_was_given_its_results_is_the_attempts() {
    let service = Service::with(vec![vec![lookup_call()], answer_frames()]);
    let adapter = adapter(&service);
    let mut first = adapter.attempt(request(vec![asked()])).await.expect("the run opens");
    drain(&mut first).await;
    let refused = br#"{"error":{"code":"resource_exhausted","message":"slow down"}}"#;
    service.send(0, Ok(Bytes::from(frame::encode(refused, frame::END_STREAM))));

    let error = adapter.attempt(request(transcript_with_result())).await.err().expect("the run's failure");
    assert_eq!(error.status, Some(429), "{error:?}");
    assert_eq!(service.opened(), 1, "no run is opened behind the failure");
    assert!(service.written(0).iter().any(|written| at(&written[5..], &[2, 11]).is_some()), "the result was written on the run");
    assert!(service.closed(0));

    let mut retry = adapter.attempt(request(transcript_with_result())).await.expect("the retry opens a run");
    assert_eq!(stop_of(&drain(&mut retry).await), Some(StopReason::Other("stop".into())));
    assert_eq!(service.opened(), 2);
    drop((first, retry));
}

/// A step that leaves the waiting run for a new one reads its request once: a tool it leaves out is told once, and
/// the catalog is read as often as by any step.
#[tokio::test(start_paused = true)]
async fn a_step_that_leaves_the_waiting_run_reads_its_request_once() {
    use mixdog_core_api::domain::provider::ToolExclusionReport;
    use mixdog_core_api::domain::provider::ToolExclusionSink;

    let service = Service::with(vec![vec![lookup_call()], answer_frames()]);
    let adapter = adapter(&service);
    let told = Arc::new(AtomicUsize::new(0));
    let step = |messages: Vec<Message>| {
        let told = told.clone();
        let sink = ToolExclusionSink(Arc::new(move |_: ToolExclusionReport| {
            told.fetch_add(1, Ordering::SeqCst);
        }));
        let broken = tool("broken", json!({"type": "object", "properties": {"x": {"$ref": "#/$defs/missing"}}}));
        request_of(messages, vec![lookup_tool(), broken], RequestOptions { on_tool_excluded: Some(sink), ..RequestOptions::default() })
    };
    let mut first = adapter.attempt(step(vec![asked()])).await.expect("the run opens");
    drain(&mut first).await;
    let (told_first, listed_first) = (told.load(Ordering::SeqCst), service.listed());
    assert_eq!(told_first, 1);

    let mut transcript = transcript_with_result();
    transcript.insert(0, Message::new(Role::System, Content::Text("Answer in one word.".into())));
    let mut second = adapter.attempt(step(transcript)).await.expect("a new run");
    drain(&mut second).await;
    assert_eq!(service.opened(), 2, "other rules: the step leaves the waiting run");
    assert_eq!(told.load(Ordering::SeqCst) - told_first, 1, "the excluded tool is told once");
    assert_eq!(service.listed() - listed_first, listed_first, "the catalog is read as often as by the first step");
    drop((first, second));
}
