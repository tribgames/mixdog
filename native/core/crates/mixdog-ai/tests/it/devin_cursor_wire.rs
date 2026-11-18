//! The Devin and Cursor wires end to end with frames built here: the request each adapter writes (Connect envelope,
//! gzip for Devin, protobuf fields by their schema numbers) and the response frames each maps to stream events.
#![allow(clippy::disallowed_methods, reason = "a test reads what the adapter wrote with std")]

use std::collections::VecDeque;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::providers::cursor::CursorAdapter;
use mixdog_ai::providers::cursor::auth::ApiKeyAccess;
use mixdog_ai::providers::devin::DevinAdapter;
use mixdog_ai::providers::devin::auth::StaticSessionToken;
use mixdog_ai::providers::devin::auth::StoredCredentials;
use mixdog_ai::providers::devin::schema::fields;
use mixdog_ai::transport::http::BidiOpen;
use mixdog_ai::transport::http::BodyStream;
use mixdog_ai::transport::http::FrameSink;
use mixdog_ai::transport::http::HttpResponse;
use mixdog_ai::transport::http::HttpSend;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

const ASKED: &str = "Look up the answer.";

fn request(model: &str) -> ModelRequest {
    ModelRequest {
        model: model.into(),
        messages: vec![Message::new(Role::System, Content::Text("You are a wire assistant.".into())), Message::new(Role::User, Content::Text(ASKED.into()))],
        tools: vec![ToolDefinition {
            name: "lookup".into(),
            description: "Read a value".into(),
            input_schema: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
            defer_loading: false,
            freeform: None,
        }],
        options: RequestOptions::default(),
    }
}

// A minimal protobuf writer: the wire format itself, so the schema numbers under test are the only shared knowledge.
fn varint(mut v: u64, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}
fn len_field(n: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint(u64::from(n) << 3 | 2, &mut out);
    varint(payload.len() as u64, &mut out);
    out.extend_from_slice(payload);
    out
}
fn text_field(n: u32, text: &str) -> Vec<u8> {
    len_field(n, text.as_bytes())
}
fn int_field(n: u32, v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    varint(u64::from(n) << 3, &mut out);
    varint(v, &mut out);
    out
}
fn envelope(flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![flags];
    out.extend((payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

struct Chunks(VecDeque<Bytes>, Option<TransportFault>);
#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.0.pop_front() {
            Some(chunk) => Some(Ok(chunk)),
            None => self.1.take().map(Err),
        }
    }
}
fn response(status: u16, chunks: Vec<Vec<u8>>) -> HttpResponse {
    HttpResponse { status, headers: Vec::new(), body: Box::new(Chunks(chunks.into_iter().map(Bytes::from).collect(), None)) }
}

struct Sink;
impl FrameSink for Sink {
    fn send(&self, _frame: Vec<u8>) -> Result<(), TransportFault> {
        Ok(())
    }
}

/// Serves one scripted stream at `stream_path`, the user-JWT exchange where Devin asks for it, and an empty answer elsewhere.
struct Wire {
    stream_path: &'static str,
    frames: Mutex<Vec<Vec<u8>>>,
    sent: Mutex<Vec<(String, Vec<u8>)>>,
}
impl Wire {
    fn new(stream_path: &'static str, frames: Vec<Vec<u8>>) -> Arc<Self> {
        Arc::new(Self { stream_path, frames: Mutex::new(frames), sent: Mutex::new(Vec::new()) })
    }
    fn sent_to(&self, path: &str) -> Vec<u8> {
        self.sent.lock().unwrap().iter().find(|(p, _)| p.ends_with(path)).map(|(_, b)| b.clone()).unwrap_or_else(|| panic!("nothing sent to {path}"))
    }
}
#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push((request.url.clone(), request.body.clone()));
        if request.url.ends_with("GetUserJwt") {
            return Ok(response(200, vec![text_field(1, "user.jwt.value")]));
        }
        // The API key is exchanged for an access token before a Cursor run.
        if request.url.ends_with("exchange_user_api_key") {
            return Ok(response(200, vec![br#"{"accessToken":"cursor.access.token","refreshToken":"cursor-refresh"}"#.to_vec()]));
        }
        if request.url.ends_with(self.stream_path) {
            return Ok(response(200, std::mem::take(&mut *self.frames.lock().unwrap())));
        }
        Ok(response(200, Vec::new()))
    }
}
#[async_trait]
impl BidiOpen for Wire {
    async fn open(&self, request: WireRequest, first: Vec<u8>, _exchange: mixdog_ai::transport::Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        self.sent.lock().unwrap().push((request.url.clone(), first));
        Ok((response(200, std::mem::take(&mut *self.frames.lock().unwrap())), Arc::new(Sink)))
    }
}

#[derive(Default)]
struct Outcome {
    content: String,
    reasoning: String,
    calls: Vec<(String, Value)>,
    usage: Option<Usage>,
    stop: Option<StopReason>,
    error: Option<ProviderError>,
}
async fn run(adapter: &dyn ProviderAdapter, request: ModelRequest) -> Outcome {
    let mut outcome = Outcome::default();
    let mut stream = match adapter.attempt(Arc::new(request)).await {
        Ok(stream) => stream,
        Err(error) => {
            outcome.error = Some(error);
            return outcome;
        }
    };
    while let Some(item) = stream.next().await {
        match item {
            Ok(StreamEvent::TextDelta(t)) => outcome.content.push_str(&t),
            Ok(StreamEvent::ReasoningDelta(t)) => outcome.reasoning.push_str(&t),
            Ok(StreamEvent::ToolCallDone(c)) => outcome.calls.push((c.name, c.arguments)),
            Ok(StreamEvent::Usage(u)) => outcome.usage = Some(u),
            Ok(StreamEvent::Completed { stop, .. }) => outcome.stop = stop,
            Ok(_) => {}
            Err(error) => {
                outcome.error = Some(error);
                break;
            }
        }
    }
    outcome
}

fn devin(wire: &Arc<Wire>) -> DevinAdapter {
    let credentials = StoredCredentials { access_token: "devin-session-token$wire-access-token".into(), refresh_token: None, expires_at: None, identity: None };
    DevinAdapter::new(None, wire.clone(), Arc::new(StaticSessionToken::new(credentials, "devin-wire")))
}
fn gzip_frame(payload: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(payload).unwrap();
    envelope(1, &encoder.finish().unwrap())
}
const TRAILER_OK: &[u8] = b"{}";

#[tokio::test]
async fn devin_writes_a_gzip_connect_request_and_maps_the_response_frames() {
    let call = [text_field(1, "call_1"), text_field(2, "lookup"), text_field(3, r#"{"key":"k"}"#)].concat();
    let usage = [int_field(2, 11), int_field(3, 7), int_field(4, 5), int_field(5, 3)].concat();
    let frames = vec![
        gzip_frame(&[text_field(1, "msg-1"), text_field(3, "Hel")].concat()),
        gzip_frame(&text_field(3, "lo")),
        gzip_frame(&text_field(9, "pondering")),
        gzip_frame(&len_field(6, &call)),
        gzip_frame(&len_field(7, &usage)),
        envelope(3, &{
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(TRAILER_OK).unwrap();
            e.finish().unwrap()
        }),
    ];
    let wire = Wire::new("GetChatMessage", frames);
    let got = run(&devin(&wire), request("devin-wire-model")).await;
    assert!(got.error.is_none(), "{:?}", got.error.map(|e| e.message));
    assert_eq!(got.content, "Hello");
    assert_eq!(got.reasoning, "pondering");
    assert_eq!(got.calls, vec![("lookup".to_owned(), json!({"key": "k"}))]);
    let usage = got.usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_write_tokens, usage.cache_read_tokens), (11, 7, 5, 3));
    assert_eq!(got.stop, Some(StopReason::ToolUse), "a call made the turn end as tool use");

    // The request: one gzip envelope whose protobuf names the tool and carries the user's text.
    let sent = wire.sent_to("GetChatMessage");
    assert_eq!(sent[0], 1, "a compressed envelope");
    assert_eq!(u32::from_be_bytes(sent[1..5].try_into().unwrap()) as usize, sent.len() - 5, "its length prefix is the payload's");
    let mut chat = Vec::new();
    flate2::read::GzDecoder::new(&sent[5..]).read_to_end(&mut chat).unwrap();
    let top = fields(&chat).unwrap();
    let tools: Vec<String> = top.iter().filter(|(n, _, _)| *n == 10).map(|(_, b, _)| String::from_utf8(fields(b).unwrap().into_iter().find(|(m, _, _)| *m == 1).unwrap().1).unwrap()).collect();
    assert_eq!(tools, ["lookup"], "tool definitions are field 10, the name its field 1");
    assert!(top.iter().any(|(n, b, _)| *n == 3 && fields(b).unwrap().iter().any(|(m, t, _)| *m == 3 && t == ASKED.as_bytes())), "the user's text is the prompt (field 3) of a chat message (field 3)");
    assert!(top.iter().any(|(n, b, _)| *n == 21 && !b.is_empty()), "the chat model uid is field 21");
}

#[tokio::test]
async fn devin_failure_trailer_is_the_servers_error_and_a_body_without_a_trailer_is_a_cut_stream() {
    let failure = br#"{"error":{"code":"resource_exhausted","message":"slow down please"}}"#;
    let wire = Wire::new("GetChatMessage", vec![gzip_frame(&text_field(3, "par")), envelope(2, failure)]);
    let error = run(&devin(&wire), request("devin-wire-model")).await.error.expect("the trailer's error");
    assert!(error.message.contains("slow down please"), "{}", error.message);

    let wire = Wire::new("GetChatMessage", vec![gzip_frame(&text_field(3, "par"))]);
    let error = run(&devin(&wire), request("devin-wire-model")).await.error.expect("cut");
    assert_eq!(error.transport, Some(TransportFault::TruncatedStream));
}

fn interaction(field: u32, inner: &[u8]) -> Vec<u8> {
    envelope(0, &len_field(1, &len_field(field, inner)))
}

#[tokio::test]
async fn cursor_writes_the_run_request_in_one_envelope_and_maps_the_interaction_updates() {
    mixdog_rt::testing::tokens();
    let frames = vec![
        interaction(1, &text_field(1, "Hi ")),
        interaction(1, &text_field(1, "there")),
        interaction(4, &text_field(1, "thinking")),
        interaction(8, &int_field(1, 5)),
        interaction(14, &[]),
        envelope(2, TRAILER_OK),
    ];
    let wire = Wire::new("/agent.v1.AgentService/Run", frames);
    let tokens = ApiKeyAccess::new(wire.clone(), "wire-api-key".into(), "env CURSOR_API_KEY".into());
    let adapter = CursorAdapter::new("cursor-wire", None, None, wire.clone(), wire.clone(), Arc::new(tokens));
    let got = run(&adapter, request("cursor-wire-model")).await;
    assert!(got.error.is_none(), "{:?}", got.error.map(|e| e.message));
    assert_eq!(got.content, "Hi there");
    assert_eq!(got.reasoning, "thinking");
    assert_eq!(got.usage.expect("usage").output_tokens, 5, "the token deltas add up to the completion");
    assert_eq!(got.stop, Some(StopReason::Other("stop".to_owned())));

    let sent = wire.sent_to("/agent.v1.AgentService/Run");
    assert_eq!(sent[0], 0, "the first frame is an uncompressed envelope");
    assert_eq!(u32::from_be_bytes(sent[1..5].try_into().unwrap()) as usize, sent.len() - 5);
    assert!(contains(&sent[5..], ASKED), "the user's message rides the run request");
    assert!(contains(&sent[5..], "lookup"), "and the tool is declared to the agent");
}

#[tokio::test]
async fn cursor_stream_that_ends_before_the_turn_ended_is_an_incomplete_stream() {
    mixdog_rt::testing::tokens();
    let wire = Wire::new("/agent.v1.AgentService/Run", vec![interaction(1, &text_field(1, "partial")), envelope(2, TRAILER_OK)]);
    let tokens = ApiKeyAccess::new(wire.clone(), "wire-api-key".into(), "env CURSOR_API_KEY".into());
    let adapter = CursorAdapter::new("cursor-wire", None, None, wire.clone(), wire.clone(), Arc::new(tokens));
    let error = run(&adapter, request("cursor-wire-model")).await.error.expect("incomplete");
    assert_eq!(error.code.as_deref(), Some("incomplete_stream"));
}